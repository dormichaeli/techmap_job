function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function sourceIdentity(row) {
  return `${normalized(row.provider)}\u001f${normalized(row.source_identifier)}`;
}

export function candidateIdentity(row) {
  return `${row.company_id}\u001f${sourceIdentity(row)}`;
}

export function reconcilePhase4Candidates(remainingRows, phase2ReviewRows, storedSources) {
  const valid = (row) => ["valid_with_jobs", "valid_empty"].includes(row.outcome);
  const exactSources = new Map(storedSources.map((row) => [candidateIdentity(row), row]));
  const providerOwners = new Map();
  for (const source of storedSources.filter((row) => row.provider && row.source_identifier)) {
    const key = sourceIdentity(source);
    if (!providerOwners.has(key)) providerOwners.set(key, new Set());
    providerOwners.get(key).add(source.company_id);
  }

  const classify = (row, origin) => {
    const stored = exactSources.get(candidateIdentity(row));
    const ownerCount = providerOwners.get(sourceIdentity(row))?.size ?? 0;
    let reconciliation_status = "new_disabled_candidate";
    let conflict_reason = "";
    if (!stored) {
      reconciliation_status = "missing_stored_source";
      conflict_reason = "validated source is absent from company_sources";
    } else if (ownerCount > 1) {
      reconciliation_status = "identity_conflict";
      conflict_reason = "provider identifier belongs to multiple company identities";
    } else if (Number(stored.is_enabled) === 1 && stored.evidence_status === "live_verified") {
      reconciliation_status = "already_live_verified";
    } else if (Number(stored.is_enabled) !== 0 || stored.evidence_status !== "imported_unverified") {
      reconciliation_status = "source_state_conflict";
      conflict_reason = `unexpected source state ${stored.evidence_status}/${stored.is_enabled}`;
    }
    return {
      ...row,
      source_id: stored?.source_id ?? row.source_id,
      current_evidence_status: stored?.evidence_status ?? "missing",
      current_is_enabled: stored?.is_enabled ?? "",
      reconciliation_origin: origin,
      reconciliation_status,
      conflict_reason,
    };
  };

  const remaining = remainingRows.filter(valid).map((row) => classify(row, "phase3_remaining"));
  const review = phase2ReviewRows.filter(valid).map((row) => classify(row, "phase2_recheck"));
  const all = [...remaining, ...review];
  const candidates = all.filter((row) => row.reconciliation_status === "new_disabled_candidate");
  return { remaining, review, all, candidates };
}

export function phase4Eligibility(row, { unresolvedExternalIds = new Set() } = {}) {
  const reasons = [];
  if (row.reconciliation_status !== "new_disabled_candidate") reasons.push(`reconciliation:${row.reconciliation_status}`);
  if (row.ownership_status !== "verified") reasons.push(`ownership:${row.ownership_status || "missing"}`);
  if (row.ownership_evidence_level !== "strong") reasons.push(`ownership_evidence:${row.ownership_evidence_level || "missing"}`);
  if (row.parser_status !== "compatible") reasons.push(`parser:${row.parser_status || "missing"}`);
  if (!["valid_with_jobs", "valid_empty"].includes(row.outcome)) reasons.push(`outcome:${row.outcome || "missing"}`);
  const status = Number(row.endpoint_http_status);
  if (!Number.isFinite(status) || status < 200 || status >= 400) reasons.push(`http:${row.endpoint_http_status || "missing"}`);
  if (unresolvedExternalIds.has(String(row.external_id))) reasons.push("unresolved_company_identity_review");
  return { eligible: reasons.length === 0, reasons };
}

function priorityScore(row) {
  const min = Number(row.employee_count_min);
  const max = Number(row.employee_count_max);
  const strictSmall = Number.isFinite(min) && Number.isFinite(max) && min >= 10 && max <= 200;
  return (strictSmall ? 100 : 0)
    + (String(row.canonical_domain).toLowerCase().endsWith(".io") ? 40 : 0)
    + (Number(row.job_count) > 0 ? 10 : 0)
    + Math.min(Number(row.job_count) || 0, 40) / 100;
}

function ranked(rows) {
  return [...rows].sort((a, b) => priorityScore(b) - priorityScore(a)
    || String(a.category_name ?? "unknown").localeCompare(String(b.category_name ?? "unknown"))
    || a.company_name.localeCompare(b.company_name));
}

function diverseSelection(rows, limit) {
  const ordered = ranked(rows);
  const selected = [];
  const selectedKeys = new Set();
  const usedProviders = new Set();
  const usedCategories = new Set();
  const add = (row) => {
    const key = candidateIdentity(row);
    if (selectedKeys.has(key) || selected.length >= limit) return;
    selected.push(row);
    selectedKeys.add(key);
    usedProviders.add(row.provider);
    usedCategories.add(row.category_name ?? "unknown");
  };
  for (const provider of [...new Set(ordered.map((row) => row.provider))]) {
    add(ordered.find((row) => row.provider === provider));
  }
  for (const row of ordered) {
    if (!usedCategories.has(row.category_name ?? "unknown")) add(row);
  }
  for (const row of ordered) add(row);
  return selected;
}

export function selectPhase4Cohorts(rows, cohortSize = 10) {
  const eligible = [];
  const deferred = [];
  for (const row of rows) {
    const decision = phase4Eligibility(row);
    if (decision.eligible) eligible.push(row);
    else deferred.push({ ...row, deferred_reason: decision.reasons.join(";") });
  }
  const cohortA = diverseSelection(eligible, cohortSize);
  const selectedA = new Set(cohortA.map(candidateIdentity));
  const cohortB = diverseSelection(eligible.filter((row) => !selectedA.has(candidateIdentity(row))), cohortSize);
  const selectedB = new Set(cohortB.map(candidateIdentity));
  for (const row of eligible) {
    if (!selectedA.has(candidateIdentity(row)) && !selectedB.has(candidateIdentity(row))) {
      deferred.push({ ...row, deferred_reason: "eligible_but_outside_phase4_cohort_limit" });
    }
  }
  const annotate = (rowsForCohort, cohort) => rowsForCohort.map((row, index) => ({
    ...row,
    phase4_cohort: cohort,
    cohort_rank: index + 1,
    cohort_priority_score: priorityScore(row).toFixed(2),
    cohort_selection_reason: [
      Number(row.employee_count_min) >= 10 && Number(row.employee_count_max) <= 200 ? "10-200 employees" : "larger-company fallback",
      String(row.canonical_domain).toLowerCase().endsWith(".io") ? ".io priority" : null,
      `provider diversity: ${row.provider}`,
      `industry diversity: ${row.category_name ?? "unknown"}`,
      `fresh expected jobs: ${row.job_count}`,
    ].filter(Boolean).join("; "),
  }));
  return { cohortA: annotate(cohortA, "A"), cohortB: annotate(cohortB, "B"), deferred };
}

export function cohortSafetyDecision({ runStatuses, failedSources, preservationDifferences, integrity, foreignKeyViolations }) {
  const reasons = [];
  if (runStatuses.some((status) => status !== "completed")) reasons.push("collection_run_not_completed");
  if (failedSources > 0) reasons.push("source_collection_failure");
  if (preservationDifferences > 0) reasons.push("historical_preservation_difference");
  if (integrity !== "ok") reasons.push("sqlite_integrity_failure");
  if (foreignKeyViolations > 0) reasons.push("foreign_key_violation");
  return { proceed: reasons.length === 0, reasons };
}

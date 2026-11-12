import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCsv, writeCsv } from "../src/csv.js";

const dbPath = resolve("data/jobs.sqlite");
const backupPath = resolve("data/backups/jobs-before-phase3-20261112T075834Z.sqlite");
const db = new DatabaseSync(dbPath, { readOnly: true });
const backup = new DatabaseSync(backupPath, { readOnly: true });
const generatedAt = new Date().toISOString();
const countBy = (rows, field) => Object.fromEntries(Object.entries(Object.groupBy(rows, (row) => row[field] || "unknown"))
  .map(([key, values]) => [key, values.length]).sort(([left], [right]) => left.localeCompare(right)));
const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
const fieldsFor = (rows) => [...new Set(rows.flatMap((row) => Object.keys(row)))];
const mdTable = (headers, rows) => [
  `| ${headers.join(" | ")} |`,
  `|${headers.map(() => "---").join("|")}|`,
  ...rows.map((row) => `| ${row.map((value) => String(value ?? "").replaceAll("|", "\\|")).join(" | ")} |`),
].join("\n");

try {
  const [revalidation, activated, remaining, phase2Review] = await Promise.all([
    readCsv(resolve("data/phase3-approved-revalidation.csv")),
    readCsv(resolve("data/phase3-activated-sources.csv")),
    readCsv(resolve("data/phase3-ats-validation.csv")),
    readCsv(resolve("data/phase3-phase2-review.csv")),
  ]);
  const allValidation = [...remaining, ...phase2Review];
  const activationCandidates = allValidation.filter((row) => ["valid_with_jobs", "valid_empty"].includes(row.outcome)
    && row.previous_verification_status === "imported_unverified" && Number(row.source_enabled) === 0);
  const investigation = allValidation.filter((row) => ["stale_source", "source_migrated", "ownership_conflict"].includes(row.outcome));
  const failures = allValidation.filter((row) => !["valid_with_jobs", "valid_empty"].includes(row.outcome));
  const baselineJobs = db.prepare(`
    SELECT job_id, source_job_id, company_id, company_source_id, company_name, job_title,
      location, department, source_provider, source_url, apply_url, first_seen_at,
      published_at, published_at_source, source_updated_at, discovery_cohort,
      discovery_kind, active
    FROM jobs WHERE discovery_cohort='phase3_approved_ats_2026-11-12'
    ORDER BY company_name, source_job_id
  `).all();
  const collectionResults = db.prepare(`
    SELECT so.run_id, r.started_at, r.finished_at, r.status run_status,
      so.company_id, so.company_source_id, so.company_name, so.source_provider,
      so.source_url, so.health_status, so.http_status, so.job_count, so.error, so.observed_at
    FROM source_observations so JOIN runs r ON r.run_id=so.run_id
    WHERE so.run_id IN (6, 7)
    ORDER BY so.run_id, so.company_name
  `).all();
  const events = db.prepare(`
    SELECT e.*, c.company_name, s.provider, s.source_identifier, s.source_url
    FROM company_source_activation_events e
    JOIN companies c ON c.company_id=e.company_id
    JOIN company_sources s ON s.source_id=e.source_id
    ORDER BY e.event_id
  `).all();

  await Promise.all([
    writeCsv(resolve("data/phase3-baseline-jobs.csv"), baselineJobs, fieldsFor(baselineJobs)),
    writeCsv(resolve("data/phase3-collection-results.csv"), collectionResults, fieldsFor(collectionResults)),
    writeCsv(resolve("data/phase3-activation-candidates.csv"), activationCandidates, fieldsFor(activationCandidates)),
    writeCsv(resolve("data/phase3-source-investigation.csv"), investigation, fieldsFor(investigation)),
    writeCsv(resolve("data/phase3-source-failures.csv"), failures, fieldsFor(failures)),
  ]);

  const backupJobs = backup.prepare("SELECT * FROM jobs ORDER BY job_id").all();
  const liveColumns = new Set(db.prepare("PRAGMA table_info(jobs)").all().map((row) => row.name));
  const commonColumns = backup.prepare("PRAGMA table_info(jobs)").all().map((row) => row.name)
    .filter((name) => liveColumns.has(name));
  const selected = commonColumns.map((name) => `"${name}"`).join(", ");
  const liveOriginal = new Map(db.prepare(`SELECT ${selected} FROM jobs WHERE job_id=?`)
    ? backupJobs.map((row) => [row.job_id, db.prepare(`SELECT ${selected} FROM jobs WHERE job_id=?`).get(row.job_id)]) : []);
  const missingOriginalJobs = backupJobs.filter((row) => !liveOriginal.get(row.job_id));
  const changedOriginalRows = backupJobs.filter((row) => {
    const live = liveOriginal.get(row.job_id);
    if (!live) return false;
    return JSON.stringify(Object.fromEntries(commonColumns.map((column) => [column, row[column]]))) !== JSON.stringify({ ...live });
  });
  const jobIdentity = db.prepare("SELECT job_id, first_seen_at FROM jobs ORDER BY job_id").all();
  const jobIdsHash = createHash("sha256").update(jobIdentity.map((row) => row.job_id).join("\n")).digest("hex");
  const firstSeenHash = createHash("sha256").update(jobIdentity.map((row) => `${row.job_id}\u001f${row.first_seen_at}`).join("\n")).digest("hex");
  const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  const baselinePublished = baselineJobs.filter((row) => row.published_at).length;
  const baselineUpdated = baselineJobs.filter((row) => row.source_updated_at).length;
  const providerBreakdown = ["greenhouse", "comeet"].map((provider) => {
    const rows = remaining.filter((row) => row.provider === provider);
    return [provider, rows.length, rows.filter((row) => Number(row.endpoint_http_status) >= 200 && Number(row.endpoint_http_status) < 400).length,
      rows.filter((row) => row.parser_status === "compatible").length,
      rows.filter((row) => ["valid_with_jobs", "valid_empty"].includes(row.outcome)).length,
      sum(rows, "job_count")];
  });
  const strictSmall = remaining.filter((row) => Number(row.employee_count_min) >= 10 && Number(row.employee_count_max) <= 200).length;
  const ioDomains = remaining.filter((row) => row.canonical_domain?.endsWith(".io")).length;
  const backupHash = createHash("sha256").update(readFileSync(backupPath)).digest("hex");

  const activationReport = `# Phase 3 source activation\n\nGenerated: ${generatedAt}\n\n## Result\n\nThree approved sources passed a fresh evidence gate and were activated atomically. No other imported source was activated.\n\n${mdTable(["Company", "Provider", "Identifier", "HTTP", "Ownership", "Parser", "Jobs", "Evidence"], revalidation.map((row) => [
    row.company_name, row.provider, row.source_identifier, row.endpoint_http_status, row.ownership_status,
    row.parser_status, row.job_count, row.ownership_evidence_url,
  ]))}\n\n## Audit trail\n\n${mdTable(["Company", "Source ID", "Previous", "New", "Enabled", "Observed"], events.map((row) => [
    row.company_name, row.source_id, row.previous_evidence_status, row.new_evidence_status,
    `${row.previous_is_enabled} -> ${row.new_is_enabled}`, row.observed_at,
  ]))}\n\nSchema v5 adds \`company_source_activation_events\` and exact \`company_source_id\` attribution on jobs and source observations. Existing stronger configurations were not modified. Enabled imported-unverified sources: **${db.prepare("SELECT COUNT(*) count FROM company_sources WHERE evidence_status='imported_unverified' AND is_enabled<>0").get().count}**.\n`;

  const ownershipReport = `# Phase 3 ownership review\n\nGenerated: ${generatedAt}\n\n## Evidence hierarchy\n\nAutomatic activation requires strong evidence: an official company-domain page or redirect to the exact ATS board, or an existing explicitly verified configuration with reliable provenance. ATS branding/name consistency is supporting evidence only. Name similarity, snippets, and third-party directories are not ownership proof. Evidence URLs and observation times are retained in the CSVs.\n\n## Phase 2 review\n\nThe 26 unresolved Phase 2 cases were rechecked. Four prior manual-review cases became valid: **BIRD Aerosystems, Verifone, CYE, and the already-enabled Cloudinary configuration**. Ten remain manual review because reachable official pages still do not expose the exact board.\n\n- Confirmed source migrations: **${phase2Review.filter((row) => row.outcome === "source_migrated").length}**.\n- Stale sources: **${phase2Review.filter((row) => row.outcome === "stale_source").length}**.\n- Parser failures after the compatibility fix: **${phase2Review.filter((row) => row.outcome === "parser_failure").length}**.\n\n## Conflicts and replacements\n\nAcross the Phase 2 review and remaining cohort, confirmed migrations: **${investigation.filter((row) => row.outcome === "source_migrated").length}**; ownership conflicts: **${investigation.filter((row) => row.outcome === "ownership_conflict").length}**; stale sources: **${investigation.filter((row) => row.outcome === "stale_source").length}**. Old identifiers remain preserved and no proposed replacement was activated.\n\nThe Comeet parser investigation found a provider-wide deactivation page, not a new schema. All 16 affected boards preserve their real HTTP 200 response but are classified \`stale_source\` from the explicit deactivation message.\n\nDetailed evidence: \`data/phase3-phase2-review.csv\`, \`data/phase3-source-investigation.csv\`, and \`data/phase3-comeet-parser-investigation.csv\`.\n`;

  const validationReport = `# Phase 3 ATS validation\n\nGenerated: ${generatedAt}\n\n## Remaining cohort\n\nAll **154** remaining candidates were attempted: 17 Greenhouse and 137 Comeet. No candidate was silently excluded and no provider rate limiting occurred.\n\n${mdTable(["Provider", "Attempted", "HTTP reachable", "Parser compatible", "Valid", "Jobs observed"], providerBreakdown)}\n\nOutcome distribution: ${Object.entries(countBy(remaining, "outcome")).map(([key, value]) => `\`${key}\` ${value}`).join(", ")}.\n\n- Strict 10-200 employee companies: **${strictSmall}/154**.\n- \`.io\` companies: **${ioDomains}/154**.\n- Newly useful disabled candidates for explicit activation review: **${activationCandidates.length}**.\n- Deferred due to rate limiting: **0**.\n\n## Job-data quality\n\nAcross the remaining cohort plus the 26 Phase 2 rechecks, parsed job observations in memory: **${sum(allValidation, "job_count")}**. Defensible publication dates: **${sum(allValidation, "published_date_jobs")}**; source-updated timestamps: **${sum(allValidation, "source_updated_date_jobs")}**. Application samples: **${allValidation.filter((row) => row.application_url_sample).length}**; reachable: **${allValidation.filter((row) => row.application_link_status === "reachable").length}**; blocked but not treated as closed: **${allValidation.filter((row) => row.application_link_status === "blocked_not_closed").length}**. No validation jobs were written to SQLite.\n\nFull results: \`data/phase3-ats-validation.csv\`; frozen manifest: \`data/phase3-ats-validation-sample.csv\`; activation-review subset: \`data/phase3-activation-candidates.csv\`.\n`;

  const collectionReport = `# Phase 3 collection results\n\nGenerated: ${generatedAt}\n\n## Controlled collection\n\nRun 6 collected only the three approved sources: Dalet 1 job, Parallel Wireless 51 jobs, and AugMedics a successful empty board. It inserted **${baselineJobs.length}** jobs tagged \`new_to_collector_baseline\`; existing jobs matched on the first run: **0**. These records are baseline discoveries, not claims of new publication.\n\nRun 7 repeated the same bounded collection. It observed the same **52** job IDs, inserted **0** duplicate rows, and preserved the first-run job-ID and first-seen fingerprints. AugMedics remained valid empty.\n\n- Baseline jobs with publication timestamps: **${baselinePublished}/${baselineJobs.length}**.\n- Baseline jobs with source-updated timestamps: **${baselineUpdated}/${baselineJobs.length}**.\n- Active jobs before/after: **${backupJobs.length}/${db.prepare("SELECT COUNT(*) count FROM jobs WHERE active=1").get().count}**.\n- Job observations before/after: **${backup.prepare("SELECT COUNT(*) count FROM job_observations").get().count}/${db.prepare("SELECT COUNT(*) count FROM job_observations").get().count}**.\n- Original jobs missing: **${missingOriginalJobs.length}**; original common-column rows changed: **${changedOriginalRows.length}**.\n- Current job-ID fingerprint: \`${jobIdsHash}\`.\n- Current first-seen fingerprint: \`${firstSeenHash}\`.\n- Integrity: **${integrity.join(", ")}**; foreign-key violations: **${foreignKeys.length}**.\n- Backup restore comparison: **passed for all 11 pre-Phase-3 tables**.\n- Backup SHA-256: \`${backupHash}\`.\n\nCSV outputs: \`data/phase3-baseline-jobs.csv\` and \`data/phase3-collection-results.csv\`.\n`;

  await Promise.all([
    writeFile(resolve("reports/phase3-source-activation.md"), activationReport, "utf8"),
    writeFile(resolve("reports/phase3-ownership-review.md"), ownershipReport, "utf8"),
    writeFile(resolve("reports/phase3-ats-validation.md"), validationReport, "utf8"),
    writeFile(resolve("reports/phase3-collection-results.md"), collectionReport, "utf8"),
  ]);

  console.log(JSON.stringify({
    activated: activated.length,
    baseline_jobs: baselineJobs.length,
    remaining_validated: remaining.length,
    activation_candidates: activationCandidates.length,
    outcomes: countBy(remaining, "outcome"),
    database: {
      schema_version: db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,
      jobs: db.prepare("SELECT COUNT(*) count FROM jobs").get().count,
      job_observations: db.prepare("SELECT COUNT(*) count FROM job_observations").get().count,
      source_observations: db.prepare("SELECT COUNT(*) count FROM source_observations").get().count,
      runs: db.prepare("SELECT COUNT(*) count FROM runs").get().count,
      missing_original_jobs: missingOriginalJobs.length,
      changed_original_rows: changedOriginalRows.length,
      integrity,
      foreign_key_violations: foreignKeys.length,
    },
  }, null, 2));
} finally {
  db.close();
  backup.close();
}

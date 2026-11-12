import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cohortSafetyDecision,
  phase4Eligibility,
  reconcilePhase4Candidates,
  selectPhase4Cohorts,
} from "../src/phase4.js";
import {
  applySuccessfulObservation, beginRun, importCompanies, openStore, recordSourceObservation,
} from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

const validation = (overrides = {}) => ({
  company_id: "c1", company_name: "One", provider: "comeet", source_identifier: "one/A1",
  source_id: "s1", outcome: "valid_with_jobs", ownership_status: "verified",
  ownership_evidence_level: "strong", parser_status: "compatible", endpoint_http_status: 200,
  job_count: 3, employee_count_min: 11, employee_count_max: 50, category_name: "Fintech",
  canonical_domain: "one.test", reconciliation_status: "new_disabled_candidate", ...overrides,
});

test("candidate reconciliation explains enabled versus new sources and rejects shared ATS identities", () => {
  const stored = [
    { ...validation(), evidence_status: "imported_unverified", is_enabled: 0 },
    { ...validation({ company_id: "c2", company_name: "Two", source_id: "s2", source_identifier: "two/A2" }), evidence_status: "live_verified", is_enabled: 1 },
    { ...validation({ company_id: "c3", company_name: "Three", source_id: "s3", source_identifier: "shared/A3" }), evidence_status: "imported_unverified", is_enabled: 0 },
    { ...validation({ company_id: "c4", company_name: "Four", source_id: "s4", source_identifier: "shared/A3" }), evidence_status: "imported_unverified", is_enabled: 0 },
  ];
  const rows = stored.map((row) => validation(row));
  const result = reconcilePhase4Candidates(rows, [], stored);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.all.map((row) => row.reconciliation_status), [
    "new_disabled_candidate", "already_live_verified", "identity_conflict", "identity_conflict",
  ]);
});

test("fresh eligibility rejects ownership changes, weak evidence, migration, and unresolved identity", () => {
  assert.equal(phase4Eligibility(validation()).eligible, true);
  assert.equal(phase4Eligibility(validation({ ownership_status: "conflict" })).eligible, false);
  assert.equal(phase4Eligibility(validation({ ownership_evidence_level: "weak" })).eligible, false);
  assert.equal(phase4Eligibility(validation({ outcome: "source_migrated" })).eligible, false);
  assert.equal(phase4Eligibility(validation(), { unresolvedExternalIds: new Set(["missing"]) }).eligible, true);
  assert.equal(phase4Eligibility(validation({ external_id: "42" }), { unresolvedExternalIds: new Set(["42"]) }).eligible, false);
});

test("cohort selection is bounded, deterministic, and includes provider diversity", () => {
  const rows = Array.from({ length: 20 }, (_, index) => validation({
    company_id: `c${index}`, source_id: `s${index}`, source_identifier: `id${index}`,
    company_name: `Company ${String(index).padStart(2, "0")}`,
    provider: index === 19 ? "lever" : index === 18 ? "greenhouse" : "comeet",
    category_name: `Category ${index % 6}`,
  }));
  const first = selectPhase4Cohorts(rows);
  const second = selectPhase4Cohorts(rows);
  assert.equal(first.cohortA.length, 10);
  assert.equal(first.cohortB.length, 10);
  assert.deepEqual(first, second);
  assert.deepEqual(new Set(first.cohortA.map((row) => row.provider)), new Set(["comeet", "greenhouse", "lever"]));
});

test("partial failure and preservation changes stop the next cohort", () => {
  assert.equal(cohortSafetyDecision({ runStatuses: ["completed", "completed"], failedSources: 0, preservationDifferences: 0, integrity: "ok", foreignKeyViolations: 0 }).proceed, true);
  const stopped = cohortSafetyDecision({ runStatuses: ["partial_success"], failedSources: 1, preservationDifferences: 2, integrity: "ok", foreignKeyViolations: 0 });
  assert.equal(stopped.proceed, false);
  assert.deepEqual(stopped.reasons, ["collection_run_not_completed", "source_collection_failure", "historical_preservation_difference"]);
});

function withPhase4Store(callback) {
  const directory = mkdtempSync(join(tmpdir(), "phase4-store-"));
  const db = openStore(join(directory, "test.sqlite"));
  try {
    importCompanies(db, [
      { company_id: "c1", company_name: "Company One", company_discovered_at: "2026-11-12T00:00:00Z", company_source_status: "verified" },
      { company_id: "c2", company_name: "Company Two", company_discovered_at: "2026-11-12T00:00:00Z", company_source_status: "verified" },
    ], "2026-11-12T00:00:00Z");
    for (const [sourceId, companyId] of [["s1", "c1"], ["s2", "c2"]]) {
      db.prepare(`INSERT INTO company_sources
        (source_id, company_id, source_kind, provider, source_identifier, source_url,
         evidence_source, evidence_status, is_enabled, imported_at)
        VALUES (?, ?, 'ats', 'greenhouse', ?, ?, 'test', 'live_verified', 1, '2026-11-12T00:00:00Z')`)
        .run(sourceId, companyId, sourceId, `https://example.test/${sourceId}`);
    }
    callback(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("identical external job IDs remain attributed to separate companies and sources", () => {
  withPhase4Store((db) => {
    const run = beginRun(db, "2026-11-12T01:00:00Z");
    for (const [companyId, companyName, sourceId] of [["c1", "Company One", "s1"], ["c2", "Company Two", "s2"]]) {
      const company = { company_id: companyId, company_name: companyName, company_source_id: sourceId, source_provider: "greenhouse" };
      const raw = { source_job_id: "shared-42", company_name: companyName, job_title: "Analyst", source_provider: "greenhouse", source_url: `https://example.test/${sourceId}` };
      applySuccessfulObservation(db, run, company, [normalizeJob(raw, "2026-11-12T01:00:00Z", { company })], "2026-11-12T01:00:00Z");
    }
    const rows = db.prepare("SELECT job_id, company_id, company_source_id FROM jobs ORDER BY company_id").all();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].job_id, rows[1].job_id);
    assert.deepEqual(rows.map((row) => [row.company_id, row.company_source_id]), [["c1", "s1"], ["c2", "s2"]]);
  });
});

test("repeated failed source observations cannot advance closure state", () => {
  withPhase4Store((db) => {
    const company = { company_id: "c1", company_name: "Company One", company_source_id: "s1", source_provider: "greenhouse", source_url: "https://example.test/s1" };
    const first = beginRun(db, "2026-11-12T01:00:00Z");
    const raw = { source_job_id: "job-1", company_name: "Company One", job_title: "Analyst", source_provider: "greenhouse", source_url: company.source_url };
    applySuccessfulObservation(db, first, company, [normalizeJob(raw, "2026-11-12T01:00:00Z", { company })], "2026-11-12T01:00:00Z");
    for (const hour of [2, 3]) {
      const run = beginRun(db, `2026-11-12T0${hour}:00:00Z`);
      recordSourceObservation(db, run, company, { status: "failed_http", httpStatus: 503, jobs: [], error: "unavailable", sourceUrl: company.source_url }, `2026-11-12T0${hour}:00:00Z`);
    }
    assert.deepEqual({ ...db.prepare("SELECT active, missing_success_count, reopened_at FROM jobs").get() }, {
      active: 1, missing_success_count: 0, reopened_at: null,
    });
  });
});

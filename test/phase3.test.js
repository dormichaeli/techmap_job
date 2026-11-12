import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCompanySources,
  applySuccessfulObservation,
  beginRun,
  importCompanies,
  openStore,
} from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

function withStore(callback) {
  const directory = mkdtempSync(join(tmpdir(), "phase3-"));
  const db = openStore(join(directory, "test.sqlite"));
  try {
    const company = {
      company_id: "company-one",
      company_name: "Company One",
      company_discovered_at: "2026-11-12T00:00:00Z",
      company_source_status: "needs_manual_review",
    };
    importCompanies(db, [company], "2026-11-12T00:00:00Z");
    callback(db, company);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function insertSource(db, {
  sourceId = "source-one",
  identifier = "company-one",
  status = "imported_unverified",
  enabled = 0,
} = {}) {
  db.prepare(`
    INSERT INTO company_sources (
      source_id, company_id, source_kind, provider, source_identifier, source_url,
      evidence_source, evidence_status, is_enabled, imported_at
    ) VALUES (?, 'company-one', 'ats', 'greenhouse', ?, ?, 'test', ?, ?, '2026-11-12T00:00:00Z')
  `).run(sourceId, identifier, `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs`, status, enabled);
}

function validEvidence(overrides = {}) {
  return {
    source_id: "source-one",
    company_id: "company-one",
    company_name: "Company One",
    provider: "greenhouse",
    source_identifier: "company-one",
    endpoint_http_status: 200,
    ownership_status: "verified",
    ownership_evidence_level: "strong",
    ownership_evidence: "Official company page links the exact board",
    ownership_evidence_url: "https://company.test/careers",
    parser_status: "compatible",
    outcome: "valid_with_jobs",
    ...overrides,
  };
}

test("schema v5 adds source-scoped collection and activation audit structures", () => {
  withStore((db) => {
    assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 5);
    assert.ok(db.prepare("PRAGMA table_info(jobs)").all().some((row) => row.name === "company_source_id"));
    assert.ok(db.prepare("PRAGMA table_info(source_observations)").all().some((row) => row.name === "company_source_id"));
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='company_source_activation_events'").get().count, 1);
  });
});

test("explicit activation requires strong fresh evidence and creates one idempotent audit event", () => {
  withStore((db) => {
    insertSource(db);
    assert.throws(() => activateCompanySources(db, [validEvidence({ ownership_status: "uncertain" })]), /evidence gate/);
    activateCompanySources(db, [validEvidence()], { observedAt: "2026-11-12T01:00:00Z" });
    activateCompanySources(db, [validEvidence()], { observedAt: "2026-11-12T01:00:00Z" });
    const source = db.prepare("SELECT evidence_status, is_enabled, evidence_url FROM company_sources WHERE source_id='source-one'").get();
    assert.deepEqual({ ...source }, {
      evidence_status: "live_verified",
      is_enabled: 1,
      evidence_url: "https://company.test/careers",
    });
    assert.equal(db.prepare("SELECT COUNT(*) count FROM company_source_activation_events").get().count, 1);
  });
});

test("first collection is baseline-tagged, preserves identity, and is idempotent", () => {
  withStore((db, company) => {
    insertSource(db);
    const scopedCompany = { ...company, source_provider: "greenhouse", company_source_id: "source-one" };
    const context = { company: scopedCompany, discoveryCohort: "phase3", discoveryKind: "new_to_collector_baseline" };
    const raw = {
      source_job_id: "job-one", company_name: company.company_name, job_title: "Analyst",
      source_provider: "greenhouse", source_url: "https://boards-api.greenhouse.io/v1/boards/company-one/jobs",
      apply_url: "https://job.test/one",
    };
    const run1 = beginRun(db, "2026-11-12T01:00:00Z");
    applySuccessfulObservation(db, run1, scopedCompany, [normalizeJob(raw, "2026-11-12T01:00:00Z", context)], "2026-11-12T01:00:00Z");
    const run2 = beginRun(db, "2026-11-12T02:00:00Z");
    applySuccessfulObservation(db, run2, scopedCompany, [normalizeJob(raw, "2026-11-12T02:00:00Z", context)], "2026-11-12T02:00:00Z");
    const row = db.prepare("SELECT COUNT(*) count, first_seen_at, discovery_kind, company_source_id FROM jobs").get();
    assert.deepEqual({ ...row }, {
      count: 1,
      first_seen_at: "2026-11-12T01:00:00Z",
      discovery_kind: "new_to_collector_baseline",
      company_source_id: "source-one",
    });
    assert.equal(db.prepare("SELECT COUNT(*) count FROM job_observations").get().count, 2);
  });
});

test("an empty observation is scoped to its exact source and cannot close another board's job", () => {
  withStore((db, company) => {
    insertSource(db);
    insertSource(db, { sourceId: "source-two", identifier: "company-two" });
    const sourceOne = { ...company, source_provider: "greenhouse", company_source_id: "source-one" };
    const sourceTwo = { ...company, source_provider: "greenhouse", company_source_id: "source-two" };
    const raw = {
      source_job_id: "job-one", company_name: company.company_name, job_title: "Analyst",
      source_provider: "greenhouse", source_url: "https://boards-api.greenhouse.io/v1/boards/company-one/jobs",
    };
    const run1 = beginRun(db, "2026-11-12T01:00:00Z");
    applySuccessfulObservation(db, run1, sourceOne, [normalizeJob(raw, "2026-11-12T01:00:00Z", { company: sourceOne })], "2026-11-12T01:00:00Z");
    for (const hour of [2, 3]) {
      const run = beginRun(db, `2026-11-12T0${hour}:00:00Z`);
      applySuccessfulObservation(db, run, sourceTwo, [], `2026-11-12T0${hour}:00:00Z`);
    }
    assert.deepEqual({ ...db.prepare("SELECT active, missing_success_count FROM jobs").get() }, {
      active: 1,
      missing_success_count: 0,
    });
  });
});

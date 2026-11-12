import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, beginRun, applySuccessfulObservation, finishRun, importCompanies, recordCompanyVerification } from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

test("jobs close only after two successful observations omit them", () => {
  const directory = mkdtempSync(join(tmpdir(), "job-poc-"));
  const db = openStore(join(directory, "test.sqlite"));
  const company = { company_name: "Acme", source_provider: "greenhouse" };
  const raw = {
    source_job_id: "job-1",
    company_name: "Acme",
    job_title: "Marketing Analyst",
    source_provider: "greenhouse",
    source_url: "https://example.test/jobs",
    apply_url: "https://example.test/jobs/1",
  };
  try {
    const run1 = beginRun(db, "2026-11-10T00:00:00Z");
    applySuccessfulObservation(db, run1, company, [normalizeJob(raw, "2026-11-10T00:00:00Z")], "2026-11-10T00:00:00Z");
    finishRun(db, run1, "completed", "2026-11-10T00:01:00Z");

    const run2 = beginRun(db, "2026-11-11T00:00:00Z");
    applySuccessfulObservation(db, run2, company, [], "2026-11-11T00:00:00Z");
    const afterOne = db.prepare("SELECT active, missing_success_count, verification_status FROM jobs").get();
    assert.deepEqual({ ...afterOne }, { active: 1, missing_success_count: 1, verification_status: "not_seen_once" });

    const run3 = beginRun(db, "2026-11-12T00:00:00Z");
    applySuccessfulObservation(db, run3, company, [], "2026-11-12T00:00:00Z");
    const afterTwo = db.prepare("SELECT active, missing_success_count, verification_status FROM jobs").get();
    assert.deepEqual({ ...afterTwo }, { active: 0, missing_success_count: 2, verification_status: "potentially_closed" });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy database migrates without changing existing job history", () => {
  const directory = mkdtempSync(join(tmpdir(), "job-poc-"));
  const path = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE runs (run_id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL);
    CREATE TABLE source_observations (run_id INTEGER NOT NULL, company_name TEXT NOT NULL, source_provider TEXT NOT NULL, source_url TEXT, health_status TEXT NOT NULL, http_status INTEGER, job_count INTEGER NOT NULL, error TEXT, observed_at TEXT NOT NULL, PRIMARY KEY (run_id, company_name, source_provider));
    CREATE TABLE jobs (job_id TEXT PRIMARY KEY, source_job_id TEXT NOT NULL, company_name TEXT NOT NULL, job_title TEXT, location TEXT, remote_type TEXT, department TEXT, description TEXT, job_url TEXT, apply_url TEXT, source_provider TEXT NOT NULL, source_url TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, source_updated_at TEXT, verification_status TEXT NOT NULL, relevance_score INTEGER NOT NULL, relevance_reasons TEXT NOT NULL, link_status TEXT, missing_success_count INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, raw_json TEXT);
    CREATE TABLE job_observations (run_id INTEGER NOT NULL, job_id TEXT NOT NULL, observed_at TEXT NOT NULL, raw_json TEXT, PRIMARY KEY (run_id, job_id));
    INSERT INTO jobs(job_id, source_job_id, company_name, source_provider, source_url, first_seen_at, last_seen_at, verification_status, relevance_score, relevance_reasons) VALUES ('one','one','Acme','lever','https://example.test','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','source_listed',50,'test');
  `);
  legacy.close();
  const db = openStore(path);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) count FROM jobs").get().count, 1);
    assert.deepEqual(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((row) => row.version), [1, 2, 3, 4, 5]);
    const columns = db.prepare("PRAGMA table_info(jobs)").all().map((row) => row.name);
    assert.ok(columns.includes("published_at"));
    assert.ok(columns.includes("discovery_priority_score"));
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='company_sources'").get().count, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a closed job reopens while preserving first-seen and recording reopened-at", () => {
  const directory = mkdtempSync(join(tmpdir(), "job-poc-"));
  const db = openStore(join(directory, "test.sqlite"));
  const company = { company_name: "Acme", source_provider: "lever" };
  const raw = { source_job_id: "reopen", company_name: "Acme", job_title: "Growth Analyst", source_provider: "lever", source_url: "https://example.test", apply_url: "https://example.test/1" };
  try {
    const run1 = beginRun(db, "2026-11-01T00:00:00Z");
    applySuccessfulObservation(db, run1, company, [normalizeJob(raw, "2026-11-01T00:00:00Z")], "2026-11-01T00:00:00Z");
    for (const day of [2, 3]) {
      const at = `2026-11-0${day}T00:00:00Z`;
      const run = beginRun(db, at);
      applySuccessfulObservation(db, run, company, [], at);
    }
    const run4 = beginRun(db, "2026-11-04T00:00:00Z");
    applySuccessfulObservation(db, run4, company, [normalizeJob(raw, "2026-11-04T00:00:00Z")], "2026-11-04T00:00:00Z");
    const row = db.prepare("SELECT active, first_seen_at, reopened_at FROM jobs").get();
    assert.equal(row.active, 1);
    assert.equal(row.first_seen_at, "2026-11-01T00:00:00Z");
    assert.equal(row.reopened_at, "2026-11-04T00:00:00Z");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("re-observing a job is idempotent and preserves first_seen_at", () => {
  const directory = mkdtempSync(join(tmpdir(), "job-poc-"));
  const db = openStore(join(directory, "test.sqlite"));
  const company = { company_name: "Acme", source_provider: "lever" };
  const raw = {
    source_job_id: "same-id", company_name: "Acme", job_title: "Growth Analyst",
    source_provider: "lever", source_url: "https://example.test", apply_url: "https://example.test/1",
  };
  try {
    const run1 = beginRun(db, "2026-11-10T00:00:00Z");
    applySuccessfulObservation(db, run1, company, [normalizeJob(raw, "2026-11-10T00:00:00Z")], "2026-11-10T00:00:00Z");
    const run2 = beginRun(db, "2026-11-11T00:00:00Z");
    applySuccessfulObservation(db, run2, company, [normalizeJob(raw, "2026-11-11T00:00:00Z")], "2026-11-11T00:00:00Z");
    const row = db.prepare("SELECT COUNT(*) count, MIN(first_seen_at) first_seen, MAX(last_seen_at) last_seen FROM jobs").get();
    assert.equal(row.count, 1);
    assert.equal(row.first_seen, "2026-11-10T00:00:00Z");
    assert.equal(row.last_seen, "2026-11-11T00:00:00Z");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("company verification inserts are syntactically valid and idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "job-poc-"));
  const db = openStore(join(directory, "test.sqlite"));
  const company = {
    company_id: "company-verify", company_name: "Verify Co",
    company_discovered_at: "2026-11-11T00:00:00Z", company_source_status: "needs_manual_review",
  };
  const verification = {
    careers_url: "https://verify.test/careers", source_provider: "greenhouse",
    source_identifier: "verify", source_url: "https://boards-api.greenhouse.io/v1/boards/verify/jobs",
    verification_status: "verified_supported", observed_at: "2026-11-11T01:00:00Z",
    evidence_source: "test", is_manual_override: true,
  };
  try {
    importCompanies(db, [company], "2026-11-11T00:00:00Z");
    recordCompanyVerification(db, company.company_id, verification);
    recordCompanyVerification(db, company.company_id, verification);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM company_source_verifications").get().count, 1);
    assert.equal(db.prepare("SELECT ats_provider FROM companies WHERE company_id=?").get(company.company_id).ats_provider, "greenhouse");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

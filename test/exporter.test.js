import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDatasets, filterJobs } from "../src/exporter.js";
import { beginRun, applySuccessfulObservation, importCompanies, openStore } from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

const now = new Date("2026-11-11T12:00:00.000Z");
function job(overrides = {}) {
  return {
    job_id: overrides.job_id ?? "job",
    company_name: "Acme",
    job_title: "Marketing Analyst",
    relevance_score: 50,
    first_seen_at: "2026-11-04T12:00:00.000Z",
    published_at: null,
    source_updated_at: "2026-11-11T11:00:00.000Z",
    employee_count_min: 11,
    employee_count_max: 50,
    ...overrides,
  };
}

test("rolling freshness windows are inclusive at exact 24h, 7d, and 30d boundaries", () => {
  for (const [days, timestamp] of [
    [1, "2026-11-10T12:00:00.000Z"],
    [7, "2026-11-04T12:00:00.000Z"],
    [30, "2026-10-12T12:00:00.000Z"],
  ]) {
    const rows = [job({ job_id: `in-${days}`, first_seen_at: timestamp })];
    assert.equal(filterJobs(rows, { now, discoveredWithinDays: days }).length, 1);
    rows[0].first_seen_at = new Date(new Date(timestamp).getTime() - 1).toISOString();
    assert.equal(filterJobs(rows, { now, discoveredWithinDays: days }).length, 0);
  }
});

test("published filtering never substitutes source_updated_at and unknown dates are opt-in", () => {
  const rows = [job()];
  assert.equal(filterJobs(rows, { now, dateField: "published_at" }).length, 0);
  assert.equal(filterJobs(rows, { now, dateField: "published_at", includeUnknownDates: true }).length, 1);
  rows[0].published_at = "2026-11-10T12:00:00.000Z";
  assert.equal(filterJobs(rows, { now, dateField: "published_at", discoveredWithinDays: 1 }).length, 1);
});

test("default broad size filter excludes unknown sizes while all mode retains them", () => {
  const unknown = job({ employee_count_min: null, employee_count_max: null });
  assert.equal(filterJobs([unknown], { now }).length, 0);
  assert.equal(filterJobs([unknown], { now, sizeMode: "all" }).length, 1);
});

test("CSV exports are internally consistent and deterministic without network access", async () => {
  const directory = mkdtempSync(join(tmpdir(), "job-export-"));
  const db = openStore(join(directory, "test.sqlite"));
  const company = {
    company_id: "company-1", company_name: "Acme", company_discovered_at: now.toISOString(),
    source_provider: "jsonld",
    company_source_status: "verified_supported", employee_count_min: 11, employee_count_max: 50,
    employee_size_bucket: "11-50", employee_size_confidence: "medium",
    employee_size_evidence: "verified_within_10_200", is_new_company: 1,
  };
  try {
    importCompanies(db, [company], now.toISOString());
    const run = beginRun(db, now.toISOString());
    const normalized = normalizeJob({
      source_job_id: "one", company_name: "Acme", job_title: "Performance Marketing Analyst",
      location: "Tel Aviv", source_provider: "jsonld", source_url: "https://example.test/careers",
      apply_url: "https://example.test/apply",
    }, now.toISOString(), { company, discoveryCohort: "test", discoveryKind: "incremental" });
    applySuccessfulObservation(db, run, company, [normalized], now.toISOString());
    const output = join(directory, "output");
    const first = await exportDatasets(db, output, { now });
    const firstCsv = readFileSync(join(output, "relevant_jobs.csv"), "utf8");
    const second = await exportDatasets(db, output, { now });
    assert.deepEqual(second, first);
    assert.equal(readFileSync(join(output, "relevant_jobs.csv"), "utf8"), firstCsv);
    assert.equal(first.selected_jobs, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

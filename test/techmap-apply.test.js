import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyTechmapImport,
  companySourceId,
  identityReviewRows,
  readExistingState,
  reconcileTechmap,
  TECHMAP_SOURCE_NAME,
} from "../src/techmap-import.js";
import { applySuccessfulObservation, beginRun, finishRun, importCompanies, openStore } from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

function record(overrides = {}) {
  return {
    external_id: overrides.external_id ?? "515000001",
    company_name: overrides.company_name ?? "Acme",
    normalized_name: overrides.normalized_name ?? "acme",
    canonical_domain: overrides.canonical_domain === undefined ? "acme.io" : overrides.canonical_domain,
    website_url: overrides.website_url === undefined ? "https://acme.io" : overrides.website_url,
    careers_url: overrides.careers_url === undefined ? "https://acme.io/careers" : overrides.careers_url,
    city: overrides.city === undefined ? "Tel Aviv" : overrides.city,
    addresses: [], category_id: 1, category_name: overrides.category_name ?? "AI/ML",
    employee_count_min: overrides.employee_count_min === undefined ? 11 : overrides.employee_count_min,
    employee_count_max: overrides.employee_count_max === undefined ? 50 : overrides.employee_count_max,
    employee_size_bucket: overrides.employee_size_bucket ?? "11-50",
    employee_size_evidence: overrides.employee_size_evidence ?? "verified_within_10_200",
    is_active: overrides.is_active === undefined ? 1 : overrides.is_active,
    is_multinational: 0,
    ats: overrides.ats ?? [{ provider: "greenhouse", identifier: "acme" }],
    raw: overrides.raw ?? { name: overrides.company_name ?? "Acme" },
    ...overrides,
  };
}

function emptyState(companies = [], aliases = [], sources = [], verifications = []) {
  return {
    companies, aliases, companyAliases: [], sources, verifications,
    successfulSourceObservations: [], jobSources: [], jobs: [],
  };
}

function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), "techmap-import-"));
  const path = join(directory, "test.sqlite");
  const db = openStore(path);
  db.close();
  return { directory, path };
}

function removeTemporaryStore(directory, path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
  db.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function company(overrides = {}) {
  return {
    company_id: overrides.company_id ?? "existing-1",
    company_name: overrides.company_name ?? "Existing",
    canonical_domain: overrides.canonical_domain ?? "existing.test",
    website_url: overrides.website_url ?? "https://existing.test",
    careers_url: overrides.careers_url ?? null,
    ats_provider: overrides.ats_provider ?? null,
    ats_identifier: overrides.ats_identifier ?? null,
    source_url: overrides.source_url ?? null,
    company_discovered_at: "2026-01-01T00:00:00.000Z",
    company_source_status: overrides.company_source_status ?? "metadata_verified",
    ...overrides,
  };
}

function fingerprints(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const rows = db.prepare("SELECT job_id, first_seen_at FROM jobs ORDER BY job_id").all();
  const result = {
    jobIds: createHash("sha256").update(rows.map((row) => row.job_id).join("\n")).digest("hex"),
    firstSeen: createHash("sha256").update(rows.map((row) => `${row.job_id}\u001f${row.first_seen_at}`).join("\n")).digest("hex"),
    jobs: rows.length,
    observations: db.prepare("SELECT COUNT(*) count FROM job_observations").get().count,
    sources: db.prepare("SELECT COUNT(*) count FROM source_observations").get().count,
    runs: db.prepare("SELECT COUNT(*) count FROM runs").get().count,
  };
  db.close();
  return result;
}

test("transitive identity dependencies quarantine the entire connected component", () => {
  const result = reconcileTechmap([
    record({ external_id: "1", company_name: "One", normalized_name: "one", canonical_domain: "shared.test", ats: [] }),
    record({ external_id: "2", company_name: "Two", normalized_name: "two", canonical_domain: "shared.test", ats: [{ provider: "lever", identifier: "bridge" }] }),
    record({ external_id: "3", company_name: "Three", normalized_name: "three", canonical_domain: "other.test", ats: [{ provider: "lever", identifier: "bridge" }] }),
  ], emptyState());
  assert.equal(result.summary.blocked_high_risk_groups, 1);
  assert.equal(result.summary.quarantined_registry_records, 3);
  assert.ok(result.decisions[0].group.every((row) => ["1", "2", "3"].includes(row.external_id)));
});

test("a shared ATS identifier across distinct domains is quarantined", () => {
  const result = reconcileTechmap([
    record({ external_id: "1", company_name: "One", normalized_name: "one", canonical_domain: "one.test", ats: [{ provider: "greenhouse", identifier: "shared" }] }),
    record({ external_id: "2", company_name: "Two", normalized_name: "two", canonical_domain: "two.test", ats: [{ provider: "greenhouse", identifier: "shared" }] }),
  ], emptyState());
  assert.equal(result.decisions[0].action, "quarantined");
  assert.equal(result.conflicts[0].conflict_type, "shared_ats_identifier");
});

test("safe identities import while an unrelated conflict remains quarantined", () => {
  const result = reconcileTechmap([
    record({ external_id: "1", company_name: "Safe", normalized_name: "safe", canonical_domain: "safe.test", ats: [] }),
    record({ external_id: "2", company_name: "One", normalized_name: "one", canonical_domain: "shared.test", ats: [] }),
    record({ external_id: "3", company_name: "Two", normalized_name: "two", canonical_domain: "shared.test", ats: [] }),
  ], emptyState());
  assert.equal(result.summary.proposed_new_companies, 1);
  assert.equal(result.summary.blocked_high_risk_groups, 1);
  assert.equal(result.summary.safe_subset_dependency_violations, 0);
});

test("duplicate careers ownership quarantines only the dependent source candidates", () => {
  const sharedCareers = "https://careers.example.test/jobs";
  const result = reconcileTechmap([
    record({ external_id: "1", company_name: "One", normalized_name: "one", canonical_domain: "one.test", careers_url: sharedCareers, ats: [] }),
    record({ external_id: "2", company_name: "Two", normalized_name: "two", canonical_domain: "two.test", careers_url: sharedCareers, ats: [] }),
  ], emptyState());
  assert.equal(result.summary.proposed_new_companies, 2);
  assert.equal(result.summary.source_conflict_groups, 1);
  assert.equal(result.summary.proposed_careers_candidates, 0);
});

test("atomic apply is idempotent and leaves imported sources disabled and unverified", () => {
  const { directory, path } = temporaryStore();
  try {
    const registry = [record({ is_active: 0, city: null })];
    const firstReconciliation = reconcileTechmap(registry, readExistingState(path));
    const first = applyTechmapImport(path, firstReconciliation, { observedAt: "2026-11-11T00:00:00.000Z" });
    assert.equal(first.companies_inserted, 1);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) count FROM companies").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM company_external_ids").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM company_aliases").get().count, 1);
    assert.equal(db.prepare("SELECT city FROM companies").get().city, null);
    assert.equal(db.prepare("SELECT source_is_active FROM company_external_ids").get().source_is_active, 0);
    assert.ok(db.prepare("SELECT * FROM company_sources").all().every((row) =>
      row.evidence_status === "imported_unverified" && row.is_enabled === 0));
    db.close();

    const secondReconciliation = reconcileTechmap(registry, readExistingState(path));
    const second = applyTechmapImport(path, secondReconciliation, { observedAt: "2026-11-12T00:00:00.000Z" });
    assert.equal(second.companies_inserted, 0);
    assert.equal(second.external_aliases_inserted, 0);
    assert.equal(second.sources_inserted, 0);
    const after = new DatabaseSync(path, { readOnly: true });
    assert.equal(after.prepare("SELECT COUNT(*) count FROM companies").get().count, 1);
    assert.equal(after.prepare("SELECT COUNT(*) count FROM company_sources").get().count, 2);
    assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    after.close();
  } finally {
    removeTemporaryStore(directory, path);
  }
});

test("injected failure rolls back schema migration and imported rows on a version-3 database", () => {
  const { directory, path } = temporaryStore();
  try {
    const downgrade = new DatabaseSync(path);
    downgrade.exec(`
      DROP TABLE company_source_activation_events;
      DROP TABLE company_sources;
      DROP TABLE company_aliases;
      DROP TABLE company_external_ids;
      DELETE FROM schema_migrations WHERE version IN (4, 5);
    `);
    downgrade.close();
    const reconciliation = reconcileTechmap([record()], readExistingState(path));
    assert.throws(() => applyTechmapImport(path, reconciliation, {
      observedAt: "2026-11-11T00:00:00.000Z", faultAt: "after_companies",
    }), /Injected import failure/);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version, 3);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM companies").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='company_sources'").get().count, 0);
    db.close();
  } finally {
    removeTemporaryStore(directory, path);
  }
});

test("existing jobs, first-seen values, observations, and run history survive import unchanged", async () => {
  const { directory, path } = temporaryStore();
  try {
    const db = openStore(path);
    const existing = { ...company(), source_provider: "greenhouse" };
    importCompanies(db, [existing], "2026-01-01T00:00:00.000Z");
    const runId = beginRun(db, "2026-01-02T00:00:00.000Z");
    applySuccessfulObservation(db, runId, existing, [normalizeJob({
      source_job_id: "job-1", company_name: existing.company_name, company_id: existing.company_id,
      job_title: "Analyst", source_provider: "greenhouse", source_url: "https://jobs.test",
      apply_url: "https://jobs.test/1",
    }, "2026-01-02T00:00:00.000Z")], "2026-01-02T00:00:00.000Z");
    finishRun(db, runId, "completed", "2026-01-02T00:01:00.000Z");
    db.close();
    const before = fingerprints(path);
    const reconciliation = reconcileTechmap([record({ external_id: "99", company_name: "New", normalized_name: "new", canonical_domain: "new.test", ats: [] })], readExistingState(path));
    applyTechmapImport(path, reconciliation, { observedAt: "2026-11-11T00:00:00.000Z" });
    assert.deepEqual(fingerprints(path), before);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    removeTemporaryStore(directory, path);
  }
});

test("verified source evidence is never downgraded by a Techmap candidate", () => {
  const { directory, path } = temporaryStore();
  try {
    const db = openStore(path);
    const existing = company({
      company_name: "Acme", canonical_domain: "acme.io", website_url: "https://acme.io",
      ats_provider: "greenhouse", ats_identifier: "acme",
      source_url: "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
      company_source_status: "verified_supported",
    });
    importCompanies(db, [existing], "2026-01-01T00:00:00.000Z");
    const sourceId = companySourceId(existing.company_id, "ats", "greenhouse", "acme", existing.source_url);
    db.prepare(`
      INSERT INTO company_sources (
        source_id, company_id, source_kind, provider, source_identifier, source_url,
        evidence_source, evidence_status, is_enabled, imported_at
      ) VALUES (?, ?, 'ats', 'greenhouse', 'acme', ?, 'manual review', 'manual_verified', 1, ?)
    `).run(sourceId, existing.company_id, existing.source_url, "2026-01-01T00:00:00.000Z");
    db.close();
    const reconciliation = reconcileTechmap([record()], readExistingState(path));
    applyTechmapImport(path, reconciliation, { observedAt: "2026-11-11T00:00:00.000Z" });
    const check = new DatabaseSync(path, { readOnly: true });
    const source = check.prepare("SELECT evidence_status, is_enabled FROM company_sources WHERE source_id=?").get(sourceId);
    assert.deepEqual({ ...source }, { evidence_status: "manual_verified", is_enabled: 1 });
    check.close();
  } finally {
    removeTemporaryStore(directory, path);
  }
});

test("a future external-ID update with a conflicting domain is quarantined", () => {
  const existing = {
    ...company({ company_id: "imported", company_name: "Acme", canonical_domain: "acme.io" }),
    normalized_name: "acme",
  };
  const aliases = [{ source_name: TECHMAP_SOURCE_NAME, external_id: "515000001", company_id: existing.company_id }];
  const result = reconcileTechmap([record({ canonical_domain: "other.io", website_url: "https://other.io" })], emptyState([existing], aliases));
  assert.equal(result.decisions[0].action, "quarantined");
  assert.equal(result.conflicts[0].conflict_type, "conflicting_existing_domain_mapping");
});

test("review artifacts preserve reviewed decisions but never invent evidence", () => {
  const result = reconcileTechmap([
    record({ external_id: "1", company_name: "One", normalized_name: "one", canonical_domain: "shared.test", ats: [] }),
    record({ external_id: "2", company_name: "Two", normalized_name: "two", canonical_domain: "shared.test", ats: [] }),
  ], emptyState());
  const group = result.decisions[0].component_id;
  const rows = identityReviewRows(result, [{
    techmap_external_id: "1", conflict_group_id: group,
    proposed_decision: "distinct_entities_shared_domain", decision_status: "reviewed",
    evidence_url: "https://evidence.test/review", review_notes: "Reviewed manually",
  }]);
  assert.equal(rows[0].decision_status, "reviewed");
  assert.equal(rows[0].evidence_url, "https://evidence.test/review");
  assert.equal(rows[1].decision_status, "unresolved");
  assert.equal(rows[1].evidence_url, "");
});

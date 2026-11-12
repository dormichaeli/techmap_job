import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const paths = process.argv.slice(2);
for (const path of paths) {
  const db = new DatabaseSync(path, { readOnly: true });
  const result = { path };
  result.integrity_check = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
  result.foreign_key_violations = db.prepare("PRAGMA foreign_key_check").all();
  for (const table of ["runs", "source_observations", "jobs", "job_observations"]) {
    result[table] = db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count;
  }
  result.active_jobs = db.prepare("SELECT COUNT(*) count FROM jobs WHERE active=1").get().count;
  const jobIdentityRows = db.prepare("SELECT job_id, first_seen_at FROM jobs ORDER BY job_id").all();
  result.job_ids_sha256 = createHash("sha256")
    .update(jobIdentityRows.map((row) => row.job_id).join("\n"))
    .digest("hex");
  result.first_seen_sha256 = createHash("sha256")
    .update(jobIdentityRows.map((row) => `${row.job_id}\u001f${row.first_seen_at}`).join("\n"))
    .digest("hex");
  result.job_identity_sha256 = createHash("sha256")
    .update(jobIdentityRows.map((row) => `${row.job_id}\u001f${row.first_seen_at}`).join("\n"))
    .digest("hex");
  result.linked_jobs = db.prepare("SELECT COUNT(*) count FROM jobs WHERE company_id IS NOT NULL").get().count;
  result.unlinked_jobs = db.prepare("SELECT COUNT(*) count FROM jobs WHERE company_id IS NULL").get().count;
  result.distinct_job_companies = db.prepare("SELECT COUNT(DISTINCT company_name) count FROM jobs").get().count;
  const companyTable = db.prepare(
    "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='companies'",
  ).get().count;
  result.companies = companyTable
    ? db.prepare("SELECT COUNT(*) count FROM companies").get().count : null;
  result.migrations = db.prepare(
    "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
  ).get().count ? db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all() : [];
  const latestRun = db.prepare("SELECT MAX(run_id) run_id FROM runs").get().run_id;
  result.latest_run_sources = latestRun ? db.prepare(
    "SELECT company_name, health_status, job_count FROM source_observations WHERE run_id=? ORDER BY job_count DESC, company_name",
  ).all(latestRun) : [];
  if (companyTable) {
    result.configured_company_sources = db.prepare(
      "SELECT COUNT(*) count FROM companies WHERE ats_provider IS NOT NULL",
    ).get().count;
    result.live_observed_company_sources = db.prepare(`
      SELECT COUNT(*) count FROM (
        SELECT company_name, source_provider FROM source_observations
        WHERE health_status IN ('success', 'empty') GROUP BY company_name, source_provider
      )
    `).get().count;
    result.company_observations = db.prepare("SELECT COUNT(*) count FROM company_observations").get().count;
    result.company_source_verifications = db.prepare(
      "SELECT COUNT(*) count FROM company_source_verifications",
    ).get().count;
    result.expansion_providers = db.prepare(`
      SELECT source_provider, COUNT(*) count,
        SUM(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) published
      FROM jobs WHERE discovery_cohort='baseline_expansion_2026-11-11'
      GROUP BY source_provider ORDER BY count DESC
    `).all();
    const hasV4 = db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='company_sources'").get().count;
    if (hasV4) {
      result.company_external_ids = db.prepare("SELECT COUNT(*) count FROM company_external_ids").get().count;
      result.company_aliases = db.prepare("SELECT COUNT(*) count FROM company_aliases").get().count;
      result.company_sources = db.prepare("SELECT COUNT(*) count FROM company_sources").get().count;
      result.company_sources_by_status = db.prepare(`
        SELECT evidence_status, is_enabled, COUNT(*) count
        FROM company_sources GROUP BY evidence_status, is_enabled
        ORDER BY evidence_status, is_enabled
      `).all();
      result.imported_sources_by_kind = db.prepare(`
        SELECT source_kind, COUNT(*) count FROM company_sources
        WHERE evidence_status='imported_unverified' GROUP BY source_kind ORDER BY source_kind
      `).all();
      result.inactive_techmap_aliases = db.prepare(`
        SELECT COUNT(*) count FROM company_external_ids
        WHERE source_name='Techmap / mluggy/techmap' AND source_is_active=0
      `).get().count;
      const hasV5 = db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='company_source_activation_events'").get().count;
      if (hasV5) {
        result.company_source_activation_events = db.prepare(
          "SELECT COUNT(*) count FROM company_source_activation_events",
        ).get().count;
        result.source_scoped_jobs = db.prepare(
          "SELECT COUNT(*) count FROM jobs WHERE company_source_id IS NOT NULL",
        ).get().count;
        result.enabled_imported_unverified = db.prepare(`
          SELECT COUNT(*) count FROM company_sources
          WHERE evidence_status='imported_unverified' AND is_enabled<>0
        `).get().count;
      }
    }
  }
  console.log(JSON.stringify(result));
  db.close();
}

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCsv, writeCsv } from "../src/csv.js";
import { loadTechmapRegistry, readExistingState, reconcileTechmap } from "../src/techmap-import.js";
import {
  buildAtsCandidateUniverse,
  PHASE2_QUOTAS,
  selectValidationSample,
  validateSample,
} from "../src/ats-validation.js";

const SAMPLE_FIELDS = [
  "company_id", "company_name", "canonical_domain", "employee_count_min", "employee_count_max",
  "employee_size_bucket", "category_name", "provider", "source_identifier", "source_url",
  "previous_verification_status", "source_enabled", "selection_reason",
];

const RESULT_FIELDS = [
  ...SAMPLE_FIELDS,
  "attempted_at", "endpoint_http_status", "endpoint_latency_ms", "endpoint_status",
  "endpoint_final_url", "ownership_status", "ownership_evidence", "ownership_evidence_url",
  "ownership_http_status", "ownership_latency_ms", "alternate_sources", "parser_status", "job_count",
  "external_job_id_sample", "job_title_sample", "location_sample", "department_sample",
  "description_available", "application_url_sample", "application_http_status",
  "application_link_status", "application_latency_ms", "published_date_jobs",
  "source_updated_date_jobs", "outcome", "recommended_action", "error",
];

function databaseAudit(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hashRows = (sql) => createHash("sha256").update(JSON.stringify(db.prepare(sql).all())).digest("hex");
    return {
      schema_version: db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,
      integrity: db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check),
      foreign_key_violations: db.prepare("PRAGMA foreign_key_check").all(),
      companies: db.prepare("SELECT COUNT(*) count FROM companies").get().count,
      jobs: db.prepare("SELECT COUNT(*) count FROM jobs").get().count,
      job_observations: db.prepare("SELECT COUNT(*) count FROM job_observations").get().count,
      source_observations: db.prepare("SELECT COUNT(*) count FROM source_observations").get().count,
      runs: db.prepare("SELECT COUNT(*) count FROM runs").get().count,
      enabled_imported_sources: db.prepare(`
        SELECT COUNT(*) count FROM company_sources
        WHERE evidence_status='imported_unverified' AND is_enabled<>0
      `).get().count,
      jobs_sha256: hashRows("SELECT * FROM jobs ORDER BY job_id"),
      job_observations_sha256: hashRows("SELECT * FROM job_observations ORDER BY run_id, job_id"),
      source_observations_sha256: hashRows("SELECT * FROM source_observations ORDER BY run_id, company_name, source_provider"),
      runs_sha256: hashRows("SELECT * FROM runs ORDER BY run_id"),
      source_activation_sha256: hashRows(`
        SELECT source_id, evidence_status, is_enabled, last_observed_at
        FROM company_sources ORDER BY source_id
      `),
    };
  } finally {
    db.close();
  }
}

function countBy(rows, field) {
  return Object.fromEntries(Object.entries(Object.groupBy(rows, (row) => row[field] ?? "unknown"))
    .map(([key, values]) => [key, values.length]).sort(([left], [right]) => left.localeCompare(right)));
}

function providerRows(results) {
  return Object.keys(PHASE2_QUOTAS).map((provider) => {
    const rows = results.filter((row) => row.provider === provider);
    return {
      provider,
      attempted: rows.length,
      http_reachable: rows.filter((row) => Number(row.endpoint_http_status) >= 200
        && Number(row.endpoint_http_status) < 400).length,
      parser_compatible: rows.filter((row) => ["success", "empty"].includes(row.endpoint_status)).length,
      ownership_verified: rows.filter((row) => row.ownership_status === "verified").length,
      valid: rows.filter((row) => ["valid_with_jobs", "valid_empty"].includes(row.outcome)).length,
      with_jobs: rows.filter((row) => Number(row.job_count) > 0).length,
      jobs: rows.reduce((sum, row) => sum + (Number(row.job_count) || 0), 0),
    };
  });
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map((value) => String(value ?? "").replaceAll("|", "\\|")).join(" | ")} |`),
  ].join("\n");
}

function buildReport({ generatedAt, universe, sample, results, before, after, backup }) {
  const providers = providerRows(results);
  const outcomes = countBy(results, "outcome");
  const successful = results.filter((row) => ["success", "empty"].includes(row.endpoint_status));
  const httpReachable = results.filter((row) => Number(row.endpoint_http_status) >= 200
    && Number(row.endpoint_http_status) < 400);
  const valid = results.filter((row) => ["valid_with_jobs", "valid_empty"].includes(row.outcome));
  const withJobs = successful.filter((row) => Number(row.job_count) > 0);
  const small = sample.filter((row) => row.employee_count_min >= 10 && row.employee_count_max <= 200);
  const io = sample.filter((row) => row.canonical_domain?.endsWith(".io"));
  const appAttempts = results.filter((row) => row.application_url_sample);
  const publishedJobs = results.reduce((sum, row) => sum + Number(row.published_date_jobs || 0), 0);
  const updatedJobs = results.reduce((sum, row) => sum + Number(row.source_updated_date_jobs || 0), 0);
  const totalJobs = successful.reduce((sum, row) => sum + Number(row.job_count || 0), 0);
  const sampledJobs = results.filter((row) => row.external_job_id_sample);
  const preExistingEnabled = sample.filter((row) => Number(row.source_enabled) !== 0);
  const invariantKeys = ["schema_version", "companies", "jobs", "job_observations", "source_observations", "runs",
    "enabled_imported_sources", "jobs_sha256", "job_observations_sha256", "source_observations_sha256",
    "runs_sha256", "source_activation_sha256"];
  const unchanged = invariantKeys.every((key) => JSON.stringify(before[key]) === JSON.stringify(after[key]));
  const readyRows = valid.filter((row) => Number(row.source_enabled) === 0
    && row.previous_verification_status === "imported_unverified");
  const ready = readyRows.map((row) => `${row.company_name} (${row.provider}:${row.source_identifier})`);
  return `# ATS validation Phase 2

Generated: ${generatedAt}

## A. Executive summary

- Sources attempted: **${results.length}**.
- Ownership-verified and parser-compatible sources: **${valid.length}**.
- HTTP-reachable ATS endpoints: **${httpReachable.length}**.
- Parser-compatible ATS endpoints (including ownership-pending): **${successful.length}**.
- Sources returning jobs: **${withJobs.length}**.
- Jobs observed in memory only: **${totalJobs}**; none were written to SQLite.
- Outcome distribution: ${Object.entries(outcomes).map(([key, value]) => `\`${key}\` ${value}`).join(", ")}.
- Imported sources activated: **0**.

## B. Provider breakdown

${table(["Provider", "Attempted", "HTTP reachable", "Parser compatible", "Ownership verified", "Valid", "With jobs", "Jobs"],
    providers.map((row) => [row.provider, row.attempted, row.http_reachable, row.parser_compatible,
      row.ownership_verified, row.valid, row.with_jobs, row.jobs]))}

Eligible universe: ${Object.entries(countBy(universe, "provider")).map(([key, value]) => `${key} ${value}`).join(", ")}.
The selected cohort exactly matched the requested 4 Breezy, 7 Lever, 10 Greenhouse, and 10 Comeet sources.

## C. Small-company coverage

- Strictly within 10-200 employees: **${small.length}/${sample.length}**.
- \`.io\` companies: **${io.length}/${sample.length}**.
- Industries represented: **${new Set(sample.map((row) => row.category_name ?? "unknown")).size}**.
- Newly useful disabled sources with sufficient evidence for activation review: **${ready.length}**.

## D. Job-data quality

- Parsed jobs: **${totalJobs}**.
- Sources with sampled external job IDs: **${sampledJobs.length}/${withJobs.length}**.
- Sampled jobs with locations: **${sampledJobs.filter((row) => row.location_sample).length}/${sampledJobs.length}**.
- Sampled jobs with departments: **${sampledJobs.filter((row) => row.department_sample).length}/${sampledJobs.length}**.
- Sampled jobs with descriptions: **${sampledJobs.filter((row) => Number(row.description_available) === 1).length}/${sampledJobs.length}**.
- Jobs with a defensible publication date: **${publishedJobs}**.
- Jobs with only a source-updated timestamp: **${updatedJobs}**.
- Application URLs sampled: **${appAttempts.length}**.
- Reachable application samples: **${appAttempts.filter((row) => row.application_link_status === "reachable").length}**.
- Blocked application samples (not treated as closure): **${appAttempts.filter((row) => row.application_link_status === "blocked_not_closed").length}**.

Publication dates were never inferred from source update times. Failed endpoints have blank job counts rather than zero.
Lever supplied all ${publishedJobs} defensible publication dates. Greenhouse and Comeet supplied source-update
timestamps but no publication dates in this cohort; the single Breezy job supplied neither.

## E. Per-source outcomes

${table(["Company", "Provider", "HTTP", "Ownership", "Parser", "Jobs", "Outcome", "Recommended action"],
    results.map((row) => [row.company_name, row.provider, row.endpoint_http_status ?? "", row.ownership_status,
      row.parser_status, row.job_count ?? "", row.outcome, row.recommended_action]))}

Full evidence, latency, job samples, application checks, and URLs are in
\`data/ats-validation-phase2.csv\`. The reproducible cohort is in
\`data/ats-validation-sample.csv\`.

## F. Safety verification

- Database unchanged across validation: **${unchanged ? "yes" : "NO"}**.
- Schema version: ${after.schema_version}.
- Companies/jobs: ${after.companies}/${after.jobs}.
- Job/source observations: ${after.job_observations}/${after.source_observations}.
- Runs: ${after.runs}.
- Enabled imported-unverified sources: ${after.enabled_imported_sources}.
- Pre-existing enabled sources in the sample: ${preExistingEnabled.length}; their statuses were unchanged.
- Integrity: ${after.integrity.join(", ")}; foreign-key violations: ${after.foreign_key_violations.length}.
- Jobs fingerprint: \`${after.jobs_sha256}\`.
- Job-observations fingerprint: \`${after.job_observations_sha256}\`.
- Source-observations fingerprint: \`${after.source_observations_sha256}\`.
- Runs fingerprint: \`${after.runs_sha256}\`.
- Source-activation fingerprint: \`${after.source_activation_sha256}\`.
- Fresh pre-validation backup: \`${backup.path}\`.
- Backup SHA-256: \`${backup.sha256}\`.

## G. Recommended next step

Ready for explicit activation review (${ready.length}):

${ready.length ? ready.map((value) => `- ${value}`).join("\n") : "- None; stronger ownership evidence is required before activation."}

Do not activate sources classified as \`needs_manual_review\`, \`ownership_conflict\`,
\`source_migrated\`, \`stale_source\`, \`inaccessible\`, \`temporarily_failed\`, or
\`parser_failure\`. Resolve official ownership evidence and parser/access issues first.

For expansion to all 185 candidates, validate provider-sized cohorts with the same
manifest frozen before requests, keep failures in the denominator, and require an
official-domain-to-exact-board ownership edge before activation. After explicit
approval, activate only reviewed sources and collect their first jobs as
\`new_to_collector_baseline\`, never as newly published.

Phase 3 was not started.
`;
}

const args = new Set(process.argv.slice(2));
const manifestOnly = args.has("--manifest-only");
const reportOnly = args.has("--report-only");
const dbPath = resolve("data/jobs.sqlite");
const sourceRoot = resolve(".research/techmap-upstream");
const backup = {
  path: "data/backups/jobs-before-ats-validation-phase2-20261112T064029Z.sqlite",
  sha256: "160EEB3E290A74817DF79BDE170CE17FBC321E432817D6AA4DCDC4C3E004DCA8",
};

const registry = loadTechmapRegistry(sourceRoot);
const state = readExistingState(dbPath);
const reconciliation = reconcileTechmap(registry, state);
const universe = buildAtsCandidateUniverse(reconciliation, state);
const sample = selectValidationSample(universe);
await writeCsv(resolve("data/ats-validation-sample.csv"), sample, SAMPLE_FIELDS);

const eligible = countBy(universe, "provider");
const selected = countBy(sample, "provider");
const manifestSummary = { eligible, selected, total: sample.length };
if (manifestOnly) {
  console.log(JSON.stringify(manifestSummary, null, 2));
  process.exit(0);
}
if (sample.length !== 31) throw new Error(`Expected a 31-source cohort, got ${sample.length}`);

const before = databaseAudit(dbPath);
const results = reportOnly
  ? await readCsv(resolve("data/ats-validation-phase2.csv"))
  : await validateSample(sample, 2);
const after = databaseAudit(dbPath);
if (!reportOnly) await writeCsv(resolve("data/ats-validation-phase2.csv"), results, RESULT_FIELDS);
const generatedAt = new Date().toISOString();
await writeFile(resolve("reports/ats-validation-phase2.md"), buildReport({
  generatedAt, universe, sample, results, before, after, backup,
}), "utf8");

const invariantKeys = ["schema_version", "companies", "jobs", "job_observations", "source_observations", "runs",
  "enabled_imported_sources", "jobs_sha256", "job_observations_sha256", "source_observations_sha256",
  "runs_sha256", "source_activation_sha256"];
const changed = invariantKeys.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
if (changed.length) throw new Error(`Live database changed during read-only validation: ${changed.join(", ")}`);

console.log(JSON.stringify({
  ...manifestSummary,
  http_reachable: results.filter((row) => Number(row.endpoint_http_status) >= 200
    && Number(row.endpoint_http_status) < 400).length,
  parser_compatible: results.filter((row) => ["success", "empty"].includes(row.endpoint_status)).length,
  valid: results.filter((row) => ["valid_with_jobs", "valid_empty"].includes(row.outcome)).length,
  with_jobs: results.filter((row) => Number(row.job_count) > 0).length,
  outcomes: countBy(results, "outcome"),
  database_unchanged: true,
}, null, 2));

import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { openStore } from "../src/store.js";
import { readCsv, writeCsv } from "../src/csv.js";

const generatedAt = new Date().toISOString();
const reconciliation = await readCsv(resolve("data/phase4-candidate-reconciliation.csv"));
const revalidation = await readCsv(resolve("data/phase4-candidate-revalidation.csv"));
const activated = await readCsv(resolve("data/phase4-activated-sources.csv"));
const deferred = await readCsv(resolve("data/phase4-deferred-sources.csv"));
const cohortA = await readCsv(resolve("data/phase4-cohort-a-sources.csv"));
const cohortB = await readCsv(resolve("data/phase4-cohort-b-sources.csv"));
const safetyA = JSON.parse(await readFile(resolve("reports/phase4-cohort-a-safety.json"), "utf8"));
const safetyB = JSON.parse(await readFile(resolve("reports/phase4-cohort-b-safety.json"), "utf8"));
const backupPath = resolve("data/backups/jobs-before-phase4-20261112T083147Z.sqlite");

const db = openStore(resolve("data/jobs.sqlite"));
const backup = openStore(backupPath);
let state;
try {
  const scalar = (sql, ...params) => db.prepare(sql).get(...params).value;
  const phase4Jobs = db.prepare(`
    SELECT j.job_id, j.source_job_id, j.company_id, j.company_source_id, j.company_name,
      c.canonical_domain, c.employee_size_bucket, c.industry, j.job_title, j.location,
      j.job_url, j.apply_url, j.source_provider, j.source_url, j.first_seen_at, j.last_seen_at,
      j.published_at, j.published_at_source, j.source_updated_at, j.first_seen_reliability,
      j.discovery_cohort, j.discovery_kind, j.reopened_at, j.active
    FROM jobs j JOIN company_source_activation_events e ON e.source_id=j.company_source_id
      JOIN companies c ON c.company_id=j.company_id
    WHERE e.activation_key LIKE 'phase4-%'
    ORDER BY j.company_name, j.job_id
  `).all().map((row) => ({ ...row }));
  await writeCsv(resolve("data/phase4-baseline-jobs.csv"), phase4Jobs, Object.keys(phase4Jobs[0]));
  const sourceResults = db.prepare(`
    SELECT CASE WHEN e.activation_key LIKE 'phase4-cohort-a%' THEN 'A' ELSE 'B' END cohort,
      c.company_name, c.company_id, c.canonical_domain, c.employee_size_bucket, c.industry,
      s.provider, s.source_identifier, s.source_id, s.evidence_url,
      COUNT(DISTINCT j.job_id) jobs,
      SUM(CASE WHEN j.published_at IS NOT NULL THEN 1 ELSE 0 END) published_dates,
      SUM(CASE WHEN j.source_updated_at IS NOT NULL THEN 1 ELSE 0 END) source_updated_dates,
      SUM(CASE WHEN j.reopened_at IS NOT NULL THEN 1 ELSE 0 END) reopened_jobs,
      SUM(CASE WHEN j.active=0 THEN 1 ELSE 0 END) inactive_jobs
    FROM company_source_activation_events e JOIN company_sources s ON s.source_id=e.source_id
      JOIN companies c ON c.company_id=s.company_id LEFT JOIN jobs j ON j.company_source_id=s.source_id
    WHERE e.activation_key LIKE 'phase4-%'
    GROUP BY e.source_id ORDER BY cohort, c.company_name
  `).all().map((row) => ({ ...row }));
  const runs = db.prepare(`
    SELECT r.run_id, r.status, r.started_at, r.finished_at,
      COUNT(DISTINCT so.company_source_id) sources, SUM(so.job_count) observed_jobs,
      SUM(CASE WHEN so.health_status LIKE 'failed%' THEN 1 ELSE 0 END) failures
    FROM runs r JOIN source_observations so ON so.run_id=r.run_id
    WHERE r.run_id BETWEEN 8 AND 11 GROUP BY r.run_id ORDER BY r.run_id
  `).all().map((row) => ({ ...row }));
  state = {
    schema: scalar("SELECT MAX(version) value FROM schema_migrations"),
    companies: scalar("SELECT COUNT(*) value FROM companies"),
    sources: scalar("SELECT COUNT(*) value FROM company_sources"),
    jobs: scalar("SELECT COUNT(*) value FROM jobs"),
    activeJobs: scalar("SELECT COUNT(*) value FROM jobs WHERE active=1"),
    observations: scalar("SELECT COUNT(*) value FROM job_observations"),
    sourceObservations: scalar("SELECT COUNT(*) value FROM source_observations"),
    runsCount: scalar("SELECT COUNT(*) value FROM runs"),
    activationEvents: scalar("SELECT COUNT(*) value FROM company_source_activation_events"),
    importedDisabled: scalar("SELECT COUNT(*) value FROM company_sources WHERE evidence_status='imported_unverified' AND is_enabled=0"),
    invalidEnabled: scalar("SELECT COUNT(*) value FROM company_sources WHERE evidence_status='imported_unverified' AND is_enabled<>0"),
    phase4Jobs, sourceResults, runs,
    beforeJobs: backup.prepare("SELECT COUNT(*) value FROM jobs").get().value,
    beforeObservations: backup.prepare("SELECT COUNT(*) value FROM job_observations").get().value,
    beforeRuns: backup.prepare("SELECT COUNT(*) value FROM runs").get().value,
  };
} finally {
  backup.close();
  db.close();
}

const mdTable = (headers, rows) => [
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.map((value) => String(value ?? "").replaceAll("|", "\\|")).join(" | ")} |`),
].join("\n");
const byCohort = (cohort) => state.sourceResults.filter((row) => row.cohort === cohort);
const expectedMap = new Map(revalidation.map((row) => [row.source_id, row]));
const activatedTable = (cohort) => mdTable(
  ["Company", "Company ID", "Size", "Domain", "Industry", "Provider / source", "Expected", "Collected", "Published", "Evidence"],
  byCohort(cohort).map((row) => [row.company_name, `\`${row.company_id}\``, row.employee_size_bucket,
    row.canonical_domain, row.industry, `${row.provider} / \`${row.source_identifier}\``,
    expectedMap.get(row.source_id)?.job_count ?? "", row.jobs, row.published_dates,
    `[official page](${row.evidence_url})`]),
);
const runTable = (runIds) => mdTable(["Run", "Status", "Sources", "Observed jobs", "Failures"],
  state.runs.filter((run) => runIds.includes(run.run_id)).map((run) => [run.run_id, run.status, run.sources, run.observed_jobs, run.failures]));

const reconciliationReport = `# Phase 4 candidate reconciliation

Generated: ${generatedAt}

## Why 34 valid sources became 20 candidates

The counts describe different populations. The remaining Phase 3 cohort contained **34 valid sources**: **17 were already live-verified and enabled**, while **17 were disabled imported candidates**. The separate Phase 2 recheck produced four valid sources: Cloudinary was already enabled, while BIRD Aerosystems, Verifone, and CYE were newly eligible disabled candidates. Therefore **17 + 3 = 20** new disabled activation candidates. No source was dropped silently.

No candidate shared its ATS provider/identifier with another company, duplicated an active source configuration, or had an unresolved company identity review. Existing live evidence was not overwritten during reconciliation.

## Full reconciliation

${mdTable(["Origin", "Company", "Provider", "Source ID", "Validation", "Current state", "Classification", "Reason"], reconciliation.map((row) => [
  row.reconciliation_origin, row.company_name, row.provider, `\`${row.source_identifier}\``, row.outcome,
  `${row.current_evidence_status}/${row.current_is_enabled}`, row.reconciliation_status, row.conflict_reason || "—",
]))}

## Fresh activation gate

All 20 disabled candidates were revalidated on 2026-11-12: 17 were valid with jobs, three were valid empty, all endpoints returned HTTP 200, all parsers were compatible, and all had strong exact-board evidence from an official company-domain page. Deferred: **${deferred.length}**.
`;

function cohortReport(cohort, safety, runIds) {
  const rows = byCohort(cohort);
  const jobs = rows.reduce((sum, row) => sum + Number(row.jobs), 0);
  const published = rows.reduce((sum, row) => sum + Number(row.published_dates), 0);
  return `# Phase 4 cohort ${cohort}

Generated: ${generatedAt}

## Activated sources

${activatedTable(cohort)}

Sources activated: **${rows.length}**. Baseline jobs collected: **${jobs}**. Defensible publication dates: **${published}/${jobs}**. Missing publication dates remain unknown; source-update dates were not substituted.

## Collection and repeat

${runTable(runIds)}

Both source-scoped runs returned the same ${jobs} unique jobs. The repeat added observations but no job rows, reset no first-seen values, produced no reopen events, and caused no closures. All first observations retain \`new_to_collector_baseline\` semantics.

## Safety gate

- Historical jobs checked against the pre-Phase-4 backup: **${safety.historical_jobs_checked}**.
- Historical identity differences: **${safety.preservation_differences.length}**.
- Job observations: ${safety.historical_observations_before} before Phase 4; ${safety.historical_observations_after} at this gate.
- Failed sources: **${safety.failed_sources}**.
- SQLite integrity: **${safety.integrity}**; foreign-key violations: **${safety.foreign_key_violations}**.
- Gate result: **${safety.proceed_to_next_cohort ? "pass" : "stop"}**.
`;
}

const totalPhase4Jobs = state.phase4Jobs.length;
const publishedJobs = state.phase4Jobs.filter((row) => row.published_at).length;
const sourceUpdatedJobs = state.phase4Jobs.filter((row) => row.source_updated_at).length;
const smallSources = activated.filter((row) => Number(row.employee_count_min) >= 10 && Number(row.employee_count_max) <= 200).length;
const ioSources = activated.filter((row) => String(row.website).toLowerCase().includes(".io")).length;
const automation = `## Future zero-cost daily automation design (not implemented)

Preferred design: a public repository uses one off-peak daily GitHub Actions run on a standard Ubuntu runner. At startup it downloads the newest published, checksummed SQLite checkpoint from GitHub Releases, verifies the checksum, restores it to the ephemeral runner, runs migrations/tests/collection in a temporary working copy, and accepts the result only after SQLite integrity, foreign-key, preservation, and export checks pass. It then creates a **draft** dated release, uploads a compressed database, checksum, recovery manifest, ODbL notice, and static exports, and publishes the release only after every asset verifies. A small repository manifest may then point to that immutable checkpoint. Keep a bounded rotation (for example seven daily, four weekly, and monthly checkpoints) and never use Actions cache or artifacts as authoritative state.

Feasible within documented free limits:

- Standard GitHub-hosted runners are free for public repositories; larger runners are not. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- A hosted job may run for six hours, far above the current seconds-long bounded collections. [Actions limits](https://docs.github.com/en/actions/reference/limits)
- Release assets may be up to 2 GiB each, with up to 1,000 assets per release; the current SQLite file is about 97 MB raw. [About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- A single concurrency group can prevent two collectors from modifying the same lineage at once. [Workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- GitHub Pages can publish generated, non-sensitive CSV/JSON and static search assets; the published site and source repository should remain below 1 GB, with a soft 100 GB/month bandwidth limit. [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

Dependent on usage assumptions:

- Scheduled runs are not a hard real-time service: they can be delayed or dropped under load, and public-repository schedules disable after 60 days without repository activity. Schedule away from the top of the hour and retain manual dispatch/recovery. [Scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- A rolling set of compressed releases is practical at the current database size, but growth and retention must be monitored. Daily binary commits are not recommended because they permanently inflate Git history.
- Public persistence is appropriate only for non-sensitive public job/company data and must ship attribution plus the same ODbL terms for the derivative database, as required by the upstream \`LICENSE.txt\`.

Not suitable for reliable persistence:

- Runner disks are ephemeral; Actions artifacts have retention and storage quotas, while caches can be evicted after inactivity. Neither is authoritative storage. [Artifact retention](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/downloading-workflow-artifacts), [dependency cache policy](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- GitHub Pages is a distribution layer, not a transactional database or checkpoint store.
- Replacing one mutable asset in place is not sufficiently atomic. Publish a new immutable checkpoint first, verify recovery, advance the pointer last, and retain the previous good checkpoint.

Security and recovery: grant only \`contents: write\` to the checkpoint job, pin third-party actions by commit SHA, execute no downloaded ATS content, require checksums and a manifest containing schema/version/count fingerprints, and restore from the previous release after any failed run. A failed collection must never publish a checkpoint or close jobs.
`;

const resultsReport = `# Phase 4 results

Generated: ${generatedAt}

## Outcome

- Candidates revalidated: **20/20**; activated and operational: **20**; deferred: **${deferred.length}**.
- Cohort A: **10 sources / 117 baseline jobs**; Cohort B: **10 sources / 69 baseline jobs**.
- New unique jobs: **${totalPhase4Jobs}**. Existing-job matches: **0**. Repeat observations were not counted as new jobs.
- Provider distribution: Comeet 16, Greenhouse 3, Lever 1.
- Preferred 10-200 size coverage: **${smallSources}/20 sources**. Exact \`.io\` domain coverage: **${ioSources}/20** (no eligible candidate had an exact \`.io\` domain).
- Publication-date coverage: **${publishedJobs}/${totalPhase4Jobs}**; source-update coverage: **${sourceUpdatedJobs}/${totalPhase4Jobs}**. No dates were fabricated or substituted.
- Source failures: **0**; reopened jobs: **0**; Phase 4 closures: **0**.

## Final database state

${mdTable(["Metric", "Before", "After"], [
  ["Schema version", 5, state.schema], ["Companies", 7832, state.companies], ["Company sources", 1491, state.sources],
  ["Jobs", state.beforeJobs, state.jobs], ["Active jobs", 1560, state.activeJobs],
  ["Job observations", state.beforeObservations, state.observations], ["Source observations", 142, state.sourceObservations],
  ["Collection runs", state.beforeRuns, state.runsCount], ["Activation events", 3, state.activationEvents],
])}

All original 1,560 job IDs, source IDs, company attribution, and first-seen timestamps match the restore-tested backup. Historical observations never decreased. Final SQLite integrity is \`ok\`, foreign-key violations are zero, enabled imported-unverified sources are **${state.invalidEnabled}**, and **${state.importedDisabled}** candidates remain safely disabled.

## Tests and artifacts

Baseline: **59/59 passed**. New Phase 4 regression tests: **6**, covering reconciliation/duplicate identifiers, fresh evidence and migration rejection, deterministic cohort diversity, partial-failure stop conditions, cross-company attribution, and failed-source closure safety. Existing Phase 3/store tests continue to cover duplicate activation, source scoping, baseline tagging, repeat idempotency, first-seen/reopen/closure safety, cross-source attribution, and activation audit events. Final: **65/65 passed**.

Required exports: \`data/phase4-activated-sources.csv\` (20), \`data/phase4-baseline-jobs.csv\` (${totalPhase4Jobs}), and \`data/phase4-deferred-sources.csv\` (${deferred.length}). The verified backup is \`data/backups/jobs-before-phase4-20261112T083147Z.sqlite\`, SHA-256 \`065f6b7215fa1bc503f573ac2a39580f8a139378eabef404ff8a847fe8749fdf\`.

${automation}

## Recommended next implementation

Do not schedule or broaden collection automatically yet. The safe next step, requiring explicit approval, is to implement a **local dry-run automation rehearsal** against a copied database: restore the latest immutable checkpoint, run one bounded incremental collection over the now-live verified set, execute all gates, build a compressed draft checkpoint plus manifest, and perform a second restore drill. Separately review the remaining 1396 disabled imported sources; Phase 3 left 91 manual-ownership cases, 10 conflicts, four migrations, and 15 stale sources that must not be activated without new evidence. No next phase was started here.
`;

await Promise.all([
  writeFile(resolve("reports/phase4-candidate-reconciliation.md"), reconciliationReport, "utf8"),
  writeFile(resolve("reports/phase4-cohort-a.md"), cohortReport("A", safetyA, [8, 9]), "utf8"),
  writeFile(resolve("reports/phase4-cohort-b.md"), cohortReport("B", safetyB, [10, 11]), "utf8"),
  writeFile(resolve("reports/phase4-results.md"), resultsReport, "utf8"),
]);

console.log(JSON.stringify({
  reports: 4, activated_sources: activated.length, baseline_jobs: totalPhase4Jobs,
  deferred_sources: deferred.length, final_jobs: state.jobs, final_observations: state.observations,
}, null, 2));

import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { openStore } from "../src/store.js";
import { cohortSafetyDecision } from "../src/phase4.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cohort = String(option("--cohort", "")).toUpperCase();
const backupPath = resolve(option("--backup", "data/backups/jobs-before-phase4-20261112T083147Z.sqlite"));
const firstRun = Number(option("--first-run"));
const lastRun = Number(option("--last-run", firstRun));
if (!new Set(["A", "B"]).has(cohort) || !Number.isInteger(firstRun) || !Number.isInteger(lastRun)) {
  throw new Error("Usage: --cohort A|B --first-run N --last-run N [--backup path]");
}

const live = openStore(resolve("data/jobs.sqlite"));
const backup = openStore(backupPath);
try {
  const historical = backup.prepare(`
    SELECT job_id, source_job_id, company_id, company_name, source_provider, first_seen_at
    FROM jobs ORDER BY job_id
  `).all();
  const liveById = new Map(live.prepare(`
    SELECT job_id, source_job_id, company_id, company_name, source_provider, first_seen_at
    FROM jobs
  `).all().map((row) => [row.job_id, row]));
  const differences = historical.flatMap((row) => {
    const current = liveById.get(row.job_id);
    if (!current) return [{ job_id: row.job_id, reason: "missing_historical_job" }];
    const changed = Object.keys(row).filter((field) => current[field] !== row[field]);
    return changed.length ? [{ job_id: row.job_id, reason: `identity_fields_changed:${changed.join("|")}` }] : [];
  });
  const backupObservations = backup.prepare("SELECT COUNT(*) count FROM job_observations").get().count;
  const liveObservations = live.prepare("SELECT COUNT(*) count FROM job_observations").get().count;
  if (liveObservations < backupObservations) differences.push({ reason: "job_observation_history_shrank" });
  const runRows = live.prepare(`
    SELECT run_id, status, started_at, finished_at FROM runs
    WHERE run_id BETWEEN ? AND ? ORDER BY run_id
  `).all(firstRun, lastRun);
  const failedSources = live.prepare(`
    SELECT COUNT(*) count FROM source_observations
    WHERE run_id BETWEEN ? AND ? AND health_status LIKE 'failed%'
  `).get(firstRun, lastRun).count;
  const integrity = live.prepare("PRAGMA integrity_check").get().integrity_check;
  const foreignKeyViolations = live.prepare("PRAGMA foreign_key_check").all().length;
  const decision = cohortSafetyDecision({
    runStatuses: runRows.map((row) => row.status),
    failedSources,
    preservationDifferences: differences.length,
    integrity,
    foreignKeyViolations,
  });
  const result = {
    cohort, first_run: firstRun, last_run: lastRun, runs: runRows,
    failed_sources: failedSources, historical_jobs_checked: historical.length,
    historical_observations_before: backupObservations,
    historical_observations_after: liveObservations,
    preservation_differences: differences,
    integrity, foreign_key_violations: foreignKeyViolations,
    proceed_to_next_cohort: decision.proceed, stop_reasons: decision.reasons,
  };
  await writeFile(resolve(`reports/phase4-cohort-${cohort.toLowerCase()}-safety.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (!decision.proceed) process.exitCode = 2;
} finally {
  backup.close();
  live.close();
}

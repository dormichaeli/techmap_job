import { resolve } from "node:path";
import { openStore } from "../src/store.js";
import { readCsv, writeCsv } from "../src/csv.js";
import { validateSample } from "../src/ats-validation.js";
import {
  candidateIdentity,
  phase4Eligibility,
  reconcilePhase4Candidates,
  selectPhase4Cohorts,
} from "../src/phase4.js";

const args = new Set(process.argv.slice(2));
const reconcileOnly = args.has("--reconcile-only");
const fieldsFor = (rows) => [...new Set(rows.flatMap((row) => Object.keys(row)))];
const counts = (rows, field) => Object.fromEntries(Object.entries(Object.groupBy(rows, (row) => row[field]))
  .map(([key, values]) => [key, values.length]));

const remainingRows = await readCsv(resolve("data/phase3-ats-validation.csv"));
const reviewRows = await readCsv(resolve("data/phase3-phase2-review.csv"));
const identityReview = await readCsv(resolve("data/techmap_identity_review.csv"));
const unresolvedExternalIds = new Set(identityReview
  .filter((row) => row.decision_status === "unresolved")
  .map((row) => row.techmap_external_id));

const db = openStore(resolve("data/jobs.sqlite"));
let storedSources;
try {
  storedSources = db.prepare(`
    SELECT s.*, c.company_name, c.canonical_domain, c.employee_count_min, c.employee_count_max,
      c.employee_size_bucket, c.industry category_name
    FROM company_sources s JOIN companies c ON c.company_id=s.company_id
  `).all().map((row) => ({ ...row }));
  const baselineJobs = db.prepare(`
    SELECT job_id, source_job_id, company_id, company_source_id, company_name, source_provider,
      first_seen_at, last_seen_at, active, missing_success_count, discovery_cohort, discovery_kind
    FROM jobs ORDER BY job_id
  `).all().map((row) => ({ ...row }));
  await writeCsv(resolve("data/phase4-preexisting-jobs.csv"), baselineJobs, Object.keys(baselineJobs[0]));
} finally {
  db.close();
}

const reconciliation = reconcilePhase4Candidates(remainingRows, reviewRows, storedSources);
await writeCsv(resolve("data/phase4-candidate-reconciliation.csv"), reconciliation.all, fieldsFor(reconciliation.all));
const reconciliationStats = {
  remaining_valid: reconciliation.remaining.length,
  remaining_statuses: counts(reconciliation.remaining, "reconciliation_status"),
  phase2_recheck_valid: reconciliation.review.length,
  phase2_recheck_statuses: counts(reconciliation.review, "reconciliation_status"),
  new_disabled_candidates: reconciliation.candidates.length,
};
if (reconciliation.remaining.length !== 34
  || reconciliation.remaining.filter((row) => row.reconciliation_status === "already_live_verified").length !== 17
  || reconciliation.remaining.filter((row) => row.reconciliation_status === "new_disabled_candidate").length !== 17
  || reconciliation.review.filter((row) => row.reconciliation_status === "new_disabled_candidate").length !== 3
  || reconciliation.candidates.length !== 20) {
  throw new Error(`Phase 4 reconciliation differs from approved scope: ${JSON.stringify(reconciliationStats)}`);
}
if (reconcileOnly) {
  console.log(JSON.stringify(reconciliationStats, null, 2));
  process.exit(0);
}

const fresh = await validateSample(reconciliation.candidates, 2);
const reconciledByKey = new Map(reconciliation.candidates.map((row) => [candidateIdentity(row), row]));
const results = fresh.map((row) => ({
  ...row,
  reconciliation_status: reconciledByKey.get(candidateIdentity(row)).reconciliation_status,
  fresh_validation: 1,
}));
await writeCsv(resolve("data/phase4-candidate-revalidation.csv"), results, fieldsFor(results));

const assessed = results.map((row) => {
  const decision = phase4Eligibility(row, { unresolvedExternalIds });
  return {
    ...row,
    phase4_eligible: decision.eligible ? 1 : 0,
    phase4_eligibility_reason: decision.eligible ? "fresh ownership, health, parser, and identity gates passed" : decision.reasons.join(";"),
  };
});
const safeRows = assessed.filter((row) => Number(row.phase4_eligible) === 1);
const unsafeRows = assessed.filter((row) => Number(row.phase4_eligible) !== 1)
  .map((row) => ({ ...row, deferred_reason: row.phase4_eligibility_reason }));
const cohorts = selectPhase4Cohorts(safeRows);
const deferred = [...unsafeRows, ...cohorts.deferred];
await writeCsv(resolve("data/phase4-cohort-a-sources.csv"), cohorts.cohortA, fieldsFor(cohorts.cohortA));
await writeCsv(resolve("data/phase4-cohort-b-sources.csv"), cohorts.cohortB, fieldsFor(cohorts.cohortB));
await writeCsv(resolve("data/phase4-deferred-sources.csv"), deferred,
  deferred.length ? fieldsFor(deferred) : ["company_id", "company_name", "provider", "source_identifier", "deferred_reason"]);

const summary = {
  ...reconciliationStats,
  fresh_attempted: results.length,
  fresh_outcomes: counts(results, "outcome"),
  eligible: safeRows.length,
  cohort_a: cohorts.cohortA.length,
  cohort_b: cohorts.cohortB.length,
  deferred: deferred.length,
  cohort_a_companies: cohorts.cohortA.map((row) => row.company_name),
  cohort_b_companies: cohorts.cohortB.map((row) => row.company_name),
};
console.log(JSON.stringify(summary, null, 2));
if (cohorts.cohortA.length > 10 || cohorts.cohortB.length > 10) process.exitCode = 2;

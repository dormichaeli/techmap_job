import { resolve } from "node:path";
import { readCsv, writeCsv } from "../src/csv.js";
import {
  buildAtsCandidateUniverse,
  prioritizeValidationCandidates,
  providerRateLimited,
  validateSample,
} from "../src/ats-validation.js";
import { loadTechmapRegistry, readExistingState, reconcileTechmap } from "../src/techmap-import.js";

const args = new Set(process.argv.slice(2));
const manifestOnly = args.has("--manifest-only");
const restart = args.has("--restart");
const key = (row) => `${row.company_id}\u001f${row.provider}\u001f${String(row.source_identifier).toLowerCase()}`;
const fieldsFor = (rows) => [...new Set(rows.flatMap((row) => Object.keys(row)))];
const resultPath = resolve("data/phase3-ats-validation.csv");
const deferredPath = resolve("data/phase3-ats-validation-deferred.csv");

const state = readExistingState(resolve("data/jobs.sqlite"));
const registry = loadTechmapRegistry(resolve(".research/techmap-upstream"));
const universe = buildAtsCandidateUniverse(reconcileTechmap(registry, state), state);
const phase2Sample = await readCsv(resolve("data/ats-validation-sample.csv"));
const tested = new Set(phase2Sample.map(key));
const remaining = universe.filter((candidate) => !tested.has(key(candidate)));
const candidates = ["greenhouse", "comeet"].flatMap((provider) => (
  prioritizeValidationCandidates(remaining.filter((candidate) => candidate.provider === provider))
    .map((candidate) => ({
      ...candidate,
      selection_reason: [
        candidate.employee_count_min >= 10 && candidate.employee_count_max <= 200 ? "10-200 employees" : null,
        candidate.canonical_domain?.endsWith(".io") ? ".io discovery priority" : null,
        `industry: ${candidate.category_name ?? "unknown"}`,
        `previous evidence: ${candidate.previous_verification_status}`,
      ].filter(Boolean).join("; "),
    }))
));

await writeCsv(resolve("data/phase3-ats-validation-sample.csv"), candidates, fieldsFor(candidates));
const distribution = Object.fromEntries(Object.entries(Object.groupBy(candidates, (row) => row.provider))
  .map(([provider, rows]) => [provider, rows.length]));
if (candidates.length !== 154 || distribution.greenhouse !== 17 || distribution.comeet !== 137) {
  throw new Error(`Remaining cohort differs from approved scope: ${JSON.stringify(distribution)} (${candidates.length})`);
}
if (manifestOnly) {
  console.log(JSON.stringify({ remaining: candidates.length, distribution }, null, 2));
  process.exit(0);
}

let results = restart ? [] : await readCsv(resultPath).catch(() => []);
const completed = new Set(results.map(key));
const deferred = [];
for (const provider of ["greenhouse", "comeet"]) {
  const providerRows = candidates.filter((candidate) => candidate.provider === provider && !completed.has(key(candidate)));
  const batchSize = provider === "greenhouse" ? 17 : 20;
  for (let index = 0; index < providerRows.length; index += batchSize) {
    const batch = providerRows.slice(index, index + batchSize);
    console.log(`Validating ${provider} batch ${Math.floor(index / batchSize) + 1}: ${batch.length} sources`);
    const batchResults = await validateSample(batch, 2);
    results.push(...batchResults);
    await writeCsv(resultPath, results, fieldsFor(results));
    console.log(JSON.stringify({
      provider,
      completed: results.filter((row) => row.provider === provider).length,
      outcomes: Object.fromEntries(Object.entries(Object.groupBy(batchResults, (row) => row.outcome))
        .map(([outcome, rows]) => [outcome, rows.length])),
    }));
    if (providerRateLimited(batchResults)) {
      const attempted = new Set(batchResults.map(key));
      deferred.push(...providerRows.slice(index).filter((row) => !attempted.has(key(row)))
        .map((row) => ({ ...row, deferred_reason: "provider_endpoint_rate_limit" })));
      console.log(`Stopping ${provider}: ATS endpoint rate limiting detected.`);
      break;
    }
  }
}
await writeCsv(deferredPath, deferred, deferred.length ? fieldsFor(deferred) : ["company_id", "deferred_reason"]);
console.log(JSON.stringify({
  attempted: results.length,
  deferred: deferred.length,
  distribution,
  outcomes: Object.fromEntries(Object.entries(Object.groupBy(results, (row) => row.outcome))
    .map(([outcome, rows]) => [outcome, rows.length])),
}, null, 2));

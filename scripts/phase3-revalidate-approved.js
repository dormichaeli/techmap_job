import { resolve } from "node:path";
import { writeCsv } from "../src/csv.js";
import { buildAtsCandidateUniverse, validateSample } from "../src/ats-validation.js";
import { loadTechmapRegistry, readExistingState, reconcileTechmap } from "../src/techmap-import.js";

const approvedNames = new Set(["Dalet", "Parallel Wireless", "AugMedics"]);
const registry = loadTechmapRegistry(resolve(".research/techmap-upstream"));
const state = readExistingState(resolve("data/jobs.sqlite"));
const universe = buildAtsCandidateUniverse(reconcileTechmap(registry, state), state);
const candidates = universe.filter((row) => approvedNames.has(row.company_name));
if (candidates.length !== approvedNames.size) {
  throw new Error(`Expected ${approvedNames.size} approved candidates, found ${candidates.length}`);
}

const results = await validateSample(candidates, 1);
await writeCsv(resolve("data/phase3-approved-revalidation.csv"), results, Object.keys(results[0]));

const unsafe = results.filter((row) => !["valid_with_jobs", "valid_empty"].includes(row.outcome));
console.log(JSON.stringify({
  attempted: results.length,
  results: results.map((row) => ({
    company: row.company_name,
    provider: row.provider,
    http_status: row.endpoint_http_status,
    ownership: row.ownership_status,
    parser: row.parser_status,
    jobs: row.job_count,
    outcome: row.outcome,
    evidence_url: row.ownership_evidence_url,
  })),
  safe_to_activate: unsafe.length === 0,
}, null, 2));
if (unsafe.length) process.exitCode = 2;

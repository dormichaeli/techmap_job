import { resolve } from "node:path";
import { readCsv, writeCsv } from "../src/csv.js";
import { buildAtsCandidateUniverse, validateSample } from "../src/ats-validation.js";
import { loadTechmapRegistry, readExistingState, reconcileTechmap } from "../src/techmap-import.js";

const key = (row) => `${row.company_id}\u001f${row.provider}\u001f${String(row.source_identifier).toLowerCase()}`;
const phase2 = await readCsv(resolve("data/ats-validation-phase2.csv"));
const reviewRows = phase2.filter((row) => [
  "needs_manual_review", "stale_source", "source_migrated", "parser_failure",
].includes(row.outcome));
const originals = new Map(reviewRows.map((row) => [key(row), row.outcome]));
const state = readExistingState(resolve("data/jobs.sqlite"));
const registry = loadTechmapRegistry(resolve(".research/techmap-upstream"));
const universe = buildAtsCandidateUniverse(reconcileTechmap(registry, state), state);
const candidates = universe.filter((row) => originals.has(key(row)))
  .map((row) => ({ ...row, phase2_outcome: originals.get(key(row)) }));
if (candidates.length !== reviewRows.length) {
  throw new Error(`Expected ${reviewRows.length} Phase 2 review candidates, found ${candidates.length}`);
}
const results = await validateSample(candidates, 2);
await writeCsv(resolve("data/phase3-phase2-review.csv"), results, [...new Set(results.flatMap((row) => Object.keys(row)))]);
console.log(JSON.stringify({
  attempted: results.length,
  transitions: Object.fromEntries(Object.entries(Object.groupBy(results, (row) => `${row.phase2_outcome} -> ${row.outcome}`))
    .map(([transition, rows]) => [transition, rows.length])),
}, null, 2));

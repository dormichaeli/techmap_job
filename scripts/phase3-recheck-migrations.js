import { resolve } from "node:path";
import { readCsv, writeCsv } from "../src/csv.js";
import { buildAtsCandidateUniverse, validateSample } from "../src/ats-validation.js";
import { loadTechmapRegistry, readExistingState, reconcileTechmap } from "../src/techmap-import.js";

const key = (row) => `${row.company_id}\u001f${row.provider}\u001f${String(row.source_identifier).toLowerCase()}`;
const fieldsFor = (rows) => [...new Set(rows.flatMap((row) => Object.keys(row)))];
const phase2Path = resolve("data/phase3-phase2-review.csv");
const remainingPath = resolve("data/phase3-ats-validation.csv");
const [phase2, remaining] = await Promise.all([readCsv(phase2Path), readCsv(remainingPath)]);
const prior = [...phase2, ...remaining].filter((row) => row.outcome === "source_migrated");
const keys = new Set(prior.map(key));
const originals = new Map(prior.map((row) => [key(row), row]));
const state = readExistingState(resolve("data/jobs.sqlite"));
const registry = loadTechmapRegistry(resolve(".research/techmap-upstream"));
const universe = buildAtsCandidateUniverse(reconcileTechmap(registry, state), state);
const candidates = universe.filter((row) => keys.has(key(row))).map((row) => ({
  ...row,
  phase2_outcome: originals.get(key(row)).phase2_outcome ?? "",
}));
const rechecked = await validateSample(candidates, 2);
const replacements = new Map(rechecked.map((row) => [key(row), row]));
const updatedPhase2 = phase2.map((row) => replacements.get(key(row)) ?? row);
const updatedRemaining = remaining.map((row) => replacements.get(key(row)) ?? row);
await Promise.all([
  writeCsv(phase2Path, updatedPhase2, fieldsFor(updatedPhase2)),
  writeCsv(remainingPath, updatedRemaining, fieldsFor(updatedRemaining)),
]);
console.log(JSON.stringify({
  rechecked: rechecked.length,
  outcomes: Object.fromEntries(Object.entries(Object.groupBy(rechecked, (row) => row.outcome))
    .map(([outcome, rows]) => [outcome, rows.length])),
}, null, 2));

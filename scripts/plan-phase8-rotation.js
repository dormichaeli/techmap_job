#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FIRST_CLOUD_MAX_SOURCES,
  loadRotatingCollectionCandidates,
  planRotatingCollectionCohort,
} from "../src/collection-cohort.js";

function parseOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid option: ${key}`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function positiveInteger(value, name, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function sizeClass(row) {
  if (row.employee_count_min === null || row.employee_count_min === undefined
    || row.employee_count_max === null || row.employee_count_max === undefined) return "unknown";
  if (Number(row.employee_count_min) >= 10 && Number(row.employee_count_max) <= 200) return "verified_10_200";
  return "other_known";
}

function increment(summary, key, field) {
  if (!summary[key]) summary[key] = { eligible: 0, unique_selected: 0, total_selections: 0 };
  summary[key][field] += 1;
}

function simulate(initialCandidates, { cycles, limit, selectionTime, intervalHours }) {
  const candidates = initialCandidates.map((row) => ({ ...row }));
  const firstSelectionMs = Date.parse(selectionTime);
  const uniqueSelected = new Set();
  const runs = [];

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const selectedAt = new Date(firstSelectionMs + cycle * intervalHours * 60 * 60 * 1000).toISOString();
    const plan = planRotatingCollectionCohort(candidates, { selectionTime: selectedAt, limit });
    const ids = plan.selected.map((row) => row.company_source_id);
    assert.equal(new Set(ids).size, ids.length, `Cycle ${cycle + 1} contains duplicate sources`);
    runs.push({
      cycle: cycle + 1,
      selection_time: selectedAt,
      cohort_fingerprint: plan.cohort_fingerprint,
      providers: plan.selected.map((row) => row.source_provider),
      source_ids: ids,
      never_observed: plan.selected.filter((row) => row.selection_reason === "never_observed").length,
      size_classes: Object.fromEntries(["verified_10_200", "unknown", "other_known"]
        .map((name) => [name, plan.selected.filter((row) => row.size_priority === name).length])),
    });
    for (const selected of plan.selected) {
      uniqueSelected.add(selected.company_source_id);
      const candidate = candidates.find((row) => row.company_source_id === selected.company_source_id);
      candidate.completed_observation_count += 1;
      candidate.last_completed_observed_at = selectedAt;
    }
  }
  return { candidates, runs, uniqueSelected };
}

const options = parseOptions(process.argv.slice(2));
if (!options.db) throw new Error("--db is required");
if (!options["selection-time"]) throw new Error("--selection-time is required");
const selectionTime = new Date(options["selection-time"]).toISOString();
const cycles = positiveInteger(options.cycles, "--cycles", 14);
const limit = positiveInteger(options.limit, "--limit", FIRST_CLOUD_MAX_SOURCES);
const intervalHours = positiveInteger(options["interval-hours"], "--interval-hours", 24);
if (limit > FIRST_CLOUD_MAX_SOURCES) throw new Error(`--limit cannot exceed ${FIRST_CLOUD_MAX_SOURCES}`);

const databasePath = resolve(options.db);
const db = new DatabaseSync(databasePath, { readOnly: true });
let initialCandidates;
try {
  initialCandidates = loadRotatingCollectionCandidates(db, { selectionTime });
} finally {
  db.close();
}

const first = simulate(initialCandidates, { cycles, limit, selectionTime, intervalHours });
const replay = simulate(initialCandidates, { cycles, limit, selectionTime, intervalHours });
assert.deepEqual(first.runs, replay.runs, "Deterministic replay produced different cohorts");

const providerCoverage = {};
const sizeCoverage = {};
const selectedCounts = new Map();
for (const row of initialCandidates) {
  increment(providerCoverage, row.source_provider, "eligible");
  increment(sizeCoverage, sizeClass(row), "eligible");
}
for (const run of first.runs) {
  for (const sourceId of run.source_ids) selectedCounts.set(sourceId, (selectedCounts.get(sourceId) ?? 0) + 1);
}
for (const row of initialCandidates) {
  const count = selectedCounts.get(row.company_source_id) ?? 0;
  if (count > 0) {
    increment(providerCoverage, row.source_provider, "unique_selected");
    increment(sizeCoverage, sizeClass(row), "unique_selected");
  }
  providerCoverage[row.source_provider].total_selections += count;
  sizeCoverage[sizeClass(row)].total_selections += count;
}

const allCovered = first.uniqueSelected.size === initialCandidates.length;
const providerFair = Object.values(providerCoverage).every((row) => row.unique_selected === row.eligible);
const unknownSizeIncluded = (sizeCoverage.unknown?.unique_selected ?? 0) > 0;
const result = {
  verdict: allCovered && providerFair && unknownSizeIncluded ? "passed" : "failed",
  database: databasePath,
  read_only: true,
  selection_time: selectionTime,
  interval_hours: intervalHours,
  cycles,
  sources_per_cycle: limit,
  available_slots: cycles * limit,
  eligible_sources: initialCandidates.length,
  unique_sources_selected: first.uniqueSelected.size,
  repeated_selections: cycles * limit - first.uniqueSelected.size,
  all_sources_covered: allCovered,
  provider_fairness_verified: providerFair,
  unknown_size_included: unknownSizeIncluded,
  deterministic_replay: true,
  provider_coverage: providerCoverage,
  company_size_coverage: sizeCoverage,
  runs: first.runs,
};
console.log(JSON.stringify(result, null, 2));
if (result.verdict !== "passed") process.exitCode = 1;

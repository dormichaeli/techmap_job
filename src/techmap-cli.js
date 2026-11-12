import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { readCsv, writeCsv } from "./csv.js";
import {
  applyTechmapImport,
  decisionRows,
  identityReviewRows,
  loadTechmapRegistry,
  readExistingState,
  reconcileTechmap,
} from "./techmap-import.js";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const dryRun = args.has("--dry-run");
if (apply === dryRun) throw new Error("Specify exactly one of --dry-run or --apply");

const dbPath = resolve("data/jobs.sqlite");
const sourceRoot = resolve(".research/techmap-upstream");
const reviewPath = resolve("data/techmap_identity_review.csv");
const generatedAt = new Date().toISOString();
const registry = loadTechmapRegistry(sourceRoot);
const state = readExistingState(dbPath);
const result = reconcileTechmap(registry, state);
const previousReview = existsSync(reviewPath) ? await readCsv(reviewPath) : [];

await mkdir(resolve("reports"), { recursive: true });
await writeFile(resolve("reports/techmap-phase1-dry-run.json"), `${JSON.stringify({
  generated_at: generatedAt,
  database_open_mode: "read_only",
  source_root: sourceRoot,
  safe_subset_gate: result.summary.safe_subset_dependency_violations === 0 ? "passed" : "failed",
  ...result.summary,
  unresolved_job_names: result.unresolvedJobNames,
}, null, 2)}\n`, "utf8");
await writeCsv(resolve("data/techmap_reconciliation.csv"), decisionRows(result), [
  "external_id", "source_company_name", "canonical_domain", "conflict_group_id", "action",
  "company_id", "match_basis", "is_primary_record", "is_active", "size", "category",
  "careers_url", "ats_candidates",
]);
await writeCsv(resolve("data/techmap_conflicts.csv"), result.conflicts, [
  "severity", "scope", "conflict_group_id", "conflict_type", "canonical_domain",
  "external_ids", "source_names", "existing_company_ids", "details",
]);
await writeCsv(reviewPath, identityReviewRows(result, previousReview), [
  "techmap_external_id", "company_name", "domain", "conflict_group_id",
  "conflicting_company_ids", "conflict_reason", "proposed_decision", "decision_status",
  "evidence_url", "review_notes",
]);

if (result.summary.safe_subset_dependency_violations) {
  console.error("Safe-subset gate failed; the database was not modified");
  process.exitCode = 3;
} else if (dryRun) {
  console.log(JSON.stringify({ mode: "dry_run", safe_subset_gate: "passed", ...result.summary }, null, 2));
} else {
  const importResult = applyTechmapImport(dbPath, result, { observedAt: generatedAt });
  const payload = {
    generated_at: generatedAt,
    mode: "atomic_safe_subset_apply",
    reconciliation: result.summary,
    import: importResult,
  };
  await writeFile(resolve("reports/techmap-phase1-import-result.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
}

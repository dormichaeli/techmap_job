import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import {
  applyTechmapImport,
  loadTechmapRegistry,
  readExistingState,
  reconcileTechmap,
} from "../src/techmap-import.js";

function audit(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const jobs = db.prepare("SELECT job_id, first_seen_at FROM jobs ORDER BY job_id").all();
    const hasV4 = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_sources'").get());
    return {
      integrity: db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check),
      foreign_key_violations: db.prepare("PRAGMA foreign_key_check").all(),
      schema_version: db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,
      companies: db.prepare("SELECT COUNT(*) count FROM companies").get().count,
      jobs: jobs.length,
      job_ids_sha256: createHash("sha256").update(jobs.map((row) => row.job_id).join("\n")).digest("hex"),
      first_seen_sha256: createHash("sha256")
        .update(jobs.map((row) => `${row.job_id}\u001f${row.first_seen_at}`).join("\n")).digest("hex"),
      job_observations: db.prepare("SELECT COUNT(*) count FROM job_observations").get().count,
      source_observations: db.prepare("SELECT COUNT(*) count FROM source_observations").get().count,
      runs: db.prepare("SELECT COUNT(*) count FROM runs").get().count,
      company_external_ids: hasV4 ? db.prepare("SELECT COUNT(*) count FROM company_external_ids").get().count : 0,
      company_aliases: hasV4 ? db.prepare("SELECT COUNT(*) count FROM company_aliases").get().count : 0,
      company_sources: hasV4 ? db.prepare("SELECT COUNT(*) count FROM company_sources").get().count : 0,
    };
  } finally {
    db.close();
  }
}

function assertInvariant(condition, message) {
  if (!condition) throw new Error(`Copy-validation invariant failed: ${message}`);
}

const sourcePath = resolve(process.argv[2] ?? "data/jobs.sqlite");
const sourceRoot = resolve(process.argv[3] ?? ".research/techmap-upstream");
const directory = mkdtempSync(join(tmpdir(), "techmap-copy-validation-"));
const copyPath = join(directory, "validation.sqlite");
const generatedAt = new Date().toISOString();

try {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  await backup(source, copyPath);
  source.close();

  const before = audit(copyPath);
  const registry = loadTechmapRegistry(sourceRoot);
  const firstReconciliation = reconcileTechmap(registry, readExistingState(copyPath));
  const firstImport = applyTechmapImport(copyPath, firstReconciliation, { observedAt: generatedAt });
  const afterFirst = audit(copyPath);
  const secondReconciliation = reconcileTechmap(registry, readExistingState(copyPath));
  const secondImport = applyTechmapImport(copyPath, secondReconciliation, { observedAt: generatedAt });
  const afterSecond = audit(copyPath);

  for (const metric of ["jobs", "job_ids_sha256", "first_seen_sha256", "job_observations", "source_observations", "runs"]) {
    assertInvariant(before[metric] === afterFirst[metric], `${metric} changed on first import`);
    assertInvariant(before[metric] === afterSecond[metric], `${metric} changed on repeated import`);
  }
  assertInvariant(afterFirst.schema_version === 4 && afterSecond.schema_version === 4, "schema version is not 4");
  assertInvariant(afterFirst.integrity.length === 1 && afterFirst.integrity[0] === "ok", "integrity check failed");
  assertInvariant(afterSecond.foreign_key_violations.length === 0, "foreign-key check failed");
  assertInvariant(firstImport.companies_inserted === firstReconciliation.summary.proposed_new_companies,
    "first import company count differs from reconciliation");
  assertInvariant(secondImport.companies_inserted === 0, "repeated import inserted companies");
  assertInvariant(secondImport.external_aliases_inserted === 0, "repeated import inserted external aliases");
  assertInvariant(secondImport.sources_inserted === 0, "repeated import inserted sources");

  const payload = {
    generated_at: generatedAt,
    source_database: sourcePath,
    copy_location: "temporary disposable SQLite backup",
    result: "passed",
    before,
    first_reconciliation: firstReconciliation.summary,
    first_import: firstImport,
    after_first: afterFirst,
    second_reconciliation: secondReconciliation.summary,
    second_import: secondImport,
    after_second: afterSecond,
  };
  await writeFile(resolve("reports/techmap-phase1-copy-validation.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(payload, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

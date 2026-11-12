import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CHECKPOINT_DATABASE_FILE,
  CHECKPOINT_MANIFEST_FILE,
  CheckpointError,
  canonicalJson,
  createCheckpoint,
  restoreCheckpoint,
  sha256File,
  validateCheckpoint,
} from "../src/checkpoint.js";
import {
  LATEST_POINTER_FILE,
  publishCheckpointLocally,
  readLatestPointer,
  resolveTrustedCheckpoint,
} from "../src/checkpoint-publication.js";
import {
  applySuccessfulObservation,
  beginRun,
  finishRun,
  importCompanies,
  openStore,
  recordSourceObservation,
  recoverInterruptedRuns,
} from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

const CREATED_AT = "2026-11-12T09:00:00.000Z";

function temporaryRoot() {
  return mkdtempSync(join(tmpdir(), "phase5-checkpoint-"));
}

function errorCode(code) {
  return (error) => error instanceof CheckpointError && error.code === code;
}

function fixtureDatabase(root, { completedRun = true, withJob = true } = {}) {
  const path = join(root, "fixture.sqlite");
  const db = openStore(path);
  importCompanies(db, [{
    company_id: "company-one",
    company_name: "Company One",
    canonical_domain: "company.test",
    company_discovered_at: "2026-11-12T00:00:00.000Z",
    company_source_status: "verified",
  }], "2026-11-12T00:00:00.000Z");
  db.prepare(`
    INSERT INTO company_sources (
      source_id, company_id, source_kind, provider, source_identifier, source_url,
      evidence_source, evidence_status, is_enabled, imported_at
    ) VALUES (
      'source-one', 'company-one', 'ats', 'greenhouse', 'company-one',
      'https://example.test/jobs', 'fixture', 'live_verified', 1, '2026-11-12T00:00:00.000Z'
    )
  `).run();
  const runId = beginRun(db, "2026-11-12T00:01:00.000Z");
  if (withJob) {
    const company = {
      company_id: "company-one", company_name: "Company One", company_source_id: "source-one",
      source_provider: "greenhouse", source_url: "https://example.test/jobs",
    };
    const raw = {
      source_job_id: "job-one", company_name: "Company One", job_title: "Analyst",
      source_provider: "greenhouse", source_url: company.source_url,
    };
    applySuccessfulObservation(db, runId, company,
      [normalizeJob(raw, "2026-11-12T00:01:00.000Z", { company, discoveryCohort: "fixture", discoveryKind: "baseline" })],
      "2026-11-12T00:01:00.000Z");
  }
  if (completedRun) finishRun(db, runId, "completed", "2026-11-12T00:02:00.000Z");
  db.close();
  return path;
}

async function makeCheckpoint(root, id = "checkpoint-one", databasePath = null, repositoryName = "created") {
  return createCheckpoint({
    sourcePath: databasePath ?? fixtureDatabase(root),
    repositoryPath: join(root, repositoryName),
    checkpointId: id,
    createdAt: CREATED_AT,
  });
}

function cloneCheckpoint(sourcePath, targetParent, id) {
  const target = join(targetParent, id);
  cpSync(sourcePath, target, { recursive: true, errorOnExist: true });
  const manifestPath = join(target, CHECKPOINT_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.checkpoint_id = id;
  writeFileSync(manifestPath, canonicalJson(manifest));
  return target;
}

test("checkpoint creation is checksummed, deterministic, restorable, and identity preserving", async () => {
  const root = temporaryRoot();
  try {
    const databasePath = fixtureDatabase(root);
    const checkpoint = await makeCheckpoint(root, "checkpoint-one", databasePath);
    const manifestText = readFileSync(checkpoint.manifest_path, "utf8");
    assert.equal(manifestText, canonicalJson(JSON.parse(manifestText)));
    assert.equal(checkpoint.manifest.database.sha256, sha256File(checkpoint.database_path));
    assert.equal(checkpoint.manifest.database.integrity_check, "ok");
    assert.equal(checkpoint.manifest.database.foreign_key_violations, 0);
    assert.equal(checkpoint.manifest.state.schema_version, 5);
    assert.equal(checkpoint.manifest.state.counts.jobs, 1);
    assert.equal(checkpoint.manifest.publication.eligible, true);
    const restoredPath = join(root, "isolated", "restored.sqlite");
    const restored = restoreCheckpoint({
      checkpointPath: checkpoint.checkpoint_directory,
      destinationPath: restoredPath,
      forbiddenPaths: [databasePath],
    });
    assert.equal(restored.inspection.fingerprints.job_identity_sha256,
      checkpoint.manifest.state.fingerprints.job_identity_sha256);
    assert.equal(restored.inspection.fingerprints.job_first_seen_sha256,
      checkpoint.manifest.state.fingerprints.job_first_seen_sha256);
    assert.throws(() => restoreCheckpoint({ checkpointPath: checkpoint.checkpoint_directory, destinationPath: restoredPath }), errorCode("RESTORE_DESTINATION_EXISTS"));
    assert.throws(() => restoreCheckpoint({ checkpointPath: checkpoint.checkpoint_directory, destinationPath: databasePath, forbiddenPaths: [databasePath] }), errorCode("RESTORE_DESTINATION_FORBIDDEN"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("immutable checkpoints reject overwrite and interrupted creation leaves no final checkpoint", async () => {
  const root = temporaryRoot();
  try {
    const databasePath = fixtureDatabase(root);
    const checkpoint = await makeCheckpoint(root, "immutable", databasePath);
    await assert.rejects(() => makeCheckpoint(root, "immutable", databasePath), errorCode("IMMUTABLE_CHECKPOINT_EXISTS"));
    await assert.rejects(() => createCheckpoint({
      sourcePath: databasePath, repositoryPath: join(root, "created"), checkpointId: "interrupted", createdAt: CREATED_AT,
      onStage: (stage) => { if (stage === "manifest_written") throw new Error("injected interruption"); },
    }), errorCode("CHECKPOINT_CREATION_FAILED"));
    assert.equal(existsSync(join(root, "created", "checkpoints", "interrupted")), false);
    assert.equal(validateCheckpoint(checkpoint.checkpoint_directory).manifest.checkpoint_id, "immutable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent checkpoint creation is serialized by an exclusive repository lock", async () => {
  const root = temporaryRoot();
  try {
    const databasePath = fixtureDatabase(root);
    let releaseFirst;
    let announceLock;
    const firstMayContinue = new Promise((resolve) => { releaseFirst = resolve; });
    const lockAcquired = new Promise((resolve) => { announceLock = resolve; });
    const first = createCheckpoint({
      sourcePath: databasePath, repositoryPath: join(root, "created"), checkpointId: "first", createdAt: CREATED_AT,
      onStage: async (stage) => { if (stage === "lock_acquired") { announceLock(); await firstMayContinue; } },
    });
    await lockAcquired;
    await assert.rejects(() => makeCheckpoint(root, "second", databasePath), errorCode("CONCURRENT_OPERATION"));
    releaseFirst();
    await first;
    assert.equal(validateCheckpoint(join(root, "created", "checkpoints", "first")).manifest.checkpoint_id, "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore validation rejects missing, malformed, version-incompatible, truncated, modified, and invalid-checksum checkpoints", async (t) => {
  const root = temporaryRoot();
  try {
    const checkpoint = await makeCheckpoint(root);
    const variants = join(root, "variants");
    const missing = cloneCheckpoint(checkpoint.checkpoint_directory, variants, "missing-manifest");
    rmSync(join(missing, CHECKPOINT_MANIFEST_FILE));
    assert.throws(() => validateCheckpoint(missing), errorCode("MANIFEST_MISSING"));

    const malformed = cloneCheckpoint(checkpoint.checkpoint_directory, variants, "malformed-manifest");
    writeFileSync(join(malformed, CHECKPOINT_MANIFEST_FILE), "{broken");
    assert.throws(() => validateCheckpoint(malformed), errorCode("MANIFEST_MALFORMED"));

    const unsupported = cloneCheckpoint(checkpoint.checkpoint_directory, variants, "unsupported-format");
    const unsupportedManifestPath = join(unsupported, CHECKPOINT_MANIFEST_FILE);
    const unsupportedManifest = JSON.parse(readFileSync(unsupportedManifestPath, "utf8"));
    unsupportedManifest.checkpoint_format_version = 99;
    writeFileSync(unsupportedManifestPath, canonicalJson(unsupportedManifest));
    assert.throws(() => validateCheckpoint(unsupported), errorCode("CHECKPOINT_VERSION_UNSUPPORTED"));

    const truncated = cloneCheckpoint(checkpoint.checkpoint_directory, variants, "truncated");
    truncateSync(join(truncated, CHECKPOINT_DATABASE_FILE), 128);
    assert.throws(() => validateCheckpoint(truncated), errorCode("DATABASE_SIZE_MISMATCH"));

    const modified = cloneCheckpoint(checkpoint.checkpoint_directory, variants, "modified");
    const modifiedDb = join(modified, CHECKPOINT_DATABASE_FILE);
    const handle = openSync(modifiedDb, "r+");
    writeSync(handle, Buffer.from([0xff]), 0, 1, 200);
    closeSync(handle);
    assert.throws(() => validateCheckpoint(modified), errorCode("CHECKSUM_MISMATCH"));

    const invalidChecksum = cloneCheckpoint(checkpoint.checkpoint_directory, variants, "invalid-checksum");
    const invalidManifestPath = join(invalidChecksum, CHECKPOINT_MANIFEST_FILE);
    const invalidManifest = JSON.parse(readFileSync(invalidManifestPath, "utf8"));
    invalidManifest.database.sha256 = "0".repeat(64);
    writeFileSync(invalidManifestPath, canonicalJson(invalidManifest));
    assert.throws(() => validateCheckpoint(invalidChecksum), errorCode("CHECKSUM_MISMATCH"));
    await t.test("original trusted checkpoint remains valid", () => {
      assert.equal(validateCheckpoint(checkpoint.checkpoint_directory).manifest.checkpoint_id, "checkpoint-one");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database compatibility gates reject unsupported schema, missing tables, foreign-key violations, and integrity corruption", async () => {
  const root = temporaryRoot();
  try {
    const unsupportedDb = fixtureDatabase(join(root, "unsupported"));
    let db = new (await import("node:sqlite")).DatabaseSync(unsupportedDb);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (99, '2026-11-12T00:00:00Z')").run();
    db.close();
    await assert.rejects(() => makeCheckpoint(root, "unsupported-schema", unsupportedDb, "unsupported-created"), errorCode("SCHEMA_VERSION_UNSUPPORTED"));

    const missingTableDb = fixtureDatabase(join(root, "missing"));
    db = new (await import("node:sqlite")).DatabaseSync(missingTableDb);
    db.exec("DROP TABLE company_aliases");
    db.close();
    await assert.rejects(() => makeCheckpoint(root, "missing-table", missingTableDb, "missing-created"), errorCode("EXPECTED_TABLE_MISSING"));

    const foreignKeyDb = fixtureDatabase(join(root, "foreign"));
    db = new (await import("node:sqlite")).DatabaseSync(foreignKeyDb);
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare(`INSERT INTO company_sources
      (source_id, company_id, source_kind, evidence_source, evidence_status, is_enabled, imported_at)
      VALUES ('orphan-source', 'missing-company', 'ats', 'test', 'imported_unverified', 0, '2026-11-12T00:00:00Z')`).run();
    db.close();
    await assert.rejects(() => makeCheckpoint(root, "foreign-key", foreignKeyDb, "foreign-created"), errorCode("FOREIGN_KEY_VIOLATION"));

    const valid = await makeCheckpoint(root, "integrity-source");
    const corrupted = cloneCheckpoint(valid.checkpoint_directory, join(root, "corrupt"), "integrity-corrupt");
    const corruptedDb = join(corrupted, CHECKPOINT_DATABASE_FILE);
    const corruptHandle = openSync(corruptedDb, "r+");
    writeSync(corruptHandle, Buffer.alloc(256, 0xff), 0, 256, 4096);
    closeSync(corruptHandle);
    const corruptManifestPath = join(corrupted, CHECKPOINT_MANIFEST_FILE);
    const corruptManifest = JSON.parse(readFileSync(corruptManifestPath, "utf8"));
    corruptManifest.database.sha256 = sha256File(corruptedDb);
    writeFileSync(corruptManifestPath, canonicalJson(corruptManifest));
    assert.throws(() => validateCheckpoint(corrupted), (error) => ["SQLITE_INTEGRITY_FAILED", "DATABASE_VALIDATION_FAILED"].includes(error.code));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two-phase publication preserves the previous pointer across interruption and supports idempotent retry", async () => {
  const root = temporaryRoot();
  try {
    const databasePath = fixtureDatabase(root);
    const first = await makeCheckpoint(root, "checkpoint-001", databasePath);
    const publicationRepository = join(root, "publication");
    await publishCheckpointLocally({ checkpointPath: first.checkpoint_directory, publicationRepository, promotedAt: "2026-11-12T09:01:00Z", expectedLatestCheckpointId: null });
    assert.equal(readLatestPointer(publicationRepository).checkpoint_id, "checkpoint-001");

    const db = openStore(databasePath);
    const run = beginRun(db, "2026-11-12T09:02:00Z");
    finishRun(db, run, "completed", "2026-11-12T09:03:00Z");
    db.close();
    const second = await makeCheckpoint(root, "checkpoint-002", databasePath);
    await assert.rejects(() => publishCheckpointLocally({
      checkpointPath: second.checkpoint_directory, publicationRepository,
      promotedAt: "2026-11-12T09:04:00Z", expectedLatestCheckpointId: "checkpoint-001",
      onStage: (stage) => { if (stage === "before_latest_pointer_update") throw new Error("injected publish interruption"); },
    }), errorCode("PUBLICATION_FAILED"));
    assert.equal(readLatestPointer(publicationRepository).checkpoint_id, "checkpoint-001");
    assert.equal(validateCheckpoint(first.checkpoint_directory).manifest.checkpoint_id, "checkpoint-001");
    await publishCheckpointLocally({ checkpointPath: second.checkpoint_directory, publicationRepository, promotedAt: "2026-11-12T09:05:00Z", expectedLatestCheckpointId: "checkpoint-001" });
    assert.equal(resolveTrustedCheckpoint(publicationRepository).manifest.checkpoint_id, "checkpoint-002");
    await assert.rejects(() => publishCheckpointLocally({ checkpointPath: first.checkpoint_directory, publicationRepository, expectedLatestCheckpointId: "wrong" }), errorCode("LATEST_POINTER_CONFLICT"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing, malformed, and missing-target pointers recover by scanning valid immutable checkpoints", async () => {
  const root = temporaryRoot();
  try {
    const checkpoint = await makeCheckpoint(root, "checkpoint-001");
    const publicationRepository = join(root, "publication");
    await publishCheckpointLocally({ checkpointPath: checkpoint.checkpoint_directory, publicationRepository, promotedAt: "2026-11-12T09:01:00Z", expectedLatestCheckpointId: null });
    const pointerPath = join(publicationRepository, LATEST_POINTER_FILE);
    rmSync(pointerPath);
    assert.equal(resolveTrustedCheckpoint(publicationRepository).resolution, "published_scan_fallback");
    writeFileSync(pointerPath, "{broken");
    assert.equal(resolveTrustedCheckpoint(publicationRepository).manifest.checkpoint_id, "checkpoint-001");
    const manifestHash = createHash("sha256").update(readFileSync(checkpoint.manifest_path)).digest("hex");
    writeFileSync(pointerPath, canonicalJson({
      pointer_format: "techmap-job-latest-checkpoint", pointer_format_version: 1,
      checkpoint_id: "missing-checkpoint", manifest_sha256: manifestHash,
      database_sha256: checkpoint.manifest.database.sha256, promoted_at: "2026-11-12T09:02:00Z",
      previous_checkpoint_id: "checkpoint-001",
    }));
    const recovered = resolveTrustedCheckpoint(publicationRepository);
    assert.equal(recovered.manifest.checkpoint_id, "checkpoint-001");
    assert.match(recovered.recovery_reason, /LATEST_CHECKPOINT_MISSING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt latest publication falls back to the previous valid checkpoint", async () => {
  const root = temporaryRoot();
  try {
    const databasePath = fixtureDatabase(root);
    const first = await makeCheckpoint(root, "checkpoint-001", databasePath);
    const publicationRepository = join(root, "publication");
    await publishCheckpointLocally({ checkpointPath: first.checkpoint_directory, publicationRepository, promotedAt: "2026-11-12T09:01:00Z", expectedLatestCheckpointId: null });
    const db = openStore(databasePath);
    const run = beginRun(db, "2026-11-12T09:02:00Z");
    finishRun(db, run, "completed", "2026-11-12T09:03:00Z");
    db.close();
    const second = await makeCheckpoint(root, "checkpoint-002", databasePath);
    await publishCheckpointLocally({ checkpointPath: second.checkpoint_directory, publicationRepository, promotedAt: "2026-11-12T09:04:00Z", expectedLatestCheckpointId: "checkpoint-001" });
    truncateSync(join(publicationRepository, "published", "checkpoint-002", CHECKPOINT_DATABASE_FILE), 256);
    const recovered = resolveTrustedCheckpoint(publicationRepository);
    assert.equal(recovered.manifest.checkpoint_id, "checkpoint-001");
    assert.equal(recovered.resolution, "published_scan_fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("published checkpoint IDs are immutable and failed verification never advances latest", async () => {
  const root = temporaryRoot();
  try {
    const firstDb = fixtureDatabase(join(root, "first-db"));
    const first = await makeCheckpoint(root, "same-id", firstDb, "first-created");
    const publicationRepository = join(root, "publication");
    await publishCheckpointLocally({ checkpointPath: first.checkpoint_directory, publicationRepository, promotedAt: "2026-11-12T09:01:00Z", expectedLatestCheckpointId: null });
    const secondDb = fixtureDatabase(join(root, "second-db"));
    const db = openStore(secondDb);
    const run = beginRun(db, "2026-11-12T09:02:00Z");
    finishRun(db, run, "completed", "2026-11-12T09:03:00Z");
    db.close();
    const different = await makeCheckpoint(root, "same-id", secondDb, "second-created");
    await assert.rejects(() => publishCheckpointLocally({ checkpointPath: different.checkpoint_directory, publicationRepository }), errorCode("PUBLISHED_CHECKPOINT_CONFLICT"));
    assert.equal(readLatestPointer(publicationRepository).checkpoint_id, "same-id");
    truncateSync(different.database_path, 128);
    await assert.rejects(() => publishCheckpointLocally({ checkpointPath: different.checkpoint_directory, publicationRepository }), errorCode("DATABASE_SIZE_MISMATCH"));
    assert.equal(readLatestPointer(publicationRepository).checkpoint_id, "same-id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted and partial run recovery preserves successful work and retries idempotently without false closure", async () => {
  const root = temporaryRoot();
  try {
    const databasePath = fixtureDatabase(root);
    const db = openStore(databasePath);
    const company = {
      company_id: "company-one", company_name: "Company One", company_source_id: "source-one",
      source_provider: "greenhouse", source_url: "https://example.test/jobs",
    };
    const interrupted = beginRun(db, "2026-11-12T10:00:00Z");
    recordSourceObservation(db, interrupted, company,
      { status: "failed_http", httpStatus: 503, jobs: [], error: "temporary", sourceUrl: company.source_url },
      "2026-11-12T10:00:01Z");
    const recovered = recoverInterruptedRuns(db, "2026-11-12T10:05:00Z");
    assert.deepEqual(recovered.map((row) => row.run_id), [interrupted]);
    assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(interrupted).status, "interrupted");
    assert.deepEqual({ ...db.prepare("SELECT active, missing_success_count FROM jobs").get() }, { active: 1, missing_success_count: 0 });
    assert.equal(recoverInterruptedRuns(db, "2026-11-12T10:06:00Z").length, 0);

    const retry = beginRun(db, "2026-11-12T10:10:00Z");
    const raw = {
      source_job_id: "job-one", company_name: "Company One", job_title: "Analyst",
      source_provider: "greenhouse", source_url: company.source_url,
    };
    applySuccessfulObservation(db, retry, company,
      [normalizeJob(raw, "2026-11-12T10:10:01Z", { company, discoveryCohort: "retry", discoveryKind: "incremental" })],
      "2026-11-12T10:10:01Z");
    finishRun(db, retry, "completed", "2026-11-12T10:11:00Z");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM jobs").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM job_observations WHERE job_id=(SELECT job_id FROM jobs)").get().count, 2);
    assert.throws(() => finishRun(db, retry, "interrupted", "2026-11-12T10:12:00Z"), /Illegal run transition/);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("running or interrupted collection checkpoints are retained for recovery but cannot be published as successful state", async () => {
  const root = temporaryRoot();
  try {
    const databasePath = fixtureDatabase(root, { completedRun: false });
    const runningCheckpoint = await makeCheckpoint(root, "running-state", databasePath);
    assert.equal(runningCheckpoint.manifest.publication.eligible, false);
    assert.equal(runningCheckpoint.manifest.publication.ineligible_reason, "running_collection_exists");
    await assert.rejects(() => publishCheckpointLocally({ checkpointPath: runningCheckpoint.checkpoint_directory, publicationRepository: join(root, "publication") }), errorCode("CHECKPOINT_NOT_PUBLISHABLE"));
    const db = openStore(databasePath);
    recoverInterruptedRuns(db, "2026-11-12T10:00:00Z");
    db.close();
    const interruptedCheckpoint = await makeCheckpoint(root, "interrupted-state", databasePath);
    assert.equal(interruptedCheckpoint.manifest.publication.eligible, false);
    assert.match(interruptedCheckpoint.manifest.publication.ineligible_reason, /latest_run_status:interrupted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

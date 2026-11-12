import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createCheckpoint, sha256File } from "../src/checkpoint.js";
import { runCheckpointAutomation } from "../src/automation.js";
import { GitHubReleaseCheckpointStorage } from "../src/github-release-storage.js";
import { generatePublicExport, PUBLIC_JOB_FIELDS } from "../src/public-export.js";
import { FileCheckpointStorage, RemoteStorageError } from "../src/remote-checkpoint.js";
import {
  RuntimeSafetyError,
  compareNumericVersions,
  verifyRuntimeSafety,
} from "../src/runtime-safety.js";
import {
  applySuccessfulObservation,
  beginRun,
  finishRun,
  importCompanies,
  openStore,
  recordSourceObservation,
} from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

function root() {
  return mkdtempSync(join(tmpdir(), "techmap-phase6-test-"));
}

function runtimeOptions() {
  return { nodeVersion: "26.13.1", sqliteVersion: "3.54.1" };
}

function fixtureDatabase(directory, { sourceJobId = "job-one" } = {}) {
  const path = join(directory, "fixture.sqlite");
  const db = openStore(path);
  importCompanies(db, [{
    company_id: "company-one",
    company_name: "Company One",
    canonical_domain: "company.invalid",
    company_discovered_at: "2026-11-12T00:00:00.000Z",
    company_source_status: "verified",
  }], "2026-11-12T00:00:00.000Z");
  db.prepare(`
    INSERT INTO company_sources (
      source_id, company_id, source_kind, provider, source_identifier, source_url,
      evidence_source, evidence_status, is_enabled, effective_from, imported_at
    ) VALUES ('source-one', 'company-one', 'ats', 'greenhouse', 'company-one',
      'https://company.invalid/jobs', 'fixture', 'live_verified', 1,
      '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z')
  `).run();
  const runId = beginRun(db, "2026-11-12T00:01:00.000Z");
  const company = {
    company_id: "company-one", company_name: "Company One", company_source_id: "source-one",
    source_provider: "greenhouse", source_url: "https://company.invalid/jobs",
  };
  const job = normalizeJob({
    source_job_id: sourceJobId,
    company_name: company.company_name,
    job_title: "Data Analyst",
    location: "Tel Aviv",
    department: "Data",
    description: "Internal-looking raw text api_key example must not be exported",
    apply_url: "https://company.invalid/jobs/one/apply",
    source_provider: company.source_provider,
    source_url: company.source_url,
  }, "2026-11-12T00:01:00.000Z", { company, discoveryCohort: "fixture", discoveryKind: "baseline" });
  applySuccessfulObservation(db, runId, company, [job], "2026-11-12T00:01:00.000Z");
  recordSourceObservation(db, runId, company, {
    status: "success", httpStatus: 200, jobs: [job], error: null, sourceUrl: company.source_url,
  }, "2026-11-12T00:01:00.000Z");
  finishRun(db, runId, "completed", "2026-11-12T00:02:00.000Z");
  db.close();
  return { path, company, job };
}

async function fixtureCheckpoint(directory, id = "baseline") {
  const fixture = fixtureDatabase(directory);
  const checkpoint = await createCheckpoint({
    sourcePath: fixture.path,
    repositoryPath: join(directory, "created"),
    checkpointId: id,
    createdAt: "2026-11-12T00:03:00.000Z",
  });
  return { ...fixture, checkpoint };
}

test("runtime guard compares numerically and rejects vulnerable or unpinned runtimes", () => {
  assert.equal(compareNumericVersions("3.9.9", "3.53.2"), -1);
  assert.equal(compareNumericVersions("3.54.1", "3.53.2"), 1);
  assert.equal(compareNumericVersions("3.53.2", "3.53.2"), 0);
  assert.throws(() => verifyRuntimeSafety({ nodeVersion: "26.13.1", sqliteVersion: "3.51.2" }),
    (error) => error instanceof RuntimeSafetyError && error.code === "SQLITE_RUNTIME_UNSAFE");
  assert.throws(() => verifyRuntimeSafety({ nodeVersion: "24.14.0", sqliteVersion: "3.54.1" }),
    (error) => error instanceof RuntimeSafetyError && error.code === "NODE_RUNTIME_UNPINNED");
  assert.equal(verifyRuntimeSafety(runtimeOptions()).safe, true);
});

test("public export is deterministic, versioned, compressed, and limited to approved fields", () => {
  const directory = root();
  try {
    const fixture = fixtureDatabase(directory);
    const db = openStore(fixture.path);
    const first = generatePublicExport(db, join(directory, "public-one"), {
      generatedAt: "2026-11-12T01:00:00.000Z", pageSize: 1,
    });
    const second = generatePublicExport(db, join(directory, "public-two"), {
      generatedAt: "2026-11-12T01:00:00.000Z", pageSize: 1,
    });
    db.close();
    assert.equal(first.full.sha256, second.full.sha256);
    assert.equal(first.compressed.sha256, second.compressed.sha256);
    const full = JSON.parse(readFileSync(join(directory, "public-one", "jobs-v1.json"), "utf8"));
    assert.deepEqual(Object.keys(full.jobs[0]).sort(), [...PUBLIC_JOB_FIELDS].sort());
    assert.equal(full.jobs[0].original_publication_date, null);
    assert.equal(full.jobs[0].last_successful_source_observation, "2026-11-12T00:01:00.000Z");
    assert.equal("description" in full.jobs[0], false);
    assert.equal("source_url" in full.jobs[0], false);
    assert.equal("raw_json" in full.jobs[0], false);
    assert.equal(gunzipSync(readFileSync(join(directory, "public-one", "jobs-v1.json.gz"))).toString("utf8"),
      readFileSync(join(directory, "public-one", "jobs-v1.json"), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote storage refuses empty bootstrap, stages immutably, and downloads verified bytes", async () => {
  const directory = root();
  try {
    const storage = new FileCheckpointStorage(join(directory, "remote"));
    assert.throws(() => storage.discoverLatestTrusted(),
      (error) => error instanceof RemoteStorageError && error.code === "TRUSTED_CHECKPOINT_MISSING");
    const { checkpoint } = await fixtureCheckpoint(directory);
    storage.seedTrustedCheckpoint(checkpoint.checkpoint_directory, "2026-11-12T00:04:00.000Z");
    const downloaded = storage.downloadLatestTrusted(join(directory, "download"));
    assert.equal(downloaded.checkpoint.manifest.checkpoint_id, "baseline");
    assert.equal(sha256File(downloaded.checkpoint.database_path), checkpoint.manifest.database.sha256);
    assert.throws(() => storage.seedTrustedCheckpoint(checkpoint.checkpoint_directory),
      (error) => error instanceof RemoteStorageError && error.code === "BOOTSTRAP_NOT_EMPTY");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote publication preserves the previous pointer across interruption, CAS conflict, and retry", async () => {
  const directory = root();
  try {
    const storage = new FileCheckpointStorage(join(directory, "remote"));
    const one = await fixtureCheckpoint(join(directory, "one"), "one");
    storage.seedTrustedCheckpoint(one.checkpoint.checkpoint_directory, "2026-11-12T00:04:00.000Z");
    const previous = storage.pointerState();
    const two = await fixtureCheckpoint(join(directory, "two"), "two");
    const staged = storage.stageCheckpoint(two.checkpoint.checkpoint_directory);
    const published = storage.publishStaged(staged);
    assert.throws(() => storage.promoteLatest(published, {
      expectedRevision: previous.revision,
      onStage(stage) { if (stage === "before_pointer_promotion") throw new Error("controlled interruption"); },
    }), (error) => error instanceof RemoteStorageError && error.code === "PROMOTION_FAILED");
    assert.equal(storage.pointerState().pointer.checkpoint_id, "one");
    assert.throws(() => storage.promoteLatest(published, { expectedRevision: "0".repeat(64) }),
      (error) => error instanceof RemoteStorageError && error.code === "CONCURRENT_PUBLICATION");
    const promoted = storage.promoteLatest(published, { expectedRevision: previous.revision });
    assert.equal(promoted.pointer.checkpoint_id, "two");
    assert.equal(storage.promoteLatest(published, { expectedRevision: previous.revision }).idempotent, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote upload checksum mismatch fails before immutable publication or pointer change", async () => {
  const directory = root();
  try {
    const storage = new FileCheckpointStorage(join(directory, "remote"));
    const one = await fixtureCheckpoint(join(directory, "one"), "one");
    storage.seedTrustedCheckpoint(one.checkpoint.checkpoint_directory, "2026-11-12T00:04:00.000Z");
    const previous = storage.pointerState();
    const two = await fixtureCheckpoint(join(directory, "two"), "two");
    assert.throws(() => storage.stageCheckpoint(two.checkpoint.checkpoint_directory, {
      onStage(stage, details) {
        if (stage === "staged_verified") writeFileSync(join(details.staged_path, "database.sqlite"), "changed after upload");
      },
    }), (error) => error.code === "DATABASE_SIZE_MISMATCH" || error.code === "CHECKSUM_MISMATCH");
    assert.equal(storage.pointerState().revision, previous.revision);
    assert.equal(storage.pointerState().pointer.checkpoint_id, "one");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("corrupt latest remote checkpoint falls back to the previous valid publication", async () => {
  const directory = root();
  try {
    const storage = new FileCheckpointStorage(join(directory, "remote"));
    const one = await fixtureCheckpoint(join(directory, "one"), "one");
    storage.seedTrustedCheckpoint(one.checkpoint.checkpoint_directory, "2026-11-12T00:04:00.000Z");
    const prior = storage.pointerState();
    const two = await fixtureCheckpoint(join(directory, "two"), "two");
    const published = storage.publishStaged(storage.stageCheckpoint(two.checkpoint.checkpoint_directory));
    storage.promoteLatest(published, { expectedRevision: prior.revision, promotedAt: "2026-11-12T00:05:00.000Z" });
    writeFileSync(join(directory, "remote", "published", "two", "database.sqlite"), "corrupt");
    const recovered = storage.discoverLatestTrusted();
    assert.equal(recovered.checkpoint.manifest.checkpoint_id, "one");
    assert.equal(recovered.resolution, "published_scan_fallback");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GitHub storage fails closed for missing credentials, rate limits, and permissions", async () => {
  assert.throws(() => new GitHubReleaseCheckpointStorage({ owner: "o", repository: "r", token: "" }),
    (error) => error instanceof RemoteStorageError && error.code === "CREDENTIALS_MISSING");
  const response = (status, remaining) => ({
    ok: false, status,
    headers: { get: (name) => name === "x-ratelimit-remaining" ? remaining : null },
  });
  const limited = new GitHubReleaseCheckpointStorage({
    owner: "o", repository: "r", token: "secret", fetchImpl: async () => response(403, "0"),
  });
  await assert.rejects(() => limited.pointerState(),
    (error) => error instanceof RemoteStorageError && error.code === "RATE_LIMITED");
  const denied = new GitHubReleaseCheckpointStorage({
    owner: "o", repository: "r", token: "secret", fetchImpl: async () => response(403, "4999"),
  });
  await assert.rejects(() => denied.pointerState(),
    (error) => error instanceof RemoteStorageError && error.code === "PERMISSION_DENIED");
});

test("complete automation rehearsal preserves identity, isolates failure, and retries idempotently", async () => {
  const directory = root();
  try {
    const initial = await fixtureCheckpoint(join(directory, "initial"), "baseline");
    const remote = new FileCheckpointStorage(join(directory, "remote"));
    remote.seedTrustedCheckpoint(initial.checkpoint.checkpoint_directory, "2026-11-12T00:04:00.000Z");
    const initialFirstSeen = initial.job.first_seen_at;
    const collect = async ({ databasePath, generatedAt }) => {
      const db = openStore(databasePath);
      const failedRun = beginRun(db, generatedAt);
      recordSourceObservation(db, failedRun, initial.company, {
        status: "failed", httpStatus: 503, jobs: [], error: "controlled",
      }, generatedAt);
      finishRun(db, failedRun, "partial_success", generatedAt);
      const runId = beginRun(db, generatedAt);
      const job = normalizeJob({
        source_job_id: "job-one", company_name: "Company One", job_title: "Data Analyst Updated",
        location: "Tel Aviv", department: "Data", apply_url: "https://company.invalid/jobs/one/apply",
        source_provider: "greenhouse", source_url: "https://company.invalid/jobs",
      }, generatedAt, { company: initial.company, discoveryCohort: "fixture", discoveryKind: "retry" });
      applySuccessfulObservation(db, runId, initial.company, [job], generatedAt);
      recordSourceObservation(db, runId, initial.company, {
        status: "success", httpStatus: 200, jobs: [job], error: null,
      }, generatedAt);
      finishRun(db, runId, "completed", generatedAt);
      const state = db.prepare("SELECT COUNT(*) count, MIN(first_seen_at) first_seen FROM jobs WHERE job_id=?").get(initial.job.job_id);
      db.close();
      return { run_id: runId, jobs: Number(state.count), first_seen_at: state.first_seen };
    };
    const first = await runCheckpointAutomation({
      storage: remote,
      workspacePath: join(directory, "run-one"),
      collect,
      generatedAt: "2026-11-12T01:00:00.000Z",
      runtimeOptions: runtimeOptions(),
    });
    assert.equal(first.collection.jobs, 1);
    assert.equal(first.collection.first_seen_at, initialFirstSeen);
    assert.equal(first.recovered_checkpoint_id, first.checkpoint_id);
    const second = await runCheckpointAutomation({
      storage: remote,
      workspacePath: join(directory, "run-two"),
      collect,
      generatedAt: "2026-11-12T02:00:00.000Z",
      runtimeOptions: runtimeOptions(),
    });
    assert.equal(second.collection.jobs, 1);
    assert.equal(second.collection.first_seen_at, initialFirstSeen);
    assert.notEqual(second.checkpoint_id, first.checkpoint_id);
    assert.equal(second.final_inspection.counts.jobs, 1);
    assert.equal(JSON.parse(readFileSync(second.public_export.index_path, "utf8")).job_count, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

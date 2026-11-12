#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCheckpointAutomation } from "../src/automation.js";
import { createCheckpoint, inspectCheckpointDatabase, sha256File, validateCheckpoint } from "../src/checkpoint.js";
import { FileCheckpointStorage, RemoteStorageError } from "../src/remote-checkpoint.js";
import {
  applySuccessfulObservation,
  beginRun,
  finishRun,
  importCompanies,
  openStore,
  recordSourceObservation,
} from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

const livePath = resolve(process.argv[2] ?? "data/jobs.sqlite");
const root = mkdtempSync(join(tmpdir(), "techmap-phase6-rehearsal-"));
const generatedAt = "2026-11-12T12:00:00.000Z";

function stableState(inspection) {
  return {
    schema_version: inspection.schema_version,
    counts: inspection.counts,
    fingerprints: inspection.fingerprints,
    collection_run: inspection.collection_run,
    source_state: inspection.source_state,
  };
}

function fixtureCollector() {
  return async ({ databasePath, generatedAt: observedAt }) => {
    const db = openStore(databasePath);
    if (!db.prepare("SELECT 1 FROM companies WHERE company_id='phase6-rehearsal-company'").get()) {
      importCompanies(db, [{
        company_id: "phase6-rehearsal-company",
        company_name: "Phase 6 Rehearsal Company",
        canonical_domain: "phase6.invalid",
        company_discovered_at: observedAt,
        company_source_name: "phase6_fixture",
        company_source_status: "verified",
      }], observedAt);
      db.prepare(`
        INSERT INTO company_sources (
          source_id, company_id, source_kind, provider, source_identifier, source_url,
          evidence_source, evidence_status, is_enabled, effective_from, imported_at
        ) VALUES ('phase6-rehearsal-source', 'phase6-rehearsal-company', 'ats', 'greenhouse',
          'phase6-rehearsal', 'https://phase6.invalid/jobs', 'phase6_fixture',
          'live_verified', 1, ?, ?)
      `).run(observedAt, observedAt);
    }
    const company = {
      company_id: "phase6-rehearsal-company",
      company_name: "Phase 6 Rehearsal Company",
      company_source_id: "phase6-rehearsal-source",
      source_provider: "greenhouse",
      source_url: "https://phase6.invalid/jobs",
    };
    const failedRun = beginRun(db, observedAt);
    recordSourceObservation(db, failedRun, company, {
      status: "failed", httpStatus: 503, jobs: [], error: "controlled fixture failure",
    }, observedAt);
    finishRun(db, failedRun, "partial_success", observedAt);
    const runId = beginRun(db, observedAt);
    const job = normalizeJob({
      source_job_id: "phase6-job-one",
      company_name: company.company_name,
      job_title: "Fixture Growth Analyst",
      location: "Tel Aviv, Israel",
      department: "Marketing Analytics",
      description: "Private fixture description that must not enter public export",
      apply_url: "https://phase6.invalid/jobs/one/apply",
      source_provider: company.source_provider,
      source_url: company.source_url,
    }, observedAt, { company, discoveryCohort: "phase6_fixture", discoveryKind: "rehearsal" });
    applySuccessfulObservation(db, runId, company, [job], observedAt);
    recordSourceObservation(db, runId, company, {
      status: "success", httpStatus: 200, jobs: [job], error: null,
    }, observedAt);
    finishRun(db, runId, "completed", observedAt);
    const result = db.prepare("SELECT job_id, first_seen_at FROM jobs WHERE company_source_id=?").get(company.company_source_id);
    const jobCount = Number(db.prepare("SELECT COUNT(*) count FROM jobs WHERE company_source_id=?").get(company.company_source_id).count);
    db.close();
    return { ...result, fixture_job_count: jobCount };
  };
}

let evidence;
try {
  const liveShaBefore = sha256File(livePath);
  const liveBefore = inspectCheckpointDatabase(livePath);
  const baseline = await createCheckpoint({
    sourcePath: livePath,
    repositoryPath: join(root, "initial"),
    checkpointId: "phase6-baseline",
    createdAt: generatedAt,
  });
  const storage = new FileCheckpointStorage(join(root, "mock-remote"));
  storage.seedTrustedCheckpoint(baseline.checkpoint_directory, generatedAt);
  const originalPromote = storage.promoteLatest.bind(storage);
  let injectPromotionFailure = true;
  storage.promoteLatest = async (...args) => {
    if (injectPromotionFailure) {
      injectPromotionFailure = false;
      throw new RemoteStorageError("CONTROLLED_POINTER_FAILURE", "Controlled pointer failure after immutable publication");
    }
    return originalPromote(...args);
  };

  let controlledFailure;
  try {
    await runCheckpointAutomation({
      storage,
      workspacePath: join(root, "interrupted-run"),
      collect: fixtureCollector(),
      protectedDatabasePaths: [livePath],
      generatedAt: "2026-11-12T12:01:00.000Z",
    });
  } catch (error) {
    controlledFailure = error;
  }
  assert.equal(controlledFailure?.code, "CONTROLLED_POINTER_FAILURE");
  assert.equal(storage.pointerState().pointer.checkpoint_id, "phase6-baseline");
  const trustedAfterFailure = storage.discoverLatestTrusted();
  assert.equal(trustedAfterFailure.resolution, "latest_pointer");
  const orphanId = readdirSync(storage.published).find((id) => id !== "phase6-baseline");
  const orphanCandidate = validateCheckpoint(join(storage.published, orphanId));

  const completed = await runCheckpointAutomation({
    storage,
    workspacePath: join(root, "retry-run"),
    collect: fixtureCollector(),
    protectedDatabasePaths: [livePath],
    generatedAt: "2026-11-12T12:02:00.000Z",
  });
  assert.equal(completed.restore_resolution, "latest_pointer");
  assert.equal(completed.collection.fixture_job_count, 1);
  assert.equal(completed.recovered_checkpoint_id, completed.checkpoint_id);
  assert.equal(completed.final_inspection.counts.jobs, liveBefore.counts.jobs + 1);
  assert.equal(completed.final_inspection.counts.job_observations, liveBefore.counts.job_observations + 1);

  const secondRun = await runCheckpointAutomation({
    storage,
    workspacePath: join(root, "second-manual-run"),
    collect: fixtureCollector(),
    protectedDatabasePaths: [livePath],
    generatedAt: "2026-11-12T12:03:00.000Z",
  });
  assert.equal(secondRun.restored_checkpoint_id, completed.checkpoint_id);
  assert.equal(secondRun.collection.fixture_job_count, 1);
  assert.equal(secondRun.collection.job_id, completed.collection.job_id);
  assert.equal(secondRun.collection.first_seen_at, completed.collection.first_seen_at);
  assert.equal(secondRun.final_inspection.counts.jobs, liveBefore.counts.jobs + 1);
  assert.equal(secondRun.final_inspection.counts.job_observations, liveBefore.counts.job_observations + 2);
  assert.equal(secondRun.recovered_checkpoint_id, secondRun.checkpoint_id);

  const liveAfter = inspectCheckpointDatabase(livePath);
  const liveShaAfter = sha256File(livePath);
  assert.equal(liveShaAfter, liveShaBefore);
  assert.deepEqual(stableState(liveAfter), stableState(liveBefore));
  evidence = {
    verdict: "passed",
    runtime: completed.runtime,
    live_database: {
      path: livePath,
      sha256_before: liveShaBefore,
      sha256_after: liveShaAfter,
      logical_state_unchanged: true,
      baseline: stableState(liveBefore),
    },
    bootstrap_checkpoint: {
      checkpoint_id: baseline.manifest.checkpoint_id,
      database_sha256: baseline.manifest.database.sha256,
    },
    interruption: {
      code: controlledFailure.code,
      previous_pointer_preserved: true,
      retry_restored_previous_trusted_checkpoint: trustedAfterFailure.checkpoint.manifest.checkpoint_id,
      unreferenced_candidate_remained_valid: orphanCandidate.manifest.checkpoint_id,
    },
    retry: {
      restore_resolution: completed.restore_resolution,
      promoted_checkpoint_id: completed.checkpoint_id,
      independently_recovered_checkpoint_id: completed.recovered_checkpoint_id,
      fixture_job_id: completed.collection.job_id,
      fixture_job_count: completed.collection.fixture_job_count,
      first_seen_at: completed.collection.first_seen_at,
      final_jobs: completed.final_inspection.counts.jobs,
      final_job_observations: completed.final_inspection.counts.job_observations,
    },
    second_manual_run: {
      restored_checkpoint_id: secondRun.restored_checkpoint_id,
      promoted_checkpoint_id: secondRun.checkpoint_id,
      independently_recovered_checkpoint_id: secondRun.recovered_checkpoint_id,
      same_job_id: secondRun.collection.job_id === completed.collection.job_id,
      preserved_first_seen_at: secondRun.collection.first_seen_at === completed.collection.first_seen_at,
      fixture_job_count: secondRun.collection.fixture_job_count,
      final_jobs: secondRun.final_inspection.counts.jobs,
      final_job_observations: secondRun.final_inspection.counts.job_observations,
    },
    public_export: {
      format: completed.public_export.format,
      version: completed.public_export.version,
      jobs: completed.public_export.job_count,
      pages: completed.public_export.pages.length,
      bytes: completed.public_export.full.bytes,
      compressed_bytes: completed.public_export.compressed.bytes,
      sha256: completed.public_export.full.sha256,
    },
    temporary_workspace_removed: true,
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify(evidence, null, 2));

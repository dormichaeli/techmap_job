#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CHECKPOINT_DATABASE_FILE,
  createCheckpoint,
  inspectCheckpointDatabase,
  restoreCheckpoint,
  sha256File,
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
} from "../src/store.js";
import { normalizeJob } from "../src/scoring.js";

const livePath = resolve(process.argv[2] ?? "data/jobs.sqlite");
const root = mkdtempSync(join(tmpdir(), "techmap-phase5-rehearsal-"));
const creationRepository = join(root, "created");
const publicationRepository = join(root, "publication");
const baselineId = "rehearsal-baseline";
const updatedId = "rehearsal-updated";
const timestamp = "2026-11-12T10:00:00.000Z";

function summary(inspection) {
  return {
    schema_version: inspection.schema_version,
    counts: inspection.counts,
    fingerprints: inspection.fingerprints,
    collection_run: inspection.collection_run,
    source_state: inspection.source_state,
  };
}

let evidence;
try {
  const liveShaBefore = sha256File(livePath);
  const liveBefore = inspectCheckpointDatabase(livePath);
  const baseline = await createCheckpoint({
    sourcePath: livePath,
    repositoryPath: creationRepository,
    checkpointId: baselineId,
    createdAt: timestamp,
  });
  assert.deepEqual(summary(baseline.inspection), summary(liveBefore));

  const baselinePublication = await publishCheckpointLocally({
    checkpointPath: baseline.checkpoint_directory,
    publicationRepository,
    promotedAt: "2026-11-12T10:01:00.000Z",
    expectedLatestCheckpointId: null,
  });
  const workingDatabase = join(root, "working", "jobs.sqlite");
  restoreCheckpoint({
    checkpointPath: baseline.checkpoint_directory,
    destinationPath: workingDatabase,
    forbiddenPaths: [livePath],
  });

  const db = openStore(workingDatabase);
  const jobsBefore = Number(db.prepare("SELECT COUNT(*) count FROM jobs").get().count);
  const observationsBefore = Number(db.prepare("SELECT COUNT(*) count FROM job_observations").get().count);
  importCompanies(db, [{
    company_id: "phase5-rehearsal-company",
    company_name: "Phase 5 Rehearsal Company",
    canonical_domain: "phase5.invalid",
    company_discovered_at: timestamp,
    company_source_name: "phase5_fixture",
    company_source_status: "verified",
  }], timestamp);
  db.prepare(`
    INSERT INTO company_sources (
      source_id, company_id, source_kind, provider, source_identifier, source_url,
      evidence_source, evidence_status, is_enabled, effective_from, imported_at
    ) VALUES (?, ?, 'ats', 'greenhouse', ?, ?, 'phase5_fixture', 'live_verified', 1, ?, ?)
  `).run("phase5-rehearsal-source", "phase5-rehearsal-company", "phase5-rehearsal", "https://phase5.invalid/jobs", timestamp, timestamp);
  const company = {
    company_id: "phase5-rehearsal-company",
    company_name: "Phase 5 Rehearsal Company",
    company_source_id: "phase5-rehearsal-source",
    source_provider: "greenhouse",
    source_url: "https://phase5.invalid/jobs",
  };

  const failedRun = beginRun(db, "2026-11-12T10:02:00.000Z");
  recordSourceObservation(db, failedRun, company, {
    status: "failed", httpStatus: 503, jobs: [], error: "controlled fixture failure",
  }, "2026-11-12T10:02:01.000Z");
  finishRun(db, failedRun, "partial_success", "2026-11-12T10:02:02.000Z");
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM jobs WHERE company_source_id=?").get(company.company_source_id).count), 0);

  const raw = {
    source_job_id: "phase5-job-one",
    company_name: company.company_name,
    job_title: "Fixture Data Analyst",
    location: "Tel Aviv, Israel",
    source_provider: company.source_provider,
    source_url: company.source_url,
    job_url: "https://phase5.invalid/jobs/one",
    apply_url: "https://phase5.invalid/jobs/one/apply",
  };
  let expectedJobId;
  for (const [index, observedAt] of ["2026-11-12T10:03:00.000Z", "2026-11-12T10:04:00.000Z"].entries()) {
    const runId = beginRun(db, observedAt);
    const job = normalizeJob(raw, observedAt, { company, discoveryCohort: "phase5_fixture", discoveryKind: "rehearsal" });
    expectedJobId ??= job.job_id;
    assert.equal(job.job_id, expectedJobId);
    applySuccessfulObservation(db, runId, company, [job], observedAt);
    recordSourceObservation(db, runId, company, {
      status: "healthy", httpStatus: 200, jobs: [job], error: null, sourceUrl: company.source_url,
    }, observedAt);
    finishRun(db, runId, "completed", new Date(Date.parse(observedAt) + 1000).toISOString());
    if (index === 1) assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM jobs WHERE job_id=?").get(expectedJobId).count), 1);
  }
  const jobsAfter = Number(db.prepare("SELECT COUNT(*) count FROM jobs").get().count);
  const observationsAfter = Number(db.prepare("SELECT COUNT(*) count FROM job_observations").get().count);
  const firstSeen = db.prepare("SELECT first_seen_at FROM jobs WHERE job_id=?").get(expectedJobId).first_seen_at;
  assert.equal(jobsAfter, jobsBefore + 1);
  assert.equal(observationsAfter, observationsBefore + 2);
  assert.equal(firstSeen, "2026-11-12T10:03:00.000Z");
  db.close();

  const updated = await createCheckpoint({
    sourcePath: workingDatabase,
    repositoryPath: creationRepository,
    checkpointId: updatedId,
    createdAt: "2026-11-12T10:05:00.000Z",
  });
  const independentlyRestored = join(root, "independent-restore", "jobs.sqlite");
  const independentRestore = restoreCheckpoint({
    checkpointPath: updated.checkpoint_directory,
    destinationPath: independentlyRestored,
    forbiddenPaths: [livePath],
  });

  let interruptionCode = null;
  try {
    await publishCheckpointLocally({
      checkpointPath: updated.checkpoint_directory,
      publicationRepository,
      promotedAt: "2026-11-12T10:06:00.000Z",
      expectedLatestCheckpointId: baselineId,
      onStage(stage) {
        if (stage === "before_latest_pointer_update") throw new Error("controlled publication interruption");
      },
    });
  } catch (error) {
    interruptionCode = error.code;
  }
  assert.equal(interruptionCode, "PUBLICATION_FAILED");
  assert.equal(readLatestPointer(publicationRepository).checkpoint_id, baselineId);

  const retryPublication = await publishCheckpointLocally({
    checkpointPath: updated.checkpoint_directory,
    publicationRepository,
    promotedAt: "2026-11-12T10:07:00.000Z",
    expectedLatestCheckpointId: baselineId,
  });
  assert.equal(retryPublication.idempotent_candidate_reuse, true);
  assert.equal(readLatestPointer(publicationRepository).checkpoint_id, updatedId);
  const resolved = resolveTrustedCheckpoint(publicationRepository);
  assert.equal(resolved.manifest.checkpoint_id, updatedId);

  const trustedPointerText = readFileSync(join(publicationRepository, LATEST_POINTER_FILE), "utf8");
  const missingPointer = JSON.parse(trustedPointerText);
  missingPointer.checkpoint_id = "missing-checkpoint";
  writeFileSync(join(publicationRepository, LATEST_POINTER_FILE), `${JSON.stringify(missingPointer, null, 2)}\n`);
  const fallback = resolveTrustedCheckpoint(publicationRepository);
  assert.equal(fallback.manifest.checkpoint_id, updatedId);
  assert.equal(fallback.resolution, "published_scan_fallback");
  writeFileSync(join(publicationRepository, LATEST_POINTER_FILE), trustedPointerText);

  const liveAfter = inspectCheckpointDatabase(livePath);
  const liveShaAfter = sha256File(livePath);
  assert.deepEqual(summary(liveAfter), summary(liveBefore));
  assert.equal(liveShaAfter, liveShaBefore);

  evidence = {
    verdict: "passed",
    executed_at: new Date().toISOString(),
    live_database: {
      path: livePath,
      sha256_before: liveShaBefore,
      sha256_after: liveShaAfter,
      logical_state_unchanged: true,
      baseline: summary(liveBefore),
    },
    baseline_checkpoint: {
      checkpoint_id: baselineId,
      database_sha256: baseline.manifest.database.sha256,
      publication_pointer_sha256: baselinePublication.pointer_sha256,
    },
    fixture_collection: {
      controlled_failed_run_preserved_jobs: true,
      job_id: expectedJobId,
      jobs_before: jobsBefore,
      jobs_after: jobsAfter,
      observations_before: observationsBefore,
      observations_after: observationsAfter,
      first_seen_preserved_on_retry: firstSeen,
      duplicate_job_rows: 0,
    },
    updated_checkpoint: {
      checkpoint_id: updatedId,
      database_sha256: updated.manifest.database.sha256,
      independent_restore_integrity: independentRestore.inspection.integrity_check,
      independent_restore_foreign_key_violations: independentRestore.inspection.foreign_key_violations,
    },
    publication: {
      interrupted_publication_error: interruptionCode,
      previous_pointer_preserved: true,
      retry_reused_verified_candidate: retryPublication.idempotent_candidate_reuse,
      latest_checkpoint_id: resolved.manifest.checkpoint_id,
      missing_target_pointer_fallback: fallback.manifest.checkpoint_id,
      fallback_resolution: fallback.resolution,
    },
    temporary_workspace_removed: true,
  };
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify(evidence, null, 2));

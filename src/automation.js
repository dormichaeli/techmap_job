import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createCheckpoint, inspectCheckpointDatabase, restoreCheckpoint, validateCheckpoint } from "./checkpoint.js";
import { generatePublicExport } from "./public-export.js";
import { openStore, recoverInterruptedRuns } from "./store.js";
import { verifyRuntimeSafety } from "./runtime-safety.js";

export class AutomationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
    this.details = details;
  }
}

export async function runCheckpointAutomation({
  storage,
  workspacePath,
  collect,
  protectedDatabasePaths = [],
  generatedAt = new Date().toISOString(),
  runtimeOptions,
  checkpointId,
  onStage = null,
}) {
  if (!storage) throw new AutomationError("STORAGE_MISSING", "Checkpoint storage is required");
  if (typeof collect !== "function") throw new AutomationError("COLLECTOR_MISSING", "A bounded collector function is required");
  const runtime = verifyRuntimeSafety(runtimeOptions);
  const workspace = resolve(workspacePath);
  if (existsSync(workspace)) throw new AutomationError("WORKSPACE_EXISTS", `Automation workspace already exists: ${workspace}`);
  mkdirSync(workspace, { recursive: true });
  if (onStage) await onStage("runtime_verified", { runtime });

  const downloadRoot = join(workspace, "download");
  const restoredDatabase = join(workspace, "working", "jobs.sqlite");
  const discovered = await storage.downloadLatestTrusted(downloadRoot);
  if (onStage) await onStage("checkpoint_downloaded", { checkpoint_id: discovered.checkpoint.manifest.checkpoint_id, resolution: discovered.resolution });
  restoreCheckpoint({
    checkpointPath: discovered.checkpoint.checkpoint_directory,
    destinationPath: restoredDatabase,
    forbiddenPaths: protectedDatabasePaths,
  });
  const restoredBefore = inspectCheckpointDatabase(restoredDatabase);
  if (onStage) await onStage("checkpoint_restored", { restoredBefore });

  const recoveryDb = openStore(restoredDatabase);
  const recoveredRuns = recoverInterruptedRuns(recoveryDb, generatedAt);
  recoveryDb.close();
  if (onStage) await onStage("interrupted_runs_recovered", { recoveredRuns });

  const collection = await collect({ databasePath: restoredDatabase, workspacePath: workspace, generatedAt });
  const collected = inspectCheckpointDatabase(restoredDatabase);
  if (!collected.collection_run || collected.collection_run.status !== "completed" || collected.running_runs !== 0) {
    throw new AutomationError(
      "COLLECTION_NOT_COMPLETE",
      `Collection did not commit a complete run: ${collected.collection_run?.status ?? "missing"}`,
      { collection_run: collected.collection_run, running_runs: collected.running_runs },
    );
  }
  if (onStage) await onStage("collection_verified", { collected, collection });

  const timestampId = generatedAt.replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const id = checkpointId ?? `run-${collected.collection_run.run_id}-${timestampId}`;
  const checkpoint = await createCheckpoint({
    sourcePath: restoredDatabase,
    repositoryPath: join(workspace, "checkpoints"),
    checkpointId: id,
    createdAt: generatedAt,
  });
  const independentRestorePath = join(workspace, "checkpoint-restore", "jobs.sqlite");
  restoreCheckpoint({
    checkpointPath: checkpoint.checkpoint_directory,
    destinationPath: independentRestorePath,
    forbiddenPaths: [restoredDatabase, ...protectedDatabasePaths],
  });
  validateCheckpoint(checkpoint.checkpoint_directory);
  if (onStage) await onStage("checkpoint_independently_verified", { checkpoint_id: id });

  const staged = await storage.stageCheckpoint(checkpoint.checkpoint_directory);
  if (onStage) await onStage("remote_checkpoint_staged", { checkpoint_id: id });
  const published = await storage.publishStaged(staged);
  if (onStage) await onStage("remote_checkpoint_published", { checkpoint_id: id });
  const promotion = await storage.promoteLatest(
    published.checkpoint ? published : { ...published, checkpoint },
    {
      expectedRevision: discovered.pointer_state?.revision ?? null,
      promotedAt: generatedAt,
    },
  );
  if (onStage) await onStage("latest_pointer_promoted", { checkpoint_id: id, promotion });

  const exportDb = openStore(restoredDatabase);
  const publicExport = generatePublicExport(exportDb, join(workspace, "public-export"), { generatedAt });
  exportDb.close();
  if (onStage) await onStage("public_export_generated", { publicExport });

  const recoveryDownload = await storage.downloadLatestTrusted(join(workspace, "recovery-download"));
  const recoveryDatabase = join(workspace, "recovery", "jobs.sqlite");
  const recovery = restoreCheckpoint({
    checkpointPath: recoveryDownload.checkpoint.checkpoint_directory,
    destinationPath: recoveryDatabase,
    forbiddenPaths: [restoredDatabase, ...protectedDatabasePaths],
  });
  if (recovery.checkpoint_id !== id) throw new AutomationError("PROMOTED_RECOVERY_MISMATCH", `Recovered ${recovery.checkpoint_id}, expected ${id}`);
  if (onStage) await onStage("promoted_checkpoint_recovered", { recovery });

  return {
    runtime,
    restored_checkpoint_id: discovered.checkpoint.manifest.checkpoint_id,
    restore_resolution: discovered.resolution,
    recovered_interrupted_runs: recoveredRuns,
    collection,
    checkpoint_id: id,
    checkpoint_database_sha256: checkpoint.manifest.database.sha256,
    promotion,
    public_export: publicExport,
    recovered_checkpoint_id: recovery.checkpoint_id,
    final_inspection: collected,
  };
}

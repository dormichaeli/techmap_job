import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  CHECKPOINT_DATABASE_FILE,
  CHECKPOINT_MANIFEST_FILE,
  CheckpointError,
  acquireFileLock,
  canonicalJson,
  validateCheckpoint,
} from "./checkpoint.js";

export const LATEST_POINTER_FILE = "latest-checkpoint.json";
export const LATEST_POINTER_FORMAT = "techmap-job-latest-checkpoint";
export const LATEST_POINTER_VERSION = 1;

function assert(condition, code, message, details = {}) {
  if (!condition) throw new CheckpointError(code, message, details);
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function writeExclusiveDurably(path, content) {
  const handle = openSync(path, "wx");
  try {
    writeSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export function validateLatestPointer(pointer) {
  assert(pointer && typeof pointer === "object" && !Array.isArray(pointer), "LATEST_POINTER_INVALID", "Latest-checkpoint pointer must be an object");
  assert(pointer.pointer_format === LATEST_POINTER_FORMAT, "LATEST_POINTER_INVALID", "Latest-checkpoint pointer format is invalid");
  assert(pointer.pointer_format_version === LATEST_POINTER_VERSION, "LATEST_POINTER_VERSION_UNSUPPORTED", `Unsupported latest pointer version ${pointer.pointer_format_version}`);
  assert(typeof pointer.checkpoint_id === "string" && /^[A-Za-z0-9._-]+$/.test(pointer.checkpoint_id), "LATEST_POINTER_INVALID", "Latest pointer checkpoint_id is invalid");
  assert(typeof pointer.manifest_sha256 === "string" && /^[0-9a-f]{64}$/.test(pointer.manifest_sha256), "LATEST_POINTER_INVALID", "Latest pointer manifest_sha256 is invalid");
  assert(typeof pointer.database_sha256 === "string" && /^[0-9a-f]{64}$/.test(pointer.database_sha256), "LATEST_POINTER_INVALID", "Latest pointer database_sha256 is invalid");
  assert(typeof pointer.promoted_at === "string" && pointer.promoted_at.endsWith("Z") && Number.isFinite(Date.parse(pointer.promoted_at)), "LATEST_POINTER_INVALID", "Latest pointer promoted_at must be UTC");
  assert(pointer.previous_checkpoint_id === null
    || (typeof pointer.previous_checkpoint_id === "string" && /^[A-Za-z0-9._-]+$/.test(pointer.previous_checkpoint_id)),
  "LATEST_POINTER_INVALID", "Latest pointer previous_checkpoint_id is invalid");
  return pointer;
}

export function readLatestPointer(publicationRepository) {
  const path = join(resolve(publicationRepository), LATEST_POINTER_FILE);
  if (!existsSync(path)) return null;
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CheckpointError("LATEST_POINTER_MALFORMED", `Latest-checkpoint pointer is malformed: ${error.message}`);
  }
  return validateLatestPointer(pointer);
}

function validatePublishedPointer(repository, pointer, options = {}) {
  const checkpointPath = join(repository, "published", pointer.checkpoint_id);
  assert(existsSync(checkpointPath), "LATEST_CHECKPOINT_MISSING", `Latest pointer references missing checkpoint ${pointer.checkpoint_id}`);
  const validated = validateCheckpoint(checkpointPath, options);
  assert(validated.manifest_sha256 === pointer.manifest_sha256, "LATEST_POINTER_MISMATCH", "Latest pointer manifest checksum does not match checkpoint");
  assert(validated.manifest.database.sha256 === pointer.database_sha256, "LATEST_POINTER_MISMATCH", "Latest pointer database checksum does not match checkpoint");
  return validated;
}

export function resolveTrustedCheckpoint(publicationRepository, options = {}) {
  const repository = resolve(publicationRepository);
  let pointerFailure = null;
  try {
    const pointer = readLatestPointer(repository);
    if (pointer) {
      return {
        ...validatePublishedPointer(repository, pointer, options),
        resolution: "latest_pointer",
        pointer,
        recovery_reason: null,
      };
    }
    pointerFailure = new CheckpointError("LATEST_POINTER_MISSING", "Latest-checkpoint pointer is missing");
  } catch (error) {
    pointerFailure = error;
  }

  const publishedPath = join(repository, "published");
  const candidates = existsSync(publishedPath)
    ? readdirSync(publishedPath, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-")).map((entry) => entry.name)
    : [];
  const valid = [];
  for (const checkpointId of candidates) {
    try {
      const validated = validateCheckpoint(join(publishedPath, checkpointId), options);
      valid.push(validated);
    } catch {
      // A corrupt publication candidate is skipped in favor of a prior trusted checkpoint.
    }
  }
  valid.sort((a, b) => Date.parse(b.manifest.created_at) - Date.parse(a.manifest.created_at)
    || b.manifest.checkpoint_id.localeCompare(a.manifest.checkpoint_id));
  assert(valid.length > 0, "NO_TRUSTED_CHECKPOINT", `No valid published checkpoint is recoverable after ${pointerFailure.code}: ${pointerFailure.message}`);
  return {
    ...valid[0],
    resolution: "published_scan_fallback",
    pointer: null,
    recovery_reason: `${pointerFailure.code}:${pointerFailure.message}`,
  };
}

export async function publishCheckpointLocally({
  checkpointPath,
  publicationRepository,
  promotedAt = new Date().toISOString(),
  expectedLatestCheckpointId,
  onStage = null,
  minimumSchemaVersion,
  maximumSchemaVersion,
}) {
  const repository = resolve(publicationRepository);
  mkdirSync(repository, { recursive: true });
  const releaseLock = acquireFileLock(join(repository, ".checkpoint-publish.lock"), { operation: "publish" });
  let stagingPath = null;
  let pointerTemporaryPath = null;
  try {
    const source = validateCheckpoint(checkpointPath, { minimumSchemaVersion, maximumSchemaVersion });
    assert(source.manifest.publication.eligible, "CHECKPOINT_NOT_PUBLISHABLE", `Checkpoint ${source.manifest.checkpoint_id} is not publication eligible: ${source.manifest.publication.ineligible_reason}`);
    const currentPointer = readLatestPointer(repository);
    if (expectedLatestCheckpointId !== undefined) {
      assert((currentPointer?.checkpoint_id ?? null) === expectedLatestCheckpointId,
        "LATEST_POINTER_CONFLICT",
        `Optimistic publication conflict: expected ${expectedLatestCheckpointId}, found ${currentPointer?.checkpoint_id ?? "none"}`);
    }
    const publishedRoot = join(repository, "published");
    mkdirSync(publishedRoot, { recursive: true });
    const finalPath = join(publishedRoot, source.manifest.checkpoint_id);
    const reusedExistingCandidate = existsSync(finalPath);
    if (reusedExistingCandidate) {
      let existing;
      try {
        existing = validateCheckpoint(finalPath, { minimumSchemaVersion, maximumSchemaVersion });
      } catch (error) {
        throw new CheckpointError("PUBLISHED_CHECKPOINT_CONFLICT", `Published checkpoint ${source.manifest.checkpoint_id} already exists but is invalid: ${error.message}`);
      }
      assert(existing.manifest_sha256 === source.manifest_sha256
        && existing.manifest.database.sha256 === source.manifest.database.sha256,
      "PUBLISHED_CHECKPOINT_CONFLICT", `Published checkpoint ${source.manifest.checkpoint_id} already exists with different content`);
    } else {
      stagingPath = join(publishedRoot, `.tmp-${source.manifest.checkpoint_id}-${randomUUID()}`);
      mkdirSync(stagingPath);
      copyFileSync(source.database_path, join(stagingPath, CHECKPOINT_DATABASE_FILE));
      copyFileSync(source.manifest_path, join(stagingPath, CHECKPOINT_MANIFEST_FILE));
      validateCheckpoint(stagingPath, { minimumSchemaVersion, maximumSchemaVersion, allowDirectoryMismatch: true });
      if (onStage) await onStage("publication_candidate_verified", { stagingPath, checkpointId: source.manifest.checkpoint_id });
      renameSync(stagingPath, finalPath);
      stagingPath = null;
    }
    if (onStage) await onStage("publication_candidate_finalized", { finalPath, checkpointId: source.manifest.checkpoint_id });
    const verifiedPublished = validateCheckpoint(finalPath, { minimumSchemaVersion, maximumSchemaVersion });
    const pointer = {
      pointer_format: LATEST_POINTER_FORMAT,
      pointer_format_version: LATEST_POINTER_VERSION,
      checkpoint_id: source.manifest.checkpoint_id,
      manifest_sha256: verifiedPublished.manifest_sha256,
      database_sha256: verifiedPublished.manifest.database.sha256,
      promoted_at: promotedAt,
      previous_checkpoint_id: currentPointer?.checkpoint_id ?? null,
    };
    validateLatestPointer(pointer);
    pointerTemporaryPath = join(repository, `.latest-${randomUUID()}.tmp`);
    writeExclusiveDurably(pointerTemporaryPath, canonicalJson(pointer));
    if (onStage) await onStage("before_latest_pointer_update", { pointer, pointerTemporaryPath });
    renameSync(pointerTemporaryPath, join(repository, LATEST_POINTER_FILE));
    pointerTemporaryPath = null;
    if (onStage) await onStage("latest_pointer_updated", { pointer });
    return {
      checkpoint_id: source.manifest.checkpoint_id,
      published_path: finalPath,
      pointer,
      pointer_sha256: sha256Buffer(Buffer.from(canonicalJson(pointer))),
      idempotent_candidate_reuse: reusedExistingCandidate,
    };
  } catch (error) {
    if (stagingPath) rmSync(stagingPath, { recursive: true, force: true });
    if (pointerTemporaryPath) rmSync(pointerTemporaryPath, { force: true });
    if (error instanceof CheckpointError) throw error;
    throw new CheckpointError("PUBLICATION_FAILED", `Checkpoint publication failed: ${error.message}`, { cause: error.message });
  } finally {
    releaseLock();
  }
}

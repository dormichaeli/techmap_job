import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  CHECKPOINT_MANIFEST_FILE,
  CheckpointError,
  acquireFileLock,
  canonicalJson,
  validateCheckpoint,
} from "./checkpoint.js";
import {
  LATEST_POINTER_FILE,
  LATEST_POINTER_FORMAT,
  LATEST_POINTER_VERSION,
  validateLatestPointer,
} from "./checkpoint-publication.js";

export class RemoteStorageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RemoteStorageError";
    this.code = code;
    this.details = details;
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameCheckpoint(left, right) {
  return left.manifest_sha256 === right.manifest_sha256
    && left.manifest.database.sha256 === right.manifest.database.sha256;
}

export class FileCheckpointStorage {
  constructor(rootPath) {
    this.root = resolve(rootPath);
    this.published = join(this.root, "published");
    this.staged = join(this.root, "staged");
    mkdirSync(this.published, { recursive: true });
    mkdirSync(this.staged, { recursive: true });
  }

  pointerState({ allowInvalid = false } = {}) {
    const path = join(this.root, LATEST_POINTER_FILE);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path);
    try {
      const pointer = validateLatestPointer(JSON.parse(raw.toString("utf8")));
      return { pointer, revision: digest(raw), path, valid: true };
    } catch (error) {
      if (!allowInvalid) throw new RemoteStorageError("LATEST_POINTER_INVALID", error.message);
      return { pointer: null, revision: digest(raw), path, valid: false, error: error.message };
    }
  }

  discoverLatestTrusted() {
    const pointerState = this.pointerState({ allowInvalid: true });
    let pointerFailure = pointerState ? pointerState.error : "latest pointer missing";
    if (pointerState?.valid) {
      try {
        const checkpoint = validateCheckpoint(join(this.published, pointerState.pointer.checkpoint_id));
        if (checkpoint.manifest_sha256 !== pointerState.pointer.manifest_sha256
          || checkpoint.manifest.database.sha256 !== pointerState.pointer.database_sha256) {
          throw new Error("pointer checksums do not match target");
        }
        return { checkpoint, resolution: "latest_pointer", pointer_state: pointerState, recovery_reason: null };
      } catch (error) {
        pointerFailure = error.message;
      }
    }
    const candidates = readdirSync(this.published, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-"))
      .flatMap((entry) => {
        try { return [validateCheckpoint(join(this.published, entry.name))]; } catch { return []; }
      })
      .filter((checkpoint) => checkpoint.manifest.publication.eligible)
      .sort((a, b) => Date.parse(b.manifest.created_at) - Date.parse(a.manifest.created_at)
        || b.manifest.checkpoint_id.localeCompare(a.manifest.checkpoint_id));
    if (!candidates.length) {
      throw new RemoteStorageError("TRUSTED_CHECKPOINT_MISSING", `No trusted checkpoint is available: ${pointerFailure}`);
    }
    return {
      checkpoint: candidates[0],
      resolution: "published_scan_fallback",
      pointer_state: pointerState,
      recovery_reason: pointerFailure,
    };
  }

  downloadLatestTrusted(destinationParent) {
    const discovered = this.discoverLatestTrusted();
    const destination = join(resolve(destinationParent), discovered.checkpoint.manifest.checkpoint_id);
    if (existsSync(destination)) throw new RemoteStorageError("DOWNLOAD_DESTINATION_EXISTS", `Download destination exists: ${destination}`);
    mkdirSync(resolve(destinationParent), { recursive: true });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      cpSync(discovered.checkpoint.checkpoint_directory, temporary, { recursive: true, errorOnExist: true });
      validateCheckpoint(temporary, { allowDirectoryMismatch: true });
      renameSync(temporary, destination);
      const checkpoint = validateCheckpoint(destination);
      if (!sameCheckpoint(discovered.checkpoint, checkpoint)) throw new RemoteStorageError("DOWNLOAD_CHECKSUM_MISMATCH", "Downloaded checkpoint differs from trusted source");
      return { ...discovered, checkpoint, downloaded_to: destination };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  stageCheckpoint(checkpointPath, { onStage = null } = {}) {
    const source = validateCheckpoint(checkpointPath);
    if (!source.manifest.publication.eligible) {
      throw new RemoteStorageError("CHECKPOINT_NOT_PUBLISHABLE", source.manifest.publication.ineligible_reason);
    }
    const release = acquireFileLock(join(this.root, ".remote-storage.lock"), { operation: "stage" });
    const final = join(this.staged, source.manifest.checkpoint_id);
    const temporary = join(this.staged, `.tmp-${source.manifest.checkpoint_id}-${randomUUID()}`);
    try {
      if (existsSync(final)) {
        const existing = validateCheckpoint(final);
        if (!sameCheckpoint(source, existing)) throw new RemoteStorageError("STAGED_CHECKPOINT_CONFLICT", "Checkpoint ID already staged with different content");
        return { checkpoint: existing, staged_path: final, idempotent: true };
      }
      cpSync(source.checkpoint_directory, temporary, { recursive: true, errorOnExist: true });
      const staged = validateCheckpoint(temporary, { allowDirectoryMismatch: true });
      if (!sameCheckpoint(source, staged)) throw new RemoteStorageError("UPLOAD_CHECKSUM_MISMATCH", "Staged checkpoint differs from source");
      if (onStage) onStage("staged_verified", { checkpoint_id: source.manifest.checkpoint_id, staged_path: temporary });
      renameSync(temporary, final);
      return { checkpoint: validateCheckpoint(final), staged_path: final, idempotent: false };
    } catch (error) {
      if (error instanceof RemoteStorageError || error instanceof CheckpointError) throw error;
      throw new RemoteStorageError("STAGE_FAILED", error.message);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      release();
    }
  }

  publishStaged(stage, { onStage = null } = {}) {
    const checkpointId = typeof stage === "string" ? stage : stage.checkpoint.manifest.checkpoint_id;
    const release = acquireFileLock(join(this.root, ".remote-storage.lock"), { operation: "publish" });
    const stagedPath = join(this.staged, checkpointId);
    const publishedPath = join(this.published, checkpointId);
    try {
      if (existsSync(publishedPath)) {
        const existing = validateCheckpoint(publishedPath);
        if (existsSync(stagedPath) && !sameCheckpoint(existing, validateCheckpoint(stagedPath))) {
          throw new RemoteStorageError("PUBLISHED_CHECKPOINT_CONFLICT", "Published checkpoint ID has different content");
        }
        return { checkpoint: existing, published_path: publishedPath, idempotent: true };
      }
      if (!existsSync(stagedPath)) throw new RemoteStorageError("STAGED_CHECKPOINT_MISSING", `Staged checkpoint ${checkpointId} is missing`);
      const staged = validateCheckpoint(stagedPath);
      if (onStage) onStage("before_immutable_publish", { checkpoint_id: checkpointId });
      renameSync(stagedPath, publishedPath);
      const published = validateCheckpoint(publishedPath);
      if (!sameCheckpoint(staged, published)) throw new RemoteStorageError("PUBLISHED_CHECKSUM_MISMATCH", "Published checkpoint changed during finalization");
      return { checkpoint: published, published_path: publishedPath, idempotent: false };
    } finally {
      release();
    }
  }

  promoteLatest(published, {
    expectedRevision = null,
    promotedAt = new Date().toISOString(),
    onStage = null,
  } = {}) {
    const checkpointId = typeof published === "string" ? published : published.checkpoint.manifest.checkpoint_id;
    const release = acquireFileLock(join(this.root, ".remote-storage.lock"), { operation: "promote" });
    const temporary = join(this.root, `.latest-${randomUUID()}.tmp`);
    try {
      const current = this.pointerState({ allowInvalid: true });
      const published = validateCheckpoint(join(this.published, checkpointId));
      if (current?.valid && current.pointer.checkpoint_id === checkpointId
        && current.pointer.manifest_sha256 === published.manifest_sha256
        && current.pointer.database_sha256 === published.manifest.database.sha256) {
        return { pointer: current.pointer, revision: current.revision, idempotent: true };
      }
      const actualRevision = current?.revision ?? null;
      if (actualRevision !== expectedRevision) {
        throw new RemoteStorageError("CONCURRENT_PUBLICATION", "Latest pointer changed since discovery", { expected_revision: expectedRevision, actual_revision: actualRevision });
      }
      const pointer = validateLatestPointer({
        pointer_format: LATEST_POINTER_FORMAT,
        pointer_format_version: LATEST_POINTER_VERSION,
        checkpoint_id: checkpointId,
        manifest_sha256: published.manifest_sha256,
        database_sha256: published.manifest.database.sha256,
        promoted_at: promotedAt,
        previous_checkpoint_id: current?.pointer?.checkpoint_id ?? null,
      });
      writeFileSync(temporary, canonicalJson(pointer), { flag: "wx" });
      if (onStage) onStage("before_pointer_promotion", { checkpoint_id: checkpointId });
      renameSync(temporary, join(this.root, LATEST_POINTER_FILE));
      const updated = this.pointerState();
      return { pointer: updated.pointer, revision: updated.revision, idempotent: false };
    } catch (error) {
      if (error instanceof RemoteStorageError || error instanceof CheckpointError) throw error;
      throw new RemoteStorageError("PROMOTION_FAILED", error.message);
    } finally {
      rmSync(temporary, { force: true });
      release();
    }
  }

  seedTrustedCheckpoint(checkpointPath, promotedAt = new Date().toISOString()) {
    if (this.pointerState({ allowInvalid: true })) throw new RemoteStorageError("BOOTSTRAP_NOT_EMPTY", "Storage already has a latest pointer");
    const staged = this.stageCheckpoint(checkpointPath);
    const published = this.publishStaged(staged);
    const promotion = this.promoteLatest(published, { expectedRevision: null, promotedAt });
    return { staged, published, promotion };
  }
}

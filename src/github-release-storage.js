import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CHECKPOINT_DATABASE_FILE,
  CHECKPOINT_MANIFEST_FILE,
  canonicalJson,
  validateCheckpoint,
} from "./checkpoint.js";
import {
  LATEST_POINTER_FORMAT,
  LATEST_POINTER_VERSION,
  validateLatestPointer,
} from "./checkpoint-publication.js";
import { RemoteStorageError } from "./remote-checkpoint.js";

const API_VERSION = "2026-03-10";

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function tagFor(checkpointId) {
  return `techmap-checkpoint-${checkpointId}`;
}

export class GitHubReleaseCheckpointStorage {
  constructor({
    owner,
    repository,
    token,
    branch = "main",
    pointerPath = ".techmap-job/latest-checkpoint.json",
    fetchImpl = globalThis.fetch,
    apiBase = "https://api.github.com",
  }) {
    if (!owner || !repository) throw new RemoteStorageError("STORAGE_CONFIGURATION_INVALID", "GitHub owner and repository are required");
    if (!token) throw new RemoteStorageError("CREDENTIALS_MISSING", "GitHub checkpoint token is missing");
    this.owner = owner;
    this.repository = repository;
    this.token = token;
    this.branch = branch;
    this.pointerPath = pointerPath;
    this.fetch = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, "");
  }

  endpoint(path) {
    return `${this.apiBase}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}${path}`;
  }

  async request(url, { method = "GET", headers = {}, body, raw = false, allow404 = false } = {}) {
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          accept: raw ? "application/octet-stream" : "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": API_VERSION,
          "user-agent": "techmap-job-checkpoint/0.1",
          ...headers,
        },
        body: body === undefined || raw ? body : JSON.stringify(body),
      });
    } catch (error) {
      throw new RemoteStorageError("REMOTE_REQUEST_FAILED", `GitHub request failed: ${error.message}`);
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const remaining = response.headers?.get?.("x-ratelimit-remaining");
      const reset = response.headers?.get?.("x-ratelimit-reset");
      const code = response.status === 401 ? "AUTHENTICATION_FAILED"
        : response.status === 403 && remaining === "0" ? "RATE_LIMITED"
          : response.status === 403 ? "PERMISSION_DENIED"
            : response.status === 404 ? "REMOTE_NOT_FOUND"
              : response.status === 409 ? "CONCURRENT_PUBLICATION"
                : response.status === 413 || response.status === 422 ? "STORAGE_QUOTA_OR_VALIDATION"
                  : response.status === 429 ? "RATE_LIMITED" : "REMOTE_REQUEST_FAILED";
      throw new RemoteStorageError(code, `GitHub API ${method} ${new URL(url).pathname} returned ${response.status}`, {
        status: response.status,
        rate_limit_remaining: remaining,
        rate_limit_reset: reset,
      });
    }
    return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  async pointerState() {
    const item = await this.request(this.endpoint(`/contents/${encodePath(this.pointerPath)}?ref=${encodeURIComponent(this.branch)}`), { allow404: true });
    if (!item) return null;
    let pointer;
    try {
      pointer = validateLatestPointer(JSON.parse(Buffer.from(item.content, "base64").toString("utf8")));
    } catch (error) {
      throw new RemoteStorageError("LATEST_POINTER_INVALID", error.message, { revision: item.sha });
    }
    return { pointer, revision: item.sha };
  }

  async assertBootstrapSafe(checkpointId) {
    if (!/^[A-Za-z0-9._-]+$/.test(checkpointId ?? "")) {
      throw new RemoteStorageError("REMOTE_CHECKPOINT_ID_INVALID", "Bootstrap checkpoint ID is invalid");
    }
    const pointer = await this.pointerState();
    if (pointer) {
      throw new RemoteStorageError(
        "BOOTSTRAP_NOT_EMPTY",
        `Checkpoint storage already points to ${pointer.pointer.checkpoint_id}`,
      );
    }
    const releases = await this.request(this.endpoint("/releases?per_page=100"));
    if (releases.length === 0) return { empty: true, resumable: false };
    if (releases.length === 1 && releases[0].tag_name === tagFor(checkpointId)) {
      return { empty: false, resumable: true, release_id: releases[0].id };
    }
    if (releases.length) {
      throw new RemoteStorageError(
        "BOOTSTRAP_NOT_EMPTY",
        "Checkpoint repository contains a different or ambiguous Release; refusing to create a second authority",
      );
    }
    return { empty: true, resumable: false };
  }

  async releaseForCheckpoint(checkpointId, { allowMissing = false } = {}) {
    return this.request(this.endpoint(`/releases/tags/${encodeURIComponent(tagFor(checkpointId))}`), { allow404: allowMissing });
  }

  async downloadRelease(release, destinationParent) {
    const checkpointId = release.tag_name.replace(/^techmap-checkpoint-/, "");
    if (!/^[A-Za-z0-9._-]+$/.test(checkpointId)) {
      throw new RemoteStorageError("REMOTE_CHECKPOINT_ID_INVALID", `Release tag has an invalid checkpoint ID: ${release.tag_name}`);
    }
    const destination = join(resolve(destinationParent), checkpointId);
    if (existsSync(destination)) throw new RemoteStorageError("DOWNLOAD_DESTINATION_EXISTS", `Download destination exists: ${destination}`);
    const assets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
    for (const filename of [CHECKPOINT_DATABASE_FILE, CHECKPOINT_MANIFEST_FILE]) {
      if (!assets.has(filename)) throw new RemoteStorageError("REMOTE_ASSET_MISSING", `Release ${release.tag_name} is missing ${filename}`);
    }
    const temporary = `${destination}.tmp-${randomUUID()}`;
    mkdirSync(temporary, { recursive: true });
    try {
      for (const filename of [CHECKPOINT_DATABASE_FILE, CHECKPOINT_MANIFEST_FILE]) {
        const bytes = await this.request(assets.get(filename).url, { raw: true });
        writeFileSync(join(temporary, filename), bytes, { flag: "wx" });
      }
      validateCheckpoint(temporary, { allowDirectoryMismatch: true });
      renameSync(temporary, destination);
      return validateCheckpoint(destination);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async downloadLatestTrusted(destinationParent) {
    let pointerState = null;
    let pointerFailure = "latest pointer missing";
    try {
      pointerState = await this.pointerState();
      if (pointerState) {
        const release = await this.releaseForCheckpoint(pointerState.pointer.checkpoint_id);
        if (release.draft) throw new RemoteStorageError("LATEST_TARGET_UNPUBLISHED", "Latest pointer targets a draft Release");
        const checkpoint = await this.downloadRelease(release, destinationParent);
        if (checkpoint.manifest_sha256 !== pointerState.pointer.manifest_sha256
          || checkpoint.manifest.database.sha256 !== pointerState.pointer.database_sha256) {
          throw new RemoteStorageError("LATEST_POINTER_MISMATCH", "Latest pointer checksums do not match Release assets");
        }
        return { checkpoint, pointer_state: pointerState, resolution: "latest_pointer", recovery_reason: null };
      }
    } catch (error) {
      pointerFailure = `${error.code ?? "ERROR"}:${error.message}`;
    }
    const releases = await this.request(this.endpoint("/releases?per_page=20"));
    for (const release of releases) {
      if (release.draft || !release.tag_name?.startsWith("techmap-checkpoint-")) continue;
      try {
        const checkpoint = await this.downloadRelease(release, destinationParent);
        if (!checkpoint.manifest.publication.eligible) continue;
        return { checkpoint, pointer_state: pointerState, resolution: "release_scan_fallback", recovery_reason: pointerFailure };
      } catch {
        // Continue to the previous immutable Release.
      }
    }
    throw new RemoteStorageError("TRUSTED_CHECKPOINT_MISSING", `No valid GitHub Release checkpoint found after ${pointerFailure}`);
  }

  async uploadAsset(uploadUrl, name, bytes, contentType) {
    const base = uploadUrl.replace(/\{.*$/, "");
    return this.request(`${base}?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes,
      raw: true,
    });
  }

  async stageCheckpoint(checkpointPath) {
    const checkpoint = validateCheckpoint(checkpointPath);
    if (!checkpoint.manifest.publication.eligible) throw new RemoteStorageError("CHECKPOINT_NOT_PUBLISHABLE", checkpoint.manifest.publication.ineligible_reason);
    const checkpointId = checkpoint.manifest.checkpoint_id;
    let release = await this.releaseForCheckpoint(checkpointId, { allowMissing: true });
    if (!release) {
      release = await this.request(this.endpoint("/releases"), {
        method: "POST",
        body: {
          tag_name: tagFor(checkpointId),
          target_commitish: this.branch,
          name: `Techmap checkpoint ${checkpointId}`,
          body: "Private operational checkpoint. Validate assets before promotion.",
          draft: true,
          prerelease: true,
        },
      });
    }
    if (release.draft) {
      const existingAssets = new Set((release.assets ?? []).map((asset) => asset.name));
      if (!existingAssets.has(CHECKPOINT_DATABASE_FILE)) {
        await this.uploadAsset(release.upload_url, CHECKPOINT_DATABASE_FILE, readFileSync(checkpoint.database_path), "application/vnd.sqlite3");
      }
      if (!existingAssets.has(CHECKPOINT_MANIFEST_FILE)) {
        await this.uploadAsset(release.upload_url, CHECKPOINT_MANIFEST_FILE, readFileSync(checkpoint.manifest_path), "application/json");
      }
      release = await this.request(this.endpoint(`/releases/${release.id}`));
    }
    const verificationRoot = join(resolve(checkpoint.checkpoint_directory, "..", ".."), `.github-stage-verify-${randomUUID()}`);
    try {
      const downloaded = await this.downloadRelease(release, verificationRoot);
      if (downloaded.manifest_sha256 !== checkpoint.manifest_sha256
        || downloaded.manifest.database.sha256 !== checkpoint.manifest.database.sha256) {
        throw new RemoteStorageError("UPLOAD_CHECKSUM_MISMATCH", "Downloaded GitHub Release assets differ from local checkpoint");
      }
      return { release, checkpoint: downloaded, idempotent: !release.draft };
    } finally {
      rmSync(verificationRoot, { recursive: true, force: true });
    }
  }

  async publishStaged(stage) {
    if (!stage.release.draft) return { ...stage, idempotent: true };
    const release = await this.request(this.endpoint(`/releases/${stage.release.id}`), {
      method: "PATCH",
      body: { draft: false, prerelease: false, make_latest: "false" },
    });
    return { ...stage, release, idempotent: false };
  }

  async promoteLatest(published, { expectedRevision = null, promotedAt = new Date().toISOString() } = {}) {
    const checkpoint = published.checkpoint;
    const current = await this.pointerState();
    if (current?.pointer.checkpoint_id === checkpoint.manifest.checkpoint_id
      && current.pointer.manifest_sha256 === checkpoint.manifest_sha256
      && current.pointer.database_sha256 === checkpoint.manifest.database.sha256) {
      return { pointer: current.pointer, revision: current.revision, idempotent: true };
    }
    if ((current?.revision ?? null) !== expectedRevision) {
      throw new RemoteStorageError("CONCURRENT_PUBLICATION", "GitHub latest pointer changed since discovery", {
        expected_revision: expectedRevision, actual_revision: current?.revision ?? null,
      });
    }
    const pointer = validateLatestPointer({
      pointer_format: LATEST_POINTER_FORMAT,
      pointer_format_version: LATEST_POINTER_VERSION,
      checkpoint_id: checkpoint.manifest.checkpoint_id,
      manifest_sha256: checkpoint.manifest_sha256,
      database_sha256: checkpoint.manifest.database.sha256,
      promoted_at: promotedAt,
      previous_checkpoint_id: current?.pointer.checkpoint_id ?? null,
    });
    const body = {
      message: `Promote trusted checkpoint ${checkpoint.manifest.checkpoint_id}`,
      content: Buffer.from(canonicalJson(pointer)).toString("base64"),
      branch: this.branch,
    };
    if (current) body.sha = current.revision;
    const result = await this.request(this.endpoint(`/contents/${encodePath(this.pointerPath)}`), { method: "PUT", body });
    return { pointer, revision: result.content.sha, idempotent: false };
  }
}

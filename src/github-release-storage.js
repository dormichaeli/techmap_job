import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
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
const DEFAULT_UPLOAD_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_UPLOAD_IDLE_TIMEOUT_MS = 60_000;
const MAX_UPLOAD_RESPONSE_BYTES = 1024 * 1024;

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function tagFor(checkpointId) {
  return `techmap-checkpoint-${checkpointId}`;
}

function requestDetails(url, method, response = null, error = null) {
  const target = new URL(url);
  const cause = error?.cause ?? error;
  return {
    method,
    hostname: target.hostname,
    path: target.pathname,
    status: response?.status ?? response?.statusCode ?? null,
    github_request_id: response?.headers?.get?.("x-github-request-id")
      ?? response?.headers?.["x-github-request-id"]
      ?? null,
    transport_error_name: error?.name ?? null,
    cause_code: cause?.code ?? null,
    cause_errno: cause?.errno ?? null,
    cause_syscall: cause?.syscall ?? null,
  };
}

function httpErrorCode(status, remaining, { upload = false } = {}) {
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403 && remaining === "0") return "RATE_LIMITED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "REMOTE_NOT_FOUND";
  if (status === 409) return "CONCURRENT_PUBLICATION";
  if (status === 413 || status === 422) return "STORAGE_QUOTA_OR_VALIDATION";
  if (status === 429) return "RATE_LIMITED";
  if (upload && status === 502) return "UPLOAD_HTTP_BAD_GATEWAY";
  return "REMOTE_REQUEST_FAILED";
}

function uploadTimeout(url, phase) {
  return new RemoteStorageError(
    "UPLOAD_TIMEOUT",
    `GitHub Release asset upload timed out during ${phase}`,
    { ...requestDetails(url, "POST"), timeout_phase: phase },
  );
}

function uploadTransportError(url, error) {
  return new RemoteStorageError(
    "UPLOAD_TRANSPORT_FAILED",
    "GitHub Release asset upload transport failed",
    requestDetails(url, "POST", null, error),
  );
}

export function streamReleaseAssetUpload({
  url,
  filePath,
  token,
  contentType,
  requestImpl = httpsRequest,
  createReadStreamImpl = createReadStream,
  connectionTimeoutMs = DEFAULT_UPLOAD_CONNECTION_TIMEOUT_MS,
  responseTimeoutMs = DEFAULT_UPLOAD_RESPONSE_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_UPLOAD_IDLE_TIMEOUT_MS,
  allowInsecureHttp = false,
}) {
  const target = new URL(url);
  if (target.protocol !== "https:" && !(allowInsecureHttp && target.protocol === "http:")) {
    throw new RemoteStorageError("UPLOAD_URL_INVALID", "Release asset upload URL must use HTTPS");
  }
  const size = statSync(filePath).size;
  return new Promise((resolve, reject) => {
    let source = null;
    let request = null;
    let response = null;
    let connectionTimer = null;
    let responseTimer = null;
    let settled = false;

    const clearTimers = () => {
      clearTimeout(connectionTimer);
      clearTimeout(responseTimer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      source?.unpipe?.(request);
      source?.destroy?.();
      response?.destroy?.();
      request?.destroy?.();
      reject(error);
    };
    const succeed = (asset) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(asset);
    };

    try {
      request = requestImpl(target, {
        method: "POST",
        agent: false,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": contentType,
          "content-length": String(size),
          "x-github-api-version": API_VERSION,
          "user-agent": "techmap-job-checkpoint/0.1",
        },
      }, (incoming) => {
        response = incoming;
        clearTimeout(responseTimer);
        const chunks = [];
        let responseBytes = 0;
        incoming.on("data", (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > MAX_UPLOAD_RESPONSE_BYTES) {
            fail(new RemoteStorageError(
              "UPLOAD_RESPONSE_INVALID",
              "GitHub Release asset upload response exceeded the safe size limit",
              requestDetails(url, "POST", incoming),
            ));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("error", (error) => fail(uploadTransportError(url, error)));
        incoming.once("end", () => {
          if (settled) return;
          const status = incoming.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const remaining = incoming.headers["x-ratelimit-remaining"] ?? null;
            fail(new RemoteStorageError(
              httpErrorCode(status, remaining, { upload: true }),
              `GitHub Release asset upload returned ${status}`,
              requestDetails(url, "POST", incoming),
            ));
            return;
          }
          let asset;
          try {
            asset = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            fail(new RemoteStorageError(
              "UPLOAD_RESPONSE_INVALID",
              "GitHub Release asset upload returned invalid JSON",
              requestDetails(url, "POST", incoming),
            ));
            return;
          }
          succeed(asset);
        });
      });
    } catch (error) {
      fail(uploadTransportError(url, error));
      return;
    }

    connectionTimer = setTimeout(() => fail(uploadTimeout(url, "connection")), connectionTimeoutMs);
    request.once("socket", (socket) => {
      const connected = () => clearTimeout(connectionTimer);
      if (!socket.connecting) connected();
      else socket.once(target.protocol === "https:" ? "secureConnect" : "connect", connected);
    });
    request.setTimeout(idleTimeoutMs, () => fail(uploadTimeout(url, "idle")));
    request.once("finish", () => {
      clearTimeout(connectionTimer);
      if (!response) responseTimer = setTimeout(() => fail(uploadTimeout(url, "response")), responseTimeoutMs);
    });
    request.once("error", (error) => fail(uploadTransportError(url, error)));

    try {
      source = createReadStreamImpl(filePath);
      source.once("error", (error) => fail(uploadTransportError(url, error)));
      source.pipe(request);
    } catch (error) {
      fail(uploadTransportError(url, error));
    }
  });
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
    streamUploadImpl = streamReleaseAssetUpload,
    uploadRequestImpl = httpsRequest,
    uploadConnectionTimeoutMs = DEFAULT_UPLOAD_CONNECTION_TIMEOUT_MS,
    uploadResponseTimeoutMs = DEFAULT_UPLOAD_RESPONSE_TIMEOUT_MS,
    uploadIdleTimeoutMs = DEFAULT_UPLOAD_IDLE_TIMEOUT_MS,
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
    this.streamUpload = streamUploadImpl;
    this.uploadRequest = uploadRequestImpl;
    this.uploadConnectionTimeoutMs = uploadConnectionTimeoutMs;
    this.uploadResponseTimeoutMs = uploadResponseTimeoutMs;
    this.uploadIdleTimeoutMs = uploadIdleTimeoutMs;
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
      throw new RemoteStorageError(
        "REMOTE_REQUEST_FAILED",
        "GitHub request transport failed",
        requestDetails(url, method, null, error),
      );
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      const remaining = response.headers?.get?.("x-ratelimit-remaining");
      const reset = response.headers?.get?.("x-ratelimit-reset");
      const code = httpErrorCode(response.status, remaining);
      throw new RemoteStorageError(code, `GitHub API ${method} ${new URL(url).pathname} returned ${response.status}`, {
        ...requestDetails(url, method, response),
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

  uploadOutcomeUnknown(name, failure, assetState, extra = {}) {
    return new RemoteStorageError(
      "UPLOAD_OUTCOME_UNKNOWN",
      `GitHub Release asset upload outcome is unresolved for ${name}`,
      {
        failure_code: failure.code ?? "UNKNOWN",
        failure_details: failure.details ?? {},
        asset_state: assetState,
        ...extra,
      },
    );
  }

  async verifyRemoteAsset(asset, { name, size, sha256 }, failure = null) {
    if (asset.state !== "uploaded") {
      throw this.uploadOutcomeUnknown(name, failure ?? new RemoteStorageError("EXISTING_ASSET_UNVERIFIED", "Existing asset is not complete"), asset.state ?? "unknown", {
        asset_id: asset.id ?? null,
        observed_size: asset.size ?? null,
      });
    }
    if (asset.size !== size) {
      throw this.uploadOutcomeUnknown(name, failure ?? new RemoteStorageError("EXISTING_ASSET_UNVERIFIED", "Existing asset size differs"), "partial", {
        asset_id: asset.id ?? null,
        expected_size: size,
        observed_size: asset.size ?? null,
      });
    }
    const expectedDigest = `sha256:${sha256}`;
    if (asset.digest !== expectedDigest) {
      throw new RemoteStorageError("UPLOAD_CHECKSUM_MISMATCH", `GitHub Release asset digest differs for ${name}`, {
        asset_id: asset.id ?? null,
        expected_digest: expectedDigest,
        observed_digest: asset.digest ?? null,
        failure_code: failure?.code ?? null,
      });
    }
    let bytes;
    try {
      bytes = await this.request(asset.url, { raw: true });
    } catch (error) {
      throw this.uploadOutcomeUnknown(name, failure ?? error, "verification_failed", {
        asset_id: asset.id ?? null,
        verification_error_code: error.code ?? "UNKNOWN",
      });
    }
    const downloadedSha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== size || downloadedSha256 !== sha256) {
      throw new RemoteStorageError("UPLOAD_CHECKSUM_MISMATCH", `Downloaded GitHub Release asset differs for ${name}`, {
        asset_id: asset.id ?? null,
        expected_size: size,
        observed_size: bytes.length,
        expected_sha256: sha256,
        observed_sha256: downloadedSha256,
        failure_code: failure?.code ?? null,
      });
    }
    return { asset, reconciled: Boolean(failure), independently_verified: true };
  }

  async reconcileUploadFailure(release, expected, failure) {
    let assets;
    try {
      assets = await this.request(this.endpoint(`/releases/${release.id}/assets?per_page=100`));
    } catch (error) {
      throw this.uploadOutcomeUnknown(expected.name, failure, "reconciliation_failed", {
        reconciliation_error_code: error.code ?? "UNKNOWN",
      });
    }
    const matches = assets.filter((asset) => asset.name === expected.name);
    if (matches.length === 0) throw this.uploadOutcomeUnknown(expected.name, failure, "absent");
    if (matches.length !== 1) {
      throw this.uploadOutcomeUnknown(expected.name, failure, "ambiguous", { matching_assets: matches.length });
    }
    return this.verifyRemoteAsset(matches[0], expected, failure);
  }

  async uploadAsset(release, { name, path, contentType, size, sha256 }) {
    const base = release.upload_url.replace(/\{.*$/, "");
    const url = `${base}?name=${encodeURIComponent(name)}`;
    try {
      const asset = await this.streamUpload({
        url,
        filePath: path,
        token: this.token,
        contentType,
        requestImpl: this.uploadRequest,
        connectionTimeoutMs: this.uploadConnectionTimeoutMs,
        responseTimeoutMs: this.uploadResponseTimeoutMs,
        idleTimeoutMs: this.uploadIdleTimeoutMs,
      });
      return { asset, reconciled: false, independently_verified: false };
    } catch (error) {
      if (error.code === "AUTHENTICATION_FAILED" || error.code === "PERMISSION_DENIED" || error.code === "RATE_LIMITED") throw error;
      return this.reconcileUploadFailure(release, { name, size, sha256 }, error);
    }
  }

  async ensureDraftAsset(release, expected) {
    const matches = (release.assets ?? []).filter((asset) => asset.name === expected.name);
    if (matches.length > 1) {
      throw this.uploadOutcomeUnknown(expected.name, new RemoteStorageError("EXISTING_ASSET_AMBIGUOUS", "Multiple existing assets share the expected name"), "ambiguous", {
        matching_assets: matches.length,
      });
    }
    if (matches.length === 1) return this.verifyRemoteAsset(matches[0], expected);
    return this.uploadAsset(release, expected);
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
      await this.ensureDraftAsset(release, {
        name: CHECKPOINT_DATABASE_FILE,
        path: checkpoint.database_path,
        contentType: "application/vnd.sqlite3",
        size: checkpoint.manifest.database.bytes,
        sha256: checkpoint.manifest.database.sha256,
      });
      await this.ensureDraftAsset(release, {
        name: CHECKPOINT_MANIFEST_FILE,
        path: checkpoint.manifest_path,
        contentType: "application/json",
        size: statSync(checkpoint.manifest_path).size,
        sha256: checkpoint.manifest_sha256,
      });
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

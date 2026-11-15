import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createCheckpoint } from "../src/checkpoint.js";
import { runCheckpointAutomation } from "../src/automation.js";
import {
  GitHubReleaseCheckpointStorage,
  streamReleaseAssetUpload,
} from "../src/github-release-storage.js";
import { RemoteStorageError } from "../src/remote-checkpoint.js";
import { beginRun, finishRun, openStore } from "../src/store.js";

const NODE = { nodeVersion: "26.13.1", sqliteVersion: "3.54.1" };

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "techmap-release-upload-"));
}

function sparseFile(directory, name, size) {
  const path = join(directory, name);
  const descriptor = openSync(path, "wx");
  try {
    ftruncateSync(descriptor, size);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

async function listen(handler, onConnection = null) {
  const server = createServer(handler);
  if (onConnection) server.on("connection", onConnection);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function localUpload(server, filePath, overrides = {}) {
  const { port } = server.address();
  return streamReleaseAssetUpload({
    url: `http://127.0.0.1:${port}/repos/o/r/releases/1/assets?name=database.sqlite&secret=query-value`,
    filePath,
    token: "super-secret-token",
    contentType: "application/vnd.sqlite3",
    requestImpl: httpRequest,
    allowInsecureHttp: true,
    connectionTimeoutMs: 1_000,
    responseTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    ...overrides,
  });
}

function response(status, body, headers = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized.get(name.toLowerCase()) ?? null },
    async json() { return JSON.parse(bytes.toString("utf8")); },
    async arrayBuffer() { return bytes; },
  };
}

function uploadFailure(code = "UPLOAD_TRANSPORT_FAILED") {
  return new RemoteStorageError(code, "sanitized failure", {
    method: "POST",
    hostname: "uploads.github.com",
    path: "/repos/o/r/releases/1/assets",
    cause_code: "ECONNRESET",
  });
}

function storageForReconciliation({ assets, bytes, failure = uploadFailure(), onFetch = null }) {
  return new GitHubReleaseCheckpointStorage({
    owner: "o",
    repository: "r",
    token: "fixture-token",
    streamUploadImpl: async () => { throw failure; },
    fetchImpl: async (url) => {
      onFetch?.(url);
      if (url.includes("/assets?per_page=100")) return response(200, assets);
      if (url.includes("/releases/assets/")) return response(200, bytes);
      throw new Error(`Unexpected fixture URL: ${new URL(url).pathname}`);
    },
  });
}

test("streaming upload sends a raw file with explicit length on a fresh connection", async () => {
  const directory = temporaryDirectory();
  const payload = Buffer.from("streamed checkpoint payload");
  const path = join(directory, "payload.bin");
  writeFileSync(path, payload);
  let observed;
  const server = await listen((request, reply) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const received = Buffer.concat(chunks);
      observed = {
        body: received,
        contentLength: request.headers["content-length"],
        connection: request.headers.connection,
      };
      reply.writeHead(201, { "content-type": "application/json", "x-github-request-id": "fixture-request" });
      reply.end(JSON.stringify({ id: 1, name: "database.sqlite", state: "uploaded", size: received.length }));
    });
  });
  try {
    const asset = await localUpload(server, path);
    assert.equal(asset.id, 1);
    assert.deepEqual(observed.body, payload);
    assert.equal(observed.contentLength, String(payload.length));
    assert.equal(observed.connection, "close");
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming upload transfers a full-size 97 MB sparse fixture without buffering it as a request body", async () => {
  const directory = temporaryDirectory();
  const expected = 97_447_936;
  const path = sparseFile(directory, "database.sqlite", expected);
  let received = 0;
  const hash = createHash("sha256");
  const server = await listen((request, reply) => {
    request.on("data", (chunk) => {
      received += chunk.length;
      hash.update(chunk);
    });
    request.on("end", () => {
      reply.writeHead(201, { "content-type": "application/json" });
      reply.end(JSON.stringify({
        id: 2,
        name: "database.sqlite",
        state: "uploaded",
        size: received,
        digest: `sha256:${hash.digest("hex")}`,
      }));
    });
  });
  const started = Date.now();
  try {
    const asset = await localUpload(server, path, { idleTimeoutMs: 10_000, responseTimeoutMs: 10_000 });
    assert.equal(asset.size, expected);
    assert.equal(received, expected);
    assert.ok(Date.now() - started < 30_000);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("connection resets before and during upload are transport failures with sanitized diagnostics", async (t) => {
  await t.test("before upload", async () => {
    const directory = temporaryDirectory();
    const path = sparseFile(directory, "payload.bin", 1024 * 1024);
    const server = await listen(() => {}, (socket) => socket.destroy());
    try {
      await assert.rejects(() => localUpload(server, path), (error) => {
        assert.equal(error.code, "UPLOAD_TRANSPORT_FAILED");
        assert.equal(error.details.method, "POST");
        assert.equal(error.details.path, "/repos/o/r/releases/1/assets");
        assert.equal(error.details.path.includes("?"), false);
        assert.equal(JSON.stringify(error).includes("super-secret-token"), false);
        assert.equal(JSON.stringify(error).includes("query-value"), false);
        return true;
      });
    } finally {
      await close(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("during upload", async () => {
    const directory = temporaryDirectory();
    const path = sparseFile(directory, "payload.bin", 8 * 1024 * 1024);
    const server = await listen((request) => request.once("data", () => request.socket.destroy()));
    try {
      await assert.rejects(() => localUpload(server, path), (error) => error.code === "UPLOAD_TRANSPORT_FAILED");
      rmSync(path);
    } finally {
      await close(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("upload HTTP failures preserve 502, authentication, and permission distinctions", async (t) => {
  for (const [status, code] of [[502, "UPLOAD_HTTP_BAD_GATEWAY"], [401, "AUTHENTICATION_FAILED"], [403, "PERMISSION_DENIED"]]) {
    await t.test(String(status), async () => {
      const directory = temporaryDirectory();
      const path = sparseFile(directory, "payload.bin", 1024);
      const server = await listen((request, reply) => {
        request.resume();
        reply.writeHead(status, { "content-type": "application/json", "x-github-request-id": `request-${status}` });
        reply.end(JSON.stringify({ message: "controlled" }));
      });
      try {
        await assert.rejects(() => localUpload(server, path), (error) => {
          assert.equal(error.code, code);
          assert.equal(error.details.status, status);
          assert.equal(error.details.github_request_id, `request-${status}`);
          return true;
        });
      } finally {
        await close(server);
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("upload response timeout cancels the stream and releases the file", async () => {
  const directory = temporaryDirectory();
  const path = sparseFile(directory, "payload.bin", 4096);
  const server = await listen((request) => request.resume());
  try {
    await assert.rejects(() => localUpload(server, path, { responseTimeoutMs: 30 }), (error) => {
      assert.equal(error.code, "UPLOAD_TIMEOUT");
      assert.equal(error.details.timeout_phase, "response");
      return true;
    });
    rmSync(path);
  } finally {
    await close(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("connection timeout is bounded independently from the response timeout", async () => {
  const directory = temporaryDirectory();
  const path = sparseFile(directory, "payload.bin", 4096);
  const stalledRequest = new Writable({ write() {} });
  stalledRequest.setTimeout = () => stalledRequest;
  try {
    await assert.rejects(() => streamReleaseAssetUpload({
      url: "https://uploads.github.com/repos/o/r/releases/1/assets?name=database.sqlite",
      filePath: path,
      token: "fixture-token",
      contentType: "application/vnd.sqlite3",
      requestImpl: () => stalledRequest,
      connectionTimeoutMs: 30,
      responseTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    }), (error) => {
      assert.equal(error.code, "UPLOAD_TIMEOUT");
      assert.equal(error.details.timeout_phase, "connection");
      return true;
    });
    rmSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transport diagnostics retain sanitized cause metadata without retaining credentials", async () => {
  const directory = temporaryDirectory();
  const path = sparseFile(directory, "payload.bin", 1);
  const cause = Object.assign(new Error("controlled reset"), {
    code: "ECONNRESET",
    errno: -54,
    syscall: "write",
  });
  const failure = new TypeError("fetch failed", { cause });
  try {
    await assert.rejects(() => streamReleaseAssetUpload({
      url: "https://uploads.github.com/repos/o/r/releases/1/assets?name=secret-name",
      filePath: path,
      token: "never-log-this-token",
      contentType: "application/vnd.sqlite3",
      requestImpl: () => { throw failure; },
    }), (error) => {
      assert.equal(error.code, "UPLOAD_TRANSPORT_FAILED");
      assert.equal(error.details.transport_error_name, "TypeError");
      assert.equal(error.details.cause_code, "ECONNRESET");
      assert.equal(error.details.cause_errno, -54);
      assert.equal(error.details.cause_syscall, "write");
      assert.equal(error.details.path, "/repos/o/r/releases/1/assets");
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      assert.equal(serialized.includes("never-log-this-token"), false);
      assert.equal(serialized.includes("secret-name"), false);
      return true;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uncertain upload reconciliation rejects partial and starter assets without retrying", async (t) => {
  const expected = { name: "database.sqlite", path: "unused", contentType: "application/vnd.sqlite3", size: 4, sha256: "0".repeat(64) };
  const release = { id: 10, upload_url: "https://uploads.github.com/repos/o/r/releases/10/assets{?name,label}" };
  for (const [label, asset, state] of [
    ["partial", { id: 1, name: expected.name, state: "uploaded", size: 2, digest: `sha256:${expected.sha256}` }, "partial"],
    ["starter", { id: 2, name: expected.name, state: "starter", size: 0, digest: null }, "starter"],
  ]) {
    await t.test(label, async () => {
      const storage = storageForReconciliation({ assets: [asset], bytes: Buffer.alloc(0) });
      await assert.rejects(() => storage.uploadAsset(release, expected), (error) => {
        assert.equal(error.code, "UPLOAD_OUTCOME_UNKNOWN");
        assert.equal(error.details.asset_state, state);
        assert.equal(error.details.failure_code, "UPLOAD_TRANSPORT_FAILED");
        return true;
      });
    });
  }
});

test("a complete asset found after a lost response is independently downloaded and accepted", async () => {
  const bytes = Buffer.from("lost response but complete upload");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = { name: "database.sqlite", path: "unused", contentType: "application/vnd.sqlite3", size: bytes.length, sha256 };
  const asset = {
    id: 3,
    name: expected.name,
    state: "uploaded",
    size: bytes.length,
    digest: `sha256:${sha256}`,
    url: "https://api.github.com/repos/o/r/releases/assets/3",
  };
  const storage = storageForReconciliation({ assets: [asset], bytes });
  const result = await storage.uploadAsset({ id: 10, upload_url: "https://uploads.github.com/repos/o/r/releases/10/assets{?name,label}" }, expected);
  assert.equal(result.reconciled, true);
  assert.equal(result.independently_verified, true);
  assert.equal(result.asset.id, 3);
});

test("reconciliation fails closed on metadata or independently downloaded checksum mismatch", async (t) => {
  const bytes = Buffer.from("expected payload");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = { name: "database.sqlite", path: "unused", contentType: "application/vnd.sqlite3", size: bytes.length, sha256 };
  const baseAsset = {
    id: 4,
    name: expected.name,
    state: "uploaded",
    size: bytes.length,
    digest: `sha256:${sha256}`,
    url: "https://api.github.com/repos/o/r/releases/assets/4",
  };
  await t.test("metadata digest", async () => {
    const storage = storageForReconciliation({ assets: [{ ...baseAsset, digest: `sha256:${"f".repeat(64)}` }], bytes });
    await assert.rejects(() => storage.uploadAsset({ id: 10, upload_url: "https://uploads.github.com/u" }, expected),
      (error) => error.code === "UPLOAD_CHECKSUM_MISMATCH");
  });
  await t.test("downloaded bytes", async () => {
    const storage = storageForReconciliation({ assets: [baseAsset], bytes: Buffer.from("changed payload!") });
    await assert.rejects(() => storage.uploadAsset({ id: 10, upload_url: "https://uploads.github.com/u" }, expected),
      (error) => error.code === "UPLOAD_CHECKSUM_MISMATCH");
  });
});

test("verified existing draft assets are idempotent and never uploaded again", async () => {
  const bytes = Buffer.from("existing verified asset");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = { name: "database.sqlite", path: "unused", contentType: "application/vnd.sqlite3", size: bytes.length, sha256 };
  const asset = {
    id: 5,
    name: expected.name,
    state: "uploaded",
    size: bytes.length,
    digest: `sha256:${sha256}`,
    url: "https://api.github.com/repos/o/r/releases/assets/5",
  };
  let uploads = 0;
  const storage = new GitHubReleaseCheckpointStorage({
    owner: "o",
    repository: "r",
    token: "fixture-token",
    streamUploadImpl: async () => { uploads += 1; throw new Error("must not upload"); },
    fetchImpl: async () => response(200, bytes),
  });
  const result = await storage.ensureDraftAsset({ assets: [asset] }, expected);
  assert.equal(result.independently_verified, true);
  assert.equal(result.reconciled, false);
  assert.equal(uploads, 0);
});

test("unresolved staging failure cannot publish a Release or promote the latest pointer", async () => {
  const directory = temporaryDirectory();
  const databasePath = join(directory, "baseline.sqlite");
  const database = openStore(databasePath);
  const firstRun = beginRun(database, "2026-11-14T00:00:00.000Z");
  finishRun(database, firstRun, "completed", "2026-11-14T00:01:00.000Z");
  database.close();
  const checkpoint = await createCheckpoint({
    sourcePath: databasePath,
    repositoryPath: join(directory, "checkpoints"),
    checkpointId: "baseline",
    createdAt: "2026-11-14T00:02:00.000Z",
  });
  let publishCalls = 0;
  let promoteCalls = 0;
  const storage = {
    async downloadLatestTrusted() {
      return { checkpoint, resolution: "latest_pointer", pointer_state: { revision: "fixture-revision" } };
    },
    async stageCheckpoint() { throw new RemoteStorageError("UPLOAD_OUTCOME_UNKNOWN", "controlled unresolved upload"); },
    async publishStaged() { publishCalls += 1; },
    async promoteLatest() { promoteCalls += 1; },
  };
  try {
    await assert.rejects(() => runCheckpointAutomation({
      storage,
      workspacePath: join(directory, "workspace"),
      generatedAt: "2026-11-14T00:03:00.000Z",
      runtimeOptions: NODE,
      async collect({ databasePath: restoredPath }) {
        const restored = openStore(restoredPath);
        const runId = beginRun(restored, "2026-11-14T00:03:00.000Z");
        finishRun(restored, runId, "completed", "2026-11-14T00:04:00.000Z");
        restored.close();
        return { controlled: true };
      },
    }), (error) => error.code === "UPLOAD_OUTCOME_UNKNOWN");
    assert.equal(publishCalls, 0);
    assert.equal(promoteCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

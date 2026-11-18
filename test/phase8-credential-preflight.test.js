import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCheckpoint } from "../src/checkpoint.js";
import {
  CredentialPreflightError,
  runCredentialPreflight,
} from "../scripts/phase8-credential-preflight.js";
import { beginRun, finishRun, openStore } from "../src/store.js";

const OWNER = "dormichaeli";
const REPOSITORY = "techmap_job_checkpoints";
const CHECKPOINT_ID = "run-13-20261115T134602Z";
const TOKEN = "fixture-installation-token-never-log";
const RUNTIME = { nodeVersion: "26.13.1", sqliteVersion: "3.54.1" };

function directory() {
  return mkdtempSync(join(tmpdir(), "techmap-credential-preflight-"));
}

function response(status, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return JSON.parse(bytes.toString("utf8")); },
    async arrayBuffer() { return bytes; },
  };
}

async function checkpointFixture(root) {
  const database = join(root, "source.sqlite");
  const db = openStore(database);
  const runId = beginRun(db, "2026-11-15T13:45:00.000Z");
  finishRun(db, runId, "completed", "2026-11-15T13:46:00.000Z");
  db.close();
  return createCheckpoint({
    sourcePath: database,
    repositoryPath: join(root, "checkpoint-repository"),
    checkpointId: CHECKPOINT_ID,
    createdAt: "2026-11-15T13:46:02.000Z",
  });
}

function fixtureFetch(checkpoint, {
  repositories = null,
  calls = [],
  pointerCheckpointId = CHECKPOINT_ID,
} = {}) {
  const database = readFileSync(checkpoint.database_path);
  const manifest = readFileSync(checkpoint.manifest_path);
  const pointer = {
    pointer_format: "techmap-job-latest-checkpoint",
    pointer_format_version: 1,
    checkpoint_id: pointerCheckpointId,
    manifest_sha256: checkpoint.manifest_sha256,
    database_sha256: checkpoint.manifest.database.sha256,
    promoted_at: "2026-11-15T13:46:02.356Z",
    previous_checkpoint_id: "run-12-20261115T112341Z",
  };
  const intendedRepository = {
    id: 1,
    full_name: `${OWNER}/${REPOSITORY}`,
    private: true,
    visibility: "private",
  };
  return async (url, request = {}) => {
    const target = new URL(url);
    calls.push({ method: request.method ?? "GET", path: target.pathname });
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (target.pathname === "/installation/repositories") {
      const accessible = repositories ?? [intendedRepository];
      return response(200, { total_count: accessible.length, repositories: accessible });
    }
    if (target.pathname === `/repos/${OWNER}/${REPOSITORY}`) return response(200, intendedRepository);
    if (target.pathname.endsWith("/.techmap-job/latest-checkpoint.json")) {
      return response(200, {
        sha: "a".repeat(40),
        content: Buffer.from(JSON.stringify(pointer)).toString("base64"),
      });
    }
    if (target.pathname.endsWith(`/releases/tags/techmap-checkpoint-${CHECKPOINT_ID}`)) {
      return response(200, {
        id: 13,
        draft: false,
        tag_name: `techmap-checkpoint-${CHECKPOINT_ID}`,
        assets: [
          { name: "database.sqlite", url: "https://api.github.com/checkpoint-assets/database" },
          { name: "manifest.json", url: "https://api.github.com/checkpoint-assets/manifest" },
        ],
      });
    }
    if (target.pathname === "/checkpoint-assets/database") return response(200, database);
    if (target.pathname === "/checkpoint-assets/manifest") return response(200, manifest);
    throw new Error(`Unexpected preflight request: ${request.method ?? "GET"} ${target.pathname}`);
  };
}

test("credential preflight is read-only, repository-scoped, and independently restores the checkpoint", async () => {
  const root = directory();
  try {
    const checkpoint = await checkpointFixture(root);
    const calls = [];
    const result = await runCredentialPreflight({
      owner: OWNER,
      repository: REPOSITORY,
      token: TOKEN,
      expectedCheckpointId: CHECKPOINT_ID,
      workspacePath: join(root, "workspace"),
      fetchImpl: fixtureFetch(checkpoint, { calls }),
      runtimeOptions: RUNTIME,
      protectedDatabasePaths: [join(root, "protected.sqlite")],
    });
    assert.equal(result.verdict, "passed");
    assert.equal(result.repository, `${OWNER}/${REPOSITORY}`);
    assert.equal(result.repository_visibility, "private");
    assert.equal(result.accessible_repository_count, 1);
    assert.equal(result.checkpoint_id, CHECKPOINT_ID);
    assert.equal(result.manifest_sha256, checkpoint.manifest_sha256);
    assert.equal(result.database_sha256, checkpoint.manifest.database.sha256);
    assert.equal(result.restored_database_sha256, checkpoint.manifest.database.sha256);
    assert.equal(result.integrity_check, "ok");
    assert.equal(result.foreign_key_violations, 0);
    assert.ok(calls.length >= 7);
    assert.deepEqual([...new Set(calls.map((call) => call.method))], ["GET"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential preflight rejects a token that can see more than the approved repository", async () => {
  const root = directory();
  try {
    const checkpoint = await checkpointFixture(root);
    const calls = [];
    const fetchImpl = fixtureFetch(checkpoint, {
      calls,
      repositories: [
        { full_name: `${OWNER}/${REPOSITORY}`, private: true, visibility: "private" },
        { full_name: `${OWNER}/unexpected`, private: true, visibility: "private" },
      ],
    });
    await assert.rejects(() => runCredentialPreflight({
      owner: OWNER,
      repository: REPOSITORY,
      token: TOKEN,
      expectedCheckpointId: CHECKPOINT_ID,
      workspacePath: join(root, "workspace"),
      fetchImpl,
      runtimeOptions: RUNTIME,
    }), (error) => error instanceof CredentialPreflightError
      && error.code === "INSTALLATION_SCOPE_INVALID"
      && error.details.repository_count === 2);
    assert.deepEqual(calls.map((call) => call.method), ["GET"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential preflight fails before asset download when the authoritative identity changes", async () => {
  const root = directory();
  try {
    const checkpoint = await checkpointFixture(root);
    const calls = [];
    await assert.rejects(() => runCredentialPreflight({
      owner: OWNER,
      repository: REPOSITORY,
      token: TOKEN,
      expectedCheckpointId: CHECKPOINT_ID,
      workspacePath: join(root, "workspace"),
      fetchImpl: fixtureFetch(checkpoint, { calls, pointerCheckpointId: "unexpected-checkpoint" }),
      runtimeOptions: RUNTIME,
    }), (error) => error instanceof CredentialPreflightError
      && error.code === "AUTHORITATIVE_CHECKPOINT_MISMATCH");
    assert.equal(calls.some((call) => call.path.startsWith("/checkpoint-assets/")), false);
    assert.deepEqual([...new Set(calls.map((call) => call.method))], ["GET"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential preflight errors never retain the installation token", async () => {
  const root = directory();
  try {
    await assert.rejects(() => runCredentialPreflight({
      owner: OWNER,
      repository: REPOSITORY,
      token: TOKEN,
      expectedCheckpointId: CHECKPOINT_ID,
      workspacePath: join(root, "workspace"),
      fetchImpl: async () => { throw new Error("controlled network failure"); },
      runtimeOptions: RUNTIME,
    }), (error) => {
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes(TOKEN), false);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential preflight workflow is manual, protected, immutable, and read-only", () => {
  const workflow = readFileSync(resolve(".github/workflows/checkpoint-credential-preflight.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bschedule:|\bpush:|pull_request:/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /environment: checkpoint-production/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510/);
  assert.match(workflow, /client-id: \$\{\{ vars\.CHECKPOINT_GITHUB_APP_CLIENT_ID \}\}/);
  assert.match(workflow, /private-key: \$\{\{ secrets\.CHECKPOINT_GITHUB_APP_PRIVATE_KEY \}\}/);
  assert.match(workflow, /owner: dormichaeli/);
  assert.match(workflow, /repositories: techmap_job_checkpoints/);
  assert.match(workflow, /permission-contents: read/);
  assert.doesNotMatch(workflow, /skip-token-revoke|CHECKPOINT_REPOSITORY_TOKEN/);
  assert.match(workflow, /--expected-checkpoint run-13-20261115T134602Z/);
  assert.doesNotMatch(workflow, /phase6-automation|\bcollect\b|stageCheckpoint|publishStaged|promoteLatest/);
  assert.doesNotMatch(workflow, /upload-pages|deploy-pages|upload-artifact|public-export/i);
});

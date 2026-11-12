import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FIRST_CLOUD_MAX_HTTP_ATTEMPTS,
  selectCollectionCohort,
} from "../src/collection-cohort.js";
import { GitHubReleaseCheckpointStorage } from "../src/github-release-storage.js";
import { RemoteStorageError } from "../src/remote-checkpoint.js";
import { importCompanies, openStore } from "../src/store.js";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return body; },
    async arrayBuffer() { return Buffer.from(JSON.stringify(body)); },
  };
}

test("first cloud cohort is private-database-derived, deterministic, diverse, and bounded", () => {
  const directory = mkdtempSync(join(tmpdir(), "techmap-phase7a-cohort-"));
  try {
    const db = openStore(join(directory, "cohort.sqlite"));
    const providers = ["jsonld", "lever", "greenhouse", "comeet", "breezy", "ashby", "custom"];
    importCompanies(db, providers.map((provider, index) => ({
      company_id: `company-${provider}`,
      company_name: `Company ${provider}`,
      canonical_domain: `${provider}.invalid`,
      careers_url: `https://${provider}.invalid/careers`,
      company_discovered_at: "2026-11-12T00:00:00.000Z",
      company_source_status: "verified",
      selection_score: index,
    })), "2026-11-12T00:00:00.000Z");
    const insert = db.prepare(`
      INSERT INTO company_sources (
        source_id, company_id, source_kind, provider, source_identifier, source_url,
        careers_url, evidence_source, evidence_status, is_enabled, imported_at
      ) VALUES (?, ?, 'ats', ?, ?, ?, ?, 'fixture', ?, 1, '2026-11-12T00:00:00.000Z')
    `);
    for (const provider of providers) {
      insert.run(
        `source-${provider}`,
        `company-${provider}`,
        provider,
        provider === "jsonld" ? null : `board-${provider}`,
        `https://${provider}.invalid/jobs`,
        `https://${provider}.invalid/careers`,
        provider === "custom" ? "manual_verified_unsupported" : "live_verified",
      );
    }
    insert.run(
      "source-unverified",
      "company-ashby",
      "ashby",
      "unverified-board",
      "https://ashby.invalid/unverified",
      "https://ashby.invalid/careers",
      "imported_unverified",
    );

    const first = selectCollectionCohort(db, { limit: 5 });
    const second = selectCollectionCohort(db, { limit: 5 });
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((row) => row.source_provider), [
      "ashby", "breezy", "comeet", "greenhouse", "lever",
    ]);
    assert.ok(first.every((row) => row.evidence_status === "live_verified"));
    assert.equal(FIRST_CLOUD_MAX_HTTP_ATTEMPTS, 15);
    assert.throws(() => selectCollectionCohort(db, { limit: 6 }), /exceeds/);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("GitHub bootstrap refuses a different release but can resume the exact candidate", async () => {
  const storage = new GitHubReleaseCheckpointStorage({
    owner: "owner",
    repository: "private-checkpoints",
    token: "fixture-token",
    fetchImpl: async (url) => url.includes("/contents/")
      ? response(404, { message: "not found" })
      : response(200, [{ id: 1, tag_name: "techmap-checkpoint-existing" }]),
  });
  await assert.rejects(() => storage.assertBootstrapSafe("candidate"),
    (error) => error instanceof RemoteStorageError && error.code === "BOOTSTRAP_NOT_EMPTY");

  const resumable = new GitHubReleaseCheckpointStorage({
    owner: "owner",
    repository: "private-checkpoints",
    token: "fixture-token",
    fetchImpl: async (url) => url.includes("/contents/")
      ? response(404, { message: "not found" })
      : response(200, [{ id: 2, tag_name: "techmap-checkpoint-candidate" }]),
  });
  assert.deepEqual(await resumable.assertBootstrapSafe("candidate"), {
    empty: false, resumable: true, release_id: 2,
  });
});

test("GitHub transport and wrong repository failures remain closed and classified", async () => {
  const interrupted = new GitHubReleaseCheckpointStorage({
    owner: "owner", repository: "repo", token: "fixture-token",
    fetchImpl: async () => { throw new Error("controlled interruption"); },
  });
  await assert.rejects(() => interrupted.pointerState(),
    (error) => error instanceof RemoteStorageError && error.code === "REMOTE_REQUEST_FAILED");

  const missing = new GitHubReleaseCheckpointStorage({
    owner: "owner", repository: "wrong-name", token: "fixture-token",
    fetchImpl: async () => response(404, { message: "not found" }),
  });
  await assert.rejects(() => missing.downloadLatestTrusted("unused"),
    (error) => error instanceof RemoteStorageError && error.code === "REMOTE_NOT_FOUND");
});

test("manual workflow has no schedule, no public data dependency, and fixed authority", () => {
  const workflow = readFileSync(resolve(".github/workflows/daily-collection.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bschedule:/);
  assert.doesNotMatch(workflow, /\bqueue:/);
  assert.doesNotMatch(workflow, /data\/companies\.csv/);
  assert.match(workflow, /repository techmap_job_checkpoints/);
  assert.match(workflow, /environment: checkpoint-production/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /--cohort-policy first_cloud_v1/);
  assert.match(workflow, /--limit 5/);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
});

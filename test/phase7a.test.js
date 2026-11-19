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

test("scheduled and manual workflow paths use secure routing and fixed safety limits", () => {
  const workflow = readFileSync(resolve(".github/workflows/daily-collection.yml"), "utf8");
  const eventGuard = workflow.indexOf("- name: Restrict authoritative events and runs");
  const checkoutStep = workflow.indexOf("- name: Check out reviewed collector");
  const tokenStep = workflow.indexOf("- name: Mint repository-scoped checkpoint write token");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow,
    /schedule:\s*\n\s*- cron: "17 12 \* \* \*"\s*\n\s*timezone: "Asia\/Jerusalem"/);
  assert.equal(workflow.match(/\bschedule:/g)?.length, 1);
  assert.equal(workflow.match(/\bworkflow_dispatch:/g)?.length, 1);
  assert.doesNotMatch(workflow, /\bqueue:/);
  assert.doesNotMatch(workflow, /\bpush:|pull_request:|workflow_run:|repository_dispatch:/);
  assert.doesNotMatch(workflow, /data\/companies\.csv/);
  assert.match(workflow, /repository techmap_job_checkpoints/);
  assert.match(workflow,
    /if: \$\{\{ github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(workflow,
    /environment: \$\{\{ github\.event_name == 'schedule' && 'checkpoint-automation' \|\| github\.event_name == 'workflow_dispatch' && 'checkpoint-production' \|\| 'checkpoint-denied' \}\}/);
  assert.match(workflow, /CHECKPOINT_AUTOMATION_ENABLED: \$\{\{ vars\.CHECKPOINT_AUTOMATION_ENABLED \}\}/);
  assert.match(workflow, /\[\[ "\$CHECKPOINT_AUTOMATION_ENABLED" != "true" \]\]/);
  assert.match(workflow, /case "\$GITHUB_EVENT_NAME" in[\s\S]*?schedule\)[\s\S]*?workflow_dispatch\)[\s\S]*?\*\)/);
  assert.match(workflow, /if \[\[ "\$GITHUB_REF" != "refs\/heads\/main" \]\]/);
  assert.ok(eventGuard >= 0);
  assert.ok(checkoutStep > eventGuard);
  assert.ok(tokenStep > checkoutStep);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /group: techmap-job-authoritative-checkpoint/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /ref: main/);
  assert.match(workflow, /--cohort-policy rotating_verified_v1/);
  assert.match(workflow, /--limit 5/);
  assert.match(workflow, /--concurrency 2/);
  assert.doesNotMatch(workflow, /upload-pages|deploy-pages|upload-artifact|release upload/i);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
});

test("production workflow mints a fail-closed repository-scoped GitHub App write token", () => {
  const workflow = readFileSync(resolve(".github/workflows/daily-collection.yml"), "utf8");
  const tokenStep = workflow.indexOf("- name: Mint repository-scoped checkpoint write token");
  const collectionStep = workflow.indexOf("- name: Restore, collect, checkpoint, verify, and promote");

  assert.ok(tokenStep >= 0);
  assert.ok(collectionStep > tokenStep);
  assert.match(workflow,
    /actions\/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510/);
  assert.match(workflow, /id: checkpoint-app-token/);
  assert.match(workflow, /client-id: \$\{\{ vars\.CHECKPOINT_GITHUB_APP_CLIENT_ID \}\}/);
  assert.match(workflow, /private-key: \$\{\{ secrets\.CHECKPOINT_GITHUB_APP_PRIVATE_KEY \}\}/);
  assert.match(workflow, /owner: dormichaeli/);
  assert.match(workflow, /repositories: techmap_job_checkpoints/);
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow,
    /permission-contents: write\s+\n\s*- name: Restore, collect, checkpoint, verify, and promote/);
  assert.doesNotMatch(workflow, /permission-(?!contents: write)/);
  assert.match(workflow,
    /CHECKPOINT_REPOSITORY_TOKEN: \$\{\{ steps\.checkpoint-app-token\.outputs\.token \}\}/);
  assert.doesNotMatch(workflow, /secrets\.CHECKPOINT_REPOSITORY_TOKEN/);
  assert.match(workflow, /--token-env CHECKPOINT_REPOSITORY_TOKEN/);
  assert.doesNotMatch(workflow, /skip-token-revoke|continue-on-error|if:\s*always\(\)|--token\s/);
  assert.equal(workflow.match(/CHECKPOINT_GITHUB_APP_PRIVATE_KEY/g)?.length, 1);
  assert.equal(workflow.match(/steps\.checkpoint-app-token\.outputs\.token/g)?.length, 1);
  assert.doesNotMatch(workflow, /echo.*(?:PRIVATE_KEY|outputs\.token)|print.*(?:PRIVATE_KEY|outputs\.token)/i);
  assert.match(workflow, /timeout-minutes: 55/);
  assert.doesNotMatch(workflow, /\bpush:|pull_request:|workflow_run:|repository_dispatch:/);
});

test("cloud automation uses one fixed timestamp for rotating selection and checkpointing", () => {
  const automation = readFileSync(resolve("scripts/phase6-automation.js"), "utf8");
  assert.equal(automation.match(/new Date\(\)\.toISOString\(\)/g)?.length, 1);
  assert.match(automation, /const generatedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(automation, /runCheckpointAutomation\(\{[\s\S]*?generatedAt,/);
  assert.match(automation,
    /async collect\(\{ databasePath, workspacePath, generatedAt: selectionTime \}\)/);
  assert.match(automation,
    /selectCollectionCohort\(cohortDatabase, \{[\s\S]*?policy: cohortPolicy,[\s\S]*?limit: collectionLimit,[\s\S]*?selectionTime,[\s\S]*?\}\)/);
  assert.match(automation, /--max-http-attempts", FIRST_CLOUD_MAX_HTTP_ATTEMPTS/);
  assert.match(automation, /selection_time: selectionTime/);
});

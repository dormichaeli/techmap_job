#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectCheckpointDatabase,
  restoreCheckpoint,
  sha256File,
} from "../src/checkpoint.js";
import { GitHubReleaseCheckpointStorage } from "../src/github-release-storage.js";
import { verifyRuntimeSafety } from "../src/runtime-safety.js";

export const PREFLIGHT_OWNER = "dormichaeli";
export const PREFLIGHT_REPOSITORY = "techmap_job_checkpoints";

export class CredentialPreflightError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CredentialPreflightError";
    this.code = code;
    this.details = details;
  }
}

function assertPreflight(condition, code, message, details = {}) {
  if (!condition) throw new CredentialPreflightError(code, message, details);
}

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--") || !argv[index + 1]) throw new Error(`Invalid option: ${name}`);
    parsed[name.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

export async function runCredentialPreflight({
  owner = PREFLIGHT_OWNER,
  repository = PREFLIGHT_REPOSITORY,
  token,
  expectedCheckpointId,
  workspacePath,
  fetchImpl = globalThis.fetch,
  apiBase = "https://api.github.com",
  runtimeOptions,
  protectedDatabasePaths = [resolve("data/jobs.sqlite")],
} = {}) {
  assertPreflight(owner === PREFLIGHT_OWNER && repository === PREFLIGHT_REPOSITORY,
    "PREFLIGHT_TARGET_INVALID", "Credential preflight target is not the approved checkpoint repository");
  assertPreflight(typeof token === "string" && token.length > 0,
    "CREDENTIALS_MISSING", "GitHub App installation token is missing");
  assertPreflight(typeof expectedCheckpointId === "string" && /^[A-Za-z0-9._-]+$/.test(expectedCheckpointId),
    "EXPECTED_CHECKPOINT_INVALID", "Expected checkpoint ID is missing or invalid");
  assertPreflight(typeof workspacePath === "string" && workspacePath.length > 0,
    "WORKSPACE_INVALID", "Credential preflight workspace is required");

  const runtime = verifyRuntimeSafety(runtimeOptions);
  const workspace = resolve(workspacePath);
  assertPreflight(!existsSync(workspace), "WORKSPACE_EXISTS", "Credential preflight workspace already exists");
  mkdirSync(workspace, { recursive: true });

  const storage = new GitHubReleaseCheckpointStorage({
    owner,
    repository,
    token,
    branch: "main",
    fetchImpl,
    apiBase,
  });

  const installationRepositories = await storage.request(
    `${storage.apiBase}/installation/repositories?per_page=100`,
  );
  const repositories = Array.isArray(installationRepositories?.repositories)
    ? installationRepositories.repositories : [];
  assertPreflight(installationRepositories?.total_count === 1 && repositories.length === 1,
    "INSTALLATION_SCOPE_INVALID", "Installation token is not restricted to exactly one repository", {
      repository_count: installationRepositories?.total_count ?? null,
    });
  const installedRepository = repositories[0];
  assertPreflight(installedRepository.full_name === `${owner}/${repository}`
    && installedRepository.private === true
    && installedRepository.visibility === "private",
  "INSTALLATION_REPOSITORY_INVALID", "Installation token does not target the approved private repository", {
    full_name: installedRepository.full_name ?? null,
    private: installedRepository.private ?? null,
    visibility: installedRepository.visibility ?? null,
  });

  const repositoryMetadata = await storage.request(storage.endpoint(""));
  assertPreflight(repositoryMetadata.full_name === `${owner}/${repository}`
    && repositoryMetadata.private === true
    && repositoryMetadata.visibility === "private",
  "CHECKPOINT_REPOSITORY_INVALID", "Checkpoint repository identity or visibility is invalid");

  const pointerState = await storage.pointerState();
  assertPreflight(pointerState?.pointer?.checkpoint_id === expectedCheckpointId,
    "AUTHORITATIVE_CHECKPOINT_MISMATCH", "Authoritative pointer does not match the approved checkpoint", {
      expected_checkpoint_id: expectedCheckpointId,
      observed_checkpoint_id: pointerState?.pointer?.checkpoint_id ?? null,
    });

  const discovered = await storage.downloadLatestTrusted(join(workspace, "download"));
  assertPreflight(discovered.resolution === "latest_pointer",
    "POINTER_RECOVERY_UNEXPECTED", "Credential preflight resolved a fallback instead of the authoritative pointer");
  assertPreflight(discovered.checkpoint.manifest.checkpoint_id === expectedCheckpointId,
    "DOWNLOADED_CHECKPOINT_MISMATCH", "Downloaded checkpoint identity does not match the approved checkpoint");
  assertPreflight(discovered.checkpoint.manifest_sha256 === pointerState.pointer.manifest_sha256
    && discovered.checkpoint.manifest.database.sha256 === pointerState.pointer.database_sha256,
  "DOWNLOADED_CHECKSUM_MISMATCH", "Downloaded checkpoint checksums do not match the authoritative pointer");
  assertPreflight(discovered.checkpoint.manifest.publication.eligible === true,
    "CHECKPOINT_NOT_PUBLISHABLE", "Authoritative checkpoint is not publication eligible");

  const restoredDatabase = join(workspace, "restore", "jobs.sqlite");
  const restored = restoreCheckpoint({
    checkpointPath: discovered.checkpoint.checkpoint_directory,
    destinationPath: restoredDatabase,
    forbiddenPaths: protectedDatabasePaths,
  });
  const restoredInspection = inspectCheckpointDatabase(restoredDatabase);
  assertPreflight(restored.checkpoint_id === expectedCheckpointId,
    "RESTORED_CHECKPOINT_MISMATCH", "Restored checkpoint identity does not match the approved checkpoint");
  assertPreflight(sha256File(restoredDatabase) === pointerState.pointer.database_sha256,
    "RESTORED_CHECKSUM_MISMATCH", "Restored database checksum does not match the authoritative pointer");
  assertPreflight(restoredInspection.integrity_check === "ok"
    && restoredInspection.foreign_key_violations === 0,
  "RESTORED_DATABASE_INVALID", "Restored database failed integrity or foreign-key validation");

  return {
    verdict: "passed",
    repository: `${owner}/${repository}`,
    repository_visibility: repositoryMetadata.visibility,
    accessible_repository_count: installationRepositories.total_count,
    checkpoint_id: expectedCheckpointId,
    pointer_revision: pointerState.revision,
    manifest_sha256: discovered.checkpoint.manifest_sha256,
    database_sha256: discovered.checkpoint.manifest.database.sha256,
    restored_database_sha256: sha256File(restoredDatabase),
    schema_version: restoredInspection.schema_version,
    integrity_check: restoredInspection.integrity_check,
    foreign_key_violations: restoredInspection.foreign_key_violations,
    runtime,
  };
}

async function main() {
  let parsed = null;
  let workspace = null;
  try {
    parsed = options(process.argv.slice(2));
    workspace = resolve(parsed.workspace ?? ".phase8-credential-preflight-workspace");
    const tokenEnvironment = parsed["token-env"] ?? "CHECKPOINT_REPOSITORY_TOKEN";
    const result = await runCredentialPreflight({
      owner: parsed.owner,
      repository: parsed.repository,
      token: process.env[tokenEnvironment],
      expectedCheckpointId: parsed["expected-checkpoint"],
      workspacePath: workspace,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      verdict: "failed",
      code: error.code ?? "CREDENTIAL_PREFLIGHT_FAILED",
      error: "GitHub App credential preflight failed closed; no remote writes were attempted.",
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (parsed?.cleanup === "true" && workspace) rmSync(workspace, { recursive: true, force: true });
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPoint === import.meta.url) await main();

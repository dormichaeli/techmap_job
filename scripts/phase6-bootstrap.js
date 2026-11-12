#!/usr/bin/env node
import { resolve } from "node:path";
import { validateCheckpoint } from "../src/checkpoint.js";
import { GitHubReleaseCheckpointStorage } from "../src/github-release-storage.js";
import { verifyRuntimeSafety } from "../src/runtime-safety.js";

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Invalid option: ${argv[index]}`);
    parsed[argv[index].slice(2)] = argv[index + 1];
  }
  return parsed;
}

try {
  const parsed = options(process.argv.slice(2));
  const checkpoint = validateCheckpoint(resolve(parsed.checkpoint));
  const token = process.env[parsed["token-env"] ?? "CHECKPOINT_REPOSITORY_TOKEN"];
  const storage = new GitHubReleaseCheckpointStorage({
    owner: parsed.owner,
    repository: parsed.repository,
    branch: parsed.branch ?? "main",
    token,
  });
  const runtime = verifyRuntimeSafety();
  const bootstrapState = await storage.assertBootstrapSafe(checkpoint.manifest.checkpoint_id);
  const staged = await storage.stageCheckpoint(checkpoint.checkpoint_directory);
  const published = await storage.publishStaged(staged);
  const promoted = await storage.promoteLatest(published, { expectedRevision: null });
  console.log(JSON.stringify({
    verdict: "bootstrapped",
    runtime,
    checkpoint_id: checkpoint.manifest.checkpoint_id,
    pointer_revision: promoted.revision,
    resumed_exact_candidate: bootstrapState.resumable,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ verdict: "failed", code: error.code ?? "BOOTSTRAP_FAILED", error: error.message }, null, 2));
  process.exitCode = 1;
}

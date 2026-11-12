#!/usr/bin/env node
import { resolve } from "node:path";
import {
  CheckpointError,
  createCheckpoint,
  restoreCheckpoint,
  validateCheckpoint,
} from "../src/checkpoint.js";
import {
  publishCheckpointLocally,
  resolveTrustedCheckpoint,
} from "../src/checkpoint-publication.js";

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const name = item.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function required(parsed, name) {
  if (!parsed[name]) throw new Error(`Missing required option --${name}`);
  return resolve(parsed[name]);
}

function checkpointId() {
  return `checkpoint-${new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function printable(validated) {
  return {
    checkpoint_id: validated.manifest.checkpoint_id,
    checkpoint_directory: validated.checkpoint_directory,
    database_sha256: validated.manifest.database.sha256,
    manifest_sha256: validated.manifest_sha256,
    schema_version: validated.inspection.schema_version,
    counts: validated.inspection.counts,
    collection_run: validated.inspection.collection_run,
    publication: validated.manifest.publication,
  };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const parsed = options(argv);
  let result;
  switch (command) {
    case "create":
      result = printable(await createCheckpoint({
        sourcePath: required(parsed, "source"),
        repositoryPath: required(parsed, "repository"),
        checkpointId: parsed.id ?? checkpointId(),
      }));
      break;
    case "validate":
      result = printable(validateCheckpoint(required(parsed, "checkpoint")));
      break;
    case "restore":
      result = restoreCheckpoint({
        checkpointPath: required(parsed, "checkpoint"),
        destinationPath: required(parsed, "destination"),
        forbiddenPaths: [resolve("data/jobs.sqlite")],
      });
      break;
    case "publish-local":
      result = await publishCheckpointLocally({
        checkpointPath: required(parsed, "checkpoint"),
        publicationRepository: required(parsed, "repository"),
        expectedLatestCheckpointId: parsed["expected-latest"] === "none"
          ? null : parsed["expected-latest"],
      });
      break;
    case "resolve-local": {
      const trusted = resolveTrustedCheckpoint(required(parsed, "repository"));
      result = { ...printable(trusted), resolution: trusted.resolution, recovery_reason: trusted.recovery_reason };
      break;
    }
    default:
      throw new Error("Usage: checkpoint-cli.js <create|validate|restore|publish-local|resolve-local> [options]");
  }
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    error: error.message,
    code: error instanceof CheckpointError ? error.code : "USAGE_ERROR",
    details: error.details ?? {},
  }, null, 2));
  process.exitCode = 1;
}

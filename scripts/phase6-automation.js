#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runCheckpointAutomation } from "../src/automation.js";
import {
  COLLECTION_COHORT_FIELDS,
  FIRST_CLOUD_MAX_HTTP_ATTEMPTS,
  FIRST_CLOUD_MAX_SOURCES,
  FIRST_CLOUD_POLICY,
  selectCollectionCohort,
} from "../src/collection-cohort.js";
import { writeCsv } from "../src/csv.js";
import { GitHubReleaseCheckpointStorage } from "../src/github-release-storage.js";
import { RuntimeSafetyError } from "../src/runtime-safety.js";
import { openStore } from "../src/store.js";

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

const parsed = options(process.argv.slice(2));
const tokenEnvironment = parsed["token-env"] ?? "CHECKPOINT_REPOSITORY_TOKEN";
const token = process.env[tokenEnvironment];
const workspace = resolve(parsed.workspace ?? ".phase6-automation-workspace");
const cohortPolicy = parsed["cohort-policy"] ?? FIRST_CLOUD_POLICY;
const collectionLimit = Number(parsed.limit ?? FIRST_CLOUD_MAX_SOURCES);
const collectionConcurrency = Number(parsed.concurrency ?? 2);
const generatedAt = new Date().toISOString();

if (!Number.isInteger(collectionLimit) || collectionLimit < 1 || collectionLimit > FIRST_CLOUD_MAX_SOURCES) {
  throw new Error(`--limit must be an integer from 1 to ${FIRST_CLOUD_MAX_SOURCES}`);
}
if (!Number.isInteger(collectionConcurrency) || collectionConcurrency < 1 || collectionConcurrency > 2) {
  throw new Error("--concurrency must be 1 or 2 for the first cloud cohort");
}

try {
  const storage = new GitHubReleaseCheckpointStorage({
    owner: parsed.owner,
    repository: parsed.repository,
    branch: parsed.branch ?? "main",
    token,
  });
  const result = await runCheckpointAutomation({
    storage,
    workspacePath: workspace,
    protectedDatabasePaths: [resolve("data/jobs.sqlite")],
    generatedAt,
    async collect({ databasePath, workspacePath }) {
      const cohortDatabase = openStore(databasePath);
      let cohort;
      try {
        cohort = selectCollectionCohort(cohortDatabase, { policy: cohortPolicy, limit: collectionLimit });
      } finally {
        cohortDatabase.close();
      }
      const companies = join(workspacePath, "private-collection-cohort.csv");
      const httpMetrics = join(workspacePath, "private-http-attempt-metrics.json");
      await writeCsv(companies, cohort, COLLECTION_COHORT_FIELDS);
      const collection = spawnSync(process.execPath, [
        "--disable-warning=ExperimentalWarning",
        resolve("src/cli.js"),
        "collect",
        "--db", databasePath,
        "--companies", companies,
        "--limit", collectionLimit,
        "--concurrency", collectionConcurrency,
        "--export-dir", resolve(workspacePath, "internal-exports"),
        "--cohort", cohortPolicy,
        "--discovery-kind", "incremental",
        "--max-http-attempts", FIRST_CLOUD_MAX_HTTP_ATTEMPTS,
        "--http-metrics-file", httpMetrics,
      ], { encoding: "utf8", timeout: 45 * 60 * 1000 });
      if (collection.status !== 0) {
        throw new Error(`Bounded collector failed with status ${collection.status}; captured output was withheld from public logs`);
      }
      const attemptMetrics = JSON.parse(readFileSync(httpMetrics, "utf8"));
      if (attemptMetrics.max_attempts !== FIRST_CLOUD_MAX_HTTP_ATTEMPTS
        || attemptMetrics.attempts > FIRST_CLOUD_MAX_HTTP_ATTEMPTS
        || attemptMetrics.blocked_attempts !== 0) {
        throw new Error("Bounded collector violated the first-cloud HTTP attempt policy");
      }
      return {
        cohort_policy: cohortPolicy,
        limit: collectionLimit,
        concurrency: collectionConcurrency,
        source_ids_sha256: createHash("sha256")
          .update(cohort.map((row) => row.company_source_id).join("\n"))
          .digest("hex"),
        http_attempts: attemptMetrics.attempts,
        max_http_attempts: attemptMetrics.max_attempts,
      };
    },
    onStage(stage) {
      console.log(JSON.stringify({ stage }));
    },
  });
  console.log(JSON.stringify({
    verdict: "completed",
    cohort_policy: result.collection.cohort_policy,
    cohort_fingerprint: result.collection.source_ids_sha256,
    source_count: result.collection.limit,
    http_attempts: result.collection.http_attempts,
    max_http_attempts: result.collection.max_http_attempts,
    runtime: result.runtime,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    verdict: "failed",
    code: error.code ?? (error instanceof RuntimeSafetyError ? error.code : "AUTOMATION_FAILED"),
    error: "Automation failed closed; inspect the private operator context for details.",
  }, null, 2));
  process.exitCode = 1;
} finally {
  if (parsed.cleanup === "true") rmSync(workspace, { recursive: true, force: true });
}

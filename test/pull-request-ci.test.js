import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("pull request CI is main-targeted, read-only, credentialless, and test-only", () => {
  const workflow = readFileSync(resolve(".github/workflows/pull-request-ci.yml"), "utf8");

  assert.match(workflow, /name: Pull request CI/);
  assert.match(workflow,
    /on:\s*\n\s*pull_request:\s*\n\s*branches:\s*\n\s*- main/);
  assert.equal(workflow.match(/\bpull_request:/g)?.length, 1);
  assert.doesNotMatch(workflow,
    /pull_request_target:|\bpush:|\bschedule:|workflow_dispatch:|workflow_run:|repository_dispatch:/);

  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*jobs:/);
  assert.doesNotMatch(workflow, /\bpermissions:\s*(?:write-all|read-all)|\bcontents: write/);
  assert.doesNotMatch(workflow, /environment:|secrets\.|vars\.|CHECKPOINT_|GITHUB_APP|PRIVATE_KEY/);

  const uses = [...workflow.matchAll(/^\s*uses:\s*([^ #]+).*$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(uses, [
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
  ]);
  assert.ok(uses.every((action) => /^actions\/[a-z0-9-]+@[a-f0-9]{40}$/.test(action)));
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /\bref:/);
  assert.match(workflow, /node-version: 26\.13\.1/);

  const runtimeCheck = workflow.indexOf("scripts/verify-runtime.js");
  const regressionSuite = workflow.indexOf("run: npm test");
  assert.ok(runtimeCheck >= 0);
  assert.ok(regressionSuite > runtimeCheck);
  const commands = [...workflow.matchAll(/^\s*run:\s*(.+)$/gm)]
    .map((match) => match[1].trim());
  assert.deepEqual(commands, [
    "node --disable-warning=ExperimentalWarning scripts/verify-runtime.js",
    "npm test",
  ]);
  assert.doesNotMatch(workflow,
    /phase6-automation|\bcollect\b|checkpoint|release|upload-artifact|deploy-pages|public-export/i);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  clearHttpAttemptBudget,
  configureHttpAttemptBudget,
  httpAttemptBudgetSnapshot,
  request,
} from "../src/http.js";

function okResponse() {
  return {
    ok: true,
    status: 200,
    url: "https://example.invalid/",
    headers: { get: () => null },
    async json() { return {}; },
  };
}

test("HTTP attempt budget is process-wide, measured, and fail-closed", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return okResponse();
  };
  try {
    configureHttpAttemptBudget(2);
    await request("https://example.invalid/one");
    await request("https://example.invalid/two");
    await assert.rejects(() => request("https://example.invalid/three"), /budget exhausted/);
    assert.equal(fetchCalls, 2);
    assert.deepEqual(httpAttemptBudgetSnapshot(), {
      max_attempts: 2,
      attempts: 2,
      blocked_attempts: 1,
    });
  } finally {
    clearHttpAttemptBudget();
    globalThis.fetch = originalFetch;
  }
});

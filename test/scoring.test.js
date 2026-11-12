import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJob, scoreJob } from "../src/scoring.js";

test("performance marketing job in central Israel ranks highly with reasons", () => {
  const result = scoreJob({
    job_title: "Performance Marketing Analyst",
    description: "Own Google Ads and Meta Ads, use SQL, and optimize campaign ROAS.",
    location: "Tel Aviv, Israel",
    remote_type: "hybrid",
  });
  assert.ok(result.relevance_score >= 65);
  assert.match(result.relevance_reasons, /Google Ads/);
  assert.match(result.relevance_reasons, /central Israel/);
});

test("unrelated engineering job is not a false positive", () => {
  const result = scoreJob({
    job_title: "Senior Backend Engineer",
    description: "Build distributed systems in Go and Kubernetes.",
    location: "Tel Aviv",
  });
  assert.ok(result.relevance_score < 40);
  assert.match(result.relevance_reasons, /engineering role/);
});

test("specialized trade analysis is penalized despite generic analyst skills", () => {
  const result = scoreJob({
    job_title: "Duty Drawback Analyst",
    description: "Analyze trade data using SQL and business intelligence tools.",
    location: "Petah Tikva, Israel",
    remote_type: "hybrid",
  });
  assert.ok(result.relevance_score < 40);
  assert.match(result.relevance_reasons, /trade\/tax analysis/);
});

test("job identifiers are deterministic and source-scoped", () => {
  const base = {
    source_job_id: "123",
    source_provider: "greenhouse",
    company_name: "Acme",
    source_url: "https://example.test/jobs",
    job_title: "Data Analyst",
  };
  const first = normalizeJob(base, "2026-11-11T00:00:00Z");
  const second = normalizeJob(base, "2026-11-12T00:00:00Z");
  const other = normalizeJob({ ...base, company_name: "Other" }, "2026-11-11T00:00:00Z");
  assert.equal(first.job_id, second.job_id);
  assert.notEqual(first.job_id, other.job_id);
  assert.equal(first.source_updated_at, null);
});

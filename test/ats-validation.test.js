import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeOwnershipEvidence,
  applicationLinkStatus,
  classifyValidation,
  extractOfficialCareerLinks,
  extractAtsReferences,
  parserStatus,
  providerRateLimited,
  selectValidationSample,
  summarizeJobData,
} from "../src/ats-validation.js";

function candidate(overrides = {}) {
  return {
    company_id: overrides.company_id ?? "company-1",
    company_name: overrides.company_name ?? "Acme",
    canonical_domain: overrides.canonical_domain ?? "acme.io",
    website_url: overrides.website_url ?? "https://acme.io",
    careers_url: overrides.careers_url ?? "https://acme.io/careers",
    employee_count_min: overrides.employee_count_min === undefined ? 11 : overrides.employee_count_min,
    employee_count_max: overrides.employee_count_max === undefined ? 50 : overrides.employee_count_max,
    employee_size_bucket: overrides.employee_size_bucket ?? "11-50",
    category_name: overrides.category_name ?? "AI/ML",
    is_multinational: overrides.is_multinational ?? 0,
    provider: overrides.provider ?? "greenhouse",
    source_identifier: overrides.source_identifier ?? "acme",
    source_url: overrides.source_url ?? "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    previous_verification_status: overrides.previous_verification_status ?? "imported_unverified",
    source_enabled: 0,
    ...overrides,
  };
}

function collection(overrides = {}) {
  return {
    status: overrides.status ?? "success",
    jobs: overrides.jobs ?? [{ source_job_id: "one" }],
    sourceUrl: "https://jobs.test",
    httpStatus: overrides.httpStatus === undefined ? 200 : overrides.httpStatus,
    error: overrides.error ?? null,
  };
}

const verified = { status: "verified" };
const uncertain = { status: "uncertain" };

test("sampling is deterministic, provider-bounded, and favors small .io companies with industry diversity", () => {
  const universe = [];
  const counts = { breezy: 4, lever: 7, greenhouse: 15, comeet: 20 };
  for (const [provider, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) {
      universe.push(candidate({
        company_id: `${provider}-${index}`,
        company_name: `${provider}-${String(index).padStart(2, "0")}`,
        provider,
        source_identifier: `${provider}-${index}`,
        canonical_domain: index < 2 ? `${provider}-${index}.io` : `${provider}-${index}.com`,
        employee_count_min: index < 12 ? 11 : 201,
        employee_count_max: index < 12 ? 50 : 1000,
        category_name: `category-${index % 12}`,
      }));
    }
  }
  const first = selectValidationSample(universe);
  const second = selectValidationSample(universe);
  assert.deepEqual(first.map((row) => row.company_id), second.map((row) => row.company_id));
  assert.deepEqual(Object.fromEntries(Object.entries(Object.groupBy(first, (row) => row.provider))
    .map(([provider, rows]) => [provider, rows.length])), { breezy: 4, lever: 7, greenhouse: 10, comeet: 10 });
  assert.equal(first.length, 31);
  assert.ok(first.filter((row) => ["greenhouse", "comeet"].includes(row.provider))
    .every((row) => row.employee_count_max <= 200));
  assert.ok(new Set(first.filter((row) => row.provider === "greenhouse").map((row) => row.category_name)).size >= 8);
});

test("official-domain links to an exact ATS board verify ownership", () => {
  const result = analyzeOwnershipEvidence(candidate(), {
    attempted: true, status: 200, url: "https://acme.io/careers", finalUrl: "https://acme.io/careers",
    body: '<a href="https://boards.greenhouse.io/acme">Open positions</a>',
  });
  assert.equal(result.status, "verified");
});

test("official-domain links to another board are migration indicators", () => {
  const result = analyzeOwnershipEvidence(candidate(), {
    attempted: true, status: 200, url: "https://acme.io/careers", finalUrl: "https://acme.io/careers",
    body: '<a href="https://jobs.lever.co/acme-new">Open positions</a>',
  });
  assert.equal(result.status, "migrated");
  assert.deepEqual(result.alternate_sources, [{ provider: "lever", identifier: "acme-new" }]);
});

test("bounded official career-page discovery can establish strong ownership", () => {
  const links = extractOfficialCareerLinks(
    '<a href="/about">About</a><a href="/company/careers">Careers</a><a href="https://other.test/jobs">Other</a>',
    "https://acme.io/", "acme.io",
  );
  assert.deepEqual(links, ["https://acme.io/company/careers"]);
  const result = analyzeOwnershipEvidence(candidate(), [
    { attempted: true, status: 200, url: "https://acme.io/", finalUrl: "https://acme.io/", body: '<a href="/company/careers">Careers</a>' },
    { attempted: true, status: 200, url: "https://acme.io/company/careers", finalUrl: "https://acme.io/company/careers", body: '<a href="https://boards.greenhouse.io/acme">Jobs</a>' },
  ]);
  assert.equal(result.status, "verified");
  assert.equal(result.evidence_level, "strong");
});

test("explicit reliable source provenance is strong but supporting branding alone is not", () => {
  const prior = analyzeOwnershipEvidence(candidate({
    previous_verification_status: "live_verified", source_enabled: 1,
  }), { attempted: true, status: 200, url: "https://acme.io", finalUrl: "https://acme.io", body: "Acme careers" });
  assert.equal(prior.status, "verified");
  const brandingOnly = analyzeOwnershipEvidence(candidate(), {
    attempted: true, status: 200, url: "https://acme.io", finalUrl: "https://acme.io", body: "Acme careers",
  });
  assert.equal(brandingOnly.status, "uncertain");
  assert.equal(brandingOnly.evidence_level, "supporting_only");
});

test("ATS metadata pointing to another official domain is an ownership conflict", () => {
  const result = analyzeOwnershipEvidence(candidate(), null, {
    official_domain: "other-company.com", evidence_url: "https://ats.test/metadata",
  });
  assert.equal(result.status, "conflict");
});

test("a corporate-domain redirect cannot by itself verify a live ATS board", () => {
  const ownership = analyzeOwnershipEvidence(candidate(), {
    attempted: true, status: 200, url: "https://acme.io", finalUrl: "https://buyer.example/careers", body: "Careers",
  });
  assert.equal(ownership.status, "domain_redirect");
  assert.equal(classifyValidation({ collection: collection(), ownership }), "ownership_conflict");
  assert.equal(classifyValidation({
    collection: collection({ status: "failed_permanent", jobs: [], httpStatus: 404 }), ownership,
  }), "source_migrated");
});

test("ATS reference extraction supports all four Phase 2 providers", () => {
  const refs = extractAtsReferences(`
    https://foo.breezy.hr/
    https://api.lever.co/v0/postings/bar?mode=json
    https://boards-api.greenhouse.io/v1/boards/baz/jobs?content=true
    https://www.comeet.com/jobs/qux/12.ABC
  `);
  assert.deepEqual(refs, [
    { provider: "breezy", identifier: "foo" },
    { provider: "lever", identifier: "bar" },
    { provider: "greenhouse", identifier: "baz" },
    { provider: "comeet", identifier: "qux/12.ABC" },
  ]);
});

test("ownership extraction treats Comeet job links and Greenhouse embeds as their board IDs", () => {
  const refs = extractAtsReferences(`
    https://www.comeet.com/jobs/guardio/57.000/Director-of-Marketing/AB.123
    https://boards.greenhouse.io/embed/job_board?for=capitolis
  `);
  assert.deepEqual(refs, [
    { provider: "comeet", identifier: "guardio/57.000" },
    { provider: "greenhouse", identifier: "capitolis" },
  ]);
});

test("a verified successful empty response is valid_empty", () => {
  assert.equal(classifyValidation({ collection: collection({ status: "empty", jobs: [] }), ownership: verified }), "valid_empty");
});

test("HTTP and response failures receive distinct classifications", () => {
  assert.equal(classifyValidation({ collection: collection({ status: "failed_permanent", jobs: [], httpStatus: 404 }), ownership: uncertain }), "stale_source");
  assert.equal(classifyValidation({ collection: collection({ status: "failed_transient", jobs: [], httpStatus: 429 }), ownership: uncertain }), "temporarily_failed");
  assert.equal(classifyValidation({ collection: collection({ status: "failed_permanent", jobs: [], httpStatus: 403 }), ownership: uncertain }), "inaccessible");
  assert.equal(classifyValidation({ collection: collection({ status: "failed_permanent", jobs: [], httpStatus: 200, error: "Invalid Greenhouse response: jobs is not an array" }), ownership: uncertain }), "parser_failure");
});

test("successful endpoints without ownership proof remain manual review", () => {
  assert.equal(classifyValidation({ collection: collection(), ownership: uncertain }), "needs_manual_review");
  assert.equal(classifyValidation({ collection: collection(), ownership: { status: "conflict" } }), "ownership_conflict");
  assert.equal(classifyValidation({ collection: collection(), ownership: { status: "migrated" } }), "source_migrated");
});

test("invalid response schemas are parser failures", () => {
  const invalid = collection({ status: "failed_permanent", jobs: [], error: "expected an array" });
  assert.equal(parserStatus(invalid), "invalid_schema");
});

test("a provider deactivation page remains HTTP 200 but classifies as stale, not a parser failure", () => {
  const deactivated = collection({ status: "failed_permanent", jobs: [], httpStatus: 200 });
  deactivated.sourceState = "stale";
  assert.equal(parserStatus(deactivated), "not_applicable_stale_board");
  assert.equal(classifyValidation({ collection: deactivated, ownership: uncertain }), "stale_source");
});

test("missing publication dates remain missing and are never inferred from updates", () => {
  const summary = summarizeJobData([{
    source_job_id: "one", job_title: "Analyst", source_updated_at: "2026-11-12T00:00:00Z",
    published_at: null, apply_url: "https://jobs.test/one",
  }]);
  assert.equal(summary.published_date_jobs, 0);
  assert.equal(summary.source_updated_date_jobs, 1);
});

test("blocked application URLs are not treated as confirmed vacancy closure", () => {
  assert.equal(applicationLinkStatus(403), "blocked_not_closed");
  assert.equal(applicationLinkStatus(429), "blocked_not_closed");
  assert.equal(applicationLinkStatus(404), "unavailable_not_closure_proof");
});

test("provider batching stops only on an ATS endpoint rate limit", () => {
  assert.equal(providerRateLimited([{ endpoint_http_status: 429 }]), true);
  assert.equal(providerRateLimited([{ endpoint_http_status: 200, application_http_status: 429 }]), false);
});

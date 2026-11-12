import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTechmap, TECHMAP_SOURCE_NAME, techmapCompanyId } from "../src/techmap-import.js";

function existing(overrides = {}) {
  return {
    company_id: overrides.company_id ?? "existing-1",
    company_name: overrides.company_name ?? "Acme",
    normalized_name: overrides.normalized_name ?? "acme",
    canonical_domain: overrides.canonical_domain ?? "acme.io",
    ats_provider: overrides.ats_provider ?? null,
    ats_identifier: overrides.ats_identifier ?? null,
    ...overrides,
  };
}

function registry(overrides = {}) {
  return {
    external_id: overrides.external_id ?? "515000001",
    company_name: overrides.company_name ?? "Acme",
    normalized_name: overrides.normalized_name ?? "acme",
    canonical_domain: overrides.canonical_domain === undefined ? "acme.io" : overrides.canonical_domain,
    website_url: overrides.website_url ?? "https://acme.io",
    careers_url: overrides.careers_url ?? "https://acme.io/careers",
    city: "Tel Aviv", addresses: [], category_id: 1, category_name: "AI/ML",
    employee_count_min: 11, employee_count_max: 50, employee_size_bucket: "11-50",
    employee_size_evidence: "verified_within_10_200", is_active: 1, is_multinational: 0,
    ats: overrides.ats ?? [{ provider: "greenhouse", identifier: "acme" }], raw: {},
    ...overrides,
  };
}

function state(companies = [], aliases = [], sources = []) {
  return {
    companies, aliases, sources, verifications: [], successfulSourceObservations: [],
    jobSources: [], jobs: [],
  };
}

test("Techmap external IDs produce stable source-scoped company IDs", () => {
  assert.equal(techmapCompanyId("515000001"), techmapCompanyId("515000001"));
  assert.notEqual(techmapCompanyId("515000001"), techmapCompanyId("515000002"));
});

test("exact domain and name safely reconcile while imported sources remain unverified", () => {
  const result = reconcileTechmap([registry()], state([existing()]));
  assert.equal(result.summary.high_risk_conflicts, 0);
  assert.equal(result.summary.matched_existing_company_groups, 1);
  const [decision] = result.decisions;
  assert.equal(decision.company_id, "existing-1");
  assert.ok(decision.sources.length >= 1);
  assert.ok(decision.sources.every((source) => source.evidence_status === "imported_unverified"));
});

test("exact names with conflicting domains are blocked rather than merged", () => {
  const result = reconcileTechmap(
    [registry({ canonical_domain: "new-acme.io" })],
    state([existing({ canonical_domain: "old-acme.io" })]),
  );
  assert.equal(result.summary.high_risk_conflicts, 1);
  assert.equal(result.conflicts[0].conflict_type, "exact_name_conflicting_domains");
});

test("a shared domain with distinct source names is a high-risk conflict", () => {
  const result = reconcileTechmap([
    registry({ external_id: "1", company_name: "Acme One", normalized_name: "acme one", ats: [] }),
    registry({ external_id: "2", company_name: "Acme Two", normalized_name: "acme two", ats: [] }),
  ], state());
  assert.equal(result.summary.high_risk_conflicts, 1);
  assert.equal(result.conflicts[0].conflict_type, "duplicate_domain_distinct_names");
});

test("an existing external alias makes repeated reconciliation idempotent", () => {
  const company = existing({ company_id: "imported-company" });
  const aliases = [{ source_name: TECHMAP_SOURCE_NAME, external_id: "515000001", company_id: company.company_id }];
  const result = reconcileTechmap([registry()], state([company], aliases));
  assert.equal(result.summary.proposed_new_companies, 0);
  assert.equal(result.summary.matched_existing_company_groups, 1);
  assert.equal(result.decisions[0].match_basis, "external_id");
});

test("exact name without domain evidence is held for review", () => {
  const result = reconcileTechmap(
    [registry({ canonical_domain: null, website_url: null, ats: [] })],
    state([existing({ canonical_domain: null })]),
  );
  assert.equal(result.summary.review_name_only_groups, 1);
  assert.equal(result.summary.proposed_new_companies, 0);
});

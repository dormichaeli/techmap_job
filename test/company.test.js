import test from "node:test";
import assert from "node:assert/strict";
import { canonicalDomain, companyIdFor, jerusalemDateTime, matchesCompanySize, normalizeCompanyName } from "../src/company.js";

test("company identity normalizes names and canonical domains deterministically", () => {
  assert.equal(normalizeCompanyName("Acme Technologies, Ltd."), "acme");
  assert.equal(canonicalDomain("HTTPS://WWW.Example.COM/jobs?q=1"), "example.com");
  assert.equal(
    companyIdFor({ company_name: "Different", website_url: "https://example.com" }),
    companyIdFor({ company_name: "Acme", canonical_domain: "www.example.com" }),
  );
});

test("strict and broad size modes keep unknown size explicit", () => {
  const inside = { employee_count_min: 11, employee_count_max: 50 };
  const overlap = { employee_count_min: 1, employee_count_max: 10 };
  const unknown = { employee_count_min: null, employee_count_max: null };
  assert.equal(matchesCompanySize(inside, { mode: "strict" }), true);
  assert.equal(matchesCompanySize(overlap, { mode: "strict" }), false);
  assert.equal(matchesCompanySize(overlap, { mode: "broad" }), true);
  assert.equal(matchesCompanySize(unknown, { mode: "broad" }), false);
  assert.equal(matchesCompanySize(unknown, { mode: "all" }), true);
});

test("Jerusalem display conversion preserves the stored UTC instant", () => {
  assert.equal(jerusalemDateTime("2026-11-11T12:00:00.000Z"), "2026-11-11, 14:00:00 GMT+2");
});

import test from "node:test";
import assert from "node:assert/strict";
import { collectCompany, extractAssignedJson, parseJsonLdJobPostings, stripHtml } from "../src/adapters.js";

test("Comeet embedded JSON extraction respects strings containing brackets", () => {
  const html = '<script>window.COMPANY_POSITIONS_DATA = [{"uid":"A.1","name":"Analyst [Growth]","x":"} still text"}];</script>';
  assert.deepEqual(extractAssignedJson(html, "COMPANY_POSITIONS_DATA"), [
    { uid: "A.1", name: "Analyst [Growth]", x: "} still text" },
  ]);
});

test("HTML stripping removes executable content and decodes common entities", () => {
  assert.equal(stripHtml("<p>Data &amp; Analytics</p><script>alert(1)</script>"), "Data & Analytics");
});

test("JSON-LD adapter preserves datePosted as publication evidence", () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting", title: "Growth Analyst", datePosted: "2026-11-10",
    url: "https://example.test/jobs/1", identifier: { value: "1" },
    jobLocation: { address: { addressLocality: "Tel Aviv", addressCountry: "Israel" } },
  })}</script>`;
  const [row] = parseJsonLdJobPostings(html, { company_name: "Acme" }, "https://example.test/careers");
  assert.equal(row.published_at, "2026-11-10T00:00:00.000Z");
  assert.equal(row.published_at_source, "jsonld.datePosted");
  assert.equal(row.source_updated_at, null);
});

test("parser failures preserve the successful endpoint HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html><body>unexpected schema</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  try {
    const result = await collectCompany({
      company_name: "Acme", source_provider: "comeet", source_id: "acme/1.000",
      source_url: "https://www.comeet.com/jobs/acme/1.000",
    });
    assert.equal(result.status, "failed_permanent");
    assert.equal(result.httpStatus, 200);
    assert.match(result.error, /COMPANY_POSITIONS_DATA/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Comeet deactivation pages are stale sources while preserving HTTP 200", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><body>This Spark Hire Recruit account has been deactivated.</body></html>",
    { status: 200, headers: { "content-type": "text/html" } },
  );
  try {
    const result = await collectCompany({
      company_name: "Old Board", source_provider: "comeet", source_id: "old/00.000",
      source_url: "https://www.comeet.com/jobs/old/00.000",
    });
    assert.equal(result.status, "failed_permanent");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.sourceState, "stale");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

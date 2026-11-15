import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRST_CLOUD_MAX_HTTP_ATTEMPTS,
  ROTATING_VERIFIED_POLICY,
  loadRotatingCollectionCandidates,
  planCollectionCohort,
  planRotatingCollectionCohort,
} from "../src/collection-cohort.js";
import { beginRun, finishRun, importCompanies, openStore } from "../src/store.js";

const FIXTURE_TIME = "2026-11-01T00:00:00.000Z";
const SELECTION_TIME = "2026-11-15T16:00:00.000Z";

function withDatabase(callback) {
  const directory = mkdtempSync(join(tmpdir(), "techmap-rotation-test-"));
  const db = openStore(join(directory, "rotation.sqlite"));
  try {
    callback(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function addSource(db, {
  id,
  provider,
  minimum = 10,
  maximum = 200,
  confidence = "medium",
  evidenceStatus = "live_verified",
  enabled = 1,
} = {}) {
  const companyId = `company-${id}`;
  importCompanies(db, [{
    company_id: companyId,
    company_name: `Company ${id}`,
    canonical_domain: `${id}.invalid`,
    website_url: `https://${id}.invalid`,
    careers_url: `https://${id}.invalid/careers`,
    employee_count_min: minimum,
    employee_count_max: maximum,
    employee_size_confidence: confidence,
    company_discovered_at: FIXTURE_TIME,
    company_source_status: "verified",
  }], FIXTURE_TIME);
  db.prepare(`
    INSERT INTO company_sources (
      source_id, company_id, source_kind, provider, source_identifier, source_url,
      careers_url, evidence_source, evidence_status, is_enabled, imported_at
    ) VALUES (?, ?, 'ats', ?, ?, ?, ?, 'fixture', ?, ?, ?)
  `).run(
    `source-${id}`,
    companyId,
    provider,
    provider === "jsonld" ? null : `board-${id}`,
    `https://${id}.invalid/jobs`,
    `https://${id}.invalid/careers`,
    evidenceStatus,
    enabled,
    FIXTURE_TIME,
  );
  return { companyId, companySourceId: `source-${id}`, companyName: `Company ${id}`, provider };
}

function observe(db, sources, { status = "completed", observedAt = FIXTURE_TIME } = {}) {
  const runId = beginRun(db, observedAt);
  const insert = db.prepare(`
    INSERT INTO source_observations (
      run_id, company_name, source_provider, source_url, health_status, http_status,
      job_count, error, observed_at, company_id, company_source_id
    ) VALUES (?, ?, ?, ?, ?, 200, 0, ?, ?, ?, ?)
  `);
  for (const source of sources) {
    insert.run(
      runId,
      source.companyName,
      source.provider,
      `https://${source.companySourceId}.invalid/jobs`,
      status === "completed" ? "empty" : "failed",
      status === "completed" ? null : "fixture failure",
      observedAt,
      source.companyId,
      source.companySourceId,
    );
  }
  finishRun(db, runId, status, observedAt);
}

function simulate(candidates, cycles = 14) {
  const state = candidates.map((row) => ({ ...row }));
  const plans = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const selectionTime = new Date(Date.parse(SELECTION_TIME) + cycle * 24 * 60 * 60 * 1000).toISOString();
    const plan = planRotatingCollectionCohort(state, { selectionTime, limit: 5 });
    plans.push(plan);
    for (const selected of plan.selected) {
      const source = state.find((row) => row.company_source_id === selected.company_source_id);
      source.last_completed_observed_at = selectionTime;
      source.completed_observation_count += 1;
    }
  }
  return plans;
}

test("rotating cohort covers 66 eligible sources in 14 deterministic successful cycles", () => {
  withDatabase((db) => {
    const providerCounts = { ashby: 9, breezy: 2, comeet: 33, greenhouse: 14, lever: 4, jsonld: 4 };
    const sources = [];
    let index = 0;
    for (const [provider, count] of Object.entries(providerCounts)) {
      for (let providerIndex = 0; providerIndex < count; providerIndex += 1) {
        const size = index < 31 ? [10, 200] : index < 55 ? [null, null] : [201, 1000];
        sources.push(addSource(db, {
          id: `${provider}-${String(providerIndex).padStart(2, "0")}`,
          provider,
          minimum: size[0],
          maximum: size[1],
          confidence: size[0] === null ? "unknown" : "medium",
        }));
        index += 1;
      }
    }
    observe(db, sources.slice(0, 26), { observedAt: "2026-11-12T00:00:00.000Z" });

    const candidates = loadRotatingCollectionCandidates(db, { selectionTime: SELECTION_TIME });
    const first = simulate(candidates);
    const replay = simulate(candidates);
    assert.deepEqual(
      first.map((plan) => plan.cohort_fingerprint),
      replay.map((plan) => plan.cohort_fingerprint),
    );
    const selected = first.flatMap((plan) => plan.selected);
    const selectedIds = new Set(selected.map((row) => row.company_source_id));
    assert.equal(selectedIds.size, 66);
    assert.ok(first.every((plan) => new Set(plan.selected.map((row) => row.company_source_id)).size === 5));
    assert.deepEqual(
      new Set(selected.map((row) => row.source_provider)),
      new Set(Object.keys(providerCounts)),
    );
    for (const [provider, count] of Object.entries(providerCounts)) {
      assert.equal(new Set(selected.filter((row) => row.source_provider === provider)
        .map((row) => row.company_source_id)).size, count);
    }
    assert.equal(new Set(selected.filter((row) => row.size_priority === "unknown")
      .map((row) => row.company_source_id)).size, 24);
    assert.equal(FIRST_CLOUD_MAX_HTTP_ATTEMPTS, 15);
  });
});

test("partial-success observations do not advance rotation history", () => {
  withDatabase((db) => {
    const sources = ["ashby", "breezy", "comeet", "greenhouse", "lever", "jsonld"]
      .map((provider) => addSource(db, { id: provider, provider }));
    const before = planCollectionCohort(db, {
      policy: ROTATING_VERIFIED_POLICY,
      limit: 5,
      selectionTime: SELECTION_TIME,
    });
    observe(db, [sources[0]], { status: "partial_success", observedAt: "2026-11-14T00:00:00.000Z" });
    const afterFailure = planCollectionCohort(db, {
      policy: ROTATING_VERIFIED_POLICY,
      limit: 5,
      selectionTime: SELECTION_TIME,
    });
    assert.equal(afterFailure.cohort_fingerprint, before.cohort_fingerprint);
    assert.deepEqual(afterFailure.selected, before.selected);

    observe(db, [sources[0]], { status: "completed", observedAt: "2026-11-14T00:00:00.000Z" });
    const afterSuccess = planCollectionCohort(db, {
      policy: ROTATING_VERIFIED_POLICY,
      limit: 5,
      selectionTime: SELECTION_TIME,
    });
    assert.notEqual(afterSuccess.cohort_fingerprint, before.cohort_fingerprint);
    assert.ok(!afterSuccess.selected.some((row) => row.company_source_id === sources[0].companySourceId));
  });
});

test("eligibility changes are applied without weakening verification requirements", () => {
  withDatabase((db) => {
    const providers = ["ashby", "breezy", "comeet", "greenhouse", "lever", "jsonld"];
    const sources = providers.map((provider) => addSource(db, { id: provider, provider }));
    const initial = planCollectionCohort(db, {
      policy: ROTATING_VERIFIED_POLICY,
      selectionTime: SELECTION_TIME,
    });
    const disabled = initial.selected[0].company_source_id;
    db.prepare("UPDATE company_sources SET is_enabled=0 WHERE source_id=?").run(disabled);
    const added = addSource(db, {
      id: "new-unknown",
      provider: "comeet",
      minimum: null,
      maximum: null,
      confidence: "unknown",
    });
    addSource(db, { id: "unverified", provider: "ashby", evidenceStatus: "imported_unverified" });
    observe(db, sources.filter((source) => source.companySourceId !== disabled), {
      observedAt: "2026-11-14T00:00:00.000Z",
    });

    const changed = planCollectionCohort(db, {
      policy: ROTATING_VERIFIED_POLICY,
      selectionTime: SELECTION_TIME,
    });
    assert.ok(!changed.selected.some((row) => row.company_source_id === disabled));
    assert.ok(changed.selected.some((row) => row.company_source_id === added.companySourceId));
    assert.ok(!changed.selected.some((row) => row.company_source_id === "source-unverified"));
    assert.ok(changed.selected.every((row) => ["live_verified", "manual_verified"].includes(row.evidence_status)));
    assert.equal(sources.length, 6);
  });
});

test("least-recent ordering prevents starvation and uses stable source-ID tie-breaking", () => {
  const candidates = [
    { company_source_id: "source-z-old", source_provider: "comeet", last_completed_observed_at: "2026-01-01T00:00:00.000Z", completed_observation_count: 1, employee_count_min: 201, employee_count_max: 1000 },
    { company_source_id: "source-b", source_provider: "comeet", last_completed_observed_at: null, completed_observation_count: 0, employee_count_min: 10, employee_count_max: 200 },
    { company_source_id: "source-a", source_provider: "comeet", last_completed_observed_at: null, completed_observation_count: 0, employee_count_min: 10, employee_count_max: 200 },
    { company_source_id: "source-unknown", source_provider: "jsonld", last_completed_observed_at: null, completed_observation_count: 0, employee_count_min: null, employee_count_max: null },
    { company_source_id: "source-recent-1", source_provider: "ashby", last_completed_observed_at: "2026-11-14T00:00:00.000Z", completed_observation_count: 1, employee_count_min: 10, employee_count_max: 200 },
    { company_source_id: "source-recent-2", source_provider: "lever", last_completed_observed_at: "2026-11-14T00:00:00.000Z", completed_observation_count: 1, employee_count_min: 10, employee_count_max: 200 },
  ];
  const plan = planRotatingCollectionCohort(candidates, { selectionTime: SELECTION_TIME, limit: 5 });
  assert.deepEqual(plan.selected.slice(0, 3).map((row) => row.company_source_id), [
    "source-unknown", "source-a", "source-b",
  ]);
  assert.ok(plan.selected.some((row) => row.company_source_id === "source-z-old"));
  assert.equal(plan.selected.find((row) => row.company_source_id === "source-z-old").selection_reason, "starvation_prevention");
  assert.throws(
    () => planRotatingCollectionCohort(candidates, { limit: 5 }),
    /requires an explicit selectionTime/,
  );
  assert.throws(
    () => planRotatingCollectionCohort(candidates, { selectionTime: SELECTION_TIME, limit: 6 }),
    /exceeds maximum 5/,
  );
});

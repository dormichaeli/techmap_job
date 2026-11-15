import { createHash } from "node:crypto";

const FIRST_CLOUD_PROVIDERS = Object.freeze([
  "ashby",
  "breezy",
  "comeet",
  "greenhouse",
  "lever",
  "jsonld",
]);

export const FIRST_CLOUD_POLICY = "first_cloud_v1";
export const ROTATING_VERIFIED_POLICY = "rotating_verified_v1";
export const FIRST_CLOUD_MAX_SOURCES = 5;
export const FIRST_CLOUD_MAX_HTTP_ATTEMPTS = FIRST_CLOUD_MAX_SOURCES * 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const STARVATION_DAYS = 30;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

function boundedLimit(value) {
  const limit = positiveInteger(value, "Collection limit");
  if (limit > FIRST_CLOUD_MAX_SOURCES) {
    throw new Error(`Collection limit ${limit} exceeds maximum ${FIRST_CLOUD_MAX_SOURCES}`);
  }
  return limit;
}

function explicitSelectionTime(value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${ROTATING_VERIFIED_POLICY} requires an explicit selectionTime`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid selectionTime: ${value}`);
  return date.toISOString();
}

function eligibleSourceSql(history = false) {
  return `
    SELECT
      c.company_id,
      c.company_name,
      c.website_url AS website,
      COALESCE(cs.careers_url, c.careers_url) AS careers_url,
      cs.provider AS source_provider,
      cs.source_identifier AS source_id,
      cs.source_url,
      cs.source_id AS company_source_id,
      cs.evidence_status,
      c.employee_count_min,
      c.employee_count_max,
      c.employee_size_confidence
      ${history ? `,
      COALESCE(history.completed_observation_count, 0) AS completed_observation_count,
      history.last_completed_observed_at` : ""}
    FROM company_sources cs
    JOIN companies c ON c.company_id = cs.company_id
    ${history ? `LEFT JOIN (
      SELECT
        so.company_source_id,
        COUNT(*) AS completed_observation_count,
        MAX(so.observed_at) AS last_completed_observed_at
      FROM source_observations so
      JOIN runs r ON r.run_id = so.run_id
      WHERE r.status = 'completed'
        AND so.health_status IN ('success', 'empty')
        AND so.company_source_id IS NOT NULL
        AND so.observed_at <= ?
      GROUP BY so.company_source_id
    ) history ON history.company_source_id = cs.source_id` : ""}
    WHERE cs.is_enabled = 1
      AND cs.source_kind = 'ats'
      AND cs.effective_to IS NULL
      AND cs.evidence_status IN ('live_verified', 'manual_verified')
      AND cs.provider IN ('ashby', 'breezy', 'comeet', 'greenhouse', 'lever', 'jsonld')
      AND (
        (cs.provider = 'jsonld' AND COALESCE(cs.source_url, cs.careers_url) IS NOT NULL)
        OR (cs.provider <> 'jsonld' AND cs.source_identifier IS NOT NULL)
      )
    ORDER BY cs.provider, cs.source_id
  `;
}

function legacyCohort(db, limit) {
  const rows = db.prepare(eligibleSourceSql()).all();
  const byProvider = new Map(FIRST_CLOUD_PROVIDERS.map((provider) => [provider, []]));
  for (const row of rows) byProvider.get(row.source_provider)?.push(row);
  const selected = [];
  let offset = 0;
  while (selected.length < limit) {
    let added = false;
    for (const provider of FIRST_CLOUD_PROVIDERS) {
      const row = byProvider.get(provider)[offset];
      if (!row) continue;
      selected.push(row);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
    offset += 1;
  }
  return selected;
}

export function loadRotatingCollectionCandidates(db, { selectionTime } = {}) {
  const selectedAt = explicitSelectionTime(selectionTime);
  return db.prepare(eligibleSourceSql(true)).all(selectedAt).map((row) => ({
    ...row,
    completed_observation_count: Number(row.completed_observation_count),
    last_completed_observed_at: row.last_completed_observed_at ?? null,
  }));
}

function sourceSizeClass(row) {
  const minimum = row.employee_count_min;
  const maximum = row.employee_count_max;
  if (minimum === null || minimum === undefined || maximum === null || maximum === undefined) return "unknown";
  if (Number(minimum) >= 10 && Number(maximum) <= 200) return "verified_10_200";
  return "other_known";
}

function sizePriority(row) {
  const sizeClass = sourceSizeClass(row);
  if (sizeClass === "verified_10_200") return 0;
  if (sizeClass === "unknown") return 1;
  return 2;
}

function timestampValue(value) {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid persisted observation time: ${value}`);
  return timestamp;
}

function compareTimestamp(left, right) {
  const leftValue = timestampValue(left);
  const rightValue = timestampValue(right);
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}

function maxTimestamp(current, candidate) {
  if (candidate === null || candidate === undefined) return current;
  if (current === null || current === undefined) return candidate;
  return timestampValue(candidate) > timestampValue(current) ? candidate : current;
}

function cohortFingerprint(selected) {
  return createHash("sha256")
    .update(selected.map((row) => row.company_source_id).join("\n"))
    .digest("hex");
}

export function planRotatingCollectionCohort(candidates, {
  selectionTime,
  limit = FIRST_CLOUD_MAX_SOURCES,
} = {}) {
  const selectedAt = explicitSelectionTime(selectionTime);
  const selectedAtMs = timestampValue(selectedAt);
  const bounded = boundedLimit(limit);
  if (!Array.isArray(candidates)) throw new Error("Rotation candidates must be an array");

  const remaining = candidates.map((candidate) => ({ ...candidate }));
  if (remaining.length < bounded) {
    throw new Error(`Policy ${ROTATING_VERIFIED_POLICY} found ${remaining.length} eligible sources; ${bounded} required`);
  }
  const sourceIds = new Set();
  for (const candidate of remaining) {
    if (!candidate.company_source_id) throw new Error("Eligible source is missing company_source_id");
    if (sourceIds.has(candidate.company_source_id)) {
      throw new Error(`Duplicate eligible company_source_id: ${candidate.company_source_id}`);
    }
    sourceIds.add(candidate.company_source_id);
  }

  const providerLastSelected = new Map(FIRST_CLOUD_PROVIDERS.map((provider) => [provider, null]));
  for (const candidate of remaining) {
    providerLastSelected.set(
      candidate.source_provider,
      maxTimestamp(providerLastSelected.get(candidate.source_provider), candidate.last_completed_observed_at),
    );
  }

  const selected = [];
  while (selected.length < bounded) {
    remaining.sort((left, right) => {
      const sourceRecency = compareTimestamp(
        left.last_completed_observed_at,
        right.last_completed_observed_at,
      );
      if (sourceRecency !== 0) return sourceRecency;
      const providerRecency = compareTimestamp(
        providerLastSelected.get(left.source_provider),
        providerLastSelected.get(right.source_provider),
      );
      if (providerRecency !== 0) return providerRecency;
      const companySize = sizePriority(left) - sizePriority(right);
      if (companySize !== 0) return companySize;
      const provider = compareText(left.source_provider, right.source_provider);
      if (provider !== 0) return provider;
      return compareText(left.company_source_id, right.company_source_id);
    });
    const next = remaining.shift();
    const lastObservedMs = timestampValue(next.last_completed_observed_at);
    const ageDays = Number.isFinite(lastObservedMs)
      ? Math.max(0, (selectedAtMs - lastObservedMs) / DAY_MS)
      : null;
    const neverObserved = next.last_completed_observed_at === null
      || next.last_completed_observed_at === undefined;
    selected.push({
      ...next,
      size_priority: sourceSizeClass(next),
      selection_reason: neverObserved
        ? "never_observed"
        : ageDays >= STARVATION_DAYS ? "starvation_prevention" : "least_recently_observed",
      observation_age_days: ageDays,
    });
    providerLastSelected.set(next.source_provider, selectedAt);
  }

  return {
    policy: ROTATING_VERIFIED_POLICY,
    selection_time: selectedAt,
    eligible_source_count: candidates.length,
    limit: bounded,
    cohort_fingerprint: cohortFingerprint(selected),
    selected,
  };
}

export function planCollectionCohort(db, {
  policy = FIRST_CLOUD_POLICY,
  limit = FIRST_CLOUD_MAX_SOURCES,
  selectionTime,
} = {}) {
  const bounded = boundedLimit(limit);
  if (policy === ROTATING_VERIFIED_POLICY) {
    const candidates = loadRotatingCollectionCandidates(db, { selectionTime });
    return planRotatingCollectionCohort(candidates, { selectionTime, limit: bounded });
  }
  if (policy !== FIRST_CLOUD_POLICY) throw new Error(`Unsupported collection cohort policy: ${policy}`);
  const selected = legacyCohort(db, bounded);
  if (selected.length !== bounded) {
    throw new Error(`Policy ${policy} found ${selected.length} eligible sources; ${bounded} required`);
  }
  return {
    policy,
    selection_time: null,
    eligible_source_count: selected.length,
    limit: bounded,
    cohort_fingerprint: cohortFingerprint(selected),
    selected,
  };
}

export function selectCollectionCohort(db, options = {}) {
  return planCollectionCohort(db, options).selected;
}

export const COLLECTION_COHORT_FIELDS = Object.freeze([
  "company_id",
  "company_name",
  "website",
  "careers_url",
  "source_provider",
  "source_id",
  "source_url",
  "company_source_id",
  "evidence_status",
]);

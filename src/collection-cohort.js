const FIRST_CLOUD_PROVIDERS = Object.freeze([
  "ashby",
  "breezy",
  "comeet",
  "greenhouse",
  "lever",
  "jsonld",
]);

export const FIRST_CLOUD_POLICY = "first_cloud_v1";
export const FIRST_CLOUD_MAX_SOURCES = 5;
export const FIRST_CLOUD_MAX_HTTP_ATTEMPTS = FIRST_CLOUD_MAX_SOURCES * 3;

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received: ${value}`);
  }
  return parsed;
}

export function selectCollectionCohort(db, {
  policy = FIRST_CLOUD_POLICY,
  limit = FIRST_CLOUD_MAX_SOURCES,
} = {}) {
  if (policy !== FIRST_CLOUD_POLICY) throw new Error(`Unsupported collection cohort policy: ${policy}`);
  const boundedLimit = positiveInteger(limit, "Collection limit");
  if (boundedLimit > FIRST_CLOUD_MAX_SOURCES) {
    throw new Error(`Collection limit ${boundedLimit} exceeds ${FIRST_CLOUD_POLICY} maximum ${FIRST_CLOUD_MAX_SOURCES}`);
  }

  const rows = db.prepare(`
    SELECT
      c.company_id,
      c.company_name,
      c.website_url AS website,
      COALESCE(cs.careers_url, c.careers_url) AS careers_url,
      cs.provider AS source_provider,
      cs.source_identifier AS source_id,
      cs.source_url,
      cs.source_id AS company_source_id,
      cs.evidence_status
    FROM company_sources cs
    JOIN companies c ON c.company_id = cs.company_id
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
  `).all();

  const byProvider = new Map(FIRST_CLOUD_PROVIDERS.map((provider) => [provider, []]));
  for (const row of rows) byProvider.get(row.source_provider)?.push(row);
  const selected = [];
  let offset = 0;
  while (selected.length < boundedLimit) {
    let added = false;
    for (const provider of FIRST_CLOUD_PROVIDERS) {
      const row = byProvider.get(provider)[offset];
      if (!row) continue;
      selected.push(row);
      added = true;
      if (selected.length === boundedLimit) break;
    }
    if (!added) break;
    offset += 1;
  }
  if (selected.length !== boundedLimit) {
    throw new Error(`Policy ${policy} found ${selected.length} eligible sources; ${boundedLimit} required`);
  }
  return selected;
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

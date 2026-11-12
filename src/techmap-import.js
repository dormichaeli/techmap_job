import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalDomain, normalizeCompanyName, parseTechmapSize, sizeEvidence } from "./company.js";
import { migrateTechmapSchema } from "./store.js";

export const TECHMAP_SOURCE_NAME = "Techmap / mluggy/techmap";
export const TECHMAP_SOURCE_URL = "https://github.com/mluggy/techmap";
export const REVIEW_DECISIONS = new Set([
  "same_operational_company",
  "distinct_entities_shared_domain",
  "stale_historical_record",
  "defer_for_review",
]);

const ATS_FIELDS = {
  comeet: "comeetId",
  greenhouse: "greenhouseId",
  lever: "leverId",
  breezy: "breezyId",
};

const SOURCE_STATUS_RANK = {
  imported_unverified: 10,
  configured_existing: 50,
  manual_inaccessible: 60,
  manual_verified_unsupported: 70,
  live_verified: 90,
  manual_verified: 100,
};

export function techmapCompanyId(externalId) {
  return createHash("sha256").update(`techmap:${externalId}`).digest("hex");
}

export function companySourceId(companyId, kind, provider, identifier, url) {
  const identity = [companyId, kind, provider ?? "", identifier ?? "", url ?? ""].join("\u001f");
  return createHash("sha256").update(identity).digest("hex");
}

function aliasId(companyId, externalId, normalizedAlias) {
  return createHash("sha256")
    .update([TECHMAP_SOURCE_NAME, companyId, externalId, normalizedAlias].join("\u001f"))
    .digest("hex");
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function nullable(value) {
  return value === "" || value === undefined ? null : value;
}

function firstAddress(record) {
  return Array.isArray(record.addresses) ? record.addresses.find((address) => address?.city) ?? record.addresses[0] : null;
}

function externalSourceUrl(externalId) {
  return `${TECHMAP_SOURCE_URL}/blob/main/companies/${externalId}.json`;
}

function atsUrl(provider, identifier) {
  const urls = {
    comeet: `https://www.comeet.com/jobs/${identifier}`,
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs?content=true`,
    lever: `https://api.lever.co/v0/postings/${identifier}?mode=json`,
    breezy: `https://${identifier}.breezy.hr/json`,
  };
  return urls[provider] ?? null;
}

function normalizedUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return String(value).trim();
  }
}

function atsKey(provider, identifier) {
  if (!provider || !identifier) return null;
  return `ats:${String(provider).trim().toLowerCase()}:${String(identifier).trim().toLowerCase()}`;
}

function sourceOwnershipKey(source) {
  return source.source_kind === "ats" && source.provider && source.source_identifier
    ? atsKey(source.provider, source.source_identifier)
    : source.source_url ? `url:${normalizedUrl(source.source_url)}` : null;
}

function addToMap(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function choosePrimary(records) {
  return [...records].sort((a, b) =>
    Number(b.is_active) - Number(a.is_active)
      || Number(Boolean(b.careers_url)) - Number(Boolean(a.careers_url))
      || b.ats.length - a.ats.length
      || a.external_id.localeCompare(b.external_id))[0];
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  add(value) {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value) {
    this.add(value);
    const parent = this.parent.get(value);
    if (parent !== value) this.parent.set(value, this.find(parent));
    return this.parent.get(value);
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      const [first, second] = [leftRoot, rightRoot].sort();
      this.parent.set(second, first);
    }
  }
}

export function loadTechmapRegistry(root) {
  const categories = JSON.parse(readFileSync(join(root, "categories.json"), "utf8"));
  const rows = [];
  for (const file of readdirSync(join(root, "companies")).filter((name) => name.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(join(root, "companies", file), "utf8"));
    const range = parseTechmapSize(raw.size);
    const externalId = basename(file, ".json");
    rows.push({
      external_id: externalId,
      company_name: raw.name,
      normalized_name: normalizeCompanyName(raw.name),
      canonical_domain: canonicalDomain(raw.websiteUrl),
      website_url: nullable(raw.websiteUrl),
      careers_url: nullable(raw.careersUrl),
      city: nullable(firstAddress(raw)?.city),
      addresses: Array.isArray(raw.addresses) ? raw.addresses : [],
      category_id: raw.categoryId ?? null,
      category_name: categories[String(raw.categoryId)] ?? null,
      employee_count_min: range.min,
      employee_count_max: range.max,
      employee_size_bucket: range.bucket,
      employee_size_evidence: sizeEvidence(range.min, range.max),
      is_active: raw.isActive === false ? 0 : 1,
      is_multinational: raw.isMultinational ? 1 : 0,
      ats: Object.entries(ATS_FIELDS)
        .filter(([, field]) => raw[field])
        .map(([provider, field]) => ({ provider, identifier: String(raw[field]) })),
      raw,
    });
  }
  return rows;
}

export function readExistingState(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const companies = db.prepare("SELECT * FROM companies ORDER BY company_id").all().map((row) => ({
      ...row,
      normalized_name: normalizeCompanyName(row.company_name),
      canonical_domain: canonicalDomain(row.canonical_domain ?? row.website_url),
    }));
    const aliases = tableExists(db, "company_external_ids")
      ? db.prepare("SELECT * FROM company_external_ids").all() : [];
    const companyAliases = tableExists(db, "company_aliases")
      ? db.prepare("SELECT * FROM company_aliases").all() : [];
    const sources = tableExists(db, "company_sources")
      ? db.prepare("SELECT * FROM company_sources").all() : [];
    const verifications = db.prepare("SELECT * FROM company_source_verifications").all();
    const successfulSourceObservations = db.prepare(`
      SELECT company_name, source_provider, source_url, MAX(observed_at) observed_at
      FROM source_observations WHERE health_status IN ('success', 'empty')
      GROUP BY company_name, source_provider, source_url
    `).all();
    const jobSources = db.prepare(`
      SELECT company_name, source_provider, source_url, MAX(last_seen_at) observed_at
      FROM jobs GROUP BY company_name, source_provider, source_url
    `).all();
    const jobs = db.prepare("SELECT job_id, company_id, company_name FROM jobs").all();
    return { companies, aliases, companyAliases, sources, verifications, successfulSourceObservations, jobSources, jobs };
  } finally {
    db.close();
  }
}

function buildSourceCandidates(companyId, records) {
  const candidates = [];
  for (const record of records) {
    if (record.careers_url) {
      candidates.push({
        source_id: companySourceId(companyId, "careers_page", null, null, record.careers_url),
        company_id: companyId,
        source_kind: "careers_page",
        provider: null,
        source_identifier: null,
        source_url: record.careers_url,
        careers_url: record.careers_url,
        evidence_source: TECHMAP_SOURCE_NAME,
        evidence_status: "imported_unverified",
        evidence_url: externalSourceUrl(record.external_id),
        external_id: record.external_id,
        raw_json: JSON.stringify(record.raw),
      });
    }
    for (const ats of record.ats) {
      const url = atsUrl(ats.provider, ats.identifier);
      candidates.push({
        source_id: companySourceId(companyId, "ats", ats.provider, ats.identifier, url),
        company_id: companyId,
        source_kind: "ats",
        provider: ats.provider,
        source_identifier: ats.identifier,
        source_url: url,
        careers_url: record.careers_url,
        evidence_source: TECHMAP_SOURCE_NAME,
        evidence_status: "imported_unverified",
        evidence_url: externalSourceUrl(record.external_id),
        external_id: record.external_id,
        raw_json: JSON.stringify(record.raw),
      });
    }
  }
  return [...new Map(candidates.map((row) => [row.source_id, row])).values()];
}

function conflictFor(componentId, type, records, existingIds, details) {
  return {
    severity: "high",
    scope: "company_identity",
    conflict_group_id: componentId,
    conflict_type: type,
    canonical_domain: unique(records.map((row) => row.canonical_domain)).join(";"),
    external_ids: records.map((row) => row.external_id).join(";"),
    source_names: records.map((row) => row.company_name).join(";"),
    existing_company_ids: existingIds.join(";"),
    details,
  };
}

function componentIdFor(records, existingIds) {
  const identity = [
    ...records.map((row) => `techmap:${row.external_id}`),
    ...existingIds.map((id) => `local:${id}`),
  ].sort().join("\n");
  return `identity-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

function exactNameTargets(records, existingByName) {
  return unique(records.flatMap((record) =>
    (existingByName.get(record.normalized_name) ?? []).map((company) => company.company_id)));
}

function sourceOwnersFromState(state) {
  const owners = new Map();
  const companiesById = new Map(state.companies.map((row) => [row.company_id, row]));
  const companiesByExactName = new Map();
  for (const company of state.companies) addToMap(companiesByExactName, company.company_name, company);
  const add = (key, companyId) => {
    if (!key || !companyId) return;
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(companyId);
  };
  for (const company of state.companies) {
    add(atsKey(company.ats_provider, company.ats_identifier), company.company_id);
    if (company.careers_url) add(`url:${normalizedUrl(company.careers_url)}`, company.company_id);
    if (company.source_url) add(`url:${normalizedUrl(company.source_url)}`, company.company_id);
  }
  for (const source of state.sources) add(sourceOwnershipKey(source), source.company_id);
  for (const verification of state.verifications) {
    add(atsKey(verification.source_provider, verification.source_identifier), verification.company_id);
    if (verification.source_url) add(`url:${normalizedUrl(verification.source_url)}`, verification.company_id);
    if (verification.careers_url) add(`url:${normalizedUrl(verification.careers_url)}`, verification.company_id);
  }
  for (const observation of [...state.successfulSourceObservations, ...state.jobSources]) {
    const matches = companiesByExactName.get(observation.company_name) ?? [];
    if (matches.length !== 1) continue;
    const company = companiesById.get(matches[0].company_id);
    const identifier = company?.ats_provider === observation.source_provider ? company.ats_identifier : null;
    add(atsKey(observation.source_provider, identifier), matches[0].company_id);
    if (observation.source_url) add(`url:${normalizedUrl(observation.source_url)}`, matches[0].company_id);
  }
  return owners;
}

function isolateSourceConflicts(decisions, state) {
  const owners = sourceOwnersFromState(state);
  const candidatesByKey = new Map();
  for (const decision of decisions.filter((row) => ["insert_new", "match_existing"].includes(row.action))) {
    for (const source of decision.sources) addToMap(candidatesByKey, sourceOwnershipKey(source), { decision, source });
  }

  const quarantined = new Set();
  const conflicts = [];
  for (const [key, entries] of candidatesByKey) {
    if (!key) continue;
    const candidateOwners = unique(entries.map((entry) => entry.source.company_id));
    const allOwners = unique([...candidateOwners, ...(owners.get(key) ?? [])]);
    if (allOwners.length <= 1) continue;
    for (const entry of entries) quarantined.add(entry.source.source_id);
    const externalIds = unique(entries.map((entry) => entry.source.external_id));
    const groupId = `source-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
    conflicts.push({
      severity: "high",
      scope: "source_candidate",
      conflict_group_id: groupId,
      conflict_type: key.startsWith("ats:") ? "shared_ats_identifier" : "shared_source_url",
      canonical_domain: "",
      external_ids: externalIds.join(";"),
      source_names: unique(entries.map((entry) => entry.decision.record.company_name)).join(";"),
      existing_company_ids: unique([...(owners.get(key) ?? [])]).join(";"),
      details: `Source identity '${key}' is attributable to more than one company; all dependent candidates are quarantined`,
    });
  }
  for (const decision of decisions) {
    if (!decision.sources) continue;
    decision.sources = decision.sources.filter((source) => !quarantined.has(source.source_id));
  }
  return { conflicts, quarantinedCount: quarantined.size };
}

export function reconcileTechmap(registry, state) {
  const union = new UnionFind();
  const signalOwner = new Map();
  const companiesById = new Map(state.companies.map((row) => [row.company_id, row]));
  const existingByName = new Map();
  const aliasRowsByExternal = new Map();
  const register = (node, signal) => {
    if (!signal) return;
    if (signalOwner.has(signal)) union.union(node, signalOwner.get(signal));
    else signalOwner.set(signal, node);
  };

  for (const company of state.companies) {
    const node = `local:${company.company_id}`;
    union.add(node);
    register(node, company.canonical_domain ? `domain:${company.canonical_domain}` : null);
    register(node, atsKey(company.ats_provider, company.ats_identifier));
    addToMap(existingByName, company.normalized_name, company);
  }
  for (const source of state.sources) {
    register(`local:${source.company_id}`, atsKey(source.provider, source.source_identifier));
  }
  for (const verification of state.verifications) {
    register(`local:${verification.company_id}`, atsKey(verification.source_provider, verification.source_identifier));
  }
  for (const alias of state.aliases.filter((row) => row.source_name === TECHMAP_SOURCE_NAME)) {
    addToMap(aliasRowsByExternal, alias.external_id, alias);
  }

  for (const record of registry) {
    const node = `techmap:${record.external_id}`;
    union.add(node);
    register(node, record.canonical_domain ? `domain:${record.canonical_domain}` : null);
    for (const ats of record.ats) register(node, atsKey(ats.provider, ats.identifier));
    for (const alias of aliasRowsByExternal.get(record.external_id) ?? []) {
      union.union(node, `local:${alias.company_id}`);
    }
  }

  const components = new Map();
  for (const record of registry) {
    const root = union.find(`techmap:${record.external_id}`);
    if (!components.has(root)) components.set(root, { records: [], existingIds: new Set() });
    components.get(root).records.push(record);
  }
  for (const company of state.companies) {
    const root = union.find(`local:${company.company_id}`);
    if (components.has(root)) components.get(root).existingIds.add(company.company_id);
  }

  const decisions = [];
  const identityConflicts = [];
  const existingCompanyIds = new Set(state.companies.map((row) => row.company_id));
  const orderedComponents = [...components.values()].sort((a, b) =>
    a.records[0].external_id.localeCompare(b.records[0].external_id));

  for (const component of orderedComponents) {
    const records = component.records.sort((a, b) => a.external_id.localeCompare(b.external_id));
    const existingIds = [...component.existingIds].sort();
    const primary = choosePrimary(records);
    const componentId = componentIdFor(records, existingIds);
    const domains = unique(records.map((row) => row.canonical_domain));
    const names = unique(records.map((row) => row.normalized_name));
    const domainNames = new Map();
    const atsRecords = new Map();
    for (const record of records) {
      if (record.canonical_domain) {
        if (!domainNames.has(record.canonical_domain)) domainNames.set(record.canonical_domain, new Set());
        domainNames.get(record.canonical_domain).add(record.normalized_name);
      }
      for (const ats of record.ats) addToMap(atsRecords, atsKey(ats.provider, ats.identifier), record);
    }

    let conflict = null;
    const duplicateAliases = records.filter((record) => unique(
      (aliasRowsByExternal.get(record.external_id) ?? []).map((row) => row.company_id),
    ).length > 1);
    if (duplicateAliases.length) {
      conflict = conflictFor(componentId, "overlapping_external_alias", records, existingIds,
        "A stable Techmap external ID points to more than one local company");
    } else if (existingIds.length > 1) {
      conflict = conflictFor(componentId, "multiple_existing_identity_targets", records, existingIds,
        "Domain, external alias, or ATS evidence connects this component to more than one existing company");
    } else if ([...domainNames.values()].some((set) => set.size > 1)) {
      conflict = conflictFor(componentId, "duplicate_domain_distinct_names", records, existingIds,
        "Multiple Techmap registry identities share a canonical domain but have distinct normalized names");
    } else if ([...atsRecords.values()].some((rows) => rows.length > 1)
      && (names.length > 1 || domains.length > 1)) {
      conflict = conflictFor(componentId, "shared_ats_identifier", records, existingIds,
        "Multiple Techmap identities share an ATS provider/identifier without identical identity metadata");
    } else if (records.length > 1 && domains.length > 1) {
      conflict = conflictFor(componentId, "conflicting_domain_mappings", records, existingIds,
        "A transitive identity component contains multiple canonical domains");
    }

    const existing = existingIds.length === 1 ? companiesById.get(existingIds[0]) : null;
    if (!conflict && existing?.canonical_domain) {
      const conflictingDomain = records.find((record) =>
        record.canonical_domain && record.canonical_domain !== existing.canonical_domain);
      if (conflictingDomain) {
        conflict = conflictFor(componentId, "conflicting_existing_domain_mapping", records, existingIds,
          `Techmap domain '${conflictingDomain.canonical_domain}' conflicts with existing domain '${existing.canonical_domain}'`);
      }
    }
    if (!conflict && existing && names.length > 1) {
      conflict = conflictFor(componentId, "distinct_names_shared_identity_evidence", records, existingIds,
        "Distinct Techmap names are connected to one existing identity and require explicit review");
    }
    if (!conflict && existing) {
      const namesAgree = records.some((record) => record.normalized_name === existing.normalized_name);
      const hasAliasEvidence = records.some((record) =>
        (aliasRowsByExternal.get(record.external_id) ?? []).some((alias) => alias.company_id === existing.company_id));
      const hasAtsEvidence = records.some((record) => record.ats.some((ats) =>
        signalOwner.get(atsKey(ats.provider, ats.identifier)) === `local:${existing.company_id}`
          || union.find(`techmap:${record.external_id}`) === union.find(`local:${existing.company_id}`)
            && !record.canonical_domain));
      if (!namesAgree && !hasAliasEvidence && !hasAtsEvidence) {
        conflict = conflictFor(componentId, "domain_name_disagreement", records, existingIds,
          `Existing company name '${existing.company_name}' disagrees with Techmap and only domain evidence matches`);
      }
    }

    if (conflict) {
      identityConflicts.push(conflict);
      decisions.push({ action: "quarantined", record: primary, group: records, component_id: componentId, conflict });
      continue;
    }

    if (existing) {
      const aliasEvidence = records.some((record) => (aliasRowsByExternal.get(record.external_id) ?? []).length);
      const atsEvidence = records.some((record) => record.ats.some((ats) =>
        (state.sources.some((source) => source.company_id === existing.company_id
          && atsKey(source.provider, source.source_identifier) === atsKey(ats.provider, ats.identifier)))
        || (existing.ats_provider && atsKey(existing.ats_provider, existing.ats_identifier) === atsKey(ats.provider, ats.identifier))));
      decisions.push({
        action: "match_existing", record: primary, group: records, component_id: componentId,
        company_id: existing.company_id,
        match_basis: aliasEvidence ? "external_id" : atsEvidence ? "ats_identifier" : "canonical_domain",
        sources: buildSourceCandidates(existing.company_id, records),
      });
      continue;
    }

    const nameTargets = exactNameTargets(records, existingByName);
    if (nameTargets.length > 1) {
      const nameConflict = conflictFor(componentId, "ambiguous_exact_name", records, nameTargets,
        "Exact normalized name matches more than one existing company");
      identityConflicts.push(nameConflict);
      decisions.push({ action: "quarantined", record: primary, group: records, component_id: componentId, conflict: nameConflict });
      continue;
    }
    if (nameTargets.length === 1) {
      const target = companiesById.get(nameTargets[0]);
      if (primary.canonical_domain && target.canonical_domain && primary.canonical_domain !== target.canonical_domain) {
        const nameConflict = conflictFor(componentId, "exact_name_conflicting_domains", records, nameTargets,
          `Existing domain '${target.canonical_domain}' conflicts with Techmap domain '${primary.canonical_domain}'`);
        identityConflicts.push(nameConflict);
        decisions.push({ action: "quarantined", record: primary, group: records, component_id: componentId, conflict: nameConflict });
      } else {
        decisions.push({
          action: "review_name_only", record: primary, group: records, component_id: componentId,
          company_id: target.company_id, match_basis: "exact_normalized_name_only",
        });
      }
      continue;
    }

    const companyId = techmapCompanyId(primary.external_id);
    if (existingCompanyIds.has(companyId)) {
      const collision = conflictFor(componentId, "generated_company_id_collision", records, [companyId],
        "The deterministic Techmap company ID is already owned without a matching external alias");
      identityConflicts.push(collision);
      decisions.push({ action: "quarantined", record: primary, group: records, component_id: componentId, conflict: collision });
      continue;
    }
    decisions.push({
      action: "insert_new", record: primary, group: records, component_id: componentId,
      company_id: companyId, match_basis: "new_techmap_external_id",
      sources: buildSourceCandidates(companyId, records),
    });
  }

  const sourceIsolation = isolateSourceConflicts(decisions, state);
  const conflicts = [...identityConflicts, ...sourceIsolation.conflicts];
  const safeDecisions = decisions.filter((row) => ["insert_new", "match_existing"].includes(row.action));
  const safeExternalIds = new Set(safeDecisions.flatMap((row) => row.group.map((record) => record.external_id)));
  const unsafeExternalIds = new Set(decisions.filter((row) => !["insert_new", "match_existing"].includes(row.action))
    .flatMap((row) => row.group.map((record) => record.external_id)));
  const overlap = [...safeExternalIds].filter((id) => unsafeExternalIds.has(id));
  if (overlap.length) throw new Error(`Conflict isolation invariant failed for external IDs: ${overlap.join(",")}`);

  const exactExistingNames = new Map();
  for (const company of state.companies) addToMap(exactExistingNames, company.company_name, company.company_id);
  const proposedJobLinks = state.jobs.filter((job) => !job.company_id
    && (exactExistingNames.get(job.company_name) ?? []).length === 1);
  const unresolvedJobNames = unique(state.jobs
    .filter((job) => !job.company_id && (exactExistingNames.get(job.company_name) ?? []).length !== 1)
    .map((job) => job.company_name));
  const allSources = safeDecisions.flatMap((row) => row.sources ?? []);
  const identityQuarantinedSources = decisions
    .filter((row) => !["insert_new", "match_existing"].includes(row.action))
    .reduce((sum, row) => sum + buildSourceCandidates("quarantined", row.group).length, 0);

  const summary = {
    registry_records: registry.length,
    identity_connected_components: decisions.length,
    existing_companies: state.companies.length,
    proposed_new_companies: decisions.filter((row) => row.action === "insert_new").length,
    matched_existing_company_groups: decisions.filter((row) => row.action === "match_existing").length,
    matched_external_records: decisions.filter((row) => row.action === "match_existing")
      .reduce((sum, row) => sum + row.group.length, 0),
    proposed_after_companies: state.companies.length + decisions.filter((row) => row.action === "insert_new").length,
    review_name_only_groups: decisions.filter((row) => row.action === "review_name_only").length,
    blocked_high_risk_groups: decisions.filter((row) => row.action === "quarantined").length,
    high_risk_conflicts: conflicts.length,
    identity_conflict_groups: identityConflicts.length,
    source_conflict_groups: sourceIsolation.conflicts.length,
    quarantined_registry_records: unsafeExternalIds.size,
    proposed_external_aliases: safeExternalIds.size,
    proposed_source_candidates: allSources.length,
    proposed_ats_candidates: allSources.filter((row) => row.source_kind === "ats").length,
    proposed_careers_candidates: allSources.filter((row) => row.source_kind === "careers_page").length,
    quarantined_source_candidates: identityQuarantinedSources + sourceIsolation.quarantinedCount,
    active_registry_records: registry.filter((row) => row.is_active).length,
    inactive_registry_records: registry.filter((row) => !row.is_active).length,
    io_registry_records: registry.filter((row) => row.canonical_domain?.endsWith(".io")).length,
    proposed_job_links: proposedJobLinks.length,
    unresolved_job_names: unresolvedJobNames.length,
    safe_subset_dependency_violations: 0,
  };
  return { summary, decisions, conflicts, identityConflicts, sourceConflicts: sourceIsolation.conflicts, proposedJobLinks, unresolvedJobNames };
}

export function decisionRows(reconciliation) {
  return reconciliation.decisions.flatMap((decision) => decision.group.map((record) => ({
    external_id: record.external_id,
    source_company_name: record.company_name,
    canonical_domain: record.canonical_domain,
    conflict_group_id: decision.component_id,
    action: decision.action,
    company_id: decision.company_id ?? "",
    match_basis: decision.match_basis ?? "",
    is_primary_record: decision.record.external_id === record.external_id ? 1 : 0,
    is_active: record.is_active,
    size: record.employee_size_bucket,
    category: record.category_name,
    careers_url: record.careers_url,
    ats_candidates: record.ats.map((ats) => `${ats.provider}:${ats.identifier}`).join(";"),
  })));
}

export function identityReviewRows(reconciliation, previousRows = []) {
  const previous = new Map(previousRows.map((row) => [`${row.techmap_external_id}\u001f${row.conflict_group_id}`, row]));
  const rows = [];
  for (const decision of reconciliation.decisions.filter((row) => ["quarantined", "review_name_only"].includes(row.action))) {
    const reason = decision.conflict?.conflict_type ?? "exact_name_only_requires_review";
    for (const record of decision.group) {
      const key = `${record.external_id}\u001f${decision.component_id}`;
      const prior = previous.get(key) ?? {};
      const proposed = REVIEW_DECISIONS.has(prior.proposed_decision) ? prior.proposed_decision : "";
      rows.push({
        techmap_external_id: record.external_id,
        company_name: record.company_name,
        domain: record.canonical_domain ?? "",
        conflict_group_id: decision.component_id,
        conflicting_company_ids: unique([
          ...decision.group.filter((other) => other.external_id !== record.external_id).map((other) => other.external_id),
          ...(decision.conflict?.existing_company_ids?.split(";") ?? []).filter(Boolean).map((id) => `local:${id}`),
        ]).join(";"),
        conflict_reason: reason,
        proposed_decision: proposed,
        decision_status: prior.decision_status === "reviewed" && proposed ? "reviewed" : "unresolved",
        evidence_url: prior.evidence_url ?? "",
        review_notes: prior.review_notes ?? "",
      });
    }
  }
  const recordsByExternalId = new Map(reconciliation.decisions
    .flatMap((decision) => decision.group)
    .map((record) => [record.external_id, record]));
  for (const conflict of reconciliation.sourceConflicts) {
    const externalIds = conflict.external_ids.split(";").filter(Boolean);
    for (const externalId of externalIds) {
      const record = recordsByExternalId.get(externalId);
      if (!record) continue;
      const key = `${externalId}\u001f${conflict.conflict_group_id}`;
      const prior = previous.get(key) ?? {};
      const proposed = REVIEW_DECISIONS.has(prior.proposed_decision) ? prior.proposed_decision : "";
      rows.push({
        techmap_external_id: externalId,
        company_name: record.company_name,
        domain: record.canonical_domain ?? "",
        conflict_group_id: conflict.conflict_group_id,
        conflicting_company_ids: unique([
          ...externalIds.filter((id) => id !== externalId),
          ...conflict.existing_company_ids.split(";").filter(Boolean).map((id) => `local:${id}`),
        ]).join(";"),
        conflict_reason: conflict.conflict_type,
        proposed_decision: proposed,
        decision_status: prior.decision_status === "reviewed" && proposed ? "reviewed" : "unresolved",
        evidence_url: prior.evidence_url ?? "",
        review_notes: prior.review_notes ?? "",
      });
    }
  }
  return rows.sort((a, b) => a.conflict_group_id.localeCompare(b.conflict_group_id)
    || a.techmap_external_id.localeCompare(b.techmap_external_id));
}

function companySelection(record) {
  let score = 0;
  const reasons = [];
  if (record.canonical_domain?.endsWith(".io")) {
    score += 15;
    reasons.push(".io discovery priority");
  }
  if (record.employee_size_evidence === "verified_within_10_200") {
    score += 28;
    reasons.push("reported range within 10-200");
  } else if (record.employee_size_evidence === "overlaps_10_200") {
    score += 12;
    reasons.push("reported range overlaps 10-200");
  }
  return { score, reasons: reasons.join("; ") || null };
}

function companyInsertStatement(db) {
  return db.prepare(`
    INSERT OR IGNORE INTO companies (
      company_id, company_name, canonical_domain, website_url, careers_url, ats_provider,
      ats_identifier, source_url, country, city, industry, employee_count, employee_count_min,
      employee_count_max, employee_size_bucket, employee_size_source, employee_size_observed_at,
      employee_size_confidence, employee_size_evidence, company_discovered_at,
      company_last_checked_at, company_source_url, company_source_name, company_source_status,
      latest_stage, latest_round_date, source_description, known_in_techmap, is_new_company,
      is_pilot_company, selection_score, selection_reasons, raw_json
    ) VALUES (${Array.from({ length: 33 }, () => "?").join(",")})
  `);
}

function insertCompany(statement, decision, observedAt) {
  const record = decision.record;
  const selection = companySelection(record);
  return statement.run(
    decision.company_id, record.company_name, record.canonical_domain, record.website_url,
    null, null, null, null, "Israel", record.city, record.category_name, null,
    record.employee_count_min, record.employee_count_max, record.employee_size_bucket,
    record.employee_size_bucket === "unknown" ? null : "Techmap size field", null,
    record.employee_size_bucket === "unknown" ? "unknown" : "medium", record.employee_size_evidence,
    observedAt, null, externalSourceUrl(record.external_id), TECHMAP_SOURCE_NAME,
    record.is_active ? "imported_unverified" : "imported_inactive", null, null, null,
    1, 0, 0, selection.score, selection.reasons, JSON.stringify(record.raw),
  ).changes;
}

function findExistingSource(db, source) {
  return db.prepare(`
    SELECT * FROM company_sources
    WHERE company_id=? AND source_kind=?
      AND COALESCE(provider, '')=COALESCE(?, '')
      AND COALESCE(source_identifier, '')=COALESCE(?, '')
      AND COALESCE(source_url, '')=COALESCE(?, '')
  `).get(source.company_id, source.source_kind, source.provider ?? null,
    source.source_identifier ?? null, source.source_url ?? null);
}

function upsertCompanySource(db, source, observedAt) {
  const existing = findExistingSource(db, source);
  if (!existing) {
    db.prepare(`
      INSERT INTO company_sources (
        source_id, company_id, source_kind, provider, source_identifier, source_url,
        careers_url, evidence_source, evidence_status, evidence_url, is_enabled,
        effective_from, effective_to, imported_at, last_observed_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(source.source_id, source.company_id, source.source_kind, source.provider ?? null,
      source.source_identifier ?? null, source.source_url ?? null, source.careers_url ?? null,
      source.evidence_source, source.evidence_status, source.evidence_url ?? null,
      source.is_enabled ?? 0, source.effective_from ?? null, source.effective_to ?? null,
      source.imported_at ?? observedAt, source.last_observed_at ?? null, source.raw_json ?? null);
    return 1;
  }
  const currentRank = SOURCE_STATUS_RANK[existing.evidence_status] ?? 40;
  const proposedRank = SOURCE_STATUS_RANK[source.evidence_status] ?? 40;
  db.prepare(`
    UPDATE company_sources SET
      careers_url=COALESCE(careers_url, ?),
      evidence_source=CASE WHEN ? > ? THEN ? ELSE evidence_source END,
      evidence_status=CASE WHEN ? > ? THEN ? ELSE evidence_status END,
      evidence_url=CASE WHEN ? > ? THEN COALESCE(?, evidence_url) ELSE evidence_url END,
      is_enabled=MAX(is_enabled, ?),
      effective_from=COALESCE(effective_from, ?),
      last_observed_at=COALESCE(?, last_observed_at),
      raw_json=CASE WHEN ? > ? THEN COALESCE(?, raw_json) ELSE raw_json END
    WHERE source_id=?
  `).run(source.careers_url ?? null,
    proposedRank, currentRank, source.evidence_source,
    proposedRank, currentRank, source.evidence_status,
    proposedRank, currentRank, source.evidence_url ?? null,
    source.is_enabled ?? 0, source.effective_from ?? null, source.last_observed_at ?? null,
    proposedRank, currentRank, source.raw_json ?? null, existing.source_id);
  return 0;
}

function verificationEvidenceStatus(verification) {
  if (verification.verification_status === "verified_supported") return "manual_verified";
  if (verification.verification_status === "verified_custom_unsupported") return "manual_verified_unsupported";
  if (verification.verification_status === "source_inaccessible") return "manual_inaccessible";
  return "configured_existing";
}

function backfillLegacySources(db, observedAt) {
  let inserted = 0;
  const companies = db.prepare("SELECT * FROM companies").all();
  const byExactName = new Map();
  for (const company of companies) addToMap(byExactName, company.company_name, company);
  for (const company of companies) {
    if (!company.ats_provider && !company.source_url && !company.careers_url) continue;
    const kind = company.ats_provider ? "ats" : "careers_page";
    const url = company.source_url ?? company.careers_url;
    const status = company.company_source_status === "verified_supported" ? "manual_verified" : "configured_existing";
    inserted += upsertCompanySource(db, {
      source_id: companySourceId(company.company_id, kind, company.ats_provider, company.ats_identifier, url),
      company_id: company.company_id, source_kind: kind, provider: company.ats_provider,
      source_identifier: company.ats_identifier, source_url: url, careers_url: company.careers_url,
      evidence_source: "legacy companies configuration", evidence_status: status,
      evidence_url: company.company_source_url, is_enabled: company.ats_provider ? 1 : 0,
      effective_from: company.company_discovered_at, last_observed_at: company.company_last_checked_at,
      raw_json: company.raw_json,
    }, observedAt);
  }
  for (const verification of db.prepare("SELECT * FROM company_source_verifications ORDER BY verification_id").all()) {
    const kind = verification.source_provider ? "ats" : "careers_page";
    const url = verification.source_url ?? verification.careers_url;
    inserted += upsertCompanySource(db, {
      source_id: companySourceId(verification.company_id, kind, verification.source_provider, verification.source_identifier, url),
      company_id: verification.company_id, source_kind: kind, provider: verification.source_provider,
      source_identifier: verification.source_identifier, source_url: url, careers_url: verification.careers_url,
      evidence_source: verification.evidence_source ?? "legacy verification",
      evidence_status: verificationEvidenceStatus(verification), evidence_url: null,
      is_enabled: verification.verification_status === "verified_supported" ? 1 : 0,
      effective_from: verification.observed_at, last_observed_at: verification.observed_at,
      raw_json: JSON.stringify(verification),
    }, observedAt);
  }
  const liveRows = db.prepare(`
    SELECT company_name, source_provider, source_url, MAX(observed_at) observed_at
    FROM source_observations WHERE health_status IN ('success', 'empty')
    GROUP BY company_name, source_provider, source_url
    UNION ALL
    SELECT company_name, source_provider, source_url, MAX(last_seen_at) observed_at
    FROM jobs GROUP BY company_name, source_provider, source_url
  `).all();
  for (const live of liveRows) {
    const matches = byExactName.get(live.company_name) ?? [];
    if (matches.length !== 1) continue;
    const company = matches[0];
    const identifier = company.ats_provider === live.source_provider ? company.ats_identifier : null;
    inserted += upsertCompanySource(db, {
      source_id: companySourceId(company.company_id, "ats", live.source_provider, identifier, live.source_url),
      company_id: company.company_id, source_kind: "ats", provider: live.source_provider,
      source_identifier: identifier, source_url: live.source_url, careers_url: company.careers_url,
      evidence_source: "local collector observation", evidence_status: "live_verified",
      evidence_url: null, is_enabled: 1, effective_from: null, last_observed_at: live.observed_at,
      raw_json: null,
    }, observedAt);
  }
  return inserted;
}

function insertExternalAlias(db, decision, record, observedAt) {
  const existing = db.prepare(`
    SELECT company_id FROM company_external_ids WHERE source_name=? AND external_id=?
  `).get(TECHMAP_SOURCE_NAME, record.external_id);
  if (existing && existing.company_id !== decision.company_id) {
    throw new Error(`External ID ${record.external_id} is already mapped to another company`);
  }
  db.prepare(`
    INSERT INTO company_external_ids (
      source_name, external_id, company_id, external_name, evidence_url, identity_status,
      source_is_active, first_seen_at, last_seen_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_name, external_id) DO UPDATE SET
      external_name=excluded.external_name, evidence_url=excluded.evidence_url,
      source_is_active=excluded.source_is_active, last_seen_at=excluded.last_seen_at,
      raw_json=excluded.raw_json
  `).run(TECHMAP_SOURCE_NAME, record.external_id, decision.company_id, record.company_name,
    externalSourceUrl(record.external_id), decision.action === "insert_new" ? "imported_safe" : "matched_existing",
    record.is_active, observedAt, observedAt, JSON.stringify(record.raw));
  const normalized = record.normalized_name || normalizeCompanyName(record.company_name);
  db.prepare(`
    INSERT INTO company_aliases (
      alias_id, company_id, alias_name, normalized_alias, alias_type, source_name,
      external_id, evidence_url, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, 'source_registry_name', ?, ?, ?, ?, ?)
    ON CONFLICT(source_name, external_id, normalized_alias) DO UPDATE SET
      alias_name=excluded.alias_name, last_seen_at=excluded.last_seen_at,
      evidence_url=excluded.evidence_url
  `).run(aliasId(decision.company_id, record.external_id, normalized), decision.company_id,
    record.company_name, normalized, TECHMAP_SOURCE_NAME, record.external_id,
    externalSourceUrl(record.external_id), observedAt, observedAt);
  return existing ? 0 : 1;
}

export function applyTechmapImport(dbPath, reconciliation, {
  observedAt = new Date().toISOString(),
  faultAt = null,
} = {}) {
  if (reconciliation.summary.safe_subset_dependency_violations !== 0) {
    throw new Error("Safe-subset dependency gate failed");
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const before = {
    companies: db.prepare("SELECT COUNT(*) count FROM companies").get().count,
    jobs: db.prepare("SELECT COUNT(*) count FROM jobs").get().count,
    job_observations: db.prepare("SELECT COUNT(*) count FROM job_observations").get().count,
    source_observations: db.prepare("SELECT COUNT(*) count FROM source_observations").get().count,
    runs: db.prepare("SELECT COUNT(*) count FROM runs").get().count,
  };
  const stats = { companies_inserted: 0, external_aliases_inserted: 0, sources_inserted: 0, legacy_sources_inserted: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    migrateTechmapSchema(db, observedAt, { withinTransaction: true });
    if (faultAt === "after_migration") throw new Error("Injected import failure after migration");
    stats.legacy_sources_inserted = backfillLegacySources(db, observedAt);
    const insertCompanyStatement = companyInsertStatement(db);
    for (const decision of reconciliation.decisions.filter((row) => row.action === "insert_new")) {
      stats.companies_inserted += insertCompany(insertCompanyStatement, decision, observedAt);
    }
    if (faultAt === "after_companies") throw new Error("Injected import failure after companies");
    for (const decision of reconciliation.decisions.filter((row) => ["insert_new", "match_existing"].includes(row.action))) {
      for (const record of decision.group) {
        stats.external_aliases_inserted += insertExternalAlias(db, decision, record, observedAt);
      }
    }
    if (faultAt === "after_aliases") throw new Error("Injected import failure after aliases");
    for (const decision of reconciliation.decisions.filter((row) => ["insert_new", "match_existing"].includes(row.action))) {
      for (const source of decision.sources ?? []) {
        stats.sources_inserted += upsertCompanySource(db, { ...source, is_enabled: 0, imported_at: observedAt }, observedAt);
      }
    }
    if (faultAt === "after_sources") throw new Error("Injected import failure after sources");
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error(`Foreign-key violations detected: ${JSON.stringify(foreignKeys)}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const after = {
    companies: db.prepare("SELECT COUNT(*) count FROM companies").get().count,
    jobs: db.prepare("SELECT COUNT(*) count FROM jobs").get().count,
    job_observations: db.prepare("SELECT COUNT(*) count FROM job_observations").get().count,
    source_observations: db.prepare("SELECT COUNT(*) count FROM source_observations").get().count,
    runs: db.prepare("SELECT COUNT(*) count FROM runs").get().count,
    external_aliases: db.prepare("SELECT COUNT(*) count FROM company_external_ids").get().count,
    company_aliases: db.prepare("SELECT COUNT(*) count FROM company_aliases").get().count,
    company_sources: db.prepare("SELECT COUNT(*) count FROM company_sources").get().count,
    schema_version: db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,
  };
  db.close();
  return { before, after, ...stats };
}

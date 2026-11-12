import { performance } from "node:perf_hooks";
import { collectCompany } from "./adapters.js";
import { mapBounded, request } from "./http.js";

export const PHASE2_QUOTAS = Object.freeze({ breezy: 4, lever: 7, greenhouse: 10, comeet: 10 });

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return String(value).trim();
  }
}

function hostMatchesDomain(value, domain) {
  if (!value || !domain) return false;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    const expected = domain.toLowerCase().replace(/^www\./, "");
    return host === expected || host.endsWith(`.${expected}`);
  } catch {
    return false;
  }
}

function sizePriority(candidate) {
  const min = candidate.employee_count_min;
  const max = candidate.employee_count_max;
  if (min !== null && max !== null && min >= 10 && max <= 200) return 100;
  if (min !== null && max !== null && min <= 200 && max >= 10) return 55;
  return 0;
}

function candidateScore(candidate) {
  return sizePriority(candidate)
    + (candidate.canonical_domain?.endsWith(".io") ? 40 : 0)
    + (candidate.is_multinational ? 0 : 20)
    + (candidate.previous_verification_status === "imported_unverified" ? 5 : 0);
}

function selectionReason(candidate) {
  const reasons = [];
  if (sizePriority(candidate) === 100) reasons.push("10-200 employees");
  else if (sizePriority(candidate)) reasons.push("size range overlaps 10-200");
  if (candidate.canonical_domain?.endsWith(".io")) reasons.push(".io discovery priority");
  if (!candidate.is_multinational && candidate.employee_count_max !== null && candidate.employee_count_max <= 200) {
    reasons.push("smaller non-multinational profile");
  }
  reasons.push(`industry diversity: ${candidate.category_name ?? "unknown"}`);
  reasons.push(`prior evidence: ${candidate.previous_verification_status}`);
  return reasons.join("; ");
}

function matchingStoredSource(sources, candidate) {
  return sources.find((source) => source.company_id === candidate.company_id
    && source.source_kind === "ats"
    && normalized(source.provider) === normalized(candidate.provider)
    && normalized(source.source_identifier) === normalized(candidate.source_identifier));
}

export function buildAtsCandidateUniverse(reconciliation, state) {
  const companies = new Map(state.companies.map((company) => [company.company_id, company]));
  const candidates = [];
  for (const decision of reconciliation.decisions.filter((row) => ["insert_new", "match_existing"].includes(row.action))) {
    for (const source of (decision.sources ?? []).filter((row) => row.source_kind === "ats")) {
      const record = decision.group.find((row) => row.external_id === source.external_id) ?? decision.record;
      const company = companies.get(decision.company_id);
      if (!company) continue;
      const base = {
        company_id: decision.company_id,
        company_name: company.company_name,
        canonical_domain: company.canonical_domain,
        website_url: company.website_url,
        careers_url: source.careers_url ?? company.careers_url,
        employee_count_min: company.employee_count_min,
        employee_count_max: company.employee_count_max,
        employee_size_bucket: company.employee_size_bucket,
        category_name: company.industry ?? record.category_name,
        is_multinational: record.is_multinational,
        provider: source.provider,
        source_identifier: source.source_identifier,
        source_url: source.source_url,
        external_id: source.external_id,
      };
      const stored = matchingStoredSource(state.sources, base);
      candidates.push({
        ...base,
        source_id: stored?.source_id ?? source.source_id,
        previous_verification_status: stored?.evidence_status ?? "imported_unverified",
        source_enabled: stored?.is_enabled ?? 0,
      });
    }
  }
  return [...new Map(candidates.map((row) => [
    `${row.company_id}\u001f${row.provider}\u001f${normalized(row.source_identifier)}`, row,
  ])).values()].sort((a, b) => a.provider.localeCompare(b.provider)
    || a.company_name.localeCompare(b.company_name)
    || a.source_identifier.localeCompare(b.source_identifier));
}

function selectProviderCohort(candidates, quota) {
  const ranked = [...candidates].sort((a, b) => candidateScore(b) - candidateScore(a)
    || String(a.category_name).localeCompare(String(b.category_name))
    || a.company_name.localeCompare(b.company_name)
    || a.source_identifier.localeCompare(b.source_identifier));
  const selected = [];
  const usedCategories = new Set();
  for (const candidate of ranked) {
    const category = candidate.category_name ?? "unknown";
    if (usedCategories.has(category)) continue;
    selected.push(candidate);
    usedCategories.add(category);
    if (selected.length === Math.min(quota, candidates.length)) return selected;
  }
  for (const candidate of ranked) {
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length === quota) break;
  }
  return selected;
}

export function prioritizeValidationCandidates(candidates) {
  return selectProviderCohort(candidates, candidates.length);
}

export function selectValidationSample(universe, quotas = PHASE2_QUOTAS) {
  const sample = [];
  for (const provider of Object.keys(quotas)) {
    const eligible = universe.filter((candidate) => candidate.provider === provider);
    const selected = selectProviderCohort(eligible, quotas[provider]);
    sample.push(...selected.map((candidate) => ({
      ...candidate,
      selection_reason: selectionReason(candidate),
    })));
  }
  return sample.sort((a, b) => Object.keys(quotas).indexOf(a.provider) - Object.keys(quotas).indexOf(b.provider)
    || candidateScore(b) - candidateScore(a)
    || a.company_name.localeCompare(b.company_name));
}

export function officialEvidenceUrl(candidate) {
  if (hostMatchesDomain(candidate.careers_url, candidate.canonical_domain)) return candidate.careers_url;
  if (hostMatchesDomain(candidate.website_url, candidate.canonical_domain)) return candidate.website_url;
  return null;
}

export function officialEvidenceUrls(candidate) {
  return [...new Set([candidate.careers_url, candidate.website_url]
    .filter((url) => hostMatchesDomain(url, candidate.canonical_domain))
    .map(normalizeUrl))];
}

export function extractOfficialCareerLinks(html = "", baseUrl, canonicalDomain) {
  if (!baseUrl || !canonicalDomain) return [];
  const links = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1].replaceAll("&amp;", "&"), baseUrl);
      if (!hostMatchesDomain(url.toString(), canonicalDomain)) continue;
      if (!/(career|jobs|join[-_/]?us|work[-_/]?with[-_/]?us|open[-_/]?positions)/i.test(`${url.pathname}${url.search}`)) continue;
      links.push(normalizeUrl(url.toString()));
    } catch {
      // Relative or malformed links that cannot be resolved are not evidence.
    }
  }
  return [...new Set(links)];
}

export function extractAtsReferences(html = "", finalUrl = "") {
  const text = `${html}\n${finalUrl}`.replaceAll("&amp;", "&");
  const references = [];
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ""));
      const host = url.hostname.toLowerCase();
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (host.endsWith(".breezy.hr")) {
        references.push({ provider: "breezy", identifier: host.split(".")[0] });
      } else if (["jobs.lever.co", "api.lever.co"].includes(host)) {
        const index = segments[0] === "v0" && segments[1] === "postings" ? 2 : 0;
        if (segments[index]) references.push({ provider: "lever", identifier: segments[index] });
      } else if (["boards-api.greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io"].includes(host)) {
        let identifier = null;
        if (host === "boards-api.greenhouse.io" && segments[0] === "v1" && segments[1] === "boards") identifier = segments[2];
        else if (segments[0] === "embed" && segments[1] === "job_board") identifier = url.searchParams.get("for");
        else identifier = segments[0];
        if (identifier) references.push({ provider: "greenhouse", identifier });
      } else if ((host === "comeet.com" || host === "www.comeet.com") && segments[0] === "jobs"
        && segments[1] && segments[2]) {
        references.push({ provider: "comeet", identifier: `${segments[1]}/${segments[2]}` });
      }
    } catch {
      // Malformed links cannot provide ownership evidence.
    }
  }
  return [...new Map(references.map((row) => [`${row.provider}:${normalized(row.identifier)}`, row])).values()];
}

export function analyzeOwnershipEvidence(candidate, officialResponse = null, atsMetadata = null) {
  if (atsMetadata?.official_domain && candidate.canonical_domain
    && !hostMatchesDomain(`https://${atsMetadata.official_domain}`, candidate.canonical_domain)) {
    return {
      status: "conflict",
      evidence: `ATS metadata points to '${atsMetadata.official_domain}', not '${candidate.canonical_domain}'`,
      evidence_url: atsMetadata.evidence_url ?? candidate.source_url,
      alternate_sources: [],
    };
  }
  const responses = (Array.isArray(officialResponse) ? officialResponse : [officialResponse]).filter(Boolean);
  if (!responses.some((response) => response.attempted)) {
    return { status: "uncertain", evidence: "No official-domain ownership page was available", evidence_url: null, alternate_sources: [] };
  }
  const successful = responses.filter((response) => !response.error && response.status > 0 && response.status < 400);
  const exactPage = successful.find((response) => extractAtsReferences(response.body, response.finalUrl)
    .some((reference) => reference.provider === candidate.provider
      && normalized(reference.identifier) === normalized(candidate.source_identifier)));
  if (exactPage) {
    return {
      status: "verified",
      evidence_level: "strong",
      evidence: "Official company-domain page links or redirects to the exact ATS board",
      evidence_url: exactPage.finalUrl ?? exactPage.url,
      alternate_sources: [],
    };
  }
  if (["live_verified", "manual_verified", "configured_existing"].includes(candidate.previous_verification_status)
    && Number(candidate.source_enabled) === 1) {
    return {
      status: "verified",
      evidence_level: "strong",
      evidence: `Existing explicitly verified source configuration (${candidate.previous_verification_status})`,
      evidence_url: candidate.source_url,
      alternate_sources: [],
    };
  }
  if (!successful.length) {
    const failed = responses.find((response) => response.attempted) ?? responses[0];
    return {
      status: "uncertain",
      evidence_level: "none",
      evidence: `Official-domain evidence request failed${failed?.status ? ` with HTTP ${failed.status}` : ""}`,
      evidence_url: failed?.url ?? null,
      alternate_sources: [],
    };
  }
  const references = [...new Map(successful.flatMap((response) => extractAtsReferences(response.body, response.finalUrl))
    .map((reference) => [`${reference.provider}:${normalized(reference.identifier)}`, reference])).values()];
  if (references.length) {
    const evidencePage = successful.find((response) => extractAtsReferences(response.body, response.finalUrl).length);
    return {
      status: "migrated",
      evidence_level: "strong",
      evidence: "Official company-domain page references a different ATS board",
      evidence_url: evidencePage?.finalUrl ?? evidencePage?.url ?? null,
      alternate_sources: references,
    };
  }
  const redirected = successful.find((response) => response.finalUrl && candidate.canonical_domain
    && !hostMatchesDomain(response.finalUrl, candidate.canonical_domain));
  if (redirected) {
    return {
      status: "domain_redirect",
      evidence_level: "supporting_only",
      evidence: "Official company domain redirects to a different corporate domain without proving ATS ownership",
      evidence_url: redirected.finalUrl,
      alternate_sources: [],
    };
  }
  return {
    status: "uncertain",
    evidence_level: "supporting_only",
    evidence: "Official company-domain page was reachable but did not expose the candidate ATS board",
    evidence_url: successful[0].finalUrl ?? successful[0].url,
    alternate_sources: [],
  };
}

export function parserStatus(collection) {
  if (["success", "empty"].includes(collection.status)) return "compatible";
  if (collection.sourceState === "stale") return "not_applicable_stale_board";
  if (/invalid|expected an array|did not contain|schema/i.test(collection.error ?? "")) return "invalid_schema";
  return "request_failed";
}

export function classifyValidation({ collection, ownership }) {
  if (ownership.status === "conflict") return "ownership_conflict";
  if (ownership.status === "migrated") return "source_migrated";
  if (ownership.status === "domain_redirect") {
    return [404, 410].includes(collection.httpStatus) ? "source_migrated" : "ownership_conflict";
  }
  if (collection.sourceState === "stale") return "stale_source";
  if (parserStatus(collection) === "invalid_schema") return "parser_failure";
  if ([404, 410].includes(collection.httpStatus)) return "stale_source";
  if ([401, 403].includes(collection.httpStatus)) return "inaccessible";
  if (!collection.httpStatus || [408, 425, 429].includes(collection.httpStatus) || collection.httpStatus >= 500) {
    return "temporarily_failed";
  }
  if (!["success", "empty"].includes(collection.status)) return "inaccessible";
  if (ownership.status !== "verified") return "needs_manual_review";
  return collection.status === "empty" ? "valid_empty" : "valid_with_jobs";
}

export function applicationLinkStatus(status, error = null) {
  if ([403, 429].includes(status)) return "blocked_not_closed";
  if (status >= 200 && status < 400) return "reachable";
  if (status === 404 || status === 410) return "unavailable_not_closure_proof";
  if (error || !status) return "not_verified";
  return "http_failure_not_closure_proof";
}

export function providerRateLimited(results) {
  return results.some((row) => Number(row.endpoint_http_status) === 429);
}

export function summarizeJobData(jobs) {
  const firstJob = jobs[0] ?? null;
  return {
    job_count: jobs.length,
    external_job_id_sample: firstJob?.source_job_id ?? null,
    job_title_sample: firstJob?.job_title ?? null,
    location_sample: firstJob?.location ?? null,
    department_sample: firstJob?.department ?? null,
    description_available: firstJob ? Number(Boolean(firstJob.description)) : null,
    application_url_sample: firstJob?.apply_url ?? firstJob?.job_url ?? null,
    published_date_jobs: jobs.filter((job) => Boolean(job.published_at)).length,
    source_updated_date_jobs: jobs.filter((job) => Boolean(job.source_updated_at)).length,
  };
}

function recommendedAction(outcome) {
  const actions = {
    valid_with_jobs: "eligible_for_explicit_activation_review",
    valid_empty: "eligible_for_explicit_activation_review_as_valid_empty",
    stale_source: "keep_disabled_and_research_replacement",
    source_migrated: "keep_disabled_and_review_detected_replacement",
    ownership_conflict: "keep_disabled_and_quarantine_for_identity_review",
    inaccessible: "keep_disabled_and_review_access_method",
    temporarily_failed: "keep_disabled_and_retry_in_later_bounded_cohort",
    parser_failure: "keep_disabled_and_update_fixture_parser_before_retry",
    needs_manual_review: "keep_disabled_and_collect_stronger_ownership_evidence",
  };
  return actions[outcome];
}

async function fetchOfficialPage(url) {
  const started = performance.now();
  try {
    const response = await request(url, { responseType: "text", timeoutMs: 12_000, retries: 1, retryBaseMs: 500 });
    return {
      attempted: true, url, status: response.status, finalUrl: response.finalUrl,
      body: response.data.slice(0, 2_000_000), latency_ms: Math.round(performance.now() - started), error: null,
    };
  } catch (error) {
    return {
      attempted: true, url, status: error.status ?? 0, finalUrl: null, body: "",
      latency_ms: Math.round(performance.now() - started), error: error.message,
    };
  }
}

export async function fetchOfficialEvidence(candidate) {
  const initialUrls = officialEvidenceUrls(candidate);
  if (!initialUrls.length) {
    return [{ attempted: false, url: null, status: null, finalUrl: null, body: "", latency_ms: null, error: null }];
  }
  const responses = [];
  for (const url of initialUrls.slice(0, 2)) responses.push(await fetchOfficialPage(url));
  const checked = new Set(responses.map((response) => normalizeUrl(response.url)));
  const discovered = responses.flatMap((response) => extractOfficialCareerLinks(
    response.body, response.finalUrl ?? response.url, candidate.canonical_domain,
  )).filter((url) => !checked.has(normalizeUrl(url))).slice(0, 2);
  for (const url of discovered) responses.push(await fetchOfficialPage(url));
  return responses;
}

async function verifyApplicationUrl(url) {
  if (!url) return { status: null, final_url: null, latency_ms: null, link_status: "not_available", error: null };
  const started = performance.now();
  try {
    const response = await request(url, { responseType: "text", timeoutMs: 10_000, retries: 0 });
    return {
      status: response.status, final_url: response.finalUrl, latency_ms: Math.round(performance.now() - started),
      link_status: applicationLinkStatus(response.status), error: null,
    };
  } catch (error) {
    return {
      status: error.status ?? 0, final_url: null, latency_ms: Math.round(performance.now() - started),
      link_status: applicationLinkStatus(error.status ?? 0, error.message), error: error.message,
    };
  }
}

export async function validateCandidate(candidate) {
  const adapterCompany = {
    company_name: candidate.company_name,
    source_provider: candidate.provider,
    source_id: candidate.source_identifier,
    source_url: candidate.source_url,
    careers_url: candidate.careers_url,
  };
  const started = performance.now();
  const [collection, officialPages] = await Promise.all([
    collectCompany(adapterCompany),
    fetchOfficialEvidence(candidate),
  ]);
  const endpointLatency = Math.round(performance.now() - started);
  const ownership = analyzeOwnershipEvidence(candidate, officialPages);
  const jobData = summarizeJobData(collection.jobs);
  const application = await verifyApplicationUrl(jobData.application_url_sample);
  const outcome = classifyValidation({ collection, ownership });
  return {
    ...candidate,
    attempted_at: new Date().toISOString(),
    endpoint_http_status: collection.httpStatus || null,
    endpoint_latency_ms: endpointLatency,
    endpoint_status: collection.status,
    endpoint_final_url: collection.sourceUrl,
    ownership_status: ownership.status,
    ownership_evidence_level: ownership.evidence_level ?? (ownership.status === "verified" ? "strong" : "none"),
    ownership_evidence: ownership.evidence,
    ownership_evidence_url: ownership.evidence_url,
    ownership_observed_at: new Date().toISOString(),
    ownership_pages_checked: officialPages.filter((page) => page.attempted).length,
    ownership_http_status: officialPages.find((page) => page.status)?.status ?? null,
    ownership_latency_ms: officialPages.reduce((sum, page) => sum + Number(page.latency_ms ?? 0), 0),
    alternate_sources: ownership.alternate_sources.map((row) => `${row.provider}:${row.identifier}`).join(";"),
    parser_status: parserStatus(collection),
    job_count: ["success", "empty"].includes(collection.status) ? jobData.job_count : null,
    external_job_id_sample: jobData.external_job_id_sample,
    job_title_sample: jobData.job_title_sample,
    location_sample: jobData.location_sample,
    department_sample: jobData.department_sample,
    description_available: jobData.description_available,
    application_url_sample: jobData.application_url_sample,
    application_http_status: application.status,
    application_link_status: application.link_status,
    application_latency_ms: application.latency_ms,
    published_date_jobs: jobData.published_date_jobs,
    source_updated_date_jobs: jobData.source_updated_date_jobs,
    outcome,
    recommended_action: recommendedAction(outcome),
    error: collection.error ?? officialPages.find((page) => page.error)?.error ?? application.error ?? null,
  };
}

export async function validateSample(sample, concurrency = 2) {
  return mapBounded(sample, concurrency, validateCandidate);
}

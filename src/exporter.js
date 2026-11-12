import { writeCsv } from "./csv.js";
import { jerusalemDateTime, matchesCompanySize } from "./company.js";
import { scoreDiscovery } from "./scoring.js";
import { activeJobs, allCompanies, latestCompanyVerifications } from "./store.js";

const JOB_FIELDS = [
  "job_id", "company_id", "company_name", "canonical_domain", "industry",
  "employee_count", "employee_count_min", "employee_count_max", "employee_size_bucket",
  "employee_size_confidence", "employee_size_evidence", "job_title", "location", "remote_type",
  "department", "description", "job_url", "apply_url", "source_provider", "source_url",
  "first_seen_at", "first_seen_at_jerusalem", "first_seen_reliability", "published_at",
  "published_at_jerusalem", "published_at_source", "source_updated_at", "last_seen_at",
  "discovery_cohort", "discovery_kind", "relevance_score", "relevance_reasons",
  "discovery_priority_score", "discovery_priority_reasons", "verification_status", "link_status",
  "reopened_at",
];

const COMPANY_FIELDS = [
  "company_id", "company_name", "canonical_domain", "website_url", "careers_url", "ats_provider",
  "ats_identifier", "source_url", "country", "city", "industry", "employee_count",
  "employee_count_min", "employee_count_max", "employee_size_bucket", "employee_size_source",
  "employee_size_observed_at", "employee_size_confidence", "employee_size_evidence",
  "company_discovered_at", "company_last_checked_at", "company_source_url", "company_source_name",
  "company_source_status", "latest_stage", "latest_round_date", "known_in_techmap",
  "is_new_company", "selection_score", "selection_reasons",
];

const VERIFICATION_FIELDS = [
  "company_id", "careers_url", "source_provider", "source_identifier", "source_url",
  "verification_status", "http_status", "job_count", "error", "observed_at", "evidence_source",
  "is_manual_override",
];

function timeValue(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function companyForJob(job) {
  return {
    employee_count_min: job.employee_count_min,
    employee_count_max: job.employee_count_max,
    employee_size_evidence: job.employee_size_evidence ?? "unknown",
    employee_size_confidence: job.employee_size_confidence ?? "unknown",
    industry: job.industry,
    is_new_company: job.is_new_company,
  };
}

function compareNullableNumber(a, b) {
  const left = Number.isFinite(Number(a)) ? Number(a) : Number.POSITIVE_INFINITY;
  const right = Number.isFinite(Number(b)) ? Number(b) : Number.POSITIVE_INFINITY;
  return left - right;
}

export function sortJobs(jobs, sort = "newest_discovered") {
  const result = [...jobs];
  const tie = (a, b) => String(a.company_name).localeCompare(String(b.company_name))
    || String(a.job_title).localeCompare(String(b.job_title));
  const comparators = {
    newest_discovered: (a, b) => (timeValue(b.first_seen_at) ?? -Infinity) - (timeValue(a.first_seen_at) ?? -Infinity) || tie(a, b),
    newest_published: (a, b) => (timeValue(b.published_at) ?? -Infinity) - (timeValue(a.published_at) ?? -Infinity) || tie(a, b),
    relevance: (a, b) => Number(b.relevance_score) - Number(a.relevance_score) || tie(a, b),
    discovery_priority: (a, b) => Number(b.discovery_priority_score) - Number(a.discovery_priority_score) || tie(a, b),
    company_name: tie,
    company_size: (a, b) => compareNullableNumber(a.employee_count_min, b.employee_count_min) || tie(a, b),
  };
  result.sort(comparators[sort] ?? comparators.newest_discovered);
  return result;
}

export function filterJobs(jobs, {
  now = new Date(),
  dateField = "first_seen_at",
  discoveredWithinHours,
  discoveredWithinDays = 7,
  allDates = false,
  includeUnknownDates = false,
  minimumEmployees = 10,
  maximumEmployees = 200,
  sizeMode = "broad",
  minimumRelevance = 40,
  sort = "newest_discovered",
} = {}) {
  if (!new Set(["first_seen_at", "published_at"]).has(dateField)) {
    throw new Error(`Unsupported date field: ${dateField}`);
  }
  const reference = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(reference.getTime())) throw new Error(`Invalid export reference time: ${now}`);
  const hours = discoveredWithinHours === undefined
    ? Number(discoveredWithinDays) * 24 : Number(discoveredWithinHours);
  const cutoff = reference.getTime() - hours * 3_600_000;
  const filtered = jobs.filter((job) => {
    if (Number(job.relevance_score) < Number(minimumRelevance)) return false;
    if (!matchesCompanySize(companyForJob(job), {
      mode: sizeMode, minimum: Number(minimumEmployees), maximum: Number(maximumEmployees),
    })) return false;
    if (allDates) return true;
    const value = timeValue(job[dateField]);
    if (value === null) return includeUnknownDates;
    return value >= cutoff && value <= reference.getTime();
  });
  return sortJobs(filtered, sort);
}

function decorateJobs(jobs, now) {
  return jobs.map((job) => {
    const dynamic = scoreDiscovery(job, companyForJob(job), now);
    return {
      ...job,
      ...dynamic,
      first_seen_at_jerusalem: jerusalemDateTime(job.first_seen_at),
      published_at_jerusalem: jerusalemDateTime(job.published_at),
    };
  });
}

export async function exportDatasets(db, dataDirectory = "data", options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const jobs = decorateJobs(activeJobs(db), now);
  const selected = filterJobs(jobs, { ...options, now });
  const allRelevant = filterJobs(jobs, { ...options, now, allDates: true, sizeMode: "all" });
  const rolling = {};
  for (const days of [1, 7, 30]) {
    rolling[days] = filterJobs(jobs, {
      ...options, now, dateField: "first_seen_at", discoveredWithinDays: days,
      discoveredWithinHours: undefined, allDates: false, includeUnknownDates: false,
    });
  }

  const companies = allCompanies(db);
  const verifications = latestCompanyVerifications(db);
  const unknownSize = companies.filter((row) => row.employee_size_evidence === "unknown");
  const newCompanies = companies.filter((row) => Number(row.is_new_company) === 1);
  const unsupported = companies.filter((row) => !row.ats_provider || /unsupported|inaccessible|manual_review/i.test(row.company_source_status));
  const manualReview = verifications.filter((row) => !/^verified_supported$/.test(row.verification_status));

  await Promise.all([
    writeCsv(`${dataDirectory}/jobs.csv`, jobs, JOB_FIELDS),
    writeCsv(`${dataDirectory}/relevant_jobs.csv`, selected, JOB_FIELDS),
    writeCsv(`${dataDirectory}/relevant_jobs_all.csv`, allRelevant, JOB_FIELDS),
    writeCsv(`${dataDirectory}/new_jobs_24h.csv`, rolling[1], JOB_FIELDS),
    writeCsv(`${dataDirectory}/new_jobs_7d.csv`, rolling[7], JOB_FIELDS),
    writeCsv(`${dataDirectory}/new_jobs_30d.csv`, rolling[30], JOB_FIELDS),
    writeCsv(`${dataDirectory}/unknown_size_companies.csv`, unknownSize, COMPANY_FIELDS),
    writeCsv(`${dataDirectory}/newly_discovered_companies.csv`, newCompanies, COMPANY_FIELDS),
    writeCsv(`${dataDirectory}/unsupported_company_sources.csv`, unsupported, COMPANY_FIELDS),
    writeCsv(`${dataDirectory}/manual_review_sources.csv`, manualReview, VERIFICATION_FIELDS),
  ]);
  return {
    active_jobs: jobs.length,
    selected_jobs: selected.length,
    all_relevant_jobs: allRelevant.length,
    new_jobs_24h: rolling[1].length,
    new_jobs_7d: rolling[7].length,
    new_jobs_30d: rolling[30].length,
    unknown_size_companies: unknownSize.length,
    newly_discovered_companies: newCompanies.length,
    unsupported_company_sources: unsupported.length,
    manual_review_sources: manualReview.length,
    as_of: now.toISOString(),
  };
}

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCsv, writeCsv } from "./csv.js";
import { collectCompany } from "./adapters.js";
import { companyIdFor, normalizeCompanyName } from "./company.js";
import { buildCandidateDataset } from "./discovery.js";
import {
  clearHttpAttemptBudget,
  configureHttpAttemptBudget,
  httpAttemptBudgetSnapshot,
  mapBounded,
  request,
} from "./http.js";
import { normalizeJob } from "./scoring.js";
import {
  openStore, beginRun, recordSourceObservation, applySuccessfulObservation, finishRun,
  shortlistForVerification, updateLinkStatus, latestRunSummary, importCompanies,
  recordCompanyVerification,
} from "./store.js";
import { exportDatasets } from "./exporter.js";

const DB_PATH = resolve("data/jobs.sqlite");
const COMPANIES_PATH = resolve("data/companies.csv");
const CANDIDATES_PATH = resolve("data/company_candidates.csv");
const OVERRIDES_PATH = resolve("data/company_source_overrides.csv");
const DISCOVERY_PILOT_PATH = resolve("data/discovery_pilot_companies.csv");
const DISCOVERY_PILOT_FIELDS = [
  "company_id", "company_name", "website", "careers_url", "source_provider", "source_id",
  "source_url", "metadata_source", "access_method", "selection_reason", "verification_status",
  "employee_count_min", "employee_count_max", "employee_size_bucket", "employee_size_confidence",
  "employee_size_evidence", "industry", "is_new_company",
];

function optionsFrom(args) {
  const options = { flags: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    const name = argument.slice(2).replaceAll("-", "_");
    if (index + 1 < args.length && !args[index + 1].startsWith("--")) {
      options[name] = args[index + 1];
      index += 1;
    } else options.flags.add(name);
  }
  return options;
}

function numberOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, received: ${value}`);
  return parsed;
}

async function verifyLinks(db) {
  const candidates = shortlistForVerification(db);
  await mapBounded(candidates, 3, async (job) => {
    const url = job.apply_url ?? job.job_url;
    try {
      await request(url, { responseType: "text", timeoutMs: 15_000, retries: 1 });
      updateLinkStatus(db, job.job_id, "verified");
    } catch (error) {
      updateLinkStatus(db, job.job_id, `failed:${error.status ?? 0}`);
    }
  });
}

function collectionContext(company, options) {
  return {
    company: {
      ...company,
      company_source_id: company.company_source_id || null,
      company_id: company.company_id || companyIdFor({
        company_name: company.company_name,
        website_url: company.website || company.website_url,
      }),
    },
    discoveryCohort: options.cohort ?? "incremental",
    discoveryKind: options.discovery_kind ?? "new_to_collector",
  };
}

async function collect(options) {
  const companiesPath = resolve(options.companies ?? COMPANIES_PATH);
  const availableCompanies = await readCsv(companiesPath);
  const limit = numberOption(options.limit, availableCompanies.length);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Collection limit must be a positive integer, received: ${limit}`);
  const companies = availableCompanies.slice(0, limit);
  const databasePath = resolve(options.db ?? DB_PATH);
  const exportDirectory = resolve(options.export_dir ?? "data");
  if (options.max_http_attempts !== undefined) {
    configureHttpAttemptBudget(numberOption(options.max_http_attempts));
  }
  const db = openStore(databasePath);
  const startedAt = options.observed_at ?? new Date().toISOString();
  const runId = beginRun(db, startedAt);
  let failures = 0;

  console.log(`Starting run ${runId}: ${companies.length} companies from ${companiesPath}`);
  try {
    const results = await mapBounded(companies, numberOption(options.concurrency, 4), async (company) => {
      const result = await collectCompany(company);
      console.log(`${company.company_name}: ${result.status} (${result.jobs.length} jobs)`);
      return { company, result };
    });

    for (const { company, result } of results) {
      const observedAt = options.observed_at ?? new Date().toISOString();
      recordSourceObservation(db, runId, company, result, observedAt);
      if (result.status === "success" || result.status === "empty") {
        const context = collectionContext(company, options);
        const normalized = result.jobs.map((job) => normalizeJob(job, observedAt, context));
        applySuccessfulObservation(db, runId, context.company, normalized, observedAt);
      } else if (result.status.startsWith("failed")) failures += 1;
    }
    if (options.flags.has("verify_links")) await verifyLinks(db);
    const status = failures ? "partial_success" : "completed";
    finishRun(db, runId, status, options.observed_at ?? new Date().toISOString());
    const exported = await exportDatasets(db, exportDirectory, exportOptions(options));
    console.log(JSON.stringify({ ...latestRunSummary(db), exported }, null, 2));
  } catch (error) {
    finishRun(db, runId, "interrupted", options.observed_at ?? new Date().toISOString());
    throw error;
  } finally {
    try {
      if (options.http_metrics_file) {
        writeFileSync(resolve(options.http_metrics_file), `${JSON.stringify(httpAttemptBudgetSnapshot(), null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      }
    } finally {
      clearHttpAttemptBudget();
      db.close();
    }
  }
}

function exportOptions(options) {
  return {
    now: options.now,
    dateField: options.date_field ?? "first_seen_at",
    discoveredWithinHours: options.discovered_within_hours === undefined
      ? undefined : numberOption(options.discovered_within_hours),
    discoveredWithinDays: numberOption(options.discovered_within_days, 7),
    allDates: options.flags.has("all_dates"),
    includeUnknownDates: options.flags.has("include_unknown_dates"),
    minimumEmployees: numberOption(options.min_employees, 10),
    maximumEmployees: numberOption(options.max_employees, 200),
    sizeMode: options.size_mode ?? "broad",
    minimumRelevance: numberOption(options.min_relevance, 40),
    sort: options.sort ?? "newest_discovered",
  };
}

async function exportOnly(options) {
  const db = openStore(resolve(options.db ?? DB_PATH));
  try {
    console.log(JSON.stringify(await exportDatasets(db, resolve(options.export_dir ?? "data"), exportOptions(options)), null, 2));
  } finally {
    db.close();
  }
}

async function verifyOnly(options) {
  const db = openStore(resolve(options.db ?? DB_PATH));
  try {
    await verifyLinks(db);
    const summary = latestRunSummary(db);
    console.log(JSON.stringify({ verified_links: summary?.verified_links ?? 0 }, null, 2));
  } finally {
    db.close();
  }
}

function pilotCompanyRow(row, observedAt) {
  const website = row.website || row.website_url || null;
  return {
    company_id: companyIdFor({ company_name: row.company_name, website_url: website }),
    company_name: row.company_name,
    canonical_domain: null,
    website_url: website,
    careers_url: row.careers_url || null,
    ats_provider: row.source_provider || null,
    ats_identifier: row.source_id || null,
    source_url: row.source_url || null,
    country: "Israel",
    city: null,
    industry: null,
    employee_count: null,
    employee_count_min: null,
    employee_count_max: null,
    employee_size_bucket: "unknown",
    employee_size_source: null,
    employee_size_observed_at: null,
    employee_size_confidence: "unknown",
    employee_size_evidence: "unknown",
    company_discovered_at: observedAt,
    company_last_checked_at: null,
    company_source_url: row.metadata_source || null,
    company_source_name: "original pilot configuration",
    company_source_status: row.verification_status || "metadata_verified",
    latest_stage: null,
    latest_round_date: null,
    source_description: row.selection_reason || null,
    known_in_techmap: 1,
    is_new_company: 0,
    is_pilot_company: 1,
    selection_score: 0,
    selection_reasons: row.selection_reason || null,
  };
}

async function importCompanyData(options) {
  const observedAt = options.observed_at ?? new Date().toISOString();
  const [candidates, originalPilot, overrides] = await Promise.all([
    readCsv(CANDIDATES_PATH), readCsv(COMPANIES_PATH), readCsv(OVERRIDES_PATH),
  ]);
  const byName = new Map(candidates.map((row) => [normalizeCompanyName(row.company_name), row]));
  const unmatched = [];
  for (const override of overrides) {
    const company = byName.get(normalizeCompanyName(override.company_name));
    if (!company) { unmatched.push(override.company_name); continue; }
    company.careers_url = override.careers_url || company.careers_url;
    company.ats_provider = override.source_provider || company.ats_provider;
    company.ats_identifier = override.source_id || company.ats_identifier;
    company.source_url = override.source_url || company.source_url;
    company.company_source_status = override.verification_status;
    company.company_last_checked_at = override.verified_at || observedAt;
  }
  const pilotRecords = originalPilot.map((row) => pilotCompanyRow(row, observedAt));
  const db = openStore(DB_PATH);
  try {
    importCompanies(db, [...pilotRecords, ...candidates], observedAt);
    for (const override of overrides) {
      const company = byName.get(normalizeCompanyName(override.company_name));
      if (!company) continue;
      recordCompanyVerification(db, company.company_id, {
        careers_url: override.careers_url || null,
        source_provider: override.source_provider || null,
        source_identifier: override.source_id || null,
        source_url: override.source_url || null,
        verification_status: override.verification_status,
        observed_at: override.verified_at || observedAt,
        evidence_source: override.override_reason,
        is_manual_override: true,
      });
    }
  } finally {
    db.close();
  }

  const structured = overrides
    .filter((row) => row.verification_status === "verified_supported")
    .map((override) => {
      const company = byName.get(normalizeCompanyName(override.company_name));
      return company ? {
        company_id: company.company_id,
        company_name: company.company_name,
        website: company.website_url,
        careers_url: override.careers_url,
        source_provider: override.source_provider,
        source_id: override.source_id,
        source_url: override.source_url,
        metadata_source: company.company_source_url,
        access_method: "Public official careers page or reusable ATS endpoint",
        selection_reason: company.selection_reasons,
        verification_status: override.verification_status,
        employee_count_min: company.employee_count_min,
        employee_count_max: company.employee_count_max,
        employee_size_bucket: company.employee_size_bucket,
        employee_size_confidence: company.employee_size_confidence,
        employee_size_evidence: company.employee_size_evidence,
        industry: company.industry,
        is_new_company: company.is_new_company,
      } : null;
    })
    .filter(Boolean);
  await writeCsv(DISCOVERY_PILOT_PATH, structured, DISCOVERY_PILOT_FIELDS);
  console.log(JSON.stringify({
    imported_candidates: candidates.length,
    imported_original_pilot: pilotRecords.length,
    recorded_overrides: overrides.length - unmatched.length,
    unmatched_overrides: unmatched,
    discovery_pilot_companies: structured.length,
    discovery_pilot_path: DISCOVERY_PILOT_PATH,
  }, null, 2));
}

const [command = "collect", ...args] = process.argv.slice(2);
const options = optionsFrom(args);
if (command === "collect") await collect(options);
else if (command === "export") await exportOnly(options);
else if (command === "verify-links") await verifyOnly(options);
else if (command === "discover") console.log(JSON.stringify(await buildCandidateDataset({
  observedAt: options.observed_at ?? new Date().toISOString(),
}), null, 2));
else if (command === "import-companies") await importCompanyData(options);
else {
  console.error("Usage: node src/cli.js <discover|import-companies|collect|export|verify-links> [options]");
  process.exitCode = 2;
}

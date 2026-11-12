import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../src/csv.js";
import { canonicalDomain } from "../src/company.js";

const root = process.argv[2] ?? ".research/techmap-upstream";
const companiesDirectory = join(root, "companies");
const jobsDirectory = join(root, "jobs");
const categories = JSON.parse(readFileSync(join(root, "categories.json"), "utf8"));
const providers = ["comeet", "greenhouse", "lever", "breezy"];
const providerField = Object.fromEntries(providers.map((name) => [name, `${name}Id`]));

function increment(object, key, amount = 1) {
  object[key] = (object[key] ?? 0) + amount;
}

function hostedPlatform(url) {
  const domain = canonicalDomain(url);
  if (!domain) return "invalid_or_missing";
  const patterns = [
    [/(?:^|\.)ashbyhq\.com$/, "ashby"],
    [/(?:^|\.)workable\.com$/, "workable"],
    [/(?:^|\.)smartrecruiters\.com$/, "smartrecruiters"],
    [/(?:^|\.)myworkdayjobs\.com$|(?:^|\.)workday\.com$/, "workday"],
    [/(?:^|\.)teamtailor\.com$/, "teamtailor"],
    [/(?:^|\.)recruitee\.com$/, "recruitee"],
    [/(?:^|\.)bamboohr\.com$/, "bamboohr"],
    [/(?:^|\.)personio\.(?:com|de)$/, "personio"],
    [/(?:^|\.)comeet\.com$/, "comeet"],
    [/(?:^|\.)greenhouse\.io$/, "greenhouse"],
    [/(?:^|\.)lever\.co$/, "lever"],
    [/(?:^|\.)breezy\.hr$/, "breezy"],
    [/(?:^|\.)applytojob\.com$/, "jazzhr"],
    [/(?:^|\.)eightfold\.ai$/, "eightfold"],
    [/(?:^|\.)jobvite\.com$/, "jobvite"],
    [/(?:^|\.)icims\.com$/, "icims"],
    [/(?:^|\.)oraclecloud\.com$/, "oracle_hcm"],
  ];
  return patterns.find(([pattern]) => pattern.test(domain))?.[1] ?? "company_or_other";
}

const records = [];
let malformed = 0;
for (const file of readdirSync(companiesDirectory)) {
  if (!file.endsWith(".json")) continue;
  try {
    records.push(JSON.parse(readFileSync(join(companiesDirectory, file), "utf8")));
  } catch {
    malformed += 1;
  }
}

const active = records.filter((row) => row.isActive !== false);
const inactive = records.filter((row) => row.isActive === false);
const providerCounts = {};
const activeProviderCounts = {};
const sizeCounts = {};
const categoryCounts = {};
const careersOnlyPlatforms = {};
let anyAts = 0;
let activeAnyAts = 0;
let activeCareers = 0;
let activeWebsite = 0;
let activeRoute = 0;
let activeCareersNoAts = 0;
let activeNoRoute = 0;
let ioActive = 0;
let ioWithRoute = 0;
let ioWithAts = 0;
let multipleAts = 0;

for (const row of records) {
  const configured = providers.filter((provider) => row[providerField[provider]]);
  if (configured.length) anyAts += 1;
  if (configured.length > 1) multipleAts += 1;
  for (const provider of configured) increment(providerCounts, provider);
}

for (const row of active) {
  const configured = providers.filter((provider) => row[providerField[provider]]);
  const hasCareers = Boolean(row.careersUrl);
  const hasRoute = hasCareers || configured.length > 0;
  const isIo = canonicalDomain(row.websiteUrl)?.endsWith(".io") ?? false;
  if (row.websiteUrl) activeWebsite += 1;
  if (hasCareers) activeCareers += 1;
  if (configured.length) activeAnyAts += 1;
  if (hasRoute) activeRoute += 1;
  else activeNoRoute += 1;
  if (hasCareers && !configured.length) {
    activeCareersNoAts += 1;
    increment(careersOnlyPlatforms, hostedPlatform(row.careersUrl));
  }
  for (const provider of configured) increment(activeProviderCounts, provider);
  increment(sizeCounts, row.size ?? "unknown");
  increment(categoryCounts, categories[String(row.categoryId)] ?? `unknown:${row.categoryId}`);
  if (isIo) {
    ioActive += 1;
    if (hasRoute) ioWithRoute += 1;
    if (configured.length) ioWithAts += 1;
  }
}

const jobCategories = {};
let jobRows = 0;
let uniqueJobUrls = new Set();
let minUpdated = null;
let maxUpdated = null;
for (const file of readdirSync(jobsDirectory).filter((name) => name.endsWith(".csv")).sort()) {
  const table = parseCsv(readFileSync(join(jobsDirectory, file), "utf8"));
  const headers = table.shift() ?? [];
  const rows = table.filter((row) => row.some(Boolean));
  const objects = rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
  jobCategories[file.replace(/\.csv$/, "")] = objects.length;
  jobRows += objects.length;
  for (const row of objects) {
    if (row.url) uniqueJobUrls.add(row.url);
    if (row.updated && (!minUpdated || row.updated < minUpdated)) minUpdated = row.updated;
    if (row.updated && (!maxUpdated || row.updated > maxUpdated)) maxUpdated = row.updated;
  }
}

function percentage(part, whole) {
  return whole ? Number((part * 100 / whole).toFixed(1)) : 0;
}

console.log(JSON.stringify({
  source_root: root,
  companies: {
    total: records.length,
    malformed,
    active: active.length,
    inactive: inactive.length,
    active_website: activeWebsite,
    active_careers_url: activeCareers,
    active_any_structured_id: activeAnyAts,
    active_any_route: activeRoute,
    active_careers_without_structured_id: activeCareersNoAts,
    active_no_route: activeNoRoute,
    active_queryable_by_current_techmap_id_adapters: activeAnyAts,
    queryable_percent_of_active: percentage(activeAnyAts, active.length),
    route_percent_of_active: percentage(activeRoute, active.length),
    any_structured_id_all_statuses: anyAts,
    multiple_structured_ids_all_statuses: multipleAts,
  },
  structured_provider_counts_all_statuses: providerCounts,
  structured_provider_counts_active: activeProviderCounts,
  active_size_distribution: sizeCounts,
  active_category_distribution: categoryCounts,
  active_careers_only_platform_hints: careersOnlyPlatforms,
  io_priority_layer: {
    active_io_domains: ioActive,
    with_any_route: ioWithRoute,
    with_structured_id: ioWithAts,
    structured_coverage_percent: percentage(ioWithAts, ioActive),
  },
  legacy_job_exports: {
    category_files: Object.keys(jobCategories).length,
    rows: jobRows,
    unique_urls: uniqueJobUrls.size,
    min_updated_value: minUpdated,
    max_updated_value: maxUpdated,
    by_category: jobCategories,
  },
}, null, 2));

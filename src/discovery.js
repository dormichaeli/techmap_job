import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { readCsv, writeCsv } from "./csv.js";
import {
  canonicalDomain, companyIdFor, normalizeCompanyName, parseTechmapSize, sizeEvidence,
} from "./company.js";

const CANDIDATE_FIELDS = [
  "company_id", "company_name", "canonical_domain", "website_url", "careers_url",
  "ats_provider", "ats_identifier", "source_url", "country", "city", "industry",
  "employee_count", "employee_count_min", "employee_count_max", "employee_size_bucket",
  "employee_size_source", "employee_size_observed_at", "employee_size_confidence",
  "employee_size_evidence", "company_discovered_at", "company_last_checked_at",
  "company_source_url", "company_source_name", "company_source_status", "latest_stage",
  "latest_round_date", "source_description", "known_in_techmap", "is_new_company",
  "is_pilot_company", "selection_score", "selection_reasons",
];

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&mdash;", "-")
    .replaceAll("—", "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseIsraeliFoundersPage(html) {
  const pattern = /<tr><td class="sx-primary"><a href="(\/companies\/[^"?]+)">([\s\S]*?)<\/a><span class="sx-sub">([\s\S]*?)<\/span><\/td><td data-label="Sector">([\s\S]*?)<\/td><td data-label="HQ">([\s\S]*?)<\/td><td data-label="Founded"[^>]*>([\s\S]*?)<\/td><td data-label="Latest round">([\s\S]*?)<\/td><td data-label="Total raised"[^>]*>([\s\S]*?)<\/td><\/tr>/g;
  return [...String(html).matchAll(pattern)].map((match) => {
    const stageMatch = /<span class="sx-sub">([\s\S]*?)<\/span>/.exec(match[7]);
    const stage = decodeHtml(stageMatch?.[1]);
    const date = decodeHtml(match[7].replace(/<span[\s\S]*?<\/span>/, ""));
    return {
      company_name: decodeHtml(match[2]),
      profile_path: match[1],
      description: decodeHtml(match[3]) || null,
      industry: decodeHtml(match[4]) || null,
      city: decodeHtml(match[5]) || null,
      founded: decodeHtml(match[6]) || null,
      latest_round_date: date || null,
      latest_stage: stage || null,
      total_raised: decodeHtml(match[8]) || null,
    };
  });
}

function sourceConfiguration(record) {
  const choices = [
    ["comeet", record.comeetId],
    ["greenhouse", record.greenhouseId],
    ["lever", record.leverId],
    ["breezy", record.breezyId],
  ];
  const found = choices.find(([, identifier]) => identifier);
  if (!found) return { provider: null, identifier: null, url: record.careersUrl ?? null };
  const [provider, identifier] = found;
  const urls = {
    comeet: `https://www.comeet.com/jobs/${identifier}`,
    greenhouse: `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs?content=true`,
    lever: `https://api.lever.co/v0/postings/${identifier}?mode=json`,
    breezy: `https://${identifier}.breezy.hr/json`,
  };
  return { provider, identifier, url: urls[provider] };
}

export function loadTechmapCompanies(directory) {
  const records = [];
  for (const file of readdirSync(directory)) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(directory, file), "utf8"));
      const source = sourceConfiguration(record);
      records.push({
        ...record,
        techmap_file: basename(file),
        normalized_name: normalizeCompanyName(record.name),
        canonical_domain: canonicalDomain(record.websiteUrl),
        source_provider: source.provider,
        source_identifier: source.identifier,
        source_url: source.url,
      });
    } catch {
      // A malformed research record is skipped and never converted into a candidate fact.
    }
  }
  return records;
}

function candidateSelectionScore(candidate) {
  const reasons = [];
  let score = 0;
  const stage = candidate.latest_stage ?? "";
  const industry = `${candidate.industry ?? ""} ${candidate.source_description ?? ""}`;
  if (/pre-seed/i.test(stage)) { score += 32; reasons.push("recent pre-seed company"); }
  else if (/seed/i.test(stage)) { score += 28; reasons.push("recent seed company"); }
  else if (/series a/i.test(stage)) { score += 20; reasons.push("recent Series A company"); }
  else if (/series b/i.test(stage)) { score += 10; reasons.push("Series B company"); }
  else if (/growth|series [cd]|ipo|acquisition/i.test(stage)) { score -= 25; reasons.push("later-stage event"); }
  else { score += 5; reasons.push("current funded-company record"); }

  if (/martech|marketing|adtech|advertis|gaming|consumer|e-?commerce|mobile|subscription|saas|data|analytics|fintech/i.test(industry)) {
    score += 22;
    reasons.push("target-adjacent industry");
  }
  if (/tel aviv|herzliya|ramat gan|petah tikva|raanana|kfar saba|central/i.test(candidate.city ?? "")) {
    score += 10;
    reasons.push("central Israel location");
  }
  if (candidate.employee_size_evidence === "verified_within_10_200") {
    score += 28;
    reasons.push("reported range within 10-200");
  } else if (candidate.employee_size_evidence === "overlaps_10_200") {
    score += 12;
    reasons.push("reported range overlaps 10-200");
  } else if (candidate.employee_size_evidence === "outside_preferred") {
    score -= 30;
    reasons.push("reported range outside 10-200");
  } else {
    reasons.push("company size unknown");
  }
  if (!candidate.known_in_techmap) {
    score += 12;
    reasons.push("not matched in Techmap");
  }
  return { score, reasons: reasons.join("; ") };
}

export async function buildCandidateDataset({
  sourceDirectory = ".research",
  techmapDirectory = ".research/techmap-upstream/companies",
  pilotPath = "data/companies.csv",
  outputPath = "data/company_candidates.csv",
  observedAt = new Date().toISOString(),
  limit = 120,
} = {}) {
  const sourceRows = [];
  for (let page = 1; page <= 6; page += 1) {
    const path = join(sourceDirectory, `israeli-founders-companies-${page}.html`);
    sourceRows.push(...parseIsraeliFoundersPage(readFileSync(path, "utf8")));
  }
  const pilot = await readCsv(pilotPath);
  const pilotNames = new Set(pilot.map((row) => normalizeCompanyName(row.company_name)));
  const techmap = loadTechmapCompanies(techmapDirectory);
  const techmapByName = new Map();
  for (const row of techmap) {
    if (row.normalized_name && !techmapByName.has(row.normalized_name)) techmapByName.set(row.normalized_name, row);
  }

  const unique = new Map();
  for (const source of sourceRows) {
    const normalized = normalizeCompanyName(source.company_name);
    if (!normalized || pilotNames.has(normalized) || unique.has(normalized)) continue;
    const matched = techmapByName.get(normalized) ?? null;
    const range = parseTechmapSize(matched?.size);
    const canonical = canonicalDomain(matched?.websiteUrl);
    const candidate = {
      company_id: null,
      company_name: source.company_name,
      canonical_domain: canonical,
      website_url: matched?.websiteUrl ?? null,
      careers_url: matched?.careersUrl ?? null,
      ats_provider: matched?.source_provider ?? null,
      ats_identifier: matched?.source_identifier ?? null,
      source_url: matched?.source_url ?? matched?.careersUrl ?? null,
      country: "Israel",
      city: source.city ?? matched?.addresses?.[0]?.city ?? null,
      industry: source.industry,
      employee_count: null,
      employee_count_min: range.min,
      employee_count_max: range.max,
      employee_size_bucket: range.bucket,
      employee_size_source: matched?.size ? "Techmap size field" : null,
      employee_size_observed_at: matched?.size ? observedAt : null,
      employee_size_confidence: matched?.size ? "medium" : "unknown",
      employee_size_evidence: sizeEvidence(range.min, range.max),
      company_discovered_at: observedAt,
      company_last_checked_at: null,
      company_source_url: `https://israelifounders.com${source.profile_path}`,
      company_source_name: "Israeli Founders / Israel Rounds",
      company_source_status: matched?.isActive === false ? "company_inactive" : "needs_manual_review",
      latest_stage: source.latest_stage,
      latest_round_date: source.latest_round_date,
      source_description: source.description,
      known_in_techmap: matched ? 1 : 0,
      // Every selected row is new to this project's company table; Techmap overlap is tracked separately.
      is_new_company: 1,
      is_pilot_company: 0,
      selection_score: 0,
      selection_reasons: null,
    };
    candidate.company_id = companyIdFor(candidate);
    const selection = candidateSelectionScore(candidate);
    candidate.selection_score = selection.score;
    candidate.selection_reasons = selection.reasons;
    unique.set(normalized, candidate);
  }

  const ranked = [...unique.values()].sort((a, b) =>
    b.selection_score - a.selection_score
      || String(b.latest_round_date).localeCompare(String(a.latest_round_date))
      || a.company_name.localeCompare(b.company_name));
  const selected = [];
  let pureCyber = 0;
  for (const row of ranked) {
    const isPureCyber = /cyber|security/i.test(row.industry ?? "")
      && !/martech|marketing|data|analytics|consumer|gaming|fintech|saas/i.test(row.industry ?? "");
    if (isPureCyber && pureCyber >= 35) continue;
    selected.push(row);
    if (isPureCyber) pureCyber += 1;
    if (selected.length >= limit) break;
  }
  await writeCsv(outputPath, selected, CANDIDATE_FIELDS);
  return {
    source_records: sourceRows.length,
    deduplicated_non_pilot: unique.size,
    selected: selected.length,
    known_in_techmap: selected.filter((row) => row.known_in_techmap).length,
    new_to_techmap: selected.filter((row) => !row.known_in_techmap).length,
    strict_size: selected.filter((row) => row.employee_size_evidence === "verified_within_10_200").length,
    overlapping_size: selected.filter((row) => row.employee_size_evidence === "overlaps_10_200").length,
    unknown_size: selected.filter((row) => row.employee_size_evidence === "unknown").length,
  };
}

import { request, mapBounded, HttpError } from "./http.js";

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function isoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function stripHtml(value) {
  if (!value) return null;
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function result(jobs, sourceUrl, httpStatus = 200) {
  return { status: jobs.length ? "success" : "empty", jobs, sourceUrl, httpStatus, error: null };
}

function invalidResponse(message, httpStatus) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  return error;
}

function unavailableResponse(message, httpStatus) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.sourceState = "stale";
  return error;
}

function common(raw, company, provider, sourceUrl) {
  return {
    company_name: company.company_name,
    source_provider: provider,
    source_url: sourceUrl,
    raw,
  };
}

async function greenhouse(company) {
  const sourceUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.source_id)}/jobs?content=true`;
  const { data, status } = await request(sourceUrl);
  if (!Array.isArray(data?.jobs)) throw invalidResponse("Invalid Greenhouse response: jobs is not an array", status);
  return result(data.jobs.map((raw) => ({
    ...common(raw, company, "greenhouse", sourceUrl),
    source_job_id: text(raw.id),
    job_title: text(raw.title),
    location: text(raw.location?.name),
    remote_type: /remote/i.test(raw.location?.name ?? "") ? "remote" : null,
    department: text(raw.departments?.map((item) => item.name).filter(Boolean).join(" / ")),
    description: stripHtml(raw.content),
    job_url: text(raw.absolute_url),
    apply_url: text(raw.absolute_url),
    source_updated_at: text(raw.updated_at),
  })), sourceUrl, status);
}

async function lever(company) {
  const sourceUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(company.source_id)}?mode=json`;
  const { data, status } = await request(sourceUrl);
  if (!Array.isArray(data)) throw invalidResponse("Invalid Lever response: expected an array", status);
  return result(data.map((raw) => ({
    ...common(raw, company, "lever", sourceUrl),
    source_job_id: text(raw.id),
    job_title: text(raw.text),
    location: text(raw.categories?.location ?? raw.categories?.allLocations?.join(", ")),
    remote_type: text(raw.workplaceType),
    department: text(raw.categories?.department ?? raw.categories?.team),
    description: text(raw.descriptionPlain) ?? stripHtml(raw.description),
    job_url: text(raw.hostedUrl),
    apply_url: text(raw.applyUrl) ?? text(raw.hostedUrl),
    source_updated_at: null,
    published_at: isoDate(raw.createdAt),
    published_at_source: isoDate(raw.createdAt) ? "lever.createdAt" : null,
  })), sourceUrl, status);
}

async function ashby(company) {
  const sourceUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.source_id)}?includeCompensation=true`;
  const { data, status } = await request(sourceUrl);
  if (!Array.isArray(data?.jobs)) throw new Error("Invalid Ashby response: jobs is not an array");
  return result(data.jobs.filter((raw) => raw.isListed !== false).map((raw) => ({
    ...common(raw, company, "ashby", sourceUrl),
    source_job_id: text(raw.id ?? raw.jobUrl ?? raw.applyUrl),
    job_title: text(raw.title),
    location: text([raw.location, ...(raw.secondaryLocations ?? []).map((item) => item.location)].filter(Boolean).join("; ")),
    remote_type: raw.isRemote === true ? "remote" : text(raw.locationType),
    department: text(raw.department ?? raw.team),
    description: text(raw.descriptionPlain) ?? stripHtml(raw.descriptionHtml),
    job_url: text(raw.jobUrl),
    apply_url: text(raw.applyUrl) ?? text(raw.jobUrl),
    source_updated_at: null,
    published_at: isoDate(raw.publishedAt),
    published_at_source: isoDate(raw.publishedAt) ? "ashby.publishedAt" : null,
  })), sourceUrl, status);
}

async function workable(company) {
  const sourceUrl = `https://www.workable.com/api/accounts/${encodeURIComponent(company.source_id)}?details=true`;
  const { data, status } = await request(sourceUrl);
  const rows = data?.jobs ?? data?.results;
  if (!Array.isArray(rows)) throw new Error("Invalid Workable response: jobs/results is not an array");
  return result(rows.map((raw) => ({
    ...common(raw, company, "workable", sourceUrl),
    source_job_id: text(raw.shortcode ?? raw.id),
    job_title: text(raw.title ?? raw.full_title),
    location: text(raw.location?.location_str ?? raw.location ?? raw.city),
    remote_type: text(raw.location?.workplace_type) ?? (raw.telecommuting ? "remote" : null),
    department: text(raw.department),
    description: stripHtml(raw.description ?? raw.full_description),
    job_url: text(raw.url ?? raw.shortlink),
    apply_url: text(raw.application_url ?? raw.shortlink ?? raw.url),
    source_updated_at: null,
    published_at: isoDate(raw.published_at ?? raw.published),
    published_at_source: isoDate(raw.published_at ?? raw.published) ? "workable.published" : null,
  })), sourceUrl, status);
}

async function smartrecruiters(company) {
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.source_id)}/postings`;
  const rows = [];
  let offset = 0;
  let httpStatus = 200;
  while (true) {
    const pageUrl = `${base}?limit=100&offset=${offset}&destination=PUBLIC`;
    const response = await request(pageUrl);
    httpStatus = response.status;
    if (!Array.isArray(response.data?.content) || typeof response.data?.totalFound !== "number") {
      throw new Error("Invalid SmartRecruiters response");
    }
    rows.push(...response.data.content);
    offset += response.data.content.length;
    if (!response.data.content.length || offset >= response.data.totalFound) break;
  }
  const details = await mapBounded(rows, 4, async (raw) => {
    try {
      const response = await request(`${base}/${encodeURIComponent(raw.id ?? raw.uuid)}`, { retries: 1 });
      return { ...raw, ...response.data };
    } catch {
      return raw;
    }
  });
  const sourceUrl = `${base}?limit=100&offset=0&destination=PUBLIC`;
  return result(details.map((raw) => ({
    ...common(raw, company, "smartrecruiters", sourceUrl),
    source_job_id: text(raw.id ?? raw.uuid),
    job_title: text(raw.name),
    location: text([raw.location?.city, raw.location?.region, raw.location?.country].filter(Boolean).join(", ")),
    remote_type: text(raw.location?.remote ? "remote" : raw.location?.locationType),
    department: text(raw.department?.label ?? raw.function?.label),
    description: stripHtml([
      raw.jobAd?.sections?.jobDescription?.text,
      raw.jobAd?.sections?.qualifications?.text,
      raw.jobAd?.sections?.additionalInformation?.text,
    ].filter(Boolean).join(" ")),
    job_url: text(raw.postingUrl),
    apply_url: text(raw.applyUrl) ?? text(raw.postingUrl),
    source_updated_at: null,
    published_at: isoDate(raw.releasedDate),
    published_at_source: isoDate(raw.releasedDate) ? "smartrecruiters.releasedDate" : null,
  })), sourceUrl, httpStatus);
}

export function extractAssignedJson(html, variableName) {
  const assignment = new RegExp(`${variableName}\\s*=\\s*`).exec(html);
  if (!assignment) return null;
  const marker = assignment.index + assignment[0].length;
  const startArray = html.indexOf("[", marker);
  const startObject = html.indexOf("{", marker);
  let start = startArray;
  if (start < 0 || (startObject >= 0 && startObject < start)) start = startObject;
  if (start < 0) return null;
  const opening = html[start];
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }
  return null;
}

async function comeet(company) {
  const sourceUrl = `https://www.comeet.com/jobs/${company.source_id}`;
  const { data: html, status } = await request(sourceUrl, { responseType: "text" });
  if (/Spark Hire Recruit account has been deactivated/i.test(html)) {
    throw unavailableResponse("Comeet/Spark Hire Recruit account is deactivated", status);
  }
  const extracted = extractAssignedJson(html, "COMPANY_POSITIONS_DATA");
  const rows = Array.isArray(extracted) ? extracted : extracted?.positions;
  if (!Array.isArray(rows)) throw invalidResponse("Comeet public board did not contain COMPANY_POSITIONS_DATA", status);
  return result(rows.map((raw) => ({
    ...common(raw, company, "comeet", sourceUrl),
    source_job_id: text(raw.uid),
    job_title: text(raw.name),
    location: text(raw.location?.name ?? [raw.location?.city, raw.location?.country].filter(Boolean).join(", ")),
    remote_type: text(raw.workplace_type),
    department: text(raw.department),
    description: stripHtml(raw.custom_fields?.details?.map?.((item) => item.value ?? item.content).join(" ") ?? raw.description),
    job_url: text(raw.url_comeet_hosted_page ?? raw.url_active_page),
    apply_url: text(raw.url_active_page ?? raw.url_comeet_hosted_page),
    source_updated_at: text(raw.time_updated),
  })), sourceUrl, status);
}

async function breezy(company) {
  const sourceUrl = `https://${encodeURIComponent(company.source_id)}.breezy.hr/json`;
  const { data, status } = await request(sourceUrl);
  if (!Array.isArray(data)) throw invalidResponse("Invalid Breezy response: expected an array", status);
  return result(data.map((raw) => ({
    ...common(raw, company, "breezy", sourceUrl),
    source_job_id: text(raw.id ?? raw.friendly_id),
    job_title: text(raw.name),
    location: text(raw.location?.name ?? raw.location),
    remote_type: raw.remote ? "remote" : null,
    department: text(raw.department?.name ?? raw.department),
    description: null,
    job_url: text(raw.url ?? `https://${company.source_id}.breezy.hr/p/${raw.friendly_id}`),
    apply_url: text(raw.url ?? `https://${company.source_id}.breezy.hr/p/${raw.friendly_id}`),
    source_updated_at: null,
  })), sourceUrl, status);
}

async function workday(company) {
  const [host, site] = company.source_id.split("/", 2);
  if (!host || !site || !/\.myworkdayjobs\.com$/i.test(host)) throw new Error("Invalid Workday source_id; expected host/site");
  const tenant = host.split(".")[0];
  const base = `https://${host}/wday/cxs/${tenant}/${site}`;
  const rows = [];
  let offset = 0;
  let httpStatus = 200;
  while (true) {
    const response = await request(`${base}/jobs`, {
      method: "POST",
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: "" }),
      headers: { "content-type": "application/json" },
    });
    httpStatus = response.status;
    if (!Array.isArray(response.data?.jobPostings) || typeof response.data?.total !== "number") {
      throw new Error("Invalid Workday response");
    }
    rows.push(...response.data.jobPostings);
    offset += response.data.jobPostings.length;
    if (!response.data.jobPostings.length || offset >= response.data.total) break;
  }
  const sourceUrl = `https://${host}/${site}`;
  return result(rows.map((raw) => {
    const jobUrl = raw.externalPath ? `https://${host}${raw.externalPath}` : null;
    return {
      ...common(raw, company, "workday", sourceUrl),
      source_job_id: text(raw.bulletFields?.[0] ?? raw.externalPath),
      job_title: text(raw.title),
      location: text(raw.locationsText),
      remote_type: /remote/i.test(raw.locationsText ?? "") ? "remote" : null,
      department: null,
      description: null,
      job_url: jobUrl,
      apply_url: jobUrl,
      source_updated_at: null,
    };
  }), sourceUrl, httpStatus);
}

function jsonLdNodes(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) jsonLdNodes(item, output);
  } else if (value && typeof value === "object") {
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (types.some((type) => String(type).toLowerCase() === "jobposting")) output.push(value);
    if (value["@graph"]) jsonLdNodes(value["@graph"], output);
  }
  return output;
}

function jsonLdLocation(raw) {
  const locations = Array.isArray(raw.jobLocation) ? raw.jobLocation : [raw.jobLocation];
  const labels = locations.filter(Boolean).map((location) => {
    const address = location.address ?? location;
    return [address.addressLocality, address.addressRegion, address.addressCountry?.name ?? address.addressCountry]
      .filter(Boolean).join(", ");
  }).filter(Boolean);
  return text(labels.join("; ")) ?? text(raw.jobLocationType);
}

export function parseJsonLdJobPostings(html, company, sourceUrl) {
  const nodes = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonLdNodes(JSON.parse(match[1]), nodes);
    } catch {
      // Invalid JSON-LD blocks are ignored; a page with no valid jobs is reported empty.
    }
  }
  const seen = new Set();
  const jobs = [];
  for (const raw of nodes) {
    const identity = text(raw.identifier?.value ?? raw.identifier ?? raw.url ?? `${raw.title}|${jsonLdLocation(raw)}`);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    const published = isoDate(raw.datePosted);
    jobs.push({
      ...common(raw, company, "jsonld", sourceUrl),
      source_job_id: identity,
      job_title: text(raw.title),
      location: jsonLdLocation(raw),
      remote_type: /telecommute|remote/i.test(`${raw.jobLocationType ?? ""} ${raw.description ?? ""}`) ? "remote" : null,
      department: text(raw.occupationalCategory),
      description: stripHtml(raw.description),
      job_url: text(raw.url) ?? sourceUrl,
      apply_url: text(raw.url) ?? sourceUrl,
      source_updated_at: null,
      published_at: published,
      published_at_source: published ? "jsonld.datePosted" : null,
    });
  }
  return jobs;
}

async function jsonld(company) {
  const sourceUrl = company.source_url ?? company.careers_url ?? company.source_id;
  const { data: html, status, finalUrl } = await request(sourceUrl, { responseType: "text" });
  return result(parseJsonLdJobPostings(html, company, finalUrl), finalUrl, status);
}

async function custom(company) {
  try {
    const response = await request(company.source_url, { responseType: "text", retries: 1 });
    return {
      status: "unsupported_accessible",
      jobs: [],
      sourceUrl: company.source_url,
      httpStatus: response.status,
      error: "Accessible custom careers page; no safe structured adapter implemented",
    };
  } catch (error) {
    return {
      status: "unsupported_unreachable",
      jobs: [],
      sourceUrl: company.source_url,
      httpStatus: error.status ?? error.httpStatus ?? 0,
      sourceState: error.sourceState ?? null,
      error: error.message,
    };
  }
}

const ADAPTERS = { greenhouse, lever, ashby, workable, smartrecruiters, comeet, breezy, workday, jsonld, custom };

export async function collectCompany(company) {
  const adapter = ADAPTERS[company.source_provider];
  if (!adapter) return { status: "unsupported", jobs: [], sourceUrl: company.source_url, httpStatus: 0, error: "No adapter" };
  try {
    return await adapter(company);
  } catch (error) {
    const transient = error instanceof HttpError ? error.retryable : false;
    return {
      status: transient ? "failed_transient" : "failed_permanent",
      jobs: [],
      sourceUrl: company.source_url,
      httpStatus: error.status ?? error.httpStatus ?? 0,
      sourceState: error.sourceState ?? null,
      error: error.message,
    };
  }
}

import { createHash } from "node:crypto";

export function normalizeCompanyName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:ltd|limited|inc|incorporated|corp|corporation|company|technologies|technology)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
export function canonicalDomain(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

export function companyIdFor(company) {
  const domain = canonicalDomain(company.canonical_domain ?? company.website_url);
  const name = normalizeCompanyName(company.company_name);
  const identity = domain ? `domain:${domain}` : `name:${name}`;
  return createHash("sha256").update(identity).digest("hex");
}

export function sizeEvidence(minimum, maximum) {
  const min = minimum === null || minimum === undefined || minimum === "" ? null : Number(minimum);
  const max = maximum === null || maximum === undefined || maximum === "" ? null : Number(maximum);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return "unknown";
  if (Number.isFinite(min) && min > 200) return "outside_preferred";
  if (Number.isFinite(max) && max < 10) return "outside_preferred";
  if (Number.isFinite(min) && Number.isFinite(max) && min >= 10 && max <= 200) {
    return "verified_within_10_200";
  }
  return "overlaps_10_200";
}

export function matchesCompanySize(company, { mode = "broad", minimum = 10, maximum = 200 } = {}) {
  if (mode === "all") return true;
  const min = company.employee_count_min === null || company.employee_count_min === undefined
    ? null : Number(company.employee_count_min);
  const max = company.employee_count_max === null || company.employee_count_max === undefined
    ? null : Number(company.employee_count_max);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return false;
  if (mode === "strict") {
    return Number.isFinite(min) && Number.isFinite(max) && min >= minimum && max <= maximum;
  }
  const lower = Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY;
  const upper = Number.isFinite(max) ? max : Number.POSITIVE_INFINITY;
  return lower <= maximum && upper >= minimum;
}

export function parseTechmapSize(code) {
  const ranges = {
    xs: { min: 1, max: 10, bucket: "1-10" },
    s: { min: 11, max: 50, bucket: "11-50" },
    m: { min: 51, max: 200, bucket: "51-200" },
    l: { min: 201, max: 1000, bucket: "201-1000" },
    xl: { min: 1001, max: null, bucket: "1001+" },
  };
  return ranges[String(code ?? "").toLowerCase()] ?? { min: null, max: null, bucket: "unknown" };
}

export function jerusalemDateTime(isoValue) {
  if (!isoValue) return null;
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).format(date);
}

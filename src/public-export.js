import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJson } from "./checkpoint.js";

export const PUBLIC_EXPORT_FORMAT = "techmap-job-public-export";
export const PUBLIC_EXPORT_VERSION = 1;
export const PUBLIC_JOB_FIELDS = Object.freeze([
  "job_id", "company_name", "job_title", "location", "job_category", "company_size",
  "source_provider", "application_url", "first_discovered_at", "original_publication_date",
  "vacancy_status", "last_successful_source_observation",
]);

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function publicUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function stringOrNull(value) {
  return value === null || value === undefined || value === "" ? null : String(value);
}

export function buildPublicJobs(db) {
  const rows = db.prepare(`
    SELECT
      j.job_id, j.company_name, j.job_title, j.location, j.department,
      c.employee_count_min, c.employee_count_max, c.employee_size_bucket,
      j.source_provider, j.apply_url, j.job_url, j.first_seen_at, j.published_at,
      j.active,
      (
        SELECT MAX(o.observed_at) FROM source_observations o
        WHERE o.company_source_id=j.company_source_id AND o.health_status IN ('success', 'empty')
      ) last_successful_source_observation
    FROM jobs j
    LEFT JOIN companies c ON c.company_id=j.company_id
    ORDER BY j.job_id
  `).all();
  return rows.map((row) => ({
    job_id: row.job_id,
    company_name: stringOrNull(row.company_name),
    job_title: stringOrNull(row.job_title),
    location: stringOrNull(row.location),
    job_category: stringOrNull(row.department),
    company_size: {
      minimum_employees: row.employee_count_min ?? null,
      maximum_employees: row.employee_count_max ?? null,
      bucket: stringOrNull(row.employee_size_bucket),
    },
    source_provider: stringOrNull(row.source_provider),
    application_url: publicUrl(row.apply_url) ?? publicUrl(row.job_url),
    first_discovered_at: row.first_seen_at,
    original_publication_date: row.published_at ?? null,
    vacancy_status: Number(row.active) === 1 ? "active" : "closed",
    last_successful_source_observation: row.last_successful_source_observation ?? null,
  }));
}

export function validatePublicJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error("Public export jobs must be an array");
  for (const job of jobs) {
    const keys = Object.keys(job).sort();
    const expected = [...PUBLIC_JOB_FIELDS].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(`Public job ${job.job_id ?? "unknown"} has an unapproved field set`);
    if (!/^[0-9a-f]{64}$/.test(job.job_id)) throw new Error("Public job_id is invalid");
    if (!new Set(["active", "closed"]).has(job.vacancy_status)) throw new Error("Public vacancy_status is invalid");
    if (job.application_url && !/^https?:\/\//.test(job.application_url)) throw new Error("Public application URL is invalid");
    if (!job.first_discovered_at || !Number.isFinite(Date.parse(job.first_discovered_at))) throw new Error("Public first-discovered date is invalid");
    if (job.original_publication_date !== null && !Number.isFinite(Date.parse(job.original_publication_date))) throw new Error("Public publication date is invalid");
  }
  return jobs;
}

export function generatePublicExport(db, outputDirectory, {
  generatedAt = new Date().toISOString(),
  pageSize = 500,
} = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5_000) throw new Error("Public export pageSize must be 1-5000");
  const jobs = validatePublicJobs(buildPublicJobs(db));
  const output = resolve(outputDirectory);
  const pagesDirectory = join(output, "pages");
  mkdirSync(pagesDirectory, { recursive: true });
  const pageFiles = [];
  for (let offset = 0; offset < jobs.length; offset += pageSize) {
    const pageNumber = Math.floor(offset / pageSize) + 1;
    const filename = `jobs-v1-${String(pageNumber).padStart(4, "0")}.json`;
    const path = join(pagesDirectory, filename);
    writeFileSync(path, canonicalJson({
      format: PUBLIC_EXPORT_FORMAT,
      version: PUBLIC_EXPORT_VERSION,
      generated_at: generatedAt,
      page: pageNumber,
      page_size: pageSize,
      jobs: jobs.slice(offset, offset + pageSize),
    }));
    pageFiles.push({ file: `pages/${filename}`, bytes: statSync(path).size, sha256: sha256(path) });
  }
  const fullPath = join(output, "jobs-v1.json");
  writeFileSync(fullPath, canonicalJson({
    format: PUBLIC_EXPORT_FORMAT,
    version: PUBLIC_EXPORT_VERSION,
    generated_at: generatedAt,
    jobs,
  }));
  const gzipPath = `${fullPath}.gz`;
  writeFileSync(gzipPath, gzipSync(readFileSync(fullPath), { level: 9, mtime: 0 }));
  const index = {
    format: PUBLIC_EXPORT_FORMAT,
    version: PUBLIC_EXPORT_VERSION,
    generated_at: generatedAt,
    job_count: jobs.length,
    active_jobs: jobs.filter((job) => job.vacancy_status === "active").length,
    closed_jobs: jobs.filter((job) => job.vacancy_status === "closed").length,
    page_size: pageSize,
    pages: pageFiles,
    full: { file: "jobs-v1.json", bytes: statSync(fullPath).size, sha256: sha256(fullPath) },
    compressed: { file: "jobs-v1.json.gz", bytes: statSync(gzipPath).size, sha256: sha256(gzipPath) },
    attribution: {
      notice: "Includes data derived from Techmap; attribute Michael Lugassy and the Techmap project. Review ODbL 1.0 obligations before redistribution.",
      license_url: "https://opendatacommons.org/licenses/odbl/1-0/",
      source_url: "https://github.com/mluggy/techmap",
    },
  };
  const indexPath = join(output, "index.json");
  writeFileSync(indexPath, canonicalJson(index));
  return { output_directory: output, index_path: indexPath, ...index };
}

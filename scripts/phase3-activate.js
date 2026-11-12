import { resolve } from "node:path";
import { readCsv, writeCsv } from "../src/csv.js";
import { activateCompanySources, openStore } from "../src/store.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const dbPath = resolve(option("--db", "data/jobs.sqlite"));
const outputPath = option("--output", "data/phase3-activated-sources.csv");
const observedAt = option("--observed-at", new Date().toISOString());
const validations = await readCsv(resolve("data/phase3-approved-revalidation.csv"));
if (validations.length !== 3) throw new Error(`Expected three approved validations, found ${validations.length}`);

const db = openStore(dbPath);
try {
  const events = activateCompanySources(db, validations, { observedAt });
  const sourceIds = events.map((event) => event.source_id);
  const sources = sourceIds.map((sourceId) => db.prepare(`
    SELECT c.company_id, s.source_id company_source_id, c.company_name,
      c.website_url website, COALESCE(s.careers_url, c.careers_url) careers_url,
      s.provider source_provider, s.source_identifier source_id, s.source_url,
      c.employee_count_min, c.employee_count_max, c.employee_size_bucket,
      c.employee_size_confidence, c.employee_size_evidence, c.industry,
      s.evidence_status, s.evidence_url, s.is_enabled
    FROM company_sources s JOIN companies c ON c.company_id=s.company_id
    WHERE s.source_id=?
  `).get(sourceId));
  if (outputPath) {
    await writeCsv(resolve(outputPath), sources, Object.keys(sources[0]));
  }
  const auditEvents = db.prepare(`
    SELECT e.activation_key, e.source_id, e.company_id, e.action,
      e.previous_evidence_status, e.new_evidence_status,
      e.previous_is_enabled, e.new_is_enabled, e.evidence_url, e.evidence_summary, e.observed_at
    FROM company_source_activation_events e
    WHERE e.activation_key LIKE 'phase3-approved-ats-2026-11-12:%'
    ORDER BY e.source_id
  `).all();
  console.log(JSON.stringify({
    database: dbPath,
    schema_version: db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version,
    activated_sources: sources,
    audit_events: auditEvents,
    enabled_imported_unverified: db.prepare(`
      SELECT COUNT(*) count FROM company_sources
      WHERE evidence_status='imported_unverified' AND is_enabled<>0
    `).get().count,
  }, null, 2));
} finally {
  db.close();
}

import { resolve } from "node:path";
import { readCsv, writeCsv } from "../src/csv.js";
import { activateCompanySources, openStore } from "../src/store.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const cohort = String(option("--cohort", "")).toUpperCase();
if (!new Set(["A", "B"]).has(cohort)) throw new Error("--cohort must be A or B");
const inputPath = resolve(`data/phase4-cohort-${cohort.toLowerCase()}-sources.csv`);
const outputPath = resolve(`data/phase4-cohort-${cohort.toLowerCase()}-activated.csv`);
const combinedPath = resolve("data/phase4-activated-sources.csv");
const observedAt = option("--observed-at", new Date().toISOString());
const activationBatch = `phase4-cohort-${cohort.toLowerCase()}-2026-11-12`;
const validations = await readCsv(inputPath);
if (!validations.length || validations.length > 10) throw new Error(`Invalid cohort ${cohort} size: ${validations.length}`);

const db = openStore(resolve("data/jobs.sqlite"));
try {
  const events = activateCompanySources(db, validations, {
    activationBatch,
    evidenceSource: `Phase 4 cohort ${cohort} fresh official-domain ownership and live ATS validation`,
    observedAt,
  });
  const sources = events.map(({ source_id, activation_key }) => ({
    ...db.prepare(`
      SELECT c.company_id, s.source_id company_source_id, c.company_name,
        c.website_url website, COALESCE(s.careers_url, c.careers_url) careers_url,
        s.provider source_provider, s.source_identifier source_id, s.source_url,
        c.employee_count_min, c.employee_count_max, c.employee_size_bucket,
        c.employee_size_confidence, c.employee_size_evidence, c.industry,
        s.evidence_status, s.evidence_url, s.is_enabled
      FROM company_sources s JOIN companies c ON c.company_id=s.company_id
      WHERE s.source_id=?
    `).get(source_id),
    activation_key,
    phase4_cohort: cohort,
    activated_at: observedAt,
  }));
  await writeCsv(outputPath, sources, Object.keys(sources[0]));
  const prior = await readCsv(combinedPath).catch(() => []);
  const merged = [...new Map([...prior, ...sources].map((row) => [row.company_source_id, row])).values()];
  await writeCsv(combinedPath, merged, Object.keys(merged[0]));
  console.log(JSON.stringify({ cohort, activationBatch, sources, audit_events: events.length }, null, 2));
} finally {
  db.close();
}

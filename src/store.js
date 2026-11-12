import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumn(db, table, definition) {
  const name = definition.trim().split(/\s+/, 1)[0];
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export function migrateTechmapSchema(db, appliedAt = new Date().toISOString(), { withinTransaction = false } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=4").get()) return false;

  if (!withinTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE company_external_ids (
        source_name TEXT NOT NULL,
        external_id TEXT NOT NULL,
        company_id TEXT NOT NULL REFERENCES companies(company_id),
        external_name TEXT,
        evidence_url TEXT,
        identity_status TEXT NOT NULL,
        source_is_active INTEGER,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        raw_json TEXT,
        PRIMARY KEY (source_name, external_id)
      );
      CREATE INDEX company_external_ids_company
        ON company_external_ids(company_id, source_name);

      CREATE TABLE company_aliases (
        alias_id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(company_id),
        alias_name TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        alias_type TEXT NOT NULL,
        source_name TEXT NOT NULL,
        external_id TEXT,
        evidence_url TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (source_name, external_id, normalized_alias)
      );
      CREATE INDEX company_aliases_company
        ON company_aliases(company_id, normalized_alias);

      CREATE TABLE company_sources (
        source_id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(company_id),
        source_kind TEXT NOT NULL,
        provider TEXT,
        source_identifier TEXT,
        source_url TEXT,
        careers_url TEXT,
        evidence_source TEXT NOT NULL,
        evidence_status TEXT NOT NULL,
        evidence_url TEXT,
        is_enabled INTEGER NOT NULL DEFAULT 0,
        effective_from TEXT,
        effective_to TEXT,
        imported_at TEXT NOT NULL,
        last_observed_at TEXT,
        raw_json TEXT
      );
      CREATE UNIQUE INDEX company_sources_identity
        ON company_sources (
          company_id,
          source_kind,
          COALESCE(provider, ''),
          COALESCE(source_identifier, ''),
          COALESCE(source_url, '')
        );
      CREATE INDEX company_sources_company_status
        ON company_sources(company_id, evidence_status, is_enabled);
      CREATE INDEX company_sources_provider_identifier
        ON company_sources(provider, source_identifier)
        WHERE provider IS NOT NULL AND source_identifier IS NOT NULL;
    `);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?)").run(appliedAt);
    if (!withinTransaction) db.exec("COMMIT");
  } catch (error) {
    if (!withinTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

export function migratePhase3Schema(db, appliedAt = new Date().toISOString(), { withinTransaction = false } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=5").get()) return false;

  if (!withinTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    addColumn(db, "jobs", "company_source_id TEXT REFERENCES company_sources(source_id)");
    addColumn(db, "source_observations", "company_id TEXT REFERENCES companies(company_id)");
    addColumn(db, "source_observations", "company_source_id TEXT REFERENCES company_sources(source_id)");
    db.exec(`
      CREATE TABLE company_source_activation_events (
        event_id INTEGER PRIMARY KEY,
        activation_key TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL REFERENCES company_sources(source_id),
        company_id TEXT NOT NULL REFERENCES companies(company_id),
        action TEXT NOT NULL,
        previous_evidence_status TEXT NOT NULL,
        new_evidence_status TEXT NOT NULL,
        previous_is_enabled INTEGER NOT NULL,
        new_is_enabled INTEGER NOT NULL,
        evidence_url TEXT,
        evidence_summary TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        raw_json TEXT
      );
      CREATE INDEX company_source_activation_events_source
        ON company_source_activation_events(source_id, observed_at);
    `);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?)").run(appliedAt);
    if (!withinTransaction) db.exec("COMMIT");
  } catch (error) {
    if (!withinTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version));
  const now = new Date().toISOString();

  if (!applied.has(1)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS companies (
          company_id TEXT PRIMARY KEY,
          company_name TEXT NOT NULL,
          canonical_domain TEXT,
          website_url TEXT,
          careers_url TEXT,
          ats_provider TEXT,
          ats_identifier TEXT,
          source_url TEXT,
          country TEXT,
          city TEXT,
          industry TEXT,
          employee_count INTEGER,
          employee_count_min INTEGER,
          employee_count_max INTEGER,
          employee_size_bucket TEXT NOT NULL DEFAULT 'unknown',
          employee_size_source TEXT,
          employee_size_observed_at TEXT,
          employee_size_confidence TEXT NOT NULL DEFAULT 'unknown',
          employee_size_evidence TEXT NOT NULL DEFAULT 'unknown',
          company_discovered_at TEXT NOT NULL,
          company_last_checked_at TEXT,
          company_source_url TEXT,
          company_source_name TEXT,
          company_source_status TEXT NOT NULL,
          latest_stage TEXT,
          latest_round_date TEXT,
          source_description TEXT,
          known_in_techmap INTEGER NOT NULL DEFAULT 0,
          is_new_company INTEGER NOT NULL DEFAULT 0,
          is_pilot_company INTEGER NOT NULL DEFAULT 0,
          selection_score INTEGER NOT NULL DEFAULT 0,
          selection_reasons TEXT,
          raw_json TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS companies_domain
          ON companies(canonical_domain) WHERE canonical_domain IS NOT NULL;
        CREATE INDEX IF NOT EXISTS companies_size
          ON companies(employee_count_min, employee_count_max, employee_size_confidence);
        CREATE TABLE IF NOT EXISTS company_observations (
          company_id TEXT NOT NULL REFERENCES companies(company_id),
          observed_at TEXT NOT NULL,
          source_name TEXT NOT NULL,
          source_url TEXT,
          raw_json TEXT,
          PRIMARY KEY (company_id, observed_at, source_name)
        );
        CREATE TABLE IF NOT EXISTS company_source_verifications (
          verification_id INTEGER PRIMARY KEY,
          company_id TEXT NOT NULL REFERENCES companies(company_id),
          careers_url TEXT,
          source_provider TEXT,
          source_identifier TEXT,
          source_url TEXT,
          verification_status TEXT NOT NULL,
          http_status INTEGER,
          job_count INTEGER,
          error TEXT,
          observed_at TEXT NOT NULL,
          evidence_source TEXT,
          is_manual_override INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS company_source_status
          ON company_source_verifications(company_id, observed_at DESC);
      `);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  if (!applied.has(2)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      addColumn(db, "jobs", "company_id TEXT REFERENCES companies(company_id)");
      addColumn(db, "jobs", "published_at TEXT");
      addColumn(db, "jobs", "published_at_source TEXT");
      addColumn(db, "jobs", "first_seen_reliability TEXT NOT NULL DEFAULT 'collector_observed'");
      addColumn(db, "jobs", "discovery_cohort TEXT NOT NULL DEFAULT 'pilot_baseline'");
      addColumn(db, "jobs", "discovery_kind TEXT NOT NULL DEFAULT 'new_to_collector_baseline'");
      addColumn(db, "jobs", "discovery_priority_score INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "jobs", "discovery_priority_reasons TEXT NOT NULL DEFAULT ''");
      addColumn(db, "jobs", "reopened_at TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs(active, first_seen_at DESC)");
      db.exec("CREATE INDEX IF NOT EXISTS jobs_published ON jobs(active, published_at DESC)");
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  if (!applied.has(3)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        DELETE FROM company_source_verifications
        WHERE verification_id NOT IN (
          SELECT MIN(verification_id) FROM company_source_verifications
          GROUP BY company_id, verification_status, observed_at,
            COALESCE(source_provider, ''), COALESCE(source_identifier, ''), is_manual_override
        );
        CREATE UNIQUE INDEX IF NOT EXISTS company_source_verification_unique
        ON company_source_verifications (
          company_id, verification_status, observed_at,
          COALESCE(source_provider, ''), COALESCE(source_identifier, ''), is_manual_override
        );
      `);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)").run(now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  migrateTechmapSchema(db, now);
  migratePhase3Schema(db, now);
}

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id INTEGER PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_observations (
      run_id INTEGER NOT NULL REFERENCES runs(run_id),
      company_name TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      source_url TEXT,
      health_status TEXT NOT NULL,
      http_status INTEGER,
      job_count INTEGER NOT NULL,
      error TEXT,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (run_id, company_name, source_provider)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      source_job_id TEXT NOT NULL,
      company_name TEXT NOT NULL,
      job_title TEXT,
      location TEXT,
      remote_type TEXT,
      department TEXT,
      description TEXT,
      job_url TEXT,
      apply_url TEXT,
      source_provider TEXT NOT NULL,
      source_url TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      source_updated_at TEXT,
      verification_status TEXT NOT NULL,
      relevance_score INTEGER NOT NULL,
      relevance_reasons TEXT NOT NULL,
      link_status TEXT,
      missing_success_count INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_company_source ON jobs(company_name, source_provider, active);
    CREATE INDEX IF NOT EXISTS jobs_relevance ON jobs(active, relevance_score DESC);
    CREATE TABLE IF NOT EXISTS job_observations (
      run_id INTEGER NOT NULL REFERENCES runs(run_id),
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      observed_at TEXT NOT NULL,
      raw_json TEXT,
      PRIMARY KEY (run_id, job_id)
    );
  `);
  migrate(db);
  return db;
}

function nullable(value) {
  return value === "" || value === undefined ? null : value;
}

function integer(value, fallback = null) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function importCompanies(db, rows, observedAt) {
  const upsert = db.prepare(`
    INSERT INTO companies (
      company_id, company_name, canonical_domain, website_url, careers_url, ats_provider,
      ats_identifier, source_url, country, city, industry, employee_count, employee_count_min,
      employee_count_max, employee_size_bucket, employee_size_source, employee_size_observed_at,
      employee_size_confidence, employee_size_evidence, company_discovered_at,
      company_last_checked_at, company_source_url, company_source_name, company_source_status,
      latest_stage, latest_round_date, source_description, known_in_techmap, is_new_company,
      is_pilot_company, selection_score, selection_reasons, raw_json
    ) VALUES (${Array.from({ length: 33 }, () => "?").join(",")})
    ON CONFLICT(company_id) DO UPDATE SET
      company_name=excluded.company_name,
      canonical_domain=COALESCE(excluded.canonical_domain, companies.canonical_domain),
      website_url=COALESCE(excluded.website_url, companies.website_url),
      careers_url=COALESCE(excluded.careers_url, companies.careers_url),
      ats_provider=COALESCE(excluded.ats_provider, companies.ats_provider),
      ats_identifier=COALESCE(excluded.ats_identifier, companies.ats_identifier),
      source_url=COALESCE(excluded.source_url, companies.source_url),
      country=COALESCE(excluded.country, companies.country), city=COALESCE(excluded.city, companies.city),
      industry=COALESCE(excluded.industry, companies.industry),
      employee_count=COALESCE(excluded.employee_count, companies.employee_count),
      employee_count_min=COALESCE(excluded.employee_count_min, companies.employee_count_min),
      employee_count_max=COALESCE(excluded.employee_count_max, companies.employee_count_max),
      employee_size_bucket=CASE WHEN excluded.employee_size_bucket='unknown' THEN companies.employee_size_bucket ELSE excluded.employee_size_bucket END,
      employee_size_source=COALESCE(excluded.employee_size_source, companies.employee_size_source),
      employee_size_observed_at=COALESCE(excluded.employee_size_observed_at, companies.employee_size_observed_at),
      employee_size_confidence=CASE WHEN excluded.employee_size_confidence='unknown' THEN companies.employee_size_confidence ELSE excluded.employee_size_confidence END,
      employee_size_evidence=CASE WHEN excluded.employee_size_evidence='unknown' THEN companies.employee_size_evidence ELSE excluded.employee_size_evidence END,
      company_last_checked_at=COALESCE(excluded.company_last_checked_at, companies.company_last_checked_at),
      company_source_url=COALESCE(excluded.company_source_url, companies.company_source_url),
      company_source_name=COALESCE(excluded.company_source_name, companies.company_source_name),
      company_source_status=excluded.company_source_status,
      latest_stage=COALESCE(excluded.latest_stage, companies.latest_stage),
      latest_round_date=COALESCE(excluded.latest_round_date, companies.latest_round_date),
      source_description=COALESCE(excluded.source_description, companies.source_description),
      known_in_techmap=excluded.known_in_techmap, is_new_company=excluded.is_new_company,
      is_pilot_company=excluded.is_pilot_company, selection_score=excluded.selection_score,
      selection_reasons=excluded.selection_reasons, raw_json=excluded.raw_json
  `);
  const observe = db.prepare(`
    INSERT OR IGNORE INTO company_observations
      (company_id, observed_at, source_name, source_url, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const raw = JSON.stringify(row);
      upsert.run(
        row.company_id, row.company_name, nullable(row.canonical_domain), nullable(row.website_url),
        nullable(row.careers_url), nullable(row.ats_provider), nullable(row.ats_identifier),
        nullable(row.source_url), nullable(row.country), nullable(row.city), nullable(row.industry),
        integer(row.employee_count), integer(row.employee_count_min), integer(row.employee_count_max),
        row.employee_size_bucket || "unknown", nullable(row.employee_size_source),
        nullable(row.employee_size_observed_at), row.employee_size_confidence || "unknown",
        row.employee_size_evidence || "unknown", row.company_discovered_at || observedAt,
        nullable(row.company_last_checked_at), nullable(row.company_source_url),
        nullable(row.company_source_name), row.company_source_status || "needs_manual_review",
        nullable(row.latest_stage), nullable(row.latest_round_date), nullable(row.source_description),
        integer(row.known_in_techmap, 0), integer(row.is_new_company, 0), integer(row.is_pilot_company, 0),
        integer(row.selection_score, 0), nullable(row.selection_reasons), raw,
      );
      observe.run(row.company_id, observedAt, row.company_source_name || "local import", row.company_source_url || null, raw);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return rows.length;
}

export function recordCompanyVerification(db, companyId, result) {
  db.prepare(`
    INSERT INTO company_source_verifications (
      company_id, careers_url, source_provider, source_identifier, source_url,
      verification_status, http_status, job_count, error, observed_at, evidence_source,
      is_manual_override
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM company_source_verifications
      WHERE company_id=? AND verification_status=? AND observed_at=?
        AND COALESCE(source_provider, '')=COALESCE(?, '')
        AND COALESCE(source_identifier, '')=COALESCE(?, '')
    )
  `).run(companyId, result.careers_url ?? null, result.source_provider ?? null,
    result.source_identifier ?? null, result.source_url ?? null, result.verification_status,
    result.http_status ?? null, result.job_count ?? null, result.error ?? null,
    result.observed_at, result.evidence_source ?? null, result.is_manual_override ? 1 : 0,
    companyId, result.verification_status, result.observed_at, result.source_provider ?? null,
    result.source_identifier ?? null);
  db.prepare(`
    UPDATE companies SET
      careers_url=COALESCE(?, careers_url), ats_provider=COALESCE(?, ats_provider),
      ats_identifier=COALESCE(?, ats_identifier), source_url=COALESCE(?, source_url),
      company_source_status=?, company_last_checked_at=?
    WHERE company_id=?
  `).run(result.careers_url ?? null, result.source_provider ?? null,
    result.source_identifier ?? null, result.source_url ?? null,
    result.verification_status, result.observed_at, companyId);
}

export function beginRun(db, startedAt) {
  return Number(db.prepare("INSERT INTO runs(started_at, status) VALUES (?, 'running') RETURNING run_id").get(startedAt).run_id);
}

export function recordSourceObservation(db, runId, company, result, observedAt) {
  db.prepare(`
    INSERT INTO source_observations
      (run_id, company_name, source_provider, source_url, health_status, http_status, job_count, error,
       observed_at, company_id, company_source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, company.company_name, company.source_provider, result.sourceUrl ?? company.source_url,
    result.status, result.httpStatus ?? 0, result.jobs.length, result.error, observedAt,
    company.company_id ?? null, company.company_source_id ?? null);
}

export function applySuccessfulObservation(db, runId, company, jobs, observedAt) {
  const previousActive = company.company_source_id
    ? db.prepare("SELECT job_id FROM jobs WHERE company_source_id=? AND active=1")
      .all(company.company_source_id).map((row) => row.job_id)
    : db.prepare("SELECT job_id FROM jobs WHERE company_name=? AND source_provider=? AND active=1")
      .all(company.company_name, company.source_provider).map((row) => row.job_id);
  const seen = new Set(jobs.map((job) => job.job_id));
  const upsert = db.prepare(`
    INSERT INTO jobs (
      job_id, source_job_id, company_name, job_title, location, remote_type, department, description,
      job_url, apply_url, source_provider, source_url, first_seen_at, last_seen_at, source_updated_at,
      verification_status, relevance_score, relevance_reasons, missing_success_count, active, raw_json,
      company_id, published_at, published_at_source, first_seen_reliability, discovery_cohort,
      discovery_kind, discovery_priority_score, discovery_priority_reasons
      , company_source_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      job_title=excluded.job_title, location=excluded.location, remote_type=excluded.remote_type,
      department=excluded.department, description=excluded.description, job_url=excluded.job_url,
      apply_url=excluded.apply_url, source_url=excluded.source_url, last_seen_at=excluded.last_seen_at,
      source_updated_at=COALESCE(excluded.source_updated_at, jobs.source_updated_at),
      published_at=COALESCE(jobs.published_at, excluded.published_at),
      published_at_source=COALESCE(jobs.published_at_source, excluded.published_at_source),
      company_id=COALESCE(jobs.company_id, excluded.company_id),
      company_source_id=COALESCE(jobs.company_source_id, excluded.company_source_id),
      verification_status=CASE
        WHEN jobs.link_status='verified' AND jobs.apply_url=excluded.apply_url THEN 'source_listed_link_verified'
        ELSE 'source_listed' END,
      relevance_score=excluded.relevance_score, relevance_reasons=excluded.relevance_reasons,
      discovery_priority_score=excluded.discovery_priority_score,
      discovery_priority_reasons=excluded.discovery_priority_reasons,
      reopened_at=CASE WHEN jobs.active=0 THEN excluded.last_seen_at ELSE jobs.reopened_at END,
      missing_success_count=0, active=1, raw_json=excluded.raw_json
  `);
  const observe = db.prepare(
    "INSERT OR REPLACE INTO job_observations(run_id, job_id, observed_at, raw_json) VALUES (?, ?, ?, ?)",
  );
  const markMissing = db.prepare(`
    UPDATE jobs SET
      missing_success_count=missing_success_count+1,
      verification_status=CASE WHEN missing_success_count >= 1 THEN 'potentially_closed' ELSE 'not_seen_once' END,
      active=CASE WHEN missing_success_count >= 1 THEN 0 ELSE 1 END
    WHERE job_id=?
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const job of jobs) {
      const rawJson = JSON.stringify(job.raw ?? null);
      upsert.run(job.job_id, job.source_job_id, job.company_name, job.job_title, job.location,
        job.remote_type, job.department, job.description, job.job_url, job.apply_url,
        job.source_provider, job.source_url, job.first_seen_at, job.last_seen_at,
        job.source_updated_at, job.verification_status, job.relevance_score,
        job.relevance_reasons, rawJson, job.company_id ?? company.company_id ?? null,
        job.published_at ?? null, job.published_at_source ?? null,
        job.first_seen_reliability ?? "collector_observed", job.discovery_cohort ?? "incremental",
        job.discovery_kind ?? "new_to_collector", job.discovery_priority_score ?? 0,
        job.discovery_priority_reasons ?? "", job.company_source_id ?? company.company_source_id ?? null);
      observe.run(runId, job.job_id, observedAt, rawJson);
    }
    for (const jobId of previousActive) if (!seen.has(jobId)) markMissing.run(jobId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function activateCompanySources(db, validations, {
  activationBatch = "phase3-approved-ats-2026-11-12",
  evidenceSource = "Phase 3 fresh official-domain ownership and live ATS validation",
  observedAt = new Date().toISOString(),
} = {}) {
  const prepared = validations.map((validation) => {
    if (validation.ownership_status !== "verified"
      || validation.ownership_evidence_level !== "strong"
      || validation.parser_status !== "compatible"
      || !["valid_with_jobs", "valid_empty"].includes(validation.outcome)
      || Number(validation.endpoint_http_status) < 200
      || Number(validation.endpoint_http_status) >= 400) {
      throw new Error(`Source ${validation.company_name} did not pass the activation evidence gate`);
    }
    const source = db.prepare("SELECT * FROM company_sources WHERE source_id=?").get(validation.source_id);
    if (!source) throw new Error(`Unknown company source: ${validation.source_id}`);
    if (source.company_id !== validation.company_id
      || source.provider !== validation.provider
      || source.source_identifier !== validation.source_identifier) {
      throw new Error(`Source identity mismatch for ${validation.company_name}`);
    }
    const activationKey = `${activationBatch}:${source.source_id}`;
    const existingEvent = db.prepare(
      "SELECT event_id FROM company_source_activation_events WHERE activation_key=?",
    ).get(activationKey);
    if (existingEvent && source.evidence_status === "live_verified" && source.is_enabled === 1) {
      return { validation, source, activationKey, alreadyApplied: true };
    }
    if (source.evidence_status !== "imported_unverified" || source.is_enabled !== 0) {
      throw new Error(`Source ${validation.company_name} is no longer a disabled imported candidate`);
    }
    return {
      validation,
      source,
      activationKey,
      alreadyApplied: false,
    };
  });

  const update = db.prepare(`
    UPDATE company_sources SET
      evidence_source=?,
      evidence_status='live_verified', evidence_url=?, is_enabled=1,
      effective_from=COALESCE(effective_from, ?), last_observed_at=?
    WHERE source_id=? AND evidence_status='imported_unverified' AND is_enabled=0
  `);
  const insertEvent = db.prepare(`
    INSERT INTO company_source_activation_events (
      activation_key, source_id, company_id, action, previous_evidence_status,
      new_evidence_status, previous_is_enabled, new_is_enabled, evidence_url,
      evidence_summary, observed_at, raw_json
    ) VALUES (?, ?, ?, 'activate', ?, 'live_verified', ?, 1, ?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { validation, source, activationKey, alreadyApplied } of prepared) {
      if (alreadyApplied) continue;
      const changed = update.run(evidenceSource, validation.ownership_evidence_url ?? null, observedAt, observedAt, source.source_id);
      if (Number(changed.changes) !== 1) throw new Error(`Concurrent source change detected for ${validation.company_name}`);
      insertEvent.run(
        activationKey, source.source_id, source.company_id, source.evidence_status, source.is_enabled,
        validation.ownership_evidence_url ?? null,
        `${validation.ownership_evidence}; endpoint HTTP ${validation.endpoint_http_status}; parser ${validation.parser_status}; outcome ${validation.outcome}`,
        observedAt, JSON.stringify(validation),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return prepared.map(({ source, activationKey }) => ({ source_id: source.source_id, activation_key: activationKey }));
}

export function finishRun(db, runId, status, finishedAt) {
  if (!["completed", "partial_success", "interrupted"].includes(status)) {
    throw new Error(`Invalid terminal run status: ${status}`);
  }
  const current = db.prepare("SELECT status, finished_at FROM runs WHERE run_id=?").get(runId);
  if (!current) throw new Error(`Unknown run: ${runId}`);
  if (current.status === status) return false;
  if (current.status !== "running") {
    throw new Error(`Illegal run transition ${current.status} -> ${status} for run ${runId}`);
  }
  const changed = db.prepare("UPDATE runs SET status=?, finished_at=? WHERE run_id=? AND status='running'")
    .run(status, finishedAt, runId);
  if (Number(changed.changes) !== 1) throw new Error(`Concurrent run transition detected for run ${runId}`);
  return true;
}

export function recoverInterruptedRuns(db, recoveredAt = new Date().toISOString()) {
  const running = db.prepare("SELECT run_id, started_at FROM runs WHERE status='running' ORDER BY run_id").all();
  const update = db.prepare("UPDATE runs SET status='interrupted', finished_at=? WHERE run_id=? AND status='running'");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const run of running) {
      const changed = update.run(recoveredAt, run.run_id);
      if (Number(changed.changes) !== 1) throw new Error(`Concurrent recovery transition detected for run ${run.run_id}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return running.map((run) => ({ ...run, recovered_at: recoveredAt, new_status: "interrupted" }));
}

export function activeJobs(db) {
  return db.prepare(`
    SELECT j.job_id, j.company_name, j.job_title, j.location, j.remote_type, j.department,
      j.description, j.job_url, j.apply_url, j.source_provider, j.source_url, j.first_seen_at,
      j.last_seen_at, j.published_at, j.published_at_source, j.source_updated_at,
      j.first_seen_reliability, j.discovery_cohort, j.discovery_kind, j.verification_status,
      j.relevance_score, j.relevance_reasons, j.discovery_priority_score,
      j.discovery_priority_reasons, j.link_status, j.reopened_at,
      c.company_id, c.canonical_domain, c.employee_count, c.employee_count_min,
      c.employee_count_max, c.employee_size_bucket, c.employee_size_confidence,
      c.employee_size_evidence, c.industry, c.is_new_company, c.known_in_techmap
    FROM jobs j LEFT JOIN companies c ON c.company_id=j.company_id
    WHERE j.active=1
    ORDER BY j.relevance_score DESC, j.company_name, j.job_title
  `).all();
}

export function allCompanies(db) {
  return db.prepare("SELECT * FROM companies ORDER BY selection_score DESC, company_name").all();
}

export function latestCompanyVerifications(db) {
  return db.prepare(`
    SELECT v.* FROM company_source_verifications v
    JOIN (SELECT company_id, MAX(verification_id) id FROM company_source_verifications GROUP BY company_id) latest
      ON latest.id=v.verification_id
    ORDER BY v.verification_status, v.company_id
  `).all();
}

export function shortlistForVerification(db, minimumScore = 40, limit = 100) {
  return db.prepare(`
    SELECT job_id, apply_url, job_url FROM jobs
    WHERE active=1 AND relevance_score>=? AND COALESCE(apply_url, job_url) IS NOT NULL
    ORDER BY discovery_priority_score DESC, relevance_score DESC, first_seen_at DESC LIMIT ?
  `).all(minimumScore, limit);
}

export function updateLinkStatus(db, jobId, status) {
  db.prepare(`
    UPDATE jobs SET link_status=?, verification_status=CASE
      WHEN ?='verified' THEN 'source_listed_link_verified'
      WHEN verification_status='source_listed_link_verified' THEN 'source_listed'
      ELSE verification_status END
    WHERE job_id=?
  `).run(status, status, jobId);
}

export function latestRunSummary(db) {
  const run = db.prepare("SELECT * FROM runs ORDER BY run_id DESC LIMIT 1").get();
  if (!run) return null;
  const sources = db.prepare(`
    SELECT health_status, COUNT(*) AS companies, SUM(job_count) AS jobs
    FROM source_observations WHERE run_id=? GROUP BY health_status ORDER BY health_status
  `).all(run.run_id);
  const uniqueJobs = db.prepare("SELECT COUNT(*) AS count FROM job_observations WHERE run_id=?").get(run.run_id).count;
  const relevant = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE active=1 AND relevance_score>=40").get().count;
  const high = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE active=1 AND relevance_score>=65").get().count;
  const verifiedLinks = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE active=1 AND link_status='verified'").get().count;
  return { ...run, sources, unique_jobs: uniqueJobs, relevant_jobs: relevant, high_relevance_jobs: high, verified_links: verifiedLinks };
}

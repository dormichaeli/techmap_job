import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

export const CHECKPOINT_FORMAT = "techmap-job-sqlite-checkpoint";
export const CHECKPOINT_FORMAT_VERSION = 1;
export const SUPPORTED_SCHEMA_MIN = 5;
export const SUPPORTED_SCHEMA_MAX = 5;
export const CHECKPOINT_DATABASE_FILE = "database.sqlite";
export const CHECKPOINT_MANIFEST_FILE = "manifest.json";

export const CRITICAL_TABLES = Object.freeze([
  "schema_migrations",
  "companies",
  "company_observations",
  "company_source_verifications",
  "company_external_ids",
  "company_aliases",
  "company_sources",
  "company_source_activation_events",
  "runs",
  "source_observations",
  "jobs",
  "job_observations",
]);

export class CheckpointError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
    this.details = details;
  }
}

function assert(condition, code, message, details = {}) {
  if (!condition) throw new CheckpointError(code, message, details);
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function canonicalJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    }
    return item;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function hashRows(db, sql) {
  const hash = createHash("sha256");
  for (const row of db.prepare(sql).iterate()) hash.update(`${JSON.stringify(row)}\n`);
  return hash.digest("hex");
}

function tableCount(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count);
}

function allTables(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
}

export function inspectCheckpointDatabase(databasePath, {
  minimumSchemaVersion = SUPPORTED_SCHEMA_MIN,
  maximumSchemaVersion = SUPPORTED_SCHEMA_MAX,
} = {}) {
  assert(existsSync(databasePath), "DATABASE_MISSING", `Checkpoint database is missing: ${databasePath}`);
  const headerBuffer = Buffer.alloc(16);
  const headerHandle = openSync(databasePath, "r");
  try {
    readSync(headerHandle, headerBuffer, 0, 16, 0);
  } finally {
    closeSync(headerHandle);
  }
  const header = headerBuffer.toString("binary");
  assert(header === "SQLite format 3\u0000", "DATABASE_HEADER_INVALID", "Checkpoint does not have a valid SQLite header");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    const sqliteVersion = db.prepare("SELECT sqlite_version() version").get().version;
    const tables = allTables(db);
    const missingTables = CRITICAL_TABLES.filter((table) => !tables.has(table));
    assert(!missingTables.length, "EXPECTED_TABLE_MISSING", `Checkpoint is missing critical tables: ${missingTables.join(", ")}`, { missingTables });
    const integrityRows = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
    assert(integrityRows.length === 1 && integrityRows[0] === "ok", "SQLITE_INTEGRITY_FAILED", "SQLite integrity_check failed", { integrityRows });
    const foreignKeyRows = db.prepare("PRAGMA foreign_key_check").all().map((row) => ({ ...row }));
    assert(foreignKeyRows.length === 0, "FOREIGN_KEY_VIOLATION", `Checkpoint has ${foreignKeyRows.length} foreign-key violations`, { foreignKeyRows });
    const schemaVersion = Number(db.prepare("SELECT MAX(version) version FROM schema_migrations").get().version);
    assert(Number.isInteger(schemaVersion), "SCHEMA_VERSION_INVALID", "Checkpoint database has no valid schema version");
    assert(schemaVersion >= minimumSchemaVersion && schemaVersion <= maximumSchemaVersion,
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported database schema version ${schemaVersion}; supported range is ${minimumSchemaVersion}-${maximumSchemaVersion}`,
      { schemaVersion, minimumSchemaVersion, maximumSchemaVersion });

    const counts = Object.fromEntries(CRITICAL_TABLES.map((table) => [table, tableCount(db, table)]));
    const latestRun = db.prepare("SELECT run_id, status, started_at, finished_at FROM runs ORDER BY run_id DESC LIMIT 1").get();
    const runningRuns = tableCount(db, "runs")
      ? Number(db.prepare("SELECT COUNT(*) count FROM runs WHERE status='running'").get().count) : 0;
    const enabledImportedUnverified = Number(db.prepare(`
      SELECT COUNT(*) count FROM company_sources
      WHERE evidence_status='imported_unverified' AND is_enabled<>0
    `).get().count);
    const activationStateMismatches = Number(db.prepare(`
      SELECT COUNT(*) count
      FROM company_source_activation_events e JOIN company_sources s ON s.source_id=e.source_id
      WHERE e.action='activate' AND (s.evidence_status<>'live_verified' OR s.is_enabled<>1)
    `).get().count);
    const attributionMismatches = Number(db.prepare(`
      SELECT COUNT(*) count FROM jobs j JOIN company_sources s ON s.source_id=j.company_source_id
      WHERE j.company_source_id IS NOT NULL AND j.company_id<>s.company_id
    `).get().count);
    assert(enabledImportedUnverified === 0, "SOURCE_STATE_INVALID", "An imported-unverified source is enabled", { enabledImportedUnverified });
    assert(activationStateMismatches === 0, "SOURCE_STATE_INVALID", "An activated source is no longer enabled and live-verified", { activationStateMismatches });
    assert(attributionMismatches === 0, "SOURCE_ATTRIBUTION_INVALID", "A job is attributed to a source owned by another company", { attributionMismatches });

    const fingerprints = {
      company_ids_sha256: hashRows(db, "SELECT company_id FROM companies ORDER BY company_id"),
      company_aliases_sha256: hashRows(db, "SELECT alias_id, company_id, normalized_alias, alias_type, source_name, COALESCE(external_id, '') external_id FROM company_aliases ORDER BY alias_id"),
      company_external_ids_sha256: hashRows(db, "SELECT source_name, external_id, company_id, identity_status FROM company_external_ids ORDER BY source_name, external_id"),
      company_sources_sha256: hashRows(db, "SELECT source_id, company_id, source_kind, COALESCE(provider, '') provider, COALESCE(source_identifier, '') source_identifier, evidence_status, is_enabled FROM company_sources ORDER BY source_id"),
      job_ids_sha256: hashRows(db, "SELECT job_id FROM jobs ORDER BY job_id"),
      job_first_seen_sha256: hashRows(db, "SELECT job_id, first_seen_at FROM jobs ORDER BY job_id"),
      job_identity_sha256: hashRows(db, "SELECT job_id, source_job_id, company_id, company_source_id, company_name, source_provider, first_seen_at FROM jobs ORDER BY job_id"),
      source_states_sha256: hashRows(db, "SELECT source_id, evidence_status, is_enabled, COALESCE(effective_from, '') effective_from, COALESCE(effective_to, '') effective_to FROM company_sources ORDER BY source_id"),
    };
    const publicationEligible = runningRuns === 0 && latestRun?.status === "completed";
    return {
      sqlite_version: sqliteVersion,
      schema_version: schemaVersion,
      page_count: Number(db.prepare("PRAGMA page_count").get().page_count),
      page_size: Number(db.prepare("PRAGMA page_size").get().page_size),
      integrity_check: "ok",
      foreign_key_violations: 0,
      counts,
      fingerprints,
      collection_run: latestRun ? { ...latestRun } : null,
      running_runs: runningRuns,
      source_state: {
        enabled_imported_unverified: enabledImportedUnverified,
        activation_state_mismatches: activationStateMismatches,
        attribution_mismatches: attributionMismatches,
      },
      publication_eligible: publicationEligible,
      publication_ineligible_reason: publicationEligible ? null
        : runningRuns ? "running_collection_exists" : `latest_run_status:${latestRun?.status ?? "missing"}`,
    };
  } catch (error) {
    if (error instanceof CheckpointError) throw error;
    throw new CheckpointError("DATABASE_VALIDATION_FAILED", `Unable to validate checkpoint database: ${error.message}`, { cause: error.message });
  } finally {
    db.close();
  }
}

export function buildCheckpointManifest({
  checkpointId,
  databasePath,
  createdAt,
  collectorName = "israel-job-discovery-poc",
  collectorVersion = "0.1.0",
  inspection,
}) {
  const stats = statSync(databasePath);
  return {
    checkpoint_format: CHECKPOINT_FORMAT,
    checkpoint_format_version: CHECKPOINT_FORMAT_VERSION,
    checkpoint_id: checkpointId,
    created_at: createdAt,
    collector: {
      name: collectorName,
      version: collectorVersion,
      node_version: process.version,
    },
    database: {
      file: CHECKPOINT_DATABASE_FILE,
      bytes: stats.size,
      sha256: sha256File(databasePath),
      sqlite_version: inspection.sqlite_version,
      page_count: inspection.page_count,
      page_size: inspection.page_size,
      integrity_check: inspection.integrity_check,
      foreign_key_violations: inspection.foreign_key_violations,
    },
    state: {
      schema_version: inspection.schema_version,
      collection_run: inspection.collection_run,
      counts: inspection.counts,
      fingerprints: inspection.fingerprints,
      source_state: inspection.source_state,
    },
    publication: {
      eligible: inspection.publication_eligible,
      ineligible_reason: inspection.publication_ineligible_reason,
    },
  };
}

function validateSha256(value, field) {
  assert(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "MANIFEST_INVALID", `Manifest field ${field} must be a lowercase SHA-256 hex digest`);
}

export function validateCheckpointManifest(manifest) {
  assert(manifest && typeof manifest === "object" && !Array.isArray(manifest), "MANIFEST_INVALID", "Checkpoint manifest must be a JSON object");
  assert(manifest.checkpoint_format === CHECKPOINT_FORMAT, "MANIFEST_INVALID", `Unsupported checkpoint format: ${manifest.checkpoint_format}`);
  assert(manifest.checkpoint_format_version === CHECKPOINT_FORMAT_VERSION,
    "CHECKPOINT_VERSION_UNSUPPORTED",
    `Unsupported checkpoint format version: ${manifest.checkpoint_format_version}`);
  assert(typeof manifest.checkpoint_id === "string" && /^[A-Za-z0-9._-]+$/.test(manifest.checkpoint_id), "MANIFEST_INVALID", "Manifest checkpoint_id is invalid");
  assert(typeof manifest.created_at === "string" && manifest.created_at.endsWith("Z") && Number.isFinite(Date.parse(manifest.created_at)), "MANIFEST_INVALID", "Manifest created_at must be a valid UTC timestamp");
  assert(typeof manifest.collector?.name === "string" && manifest.collector.name.length > 0, "MANIFEST_INVALID", "Manifest collector.name is required");
  assert(typeof manifest.collector?.version === "string" && manifest.collector.version.length > 0, "MANIFEST_INVALID", "Manifest collector.version is required");
  assert(typeof manifest.collector?.node_version === "string" && manifest.collector.node_version.length > 0, "MANIFEST_INVALID", "Manifest collector.node_version is required");
  assert(manifest.database?.file === CHECKPOINT_DATABASE_FILE, "MANIFEST_INVALID", `Manifest database.file must be ${CHECKPOINT_DATABASE_FILE}`);
  assert(Number.isInteger(manifest.database?.bytes) && manifest.database.bytes > 0, "MANIFEST_INVALID", "Manifest database.bytes must be a positive integer");
  validateSha256(manifest.database?.sha256, "database.sha256");
  assert(typeof manifest.database?.sqlite_version === "string" && manifest.database.sqlite_version.length > 0, "MANIFEST_INVALID", "Manifest database.sqlite_version is required");
  assert(Number.isInteger(manifest.database?.page_count) && manifest.database.page_count > 0, "MANIFEST_INVALID", "Manifest database.page_count must be positive");
  assert(Number.isInteger(manifest.database?.page_size) && manifest.database.page_size > 0, "MANIFEST_INVALID", "Manifest database.page_size must be positive");
  assert(manifest.database?.integrity_check === "ok", "MANIFEST_INVALID", "Manifest database.integrity_check must be ok");
  assert(manifest.database?.foreign_key_violations === 0, "MANIFEST_INVALID", "Manifest database.foreign_key_violations must be zero");
  assert(Number.isInteger(manifest.state?.schema_version), "MANIFEST_INVALID", "Manifest state.schema_version must be an integer");
  for (const table of CRITICAL_TABLES) {
    assert(Number.isInteger(manifest.state?.counts?.[table]) && manifest.state.counts[table] >= 0,
      "MANIFEST_INVALID", `Manifest is missing a valid count for ${table}`);
  }
  for (const [name, value] of Object.entries(manifest.state?.fingerprints ?? {})) validateSha256(value, `state.fingerprints.${name}`);
  const requiredFingerprints = ["company_ids_sha256", "company_aliases_sha256", "company_external_ids_sha256", "company_sources_sha256", "job_ids_sha256", "job_first_seen_sha256", "job_identity_sha256", "source_states_sha256"];
  for (const name of requiredFingerprints) assert(name in (manifest.state?.fingerprints ?? {}), "MANIFEST_INVALID", `Manifest is missing fingerprint ${name}`);
  assert(Number.isInteger(manifest.state?.source_state?.enabled_imported_unverified), "MANIFEST_INVALID", "Manifest source state is missing enabled_imported_unverified");
  assert(Number.isInteger(manifest.state?.source_state?.activation_state_mismatches), "MANIFEST_INVALID", "Manifest source state is missing activation_state_mismatches");
  assert(Number.isInteger(manifest.state?.source_state?.attribution_mismatches), "MANIFEST_INVALID", "Manifest source state is missing attribution_mismatches");
  assert(typeof manifest.publication?.eligible === "boolean", "MANIFEST_INVALID", "Manifest publication.eligible must be boolean");
  assert(manifest.publication.ineligible_reason === null || typeof manifest.publication.ineligible_reason === "string", "MANIFEST_INVALID", "Manifest publication.ineligible_reason must be null or a string");
  return manifest;
}

function compareInspection(manifest, inspection) {
  assert(manifest.state.schema_version === inspection.schema_version, "MANIFEST_DATABASE_MISMATCH", "Manifest schema version does not match database");
  for (const table of CRITICAL_TABLES) {
    assert(manifest.state.counts[table] === inspection.counts[table], "MANIFEST_DATABASE_MISMATCH", `Manifest count for ${table} does not match database`, { expected: manifest.state.counts[table], actual: inspection.counts[table] });
  }
  for (const [name, expected] of Object.entries(manifest.state.fingerprints)) {
    assert(expected === inspection.fingerprints[name], "IDENTITY_FINGERPRINT_MISMATCH", `Fingerprint ${name} does not match database`, { expected, actual: inspection.fingerprints[name] });
  }
  assert(canonicalJson(manifest.state.collection_run) === canonicalJson(inspection.collection_run), "MANIFEST_DATABASE_MISMATCH", "Manifest collection run does not match database");
  assert(canonicalJson(manifest.state.source_state) === canonicalJson(inspection.source_state), "MANIFEST_DATABASE_MISMATCH", "Manifest source state does not match database");
  assert(manifest.publication.eligible === inspection.publication_eligible, "MANIFEST_DATABASE_MISMATCH", "Manifest publication eligibility does not match database state");
  assert(manifest.publication.ineligible_reason === inspection.publication_ineligible_reason, "MANIFEST_DATABASE_MISMATCH", "Manifest publication reason does not match database state");
}

export function validateCheckpoint(checkpointDirectory, options = {}) {
  const directory = resolve(checkpointDirectory);
  const manifestPath = join(directory, CHECKPOINT_MANIFEST_FILE);
  assert(existsSync(manifestPath), "MANIFEST_MISSING", `Checkpoint manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new CheckpointError("MANIFEST_MALFORMED", `Checkpoint manifest is not valid JSON: ${error.message}`);
  }
  validateCheckpointManifest(manifest);
  assert(options.allowDirectoryMismatch || basename(directory) === manifest.checkpoint_id,
    "MANIFEST_DIRECTORY_MISMATCH", "Checkpoint directory name does not match manifest checkpoint_id");
  const databasePath = join(directory, manifest.database.file);
  assert(existsSync(databasePath) && lstatSync(databasePath).isFile() && !lstatSync(databasePath).isSymbolicLink(), "DATABASE_MISSING", "Checkpoint database is missing or is not a regular file");
  const size = statSync(databasePath).size;
  assert(size === manifest.database.bytes, "DATABASE_SIZE_MISMATCH", `Checkpoint database size mismatch: expected ${manifest.database.bytes}, received ${size}`);
  const checksum = sha256File(databasePath);
  assert(checksum === manifest.database.sha256, "CHECKSUM_MISMATCH", "Checkpoint database SHA-256 does not match manifest", { expected: manifest.database.sha256, actual: checksum });
  const inspection = inspectCheckpointDatabase(databasePath, options);
  compareInspection(manifest, inspection);
  return {
    checkpoint_directory: directory,
    manifest_path: manifestPath,
    database_path: databasePath,
    manifest,
    manifest_sha256: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    inspection,
  };
}

function writeDurably(path, content) {
  const handle = openSync(path, "wx");
  try {
    writeSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export function acquireFileLock(lockPath, owner = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = openSync(lockPath, "wx");
    writeSync(handle, canonicalJson({ pid: process.pid, acquired_at: new Date().toISOString(), ...owner }));
    fsyncSync(handle);
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    if (error.code === "EEXIST") throw new CheckpointError("CONCURRENT_OPERATION", `Another checkpoint operation holds lock ${lockPath}`);
    throw error;
  }
  return () => {
    closeSync(handle);
    rmSync(lockPath, { force: true });
  };
}

export async function createCheckpoint({
  sourcePath,
  repositoryPath,
  checkpointId,
  createdAt = new Date().toISOString(),
  collectorName,
  collectorVersion,
  minimumSchemaVersion,
  maximumSchemaVersion,
  onStage = null,
}) {
  assert(typeof checkpointId === "string" && /^[A-Za-z0-9._-]+$/.test(checkpointId), "CHECKPOINT_ID_INVALID", "Checkpoint ID may contain only letters, numbers, dot, underscore, and hyphen");
  assert(createdAt.endsWith("Z") && Number.isFinite(Date.parse(createdAt)), "CHECKPOINT_TIMESTAMP_INVALID", "Checkpoint creation time must be UTC");
  const repository = resolve(repositoryPath);
  const checkpointsPath = join(repository, "checkpoints");
  const finalPath = join(checkpointsPath, checkpointId);
  mkdirSync(checkpointsPath, { recursive: true });
  assert(!existsSync(finalPath), "IMMUTABLE_CHECKPOINT_EXISTS", `Checkpoint ${checkpointId} already exists and will not be overwritten`);
  const releaseLock = acquireFileLock(join(repository, ".checkpoint-create.lock"), { operation: "create", checkpoint_id: checkpointId });
  let temporaryPath;
  try {
    if (onStage) await onStage("lock_acquired", { checkpointId });
    assert(!existsSync(finalPath), "IMMUTABLE_CHECKPOINT_EXISTS", `Checkpoint ${checkpointId} already exists and will not be overwritten`);
    temporaryPath = mkdtempSync(join(checkpointsPath, `.tmp-${checkpointId}-`));
    const temporaryDatabase = join(temporaryPath, CHECKPOINT_DATABASE_FILE);
    const source = new DatabaseSync(resolve(sourcePath), { readOnly: true });
    try {
      await backup(source, temporaryDatabase);
    } finally {
      source.close();
    }
    if (onStage) await onStage("snapshot_created", { checkpointId, temporaryDatabase });
    const inspection = inspectCheckpointDatabase(temporaryDatabase, { minimumSchemaVersion, maximumSchemaVersion });
    const manifest = buildCheckpointManifest({ checkpointId, databasePath: temporaryDatabase, createdAt, collectorName, collectorVersion, inspection });
    writeDurably(join(temporaryPath, CHECKPOINT_MANIFEST_FILE), canonicalJson(manifest));
    if (onStage) await onStage("manifest_written", { checkpointId, temporaryPath });
    const staged = validateCheckpoint(temporaryPath, { minimumSchemaVersion, maximumSchemaVersion, allowDirectoryMismatch: true });
    if (onStage) await onStage("checkpoint_verified", { checkpointId, staged });
    renameSync(temporaryPath, finalPath);
    temporaryPath = null;
    if (onStage) await onStage("checkpoint_finalized", { checkpointId, finalPath });
    return validateCheckpoint(finalPath, { minimumSchemaVersion, maximumSchemaVersion });
  } catch (error) {
    if (temporaryPath) rmSync(temporaryPath, { recursive: true, force: true });
    if (error instanceof CheckpointError) throw error;
    throw new CheckpointError("CHECKPOINT_CREATION_FAILED", `Checkpoint creation failed: ${error.message}`, { cause: error.message });
  } finally {
    releaseLock();
  }
}

export function restoreCheckpoint({
  checkpointPath,
  destinationPath,
  forbiddenPaths = [],
  minimumSchemaVersion,
  maximumSchemaVersion,
}) {
  const destination = resolve(destinationPath);
  const forbidden = new Set(forbiddenPaths.map((path) => resolve(path).toLowerCase()));
  assert(!forbidden.has(destination.toLowerCase()), "RESTORE_DESTINATION_FORBIDDEN", `Refusing to restore over protected database ${destination}`);
  assert(!existsSync(destination), "RESTORE_DESTINATION_EXISTS", `Restore destination already exists: ${destination}`);
  const validated = validateCheckpoint(checkpointPath, { minimumSchemaVersion, maximumSchemaVersion });
  mkdirSync(dirname(destination), { recursive: true });
  const temporaryDirectory = mkdtempSync(join(dirname(destination), ".restore-"));
  const stagedPath = join(temporaryDirectory, basename(destination));
  try {
    copyFileSync(validated.database_path, stagedPath);
    const inspection = inspectCheckpointDatabase(stagedPath, { minimumSchemaVersion, maximumSchemaVersion });
    compareInspection(validated.manifest, inspection);
    assert(sha256File(stagedPath) === validated.manifest.database.sha256, "CHECKSUM_MISMATCH", "Staged restore checksum changed during copy");
    renameSync(stagedPath, destination);
    return { destination_path: destination, checkpoint_id: validated.manifest.checkpoint_id, inspection };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

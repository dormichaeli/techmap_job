import { DatabaseSync } from "node:sqlite";

export const REQUIRED_NODE_VERSION = "26.13.1";
export const MINIMUM_SQLITE_VERSION = "3.53.2";

export class RuntimeSafetyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeSafetyError";
    this.code = code;
    this.details = details;
  }
}

export function parseNumericVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new RuntimeSafetyError("VERSION_INVALID", `Expected a numeric major.minor.patch version, received: ${version}`);
  }
  return version.split(".").map((part) => Number(part));
}

export function compareNumericVersions(left, right) {
  const a = parseNumericVersion(left);
  const b = parseNumericVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function embeddedSqliteVersion() {
  const db = new DatabaseSync(":memory:");
  try {
    return db.prepare("SELECT sqlite_version() version").get().version;
  } finally {
    db.close();
  }
}

export function verifyRuntimeSafety({
  nodeVersion = process.versions.node,
  sqliteVersion = embeddedSqliteVersion(),
  requiredNodeVersion = REQUIRED_NODE_VERSION,
  minimumSqliteVersion = MINIMUM_SQLITE_VERSION,
  requireExactNode = true,
} = {}) {
  parseNumericVersion(nodeVersion);
  parseNumericVersion(sqliteVersion);
  if (requireExactNode && nodeVersion !== requiredNodeVersion) {
    throw new RuntimeSafetyError(
      "NODE_RUNTIME_UNPINNED",
      `Node ${nodeVersion} is not the reviewed runtime ${requiredNodeVersion}`,
      { node_version: nodeVersion, required_node_version: requiredNodeVersion },
    );
  }
  if (compareNumericVersions(sqliteVersion, minimumSqliteVersion) < 0) {
    throw new RuntimeSafetyError(
      "SQLITE_RUNTIME_UNSAFE",
      `Embedded SQLite ${sqliteVersion} is below required ${minimumSqliteVersion}`,
      { sqlite_version: sqliteVersion, minimum_sqlite_version: minimumSqliteVersion },
    );
  }
  return {
    safe: true,
    node_version: nodeVersion,
    required_node_version: requiredNodeVersion,
    sqlite_version: sqliteVersion,
    minimum_sqlite_version: minimumSqliteVersion,
  };
}

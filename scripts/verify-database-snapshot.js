import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function audit(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    const result = {
      path,
      integrity: db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check),
      foreign_key_violations: db.prepare("PRAGMA foreign_key_check").all().length,
      tables: {},
    };

    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
        .map((row) => row.name);
      const orderBy = columns.length ? ` ORDER BY ${columns.map(quoteIdentifier).join(", ")}` : "";
      const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}${orderBy}`).iterate();
      const hash = createHash("sha256");
      let count = 0;
      for (const row of rows) {
        hash.update(JSON.stringify(row));
        hash.update("\n");
        count += 1;
      }
      result.tables[table] = { count, sha256: hash.digest("hex") };
    }
    return result;
  } finally {
    db.close();
  }
}

const [leftArgument, rightArgument] = process.argv.slice(2);
if (!leftArgument || !rightArgument) {
  throw new Error("Usage: node scripts/verify-database-snapshot.js <database> <snapshot>");
}

const left = audit(resolve(leftArgument));
const right = audit(resolve(rightArgument));
const tableNames = [...new Set([...Object.keys(left.tables), ...Object.keys(right.tables)])].sort();
const differences = tableNames.filter((table) => (
  JSON.stringify(left.tables[table]) !== JSON.stringify(right.tables[table])
));
const output = {
  matches: differences.length === 0,
  left: {
    path: left.path,
    integrity: left.integrity,
    foreign_key_violations: left.foreign_key_violations,
  },
  right: {
    path: right.path,
    integrity: right.integrity,
    foreign_key_violations: right.foreign_key_violations,
  },
  table_count: tableNames.length,
  differences,
  critical_tables: Object.fromEntries([
    "companies", "company_sources", "jobs", "job_observations", "source_observations", "runs",
  ].filter((table) => left.tables[table]).map((table) => [table, left.tables[table]])),
};

console.log(JSON.stringify(output, null, 2));
if (!output.matches || left.integrity.some((value) => value !== "ok")
  || right.integrity.some((value) => value !== "ok")
  || left.foreign_key_violations || right.foreign_key_violations) {
  process.exitCode = 1;
}

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { spawnSync } from "node:child_process";

const sourcePath = resolve(process.argv[2] ?? "data/jobs.sqlite");
const prefix = process.argv[3] ?? "jobs-backup";
const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const backupPath = resolve("data/backups", `${prefix}-${timestamp}.sqlite`);
mkdirSync(dirname(backupPath), { recursive: true });

const source = new DatabaseSync(sourcePath, { readOnly: true });
await backup(source, backupPath);
source.close();

const directory = mkdtempSync(join(tmpdir(), "sqlite-restore-drill-"));
const restoredPath = join(directory, basename(backupPath));
try {
  copyFileSync(backupPath, restoredPath);
  const verification = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    resolve("scripts/verify-database-snapshot.js"),
    sourcePath,
    restoredPath,
  ], { encoding: "utf8" });
  if (verification.status !== 0) {
    throw new Error(`Backup restore verification failed:\n${verification.stdout}\n${verification.stderr}`);
  }
  console.log(JSON.stringify({
    source_path: sourcePath,
    backup_path: backupPath,
    backup_sha256: createHash("sha256").update(readFileSync(backupPath)).digest("hex"),
    restore_verification: JSON.parse(verification.stdout),
  }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

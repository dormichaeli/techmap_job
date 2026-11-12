#!/usr/bin/env node
import { resolve } from "node:path";
import { generatePublicExport } from "../src/public-export.js";
import { DatabaseSync } from "node:sqlite";

const databasePath = resolve(process.argv[2] ?? "data/jobs.sqlite");
const outputPath = resolve(process.argv[3] ?? "public-data");
const generatedAt = process.argv[4] ?? new Date().toISOString();
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  console.log(JSON.stringify(generatePublicExport(db, outputPath, { generatedAt }), null, 2));
} finally {
  db.close();
}

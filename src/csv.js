import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  text = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}
export async function readCsv(path) {
  const rows = parseCsv(await readFile(path, "utf8"));
  const headers = rows.shift() ?? [];
  return rows
    .filter((row) => row.some((value) => value !== ""))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function writeCsv(path, rows, fields) {
  await mkdir(dirname(path), { recursive: true });
  const lines = [fields.join(",")];
  for (const row of rows) lines.push(fields.map((field) => csvCell(row[field])).join(","));
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

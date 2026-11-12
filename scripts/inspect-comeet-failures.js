import { resolve } from "node:path";
import { readCsv, writeCsv } from "../src/csv.js";
import { mapBounded, request } from "../src/http.js";

const [phase2, remaining] = await Promise.all([
  readCsv(resolve("data/phase3-phase2-review.csv")),
  readCsv(resolve("data/phase3-ats-validation.csv")),
]);
const failures = [...phase2, ...remaining].filter((row) => row.provider === "comeet" && row.outcome === "parser_failure");
const results = await mapBounded(failures, 2, async (row) => {
  const response = await request(row.source_url, { responseType: "text", timeoutMs: 12_000, retries: 1 });
  const html = response.data;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null;
  const plain = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    company_name: row.company_name,
    source_identifier: row.source_identifier,
    source_url: row.source_url,
    http_status: response.status,
    final_url: response.finalUrl,
    response_bytes: Buffer.byteLength(html),
    title,
    has_company_positions_data: Number(/COMPANY_POSITIONS_DATA/.test(html)),
    has_next_data: Number(/__NEXT_DATA__/.test(html)),
    unavailable_marker: Number(/page (?:was )?not found|does not exist|no longer available|company not found|invalid company/i.test(`${title ?? ""} ${plain.slice(0, 2000)}`)),
    visible_text_sample: plain.slice(0, 240),
  };
});
await writeCsv(resolve("data/phase3-comeet-parser-investigation.csv"), results, Object.keys(results[0]));
console.log(JSON.stringify(results, null, 2));

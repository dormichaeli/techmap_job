import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.js";

test("CSV parser handles commas, quotes, and newlines", () => {
  const rows = parseCsv('a,b\r\n"one, two","say ""hello"""\r\n');
  assert.deepEqual(rows, [["a", "b"], ["one, two", 'say "hello"']]);
});

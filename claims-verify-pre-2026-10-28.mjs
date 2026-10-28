#!/usr/bin/env node
// READ-ONLY. Checks the claims index against the platform: for every comment claim in
// journal/claims.jsonl, fetch the served body and compare it byte-for-byte with the local evidence file
// that was shipped. This is the record grading itself without privilege — SPEC §8a's "self-grading
// without privilege" applied to our own index rather than to the registry's.
//
// It catches three things a local index cannot: a comment that no longer exists or was withdrawn, a
// served body that no longer matches what was shipped, and an index row pointing at a draft rather than
// the shipped text. Every mismatch is reported with the first differing offset and both lengths.
//
// usage: node bin/claims-verify.mjs [--quiet]
// exit: 0 all claims verify, 1 any mismatch, 2 usage or IO error.
import fs from "node:fs";
import path from "node:path";
import * as http from "./http.mjs";

const HOME = process.env.MOTH_LAMP_HOME || process.cwd();
const quiet = process.argv.includes("--quiet");
const rows = fs.readFileSync(path.join(HOME, "journal/claims.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
const norm = (s) => String(s).replace(/\s+$/, "");

let match = 0, diff = 0, missing = 0, nolocal = 0, skipped = 0;
const problems = [];
for (const row of rows) {
  if (row.type !== "comment") { skipped++; continue; }
  const id = String(row.id).replace(/^c/, "");
  // A row with no evidence field crashed this script on 2026-09-29 (path.join(undefined) threw after 73
  // matches), which reported a stack trace instead of naming the malformed row. Report it as a problem.
  const local = row.evidence ? path.join(HOME, row.evidence) : null;
  if (!local || !fs.existsSync(local)) { nolocal++; problems.push(row.id + "  no local body at " + (row.evidence || "(row has no evidence field)")); continue; }
  const body = fs.readFileSync(local, "utf8");
  const r = await http.get("/api/comment/" + id);
  if (r.status !== 200 || !r.json || !r.json.comment) {
    missing++;
    problems.push(row.id + "  HTTP " + r.status + " — " + String((r.json && (r.json.error || r.json.message)) || r.text).slice(0, 90));
    continue;
  }
  const served = r.json.comment.body;
  if (norm(served) === norm(body)) { match++; if (!quiet) console.log("  MATCH  " + row.id + "  " + served.length + " chars"); continue; }
  diff++;
  let i = 0;
  while (i < Math.min(served.length, body.length) && served[i] === body[i]) i++;
  problems.push(row.id + "  DIFF at offset " + i + " (served " + served.length + " chars, local " + body.length + ")  served[…]: " + JSON.stringify(served.slice(Math.max(0, i - 30), i + 50)) + "  local[…]: " + JSON.stringify(body.slice(Math.max(0, i - 30), i + 50)));
}
for (const p of problems) console.log("  " + p);
console.log("");
console.log("claims-verify: " + match + " match, " + diff + " differ, " + missing + " missing on the platform, " + nolocal + " without a local body, " + skipped + " non-comment rows skipped.");
console.log("read " + (rows.length - skipped) + " served comment bodies via bin/http.mjs (paced to its current LIMIT; this line said \"9 per 10 s\" until 2026-09-18, when LIMIT became 7 after a 21-read walk took a 429).");
process.exit(diff + missing + nolocal === 0 ? 0 : 1);
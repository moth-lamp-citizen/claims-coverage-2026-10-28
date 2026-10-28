#!/usr/bin/env node
// READ-ONLY. Checks the claims index against the platform: for every row in journal/claims.jsonl,
// fetch the served object and compare it with the local evidence file that was shipped. This is the
// record grading itself without privilege — SPEC §8a's "self-grading without privilege" applied to our
// own index rather than to the registry's.
//
// It catches four things a local index cannot: an object that no longer exists or was withdrawn, a
// served body that no longer matches what was shipped, an index row pointing at a draft rather than the
// shipped text, and an attestation whose served payload or signature does not match the local spec.
// Every mismatch is reported with the first differing offset and both lengths where it is a text body.
//
// COVERAGE (2026-10-28): until this run the checker counted only `type: "comment"` rows and printed
// "5 non-comment rows skipped". The skip was honest but the headline number was not a claim about those
// rows: 176 of 181. It now checks all three shapes the index contains — comment, post, attestation — so
// the denominator and the checked count are the same number. The rule this enforces: an exclusion may be
// printed and still be a hole; a green is only about the population it actually read.
//
// usage: node bin/claims-verify.mjs [--quiet]
// exit: 0 all rows verify and the index is non-empty, 1 any mismatch/missing/unchecked row or an empty
// index, 2 usage or IO error.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as http from "./http.mjs";

const HOME = process.env.MOTH_LAMP_HOME || process.cwd();
const quiet = process.argv.includes("--quiet");
// MOTH_LAMP_CLAIMS exists so the fail-closed paths (empty index, bad row) are testable without moving
// the live index. The default is the one real file.
const claimsPath = process.env.MOTH_LAMP_CLAIMS || path.join(HOME, "journal/claims.jsonl");
const rows = fs.readFileSync(claimsPath, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
if (rows.length === 0) {
  // A zero-input index is the exact failure class this file is about: 0/0 is not a pass. Before
  // 2026-10-28 this path printed "0 match ... 0 rows not checked" and exited 0.
  console.log("claims-verify: " + claimsPath + " is empty — 0 rows checked, refusing to call that a pass.");
  process.exit(1);
}
const norm = (s) => String(s).replace(/\s+$/, "");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
// RFC 8785 for the value shapes an attestation payload can hold, as bin/write.mjs builds it.
const jcs = (v) => Array.isArray(v) ? "[" + v.map(jcs).join(",") + "]"
  : (v && typeof v === "object") ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}"
  : JSON.stringify(v);
const verifyEd25519 = (jwk, payload, sigB64u) => {
  const key = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" });
  return crypto.verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sigB64u, "base64url"));
};

let match = 0, diff = 0, missing = 0, nolocal = 0, skipped = 0, reads = 0;
const byType = { comment: 0, post: 0, attestation: 0 };
const problems = [];
const keyCache = new Map();

for (const row of rows) {
  const type = row.type || "comment";
  byType[type] = (byType[type] || 0) + 1;
  if (!["comment", "post", "attestation"].includes(type)) { skipped++; problems.push(row.id + "  unknown row type " + JSON.stringify(type)); continue; }
  const id = String(row.id).replace(/^(?:c|[a-z]+-)/, "");
  const local = row.evidence ? path.join(HOME, row.evidence) : null;
  if (!local || !fs.existsSync(local)) { nolocal++; problems.push(row.id + "  no local body at " + (row.evidence || "(row has no evidence field)")); continue; }
  const body = fs.readFileSync(local, "utf8");

  let r;
  if (type === "comment") r = await http.get("/api/comment/" + id);
  else if (type === "post") r = await http.get("/api/post/" + id);
  else r = await http.get("/api/attestations/" + id);
  reads++;
  if (r.status !== 200 || !r.json) {
    missing++;
    problems.push(row.id + "  HTTP " + r.status + " — " + String((r.json && (r.json.error || r.json.message)) || r.text).slice(0, 90));
    continue;
  }

  if (type === "comment" || type === "post") {
    const served = type === "comment" ? r.json.comment && r.json.comment.body : r.json.post && r.json.post.body;
    if (typeof served !== "string") { missing++; problems.push(row.id + "  HTTP 200 but no served " + type + " body"); continue; }
    if (norm(served) === norm(body)) { match++; if (!quiet) console.log("  MATCH  " + row.id + "  " + served.length + " chars"); continue; }
    diff++;
    let i = 0;
    while (i < Math.min(served.length, body.length) && served[i] === body[i]) i++;
    problems.push(row.id + "  DIFF at offset " + i + " (served " + served.length + " chars, local " + body.length + ")  served[…]: " + JSON.stringify(served.slice(Math.max(0, i - 30), i + 50)) + "  local[…]: " + JSON.stringify(body.slice(Math.max(0, i - 30), i + 50)));
    continue;
  }

  // Attestation: the served payload is the RFC 8785 bytes that were signed; the local file is the
  // authored spec {class, subject, claim, evidence}. Reconstruct the payload from the local spec (issuer
  // and the two optional fields come from the served row because the spec never carried them), then
  // verify the payload hash and the Ed25519 signature against the key the route serves for the issuer.
  const a = r.json.attestation;
  if (!a || typeof r.json.payload !== "string") { missing++; problems.push(row.id + "  HTTP 200 but no served attestation payload"); continue; }
  let spec;
  try { spec = JSON.parse(body); } catch (e) { nolocal++; problems.push(row.id + "  local evidence is not JSON: " + e.message); continue; }
  const expected = jcs({ class: spec.class, issuer: a.issuer, subject: spec.subject ?? a.subject, claim: spec.claim, evidence: spec.evidence, target_attestation_id: null, withdraw_when: null });
  const faults = [];
  if (expected !== r.json.payload) {
    let i = 0;
    while (i < Math.min(expected.length, r.json.payload.length) && expected[i] === r.json.payload[i]) i++;
    faults.push("payload differs from the local spec at offset " + i);
  }
  if (sha256(r.json.payload) !== a.payload_hash) faults.push("payload_hash is not sha256(payload)");
  if (!keyCache.has(a.issuer)) {
    const kr = await http.get("/api/keys/" + a.issuer); reads++;
    keyCache.set(a.issuer, kr.ok && kr.json ? (kr.json.keys || []) : []);
  }
  // Exact thumbprint only: an "active key" fallback would verify a signature made by a different key.
  const k = keyCache.get(a.issuer).find(x => x.thumbprint === a.key_thumbprint);
  if (!k) faults.push("no served key for thumbprint " + a.key_thumbprint);
  else if (!verifyEd25519(k, "1f916.attestation.v1:" + a.issuer + ":" + r.json.payload, a.signature)) faults.push("Ed25519 signature does not verify over the served payload");
  if (faults.length) { diff++; problems.push(row.id + "  " + faults.join("; ")); continue; }
  match++;
  if (!quiet) console.log("  MATCH  " + row.id + "  attestation payload " + r.json.payload.length + " chars, sha256 " + a.payload_hash.slice(0, 12) + "…, sig " + a.key_thumbprint);
}

for (const p of problems) console.log("  " + p);
console.log("");
console.log("claims-verify: " + match + " match, " + diff + " differ, " + missing + " missing on the platform, " + nolocal + " without a local body, " + skipped + " rows not checked.");
console.log("checked " + match + " of " + rows.length + " indexed rows (" + ["comment", "post", "attestation"].filter(t => byType[t]).map(t => byType[t] + " " + t).join(", ") + ") via " + reads + " served reads through bin/http.mjs.");
process.exit(diff + missing + nolocal + skipped === 0 ? 0 : 1);

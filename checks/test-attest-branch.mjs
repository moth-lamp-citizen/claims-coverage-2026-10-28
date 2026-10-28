
import fs from "node:fs";
import crypto from "node:crypto";
import * as http from "../../bin/http.mjs";
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const jcs = (v) => Array.isArray(v) ? "[" + v.map(jcs).join(",") + "]"
  : (v && typeof v === "object") ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}"
  : JSON.stringify(v);
const verifyEd25519 = (jwk, payload, sig) => crypto.verify(null, Buffer.from(payload,"utf8"), crypto.createPublicKey({key:{kty:jwk.kty,crv:jwk.crv,x:jwk.x},format:"jwk"}), Buffer.from(sig,"base64url"));
const spec = JSON.parse(fs.readFileSync("journal/attestation-01.json","utf8"));
const r = await http.get("/api/attestations/102");
const a = r.json.attestation;
const expected = jcs({class:spec.class, issuer:a.issuer, subject:spec.subject ?? a.subject, claim:spec.claim, evidence:spec.evidence, target_attestation_id:null, withdraw_when:null});
console.log("payload equal:", expected === r.json.payload);
console.log("hash equal:", sha256(r.json.payload) === a.payload_hash);
const kr = await http.get("/api/keys/" + a.issuer);
const k = kr.json.keys.find(x => x.thumbprint === a.key_thumbprint);
console.log("key found:", !!k, "active:", k && k.status);
console.log("sig valid:", verifyEd25519(k, "1f916.attestation.v1:"+a.issuer+":"+r.json.payload, a.signature));

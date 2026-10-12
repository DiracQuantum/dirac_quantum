// End-to-end check of the registry API with a throwaway Ed25519 "wallet". It writes a throwaway
// passport and seal, so it runs against a LOCAL Worker (wrangler dev with the migrations applied)
// and refuses any host but loopback unless --allow-remote is passed.
// Run: node scripts/api-e2e.ts [http://127.0.0.1:8787] [--allow-remote]
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import {
  ANCHOR_MEMO,
  WALLET_MESSAGE,
  b64,
  buildPassport,
  createSeal,
  fingerprint,
  hashBytes,
  keysFromSeeds,
  passportHash,
  sealId,
  seedsFromSignature,
  selfSign,
  utf8,
  verifySeal,
} from "../src/lib/pq.ts";

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(BASE).hostname) && !args.includes("--allow-remote")) {
  console.error(`refusing to write a test passport to ${BASE}; pass --allow-remote to override`);
  process.exit(2);
}
let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
}
async function json(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data: data as Record<string, unknown> | null };
}

// throwaway wallet
const sk = randomBytes(32);
const pk = ed25519.getPublicKey(sk);
const wallet = base58.encode(pk);

// simple mode: the "wallet signature" that derives the keys
const derivationSig = ed25519.sign(utf8("derive"), sk);
const keys = keysFromSeeds(seedsFromSignature(derivationSig));
const passport = buildPassport(wallet, keys, "simple");
const self_sig = selfSign(passport, keys.dsaSk);
const wallet_sig = b64.encode(ed25519.sign(utf8(WALLET_MESSAGE(passport)), sk));
const hash = passportHash(passport);
console.log("wallet", wallet, "fingerprint", fingerprint(passport), "memo", ANCHOR_MEMO(passport));

// register
const reg = await json("POST", "/api/passports", { passport, self_sig, wallet_sig });
check("register passport", reg.status === 200 && reg.data?.ok === true && reg.data?.hash === hash, `status ${reg.status} ${JSON.stringify(reg.data)}`);

// fetch back
const got = await json("GET", `/api/passports/${wallet}`);
const rec = got.data as { passport?: typeof passport; hash?: string; anchor_tx?: string | null } | null;
check("fetch passport", got.status === 200 && rec?.hash === hash && rec?.passport?.dsa_pk === passport.dsa_pk, `status ${got.status}`);

// tampered self signature is rejected
const bad = await json("POST", "/api/passports", { passport: { ...passport, created_at: passport.created_at + 1 }, self_sig, wallet_sig });
check("tampered passport rejected", bad.status === 400 || bad.status === 422 || bad.status === 401, `status ${bad.status} ${JSON.stringify(bad.data)}`);

// add an anchor tx (fake signature string, 64 bytes base58): no node has it, and a re-register
// (which anyone can send with the public record) only records an anchor the chain shows
const anchor_tx = base58.encode(randomBytes(64));
const reg2 = await json("POST", "/api/passports", { passport, self_sig, wallet_sig, anchor_tx });
const got2 = await json("GET", `/api/passports/${wallet}`);
const rec2 = got2.data as { anchor_tx?: string | null; anchor_verified?: boolean; version?: number } | null;
check(
  "unseen anchor not recorded, never reported as an anchor",
  reg2.status === 200 && reg2.data?.anchor_status === "unseen" && rec2?.anchor_tx === null && rec2?.anchor_verified === false && rec2?.version === 1,
  `status ${reg2.status} ${String(reg2.data?.anchor_status)} anchor ${rec2?.anchor_tx} verified ${String(rec2?.anchor_verified)}`,
);

// a second passport for the same wallet without a rotation signature is refused
const keys2 = keysFromSeeds(seedsFromSignature(ed25519.sign(utf8("derive again"), sk)));
const passport2 = buildPassport(wallet, keys2, "simple");
const replace = await json("POST", "/api/passports", {
  passport: passport2,
  self_sig: selfSign(passport2, keys2.dsaSk),
  wallet_sig: b64.encode(ed25519.sign(utf8(WALLET_MESSAGE(passport2)), sk)),
});
check("replacement without rotation_sig rejected", replace.status === 409, `status ${replace.status} ${JSON.stringify(replace.data)}`);

// seal a document
const doc = utf8("I, " + wallet + ", agree to the terms.");
const seal = createSeal(hashBytes(doc), passport, keys.dsaSk, { name: "terms.txt" });
check("seal verifies locally", verifySeal(seal).ok);
const pub = await json("POST", "/api/seals", { seal });
check("publish seal", pub.status === 200 && pub.data?.ok === true && pub.data?.id === sealId(seal), `status ${pub.status} ${JSON.stringify(pub.data)}`);
const gotSeal = await json("GET", `/api/seals/${sealId(seal)}`);
check("fetch seal", gotSeal.status === 200 && (gotSeal.data as { seal?: { signature?: string } })?.seal?.signature === seal.signature, `status ${gotSeal.status}`);
const badSeal = await json("POST", "/api/seals", { seal: { ...seal, doc_hash: "0".repeat(64) } });
check("tampered seal rejected", badSeal.status >= 400, `status ${badSeal.status}`);

// stats
const stats = await json("GET", "/api/stats");
check("stats", stats.status === 200 && typeof stats.data?.passports === "number" && (stats.data.passports as number) >= 1, JSON.stringify(stats.data));

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
console.log(`public page: ${BASE}/p?a=${wallet}`);
process.exit(failed ? 1 : 0);

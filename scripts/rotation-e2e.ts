// End-to-end check of passport rotation, version history and anchor verification against a
// LOCAL Worker (wrangler dev with migration 0013 applied). It writes throwaway passports, so it
// refuses any host but loopback unless --allow-remote is passed.
//
// Run: node scripts/rotation-e2e.ts [http://127.0.0.1:8787]
//
// The anchor checks need the Worker to reach a Solana RPC (RPC_URL or the public fallbacks): a
// recent foreign transaction must be refused (400); the production passport (public data, read
// only) registered here with its real anchor must come back verified. That anchor is from 2026-10
// and some free endpoints prune history, so without RPC_URL it may stay pending: those checks print
// SKIP with every upstream's answer instead of failing.
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { base58 } from "@scure/base";
import {
  ROTATE_MESSAGE,
  WALLET_MESSAGE,
  b64,
  buildPassport,
  createSeal,
  hashBytes,
  keysFromSeeds,
  newEntropy,
  passportHash,
  sealId,
  sealIdentity,
  seedsFromEntropy,
  selfSign,
  signRotation,
  utf8,
  verifyRotation,
  verifySeal,
  type KeyVersion,
  type Passport,
  type PassportKeys,
} from "../src/lib/pq.ts";

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const host = new URL(BASE).hostname;
if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && !args.includes("--allow-remote")) {
  console.error(`refusing to write test passports to ${BASE}; pass --allow-remote to override`);
  process.exit(2);
}
/** Public, read-only source of a real anchored passport for the live anchor checks. */
const PROD = "https://dirac.deeper-cf.workers.dev";
const PROD_WALLET = "vvDgn5TA4FAGw9L1vtSRPX7qnsprqRUnVZiqUFzDFR8";

let failed = 0;
let skipped = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
}
function skip(name: string, why: string) {
  console.log(`SKIP  ${name}  ${why}`);
  skipped++;
}

type Json = Record<string, unknown>;
// Each request carries its own client address: the local rate limiter (10 registrations a minute
// per address) would otherwise stop the run half way. Production ignores this header from clients.
async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Json | null }> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "cf-connecting-ip": `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Json | null = null;
  try {
    data = (await res.json()) as Json;
  } catch {}
  return { status: res.status, data };
}
const brief = (r: { status: number; data: Json | null }) => `status ${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`;

/* ------------------------------------------------------------------ */
/* A throwaway wallet and two passports                                */
/* ------------------------------------------------------------------ */

const walletSk = randomBytes(32);
const wallet = base58.encode(ed25519.getPublicKey(walletSk));
const walletSign = (p: Passport) => b64.encode(ed25519.sign(utf8(WALLET_MESSAGE(p)), walletSk));

function issue(createdAt: number): { passport: Passport; keys: PassportKeys; self_sig: string; wallet_sig: string } {
  const keys = keysFromSeeds(seedsFromEntropy(newEntropy()));
  const passport = buildPassport(wallet, keys, "hardened", createdAt);
  return { passport, keys, self_sig: selfSign(passport, keys.dsaSk), wallet_sig: walletSign(passport) };
}

const t = Date.now();
const p1 = issue(t - 60_000);
const p2 = issue(t);
const p3 = issue(t + 1);
const h1 = passportHash(p1.passport);
const h2 = passportHash(p2.passport);
console.log("wallet", wallet, "\nP1", h1, "\nP2", h2);

/* ------------------------------------------------------------------ */
/* First registration                                                  */
/* ------------------------------------------------------------------ */

const reg1 = await call("POST", "/api/passports", { passport: p1.passport, self_sig: p1.self_sig, wallet_sig: p1.wallet_sig });
check("register P1 (first passport, wallet signature only)", reg1.status === 200 && reg1.data?.hash === h1 && reg1.data?.version === 1, brief(reg1));

const got1 = await call("GET", `/api/passports/${wallet}`);
check(
  "GET: P1 active, version 1, no anchor, rotated_from null",
  got1.status === 200 &&
    got1.data?.hash === h1 &&
    got1.data?.version === 1 &&
    got1.data?.anchor_tx === null &&
    got1.data?.anchor_verified === false &&
    got1.data?.rotated_from === null,
  brief(got1),
);

// A seal made while P1 is the active passport.
const doc = utf8(`terms agreed by ${wallet}`);
const sealP1 = createSeal(hashBytes(doc), p1.passport, p1.keys.dsaSk, { signedAt: Math.floor(Date.now() / 1000) });
check("seal by P1 verifies locally", verifySeal(sealP1).ok);
// Published while P1 is active: the registry's receipt time later proves it predates the rotation.
const pubP1 = await call("POST", "/api/seals", { seal: sealP1 });
check("seal by P1 published before the rotation", pubP1.status === 200 && pubP1.data?.id === sealId(sealP1), brief(pubP1));
const futureSeal = createSeal(hashBytes(doc), p1.passport, p1.keys.dsaSk, { signedAt: Math.floor(Date.now() / 1000) + 3600 });
const pubFuture = await call("POST", "/api/seals", { seal: futureSeal });
check("a seal dated an hour ahead is refused by the registry: 400", pubFuture.status === 400, brief(pubFuture));

/* ------------------------------------------------------------------ */
/* Replacement without, and with a wrong, rotation signature           */
/* ------------------------------------------------------------------ */

const bareP2 = { passport: p2.passport, self_sig: p2.self_sig, wallet_sig: p2.wallet_sig };
const noSig = await call("POST", "/api/passports", bareP2);
check(
  "P2 with only a wallet signature: 409 rotation_required",
  noSig.status === 409 &&
    noSig.data?.code === "rotation_required" &&
    noSig.data?.error === "this wallet already has a passport; replacing it needs a signature from its current key",
  brief(noSig),
);

// What a wallet-key thief can produce: the NEW passport's key signing the rotation message.
const wrongKeySig = b64.encode(ml_dsa65.sign(utf8(ROTATE_MESSAGE(wallet, h1, h2)), p2.keys.dsaSk));
check("(the forged rotation_sig really fails verifyRotation)", !verifyRotation(p1.passport, p2.passport, wrongKeySig));
const wrongKey = await call("POST", "/api/passports", { ...bareP2, rotation_sig: wrongKeySig });
check("P2 with a rotation_sig from the wrong key: 409 rotation_invalid", wrongKey.status === 409 && wrongKey.data?.code === "rotation_invalid", brief(wrongKey));

const malformed = await call("POST", "/api/passports", { ...bareP2, rotation_sig: "AAAA" });
check("P2 with a malformed rotation_sig: 400", malformed.status === 400, brief(malformed));

const still1 = await call("GET", `/api/passports/${wallet}`);
check("after the refusals P1 is still active", still1.data?.hash === h1 && still1.data?.version === 1, brief(still1));

/* ------------------------------------------------------------------ */
/* A valid rotation                                                    */
/* ------------------------------------------------------------------ */

const rotation12 = signRotation(p1.passport, p1.keys.dsaSk, p2.passport);
const rot = await call("POST", "/api/passports", { ...bareP2, rotation_sig: rotation12 });
check("P2 with P1's rotation_sig: 200, version 2, rotated", rot.status === 200 && rot.data?.version === 2 && rot.data?.rotated === true && rot.data?.hash === h2, brief(rot));
const rotatedAt = typeof rot.data?.registered_at === "number" ? rot.data.registered_at : 0;

const got2 = await call("GET", `/api/passports/${wallet}`);
check("GET: P2 active, version 2, rotated_from = P1's hash", got2.data?.hash === h2 && got2.data?.version === 2 && got2.data?.rotated_from === h1, brief(got2));

interface Version {
  version: number;
  hash: string;
  passport: Passport;
  rotation_sig: string | null;
  rotation_signed: boolean;
  registered_at: number;
  superseded_at: number | null;
  anchor_tx: string | null;
  anchor_verified: boolean;
}
const readHistory = async (w: string) => {
  const r = await call("GET", `/api/passports/${w}/history`);
  return { status: r.status, total: r.data?.total as number, versions: (r.data?.versions ?? []) as Version[] };
};
const hist = await readHistory(wallet);
const [v2, v1] = hist.versions;
check(
  "history: two versions, newest first, P1 superseded at the rotation, P2 open",
  hist.status === 200 &&
    hist.total === 2 &&
    hist.versions.length === 2 &&
    v2?.version === 2 &&
    v2.hash === h2 &&
    v2.superseded_at === null &&
    v1?.version === 1 &&
    v1.hash === h1 &&
    v1.superseded_at === rotatedAt &&
    v2.registered_at === rotatedAt,
  JSON.stringify(hist.versions.map((v) => ({ version: v.version, superseded_at: v.superseded_at, registered_at: v.registered_at }))),
);
check(
  "history: v2's rotation_sig re-verifies against v1's key in the client",
  v2?.rotation_signed === true && v1?.rotation_signed === false && !!v2.rotation_sig && verifyRotation(v1.passport, v2.passport, v2.rotation_sig),
);

/* ------------------------------------------------------------------ */
/* Idempotency and replays                                             */
/* ------------------------------------------------------------------ */

const again = await call("POST", "/api/passports", bareP2);
check("re-register P2 as is: 200, still version 2, same registration time", again.status === 200 && again.data?.version === 2 && again.data?.registered_at === rotatedAt, brief(again));
const histAgain = await readHistory(wallet);
check("re-register adds no version", histAgain.total === 2, `total ${histAgain.total}`);

const back = await call("POST", "/api/passports", { passport: p1.passport, self_sig: p1.self_sig, wallet_sig: p1.wallet_sig });
check("P1 again without a signature from P2's key: 409", back.status === 409 && back.data?.code === "rotation_required", brief(back));

const replay = await call("POST", "/api/passports", { passport: p3.passport, self_sig: p3.self_sig, wallet_sig: p3.wallet_sig, rotation_sig: rotation12 });
check("P3 with the replayed P1->P2 rotation_sig: 409", replay.status === 409 && replay.data?.code === "rotation_invalid", brief(replay));

// Even P2's own key cannot bring P1 back: were it allowed, the old P1->P2 rotation_sig would
// become valid again and anyone could replay it to swap P2 back in.
const rollback = await call("POST", "/api/passports", {
  passport: p1.passport,
  self_sig: p1.self_sig,
  wallet_sig: p1.wallet_sig,
  rotation_sig: signRotation(p2.passport, p2.keys.dsaSk, p1.passport),
});
check("P1 back with a valid rotation_sig from P2's key: 409 passport_reused", rollback.status === 409 && rollback.data?.code === "passport_reused", brief(rollback));
const afterRollback = await readHistory(wallet);
check("the refused rollback adds no version", afterRollback.total === 2 && afterRollback.versions[0]?.hash === h2, `total ${afterRollback.total}`);

/* ------------------------------------------------------------------ */
/* Seal identity against the history (sealIdentity, pure)              */
/* ------------------------------------------------------------------ */

const keyVersions: KeyVersion[] = hist.versions.map((v) => ({
  version: v.version,
  dsa_pk: v.passport.dsa_pk,
  registered_at: v.registered_at,
  superseded_at: v.superseded_at,
  created_at: v.passport.created_at,
}));
const sealP2 = createSeal(hashBytes(doc), p2.passport, p2.keys.dsaSk);
const stranger = issue(t);
const sealStranger = createSeal(hashBytes(doc), stranger.passport, stranger.keys.dsaSk);
const lateP1 = createSeal(hashBytes(doc), p1.passport, p1.keys.dsaSk, { signedAt: Math.floor(rotatedAt / 1000) + 3600 });
// What a thief of the retired P1 key can make after the rotation: a seal dated back into P1's window.
const backdated = createSeal(hashBytes(utf8("backdated")), p1.passport, p1.keys.dsaSk, {
  signedAt: Math.floor(rotatedAt / 1000) - 60,
});
const pubBackdated = await call("POST", "/api/seals", { seal: backdated });
const receipt = async (id: string) => {
  const r = await call("GET", `/api/seals/${id}`);
  return typeof r.data?.registered_at === "number" ? r.data.registered_at : null;
};
const now = Date.now();

const idP1 = sealIdentity(sealP1, keyVersions, { now, publishedAt: await receipt(sealId(sealP1)) });
check(
  "seal by P1 published before the rotation: earlier key, proven by the registry's receipt",
  idP1.status === "earlier" && idP1.version === 1 && idP1.rotatedAt === rotatedAt && idP1.proven,
  JSON.stringify(idP1),
);
const idBackdated = sealIdentity(backdated, keyVersions, { now, publishedAt: await receipt(sealId(backdated)) });
check(
  "retired P1 key, seal backdated before the rotation but published after: earlier, not proven",
  pubBackdated.status === 200 && idBackdated.status === "earlier" && !idBackdated.proven,
  JSON.stringify(idBackdated),
);
const idUnpublished = sealIdentity(sealP1, keyVersions, { now, publishedAt: null });
check("the same P1 seal from a file the registry never received: not proven", idUnpublished.status === "earlier" && !idUnpublished.proven, JSON.stringify(idUnpublished));
const idP2 = sealIdentity(sealP2, keyVersions, { now, publishedAt: null });
check("seal by P2: verified identity", idP2.status === "verified" && idP2.version === 2, JSON.stringify(idP2));
const idStranger = sealIdentity(sealStranger, keyVersions, { now });
check("seal by an unknown key naming this wallet: identity mismatch", idStranger.status === "mismatch" && idStranger.reason === "unknown-key", JSON.stringify(idStranger));
const idLate = sealIdentity(lateP1, keyVersions, { now: rotatedAt + 2 * 3_600_000 });
check("seal by P1 dated an hour after the rotation: mismatch outside the window", idLate.status === "mismatch" && idLate.reason === "outside-window", JSON.stringify(idLate));
const idAhead = sealIdentity(createSeal(hashBytes(doc), p2.passport, p2.keys.dsaSk, { signedAt: Math.floor(now / 1000) + 86_400 }), keyVersions, { now });
check("seal by P2 dated a day ahead: mismatch, signed in the future", idAhead.status === "mismatch" && idAhead.reason === "future", JSON.stringify(idAhead));
const idBeforeKeys = sealIdentity(createSeal(hashBytes(doc), p1.passport, p1.keys.dsaSk, { signedAt: 1_577_836_800 }), keyVersions, { now });
check("seal by P1 dated 2020, before P1 existed: mismatch outside the window", idBeforeKeys.status === "mismatch" && idBeforeKeys.reason === "outside-window", JSON.stringify(idBeforeKeys));

const nobody = base58.encode(ed25519.getPublicKey(randomBytes(32)));
const empty = await readHistory(nobody);
check("history of a wallet without a passport: 200, empty", empty.status === 200 && empty.versions.length === 0 && empty.total === 0, `status ${empty.status}`);
check("seal naming a wallet without a passport: unbound", sealIdentity({ ...sealStranger, passport: nobody }, empty.versions.map((v) => ({ version: v.version, dsa_pk: v.passport.dsa_pk, registered_at: v.registered_at, superseded_at: v.superseded_at }))).status === "unbound");
const badHist = await call("GET", "/api/passports/not-a-wallet/history");
check("history of a malformed address: 400", badHist.status === 400, brief(badHist));

/* ------------------------------------------------------------------ */
/* Anchors                                                             */
/* ------------------------------------------------------------------ */

// A well-formed signature no node has seen, sent with a re-register. Anyone can send that request
// (the passport's signatures are public), so an anchor the chain does not show is not recorded.
const fakeTx = base58.encode(randomBytes(64));
const fake = await call("POST", "/api/passports", { ...bareP2, anchor_tx: fakeTx });
check("fake (unseen) anchor tx on a re-register: 200, unseen, nothing recorded", fake.status === 200 && fake.data?.anchor_status === "unseen" && fake.data?.anchor_tx === null, brief(fake));
const gotFake = await call("GET", `/api/passports/${wallet}`);
check("GET: no anchor claim after it", gotFake.data?.anchor_tx === null && gotFake.data?.anchor_verified === false, brief(gotFake));
// The same with nothing but the public record, as a stranger would send it.
const pub = gotFake.data as { passport: Passport; self_sig: string; wallet_sig: string } | null;
const strangerClaim = pub
  ? await call("POST", "/api/passports", { passport: pub.passport, self_sig: pub.self_sig, wallet_sig: pub.wallet_sig, anchor_tx: base58.encode(randomBytes(64)) })
  : null;
const gotStranger = await call("GET", `/api/passports/${wallet}`);
check(
  "a stranger re-sending the public record with a made-up anchor pins nothing on the passport",
  strangerClaim?.data?.anchor_status === "unseen" && gotStranger.data?.anchor_tx === null,
  brief(gotStranger),
);

// A rotation carries a fresh signature, so an unseen anchor named there is kept as an unverified claim.
const p4 = issue(t + 2);
const claimTx = base58.encode(randomBytes(64));
const rot4 = await call("POST", "/api/passports", {
  passport: p4.passport,
  self_sig: p4.self_sig,
  wallet_sig: p4.wallet_sig,
  rotation_sig: signRotation(p2.passport, p2.keys.dsaSk, p4.passport),
  anchor_tx: claimTx,
});
check("rotation to P4 naming an unseen anchor: 200, version 3, kept as pending", rot4.status === 200 && rot4.data?.version === 3 && rot4.data?.anchor_status === "pending" && rot4.data?.anchor_tx === claimTx, brief(rot4));
const got4 = await call("GET", `/api/passports/${wallet}`);
check("GET: the claim is listed with anchor_verified false", got4.data?.anchor_tx === claimTx && got4.data?.anchor_verified === false && got4.data?.anchor_time === null, brief(got4));
const bareP4 = { passport: p4.passport, self_sig: p4.self_sig, wallet_sig: p4.wallet_sig };
const overwrite = await call("POST", "/api/passports", { ...bareP4, anchor_tx: base58.encode(randomBytes(64)) });
const after4 = await call("GET", `/api/passports/${wallet}`);
check("a re-register with another unseen tx leaves the claim alone", overwrite.data?.anchor_status === "unseen" && after4.data?.anchor_tx === claimTx, brief(after4));

// A real, recent transaction someone else signed (a memo, through the Worker's own RPC proxy):
// recent enough that every RPC node still has it, so the refusal does not depend on archival history.
const recent = await call("POST", "/api/rpc", {
  jsonrpc: "2.0",
  id: 1,
  method: "getSignaturesForAddress",
  params: ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", { limit: 10, commitment: "confirmed" }],
});
const recentList = Array.isArray(recent.data?.result) ? (recent.data.result as { signature?: string; err?: unknown }[]) : [];
const foreignTx = recentList.find((s) => typeof s.signature === "string" && s.err === null)?.signature ?? null;
// The production passport (public, read only) with its real anchor, for the positive check below.
const prod = (await fetch(`${PROD}/api/passports/${PROD_WALLET}`)
  .then((r) => (r.ok ? (r.json() as Promise<Json>) : null))
  .catch(() => null)) as (Json & { passport: Passport; self_sig: string; wallet_sig: string; anchor_tx: string | null }) | null;
if (!foreignTx) {
  skip("foreign anchor tx is refused", `no recent memo transaction from the RPC proxy (${brief(recent)})`);
} else {
  const foreign = await call("POST", "/api/passports", { ...bareP4, anchor_tx: foreignTx });
  if (foreign.status === 200 && (foreign.data?.anchor_status === "pending" || foreign.data?.anchor_status === "unseen")) {
    skip("foreign anchor tx is refused", `the Worker reached no RPC (${String(foreign.data?.anchor_note)})`);
  } else {
    check("foreign anchor tx (real, recent, signed by another wallet): 400", foreign.status === 400 && /anchor_tx refused/.test(String(foreign.data?.error)), brief(foreign));
    const after = await call("GET", `/api/passports/${wallet}`);
    check(
      "the refused anchor touched nothing else",
      after.data?.hash === passportHash(p4.passport) && after.data?.version === 3 && after.data?.anchor_tx === claimTx && after.data?.anchor_verified === false,
      brief(after),
    );
  }
}

// The real thing: the production passport (public data) with its real anchor, on this local registry.
if (!prod) {
  skip("real anchor verifies", "could not read the public production passport");
} else {
  const live = await call("POST", "/api/passports", {
    passport: prod.passport,
    self_sig: prod.self_sig,
    wallet_sig: prod.wallet_sig,
    anchor_tx: prod.anchor_tx,
  });
  if (live.status === 200 && (live.data?.anchor_status === "pending" || live.data?.anchor_status === "unseen")) {
    skip("real anchor verifies", `the Worker reached no RPC (${String(live.data?.anchor_note)})`);
  } else {
    check("real anchor of a production passport: verified with slot and block time", live.status === 200 && live.data?.anchor_verified === true, brief(live));
    const liveGot = await call("GET", `/api/passports/${PROD_WALLET}`);
    check(
      "GET: anchor_verified, anchor_slot and anchor_time set",
      liveGot.data?.anchor_verified === true && typeof liveGot.data?.anchor_slot === "number" && typeof liveGot.data?.anchor_time === "number",
      brief({ status: liveGot.status, data: { anchor_verified: liveGot.data?.anchor_verified, anchor_slot: liveGot.data?.anchor_slot, anchor_time: liveGot.data?.anchor_time } }),
    );
  }
}

console.log(failed ? `\n${failed} FAILED, ${skipped} skipped` : `\nALL PASS (${skipped} skipped)`);
process.exit(failed ? 1 : 0);

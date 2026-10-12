/**
 * End-to-end check of wallet-signed gates and badges against a running Worker
 * (local `wrangler dev` with migrations 0001..0006 applied, or the deployment):
 *   a throwaway wallet signs a gate, the state counts it, the nonce cannot be
 *   replayed, a bad signature and a stale day are refused, the fourth signed
 *   gate in a minute is rate limited, anonymous gates keep their own limit, a
 *   second wallet signs one gate, and (with --age-cmd) the day is collapsed
 *   and the badges and the influencer are checked.
 *
 * Run: node scripts/pet-signed-e2e.ts [http://127.0.0.1:8792] [--d1-cmd "<command prefix>"] [--age-cmd "<shell command>"]
 *
 * `--d1-cmd` is a command that runs the SQL given as its last argument against
 * the Worker's local database, e.g.
 *   --d1-cmd "npx wrangler d1 execute dirac --local --command"
 * (add --persist-to when the Worker runs with one). The script uses it to mark
 * its throwaway wallets as found on chain (`pet_wallets`), since a wallet with
 * no Solana account is refused by design (migrations/0009_pet_sybil.sql), to
 * count `pet_nonces` rows, and to push the current day's start two days into
 * the past so the next GET /api/pet collapses it. Without it the signed gates
 * answer 403 (unless the Worker's RPC is unreachable, which lets them through)
 * and the nonce, collapse and badge checks are skipped. `--age-cmd` is the
 * older way to give the aging command alone. Never point either at the
 * production database.
 *
 * Local dev honours a `cf-connecting-ip` header, so the anonymous gates get
 * their own rate-limit bucket; Cloudflare overwrites the header in production.
 */

import { execSync } from "node:child_process";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import type { ActResult, Gate, PetBadge, PetDay, PetState } from "../src/lib/pet.ts";
import { GATE_MESSAGE, PET_WINDOW_MS, SIGNED_IP_LIMIT, SIGNED_PET_LIMIT, WALLETS_PER_IP_PER_DAY, newGateNonce } from "../src/lib/petGate.ts";

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8792";
const option = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const D1_CMD = option("--d1-cmd");
const AGE_CMD = option("--age-cmd") ?? (D1_CMD ? `${D1_CMD} "UPDATE pet_state SET day_started_at = day_started_at - 172800000 WHERE id = 1"` : null);

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (data: unknown) => JSON.stringify(data)?.slice(0, 160) ?? "";

/** Runs one SQL statement through `--d1-cmd`; `--json` makes wrangler print the rows, which are returned. */
function d1(sql: string): Record<string, unknown>[] {
  if (!D1_CMD) throw new Error("--d1-cmd is not set");
  const out = execSync(`${D1_CMD} "${sql}" --json`, { stdio: "pipe" }).toString();
  const start = out.indexOf("[");
  if (start < 0) return [];
  const parsed = JSON.parse(out.slice(start)) as { results?: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

/** Marks wallets as found on chain, so the Worker's on-chain check (cached in pet_wallets) lets them sign. */
function markOnChain(wallets: string[]): void {
  const values = wallets.map((w) => `('${w}', 1, ${Date.now()})`).join(", ");
  d1(`INSERT OR REPLACE INTO pet_wallets (wallet, on_chain, checked_at) VALUES ${values}`);
}

const nonceRows = (): number => Number(d1("SELECT COUNT(*) AS n FROM pet_nonces")[0]?.n ?? 0);

type Reply<T> = { status: number; data: T | null };
type ErrorReply = { error?: string; retryAt?: number; day?: number };

/** A fresh client address per run: the wallets-per-IP rows live for the whole UTC day, so a fixed one would trip the cap on the second run. */
const freshIp = (net: number) => `10.${net}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const MAIN_IP = freshIp(7);

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, ip = MAIN_IP): Promise<Reply<T>> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {}
  return { status: res.status, data };
}

function makeWallet() {
  const sk = randomBytes(32);
  const wallet = base58.encode(ed25519.getPublicKey(sk));
  const sign = (message: string) => base64.encode(ed25519.sign(new TextEncoder().encode(message), sk));
  return { sk, wallet, sign };
}

type Signer = ReturnType<typeof makeWallet>;

/** The signed act body for a gate on `day`, with a fresh nonce unless one is given. */
function signedBody(who: Signer, day: number, gate: Gate, q: number, t: number | null = null, nonce = newGateNonce()) {
  const body: Record<string, unknown> = { gate, q, day, wallet: who.wallet, nonce, sig: who.sign(GATE_MESSAGE(day, gate, q, t, nonce)) };
  if (t !== null) body.t = t;
  return body;
}

/* --- the register ---------------------------------------------------- */

const first = await call<PetState>("GET", "/api/pet");
check("GET /api/pet", first.status === 200 && typeof first.data?.day === "number", `status ${first.status} ${short(first.data)}`);
if (!first.data) {
  console.log("\nno register; is the Worker running at", BASE, "?");
  process.exit(1);
}
const day = first.data.day;
check("GET /api/pet carries signedToday, leader and myGates = null without a wallet",
  typeof first.data.signedToday === "number" && "leader" in first.data && first.data.myGates === null,
  short({ signedToday: first.data.signedToday, leader: first.data.leader, myGates: first.data.myGates }));

// The three-per-minute check needs all gates in one fixed window: start a fresh one when this one is nearly over.
const remaining = PET_WINDOW_MS - (Date.now() % PET_WINDOW_MS);
if (remaining < 20_000) {
  console.log(`waiting ${Math.ceil(remaining / 1000)} s for a fresh minute window`);
  await sleep(remaining + 500);
}

/* --- one signed gate -------------------------------------------------- */

const A = makeWallet();
const B = makeWallet();
/** three wallets for the per-IP signed cap, three for the wallets-per-IP cap */
const P = makeWallet();
const Q = makeWallet();
const R = makeWallet();
const trio = [makeWallet(), makeWallet(), makeWallet()];
if (D1_CMD) {
  markOnChain([A, B, P, Q, R, ...trio].map((w) => w.wallet));
  console.log("marked the throwaway wallets as found on chain (pet_wallets)");
} else {
  console.log("no --d1-cmd: the throwaway wallets have no Solana account, so signed gates answer 403 unless the Worker's RPC is unreachable");
}
const signedTodayBefore = first.data.signedToday ?? 0;

const firstNonce = newGateNonce();
const act1 = await call<ActResult>("POST", "/api/pet/act", signedBody(A, day, "H", 0, null, firstNonce));
check("signed H on q0 goes through", act1.status === 200 && act1.data?.ok === true, `status ${act1.status} ${short(act1.data)}`);
const s1 = act1.data?.state;
check("response state counts the wallet: myGates 1, signedToday +1, leader is A",
  !!s1 && s1.myGates === 1 && (s1.signedToday ?? 0) >= signedTodayBefore + 1 && s1.leader?.wallet === A.wallet && s1.leader.gates === 1,
  short({ myGates: s1?.myGates, signedToday: s1?.signedToday, leader: s1?.leader }));
check("the recent action carries the wallet", s1?.recent[0]?.wallet === A.wallet && s1?.recent[0]?.gate === "H", short(s1?.recent[0]));

/* --- refusals ------------------------------------------------------- */

const replay = await call<ErrorReply>("POST", "/api/pet/act", signedBody(A, day, "H", 0, null, firstNonce));
check("replaying the nonce is refused with 409", replay.status === 409 && /nonce/.test(replay.data?.error ?? ""), `status ${replay.status} ${short(replay.data)}`);

const forged = { ...signedBody(A, day, "X", 1), sig: A.sign("something else") };
const forgedRes = await call<ErrorReply>("POST", "/api/pet/act", forged);
check("a signature over another message is refused with 401", forgedRes.status === 401, `status ${forgedRes.status} ${short(forgedRes.data)}`);

const stolen = { ...signedBody(A, day, "X", 1), wallet: B.wallet };
const stolenRes = await call<ErrorReply>("POST", "/api/pet/act", stolen);
check("a signature under another wallet is refused with 401", stolenRes.status === 401, `status ${stolenRes.status}`);

const staleDay = await call<ErrorReply>("POST", "/api/pet/act", signedBody(A, day + 1, "X", 1));
check("a gate signed for another day is refused with 409 and names the day",
  staleDay.status === 409 && /day/.test(staleDay.data?.error ?? "") && staleDay.data?.day === day, `status ${staleDay.status} ${short(staleDay.data)}`);

const partial = await call<ErrorReply>("POST", "/api/pet/act", { gate: "X", q: 1, day, wallet: A.wallet, nonce: newGateNonce() });
check("wallet and nonce without sig is 400", partial.status === 400, `status ${partial.status} ${short(partial.data)}`);

const badNonce = await call<ErrorReply>("POST", "/api/pet/act", { ...signedBody(A, day, "X", 1), nonce: "nope" });
check("a malformed nonce is 400", badNonce.status === 400, `status ${badNonce.status} ${short(badNonce.data)}`);

const noDay = signedBody(A, day, "X", 1);
delete noDay.day;
const noDayRes = await call<ErrorReply>("POST", "/api/pet/act", noDay);
check("a signed gate without day is 400", noDayRes.status === 400, `status ${noDayRes.status} ${short(noDayRes.data)}`);

/* --- the per-wallet limit ------------------------------------------- */

const act2 = await call<ActResult>("POST", "/api/pet/act", signedBody(A, day, "X", 1), "10.7.7.2");
const act3 = await call<ActResult>("POST", "/api/pet/act", signedBody(A, day, "H", 2), "10.7.7.3");
check(`signed gates 2 and 3 in the same minute go through (${SIGNED_PET_LIMIT} per wallet, any IP)`,
  act2.status === 200 && act3.status === 200, `status ${act2.status} ${act2.data && "error" in act2.data ? short(act2.data) : ""} / ${act3.status}`);
check("myGates is 3 after three signed gates", act3.data?.state?.myGates === 3, `myGates ${act3.data?.state?.myGates}`);

const noncesBefore = D1_CMD ? nonceRows() : 0;
const act4 = await call<ErrorReply>("POST", "/api/pet/act", signedBody(A, day, "X", 3), "10.7.7.4");
check("the fourth signed gate in the minute is 429 with retryAt",
  act4.status === 429 && typeof act4.data?.retryAt === "number" && act4.data.retryAt > Date.now(), `status ${act4.status} ${short(act4.data)}`);

const act4Replay = await call<ErrorReply>("POST", "/api/pet/act", signedBody(A, day, "X", 3), "10.7.7.4");
check("a rate-limited signed gate did not spend the register (still 429, not 409)", act4Replay.status === 429, `status ${act4Replay.status}`);
if (D1_CMD) {
  const noncesAfter = nonceRows();
  check("rate-limited signed gates write no pet_nonces row", noncesAfter === noncesBefore, `${noncesBefore} -> ${noncesAfter}`);
}

/* --- the per-IP caps on signed gates ---------------------------------- */

const capIp = freshIp(20);
const capCodes: number[] = [];
for (const who of [P, Q]) {
  for (let i = 0; i < SIGNED_PET_LIMIT; i++) capCodes.push((await call("POST", "/api/pet/act", signedBody(who, day, "X", i), capIp)).status);
}
check(`${SIGNED_IP_LIMIT} signed gates from one IP by two wallets go through`, capCodes.length === SIGNED_IP_LIMIT && capCodes.every((s) => s === 200), capCodes.join(" "));
const seventh = await call<ErrorReply>("POST", "/api/pet/act", signedBody(R, day, "X", 7), capIp);
check(`signed gate ${SIGNED_IP_LIMIT + 1} from that IP in the minute is 429 although its wallet is fresh`,
  seventh.status === 429 && typeof seventh.data?.retryAt === "number", `status ${seventh.status} ${short(seventh.data)}`);

const walletsIp = freshIp(21);
const trioCodes: number[] = [];
for (const who of trio) trioCodes.push((await call("POST", "/api/pet/act", signedBody(who, day, "H", 8), walletsIp)).status);
check(`${WALLETS_PER_IP_PER_DAY} wallets may sign from one IP in a day`, trioCodes.every((s) => s === 200), trioCodes.join(" "));
const fourthWallet = await call<ErrorReply>("POST", "/api/pet/act", signedBody(makeWallet(), day, "H", 8), walletsIp);
check(`wallet ${WALLETS_PER_IP_PER_DAY + 1} from that IP is 403 and names the limit`,
  fourthWallet.status === 403 && /wallets/.test(fourthWallet.data?.error ?? "") && (fourthWallet.data as { limit?: number } | null)?.limit === WALLETS_PER_IP_PER_DAY,
  `status ${fourthWallet.status} ${short(fourthWallet.data)}`);
const trioAgain = await call<ActResult>("POST", "/api/pet/act", signedBody(trio[0], day, "H", 9), walletsIp);
check("a wallet already counted for that IP still signs", trioAgain.status === 200, `status ${trioAgain.status}`);

const unfunded = await call<ErrorReply>("POST", "/api/pet/act", signedBody(makeWallet(), day, "X", 0), freshIp(22));
check("a wallet with no Solana account is 403 (needs the Worker's RPC; an unreachable RPC lets it through)",
  unfunded.status === 403 && /account/.test(unfunded.data?.error ?? ""), `status ${unfunded.status} ${short(unfunded.data)}`);

/* --- refused gates are capped per IP ---------------------------------- */

// A fresh wallet: A's own minute is spent, and the pre-check answers an exhausted wallet 429 before the signature is looked at.
const floodIp = freshIp(23);
const flooder = makeWallet();
const flood: number[] = [];
for (let i = 0; i < 25; i++) {
  flood.push((await call("POST", "/api/pet/act", { ...signedBody(flooder, day, "X", 1), sig: base64.encode(new Uint8Array(64)) }, floodIp)).status);
}
check("a bad-signature flood from one IP is 401 twenty times, then 429 from the pre-check",
  flood.slice(0, 20).every((s) => s === 401) && flood.slice(20).filter((s) => s === 429).length >= 3,
  flood.join(" "));

/* --- anonymous gates keep their own limit ---------------------------- */

const anonIp = `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const anon1 = await call<ActResult>("POST", "/api/pet/act", { gate: "H", q: 4 }, anonIp);
check("an anonymous gate still goes through (1 per minute per IP)", anon1.status === 200 && anon1.data?.state.recent[0]?.wallet === null, `status ${anon1.status} ${short(anon1.data && "error" in anon1.data ? anon1.data : anon1.data?.state.recent[0])}`);
const anon2 = await call<ErrorReply>("POST", "/api/pet/act", { gate: "H", q: 5 }, anonIp);
check("the second anonymous gate from the same IP is 429", anon2.status === 429, `status ${anon2.status}`);
const anonDay = await call<ErrorReply>("POST", "/api/pet/act", { gate: "H", q: 5, day: day + 1 }, "10.8.250.250");
check("an anonymous gate aimed at another day is 409", anonDay.status === 409, `status ${anonDay.status} ${short(anonDay.data)}`);

/* --- a second wallet ------------------------------------------------ */

const actB = await call<ActResult>("POST", "/api/pet/act", signedBody(B, day, "X", 6), MAIN_IP);
check("wallet B signs one gate from A's IP (its own bucket)", actB.status === 200 && actB.data?.state?.myGates === 1, `status ${actB.status} ${short(actB.data && "error" in actB.data ? actB.data : actB.data?.state?.myGates)}`);
check("the leader is still A with 3", actB.data?.state?.leader?.wallet === A.wallet && actB.data?.state?.leader?.gates === 3, short(actB.data?.state?.leader));

/* --- reads ----------------------------------------------------------- */

const mine = await call<PetState>("GET", `/api/pet?wallet=${A.wallet}`);
check("GET /api/pet?wallet=A reports myGates 3", mine.status === 200 && mine.data?.myGates === 3, `status ${mine.status} myGates ${mine.data?.myGates}`);
const other = await call<PetState>("GET", `/api/pet?wallet=${makeWallet().wallet}`);
check("GET /api/pet?wallet=<unused> reports myGates 0", other.status === 200 && other.data?.myGates === 0, `myGates ${other.data?.myGates}`);
const badWallet = await call<ErrorReply>("GET", "/api/pet?wallet=nope");
check("GET /api/pet?wallet=nope is 400", badWallet.status === 400, `status ${badWallet.status}`);

const noBadges = await call<PetBadge[]>("GET", `/api/pet/badges?wallet=${A.wallet}`);
check("GET /api/pet/badges before the collapse is an empty list", noBadges.status === 200 && Array.isArray(noBadges.data) && noBadges.data.length === 0, `status ${noBadges.status} ${short(noBadges.data)}`);
const badgesNoWallet = await call<ErrorReply>("GET", "/api/pet/badges");
check("GET /api/pet/badges without wallet is 400", badgesNoWallet.status === 400, `status ${badgesNoWallet.status}`);
const badgesBad = await call<ErrorReply>("GET", "/api/pet/badges?wallet=0OIl");
check("GET /api/pet/badges?wallet=0OIl is 400", badgesBad.status === 400, `status ${badgesBad.status}`);

/* --- the collapse: badges and the influencer ------------------------- */

if (AGE_CMD) {
  console.log("aging the day:", AGE_CMD);
  try {
    execSync(AGE_CMD, { stdio: "pipe" });
  } catch (e) {
    check("age command ran", false, e instanceof Error ? e.message : String(e));
  }
  const after = await call<PetState>("GET", "/api/pet");
  check("GET /api/pet collapses the aged day", after.status === 200 && after.data?.day === day + 1, `day ${after.data?.day} (was ${day})`);
  const recorded = after.data?.history[0];
  check("the recorded day names A as influencer with 3 signed gates",
    recorded?.day === day && recorded.topWallet === A.wallet && recorded.topGates === 3, short(recorded));
  check("the new day starts with no signed gates and no leader", after.data?.signedToday === 0 && after.data?.leader === null, short({ signedToday: after.data?.signedToday, leader: after.data?.leader }));

  const hist = await call<PetDay[]>("GET", "/api/pet/history?limit=3");
  check("GET /api/pet/history rows carry topWallet", hist.status === 200 && hist.data?.[0]?.day === day && hist.data[0].topWallet === A.wallet, short(hist.data?.[0]));

  const badgesA = await call<PetBadge[]>("GET", `/api/pet/badges?wallet=${A.wallet}`);
  const kindsA = (badgesA.data ?? []).filter((b) => b.day === day).map((b) => b.kind);
  check("A has influencer and witness for the day, influencer first",
    badgesA.status === 200 && kindsA.length === 2 && kindsA[0] === "influencer" && kindsA[1] === "witness", short(badgesA.data));
  const badgeA = (badgesA.data ?? [])[0];
  check("the badge row carries the day's form, collapse time and A's 3 signed gates",
    !!badgeA && badgeA.wallet === A.wallet && badgeA.form === recorded?.form && badgeA.measuredAt === recorded?.measuredAt && badgeA.gates === 3, short(badgeA));

  const badgesB = await call<PetBadge[]>("GET", `/api/pet/badges?wallet=${B.wallet}`);
  const kindsB = (badgesB.data ?? []).filter((b) => b.day === day).map((b) => b.kind);
  check("B has witness only", badgesB.status === 200 && kindsB.length === 1 && kindsB[0] === "witness" && badgesB.data?.[0]?.gates === 1, short(badgesB.data));

  const stale = await call<ErrorReply>("POST", "/api/pet/act", signedBody(B, day, "H", 7), "10.7.7.9");
  check("a gate signed for the collapsed day is now a day mismatch", stale.status === 409 && stale.data?.day === day + 1, `status ${stale.status} ${short(stale.data)}`);

  const again = await call<PetState>("GET", "/api/pet");
  check("a second read does not collapse again", again.data?.day === day + 1, `day ${again.data?.day}`);
} else {
  console.log("SKIP  collapse and badge checks (pass --age-cmd to run them)");
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
console.log("throwaway wallets", A.wallet, B.wallet);
process.exit(failed ? 1 : 0);

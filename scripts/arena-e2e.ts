/**
 * End-to-end check of the arena routes against a running Worker (local
 * `wrangler dev` with the migrations applied, or the deployment):
 *   spar against the house, two throwaway wallets with passports commit,
 *   withdraw, commit again, pair, both reveal, the bout resolves exactly and
 *   the ratings move; in between: a replayed commit is refused, a viewer
 *   claim (?wallet=) discloses nothing, one open bout per pair, a revealed
 *   side is not locked out; then a second bout is aged past the reveal
 *   window to check the forfeit.
 *
 * Run: node scripts/arena-e2e.ts [http://127.0.0.1:8791] [--age-cmd "<shell command with {id}>"]
 *        [--sql-cmd "<shell command with {file}>"] [--clock]
 *
 * `--age-cmd` is run (with {id} replaced by the bout id) to push a bout's
 * paired_at 25 h into the past, e.g.
 *   npx wrangler d1 execute dirac --local --command "UPDATE arena_bouts SET paired_at = paired_at - 90000000 WHERE id = '{id}'"
 * Without it the forfeit check is skipped.
 *
 * The daily tournament section (after the ranked one):
 * - always: GET /api/arena/tournament shape and day validation, the
 *   tournament's own 10-a-minute limit;
 * - `--sql-cmd` runs SQL against the same local D1 (the SQL is written to a
 *   temp file whose path replaces {file}), e.g.
 *     npx wrangler d1 execute dirac --local --file {file}
 *   It edits the local D1 to simulate what a real day would take hours to
 *   produce: entry timestamps (the earliest-commit tie-break), 63 synthetic
 *   entries (the 64-entry cap), and a whole bracket moved to a finished day
 *   (a day boundary crossed by editing rows: it resolves as all forfeits);
 * - `--clock` needs a target that also serves GET /__test/clock?offset=<ms>
 *   (shifts the Worker's Date.now()) and GET /__test/cron (runs
 *   resolveTournaments(env), the cron hook), i.e. a scratch entry that wraps
 *   worker/index.ts; never the deployment. With it the whole day is played:
 *   entries before 21:00, refusals on every boundary, reveals 21:00..23:59,
 *   resolution by the cron route and lazily on GET, standings and matrix
 *   against the local round robin, badges, and "resolved once".
 * Seals are dated by the Worker's clock (createSeal's signedAt), so they pass
 * the 1 h skew check while the clock is shifted.
 *
 * Local dev honours a `cf-connecting-ip` header, so each actor gets its own
 * rate-limit bucket; Cloudflare overwrites the header in production.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import {
  WALLET_MESSAGE,
  b64,
  buildPassport,
  createSeal,
  keysFromSeeds,
  seedsFromSignature,
  selfSign,
  utf8,
} from "../src/lib/pq.ts";
import {
  DAY_MS,
  ELO_START,
  TOURNAMENT_MAX_ENTRIES,
  canonicalCircuit,
  commitDocHash,
  commitHash,
  dayOf,
  dayStart,
  eloAfter,
  isDay,
  newSalt,
  parseCircuit,
  roundRobin,
  runBout,
  scoreA,
  shiftDay,
  sparTally,
  tournamentDocHash,
  tournamentSchedule,
  verdictOf,
  withdrawDocHash,
  type ArenaBadges,
  type ArenaBout,
  type ArenaLadder,
  type ArenaMe,
  type Circuit,
  type SparResult,
  type TournamentEnterResponse,
  type TournamentRevealResponse,
  type TournamentView,
} from "../src/lib/arena.ts";

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:8791";
const ageIndex = args.indexOf("--age-cmd");
const AGE_CMD = ageIndex >= 0 ? args[ageIndex + 1] : null;
const sqlIndex = args.indexOf("--sql-cmd");
const SQL_CMD = sqlIndex >= 0 ? args[sqlIndex + 1] : null;
const CLOCK = args.includes("--clock");

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, ip = "10.0.0.9") {
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

function makeIdentity(ip: string) {
  const sk = randomBytes(32);
  const wallet = base58.encode(ed25519.getPublicKey(sk));
  const keys = keysFromSeeds(seedsFromSignature(ed25519.sign(utf8("derive"), sk)));
  const passport = buildPassport(wallet, keys, "simple");
  return { sk, wallet, keys, passport, ip };
}

const circuit = (pre: Circuit["pre"], post: Circuit["post"] = []): Circuit => ({ v: 1, pre, post });

/* --- ladder and spar ---------------------------------------------- */

const ladder0 = await call<ArenaLadder>("GET", "/api/arena");
check("GET /api/arena", ladder0.status === 200 && Array.isArray(ladder0.data?.ladder) && !!ladder0.data?.house, `status ${ladder0.status}`);
const house = ladder0.data!.house;
check("house fighter is a valid circuit with day bits", parseCircuit(house.circuit).ok && /^[01]{10}$/.test(house.dayBits), canonicalCircuit(house.circuit));
check("layer description present", ladder0.data!.layer.gates.length === 3);

const player = circuit([{ g: "H" }, { g: "RY", t: 35 }], [{ g: "Z" }]);
const spar = await call<SparResult>("POST", "/api/arena/spar", { circuit: player });
check("POST /api/arena/spar", spar.status === 200 && spar.data?.rated === false, `status ${spar.status} ${JSON.stringify(spar.data).slice(0, 120)}`);
if (spar.data) {
  const local = runBout(player, house.circuit);
  const tally = sparTally(local, house.dayBits, spar.data.boutId);
  check("spar pA equals the local simulator", near(spar.data.pA, local.pA), `${spar.data.pA} vs ${local.pA}`);
  check("spar shots: 100, a + b = 100, sequence replays locally", spar.data.shots.n === 100 && spar.data.shots.a + spar.data.shots.b === 100 && spar.data.shots.sequence === tally.sequence && spar.data.shots.a === tally.a);
  check("spar verdict follows the exact rule", spar.data.verdict === verdictOf(local.pA));
}
const badSpar = await call("POST", "/api/arena/spar", { circuit: circuit([{ g: "RY", t: 7 }]) });
check("spar rejects an off-grid angle", badSpar.status === 400, `status ${badSpar.status} ${badSpar.data?.error}`);
const badSpar2 = await call("POST", "/api/arena/spar", { circuit: circuit([{ g: "H" }, { g: "H" }, { g: "H" }, { g: "H" }]) });
check("spar rejects 4 pre gates", badSpar2.status === 400, `status ${badSpar2.status} ${badSpar2.data?.error}`);

/* --- passports -------------------------------------------------- */

const A = makeIdentity("10.0.0.1");
const B = makeIdentity("10.0.0.2");
for (const who of [A, B]) {
  const reg = await call("POST", "/api/passports", {
    passport: who.passport,
    self_sig: selfSign(who.passport, who.keys.dsaSk),
    wallet_sig: b64.encode(ed25519.sign(utf8(WALLET_MESSAGE(who.passport)), who.sk)),
  }, who.ip);
  check(`register passport ${who.wallet.slice(0, 4)}`, reg.status === 200, `status ${reg.status} ${JSON.stringify(reg.data)}`);
}

function commitBody(who: ReturnType<typeof makeIdentity>, c: Circuit) {
  const salt = newSalt();
  const commit = commitHash(c, salt);
  const seal = createSeal(commitDocHash(commit), who.passport, who.keys.dsaSk);
  return { salt, commit, body: { wallet: who.wallet, commit, seal } };
}

/* --- commit, pairing, reveal ----------------------------------------- */

const C = makeIdentity("10.0.0.3");
const cA = circuit([{ g: "RY", t: 50 }, { g: "H" }], [{ g: "RY", t: -30 }]);
const cB = circuit([{ g: "X" }], [{ g: "RY", t: 120 }, { g: "Z" }]);

const noPass = commitBody(C, cA);
const noPassRes = await call("POST", "/api/arena/commit", noPass.body, C.ip);
check("commit without a registered passport -> 403", noPassRes.status === 403, `status ${noPassRes.status} ${noPassRes.data?.error}`);

// The limiter is per client IP (10 mutating requests a minute); the refused
// attempts below come from side addresses so the real flow keeps its quota.
const A_BAD = "10.0.0.21";
const A_SIDE = "10.0.0.22";

const forged = commitBody(A, cA);
const forgedRes = await call("POST", "/api/arena/commit", { ...forged.body, seal: { ...forged.body.seal, signature: b64.encode(randomBytes(3309)) } }, A_BAD);
check("commit with a forged seal -> 400", forgedRes.status === 400, `status ${forgedRes.status} ${forgedRes.data?.error}`);

const wrongDoc = commitBody(A, cA);
const otherCommit = commitHash(cB, newSalt());
const wrongDocRes = await call("POST", "/api/arena/commit", { ...wrongDoc.body, commit: otherCommit }, A_BAD);
check("commit whose seal covers another commit -> 400", wrongDocRes.status === 400, `status ${wrongDocRes.status} ${wrongDocRes.data?.error}`);

const future = commitBody(A, cA);
const futureSeal = createSeal(commitDocHash(future.commit), A.passport, A.keys.dsaSk, { signedAt: Math.floor(Date.now() / 1000) + 3700 });
const futureRes = await call("POST", "/api/arena/commit", { ...future.body, seal: futureSeal }, A_BAD);
check("commit sealed 1 h in the future -> 400 naming the future, not 'too old'", futureRes.status === 400 && /future/.test(String(futureRes.data?.error)) && !/too old/.test(String(futureRes.data?.error)), `status ${futureRes.status} ${futureRes.data?.error}`);
const stale = commitBody(A, cA);
const staleSeal = createSeal(commitDocHash(stale.commit), A.passport, A.keys.dsaSk, { signedAt: Math.floor(Date.now() / 1000) - 3700 });
const staleRes = await call("POST", "/api/arena/commit", { ...stale.body, seal: staleSeal }, A_BAD);
check("commit sealed 1 h ago -> 400 'too old'", staleRes.status === 400 && /too old/.test(String(staleRes.data?.error)), `status ${staleRes.status} ${staleRes.data?.error}`);

/* --- withdraw ----------------------------------------------------------- */

const a0 = commitBody(A, cA);
const a0Res = await call("POST", "/api/arena/commit", a0.body, A_SIDE);
check("A commits -> queued (to be withdrawn)", a0Res.status === 200 && a0Res.data?.queued === true, `status ${a0Res.status} ${JSON.stringify(a0Res.data)}`);
const withdrawBody = (who: ReturnType<typeof makeIdentity>, commit: string) => ({
  wallet: who.wallet,
  commit,
  seal: createSeal(withdrawDocHash(commit), who.passport, who.keys.dsaSk),
});
const wrongWithdraw = await call("DELETE", "/api/arena/queue", { ...withdrawBody(A, a0.commit), seal: createSeal(commitDocHash(a0.commit), A.passport, A.keys.dsaSk) }, A_BAD);
check("withdraw with the commit seal instead of the withdraw seal -> 400", wrongWithdraw.status === 400, `status ${wrongWithdraw.status} ${wrongWithdraw.data?.error}`);
const strangerWithdraw = await call("DELETE", "/api/arena/queue", { ...withdrawBody(B, a0.commit), wallet: A.wallet }, A_BAD);
check("withdraw sealed by another passport -> 400", strangerWithdraw.status === 400, `status ${strangerWithdraw.status} ${strangerWithdraw.data?.error}`);
const withdrawn = await call<{ withdrawn: boolean; commit: string }>("DELETE", "/api/arena/queue", withdrawBody(A, a0.commit), A_SIDE);
check("A withdraws its queued fighter -> { withdrawn: true }", withdrawn.status === 200 && withdrawn.data?.withdrawn === true && withdrawn.data?.commit === a0.commit, `status ${withdrawn.status} ${JSON.stringify(withdrawn.data)}`);
check("queue is empty after the withdrawal", (await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`)).data?.queued === null);
const withdrawAgain = await call("DELETE", "/api/arena/queue", withdrawBody(A, a0.commit), A_SIDE);
check("withdrawing again -> 404", withdrawAgain.status === 404, `status ${withdrawAgain.status} ${withdrawAgain.data?.error}`);

const a1 = commitBody(A, cA);
const a1Res = await call("POST", "/api/arena/commit", a1.body, A.ip);
check("A commits -> queued", a1Res.status === 200 && a1Res.data?.queued === true, `status ${a1Res.status} ${JSON.stringify(a1Res.data)}`);

const meA0 = await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`, undefined, A.ip);
check("GET /me shows A queued with the commit", meA0.status === 200 && meA0.data?.queued?.commit === a1.commit && meA0.data?.rating.elo === ELO_START);

const a1again = await call("POST", "/api/arena/commit", commitBody(A, cA).body, A.ip);
check("a second commit from A while queued -> 409", a1again.status === 409, `status ${a1again.status} ${a1again.data?.error}`);

const b1 = commitBody(B, cB);
const b1Res = await call<{ queued: boolean; boutId: string; role: string }>("POST", "/api/arena/commit", b1.body, B.ip);
check("B commits -> paired as B", b1Res.status === 200 && b1Res.data?.queued === false && b1Res.data?.role === "b" && /^[0-9a-f]{16}$/.test(b1Res.data?.boutId ?? ""), `status ${b1Res.status} ${JSON.stringify(b1Res.data)}`);
const boutId = b1Res.data!.boutId;

const open = await call<ArenaBout>("GET", `/api/arena/bout/${boutId}`);
check("GET bout: open, no circuits, 24 h reveal window", open.status === 200 && open.data?.a === A.wallet && open.data?.b === B.wallet && open.data?.aCircuit === null && open.data?.bCircuit === null && open.data?.resolvedAt === null && open.data?.revealBy === open.data!.pairedAt + 86_400_000);
check("queue is empty after pairing", (await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`)).data?.queued === null);

/* --- replay: a commit is single-use ----------------------------------- */

const replay = await call("POST", "/api/arena/commit", a1.body, A_SIDE);
check("replaying A's paired commit body -> 409, not queued again", replay.status === 409 && (await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`)).data?.queued === null, `status ${replay.status} ${replay.data?.error}`);

/* --- one open bout per pair: B queues instead of pairing with A again --- */

const a1b = commitBody(A, cA);
const a1bRes = await call("POST", "/api/arena/commit", a1b.body, A_SIDE);
check("A commits again while bout 1 is open -> queued (a fresh commit)", a1bRes.status === 200 && a1bRes.data?.queued === true, `status ${a1bRes.status} ${JSON.stringify(a1bRes.data)}`);
const b1b = commitBody(B, cB);
const b1bRes = await call("POST", "/api/arena/commit", b1b.body, B.ip);
check("B commits while A waits but has an open bout with B -> B queues too", b1bRes.status === 200 && b1bRes.data?.queued === true, `status ${b1bRes.status} ${JSON.stringify(b1bRes.data)}`);
for (const [who, body, ip] of [[A, withdrawBody(A, a1b.commit), A_SIDE], [B, withdrawBody(B, b1b.commit), B.ip]] as const) {
  const w = await call("DELETE", "/api/arena/queue", body, ip);
  check(`${who.wallet.slice(0, 4)} withdraws the extra fighter`, w.status === 200, `status ${w.status} ${w.data?.error ?? ""}`);
}

const wrongSalt = await call("POST", "/api/arena/reveal", { wallet: A.wallet, boutId, circuit: cA, salt: newSalt() }, A.ip);
check("reveal with the wrong salt -> 400", wrongSalt.status === 400, `status ${wrongSalt.status} ${wrongSalt.data?.error}`);
const wrongCircuit = await call("POST", "/api/arena/reveal", { wallet: A.wallet, boutId, circuit: cB, salt: a1.salt }, A.ip);
check("reveal with another circuit -> 400", wrongCircuit.status === 400, `status ${wrongCircuit.status} ${wrongCircuit.data?.error}`);
const stranger = await call("POST", "/api/arena/reveal", { wallet: C.wallet, boutId, circuit: cA, salt: a1.salt }, C.ip);
check("reveal by a wallet not in the bout -> 403", stranger.status === 403, `status ${stranger.status}`);

const revA = await call<ArenaBout>("POST", "/api/arena/reveal", { wallet: A.wallet, boutId, circuit: cA, salt: a1.salt }, A.ip);
check("A reveals: own circuit echoed, bout still open", revA.status === 200 && revA.data?.aRevealedAt !== null && revA.data?.resolvedAt === null && canonicalCircuit(revA.data!.aCircuit!) === canonicalCircuit(cA) && revA.data?.bCircuit === null, `status ${revA.status} ${JSON.stringify(revA.data).slice(0, 160)}`);
const asB = await call<ArenaBout>("GET", `/api/arena/bout/${boutId}?wallet=${B.wallet}`);
check("B cannot see A's circuit before resolution", asB.data?.aCircuit === null && asB.data?.aRevealedAt !== null);
// A viewer claim is not a proof: a third party sending ?wallet=A must not get A's circuit either.
const asAfromC = await call<ArenaBout>("GET", `/api/arena/bout/${boutId}?wallet=${A.wallet}`, undefined, C.ip);
check("GET bout?wallet=A from a third party does not disclose A's circuit", asAfromC.status === 200 && asAfromC.data?.aCircuit === null && asAfromC.data?.aRevealedAt !== null, JSON.stringify(asAfromC.data?.aCircuit));
const meAfromC = await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`, undefined, C.ip);
check("GET /me?wallet=A from a third party does not disclose A's circuit", meAfromC.status === 200 && meAfromC.data?.unresolved[0]?.aCircuit === null && meAfromC.data?.unresolved[0]?.revealed === true, JSON.stringify(meAfromC.data?.unresolved[0]?.aCircuit));
const meA1 = await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`);
check("GET /me: A's open bout says revealed, waiting", meA1.data?.unresolved.length === 1 && meA1.data?.unresolved[0].revealed === true && meA1.data?.unresolved[0].mustReveal === false && meA1.data?.unresolved[0].role === "a");
const a1c = commitBody(A, cA);
const a1cRes = await call("POST", "/api/arena/commit", a1c.body, A_SIDE);
check("A, having revealed, is not locked by B's pending reveal: a new commit queues", a1cRes.status === 200 && a1cRes.data?.queued === true, `status ${a1cRes.status} ${JSON.stringify(a1cRes.data)}`);
check("A withdraws it again", (await call("DELETE", "/api/arena/queue", withdrawBody(A, a1c.commit), A_SIDE)).status === 200);
const meB1 = await call<ArenaMe>("GET", `/api/arena/me?wallet=${B.wallet}`);
check("GET /me: B must reveal, opponent revealed", meB1.data?.unresolved[0]?.mustReveal === true && meB1.data?.unresolved[0]?.opponentRevealed === true && meB1.data?.unresolved[0]?.role === "b");

const revAagain = await call<ArenaBout>("POST", "/api/arena/reveal", { wallet: A.wallet, boutId, circuit: cA, salt: a1.salt }, A.ip);
check("A reveals again: idempotent", revAagain.status === 200 && revAagain.data?.resolvedAt === null);

const revB = await call<ArenaBout>("POST", "/api/arena/reveal", { wallet: B.wallet, boutId, circuit: cB, salt: b1.salt }, B.ip);
const expected = runBout(cA, cB);
check("B reveals: resolved exactly", revB.status === 200 && revB.data?.resolvedAt !== null && near(revB.data!.pA!, expected.pA) && revB.data?.result === verdictOf(expected.pA) && revB.data?.probs !== null, `status ${revB.status} result ${revB.data?.result} pA ${revB.data?.pA} expected ${expected.pA}`);
const publicBout = await call<ArenaBout>("GET", `/api/arena/bout/${boutId}`);
check("resolved bout shows both circuits to anyone", publicBout.data?.aCircuit !== null && publicBout.data?.bCircuit !== null);

const score = scoreA(verdictOf(expected.pA))!;
const elo1 = eloAfter(ELO_START, ELO_START, score);
const meA2 = await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`);
const meB2 = await call<ArenaMe>("GET", `/api/arena/me?wallet=${B.wallet}`);
check("ELO moved for A", near(meA2.data!.rating.elo, elo1.a, 1e-6) && meA2.data!.rating.bouts === 1, `${meA2.data?.rating.elo} expected ${elo1.a}`);
check("ELO moved for B", near(meB2.data!.rating.elo, elo1.b, 1e-6) && meB2.data!.rating.bouts === 1, `${meB2.data?.rating.elo} expected ${elo1.b}`);
check("record counts", (score === 1 ? meA2.data!.rating.wins === 1 && meB2.data!.rating.losses === 1 : score === 0 ? meA2.data!.rating.losses === 1 && meB2.data!.rating.wins === 1 : meA2.data!.rating.draws === 1));
check("resolved bout in A's recent list", meA2.data!.recent.length === 1 && meA2.data!.recent[0].id === boutId && meA2.data!.unresolved.length === 0);

const ladder1 = await call<ArenaLadder>("GET", "/api/arena");
check("ladder lists both wallets, latest bout with circuits and pA", ladder1.data!.ladder.some((r) => r.wallet === A.wallet) && ladder1.data!.ladder.some((r) => r.wallet === B.wallet) && ladder1.data!.recent[0]?.id === boutId && ladder1.data!.recent[0]?.aCircuit !== null && near(ladder1.data!.recent[0]!.pA!, expected.pA));
const sorted = ladder1.data!.ladder.every((r, i, arr) => i === 0 || arr[i - 1].elo >= r.elo);
check("ladder sorted by ELO", sorted);

/* --- forfeit ------------------------------------------------------- */

if (AGE_CMD) {
  const cA2 = circuit([{ g: "Z" }, { g: "RY", t: -85 }]);
  const cB2 = circuit([{ g: "H" }], [{ g: "X" }]);
  const a2 = commitBody(A, cA2);
  const a2Res = await call("POST", "/api/arena/commit", a2.body, A.ip);
  const b2 = commitBody(B, cB2);
  const b2Res = await call<{ queued: boolean; boutId: string }>("POST", "/api/arena/commit", b2.body, B.ip);
  check("second pairing", a2Res.data?.queued === true && b2Res.data?.queued === false, `${JSON.stringify(a2Res.data)} ${JSON.stringify(b2Res.data)}`);
  const bout2 = b2Res.data!.boutId;
  const rev = await call<ArenaBout>("POST", "/api/arena/reveal", { wallet: A.wallet, boutId: bout2, circuit: cA2, salt: a2.salt }, A.ip);
  check("A reveals in bout 2", rev.status === 200 && rev.data?.aRevealedAt !== null);
  const before = (await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`)).data!.rating;
  const beforeB = (await call<ArenaMe>("GET", `/api/arena/me?wallet=${B.wallet}`)).data!.rating;
  const cmd = AGE_CMD.replace("{id}", bout2);
  console.log("aging bout", bout2);
  execSync(cmd, { stdio: "inherit", shell: process.platform === "win32" ? "cmd.exe" : undefined });
  const settled = await call<ArenaBout>("GET", `/api/arena/bout/${bout2}`);
  check("aged bout resolves as B's forfeit on GET", settled.status === 200 && settled.data?.result === "b_forfeit" && settled.data?.resolvedAt !== null && settled.data?.pA === null, `${JSON.stringify(settled.data).slice(0, 200)}`);
  const elo2 = eloAfter(before.elo, beforeB.elo, 1);
  const afterA = (await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`)).data!.rating;
  const afterB = (await call<ArenaMe>("GET", `/api/arena/me?wallet=${B.wallet}`)).data!.rating;
  check("forfeit moves ELO like a win for A", near(afterA.elo, elo2.a, 1e-6) && near(afterB.elo, elo2.b, 1e-6) && afterA.wins === before.wins + 1 && afterB.losses === beforeB.losses + 1, `${afterA.elo} / ${afterB.elo} expected ${elo2.a} / ${elo2.b}`);
  const again = await call<ArenaBout>("GET", `/api/arena/bout/${bout2}`);
  const afterA2 = (await call<ArenaMe>("GET", `/api/arena/me?wallet=${A.wallet}`)).data!.rating;
  check("a second GET does not settle twice", again.data?.result === "b_forfeit" && near(afterA2.elo, afterA.elo, 1e-9));
} else {
  console.log("SKIP  forfeit (no --age-cmd)");
}

/* --- rate limit ------------------------------------------------------- */

let limited = false;
for (let i = 0; i < 12; i++) {
  const r = await call("POST", "/api/arena/spar", { circuit: player }, "10.0.0.77");
  if (r.status === 429) {
    limited = typeof r.data?.retryAt === "number";
    break;
  }
}
check("11th POST in a minute from one IP -> 429 with retryAt", limited);

/* --- daily tournament ---------------------------------------------------- */

console.log("\n--- daily tournament");

let clockOffset = 0;
/** Points the Worker's Date.now() at `at` (unix ms), or back at the real clock with null. */
async function setClock(at: number | null): Promise<void> {
  const offset = at === null ? 0 : at - Date.now();
  const res = await fetch(`${BASE}/__test/clock?offset=${offset}`);
  const data = (await res.json()) as { offset: number };
  clockOffset = data.offset;
}
const serverNow = () => Date.now() + clockOffset;
const sealedAt = (shiftS = 0) => Math.floor(serverNow() / 1000) + shiftS;

function runSql(sql: string): void {
  if (!SQL_CMD) throw new Error("no --sql-cmd");
  const file = join(mkdtempSync(join(tmpdir(), "arena-e2e-")), "edit.sql");
  writeFileSync(file, sql);
  try {
    execSync(SQL_CMD.replace("{file}", file), { stdio: "pipe", shell: process.platform === "win32" ? "cmd.exe" : undefined });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    console.log(String(err.stdout ?? ""), String(err.stderr ?? ""));
    throw e;
  }
}

type Identity = ReturnType<typeof makeIdentity>;
const isPhase = (p: unknown) => p === "upcoming" || p === "entry" || p === "reveal" || p === "closing" || p === "resolved";

function entryBody(who: Identity, c: Circuit, day: string, opts: { sealDay?: string; docHash?: string; signedShiftS?: number } = {}) {
  const salt = newSalt();
  const commit = commitHash(c, salt);
  const seal = createSeal(opts.docHash ?? tournamentDocHash(opts.sealDay ?? day, commit), who.passport, who.keys.dsaSk, {
    signedAt: sealedAt(opts.signedShiftS ?? 0),
  });
  return { salt, commit, circuit: c, body: { wallet: who.wallet, day, commit, seal } };
}
type Entry = ReturnType<typeof entryBody>;
const enter = (e: Entry, ip: string) => call<TournamentEnterResponse>("POST", "/api/arena/tournament/enter", e.body, ip);
const revealT = (who: Identity, day: string, c: Circuit, salt: string, ip = who.ip) =>
  call<TournamentRevealResponse>("POST", "/api/arena/tournament/reveal", { wallet: who.wallet, day, circuit: c, salt }, ip);
const viewOf = async (day: string) => (await call<TournamentView>("GET", `/api/arena/tournament?day=${day}`)).data!;

const t0 = await call<TournamentView>("GET", "/api/arena/tournament");
const v0 = t0.data;
check(
  "GET /api/arena/tournament: today's view, its schedule, the cap",
  t0.status === 200 &&
    !!v0 &&
    isDay(v0.day) &&
    v0.day === dayOf(v0.now) &&
    isPhase(v0.phase) &&
    v0.maxEntries === TOURNAMENT_MAX_ENTRIES &&
    JSON.stringify(v0.schedule) === JSON.stringify(tournamentSchedule(v0.day)) &&
    Array.isArray(v0.entrants),
  `status ${t0.status} ${JSON.stringify(v0).slice(0, 160)}`,
);
for (const bad of ["2026-02-30", "yesterday", "2026-1-01"]) {
  const r = await call("GET", `/api/arena/tournament?day=${bad}`);
  check(`GET tournament ?day=${bad} -> 400`, r.status === 400, `status ${r.status}`);
}
const empty = await call<TournamentView>("GET", "/api/arena/tournament?day=2001-01-01");
check("a past day nobody entered: resolved phase, no entrants, no result", empty.status === 200 && empty.data?.phase === "resolved" && empty.data.entrants.length === 0 && empty.data.result === null);

// Identities for the tournament, registered on the real clock.
const T = [1, 2, 3, 4, 5].map((i) => makeIdentity(`10.0.1.${i}`));
for (const who of T) {
  const reg = await call("POST", "/api/passports", {
    passport: who.passport,
    self_sig: selfSign(who.passport, who.keys.dsaSk),
    wallet_sig: b64.encode(ed25519.sign(utf8(WALLET_MESSAGE(who.passport)), who.sk)),
  }, who.ip);
  check(`register tournament passport ${who.wallet.slice(0, 4)}`, reg.status === 200, `status ${reg.status}`);
}
const [T1, T2, T3, T4, T5] = T;

let tLimited = false;
for (let i = 0; i < 12; i++) {
  const r = await call("POST", "/api/arena/tournament/enter", { wallet: C.wallet, commit: "c".repeat(64), seal: {} }, "10.0.1.77");
  if (r.status === 429) {
    tLimited = i === 10 && typeof r.data?.retryAt === "number";
    break;
  }
}
check("tournament POSTs: the 11th in a minute from one IP -> 429 (own bucket)", tLimited);

const STRONG = circuit([], [{ g: "RY", t: 60 }]);
const TWIN = circuit([{ g: "H" }], [{ g: "RY", t: 35 }]);
const OTHER = circuit([{ g: "X" }], [{ g: "RY", t: 120 }, { g: "Z" }]);

if (CLOCK) {
  try {
    const X = dayOf(Date.UTC(2031, 0, 1) + Math.floor(Math.random() * 2000) * DAY_MS);
    const sX = tournamentSchedule(X);
    console.log("tournament day", X);
    await setClock(sX.opensAt + 10 * 3_600_000);
    const BAD = "10.0.1.21";

    // Entry phase: refusals.
    const noPass = await enter(entryBody(C, STRONG, X), BAD);
    check("enter without a registered passport -> 403", noPass.status === 403, `status ${noPass.status} ${noPass.data?.error}`);
    const wrongDay = await enter(entryBody(T1, STRONG, shiftDay(X, 1)), BAD);
    check("enter for another day than the server's today -> 409", wrongDay.status === 409, `status ${wrongDay.status} ${wrongDay.data?.error}`);
    const rankedSeal = entryBody(T1, STRONG, X);
    const rankedSealRes = await enter({ ...rankedSeal, body: { ...rankedSeal.body, seal: createSeal(commitDocHash(rankedSeal.commit), T1.passport, T1.keys.dsaSk, { signedAt: sealedAt() }) } }, BAD);
    check("enter sealed with the ranked message instead of the tournament's -> 400", rankedSealRes.status === 400, `status ${rankedSealRes.status} ${rankedSealRes.data?.error}`);
    const otherDaySeal = await enter(entryBody(T1, STRONG, X, { sealDay: shiftDay(X, -1) }), BAD);
    check("enter sealed for yesterday -> 400 (the seal binds the day)", otherDaySeal.status === 400 && /cover/.test(String(otherDaySeal.data?.error)), `status ${otherDaySeal.status} ${otherDaySeal.data?.error}`);
    const staleT = await enter(entryBody(T1, STRONG, X, { signedShiftS: -7200 }), BAD);
    check("enter sealed 2 h before the Worker's clock -> 400 too old", staleT.status === 400 && /too old/.test(String(staleT.data?.error)), `status ${staleT.status} ${staleT.data?.error}`);

    // Entries.
    const e1 = entryBody(T1, STRONG, X);
    const e2 = entryBody(T2, TWIN, X);
    const e3 = entryBody(T3, TWIN, X);
    const e4 = entryBody(T4, OTHER, X);
    const plan: [Identity, Entry][] = [[T1, e1], [T2, e2], [T3, e3], [T4, e4]];
    let n = 0;
    for (const [who, e] of plan) {
      const r = await enter(e, who.ip);
      n++;
      check(`${who.wallet.slice(0, 4)} enters ${X} -> entry ${n}`, r.status === 200 && r.data?.entered === true && r.data.day === X && r.data.commit === e.commit && r.data.entries === n, `status ${r.status} ${JSON.stringify(r.data)}`);
    }
    const again = await enter(entryBody(T1, STRONG, X), "10.0.1.22");
    check("a second entry of the same wallet that day -> 409", again.status === 409 && again.data?.commit === e1.commit, `status ${again.status} ${again.data?.error}`);
    const stolen = entryBody(T5, STRONG, X);
    const stolenRes = await enter({ ...stolen, body: { ...stolen.body, commit: e1.commit, seal: createSeal(tournamentDocHash(X, e1.commit), T5.passport, T5.keys.dsaSk, { signedAt: sealedAt() }) } }, "10.0.1.22");
    check("another wallet entering an already entered commit -> 409", stolenRes.status === 409 && /commit/.test(String(stolenRes.data?.error)), `status ${stolenRes.status} ${stolenRes.data?.error}`);

    let vx = await viewOf(X);
    check(
      "entry phase view: 4 entrants in commit order, nothing revealed, no circuit anywhere",
      vx.phase === "entry" && vx.counts.entries === 4 && vx.counts.revealed === 0 && vx.entrants.map((e) => e.wallet).join() === [T1, T2, T3, T4].map((w) => w.wallet).join() && vx.result === null && !JSON.stringify(vx).includes('"pre"'),
      JSON.stringify(vx).slice(0, 200),
    );
    const early = await revealT(T1, X, STRONG, e1.salt, BAD);
    check("reveal before 21:00 UTC -> 409", early.status === 409 && /21:00/.test(String(early.data?.error)), `status ${early.status} ${early.data?.error}`);

    // The earliest-commit tie-break: T2 and T3 field the same circuit; T3's entry is moved an hour earlier in the D1.
    if (SQL_CMD) runSql(`UPDATE arena_tournament_entries SET entered_at = entered_at - 3600000 WHERE day = '${X}' AND wallet = '${T3.wallet}';`);

    // Reveal phase.
    await setClock(sX.entryClosesAt + 30 * 60_000);
    const late = await enter(entryBody(T5, OTHER, X), "10.0.1.23");
    check("enter after 21:00 UTC -> 409", late.status === 409 && /closed/.test(String(late.data?.error)), `status ${late.status} ${late.data?.error}`);
    const wrongSaltT = await revealT(T1, X, STRONG, newSalt(), "10.0.1.23");
    check("reveal with the wrong salt -> 400", wrongSaltT.status === 400, `status ${wrongSaltT.status} ${wrongSaltT.data?.error}`);
    const swapped = await revealT(T1, X, TWIN, e2.salt, "10.0.1.23");
    check("reveal with another entrant's circuit and salt -> 400", swapped.status === 400, `status ${swapped.status} ${swapped.data?.error}`);
    const noEntry = await revealT(T5, X, STRONG, e1.salt, "10.0.1.23");
    check("reveal by a wallet with no entry -> 404", noEntry.status === 404, `status ${noEntry.status} ${noEntry.data?.error}`);
    const revealed = new Map<string, number>();
    for (const [who, e] of plan.slice(0, 3)) {
      const r = await revealT(who, X, e.circuit, e.salt);
      revealed.set(who.wallet, r.data?.revealedAt ?? 0);
      check(`${who.wallet.slice(0, 4)} reveals: own circuit echoed`, r.status === 200 && r.data?.revealed === true && r.data.commit === e.commit && canonicalCircuit(r.data.circuit) === canonicalCircuit(e.circuit), `status ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    }
    const twice = await revealT(T1, X, STRONG, e1.salt);
    check("revealing twice is idempotent (same revealedAt)", twice.status === 200 && twice.data?.revealedAt === revealed.get(T1.wallet));
    vx = await viewOf(X);
    check(
      "reveal phase view: 3 revealed, timestamps public, circuits still hidden",
      vx.phase === "reveal" && vx.counts.revealed === 3 && vx.entrants.filter((e) => e.revealedAt !== null).length === 3 && vx.result === null && !JSON.stringify(vx).includes('"pre"'),
      JSON.stringify(vx).slice(0, 200),
    );

    // The last minute: reveals closed, nothing resolved yet.
    await setClock(sX.revealClosesAt + 30_000);
    const tooLate = await revealT(T4, X, OTHER, e4.salt);
    check("reveal after 23:59 UTC -> 409", tooLate.status === 409 && /closed/.test(String(tooLate.data?.error)), `status ${tooLate.status} ${tooLate.data?.error}`);
    vx = await viewOf(X);
    check("23:59..00:00: phase closing, no result yet", vx.phase === "closing" && vx.result === null, vx.phase);

    // 00:00 of the next day: the cron route resolves the day.
    await setClock(sX.resolvesAt + 5_000);
    const cron = (await call<{ resolved: string[] }>("GET", "/__test/cron")).data;
    check("resolveTournaments (the cron hook) resolves the finished day", !!cron && cron.resolved.includes(X), JSON.stringify(cron));
    vx = await viewOf(X);
    const res = vx.result;
    const fighters = vx.entrants
      .filter((e) => e.revealedAt !== null)
      .map((e) => ({ wallet: e.wallet, commit: e.commit, enteredAt: e.enteredAt, circuit: plan.find(([w]) => w.wallet === e.wallet)![1].circuit }));
    const local = roundRobin(fighters);
    check(
      "resolved: 3 standings with circuits, T4 a forfeit, nothing else",
      vx.phase === "resolved" && !!res && res.standings.length === 3 && res.forfeits.length === 1 && res.forfeits[0].wallet === T4.wallet && res.standings.every((s) => parseCircuit(s.circuit).ok),
      JSON.stringify(res).slice(0, 200),
    );
    if (res) {
      check(
        "standings equal the local round robin: order, points, record, margin",
        res.standings.length === local.standings.length &&
          res.standings.every((s, i) => {
            const l = local.standings[i];
            return s.wallet === l.wallet && s.place === i + 1 && s.points === l.points && s.wins === l.wins && s.draws === l.draws && s.losses === l.losses && s.games === 4 && near(s.margin, l.margin, 1e-12);
          }),
        `${res.standings.map((s) => `${s.wallet.slice(0, 4)}:${s.points}/${s.margin.toFixed(4)}`).join(" ")} vs ${local.standings.map((s) => `${s.wallet.slice(0, 4)}:${s.points}/${s.margin.toFixed(4)}`).join(" ")}`,
      );
      check(
        "matrix: 3 x 3, null diagonal, every cell the exact pA of row as A vs column as B",
        res.matrix.length === 3 &&
          res.matrix.every((row, i) => row.length === 3 && row.every((p, j) => (i === j ? p === null : p !== null && near(p, runBout(res.standings[i].circuit, res.standings[j].circuit).pA, 1e-12)))),
        JSON.stringify(res.matrix),
      );
      const i2 = res.standings.findIndex((s) => s.wallet === T2.wallet);
      const i3 = res.standings.findIndex((s) => s.wallet === T3.wallet);
      const twinsTied = res.standings[i2].points === res.standings[i3].points && near(res.standings[i2].margin, res.standings[i3].margin, 1e-12);
      check(
        SQL_CMD ? "twins tie on points and margin; the earlier commit (T3, moved back in the D1) ranks first" : "twins tie on points and margin; the earlier commit ranks first",
        twinsTied && (SQL_CMD ? i3 < i2 : i2 < i3),
        `T2 #${i2 + 1} T3 #${i3 + 1}`,
      );
      const cron2 = (await call<{ resolved: string[] }>("GET", "/__test/cron")).data;
      const vAgain = await viewOf(X);
      check("resolved once: a second cron run and a second read change nothing", !!cron2 && !cron2.resolved.includes(X) && vAgain.result?.resolvedAt === res.resolvedAt && JSON.stringify(vAgain.result) === JSON.stringify(res));
      for (const s of res.standings) {
        const b = (await call<ArenaBadges>("GET", `/api/arena/badges?wallet=${s.wallet}`)).data;
        check(`badge for place ${s.place}`, !!b && b.badges.some((x) => x.day === X && x.place === s.place && x.kind === "tournament"), JSON.stringify(b));
      }
      const b4 = (await call<ArenaBadges>("GET", `/api/arena/badges?wallet=${T4.wallet}`)).data;
      check("no badge for the forfeit", !!b4 && !b4.badges.some((x) => x.day === X));
    }
    const afterRes = await revealT(T4, X, OTHER, e4.salt);
    check("reveal after the resolution -> 409", afterRes.status === 409, `status ${afterRes.status}`);

    // Day Y = X + 1, resolved lazily by a read (no cron), with a forfeit.
    const Y = shiftDay(X, 1);
    const sY = tournamentSchedule(Y);
    const y1 = entryBody(T1, OTHER, Y);
    const y2 = entryBody(T2, STRONG, Y);
    const y4 = entryBody(T4, TWIN, Y);
    for (const [who, e] of [[T1, y1], [T2, y2], [T4, y4]] as const) {
      const r = await enter(e, who.ip);
      check(`${who.wallet.slice(0, 4)} enters ${Y} at 00:00:05`, r.status === 200, `status ${r.status} ${r.data?.error ?? ""}`);
    }
    await setClock(sY.entryClosesAt + 5 * 60_000);
    for (const [who, e] of [[T1, y1], [T2, y2]] as const) {
      const r = await revealT(who, Y, e.circuit, e.salt);
      check(`${who.wallet.slice(0, 4)} reveals in ${Y}`, r.status === 200, `status ${r.status} ${r.data?.error ?? ""}`);
    }
    await setClock(sY.resolvesAt + 3_000);
    const vy = await viewOf(Y);
    const yLocal = roundRobin(
      vy.entrants.filter((e) => e.revealedAt !== null).map((e) => ({ wallet: e.wallet, commit: e.commit, enteredAt: e.enteredAt, circuit: e.wallet === T1.wallet ? OTHER : STRONG })),
    );
    check(
      "a plain read after 00:00 resolves the day lazily: 2 standings, 1 forfeit",
      vy.phase === "resolved" && !!vy.result && vy.result.standings.length === 2 && vy.result.forfeits.length === 1 && vy.result.standings.map((s) => s.wallet).join() === yLocal.standings.map((s) => s.wallet).join(),
      JSON.stringify(vy.result).slice(0, 200),
    );
    for (const who of [T1, T2]) {
      const b = (await call<ArenaBadges>("GET", `/api/arena/badges?wallet=${who.wallet}`)).data;
      check(`two revealed fighters: both on the ${Y} podium (${who.wallet.slice(0, 4)})`, !!b && b.badges.some((x) => x.day === Y));
    }
  } finally {
    await setClock(null);
  }
} else {
  console.log("SKIP  tournament day played through (no --clock)");
}

/* The 64-entry cap and a day boundary crossed by editing the D1. */
if (SQL_CMD) {
  try {
    // With --clock: the first minutes of a fresh synthetic day; without: today, if entries are open.
    let Z: string | null = null;
    if (CLOCK) {
      Z = dayOf(Date.UTC(2041, 0, 1) + Math.floor(Math.random() * 2000) * DAY_MS);
      await setClock(dayStart(Z) + 60_000);
    } else if (v0?.phase === "entry") {
      Z = v0.day;
    }
    if (Z === null) {
      console.log("SKIP  cap test (entries closed at the real clock and no --clock)");
    } else {
      const rows: string[] = [];
      for (let i = 0; i < TOURNAMENT_MAX_ENTRIES - 1; i++) {
        rows.push(`('${Z}', 'cap-wallet-${i}', '${commitHash(STRONG, newSalt())}', '{}', ${dayStart(Z) + i})`);
      }
      runSql(`INSERT INTO arena_tournament_entries (day, wallet, "commit", seal, entered_at) VALUES ${rows.join(", ")};`);
      const last = await enter(entryBody(T5, STRONG, Z), T5.ip);
      check(`with 63 entries in the D1, an entry is the 64th`, last.status === 200 && last.data?.entries === TOURNAMENT_MAX_ENTRIES, `status ${last.status} ${JSON.stringify(last.data)}`);
      const over = await enter(entryBody(T1, STRONG, Z), "10.0.1.31");
      check("the 65th entry is refused: 409, bracket full", over.status === 409 && over.data?.entries === TOURNAMENT_MAX_ENTRIES, `status ${over.status} ${JSON.stringify(over.data)}`);

      // Move the whole bracket to a finished day: a day boundary crossed by editing rows.
      const W = shiftDay(Z, -(200 + Math.floor(Math.random() * 3000)));
      runSql(`UPDATE arena_tournament_entries SET day = '${W}' WHERE day = '${Z}';`);
      const vz = await viewOf(Z);
      const vw = await viewOf(W);
      check(`the bracket moved off ${Z}`, vz.entrants.length === 0, String(vz.entrants.length));
      check(
        `${W} resolves on read: 64 entries, nobody revealed, 64 forfeits, no standings`,
        vw.phase === "resolved" && vw.counts.entries === 64 && !!vw.result && vw.result.standings.length === 0 && vw.result.forfeits.length === 64 && vw.result.matrix.length === 0,
        JSON.stringify(vw.result).slice(0, 160),
      );
      const b5 = (await call<ArenaBadges>("GET", `/api/arena/badges?wallet=${T5.wallet}`)).data;
      check("no badge from a day nobody revealed", !!b5 && !b5.badges.some((x) => x.day === W));
    }
  } finally {
    if (CLOCK) await setClock(null);
  }
} else {
  console.log("SKIP  cap and D1-edited day boundary (no --sql-cmd)");
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
console.log("throwaway wallets", A.wallet, B.wallet);
process.exit(failed ? 1 : 0);

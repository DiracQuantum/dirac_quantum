/**
 * Qubit Arena: ranked commit-reveal bouts and exhibition sparring.
 *
 * Routes (JSON, CORS "*"), mounted by worker/index.ts through `handleArena`:
 *   GET  /api/arena                 ladder, totals, the entangling layer, the house fighter, latest bouts
 *   GET  /api/arena/me?wallet=      my rating, my queued fighter, my open bouts, my last 20 bouts
 *   POST /api/arena/spar            { circuit } -> 100 sampled shots against the house fighter (not rated)
 *   POST /api/arena/commit          { wallet, commit, seal } -> queued, or paired when someone was waiting
 *   DELETE /api/arena/queue         { wallet, commit, seal } -> the queued fighter is withdrawn (not once paired)
 *   POST /api/arena/reveal          { wallet, boutId, circuit, salt } -> the bout, resolved when both revealed
 *   GET  /api/arena/bout/:id        one bout
 *   GET  /api/arena/tournament?day= the daily tournament of a UTC day (default today): phase,
 *                                   entrants, and once resolved the standings and the matrix
 *   POST /api/arena/tournament/enter  { wallet, day?, commit, seal } -> entered (00:00..21:00 UTC)
 *   POST /api/arena/tournament/reveal { wallet, day?, circuit, salt } -> revealed (21:00..23:59 UTC)
 *   GET  /api/arena/badges?wallet=  tournament podium badges of a wallet
 *
 * Daily tournament: entries are commits sealed by the passport over
 * sha256("dirac:arena:tournament:v1:" + day + ":" + commit), one per wallet
 * and day, at most 64 a day. From 00:00 UTC of the next day the day resolves
 * (lazily on any tournament read, and from the daily cron through
 * `resolveTournaments`): a double round robin of the revealed fighters,
 * decided exactly, stored once (the INSERT OR IGNORE on the day is the
 * guard), the top three written to arena_badges. Unrevealed entries are
 * listed as forfeits.
 *
 * The physics, the canonical circuit JSON, the commit hash, the rating maths
 * and the house fighter all come from ../src/lib/arena, the same module the
 * pages use. Ranked bouts are decided by the exact probability pA = p00 + p11
 * (A wins above 0.5, B below, a draw within 1e-9); sparring samples 100
 * shots with mulberry32 seeded from sha256(dayBits + boutId), where dayBits
 * is the pet's latest collapsed day.
 *
 * Hidden information: a commit is sha256(canonical circuit + ":" + salt),
 * sealed by the wallet's registered passport (ML-DSA over
 * sha256("dirac:arena:commit:v1:" + commit)). The reveal sends the circuit
 * and the salt; a recomputed commit that differs is refused. A revealed
 * circuit is shown to nobody (the GET routes take no viewer claim) until
 * the bout is resolved; only the reveal response echoes it to its sender,
 * who evidently holds the preimage. A commit is single-use: one that is
 * queued or already in a bout is refused, so a captured commit body cannot
 * be replayed.
 *
 * Matchmaking is asynchronous: a commit joins the queue; when another wallet
 * is already waiting (and has no open bout against this one) the two are
 * paired (the older commit is A). A queued fighter can be withdrawn with a
 * seal over sha256("dirac:arena:withdraw:v1:" + commit). A side that has
 * not revealed 24 h after pairing forfeits; those forfeits are settled
 * lazily on every GET (and before a commit). MAX_UNRESOLVED counts only the
 * open bouts still waiting for the wallet's own reveal, so an opponent who
 * never reveals cannot lock a player out.
 *
 * Rate limit: 10 mutating requests (POST/DELETE) per minute per client IP,
 * counted in the shared D1 `ratelimit` table (fixed one-minute windows,
 * bucket "arena"; the tournament's two POSTs count in their own bucket,
 * "arenat", with the same limit).
 */

import { base58 } from "@scure/base";
import { verifySeal, type Passport, type QSeal } from "../src/lib/pq";
import {
  DEFAULT_DAY_BITS,
  ELO_START,
  LAYER_DESCRIPTION,
  LAYER_GATES,
  MAX_UNRESOLVED,
  REVEAL_WINDOW_MS,
  TOURNAMENT_MAX_ENTRIES,
  TOURNAMENT_PODIUM,
  canonicalCircuit,
  circuitFromJson,
  commitDocHash,
  commitHash,
  dayOf,
  eloAfter,
  houseFighter,
  isBoutId,
  isCommit,
  isDay,
  isDayBits,
  isSalt,
  newBoutId,
  parseCircuit,
  roundRobin,
  runBout,
  scoreA,
  shiftDay,
  sparSeed,
  sparTally,
  tournamentDocHash,
  tournamentPhase,
  tournamentSchedule,
  verdictOf,
  type ArenaBadge,
  type ArenaBadges,
  type ArenaBout,
  type ArenaLadder,
  type ArenaMe,
  type BoutResult,
  type CommitResponse,
  type HouseFighter,
  type MyBout,
  type Probabilities,
  type RatingRow,
  type SparResult,
  type TournamentEnterResponse,
  type TournamentEntrant,
  type TournamentFighter,
  type TournamentResult,
  type TournamentRevealResponse,
  type TournamentView,
  type WithdrawResponse,
  withdrawDocHash,
} from "../src/lib/arena";

export interface Env {
  DB: D1Database;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** A commit body carries a seal: 1952-byte key and 3309-byte signature in base64, about 7.5 KB. */
const MAX_BODY_BYTES = 16 * 1024;
interface LimitConfig {
  bucket: string;
  limit: number;
  periodMs: number;
}
const POST_LIMIT: LimitConfig = { bucket: "arena", limit: 10, periodMs: 60_000 };
/** The tournament's enter and reveal: same limit, own bucket, so a day's entry never eats the ranked quota. */
const TOURNAMENT_LIMIT: LimitConfig = { bucket: "arenat", limit: 10, periodMs: 60_000 };
/** Finished days resolved per tournament read (or cron run), oldest first. */
const PENDING_DAYS_PER_PASS = 7;
/** How far back a pass looks for unresolved days. */
const PENDING_LOOKBACK_DAYS = 14;
const MY_BADGES = 90;
/** A seal whose signed_at is further than this from the server clock, either way, is refused. */
const SEAL_MAX_SKEW_S = 60 * 60;
const LADDER_SIZE = 20;
const RECENT_BOUTS = 10;
const MY_BOUTS = 20;
const ED25519_PK_LEN = 32;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

/** Shared fixed-window counter (docs/CONTRACT-WEEK2.md). */
const SQL_RATE_LIMIT = `
INSERT INTO ratelimit (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN ratelimit.window_start = excluded.window_start THEN ratelimit.count + 1 ELSE 1 END,
  window_start = excluded.window_start
RETURNING count`;

const SQL_LATEST_DAY = `SELECT day, bits FROM pet_days ORDER BY day DESC LIMIT 1`;
const SQL_GET_PASSPORT = `SELECT bundle FROM passports WHERE wallet = ?1`;

const SQL_ENSURE_RATING = `
INSERT OR IGNORE INTO arena_ratings (wallet, elo, wins, losses, draws, updated_at)
VALUES (?1, ${ELO_START}, 0, 0, 0, ?2)`;
const SQL_GET_RATING = `SELECT wallet, elo, wins, losses, draws FROM arena_ratings WHERE wallet = ?1`;
const SQL_UPDATE_RATING = `
UPDATE arena_ratings
SET elo = ?1, wins = wins + ?2, losses = losses + ?3, draws = draws + ?4, updated_at = ?5
WHERE wallet = ?6`;
const SQL_LADDER = `
SELECT wallet, elo, wins, losses, draws FROM arena_ratings
ORDER BY elo DESC, wins DESC, wallet ASC LIMIT ${LADDER_SIZE}`;
const SQL_TOTALS = `
SELECT
  (SELECT COUNT(*) FROM arena_ratings) AS fighters,
  (SELECT COUNT(*) FROM arena_bouts) AS bouts,
  (SELECT COUNT(*) FROM arena_bouts WHERE resolved_at IS NOT NULL) AS resolved,
  (SELECT COUNT(*) FROM arena_queue) AS queued`;

/** `commit` is a reserved word in SQLite, hence the quotes. */
const SQL_GET_QUEUED = `SELECT wallet, "commit", queued_at FROM arena_queue WHERE wallet = ?1`;
/**
 * The oldest fighter of another wallet that has no open bout against this
 * one (one open bout per pair); a tie on time is broken by wallet so two
 * isolates agree.
 */
const SQL_OLDEST_OPPONENT = `
SELECT q.wallet, q."commit", q.queued_at FROM arena_queue q
WHERE q.wallet != ?1
  AND NOT EXISTS (
    SELECT 1 FROM arena_bouts b
    WHERE b.resolved_at IS NULL
      AND ((b.a_wallet = ?1 AND b.b_wallet = q.wallet) OR (b.b_wallet = ?1 AND b.a_wallet = q.wallet)))
ORDER BY q.queued_at ASC, q.wallet ASC LIMIT 1`;
/** OR IGNORE: the wallet is the primary key and the commit is unique (0008), either collision leaves 0 changes. */
const SQL_ENQUEUE = `
INSERT OR IGNORE INTO arena_queue (wallet, "commit", seal, queued_at) VALUES (?1, ?2, ?3, ?4)`;
/** Both the wallet and the commit, so a pairing that another isolate already took changes nothing. Also the withdrawal. */
const SQL_DEQUEUE = `DELETE FROM arena_queue WHERE wallet = ?1 AND "commit" = ?2`;
/** A commit that already entered a bout is spent: it must never be queued again. */
const SQL_COMMIT_USED = `SELECT 1 AS used FROM arena_bouts WHERE a_commit = ?1 OR b_commit = ?1 LIMIT 1`;

const BOUT_COLUMNS = `
id, a_wallet, b_wallet, a_commit, b_commit, a_circuit, b_circuit,
a_revealed_at, b_revealed_at, paired_at, resolved_at, p_a, result, seed`;
const SQL_INSERT_BOUT = `
INSERT INTO arena_bouts (id, a_wallet, b_wallet, a_commit, b_commit, paired_at, seed)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;
const SQL_GET_BOUT = `SELECT ${BOUT_COLUMNS} FROM arena_bouts WHERE id = ?1`;
/** Open bouts still waiting for this wallet's own reveal (an opponent's missing reveal does not count). */
const SQL_COUNT_OWED = `
SELECT COUNT(*) AS n FROM arena_bouts
WHERE resolved_at IS NULL
  AND ((a_wallet = ?1 AND a_revealed_at IS NULL) OR (b_wallet = ?1 AND b_revealed_at IS NULL))`;
const SQL_OPEN_FOR = `
SELECT ${BOUT_COLUMNS} FROM arena_bouts
WHERE resolved_at IS NULL AND (a_wallet = ?1 OR b_wallet = ?1)
ORDER BY paired_at DESC`;
const SQL_RECENT_FOR = `
SELECT ${BOUT_COLUMNS} FROM arena_bouts
WHERE resolved_at IS NOT NULL AND (a_wallet = ?1 OR b_wallet = ?1)
ORDER BY resolved_at DESC LIMIT ${MY_BOUTS}`;
const SQL_LATEST_RESOLVED = `
SELECT ${BOUT_COLUMNS} FROM arena_bouts
WHERE resolved_at IS NOT NULL
ORDER BY resolved_at DESC LIMIT ${RECENT_BOUTS}`;
const SQL_EXPIRED = `
SELECT ${BOUT_COLUMNS} FROM arena_bouts
WHERE resolved_at IS NULL AND paired_at <= ?1
ORDER BY paired_at ASC LIMIT 50`;

const SQL_REVEAL_A = `
UPDATE arena_bouts SET a_circuit = ?1, a_revealed_at = ?2
WHERE id = ?3 AND a_revealed_at IS NULL AND resolved_at IS NULL`;
const SQL_REVEAL_B = `
UPDATE arena_bouts SET b_circuit = ?1, b_revealed_at = ?2
WHERE id = ?3 AND b_revealed_at IS NULL AND resolved_at IS NULL`;
/** The `resolved_at IS NULL` guard makes exactly one isolate the resolver of a bout. */
const SQL_RESOLVE = `
UPDATE arena_bouts SET p_a = ?1, result = ?2, resolved_at = ?3
WHERE id = ?4 AND resolved_at IS NULL`;

/* --- daily tournament (migrations/0011_arena_tournament.sql) --- */

const ENTRY_COLUMNS = `day, wallet, "commit", entered_at, circuit, revealed_at`;
const SQL_T_ENTRIES = `
SELECT ${ENTRY_COLUMNS} FROM arena_tournament_entries
WHERE day = ?1 ORDER BY entered_at ASC, wallet ASC`;
const SQL_T_ENTRY = `SELECT ${ENTRY_COLUMNS} FROM arena_tournament_entries WHERE day = ?1 AND wallet = ?2`;
const SQL_T_COMMIT_USED = `SELECT day, wallet FROM arena_tournament_entries WHERE "commit" = ?1 LIMIT 1`;
const SQL_T_COUNT = `SELECT COUNT(*) AS n FROM arena_tournament_entries WHERE day = ?1`;
/**
 * The cap and the "not yet resolved" guard ride in the statement itself, so
 * two isolates can never push a day past the cap. OR IGNORE: (day, wallet)
 * is the primary key and the commit is unique; any collision changes 0 rows.
 */
const SQL_T_ENTER = `
INSERT OR IGNORE INTO arena_tournament_entries (day, wallet, "commit", seal, entered_at)
SELECT ?1, ?2, ?3, ?4, ?5
WHERE (SELECT COUNT(*) FROM arena_tournament_entries WHERE day = ?1) < ${TOURNAMENT_MAX_ENTRIES}
  AND NOT EXISTS (SELECT 1 FROM arena_tournaments WHERE day = ?1)`;
const SQL_T_REVEAL = `
UPDATE arena_tournament_entries SET circuit = ?1, revealed_at = ?2
WHERE day = ?3 AND wallet = ?4 AND revealed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM arena_tournaments WHERE day = ?3)`;
const SQL_T_GET = `SELECT day, resolved_at, standings, forfeits, matrix FROM arena_tournaments WHERE day = ?1`;
/**
 * Of the look-back days (?1, a JSON array of "YYYY-MM-DD"), those with
 * entries and no stored result. Two index probes per day, so a read costs
 * about 2 x 14 rows whatever the brackets hold (a scan of the entries would
 * read every entry of the last two weeks on every poll). An older day still
 * resolves when it is read by name.
 */
const SQL_T_PENDING = `
SELECT j.value AS day FROM json_each(?1) AS j
WHERE EXISTS (SELECT 1 FROM arena_tournament_entries e WHERE e.day = j.value)
  AND NOT EXISTS (SELECT 1 FROM arena_tournaments t WHERE t.day = j.value)
ORDER BY j.value ASC LIMIT ${PENDING_DAYS_PER_PASS}`;
/** The guard: the first result stored for a day stays; a second resolver changes nothing. */
const SQL_T_STORE = `
INSERT OR IGNORE INTO arena_tournaments (day, resolved_at, entries, revealed, standings, forfeits, matrix)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;
/** In the same batch as the result, and only when the stored result is this resolver's (same resolved_at). */
const SQL_T_BADGE = `
INSERT OR IGNORE INTO arena_badges (wallet, day, kind, place, awarded_at)
SELECT ?1, ?2, 'tournament', ?3, ?4
WHERE EXISTS (SELECT 1 FROM arena_tournaments WHERE day = ?2 AND resolved_at = ?4)`;
const SQL_BADGES_FOR = `
SELECT kind, day, place, awarded_at FROM arena_badges
WHERE wallet = ?1 ORDER BY day DESC, kind ASC LIMIT ${MY_BADGES}`;

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface BoutRow {
  id: string;
  a_wallet: string;
  b_wallet: string;
  a_commit: string;
  b_commit: string;
  a_circuit: string | null;
  b_circuit: string | null;
  a_revealed_at: number | null;
  b_revealed_at: number | null;
  paired_at: number;
  resolved_at: number | null;
  p_a: number | null;
  result: string | null;
  seed: string | null;
}

interface RatingRowDb {
  wallet: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
}

interface QueueRow {
  wallet: string;
  commit: string;
  queued_at: number;
}

interface EntryRow {
  day: string;
  wallet: string;
  commit: string;
  entered_at: number;
  circuit: string | null;
  revealed_at: number | null;
}

interface TournamentRow {
  day: string;
  resolved_at: number;
  standings: string;
  forfeits: string;
  matrix: string;
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

const badRequest = (error: string): Response => json({ error }, 400);
const notFound = (error = "not found"): Response => json({ error }, 404);
const conflict = (error: string, extra: Record<string, unknown> = {}): Response => json({ error, ...extra }, 409);

const rateLimited = (retryAt: number): Response =>
  json({ error: "rate limited", retryAt }, 429, {
    "Retry-After": String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))),
  });

/** The connecting IP, or "anon" when the header is missing (local dev). */
const clientIp = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "anon";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWallet(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    return base58.decode(value).length === ED25519_PK_LEN;
  } catch {
    return false;
  }
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

type Body = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/** Reads the body as JSON without ever buffering more than MAX_BODY_BYTES. */
async function readJson(request: Request): Promise<Body> {
  const tooLarge: Body = { ok: false, status: 413, error: `body exceeds ${MAX_BODY_BYTES} bytes` };
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return tooLarge;

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  if (total === 0) return { ok: false, status: 400, error: "empty body" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: "body is not valid JSON" };
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

type Limit = { limited: false } | { limited: true; retryAt: number };

/** Ten POSTs per minute per client. The counter fails open and logs, like the pet's. */
async function checkLimit(env: Env, key: string, config: LimitConfig = POST_LIMIT): Promise<Limit> {
  const window = Math.floor(Date.now() / config.periodMs);
  try {
    const row = await env.DB.prepare(SQL_RATE_LIMIT)
      .bind(`${config.bucket}:${key}`, window)
      .first<{ count: number }>();
    if ((row?.count ?? 0) > config.limit) return { limited: true, retryAt: (window + 1) * config.periodMs };
    return { limited: false };
  } catch (error) {
    console.warn("arena rate limiter failed", error);
    return { limited: false };
  }
}

/* ------------------------------------------------------------------ */
/* Day bits, passports, ratings                                        */
/* ------------------------------------------------------------------ */

/** The pet's latest collapsed day, or the fixed fallback when there is none yet. */
async function latestDay(env: Env): Promise<{ day: number | null; bits: string }> {
  try {
    const row = await env.DB.prepare(SQL_LATEST_DAY).first<{ day: number; bits: string }>();
    if (row && isDayBits(row.bits)) return { day: row.day, bits: row.bits };
  } catch (error) {
    console.warn("arena: pet_days unavailable", error);
  }
  return { day: null, bits: DEFAULT_DAY_BITS };
}

async function houseOfTheDay(env: Env): Promise<HouseFighter> {
  const { day, bits } = await latestDay(env);
  return { circuit: houseFighter(bits), dayBits: bits, day };
}

async function registeredPassport(env: Env, wallet: string): Promise<Passport | null> {
  const row = await env.DB.prepare(SQL_GET_PASSPORT).bind(wallet).first<{ bundle: string }>();
  if (!row) return null;
  try {
    const p: unknown = JSON.parse(row.bundle);
    return isRecord(p) && typeof p.dsa_pk === "string" && p.wallet === wallet ? (p as unknown as Passport) : null;
  } catch {
    return null;
  }
}

function ratingOf(row: RatingRowDb | null, wallet: string): RatingRow {
  if (!row) return { wallet, elo: ELO_START, wins: 0, losses: 0, draws: 0, bouts: 0 };
  return {
    wallet: row.wallet,
    elo: row.elo,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    bouts: row.wins + row.losses + row.draws,
  };
}

async function readRating(env: Env, wallet: string): Promise<RatingRow> {
  return ratingOf(await env.DB.prepare(SQL_GET_RATING).bind(wallet).first<RatingRowDb>(), wallet);
}

/* ------------------------------------------------------------------ */
/* Bouts                                                               */
/* ------------------------------------------------------------------ */

const isResult = (v: unknown): v is BoutResult =>
  v === "a" || v === "b" || v === "draw" || v === "a_forfeit" || v === "b_forfeit";

/**
 * The JSON view of a bout. Circuits are public once the bout is resolved;
 * before that only `revealer`'s own circuit is included, and `revealer` is
 * set solely by the reveal handler, for the wallet that just sent that very
 * circuit and salt. The GET routes pass null: a `?wallet=` query is a claim,
 * not a proof, and must not open a revealed circuit to the opponent.
 */
function boutView(row: BoutRow, revealer: string | null): ArenaBout {
  const resolved = row.resolved_at !== null;
  const a = circuitFromJson(row.a_circuit);
  const b = circuitFromJson(row.b_circuit);
  const showA = resolved || (revealer !== null && revealer === row.a_wallet);
  const showB = resolved || (revealer !== null && revealer === row.b_wallet);
  const aCircuit = showA ? a : null;
  const bCircuit = showB ? b : null;
  let probs: Probabilities | null = null;
  if (resolved && a && b) probs = runBout(a, b);
  return {
    id: row.id,
    a: row.a_wallet,
    b: row.b_wallet,
    aCommit: row.a_commit,
    bCommit: row.b_commit,
    aCircuit,
    bCircuit,
    aRevealedAt: row.a_revealed_at,
    bRevealedAt: row.b_revealed_at,
    pairedAt: row.paired_at,
    revealBy: row.paired_at + REVEAL_WINDOW_MS,
    resolvedAt: row.resolved_at,
    pA: row.p_a,
    result: isResult(row.result) ? row.result : null,
    seed: row.seed,
    probs,
  };
}

/** One wallet's side of an open bout: flags only, no circuit (the wallet is unverified here). */
function myBoutView(row: BoutRow, wallet: string): MyBout {
  const role = row.a_wallet === wallet ? "a" : "b";
  const revealed = role === "a" ? row.a_revealed_at !== null : row.b_revealed_at !== null;
  const opponentRevealed = role === "a" ? row.b_revealed_at !== null : row.a_revealed_at !== null;
  return {
    ...boutView(row, null),
    role,
    revealed,
    opponentRevealed,
    mustReveal: row.resolved_at === null && !revealed,
  };
}

async function readBout(env: Env, id: string): Promise<BoutRow | null> {
  return env.DB.prepare(SQL_GET_BOUT).bind(id).first<BoutRow>();
}

/**
 * Writes the outcome of a bout and, when this isolate won the race to do
 * so, moves both ratings. `pA` is null for forfeits and void bouts; a null
 * score (double no-show) leaves the ratings alone.
 */
async function resolveBout(env: Env, row: BoutRow, pA: number | null, result: BoutResult, now: number): Promise<void> {
  const resolved = await env.DB.prepare(SQL_RESOLVE).bind(pA, result, now, row.id).run();
  if ((resolved.meta.changes ?? 0) === 0) return;
  const score = result === "draw" && pA === null ? null : scoreA(result);
  if (score === null) return;

  await env.DB.batch([
    env.DB.prepare(SQL_ENSURE_RATING).bind(row.a_wallet, now),
    env.DB.prepare(SQL_ENSURE_RATING).bind(row.b_wallet, now),
  ]);
  const [ra, rb] = await Promise.all([readRating(env, row.a_wallet), readRating(env, row.b_wallet)]);
  const next = eloAfter(ra.elo, rb.elo, score);
  const aWin = score === 1 ? 1 : 0;
  const bWin = score === 0 ? 1 : 0;
  const draw = score === 0.5 ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare(SQL_UPDATE_RATING).bind(next.a, aWin, bWin, draw, now, row.a_wallet),
    env.DB.prepare(SQL_UPDATE_RATING).bind(next.b, bWin, aWin, draw, now, row.b_wallet),
  ]);
}

/** Both circuits are in: the exact rule decides. */
async function resolveRevealed(env: Env, row: BoutRow, now: number): Promise<void> {
  const a = circuitFromJson(row.a_circuit);
  const b = circuitFromJson(row.b_circuit);
  if (!a || !b) return;
  const { pA } = runBout(a, b);
  await resolveBout(env, row, pA, verdictOf(pA), now);
}

/**
 * Settles every bout whose reveal window closed: the side that revealed
 * wins by forfeit; a bout nobody revealed is void (recorded as a draw with
 * no pA and no rating change); one that somehow has both circuits is
 * resolved exactly. Runs lazily before reads and commits.
 */
async function settleForfeits(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(SQL_EXPIRED).bind(now - REVEAL_WINDOW_MS).all<BoutRow>();
  for (const row of results) {
    const aIn = row.a_revealed_at !== null;
    const bIn = row.b_revealed_at !== null;
    if (aIn && bIn) await resolveRevealed(env, row, now);
    else if (aIn) await resolveBout(env, row, null, "b_forfeit", now);
    else if (bIn) await resolveBout(env, row, null, "a_forfeit", now);
    else await resolveBout(env, row, null, "draw", now);
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function getArena(env: Env): Promise<Response> {
  const now = Date.now();
  await settleForfeits(env, now);
  const [ladderRes, totalsRes, recentRes] = await env.DB.batch([
    env.DB.prepare(SQL_LADDER),
    env.DB.prepare(SQL_TOTALS),
    env.DB.prepare(SQL_LATEST_RESOLVED),
  ]);
  const totalsRow = (totalsRes.results as { fighters: number; bouts: number; resolved: number; queued: number }[])[0];
  const body: ArenaLadder = {
    ladder: (ladderRes.results as RatingRowDb[]).map((r) => ratingOf(r, r.wallet)),
    totals: totalsRow ?? { fighters: 0, bouts: 0, resolved: 0, queued: 0 },
    layer: { description: LAYER_DESCRIPTION, gates: [...LAYER_GATES] },
    house: await houseOfTheDay(env),
    recent: (recentRes.results as BoutRow[]).map((r) => boutView(r, null)),
  };
  return json(body);
}

async function getMe(env: Env, url: URL): Promise<Response> {
  const wallet = url.searchParams.get("wallet")?.trim() ?? "";
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  const now = Date.now();
  await settleForfeits(env, now);
  const [ratingRes, queueRes, openRes, recentRes] = await env.DB.batch([
    env.DB.prepare(SQL_GET_RATING).bind(wallet),
    env.DB.prepare(SQL_GET_QUEUED).bind(wallet),
    env.DB.prepare(SQL_OPEN_FOR).bind(wallet),
    env.DB.prepare(SQL_RECENT_FOR).bind(wallet),
  ]);
  const queued = (queueRes.results as QueueRow[])[0];
  const body: ArenaMe = {
    wallet,
    rating: ratingOf((ratingRes.results as RatingRowDb[])[0] ?? null, wallet),
    queued: queued ? { commit: queued.commit, queuedAt: queued.queued_at } : null,
    unresolved: (openRes.results as BoutRow[]).map((r) => myBoutView(r, wallet)),
    recent: (recentRes.results as BoutRow[]).map((r) => boutView(r, null)),
  };
  return json(body);
}

async function spar(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");
  const parsed = parseCircuit(body.value.circuit);
  if (!parsed.ok) return badRequest(`circuit: ${parsed.error}`);

  const limit = await checkLimit(env, clientIp(request));
  if (limit.limited) return rateLimited(limit.retryAt);

  const house = await houseOfTheDay(env);
  const player = parsed.value;
  const probs = runBout(player, house.circuit);
  const boutId = newBoutId();
  const result: SparResult = {
    boutId,
    pA: probs.pA,
    verdict: verdictOf(probs.pA),
    probs,
    shots: sparTally(probs, house.dayBits, boutId),
    player,
    house,
    seed: sparSeed(house.dayBits, boutId),
    rated: false,
  };
  return json(result);
}

/**
 * Structural and cryptographic check of a seal against the registered
 * passport: it must cover `docHash` (the commit or the withdraw message of
 * `subject`) and be dated within SEAL_MAX_SKEW_S of the server clock.
 */
function sealMatches(seal: unknown, wallet: string, docHash: string, subject: string, passport: Passport, now: number): string | null {
  if (!isRecord(seal)) return "seal must be an object";
  const s = seal as unknown as QSeal;
  const check = verifySeal(s);
  if (!check.ok) return `seal: ${check.reason ?? "invalid"}`;
  if (s.passport !== wallet) return "seal was made by another passport";
  if (s.dsa_pk !== passport.dsa_pk) return "seal key does not match the registered passport";
  if (s.doc_hash !== docHash) return `seal does not cover this ${subject}`;
  const age = Math.floor(now / 1000) - s.signed_at;
  if (age > SEAL_MAX_SKEW_S) return "seal is too old: signed more than 1 h before server time";
  if (-age > SEAL_MAX_SKEW_S) return "seal is dated in the future: signed more than 1 h after server time, check the clock";
  return null;
}

async function commit(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");
  const { wallet, commit: commitHex, seal } = body.value;
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  if (!isCommit(commitHex)) return badRequest("commit must be a hex sha256 digest (64 chars)");

  const limit = await checkLimit(env, clientIp(request));
  if (limit.limited) return rateLimited(limit.retryAt);

  const now = Date.now();
  const passport = await registeredPassport(env, wallet);
  if (!passport) return json({ error: "ranked bouts need a registered passport" }, 403);
  const sealError = sealMatches(seal, wallet, commitDocHash(commitHex), "commit", passport, now);
  if (sealError) return badRequest(sealError);

  await settleForfeits(env, now);
  const [queuedRes, owedRes, usedRes] = await env.DB.batch([
    env.DB.prepare(SQL_GET_QUEUED).bind(wallet),
    env.DB.prepare(SQL_COUNT_OWED).bind(wallet),
    env.DB.prepare(SQL_COMMIT_USED).bind(commitHex),
  ]);
  const mine = (queuedRes.results as QueueRow[])[0];
  if (mine) return conflict("a fighter of this wallet is already queued", { commit: mine.commit, queuedAt: mine.queued_at });
  // A commit is single-use: once it has been in a bout its circuit becomes
  // public, so queueing it again would hand the next opponent a known hand.
  if (usedRes.results.length > 0) return conflict("this commit has already fought; commit a fresh salt", { commit: commitHex });
  const open = (owedRes.results as { n: number }[])[0]?.n ?? 0;
  if (open >= MAX_UNRESOLVED) return conflict(`${MAX_UNRESOLVED} bouts are waiting for your reveal, reveal first`, { open });

  await env.DB.prepare(SQL_ENSURE_RATING).bind(wallet, now).run();

  // Pair with the oldest waiting fighter of another wallet that has no open
  // bout against this one. The dequeue is guarded by wallet and commit: if
  // another isolate paired that fighter meanwhile, nothing changes here and
  // this fighter waits instead.
  const opponent = await env.DB.prepare(SQL_OLDEST_OPPONENT).bind(wallet).first<QueueRow>();
  if (opponent) {
    const taken = await env.DB.prepare(SQL_DEQUEUE).bind(opponent.wallet, opponent.commit).run();
    if ((taken.meta.changes ?? 0) > 0) {
      const boutId = newBoutId();
      const { bits } = await latestDay(env);
      await env.DB.prepare(SQL_INSERT_BOUT)
        .bind(boutId, opponent.wallet, wallet, opponent.commit, commitHex, now, sparSeed(bits, boutId))
        .run();
      const paired: CommitResponse = { queued: false, boutId, role: "b" };
      return json(paired);
    }
  }

  const queued = await env.DB.prepare(SQL_ENQUEUE).bind(wallet, commitHex, JSON.stringify(seal), now).run();
  if ((queued.meta.changes ?? 0) === 0) return conflict("a fighter of this wallet, or this commit, is already queued");
  const response: CommitResponse = { queued: true };
  return json(response);
}

/**
 * Takes a queued fighter back. The seal covers the withdraw message of the
 * commit, so only the passport that queued it can withdraw it. Once paired
 * the row is gone from the queue and the bout stands: 404.
 */
async function withdraw(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");
  const { wallet, commit: commitHex, seal } = body.value;
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  if (!isCommit(commitHex)) return badRequest("commit must be a hex sha256 digest (64 chars)");

  const limit = await checkLimit(env, clientIp(request));
  if (limit.limited) return rateLimited(limit.retryAt);

  const now = Date.now();
  const passport = await registeredPassport(env, wallet);
  if (!passport) return json({ error: "ranked bouts need a registered passport" }, 403);
  const sealError = sealMatches(seal, wallet, withdrawDocHash(commitHex), "withdrawal", passport, now);
  if (sealError) return badRequest(sealError);

  const gone = await env.DB.prepare(SQL_DEQUEUE).bind(wallet, commitHex).run();
  if ((gone.meta.changes ?? 0) === 0) return notFound("no fighter with this commit is queued (it may just have been paired)");
  const response: WithdrawResponse = { withdrawn: true, commit: commitHex };
  return json(response);
}

async function reveal(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");
  const { wallet, boutId, circuit, salt } = body.value;
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  if (!isBoutId(boutId)) return badRequest("boutId must be 16 hex characters");
  if (!isSalt(salt)) return badRequest("salt must be 32 hex characters");
  const parsed = parseCircuit(circuit);
  if (!parsed.ok) return badRequest(`circuit: ${parsed.error}`);

  const limit = await checkLimit(env, clientIp(request));
  if (limit.limited) return rateLimited(limit.retryAt);

  const now = Date.now();
  await settleForfeits(env, now);
  let row = await readBout(env, boutId);
  if (!row) return notFound("no such bout");
  const role = row.a_wallet === wallet ? "a" : row.b_wallet === wallet ? "b" : null;
  if (!role) return json({ error: "this wallet is not in the bout" }, 403);
  if (row.resolved_at !== null) return conflict("the bout is already resolved", { bout: boutView(row, wallet) });

  const expected = role === "a" ? row.a_commit : row.b_commit;
  if (commitHash(parsed.value, salt) !== expected) return badRequest("circuit and salt do not match the commit");
  const stored = canonicalCircuit(parsed.value);
  const already = role === "a" ? row.a_circuit : row.b_circuit;
  if (already === null) {
    await env.DB.prepare(role === "a" ? SQL_REVEAL_A : SQL_REVEAL_B).bind(stored, now, boutId).run();
    row = (await readBout(env, boutId)) ?? row;
  }
  if (row.a_revealed_at !== null && row.b_revealed_at !== null && row.resolved_at === null) {
    await resolveRevealed(env, row, now);
    row = (await readBout(env, boutId)) ?? row;
  }
  return json(boutView(row, wallet));
}

/** One bout for anyone; circuits only once resolved (no viewer claim is honoured). */
async function getBout(env: Env, id: string): Promise<Response> {
  if (!isBoutId(id)) return badRequest("bout id must be 16 hex characters");
  const now = Date.now();
  await settleForfeits(env, now);
  const row = await readBout(env, id);
  if (!row) return notFound("no such bout");
  return json(boutView(row, null));
}

/* ------------------------------------------------------------------ */
/* Daily tournament                                                    */
/* ------------------------------------------------------------------ */

const entrantOf = (r: EntryRow): TournamentEntrant => ({
  wallet: r.wallet,
  commit: r.commit,
  enteredAt: r.entered_at,
  revealedAt: r.revealed_at,
});

/**
 * Resolves one finished day: the revealed fighters play the double round
 * robin, unrevealed entries become forfeits, the result is stored once (the
 * INSERT OR IGNORE on the day is the guard) and, when at least two fighters
 * revealed, the top three get their badge rows in the same batch. True when
 * this call stored the result; false before 00:00 UTC of the next day, for
 * a day nobody entered, and when another resolver was first.
 */
async function resolveDay(env: Env, day: string, now: number): Promise<boolean> {
  if (now < tournamentSchedule(day).resolvesAt) return false;
  const { results } = await env.DB.prepare(SQL_T_ENTRIES).bind(day).all<EntryRow>();
  if (results.length === 0) return false;
  const fighters: TournamentFighter[] = [];
  const forfeits: TournamentEntrant[] = [];
  for (const r of results) {
    const circuit = r.revealed_at !== null ? circuitFromJson(r.circuit) : null;
    if (circuit) fighters.push({ wallet: r.wallet, commit: r.commit, enteredAt: r.entered_at, circuit });
    else forfeits.push(entrantOf(r));
  }
  const { standings, matrix } = roundRobin(fighters);
  const statements = [
    env.DB.prepare(SQL_T_STORE).bind(
      day,
      now,
      results.length,
      fighters.length,
      JSON.stringify(standings),
      JSON.stringify(forfeits),
      JSON.stringify(matrix),
    ),
  ];
  if (standings.length >= 2) {
    for (const s of standings.slice(0, TOURNAMENT_PODIUM)) {
      statements.push(env.DB.prepare(SQL_T_BADGE).bind(s.wallet, day, s.place, now));
    }
  }
  const [stored] = await env.DB.batch(statements);
  return (stored.meta.changes ?? 0) > 0;
}

/** Every finished day with entries and no stored result, oldest first, a few per pass. Throws on a D1 failure. */
async function resolvePending(env: Env, now: number): Promise<string[]> {
  const today = dayOf(now);
  const lookback: string[] = [];
  for (let k = PENDING_LOOKBACK_DAYS; k >= 1; k--) lookback.push(shiftDay(today, -k));
  const { results } = await env.DB.prepare(SQL_T_PENDING).bind(JSON.stringify(lookback)).all<{ day: string }>();
  const resolved: string[] = [];
  for (const { day } of results) {
    if (isDay(day) && (await resolveDay(env, day, now))) resolved.push(day);
  }
  return resolved;
}

/**
 * The cron entry point (worker/index.ts `scheduled`, 00:00 UTC):
 *   ctx.waitUntil(resolveTournaments(env));
 * Resolves the finished days that have entries and no result yet. Every
 * tournament read does the same lazily, so a missed cron run costs nothing.
 * Never throws: a failure is logged and the next read or run tries again.
 */
export async function resolveTournaments(env: Env, now: number = Date.now()): Promise<{ resolved: string[] }> {
  try {
    return { resolved: await resolvePending(env, now) };
  } catch (error) {
    console.error("arena: tournament resolution failed", error);
    return { resolved: [] };
  }
}

function parseResult(row: TournamentRow): TournamentResult | null {
  try {
    return {
      resolvedAt: row.resolved_at,
      standings: JSON.parse(row.standings),
      forfeits: JSON.parse(row.forfeits),
      matrix: JSON.parse(row.matrix),
    };
  } catch (error) {
    console.error("arena: stored tournament result is unreadable", row.day, error);
    return null;
  }
}

async function readTournament(env: Env, day: string, now: number): Promise<TournamentView> {
  const [entriesRes, rowRes] = await env.DB.batch([
    env.DB.prepare(SQL_T_ENTRIES).bind(day),
    env.DB.prepare(SQL_T_GET).bind(day),
  ]);
  const entries = entriesRes.results as EntryRow[];
  const row = (rowRes.results as TournamentRow[])[0];
  return {
    day,
    phase: tournamentPhase(day, now),
    now,
    schedule: tournamentSchedule(day),
    maxEntries: TOURNAMENT_MAX_ENTRIES,
    counts: { entries: entries.length, revealed: entries.filter((r) => r.revealed_at !== null).length },
    entrants: entries.map(entrantOf),
    result: row ? parseResult(row) : null,
  };
}

/** One day's tournament as anyone sees it; circuits only in the stored result. Resolves finished days first. */
async function getTournament(env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  const raw = url.searchParams.get("day")?.trim() ?? "";
  const day = raw === "" ? dayOf(now) : raw;
  if (!isDay(day)) return badRequest("day must be a UTC date, YYYY-MM-DD");
  // Resolution is a side job of the read: a failure is logged and the view is served anyway (result null, "resolving").
  await resolveTournaments(env, now);
  let view = await readTournament(env, day, now);
  // A finished day the pass did not reach (older than the look-back, or more than PENDING_DAYS_PER_PASS waiting).
  if (view.result === null && view.entrants.length > 0 && now >= view.schedule.resolvesAt) {
    try {
      await resolveDay(env, day, now);
      view = await readTournament(env, day, now);
    } catch (error) {
      console.error("arena: tournament resolution failed", day, error);
    }
  }
  return json(view);
}

async function enterTournament(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");
  const { wallet, day: dayField, commit: commitHex, seal } = body.value;
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  if (!isCommit(commitHex)) return badRequest("commit must be a hex sha256 digest (64 chars)");
  if (dayField !== undefined && !isDay(dayField)) return badRequest("day must be a UTC date, YYYY-MM-DD");

  const limit = await checkLimit(env, clientIp(request), TOURNAMENT_LIMIT);
  if (limit.limited) return rateLimited(limit.retryAt);

  const now = Date.now();
  const today = dayOf(now);
  if (dayField !== undefined && dayField !== today) return conflict(`entries are open for ${today} only`, { day: today });
  if (tournamentPhase(today, now) !== "entry") {
    return conflict(`entries for ${today} closed at 21:00 UTC; the next day opens at 00:00 UTC`, {
      day: today,
      opensAt: tournamentSchedule(today).resolvesAt,
    });
  }
  const passport = await registeredPassport(env, wallet);
  if (!passport) return json({ error: "the tournament needs a registered passport" }, 403);
  const sealError = sealMatches(seal, wallet, tournamentDocHash(today, commitHex), "tournament entry", passport, now);
  if (sealError) return badRequest(sealError);

  const [mineRes, usedRes, countRes] = await env.DB.batch([
    env.DB.prepare(SQL_T_ENTRY).bind(today, wallet),
    env.DB.prepare(SQL_T_COMMIT_USED).bind(commitHex),
    env.DB.prepare(SQL_T_COUNT).bind(today),
  ]);
  const mine = (mineRes.results as EntryRow[])[0];
  if (mine) return conflict(`this wallet already entered ${today}`, { commit: mine.commit, enteredAt: mine.entered_at });
  if (usedRes.results.length > 0) return conflict("this commit was already entered; commit a fresh salt", { commit: commitHex });
  const count = (countRes.results as { n: number }[])[0]?.n ?? 0;
  if (count >= TOURNAMENT_MAX_ENTRIES) {
    return conflict(`the bracket for ${today} is full: ${TOURNAMENT_MAX_ENTRIES} entries`, { entries: count });
  }

  const inserted = await env.DB.prepare(SQL_T_ENTER).bind(today, wallet, commitHex, JSON.stringify(seal), now).run();
  if ((inserted.meta.changes ?? 0) === 0) {
    // Another isolate took the last place, this wallet's entry or this commit in between.
    return conflict(`the entry was refused: the bracket for ${today} filled up, or this wallet or commit is already in`);
  }
  const after = await env.DB.prepare(SQL_T_COUNT).bind(today).first<{ n: number }>();
  const response: TournamentEnterResponse = { entered: true, day: today, commit: commitHex, enteredAt: now, entries: after?.n ?? count + 1 };
  return json(response);
}

async function revealTournament(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");
  const { wallet, day: dayField, circuit, salt } = body.value;
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  if (dayField !== undefined && !isDay(dayField)) return badRequest("day must be a UTC date, YYYY-MM-DD");
  if (!isSalt(salt)) return badRequest("salt must be 32 hex characters");
  const parsed = parseCircuit(circuit);
  if (!parsed.ok) return badRequest(`circuit: ${parsed.error}`);

  const limit = await checkLimit(env, clientIp(request), TOURNAMENT_LIMIT);
  if (limit.limited) return rateLimited(limit.retryAt);

  const now = Date.now();
  const day = dayField ?? dayOf(now);
  const schedule = tournamentSchedule(day);
  const phase = tournamentPhase(day, now);
  if (phase === "upcoming" || phase === "entry") {
    return conflict(`reveals for ${day} open at 21:00 UTC`, { revealOpensAt: schedule.entryClosesAt });
  }
  if (phase !== "reveal") return conflict(`the reveal window for ${day} closed at 23:59 UTC`, { revealClosedAt: schedule.revealClosesAt });

  const entry = await env.DB.prepare(SQL_T_ENTRY).bind(day, wallet).first<EntryRow>();
  if (!entry) return notFound(`this wallet has no entry for ${day}`);
  if (commitHash(parsed.value, salt) !== entry.commit) return badRequest("circuit and salt do not match the commit");

  let revealedAt = entry.revealed_at;
  if (revealedAt === null) {
    const res = await env.DB.prepare(SQL_T_REVEAL).bind(canonicalCircuit(parsed.value), now, day, wallet).run();
    if ((res.meta.changes ?? 0) > 0) {
      revealedAt = now;
    } else {
      const again = await env.DB.prepare(SQL_T_ENTRY).bind(day, wallet).first<EntryRow>();
      if (!again || again.revealed_at === null) return conflict(`the reveal window for ${day} closed`);
      revealedAt = again.revealed_at;
    }
  }
  const response: TournamentRevealResponse = { revealed: true, day, wallet, commit: entry.commit, circuit: parsed.value, revealedAt };
  return json(response);
}

async function getBadges(env: Env, url: URL): Promise<Response> {
  const wallet = url.searchParams.get("wallet")?.trim() ?? "";
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  const { results } = await env.DB.prepare(SQL_BADGES_FOR)
    .bind(wallet)
    .all<{ kind: string; day: string; place: number; awarded_at: number }>();
  const badges: ArenaBadge[] = results
    .filter((r) => r.kind === "tournament")
    .map((r) => ({ kind: "tournament", day: r.day, place: r.place, awardedAt: r.awarded_at }));
  const body: ArenaBadges = { wallet, badges };
  return json(body);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * Serves /api/arena, /api/arena/me, /api/arena/spar, /api/arena/commit,
 * /api/arena/queue (DELETE), /api/arena/reveal, /api/arena/bout/:id,
 * /api/arena/tournament (GET), /api/arena/tournament/enter and /reveal
 * (POST) and /api/arena/badges; null for any other path. `parts` is
 * `url.pathname.split("/").filter(Boolean)`.
 */
export async function handleArena(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  parts: string[],
  url: URL,
): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "arena" || parts.length > 4) return null;
  const sub = parts[2];
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    if (parts.length === 2 && method === "GET") return await getArena(env);
    if (parts.length === 3) {
      if (sub === "me" && method === "GET") return await getMe(env, url);
      if (sub === "spar" && method === "POST") return await spar(request, env);
      if (sub === "commit" && method === "POST") return await commit(request, env);
      if (sub === "queue" && method === "DELETE") return await withdraw(request, env);
      if (sub === "reveal" && method === "POST") return await reveal(request, env);
      if (sub === "tournament" && method === "GET") return await getTournament(env, url);
      if (sub === "badges" && method === "GET") return await getBadges(env, url);
    }
    if (parts.length === 4 && sub === "bout" && method === "GET") {
      const id = decodeSegment(parts[3]);
      if (id === null) return badRequest("malformed path");
      return await getBout(env, id);
    }
    if (parts.length === 4 && sub === "tournament" && method === "POST") {
      if (parts[3] === "enter") return await enterTournament(request, env);
      if (parts[3] === "reveal") return await revealTournament(request, env);
    }
  } catch (error) {
    console.error("arena api error", method, url.pathname, error);
    return json({ error: "internal error" }, 500);
  }
  return null;
}

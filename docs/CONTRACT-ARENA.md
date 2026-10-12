# Arena contract: Qubit Arena v1 (Bell Battles)

Builds on docs/CONTRACT.md (stack facts, lint rules, design classes, pq.ts API) and docs/CONTRACT-WEEK2.md (module mounting, JSON/CORS conventions, the shared D1 `ratelimit` table). The Worker module is `worker/arena.ts`, the physics is `src/lib/arena.ts` (pure, imported by the Worker, the pages and the node self-test), the browser client is `src/lib/arenaApi.ts`, the page is `/arena`.

## Rules

- Register |q0 q1⟩. Player A owns q0, player B owns q1. A fighter is a circuit on its own qubit: up to 3 `pre` gates and up to 2 `post` gates from {H, X, Z, RY(theta)}, theta in degrees, -180..180 in 5-degree steps.
- Between pre and post runs a fixed public entangling layer: H on q0, then CNOT(q0 → q1), then RY(60°) on q1. Then both qubits are measured in the computational basis.
- Parity 0 outcomes (00, 11) are A's, parity 1 (01, 10) are B's. `pA = p00 + p11`.
- Ranked: exact. A wins if `pA > 0.5 + 1e-9`, B wins if `pA < 0.5 - 1e-9`, otherwise a draw. No sampling.
- Sparring (exhibition): 100 shots drawn with mulberry32 seeded by the first 4 bytes (big-endian) of `sha256(dayBits + boutId)`, where `dayBits` is the latest `pet_days.bits` (fallback `"0000000000"`). Reports shots won per side and the full exact table. Not rated, no passport.
- Hidden information (ranked only): `canonical = JSON.stringify({ v: 1, pre: [...], post: [...] })` with gates `{ g }` or `{ g: "RY", t }` in that key order, no whitespace. `commit = sha256hex(canonical + ":" + salt)`, `salt` = 16 random bytes as 32 hex chars, drawn in the browser. The passport seals `docHash = sha256hex("dirac:arena:commit:v1:" + commit)` with `createSeal` (ML-DSA-65); the seal carries `passport` (the wallet) and `dsa_pk`. Reveal = circuit + salt; the Worker recomputes the commit and refuses a mismatch. A revealed circuit is disclosed to nobody until the bout is resolved: the GET routes honour no viewer claim (a `?wallet=` query is not a proof), only the reveal response echoes the sender's own circuit.
- A commit is single-use: a commit that is queued or has ever entered a bout (`a_commit`/`b_commit`) is refused with 409, so a captured commit body cannot be replayed once its circuit is public.
- Matchmaking is asynchronous. A commit joins `arena_queue`; if another wallet is already waiting and has no open bout against this one (one open bout per pair), the two are paired at once: the older commit is A, the new one is B. A wallet has at most one queued fighter, which it can withdraw until it is paired (`DELETE /api/arena/queue` with a seal over `sha256hex("dirac:arena:withdraw:v1:" + commit)`), and at most 5 open bouts still waiting for its own reveal (an opponent who has not revealed does not count, so a stalling opponent cannot lock a player out). Ranked needs a passport registered under that wallet (`passports` table); the seal's `dsa_pk` must match it and its `signed_at` must be within 1 h of server time either way (a seal from the future is refused with its own message). `POST /api/passports` is limited to 10 registrations a minute per client IP.
- Reveal window: 24 h from `pairedAt`. Past it, any `GET /api/arena`, `GET /api/arena/me`, `GET /api/arena/bout/:id` (and a later commit) settles the bout: the side that revealed wins by forfeit (`b_forfeit` = B did not reveal, A wins); if nobody revealed the bout is void (`result = "draw"`, `pA = null`, no rating change; the views print "void · nobody revealed").
- Rating: ELO, K = 32, start 1200, draw = 0.5. A forfeit counts as a win/loss. Ratings are only touched by the isolate that resolved the bout (the `resolved_at IS NULL` guard on the resolve statement), so a double resolution cannot double-count.

## Daily tournament (SPEC 3.7, "ежедневный турнир")

- One tournament per UTC day D, written `"YYYY-MM-DD"`. Asynchronous, no brackets to wait on: everyone who reveals meets everyone else.
- Entry, 00:00 to 21:00 UTC of D: a commit with the ranked scheme (`commit = sha256hex(canonical + ":" + salt)`), sealed by the registered passport over `tournamentDocHash(D, commit) = sha256hex("dirac:arena:tournament:v1:" + D + ":" + commit)`. The seal binds the day, so an entry body cannot be replayed on another day. Same passport and 1 h skew rules as ranked. One entry per wallet per day, at most 64 entries a day (the 65th is refused; the cap is enforced inside the INSERT, so two isolates cannot overshoot), and a commit is single-use across all days.
- Reveal, 21:00 to 23:59 UTC of D: circuit + salt, from the browser that entered (it alone holds them, `arenaStore`). No seal needed: the preimage is the proof. Idempotent. Before 21:00 and from 23:59 the reveal is refused (409). The minute 23:59 to 00:00 takes no reveal, so a reveal can never race the resolution.
- Resolution, from 00:00 UTC of D+1: every revealed fighter plays every other twice, once as A and once as B, each game decided by the exact ranked rule (`verdictOf`, draw within 1e-9). Win 1, draw 0.5, loss 0. Ranking: points, then the summed margin (own share minus 0.5 in every game: `pA − 0.5` as A, `0.5 − pA` as B, i.e. `+|pA − 0.5|` per win and `−|pA − 0.5|` per loss; compared on a 1e-9 grid), then the earlier entry (`entered_at`), then the wallet (only to make the order total). Places are unique. Unrevealed entries are listed as forfeits: not played, no points, no badge.
- The result is computed once and stored (`INSERT OR IGNORE` on the day: the first resolver wins, a second changes nothing), circuits included. It runs lazily on any `GET /api/arena/tournament` (every finished day of the last 14 with entries and no result, oldest first, 7 per read, plus the requested day itself however old) and from the daily cron through the exported `resolveTournaments(env)`. The look-back is two index probes per day (`json_each` over the 14 dates), not a scan of the entries, so a poll reads about 28 rows plus the requested day. A failed resolution is logged and the read is still served (`result: null`, "resolving"). The games run on prepared gates in reused buffers (`roundRobin`), bitwise equal to `runBout` and several times faster: a 64-entry day (4,032 games) costs a few ms of CPU.
- Badges: when at least two fighters revealed, places 1 to 3 get a row in `arena_badges` (kind `tournament`), written in the same D1 batch as the result and only when the stored result is this resolver's (same `resolved_at`). No stakes, no pools.
- Rate limit: enter and reveal count 10 per minute per client IP in their own D1 bucket, `arenat`.

## Challenges (client only)

- Puzzles checked in the browser with the same simulator (`runBout`), nothing sent to the server. `checkChallenge(ch, circuit)` runs the circuit on its side (`role`) against `ch.opponent`; tolerances are the ranked ones: "at least x" passes at `x − 1e-9`, "exactly x" within 1e-9, "impossible" below 1e-9.
- Eight kinds: `floor` (at least x on one outcome), `window` (pA in [x, x + 0.10]), `exact` (pA = 0.5, a dead heat), `beat` (pA at least x), `hold` (play B, keep pA at or under x), `forbid` (one outcome impossible, optionally with a pA floor), `single` (beat it with one gate), `split` (both |00⟩ and |11⟩ at least x).
- Daily: `dailyChallenge(dayBits, petDay)` from the pet's latest collapsed bits (the same `pet_days` row `GET /api/arena` reports as `house.dayBits`/`house.day`, which is what `/api/pet` shows as the latest day). `rng = mulberry32(seedToUint32(sha256Hex("dirac:arena:challenge:v1:" + bits)))` draws, in this order: the opponent (house fighter, empty circuit, or the rival `rivalFighter(bits)`, the house derivation with prefix `dirac:arena:rival:v1:`), the order in which the eight kinds are tried (Fisher-Yates), the outcome for floor/forbid, the window pick. The first kind that is solvable against that opponent and not already solved by the empty circuit wins. Thresholds sit at least 0.02 inside the best reachable value (under the maximum for floor, beat, single, split and the forbid floor; over the minimum for hold), on a 0.05 grid; a window holds a reachable pA at least 0.01 inside both edges; so every daily challenge is solvable. The id is `daily:<pet day>:<bits>`.
- Solvability is exact, not sampled: every gate is a real orthogonal matrix (H = RY(90)·Z, X = RY(180)·Z), so one side can only reach the distributions of pre `[RY t]` with post `[RY u]` or `[Z, RY u]` over the 72 angles distinct up to sign (`searchFamily()`, 10,368 circuits; `singleGateFamily()`, 151, for the one-gate kind). The self-test checks the claim against random full circuits.
- Lessons (permanent, against the empty circuit, as A): `lesson:certain` pA = 1, `lesson:zero` pA = 0, `lesson:draw` pA = 0.5, with a hint (with pre empty and one post RY(u), pA = cos²((u − 60)/2)).

## Physics module `src/lib/arena.ts`

```ts
export type GateName = "H" | "X" | "Z" | "RY";
export interface ArenaGate { g: GateName; t?: number }           // t: RY only, degrees
export interface Circuit { v: 1; pre: ArenaGate[]; post: ArenaGate[] }
export interface State2 { re: number[]; im: number[] }           // 4 amplitudes, bit 0 = q0, bit 1 = q1
export interface Probabilities { p00; p01; p10; p11; pA }        // labels |q0 q1⟩
export type Verdict = "a" | "b" | "draw";
export type BoutResult = Verdict | "a_forfeit" | "b_forfeit";

export const MAX_PRE = 3, MAX_POST = 2, ANGLE_STEP = 5, ANGLE_MIN = -180, ANGLE_MAX = 180, LAYER_RY_DEG = 60;
export const ELO_K = 32, ELO_START = 1200, SPAR_SHOTS = 100, DEFAULT_DAY_BITS = "0000000000";
export const REVEAL_WINDOW_MS = 86_400_000, MAX_UNRESOLVED = 5, DRAW_EPS = 1e-9;
export const COMMIT_MESSAGE = (commit: string) => `dirac:arena:commit:v1:${commit}`;
export const WITHDRAW_MESSAGE = (commit: string) => `dirac:arena:withdraw:v1:${commit}`;

export function zero2(): State2;
export function applyH(s, q), applyX(s, q), applyZ(s, q), applyRY(s, q, degrees), applyCNOT(s, c, t), applyGate(s, q, gate): State2;  // pure, return new states
export function finalState(a: Circuit, b: Circuit): State2;      // A.pre on q0, B.pre on q1, layer, A.post, B.post
export function runBout(a: Circuit, b: Circuit): Probabilities;
export function verdictOf(pA: number): Verdict;

export function parseCircuit(input: unknown): { ok: true; value: Circuit } | { ok: false; error: string };  // strict: gate set, slot sizes, angle grid, no extra keys
export function canonicalCircuit(c: Circuit): string;
export function circuitFromJson(text: string | null | undefined): Circuit | null;
export function gateLabel(g), circuitLabel(c), fighterStyle(c): "hadamard" | "pauli";   // H-heavy → hadamard, X/Z-heavy → pauli, RY counts half towards hadamard

export function sha256Hex(text: string): string;
export function newSalt(): string;                                // 32 hex
export function commitHash(c: Circuit, salt: string): string;     // sha256hex(canonical + ":" + salt)
export function commitDocHash(commit: string): string;            // sha256hex(COMMIT_MESSAGE(commit)), what the commit seal covers
export function withdrawDocHash(commit: string): string;          // sha256hex(WITHDRAW_MESSAGE(commit)), what the withdraw seal covers
export function newBoutId(): string;                              // 16 hex
export const isCommit(s), isSalt(s), isBoutId(s), isDayBits(s);

export function expectedScore(ra, rb): number;
export function eloAfter(ra, rb, scoreA, k = 32): { a: number; b: number };
export function scoreA(result: BoutResult): number;               // a/b_forfeit → 1, b/a_forfeit → 0, draw → 0.5

export function sparSeed(dayBits, boutId): string;                // sha256hex(dayBits + boutId)
export function seedToUint32(hex): number;                        // first 4 bytes big-endian
export function mulberry32(seed: number): () => number;
export function sampleShots(p: Probabilities, n, rng): ShotTally; // { n, a, b, counts: {00,01,10,11}, sequence: "0..3" per shot (index order 00,10,01,11) }
export function sparTally(p, dayBits, boutId): ShotTally;         // sampleShots with SPAR_SHOTS and the seeded PRNG

export function houseFighter(dayBits: string): Circuit;
```

House fighter derivation: `rng = mulberry32(seedToUint32(sha256Hex("dirac:arena:house:v1:" + dayBits)))`; draws in order: `nPre = 1 + floor(rng()*3)`, `nPost = floor(rng()*3)`, then each gate `GATE_NAMES[floor(rng()*4)]`, an RY drawing `t = -180 + 5 * floor(rng()*73)`. Invalid bits fall back to `DEFAULT_DAY_BITS`. `rivalFighter(dayBits)` is the same derivation with the prefix `dirac:arena:rival:v1:`.

Tournament and challenges (same module, pure):

```ts
export const DAY_MS, TOURNAMENT_ENTRY_CLOSE_MS /* 21 h */, TOURNAMENT_REVEAL_CLOSE_MS /* 23 h 59 m */, TOURNAMENT_MAX_ENTRIES = 64, TOURNAMENT_PODIUM = 3;
export const TOURNAMENT_MESSAGE = (day, commit) => `dirac:arena:tournament:v1:${day}:${commit}`;
export function tournamentDocHash(day, commit): string;           // sha256hex(TOURNAMENT_MESSAGE)
export type TournamentPhase = "upcoming" | "entry" | "reveal" | "closing" | "resolved";
export function dayOf(ms): string; isDay(s); dayStart(day): number; shiftDay(day, n): string;
export function tournamentSchedule(day): { day, opensAt, entryClosesAt, revealClosesAt, resolvesAt };
export function tournamentPhase(day, now): TournamentPhase;       // "resolved" = resolvable
export function roundRobin(fighters: TournamentFighter[]): { standings: TournamentStanding[]; matrix: (number | null)[][] };
export function compareStandings(a, b): number;                   // points, margin (1e-9 grid), enteredAt, wallet
interface TournamentFighter { wallet; commit; enteredAt; circuit }
interface TournamentStanding extends TournamentFighter { place; points; margin; wins; draws; losses; games }

export type ChallengeKind = "floor" | "window" | "exact" | "beat" | "hold" | "forbid" | "single" | "split";
interface Challenge { id; kind; title; task; hint; role: "a" | "b"; opponent: Circuit; opponentName; outcome; min; max; target; maxGates }
export function checkChallenge(ch, circuit): { solved; probs; value; unmet: string | null };
export function challengeGoal(ch): string;                        // "p11 ≥ 0.75", "0.70 ≤ pA ≤ 0.80", ...
export function dailyChallenge(dayBits, petDay): Challenge;
export const LESSONS: readonly Challenge[];
export function searchFamily(), singleGateFamily(): readonly Circuit[];
export function solveChallenge(ch): Circuit | null;               // first family member that solves it
```

## Storage (`migrations/0005_arena.sql`, `migrations/0008_arena_commit_index.sql`)

```sql
CREATE TABLE IF NOT EXISTS arena_ratings (wallet TEXT PRIMARY KEY, elo REAL NOT NULL DEFAULT 1200, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS arena_queue (wallet TEXT PRIMARY KEY, "commit" TEXT NOT NULL, seal TEXT NOT NULL, queued_at INTEGER NOT NULL);   -- "commit" is a reserved word, always quoted
CREATE TABLE IF NOT EXISTS arena_bouts (id TEXT PRIMARY KEY, a_wallet, b_wallet, a_commit, b_commit, a_circuit, b_circuit, a_revealed_at, b_revealed_at, paired_at, resolved_at, p_a REAL, result TEXT, seed TEXT);
-- indexes: arena_ratings(elo DESC), arena_queue(queued_at), arena_bouts(a_wallet, paired_at), (b_wallet, paired_at), (resolved_at, paired_at)
-- 0008: UNIQUE arena_queue("commit"), arena_bouts(a_commit), arena_bouts(b_commit)  -- single-use commits; the Worker's guard query works without them
```

`seed` = `sparSeed(dayBits, id)` at pairing time (informational for ranked bouts). Circuits are stored as canonical JSON.

`migrations/0011_arena_tournament.sql`:

```sql
CREATE TABLE IF NOT EXISTS arena_tournament_entries (day TEXT NOT NULL, wallet TEXT NOT NULL, "commit" TEXT NOT NULL UNIQUE, seal TEXT NOT NULL, entered_at INTEGER NOT NULL, circuit TEXT, revealed_at INTEGER, PRIMARY KEY (day, wallet));
CREATE INDEX IF NOT EXISTS arena_tournament_entries_order ON arena_tournament_entries(day, entered_at);
CREATE TABLE IF NOT EXISTS arena_tournaments (day TEXT PRIMARY KEY, resolved_at INTEGER NOT NULL, entries INTEGER NOT NULL, revealed INTEGER NOT NULL, standings TEXT NOT NULL, forfeits TEXT NOT NULL, matrix TEXT NOT NULL);  -- JSON columns
CREATE TABLE IF NOT EXISTS arena_badges (wallet TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'tournament', place INTEGER NOT NULL, awarded_at INTEGER NOT NULL, PRIMARY KEY (wallet, day, kind));
CREATE INDEX IF NOT EXISTS arena_badges_day ON arena_badges(day, place);
```

A full day stores at most 64 × 63 matrix cells (about 80 KB of JSON).

## Routes (worker/arena.ts, `handleArena(request, env, ctx, parts, url)`)

All JSON with CORS `*`, `Cache-Control: no-store`; errors `{ error }` (400 bad input, 403 no passport / not your bout, 404 unknown bout or nothing queued, 409 queue, spent-commit or owed-reveal limits, 413 body > 16 KB, 429 `{ error: "rate limited", retryAt }` + `Retry-After`). Mutating requests (POST, DELETE) are limited to 10 per minute per client IP (D1 `ratelimit` bucket `arena`). Every GET and the commit settle expired bouts first.

```ts
interface ArenaBout {
  id; a; b; aCommit; bCommit;                      // wallets and commits
  aCircuit: Circuit | null; bCircuit: Circuit | null;  // public once resolved; before that null on every GET (only the reveal response echoes the sender's own)
  aRevealedAt; bRevealedAt; pairedAt; revealBy; resolvedAt;   // unix ms, revealBy = pairedAt + 24 h
  pA: number | null; result: BoutResult | null; seed: string | null;
  probs: Probabilities | null;                     // once both circuits are public
}
interface MyBout extends ArenaBout { role: "a" | "b"; revealed; opponentRevealed; mustReveal }
interface RatingRow { wallet; elo; wins; losses; draws; bouts }
interface HouseFighter { circuit: Circuit; dayBits: string; day: number | null }
```

- `GET /api/arena` → `{ ladder: RatingRow[20], totals: { fighters, bouts, resolved, queued }, layer: { description, gates: string[3] }, house: HouseFighter, recent: ArenaBout[10] }` (latest resolved, circuits included).
- `GET /api/arena/me?wallet=` → `{ wallet, rating: RatingRow, queued: { commit, queuedAt } | null, unresolved: MyBout[], recent: ArenaBout[20] }`. The wallet is not verified, so `unresolved[].aCircuit/bCircuit` stay null until resolved; the flags (`revealed`, `opponentRevealed`, `mustReveal`) come from the timestamps, which are public anyway.
- `POST /api/arena/spar` `{ circuit }` → `{ boutId, pA, verdict, probs, shots: ShotTally, player, house, seed, rated: false }`. Validates the circuit strictly.
- `POST /api/arena/commit` `{ wallet, commit, seal: QSeal }` → `{ queued: true }` or `{ queued: false, boutId, role: "b" }`. 403 without a registered passport; 400 on a seal that does not verify, was made by another key, covers another commit, is older than 1 h ("seal is too old…") or is dated more than 1 h ahead ("seal is dated in the future…"); 409 when a fighter of the wallet is queued (`{ commit, queuedAt }`), when the commit has already fought (`{ commit }`) or 5 bouts are waiting for this wallet's reveal (`{ open }`).
- `DELETE /api/arena/queue` `{ wallet, commit, seal: QSeal }` → `{ withdrawn: true, commit }`. The seal covers `withdrawDocHash(commit)`, same passport and skew rules as the commit. 404 when no fighter with that commit is queued for the wallet (already paired, already withdrawn, or never queued): the bout, if any, stands.
- `POST /api/arena/reveal` `{ wallet, boutId, circuit, salt }` → `ArenaBout` with the sender's own circuit echoed (it just sent the preimage). 400 when `commitHash(circuit, salt)` differs from that side's commit; 403 when the wallet is not in the bout; 409 when already resolved. Idempotent for a side that already revealed. Resolves when both sides are in.
- `GET /api/arena/bout/:id` → `ArenaBout` as anyone sees it (a `?wallet=` query is ignored).
- `GET /api/arena/tournament?day=YYYY-MM-DD` (default: the server's UTC today) → `TournamentView { day, phase, now, schedule, maxEntries: 64, counts: { entries, revealed }, entrants: { wallet, commit, enteredAt, revealedAt }[] (commit order), result: { resolvedAt, standings: TournamentStanding[], forfeits: TournamentEntrant[], matrix } | null }`. Circuits appear only in `result.standings`. `result` is null until the day resolved and for a past day nobody entered. 400 on a malformed or impossible date. Resolves finished days first (see above).
- `POST /api/arena/tournament/enter` `{ wallet, day?, commit, seal: QSeal }` → `{ entered: true, day, commit, enteredAt, entries }`. 403 without a registered passport ("the tournament needs a registered passport"); 400 on a seal that does not verify, was made by another key, does not cover `tournamentDocHash(today, commit)` ("seal does not cover this tournament entry"), is too old or dated in the future; 409 when `day` is not the server's today (`{ day }`), after 21:00 UTC (`{ day, opensAt }`, the next day's start), when the wallet already entered (`{ commit, enteredAt }`), when the commit was already entered on any day (`{ commit }`), when the day is full (`{ entries: 64 }`).
- `POST /api/arena/tournament/reveal` `{ wallet, day?, circuit, salt }` → `{ revealed: true, day, wallet, commit, circuit, revealedAt }` (the sender's own circuit echoed). 409 before 21:00 (`{ revealOpensAt }`) and from 23:59 UTC (`{ revealClosedAt }`) or once resolved; 404 when the wallet has no entry that day; 400 when `commitHash(circuit, salt)` differs from the entry. Idempotent (same `revealedAt`).
- `GET /api/arena/badges?wallet=` → `{ wallet, badges: { kind: "tournament", day, place, awardedAt }[] }`, newest day first, at most 90.

## Browser client `src/lib/arenaApi.ts`

```ts
export class ArenaApiError extends Error { status; retryAt: number | null; data: Record<string, unknown> | null }
export function fetchLadder(): Promise<ArenaLadder>;
export function fetchArenaMe(wallet): Promise<ArenaMe>;
export function sparWithHouse(circuit): Promise<SparResult>;
export function commitFighter(wallet, commit, seal: QSeal): Promise<CommitResponse>;
export function withdrawFighter(wallet, commit, seal: QSeal): Promise<WithdrawResponse>;   // seal over withdrawDocHash(commit)
export function revealFighter(wallet, boutId, circuit, salt): Promise<ArenaBout>;
export function fetchBout(id): Promise<ArenaBout>;
export function fetchTournament(day?): Promise<TournamentView>;
export function enterTournament(wallet, day, commit, seal: QSeal): Promise<TournamentEnterResponse>;   // seal over tournamentDocHash(day, commit)
export function revealTournament(wallet, day, circuit, salt): Promise<TournamentRevealResponse>;
export function fetchArenaBadges(wallet): Promise<ArenaBadges>;
```

Browser storage (`src/lib/arenaStore.ts`, external store read through `useSyncExternalStore`): `dirac:arena:fighters:<wallet>` holds `{ commit, salt, circuit, boutId, createdAt, revealedAt }[]` for every ranked commit made in that browser (the only copy of circuit + salt, hence "reveal must come from this browser"); `dirac:arena:favourite` one practice opponent; `dirac:arena:draft` the builder's circuit. A stored fighter is never dropped on age: `syncFighters(wallet, me)` reconciles the list with each `GET /api/arena/me` answer (records bout ids, removes a fighter that was withdrawn or that the server lists neither as queued nor in any bout once it is 10 min old), so a fighter that waits weeks in the queue keeps its circuit and salt.

`dirac:arena:tournament:<wallet>` holds `{ day, commit, salt, circuit, enteredAt, revealedAt }[]` for the tournament entries made in that browser: stored before the enter request (a lost reply must not lose the circuit), removed on a 4xx refusal, kept 14 days (by then the day has resolved and the circuit is public). It is the only copy of circuit + salt, so the 21:00 to 23:59 UTC reveal must come from that browser; the panel says so. `dirac:arena:challenges` maps a challenge id to `{ at, value, circuit }`, the first solve in that browser.

## Page `/arena` (`src/app/arena/page.tsx`, components in `src/components/arena/*`)

Tabs (`ArenaTabs`, links to `?tab=bout|tournament|challenges`, other query parameters kept, `?bout=` too; the page reads them with `useSearchParams` inside `<Suspense>`, whose fallback renders the Bout tab for the static HTML). Left, on every tab: chapter header, `FightStage` (two `FighterCard`s: sprite by `fighterStyle`, tint and labels by the circuit; plays a spar as ten rounds of ten shots), `ProbabilityReadout` (exact p00 p01 p10 p11 and pA against the house, a stored favourite or the identity). Right: `BoutLookup` (`?bout=<id>`, inside Suspense), the tab bar, `CircuitBuilder` (shared by every tab), then:

- Bout: `SparPanel`, `RankedPanel` (needs `useSession` passport + keys for the connected wallet), `BoutsPanel` (open bouts with Reveal, results), `Ladder`, `RecentBouts`, `RulesPanel`.
- Tournament (`TournamentTab`, owns the reads): `TournamentPanel` (today: phase chip, live countdown to the next cut-off on the local clock corrected by the server's, a day bar, entries/revealed counts, "your entry" in every state: connect, passport keys, commit and enter, entered and kept in this browser, reveal button, committed elsewhere, revealed, forfeit, closed, full; podium badge counts; entrants list, scrollable), `TournamentResults` (yesterday by default, earlier days with the arrows: podium, standings table, forfeits, the round-robin matrix in a scrolling table with sticky headers, bright = A won, grey = B won, blue = exact draw), tournament rules. `useTournament` polls every 30 s while visible and reads again 2 s after each phase boundary.
- Challenges: `ChallengesPanel` (today's challenge, then the three lessons; every card reruns the builder's circuit live and shows the goal, the opponent, the measured numbers and the full table; "practise against it" stores the opponent as the favourite so the odds panel and the stage show it). On this tab a builder change that meets a goal is recorded at once; a "Record solve" button covers a draft that already passes. The daily challenge (an exhaustive search, tens of ms) is computed only on this tab.

On phones the bout lookup and the tab bar sit under the header; wide tables (standings, matrix) scroll inside their panel.

## Tests

- `node scripts/arena-selftest.ts` (55 checks, about 5 s; one checks the round robin's games bitwise against `runBout` over 2,256 ordered pairs of random full circuits): physics (H alone with the layer gives pA = 0.75, Bell pair, RY matrix, CNOT), canonical form and commit round trip, strict validation, ELO, PRNG determinism, sampling frequencies, house and rival fighter determinism; the tournament calendar (days, schedule, every phase boundary, the seal message); the round robin (two identities tie and the earlier entry wins, same entry time falls back to the wallet, an exact draw scores 0.5 each, the margin comparator, 9 random fighters with a twin checked against an independent count of points, margins, matrix and order, the empty and one-fighter cases); the challenges (family sizes, the family reaches the distribution of random full circuits as A and as B, every checker kind including the 1e-9 edges, the lessons' documented solutions, daily determinism and ids, all kinds and opponents over 256 days, 64 daily challenges solvable and not solved by the empty circuit).
- `node scripts/arena-e2e.ts http://127.0.0.1:8791 [--age-cmd "..."] [--sql-cmd "... {file}"] [--clock]` against a local `wrangler dev` with the migrations applied: spar (pA and the 100-shot sequence match the local module), two throwaway passports, commit (403 without passport, 400 forged seal / wrong document / seal 1 h stale / seal 1 h in the future, 409 double queue), withdraw (400 wrong seal or another passport, 200 then 404), pairing, replay of a paired commit (409), one open bout per pair, reveal (400 wrong salt/circuit, 403 stranger, hidden from everyone until resolved including `?wallet=` claims by a third party, idempotent), a revealed side is not locked out by the opponent's pending reveal, exact resolution, ELO movement, ladder; with `--age-cmd` also the 24 h forfeit; and the 10-per-minute limit. Then the tournament: the view, its schedule and day validation, the `arenat` limit; with `--clock` a whole synthetic day (403 no passport, 409 wrong day, 400 ranked seal / yesterday's seal / stale seal, 4 entries, 409 second entry and reused commit, circuits hidden, 409 reveal before 21:00, 409 entry after 21:00, 400 wrong salt / another's preimage, 404 no entry, 3 reveals echoed, idempotent, 409 after 23:59, phase closing, resolution through the cron route, standings and matrix equal to the local `roundRobin`, the earliest-commit tie-break between twins, resolved once, badges for the podium and none for the forfeit, 409 after resolution), then a second day resolved by a plain read; with `--sql-cmd` the twins' `entered_at` is edited in the D1, 63 synthetic entries make a real one the 64th and refuse the 65th, and the whole bracket is moved to a finished day by an UPDATE (a day boundary crossed in the D1), which resolves on read as 64 forfeits with no badge.
- `--clock` needs a target that also answers `GET /__test/clock?offset=<ms>` and `GET /__test/cron`: a scratch entry outside the repo that wraps the Worker, never the deployment:

```ts
import worker from "<repo>/worker/index";
import { resolveTournaments } from "<repo>/worker/arena";
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/clock") { offset = Number(url.searchParams.get("offset") ?? 0); return Response.json({ offset, now: Date.now() }); }
    if (url.pathname === "/__test/cron") return Response.json(await resolveTournaments(env));
    return worker.fetch(request, env, ctx);
  },
};
```

  Run it with a scratch wrangler config that carries the `DB` binding (same `database_id`, `migrations_dir` pointing at the repo) and `--persist-to <scratch dir>`; `--sql-cmd "npx wrangler d1 execute dirac --local --config <that config> --persist-to <dir> --file {file}"`. Last local run: 118 checks, all pass, on a fresh D1.

## Integrator duties

- `worker/index.ts`: `import { handleArena } from "./arena";` and, next to the pet/inbox delegation before `notFound()`: `const arena = await handleArena(request, env, ctx, parts, url); if (arena) return arena;`. Add `/api/arena/*` to the header comment. `POST /api/passports` carries the `passports` D1 rate-limit bucket (10 a minute per IP).
- `worker/index.ts`, the daily tournament: `import { handleArena, resolveTournaments } from "./arena";` and in `scheduled` (00:00 UTC), next to the pet collapse: `ctx.waitUntil(resolveTournaments(env));`. The routes need nothing new: `handleArena` already serves `/api/arena/tournament*` and `/api/arena/badges`.
- `wrangler d1 migrations apply dirac --remote` for `0005_arena.sql`, `0008_arena_commit_index.sql` and `0011_arena_tournament.sql`.
- `src/components/sections/Playground.tsx`: a link "Enter the arena →" to `/arena` in `ArenaCard`; `src/components/sections/Footer.tsx`: "Qubit arena" → `/arena`.

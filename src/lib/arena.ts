/**
 * Qubit Arena: the exact two-qubit physics, the circuit format, the
 * commit-reveal hash, the rating maths, the house fighter and the
 * exhibition PRNG.
 *
 * Pure module: no React, no DOM apart from `TextEncoder`, no `process`. The
 * Worker (worker/arena.ts), the pages and the node self-test
 * (scripts/arena-selftest.ts) all import this one file, so a bout is decided
 * by the same arithmetic wherever it is computed. No TS-only runtime syntax.
 *
 * Rules (v1):
 * - Register |q0 q1>. Player A owns q0, player B owns q1. A fighter is a
 *   circuit on its own qubit: up to 3 "pre" gates and up to 2 "post" gates
 *   from {H, X, Z, RY(theta)}, theta in degrees, -180..180 in 5-degree steps.
 * - Between pre and post a fixed public entangling layer runs: H on q0,
 *   CNOT(q0 -> q1), RY(60 degrees) on q1. Then both qubits are measured.
 * - Outcomes with parity 0 (00, 11) are A's, parity 1 (01, 10) are B's.
 *   pA = p00 + p11. Ranked bouts compare pA exactly (no sampling); sparring
 *   samples 100 shots with a seeded PRNG.
 * - Hidden information: commit = sha256(canonical circuit JSON + ":" + salt).
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type GateName = "H" | "X" | "Z" | "RY";

export interface ArenaGate {
  g: GateName;
  /** RY only: degrees, -180..180, multiple of 5 */
  t?: number;
}

export interface Circuit {
  v: 1;
  pre: ArenaGate[];
  post: ArenaGate[];
}

/** Two-qubit state vector: amplitude of basis state i is re[i] + i*im[i]; bit 0 = q0, bit 1 = q1. */
export interface State2 {
  re: number[];
  im: number[];
}

/** Exact outcome probabilities; labels are |q0 q1>. */
export interface Probabilities {
  p00: number;
  p01: number;
  p10: number;
  p11: number;
  /** p00 + p11: the share of the distribution that belongs to A */
  pA: number;
}

export type Verdict = "a" | "b" | "draw";
export type BoutResult = Verdict | "a_forfeit" | "b_forfeit";

export interface ShotTally {
  n: number;
  /** shots with parity 0 (A's) */
  a: number;
  /** shots with parity 1 (B's) */
  b: number;
  counts: { "00": number; "01": number; "10": number; "11": number };
  /** one character per shot: the outcome index 0..3 (|q0 q1> = 00, 10, 01, 11) */
  sequence: string;
}

export interface RatingRow {
  wallet: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  bouts: number;
}

export interface HouseFighter {
  circuit: Circuit;
  /** the pet's latest collapsed day bits, or DEFAULT_DAY_BITS */
  dayBits: string;
  /** the pet day those bits came from, null for the fallback */
  day: number | null;
}

export interface ArenaBout {
  id: string;
  /** wallets */
  a: string;
  b: string;
  aCommit: string;
  bCommit: string;
  /**
   * null until revealed, and hidden from everyone (the GET routes included)
   * until the bout is resolved; only the reveal response echoes the
   * revealer's own circuit back.
   */
  aCircuit: Circuit | null;
  bCircuit: Circuit | null;
  aRevealedAt: number | null;
  bRevealedAt: number | null;
  /** unix ms */
  pairedAt: number;
  /** pairedAt + REVEAL_WINDOW_MS: after this an unrevealed side forfeits */
  revealBy: number;
  resolvedAt: number | null;
  pA: number | null;
  result: BoutResult | null;
  /** sha256 hex of (dayBits + boutId) at pairing time, informational for ranked bouts */
  seed: string | null;
  /** the full table once both circuits are public */
  probs: Probabilities | null;
}

export interface MyBout extends ArenaBout {
  role: "a" | "b";
  revealed: boolean;
  opponentRevealed: boolean;
  mustReveal: boolean;
}

export interface ArenaLadder {
  ladder: RatingRow[];
  totals: { fighters: number; bouts: number; resolved: number; queued: number };
  layer: { description: string; gates: string[] };
  house: HouseFighter;
  /** latest resolved bouts, circuits included */
  recent: ArenaBout[];
}

export interface ArenaMe {
  wallet: string;
  rating: RatingRow;
  queued: { commit: string; queuedAt: number } | null;
  unresolved: MyBout[];
  recent: ArenaBout[];
}

export interface SparResult {
  boutId: string;
  pA: number;
  verdict: Verdict;
  probs: Probabilities;
  shots: ShotTally;
  player: Circuit;
  house: HouseFighter;
  /** sha256 hex of (dayBits + boutId): the PRNG seed */
  seed: string;
  rated: false;
}

export type CommitResponse = { queued: true } | { queued: false; boutId: string; role: "a" | "b" };

/** `DELETE /api/arena/queue`: the queued fighter with this commit is gone. */
export interface WithdrawResponse {
  withdrawn: true;
  commit: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const GATE_NAMES: readonly GateName[] = ["H", "X", "Z", "RY"];
export const MAX_PRE = 3;
export const MAX_POST = 2;
export const ANGLE_STEP = 5;
export const ANGLE_MIN = -180;
export const ANGLE_MAX = 180;
/** The fixed layer's rotation on q1, degrees. */
export const LAYER_RY_DEG = 60;
export const LAYER_GATES: readonly string[] = ["H q0", "CNOT q0 -> q1", `RY(${LAYER_RY_DEG}) q1`];
export const LAYER_DESCRIPTION =
  "After both pre circuits: H on q0, CNOT with q0 as control and q1 as target, RY(60 degrees) on q1. Then both post circuits, then a computational-basis measurement of both qubits.";
export const ELO_K = 32;
export const ELO_START = 1200;
export const SPAR_SHOTS = 100;
export const DEFAULT_DAY_BITS = "0000000000";
export const REVEAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Open bouts still waiting for a wallet's own reveal: above this a commit is refused. */
export const MAX_UNRESOLVED = 5;
/** Ranked bouts: |pA - 0.5| within this is a draw. */
export const DRAW_EPS = 1e-9;
export const COMMIT_MESSAGE = (commit: string) => `dirac:arena:commit:v1:${commit}`;
/** Sealed by the passport to take a queued fighter back (DELETE /api/arena/queue). */
export const WITHDRAW_MESSAGE = (commit: string) => `dirac:arena:withdraw:v1:${commit}`;

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;
const DEG = Math.PI / 180;
const encoder = new TextEncoder();

/* ------------------------------------------------------------------ */
/* State and gates                                                     */
/* ------------------------------------------------------------------ */

/** |00> */
export function zero2(): State2 {
  return { re: [1, 0, 0, 0], im: [0, 0, 0, 0] };
}

const clone = (s: State2): State2 => ({ re: s.re.slice(), im: s.im.slice() });

function assertQubit(q: number): void {
  if (q !== 0 && q !== 1) throw new RangeError("qubit must be 0 or 1");
}

/** The two basis pairs (i0 without bit q, i1 with it). */
function pairs(q: number): [number, number][] {
  const m = 1 << q;
  const out: [number, number][] = [];
  for (let i = 0; i < 4; i++) if ((i & m) === 0) out.push([i, i | m]);
  return out;
}

/** Hadamard on qubit q. */
export function applyH(s: State2, q: number): State2 {
  assertQubit(q);
  const o = clone(s);
  const k = Math.SQRT1_2;
  for (const [i0, i1] of pairs(q)) {
    o.re[i0] = (s.re[i0] + s.re[i1]) * k;
    o.im[i0] = (s.im[i0] + s.im[i1]) * k;
    o.re[i1] = (s.re[i0] - s.re[i1]) * k;
    o.im[i1] = (s.im[i0] - s.im[i1]) * k;
  }
  return o;
}

/** Pauli X (bit flip) on qubit q. */
export function applyX(s: State2, q: number): State2 {
  assertQubit(q);
  const o = clone(s);
  for (const [i0, i1] of pairs(q)) {
    o.re[i0] = s.re[i1];
    o.im[i0] = s.im[i1];
    o.re[i1] = s.re[i0];
    o.im[i1] = s.im[i0];
  }
  return o;
}

/** Pauli Z (phase flip) on qubit q. */
export function applyZ(s: State2, q: number): State2 {
  assertQubit(q);
  const o = clone(s);
  for (const [, i1] of pairs(q)) {
    o.re[i1] = -s.re[i1];
    o.im[i1] = -s.im[i1];
  }
  return o;
}

/** RY(theta) = [[cos t/2, -sin t/2], [sin t/2, cos t/2]] on qubit q, theta in degrees. */
export function applyRY(s: State2, q: number, degrees: number): State2 {
  assertQubit(q);
  if (!Number.isFinite(degrees)) throw new RangeError("angle must be finite");
  const half = (degrees * DEG) / 2;
  const c = Math.cos(half);
  const n = Math.sin(half);
  const o = clone(s);
  for (const [i0, i1] of pairs(q)) {
    o.re[i0] = c * s.re[i0] - n * s.re[i1];
    o.im[i0] = c * s.im[i0] - n * s.im[i1];
    o.re[i1] = n * s.re[i0] + c * s.re[i1];
    o.im[i1] = n * s.im[i0] + c * s.im[i1];
  }
  return o;
}

/** Controlled NOT: flips qubit t in every basis state where bit c is 1. */
export function applyCNOT(s: State2, c: number, t: number): State2 {
  assertQubit(c);
  assertQubit(t);
  if (c === t) throw new RangeError("control and target must differ");
  const o = clone(s);
  const cm = 1 << c;
  const tm = 1 << t;
  for (let i = 0; i < 4; i++) {
    if ((i & cm) !== 0 && (i & tm) === 0) {
      const j = i | tm;
      o.re[i] = s.re[j];
      o.im[i] = s.im[j];
      o.re[j] = s.re[i];
      o.im[j] = s.im[i];
    }
  }
  return o;
}

/** One fighter gate on qubit q. */
export function applyGate(s: State2, q: number, gate: ArenaGate): State2 {
  switch (gate.g) {
    case "H":
      return applyH(s, q);
    case "X":
      return applyX(s, q);
    case "Z":
      return applyZ(s, q);
    case "RY":
      return applyRY(s, q, gate.t ?? 0);
  }
}

/** |a_i|^2 for the four basis states, index order. */
export function amplitudesSquared(s: State2): number[] {
  return [0, 1, 2, 3].map((i) => s.re[i] * s.re[i] + s.im[i] * s.im[i]);
}

export function probabilitiesOf(s: State2): Probabilities {
  const p = amplitudesSquared(s);
  return { p00: p[0], p10: p[1], p01: p[2], p11: p[3], pA: p[0] + p[3] };
}

/** The whole bout: A's pre on q0, B's pre on q1, the fixed layer, both posts. */
export function finalState(a: Circuit, b: Circuit): State2 {
  let s = zero2();
  for (const g of a.pre) s = applyGate(s, 0, g);
  for (const g of b.pre) s = applyGate(s, 1, g);
  s = applyH(s, 0);
  s = applyCNOT(s, 0, 1);
  s = applyRY(s, 1, LAYER_RY_DEG);
  for (const g of a.post) s = applyGate(s, 0, g);
  for (const g of b.post) s = applyGate(s, 1, g);
  return s;
}

export function runBout(a: Circuit, b: Circuit): Probabilities {
  return probabilitiesOf(finalState(a, b));
}

/** The ranked rule: exact comparison of pA with 0.5, a draw within DRAW_EPS. */
export function verdictOf(pA: number): Verdict {
  if (pA > 0.5 + DRAW_EPS) return "a";
  if (pA < 0.5 - DRAW_EPS) return "b";
  return "draw";
}

/** Index-order probabilities [p00, p10, p01, p11] for the sampler. */
export function indexProbabilities(p: Probabilities): number[] {
  return [p.p00, p.p10, p.p01, p.p11];
}

/* ------------------------------------------------------------------ */
/* Circuits: validation and canonical form                             */
/* ------------------------------------------------------------------ */

export const emptyCircuit = (): Circuit => ({ v: 1, pre: [], post: [] });

export const isAngle = (t: unknown): t is number =>
  typeof t === "number" && Number.isInteger(t) && t >= ANGLE_MIN && t <= ANGLE_MAX && t % ANGLE_STEP === 0;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGate(input: unknown, where: string): Parsed<ArenaGate> {
  if (!isRecord(input)) return { ok: false, error: `${where}: gate must be an object` };
  const keys = Object.keys(input);
  const { g, t } = input;
  if (typeof g !== "string" || !(GATE_NAMES as readonly string[]).includes(g)) {
    return { ok: false, error: `${where}: gate must be one of H, X, Z, RY` };
  }
  if (g === "RY") {
    if (!isAngle(t)) {
      return { ok: false, error: `${where}: RY needs t, an integer multiple of ${ANGLE_STEP} in ${ANGLE_MIN}..${ANGLE_MAX}` };
    }
    if (keys.some((k) => k !== "g" && k !== "t")) return { ok: false, error: `${where}: unknown gate field` };
    return { ok: true, value: { g: "RY", t: t === 0 ? 0 : t } };
  }
  if (t !== undefined) return { ok: false, error: `${where}: only RY takes an angle` };
  if (keys.some((k) => k !== "g")) return { ok: false, error: `${where}: unknown gate field` };
  return { ok: true, value: { g: g as Exclude<GateName, "RY"> } };
}

function parseSlot(input: unknown, name: "pre" | "post", max: number): Parsed<ArenaGate[]> {
  if (!Array.isArray(input)) return { ok: false, error: `${name} must be an array of gates` };
  if (input.length > max) return { ok: false, error: `${name} takes at most ${max} gates` };
  const out: ArenaGate[] = [];
  for (let i = 0; i < input.length; i++) {
    const gate = parseGate(input[i], `${name}[${i}]`);
    if (!gate.ok) return gate;
    out.push(gate.value);
  }
  return { ok: true, value: out };
}

/** Strict: the gate set, the slot sizes, the angle grid, no extra fields. */
export function parseCircuit(input: unknown): Parsed<Circuit> {
  if (!isRecord(input)) return { ok: false, error: "circuit must be an object" };
  if (input.v !== 1) return { ok: false, error: "circuit.v must be 1" };
  if (Object.keys(input).some((k) => k !== "v" && k !== "pre" && k !== "post")) {
    return { ok: false, error: "circuit has unknown fields" };
  }
  const pre = parseSlot(input.pre, "pre", MAX_PRE);
  if (!pre.ok) return pre;
  const post = parseSlot(input.post, "post", MAX_POST);
  if (!post.ok) return post;
  return { ok: true, value: { v: 1, pre: pre.value, post: post.value } };
}

/**
 * Canonical JSON: fixed key order {v, pre, post}, each gate {g} or {g, t},
 * no whitespace. `JSON.stringify` keeps insertion order for string keys, so
 * the output is byte-identical in every engine.
 */
export function canonicalCircuit(c: Circuit): string {
  const gate = (g: ArenaGate) => (g.g === "RY" ? { g: "RY", t: g.t ?? 0 } : { g: g.g });
  return JSON.stringify({ v: 1, pre: c.pre.map(gate), post: c.post.map(gate) });
}

/** The circuit a stored canonical string describes; null when it is not one. */
export function circuitFromJson(text: string | null | undefined): Circuit | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const parsed = parseCircuit(JSON.parse(text));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}

/** "H", "X", "Z", "RY 45", "RY -90" */
export function gateLabel(g: ArenaGate): string {
  return g.g === "RY" ? `RY ${g.t ?? 0}` : g.g;
}

/** "H · RY 45 | X" (pre | post); "identity" for an empty circuit. */
export function circuitLabel(c: Circuit): string {
  const pre = c.pre.map(gateLabel).join(" · ");
  const post = c.post.map(gateLabel).join(" · ");
  if (!pre && !post) return "identity";
  return `${pre || "—"} | ${post || "—"}`;
}

export const gateCount = (c: Circuit): number => c.pre.length + c.post.length;

/**
 * Which render a circuit wears: H-heavy fighters are Hadamard, X/Z-heavy
 * fighters are Pauli. An RY counts half towards Hadamard (it builds
 * superpositions too); ties and empty circuits are Hadamard.
 */
export function fighterStyle(c: Circuit): "hadamard" | "pauli" {
  let h = 0;
  let p = 0;
  for (const g of [...c.pre, ...c.post]) {
    if (g.g === "H") h += 1;
    else if (g.g === "RY") h += 0.5;
    else p += 1;
  }
  return p > h ? "pauli" : "hadamard";
}

/* ------------------------------------------------------------------ */
/* Commit-reveal                                                       */
/* ------------------------------------------------------------------ */

export const sha256Hex = (text: string): string => bytesToHex(sha256(encoder.encode(text)));

/** 16 random bytes as 32 hex characters. */
export const newSalt = (): string => bytesToHex(randomBytes(16));

export const isSalt = (s: unknown): s is string => typeof s === "string" && HEX_32.test(s);
export const isCommit = (s: unknown): s is string => typeof s === "string" && HEX_64.test(s);
export const isBoutId = (s: unknown): s is string => typeof s === "string" && HEX_16.test(s);

/** sha256 hex of (canonical circuit JSON + ":" + salt). */
export function commitHash(c: Circuit, salt: string): string {
  if (!isSalt(salt)) throw new Error("salt must be 32 hex characters");
  return sha256Hex(`${canonicalCircuit(c)}:${salt}`);
}

/** The document hash the passport seals: sha256 hex of the commit message. */
export const commitDocHash = (commit: string): string => sha256Hex(COMMIT_MESSAGE(commit));

/** The document hash sealed to withdraw a queued commit: sha256 hex of the withdraw message. */
export const withdrawDocHash = (commit: string): string => sha256Hex(WITHDRAW_MESSAGE(commit));

/** 8 random bytes as 16 hex characters. */
export const newBoutId = (): string => bytesToHex(randomBytes(8));

/* ------------------------------------------------------------------ */
/* Rating                                                              */
/* ------------------------------------------------------------------ */

export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** New ratings after a bout; scoreA is 1 (A won), 0.5 (draw) or 0 (B won). */
export function eloAfter(ra: number, rb: number, scoreA: number, k = ELO_K): { a: number; b: number } {
  const ea = expectedScore(ra, rb);
  const eb = 1 - ea;
  return { a: ra + k * (scoreA - ea), b: rb + k * (1 - scoreA - eb) };
}

/** A's score for a result, or null when nothing is rated (a double no-show). */
export function scoreA(result: BoutResult): number | null {
  switch (result) {
    case "a":
    case "b_forfeit":
      return 1;
    case "b":
    case "a_forfeit":
      return 0;
    case "draw":
      return 0.5;
  }
}

/* ------------------------------------------------------------------ */
/* Exhibition sampling                                                 */
/* ------------------------------------------------------------------ */

/** sha256 hex of (dayBits + boutId): the seed material of an exhibition bout. */
export const sparSeed = (dayBits: string, boutId: string): string => sha256Hex(`${dayBits}${boutId}`);

/** The first 4 bytes of a hex digest as an unsigned 32-bit integer (big-endian). */
export function seedToUint32(hex: string): number {
  if (!/^[0-9a-f]{8,}$/.test(hex)) throw new Error("seed must be a hex digest");
  return Number.parseInt(hex.slice(0, 8), 16) >>> 0;
}

/** mulberry32: a small deterministic PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n shots from the exact distribution with the given PRNG; the result lists who took each one. */
export function sampleShots(p: Probabilities, n: number, rng: () => number): ShotTally {
  const weights = indexProbabilities(p);
  const total = weights.reduce((x, y) => x + y, 0) || 1;
  const counts = [0, 0, 0, 0];
  let sequence = "";
  for (let k = 0; k < n; k++) {
    const r = rng() * total;
    let acc = 0;
    let idx = 3;
    for (let i = 0; i < 4; i++) {
      acc += weights[i];
      if (r < acc) {
        idx = i;
        break;
      }
    }
    counts[idx] += 1;
    sequence += String(idx);
  }
  const a = counts[0] + counts[3];
  return {
    n,
    a,
    b: n - a,
    counts: { "00": counts[0], "10": counts[1], "01": counts[2], "11": counts[3] },
    sequence,
  };
}

/** The 100-shot exhibition of a bout, seeded by sparSeed(dayBits, boutId). */
export function sparTally(p: Probabilities, dayBits: string, boutId: string): ShotTally {
  return sampleShots(p, SPAR_SHOTS, mulberry32(seedToUint32(sparSeed(dayBits, boutId))));
}

/* ------------------------------------------------------------------ */
/* House fighter                                                       */
/* ------------------------------------------------------------------ */

export const isDayBits = (s: unknown): s is string => typeof s === "string" && /^[01]{10}$/.test(s);

/**
 * The house fighter of the day, derived from the pet's latest collapsed
 * bits: mulberry32 seeded with the first 4 bytes of
 * sha256("dirac:arena:house:v1:" + dayBits) draws, in this order, the pre
 * count (1..3), the post count (0..2), then every gate uniformly from
 * {H, X, Z, RY}; an RY draws its angle uniformly from the 73 grid points
 * -180..180. Same bits, same fighter, in any runtime.
 */
export function houseFighter(dayBits: string): Circuit {
  const bits = isDayBits(dayBits) ? dayBits : DEFAULT_DAY_BITS;
  return drawFighter(`dirac:arena:house:v1:${bits}`);
}

/**
 * The challenge rival of the day: the house derivation with its own prefix,
 * sha256("dirac:arena:rival:v1:" + dayBits), so it differs from the house.
 */
export function rivalFighter(dayBits: string): Circuit {
  const bits = isDayBits(dayBits) ? dayBits : DEFAULT_DAY_BITS;
  return drawFighter(`dirac:arena:rival:v1:${bits}`);
}

function drawFighter(seedText: string): Circuit {
  const rng = mulberry32(seedToUint32(sha256Hex(seedText)));
  const nPre = 1 + Math.floor(rng() * 3);
  const nPost = Math.floor(rng() * 3);
  const draw = (): ArenaGate => {
    const g = GATE_NAMES[Math.floor(rng() * GATE_NAMES.length)];
    if (g !== "RY") return { g };
    const steps = (ANGLE_MAX - ANGLE_MIN) / ANGLE_STEP + 1;
    return { g, t: ANGLE_MIN + ANGLE_STEP * Math.floor(rng() * steps) };
  };
  const pre: ArenaGate[] = [];
  const post: ArenaGate[] = [];
  for (let i = 0; i < nPre; i++) pre.push(draw());
  for (let i = 0; i < nPost; i++) post.push(draw());
  return { v: 1, pre, post };
}

/* ------------------------------------------------------------------ */
/* Daily tournament                                                    */
/* ------------------------------------------------------------------ */

/*
 * One tournament per UTC day D ("YYYY-MM-DD"). Entries are commits sealed
 * like ranked ones, over sha256("dirac:arena:tournament:v1:" + D + ":" +
 * commit), accepted from 00:00 until 21:00 UTC; entrants reveal circuit and
 * salt from 21:00 until 23:59 UTC; from 00:00 UTC of D+1 the day resolves:
 * every revealed fighter plays every other twice, once as A and once as B,
 * decided exactly (win 1, draw 0.5, loss 0). Ranking: points, then the summed
 * margin, then the earlier commit. The minute between 23:59 and 00:00 takes
 * no reveal, so a late reveal can never race the resolution.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Entries for day D close at 21:00 UTC; reveals open at the same moment. */
export const TOURNAMENT_ENTRY_CLOSE_MS = 21 * 60 * 60 * 1000;
/** Reveals close at 23:59 UTC. */
export const TOURNAMENT_REVEAL_CLOSE_MS = (23 * 60 + 59) * 60 * 1000;
/** Entries per day; later ones are refused. */
export const TOURNAMENT_MAX_ENTRIES = 64;
/** Places that earn a tournament badge (when at least two fighters revealed). */
export const TOURNAMENT_PODIUM = 3;
export const TOURNAMENT_MESSAGE = (day: string, commit: string) => `dirac:arena:tournament:v1:${day}:${commit}`;
/** The document hash the passport seals to enter day `day`: sha256 hex of the tournament message. */
export const tournamentDocHash = (day: string, commit: string): string => sha256Hex(TOURNAMENT_MESSAGE(day, commit));

export type TournamentPhase = "upcoming" | "entry" | "reveal" | "closing" | "resolved";

export interface TournamentSchedule {
  day: string;
  /** 00:00 UTC of D: entries open */
  opensAt: number;
  /** 21:00 UTC: entries close, reveals open */
  entryClosesAt: number;
  /** 23:59 UTC: reveals close */
  revealClosesAt: number;
  /** 00:00 UTC of D+1: the day resolves */
  resolvesAt: number;
}

/** The UTC day of a unix-ms instant, "YYYY-MM-DD". */
export function dayOf(ms: number): string {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day written "YYYY-MM-DD", 1970 or later. */
export function isDay(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DAY_RE.exec(s);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) && ms >= 0 && dayOf(ms) === s;
}

/** 00:00 UTC of a day, unix ms. */
export function dayStart(day: string): number {
  if (!isDay(day)) throw new RangeError("day must be YYYY-MM-DD");
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** The day `days` after (or before, when negative) `day`. */
export const shiftDay = (day: string, days: number): string => dayOf(dayStart(day) + days * DAY_MS);

export function tournamentSchedule(day: string): TournamentSchedule {
  const opensAt = dayStart(day);
  return {
    day,
    opensAt,
    entryClosesAt: opensAt + TOURNAMENT_ENTRY_CLOSE_MS,
    revealClosesAt: opensAt + TOURNAMENT_REVEAL_CLOSE_MS,
    resolvesAt: opensAt + DAY_MS,
  };
}

/** Where day `day` stands at `now`; "resolved" means resolvable (the Worker resolves it on the next read). */
export function tournamentPhase(day: string, now: number): TournamentPhase {
  const s = tournamentSchedule(day);
  if (now < s.opensAt) return "upcoming";
  if (now < s.entryClosesAt) return "entry";
  if (now < s.revealClosesAt) return "reveal";
  if (now < s.resolvesAt) return "closing";
  return "resolved";
}

export interface TournamentFighter {
  wallet: string;
  commit: string;
  /** unix ms of the entry: the last tie-break, earlier first */
  enteredAt: number;
  circuit: Circuit;
}

export interface TournamentStanding extends TournamentFighter {
  /** 1-based and unique: the tie-breaks always separate two fighters */
  place: number;
  /** win 1, draw 0.5, loss 0, over 2 (n - 1) games */
  points: number;
  /**
   * The summed margin: own share minus 0.5 in every game (pA - 0.5 as A,
   * 0.5 - pA as B), so +|pA - 0.5| for a win and -|pA - 0.5| for a loss.
   */
  margin: number;
  wins: number;
  draws: number;
  losses: number;
  games: number;
}

export interface RoundRobin {
  /** in place order */
  standings: TournamentStanding[];
  /** matrix[i][j]: the exact pA with standings[i] as A and standings[j] as B; null on the diagonal */
  matrix: (number | null)[][];
}

/** Margins compare on a 1e-9 grid, so the order of a float sum can never reorder a tie. */
const marginKey = (m: number): number => Math.round(m * 1e9);

/** A fighter gate prepared once for the round robin: the gate and, for RY, cos and sin of the half angle. */
interface PreparedGate {
  g: GateName;
  c: number;
  n: number;
}

function prepareGate(gate: ArenaGate): PreparedGate {
  if (gate.g !== "RY") return { g: gate.g, c: 0, n: 0 };
  const half = ((gate.t ?? 0) * DEG) / 2;
  return { g: "RY", c: Math.cos(half), n: Math.sin(half) };
}

const LAYER_H: PreparedGate = prepareGate({ g: "H" });
const LAYER_RY: PreparedGate = prepareGate({ g: "RY", t: LAYER_RY_DEG });

/** applyGate in place: the same expressions in the same order, so the amplitudes are bitwise those of applyGate. */
function applyPrepared(re: Float64Array, im: Float64Array, q: number, gate: PreparedGate): void {
  const m = 1 << q;
  for (let i0 = 0; i0 < 4; i0++) {
    if ((i0 & m) !== 0) continue;
    const i1 = i0 | m;
    const r0 = re[i0];
    const r1 = re[i1];
    const m0 = im[i0];
    const m1 = im[i1];
    if (gate.g === "H") {
      const k = Math.SQRT1_2;
      re[i0] = (r0 + r1) * k;
      im[i0] = (m0 + m1) * k;
      re[i1] = (r0 - r1) * k;
      im[i1] = (m0 - m1) * k;
    } else if (gate.g === "X") {
      re[i0] = r1;
      im[i0] = m1;
      re[i1] = r0;
      im[i1] = m0;
    } else if (gate.g === "Z") {
      re[i1] = -r1;
      im[i1] = -m1;
    } else {
      re[i0] = gate.c * r0 - gate.n * r1;
      im[i0] = gate.c * m0 - gate.n * m1;
      re[i1] = gate.n * r0 + gate.c * r1;
      im[i1] = gate.n * m0 + gate.c * m1;
    }
  }
}

/**
 * runBout(a, b).pA without allocating: finalState's sequence (A.pre on q0,
 * B.pre on q1, H q0, CNOT q0 -> q1, RY(60) q1, A.post, B.post) on two
 * reused buffers. Bitwise equal to runBout's pA (the self-test checks it), and
 * several times faster, which keeps a 64-entry day (4,032 games) well inside
 * a Worker request's CPU budget.
 */
function preparedPA(
  a: { pre: PreparedGate[]; post: PreparedGate[] },
  b: { pre: PreparedGate[]; post: PreparedGate[] },
  re: Float64Array,
  im: Float64Array,
): number {
  re.fill(0);
  im.fill(0);
  re[0] = 1;
  for (const g of a.pre) applyPrepared(re, im, 0, g);
  for (const g of b.pre) applyPrepared(re, im, 1, g);
  applyPrepared(re, im, 0, LAYER_H);
  // CNOT(q0 -> q1): swaps the amplitudes of |q0=1, q1=0> (index 1) and |q0=1, q1=1> (index 3).
  const r1 = re[1];
  const m1 = im[1];
  re[1] = re[3];
  im[1] = im[3];
  re[3] = r1;
  im[3] = m1;
  applyPrepared(re, im, 1, LAYER_RY);
  for (const g of a.post) applyPrepared(re, im, 0, g);
  for (const g of b.post) applyPrepared(re, im, 1, g);
  return re[0] * re[0] + im[0] * im[0] + (re[3] * re[3] + im[3] * im[3]);
}

/** Points, then margin, then the earlier entry, then the wallet (only to make the order total). */
export function compareStandings(
  a: Pick<TournamentStanding, "points" | "margin" | "enteredAt" | "wallet">,
  b: Pick<TournamentStanding, "points" | "margin" | "enteredAt" | "wallet">,
): number {
  if (a.points !== b.points) return b.points - a.points;
  const ma = marginKey(a.margin);
  const mb = marginKey(b.margin);
  if (ma !== mb) return mb - ma;
  if (a.enteredAt !== b.enteredAt) return a.enteredAt - b.enteredAt;
  return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
}

/**
 * The full double round robin: every fighter plays every other once as A
 * and once as B, each game decided by the exact ranked rule (verdictOf).
 */
export function roundRobin(fighters: readonly TournamentFighter[]): RoundRobin {
  const n = fighters.length;
  const pa: number[][] = fighters.map(() => new Array<number>(n).fill(Number.NaN));
  const rows: TournamentStanding[] = fighters.map((f) => ({
    wallet: f.wallet,
    commit: f.commit,
    enteredAt: f.enteredAt,
    circuit: f.circuit,
    place: 0,
    points: 0,
    margin: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    games: 0,
  }));
  const prepared = fighters.map((f) => ({ pre: f.circuit.pre.map(prepareGate), post: f.circuit.post.map(prepareGate) }));
  const re = new Float64Array(4);
  const im = new Float64Array(4);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const p = preparedPA(prepared[i], prepared[j], re, im);
      pa[i][j] = p;
      const a = rows[i];
      const b = rows[j];
      a.games += 1;
      b.games += 1;
      a.margin += p - 0.5;
      b.margin += 0.5 - p;
      const v = verdictOf(p);
      if (v === "a") {
        a.points += 1;
        a.wins += 1;
        b.losses += 1;
      } else if (v === "b") {
        b.points += 1;
        b.wins += 1;
        a.losses += 1;
      } else {
        a.points += 0.5;
        b.points += 0.5;
        a.draws += 1;
        b.draws += 1;
      }
    }
  }
  const order = rows.map((_, i) => i).sort((x, y) => compareStandings(rows[x], rows[y]));
  return {
    standings: order.map((i, k) => ({ ...rows[i], place: k + 1 })),
    matrix: order.map((i) => order.map((j) => (i === j ? null : pa[i][j]))),
  };
}

/** One entry as everyone sees it: the circuit stays hidden until the day resolves. */
export interface TournamentEntrant {
  wallet: string;
  commit: string;
  enteredAt: number;
  revealedAt: number | null;
}

export interface TournamentResult {
  resolvedAt: number;
  /** the revealed fighters in place order, circuits public */
  standings: TournamentStanding[];
  /** entries that never revealed: listed, not played, no points, no badge */
  forfeits: TournamentEntrant[];
  /** standings order on both axes: matrix[i][j] = pA with i as A, j as B; null on the diagonal */
  matrix: (number | null)[][];
}

/** `GET /api/arena/tournament?day=` */
export interface TournamentView {
  day: string;
  phase: TournamentPhase;
  /** the server clock, unix ms */
  now: number;
  schedule: TournamentSchedule;
  maxEntries: number;
  counts: { entries: number; revealed: number };
  /** every entry in commit order */
  entrants: TournamentEntrant[];
  /** null until the day resolved, and for a past day nobody entered */
  result: TournamentResult | null;
}

/** `POST /api/arena/tournament/enter` */
export interface TournamentEnterResponse {
  entered: true;
  day: string;
  commit: string;
  enteredAt: number;
  /** entries for the day, this one included */
  entries: number;
}

/** `POST /api/arena/tournament/reveal`: the sender's own circuit echoed, it just sent the preimage. */
export interface TournamentRevealResponse {
  revealed: true;
  day: string;
  wallet: string;
  commit: string;
  circuit: Circuit;
  revealedAt: number;
}

export interface ArenaBadge {
  kind: "tournament";
  day: string;
  /** 1, 2 or 3 */
  place: number;
  awardedAt: number;
}

/** `GET /api/arena/badges?wallet=` */
export interface ArenaBadges {
  wallet: string;
  badges: ArenaBadge[];
}

/* ------------------------------------------------------------------ */
/* Challenges                                                          */
/* ------------------------------------------------------------------ */

/*
 * Puzzles checked in the browser with the same simulator: "against this
 * opponent, reach this number". A daily one is drawn from the pet's latest
 * day bits out of a fixed catalogue of eight kinds, with its threshold set
 * from the best any circuit can do (searched exhaustively, see
 * searchFamily), so every daily challenge is solvable; three lessons are
 * permanent. Nothing goes to the server.
 */

export type OutcomeLabel = "00" | "01" | "10" | "11";
export type ChallengeKind = "floor" | "window" | "exact" | "beat" | "hold" | "forbid" | "single" | "split";
export const CHALLENGE_KINDS: readonly ChallengeKind[] = ["floor", "window", "exact", "beat", "hold", "forbid", "single", "split"];
export const OUTCOME_NAMES: readonly OutcomeLabel[] = ["00", "01", "10", "11"];
/** "at least x" passes at x - 1e-9, "exactly x" within 1e-9, "impossible" below 1e-9: the ranked tolerance. */
export const CHALLENGE_EPS = DRAW_EPS;

export interface Challenge {
  /** "daily:<pet day>:<bits>" or "lesson:<name>": the key a solve is remembered under */
  id: string;
  kind: ChallengeKind;
  title: string;
  /** the task in one sentence */
  task: string;
  hint: string | null;
  /** the side your circuit plays */
  role: "a" | "b";
  opponent: Circuit;
  opponentName: string;
  /** floor, forbid */
  outcome: OutcomeLabel | null;
  /** floor, window, beat, forbid, single, split: the value must reach this */
  min: number | null;
  /** window, hold: the value must stay at or under this */
  max: number | null;
  /** exact: pA must equal this within 1e-9 */
  target: number | null;
  /** single: at most this many gates */
  maxGates: number | null;
}

export interface ChallengeCheck {
  solved: boolean;
  probs: Probabilities;
  /** the number the goal reads: pA, p of the named outcome, or min(p00, p11) for split */
  value: number;
  /** a side condition that failed (the gate budget, the pA floor of forbid), or null */
  unmet: string | null;
}

export function outcomeOf(p: Probabilities, o: OutcomeLabel): number {
  return o === "00" ? p.p00 : o === "01" ? p.p01 : o === "10" ? p.p10 : p.p11;
}

const atLeast = (v: number, x: number | null): boolean => x === null || v >= x - CHALLENGE_EPS;
const atMost = (v: number, x: number | null): boolean => x === null || v <= x + CHALLENGE_EPS;
const fmt2 = (x: number | null): string => (x === null ? "—" : x.toFixed(2));

/** Runs the circuit on its side against the challenge's opponent and reads the goal exactly. */
export function checkChallenge(ch: Challenge, circuit: Circuit): ChallengeCheck {
  const probs = ch.role === "a" ? runBout(circuit, ch.opponent) : runBout(ch.opponent, circuit);
  const pA = probs.pA;
  const o = ch.outcome ? outcomeOf(probs, ch.outcome) : 0;
  switch (ch.kind) {
    case "floor":
      return { solved: atLeast(o, ch.min), probs, value: o, unmet: null };
    case "window":
      return { solved: atLeast(pA, ch.min) && atMost(pA, ch.max), probs, value: pA, unmet: null };
    case "exact":
      return { solved: Math.abs(pA - (ch.target ?? 0.5)) <= CHALLENGE_EPS, probs, value: pA, unmet: null };
    case "beat":
      return { solved: atLeast(pA, ch.min), probs, value: pA, unmet: null };
    case "hold":
      return { solved: atMost(pA, ch.max), probs, value: pA, unmet: null };
    case "forbid": {
      const ruledOut = o <= CHALLENGE_EPS;
      const floorOk = atLeast(pA, ch.min);
      return {
        solved: ruledOut && floorOk,
        probs,
        value: o,
        unmet: ruledOut && !floorOk ? `pA ${pA.toFixed(3)} is under ${fmt2(ch.min)}` : null,
      };
    }
    case "single": {
      const n = gateCount(circuit);
      const within = ch.maxGates === null || n <= ch.maxGates;
      return {
        solved: within && atLeast(pA, ch.min),
        probs,
        value: pA,
        unmet: within ? null : `${n} gates, the budget is ${ch.maxGates}`,
      };
    }
    case "split": {
      const v = Math.min(probs.p00, probs.p11);
      return { solved: atLeast(v, ch.min), probs, value: v, unmet: null };
    }
  }
}

/** The goal in one line: "p11 ≥ 0.75", "0.70 ≤ pA ≤ 0.80", "pA = 0.5 within 1e-9". */
export function challengeGoal(ch: Challenge): string {
  switch (ch.kind) {
    case "floor":
      return `p${ch.outcome} ≥ ${fmt2(ch.min)}`;
    case "window":
      return `${fmt2(ch.min)} ≤ pA ≤ ${fmt2(ch.max)}`;
    case "exact":
      return `pA = ${ch.target ?? 0.5} within 1e-9`;
    case "beat":
      return `pA ≥ ${fmt2(ch.min)}`;
    case "hold":
      return `pA ≤ ${fmt2(ch.max)}, you are B`;
    case "forbid":
      return ch.min === null ? `p${ch.outcome} < 1e-9` : `p${ch.outcome} < 1e-9 and pA ≥ ${fmt2(ch.min)}`;
    case "single":
      return `pA ≥ ${fmt2(ch.min)} with at most ${ch.maxGates ?? 1} gate`;
    case "split":
      return `p00 ≥ ${fmt2(ch.min)} and p11 ≥ ${fmt2(ch.min)}`;
  }
}

/** RY angles that give distinct rotations up to a global sign: -175..180 (RY(t + 360) = -RY(t)). */
const SEARCH_ANGLES: readonly number[] = Array.from(
  { length: (ANGLE_MAX - ANGLE_MIN) / ANGLE_STEP },
  (_, i) => ANGLE_MIN + ANGLE_STEP * (i + 1),
);
let searchFamilyCache: readonly Circuit[] | null = null;
let singleFamilyCache: readonly Circuit[] | null = null;

/**
 * Circuits that between them produce every outcome distribution one side can
 * reach. Every gate is a real orthogonal matrix (H = RY(90)·Z, X = RY(180)·Z),
 * so a pre slot can only make cos a|0⟩ + sin a|1⟩ with a on the 2.5-degree
 * grid, which one RY reaches, and any two post gates multiply to a rotation,
 * or a rotation after Z, on the same grid. Hence: pre [RY t] with post
 * [RY u] or [Z, RY u], over the 72 angles distinct up to sign: 10,368
 * circuits. A maximum over this family is the maximum over all circuits.
 */
export function searchFamily(): readonly Circuit[] {
  if (searchFamilyCache) return searchFamilyCache;
  const out: Circuit[] = [];
  for (const t of SEARCH_ANGLES) {
    const pre: ArenaGate[] = [{ g: "RY", t }];
    for (const u of SEARCH_ANGLES) out.push({ v: 1, pre, post: [{ g: "RY", t: u }] });
    for (const u of SEARCH_ANGLES) out.push({ v: 1, pre, post: [{ g: "Z" }, { g: "RY", t: u }] });
  }
  searchFamilyCache = Object.freeze(out);
  return searchFamilyCache;
}

/** Every circuit of at most one gate: the empty one, then each gate alone in pre or in post. */
export function singleGateFamily(): readonly Circuit[] {
  if (singleFamilyCache) return singleFamilyCache;
  const gates: ArenaGate[] = [{ g: "H" }, { g: "X" }, { g: "Z" }, ...SEARCH_ANGLES.map((t): ArenaGate => ({ g: "RY", t }))];
  const out: Circuit[] = [emptyCircuit()];
  for (const g of gates) out.push({ v: 1, pre: [g], post: [] });
  for (const g of gates) out.push({ v: 1, pre: [], post: [g] });
  singleFamilyCache = Object.freeze(out);
  return singleFamilyCache;
}

/** The first circuit of the search family that solves the challenge, or null when none does. */
export function solveChallenge(ch: Challenge): Circuit | null {
  const family = ch.kind === "single" ? singleGateFamily() : searchFamily();
  for (const c of family) if (checkChallenge(ch, c).solved) return c;
  return null;
}

const EMPTY_OPPONENT = "empty opponent";
const LESSON_HINT = "Leave pre empty. With one post RY(u), pA = cos²((u − 60)/2): the layer tilts q1 by 60 degrees.";

function lesson(id: string, title: string, target: number, task: string, hint: string): Challenge {
  return {
    id: `lesson:${id}`,
    kind: "exact",
    title,
    task,
    hint,
    role: "a",
    opponent: emptyCircuit(),
    opponentName: EMPTY_OPPONENT,
    outcome: null,
    min: null,
    max: null,
    target,
    maxGates: null,
  };
}

/** Three permanent onboarding puzzles, all against the empty circuit. */
export const LESSONS: readonly Challenge[] = Object.freeze([
  lesson("certain", "Certain win", 1, "Against an empty opponent, make pA exactly 1.", LESSON_HINT),
  lesson("zero", "Certain loss", 0, "Against an empty opponent, make pA exactly 0.", "Same formula: find the u where the cosine vanishes."),
  lesson("draw", "Exact draw", 0.5, "Against an empty opponent, make pA exactly 0.5.", "Same formula: cos² is one half 45 degrees off the peak."),
]);

const floor20 = (x: number): number => Math.floor(x * 20 + 1e-9) / 20;
const ceil20 = (x: number): number => Math.ceil(x * 20 - 1e-9) / 20;
/** How far under the best reachable value a threshold sits, so ulp-level engine differences never matter. */
const SLACK = 0.02;
const OPPONENT_NAMES = ["house fighter", EMPTY_OPPONENT, "rival"] as const;

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

interface Tables {
  /** every reachable distribution with your circuit as A */
  asA(): readonly Probabilities[];
  /** with your circuit as B */
  asB(): readonly Probabilities[];
  /** as A with at most one gate */
  single(): readonly Probabilities[];
}

function tablesFor(opponent: Circuit): Tables {
  let a: Probabilities[] | null = null;
  let b: Probabilities[] | null = null;
  let s: Probabilities[] | null = null;
  return {
    asA: () => (a ??= searchFamily().map((c) => runBout(c, opponent))),
    asB: () => (b ??= searchFamily().map((c) => runBout(opponent, c))),
    single: () => (s ??= singleGateFamily().map((c) => runBout(c, opponent))),
  };
}

const maxOf = (xs: readonly number[]): number => xs.reduce((m, x) => (x > m ? x : m), Number.NEGATIVE_INFINITY);
const minOf = (xs: readonly number[]): number => xs.reduce((m, x) => (x < m ? x : m), Number.POSITIVE_INFINITY);

function buildChallenge(kind: ChallengeKind, base: Challenge, t: Tables, outcome: OutcomeLabel, windowPick: number): Challenge | null {
  const opp = base.opponentName;
  switch (kind) {
    case "floor": {
      const min = Math.min(0.95, floor20(maxOf(t.asA().map((p) => outcomeOf(p, outcome))) - SLACK));
      if (min < 0.25) return null;
      return { ...base, kind, outcome, min, title: `Weight on |${outcome}⟩`, task: `Against the ${opp}, put at least ${fmt2(min)} on |${outcome}⟩.` };
    }
    case "window": {
      const idle = runBout(emptyCircuit(), base.opponent).pA;
      const pas = t.asA().map((p) => p.pA);
      const options: number[] = [];
      for (let k = 1; k <= 17; k++) {
        const lo = k / 20;
        const hi = (k + 2) / 20;
        if (idle >= lo - SLACK && idle <= hi + SLACK) continue;
        if (pas.some((v) => v >= lo + SLACK / 2 && v <= hi - SLACK / 2)) options.push(k);
      }
      if (options.length === 0) return null;
      const k = options[Math.min(options.length - 1, Math.floor(windowPick * options.length))];
      const min = k / 20;
      const max = (k + 2) / 20;
      return { ...base, kind, min, max, title: "Thread the window", task: `Against the ${opp}, land pA between ${fmt2(min)} and ${fmt2(max)}.` };
    }
    case "exact": {
      if (!t.asA().some((p) => Math.abs(p.pA - 0.5) <= 1e-12)) return null;
      return { ...base, kind, target: 0.5, title: "Dead heat", task: `Against the ${opp}, make pA exactly 0.5: a draw within 1e-9.` };
    }
    case "beat": {
      const min = Math.min(0.95, floor20(maxOf(t.asA().map((p) => p.pA)) - SLACK));
      if (min < 0.6) return null;
      return { ...base, kind, min, title: "Clear win", task: `Beat the ${opp} with pA of at least ${fmt2(min)}.` };
    }
    case "hold": {
      const max = Math.max(0.05, ceil20(minOf(t.asB().map((p) => p.pA)) + SLACK));
      if (max > 0.4) return null;
      return { ...base, kind, role: "b", max, title: "Hold the line", task: `Play B against the ${opp} as A: keep pA at or under ${fmt2(max)}.` };
    }
    case "forbid": {
      const clean = t.asA().filter((p) => outcomeOf(p, outcome) <= 1e-12);
      if (clean.length === 0) return null;
      const best = floor20(maxOf(clean.map((p) => p.pA)) - SLACK);
      const min = best >= 0.3 ? Math.min(0.95, best) : null;
      return {
        ...base,
        kind,
        outcome,
        min,
        title: `Rule out |${outcome}⟩`,
        task: `Against the ${opp}, make |${outcome}⟩ impossible${min === null ? "" : ` and keep pA at or above ${fmt2(min)}`}.`,
      };
    }
    case "single": {
      const min = Math.min(0.95, floor20(maxOf(t.single().map((p) => p.pA)) - SLACK));
      if (min < 0.6) return null;
      return { ...base, kind, min, maxGates: 1, title: "One gate", task: `Beat the ${opp} with a single gate: pA of at least ${fmt2(min)}.` };
    }
    case "split": {
      const min = floor20(maxOf(t.asA().map((p) => Math.min(p.p00, p.p11))) - SLACK);
      if (min < 0.2) return null;
      return { ...base, kind, min, title: "Even split", task: `Against the ${opp}, put at least ${fmt2(min)} on both |00⟩ and |11⟩.` };
    }
  }
}

/**
 * The challenge of a day, from the pet's collapsed bits:
 * rng = mulberry32(seedToUint32(sha256Hex("dirac:arena:challenge:v1:" + bits)))
 * draws, in this order, the opponent (house fighter, empty, rival), the order
 * in which the eight kinds are tried (Fisher-Yates), the outcome for floor and
 * forbid, and the window pick. The first kind that is solvable against that
 * opponent and not already solved by the empty circuit wins; its threshold
 * sits 0.02 under the best reachable value, on a 0.05 grid. Same bits, same
 * challenge, in every browser.
 */
export function dailyChallenge(dayBits: string, day: number | null = null): Challenge {
  const bits = isDayBits(dayBits) ? dayBits : DEFAULT_DAY_BITS;
  const rng = mulberry32(seedToUint32(sha256Hex(`dirac:arena:challenge:v1:${bits}`)));
  const opponentPick = Math.floor(rng() * OPPONENT_NAMES.length);
  const order = shuffled(CHALLENGE_KINDS, rng);
  const outcome = OUTCOME_NAMES[Math.floor(rng() * OUTCOME_NAMES.length)];
  const windowPick = rng();

  const opponent = opponentPick === 0 ? houseFighter(bits) : opponentPick === 1 ? emptyCircuit() : rivalFighter(bits);
  const base: Challenge = {
    id: `daily:${day ?? "-"}:${bits}`,
    kind: "floor",
    title: "",
    task: "",
    hint: null,
    role: "a",
    opponent,
    opponentName: OPPONENT_NAMES[opponentPick],
    outcome: null,
    min: null,
    max: null,
    target: null,
    maxGates: null,
  };
  const tables = tablesFor(opponent);
  const idle = emptyCircuit();
  for (const kind of order) {
    const ch = buildChallenge(kind, base, tables, outcome, windowPick);
    if (ch && !checkChallenge(ch, idle).solved) return ch;
  }
  // Not reached for any bits the self-test samples; a certain win against the empty circuit is always solvable.
  return { ...LESSONS[0], id: base.id, hint: null };
}

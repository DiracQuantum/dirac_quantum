/**
 * Quantum pet: one 10-qubit register that every visitor shares.
 *
 * Routes (JSON, CORS "*"), mounted by worker/index.ts through `handlePet`:
 *   GET  /api/pet[?wallet=]         the live state (collapses lazily when the day is over);
 *                                   with a wallet also its signed gates today (`myGates`)
 *   POST /api/pet/act               apply one gate: { gate, q, t? } anonymously, or
 *                                   { gate, q, t?, day, wallet, nonce, sig } signed by a wallet
 *   GET  /api/pet/history?limit=30  collapsed days, newest first (max 90), with the influencer wallet
 *   GET  /api/pet/badges?wallet=    the wallet's badges, newest day first
 *   GET  /api/pet/qpu[?day=N[&format=qasm]]  the weekly hardware runs (newest 12), one run, or its circuit
 *   GET  /api/pet/qpu/check         read-only check of the live IBM service: IAM, instance, usage,
 *                                   backends, the Sunday's backend and chain choice; nothing is sent
 *                                   (2 a minute per IP, one live check per 5 minutes, cached in qpu_check)
 *   POST /api/pet/qpu/smoke         send one Bell-pair job through the Sunday's path (one that ran per
 *                                   6 days, one pending at a time, inside the monthly QPU budget)
 *   GET  /api/pet/qpu/smoke         the latest smoke job; an open one is polled (once per 30 s, shared)
 *
 * Cron (`scheduled` in worker/index.ts): `collapsePet(env)` measures the whole
 * register at 00:00 UTC, records the day in `pet_days`, awards the badges,
 * starts the next day with a fresh superposition and posts the result to X
 * when the secrets are set. A second call in the same UTC day is a no-op, and
 * GET /api/pet runs the same collapse when the cron missed, so the state is
 * never stale.
 *
 * Sundays on IBM hardware (SPEC 3.6, worker/qpu.ts, migrations/0012_pet_qpu.sql):
 * the Sunday 00:00 UTC collapse, when the IBM_QUANTUM_API_KEY secret is set,
 * the quota allows and the day's log rebuilds the stored state exactly, is
 * not drawn here. The day's state goes to `pet_qpu_runs`, the next day starts
 * as usual, and `pollQpu(env)` (a cron every 15 minutes, and GET /api/pet at
 * most once a minute) sends the circuit to the least busy IBM CZ backend, follows the job
 * and, when it completes, writes the day with the hardware's bits, backend
 * and job id. The day's partial measurements happen again on the chip, so
 * only shots that repeat the site's outcomes count (post-selection). A job
 * that fails, cannot be sent, has no such shot, or has not finished six hours
 * after the collapse falls back to a simulator draw of the stored state, and
 * the day records why. Until then the body stays on the day before.
 *
 * Signed gates (src/lib/petGate.ts): the wallet signs
 * "dirac:pet:gate:v1:<day>:<gate>:<q>:<t or ->:<nonce>" with Ed25519; the
 * Worker checks the signature, refuses another day and a nonce it has seen
 * (`pet_nonces`), and writes the wallet next to the gate. At the collapse
 * every wallet with a signed gate gets the "witness" badge for the day and
 * the one with the most signed gates (ties: the one that reached the count
 * first) the "influencer" badge; the day row keeps that wallet and count.
 *
 * The physics lives in the first half of this file as pure functions over
 * { re, im } Float64Arrays (basis index bit i = qubit i) and is exported for
 * the self-test (scripts/pet-selftest.ts). Gates return new states; nothing
 * is mutated in place.
 *
 * Rate limits, counted in the shared D1 `ratelimit` table (fixed one-minute
 * windows): one anonymous gate per minute per client IP (bucket "pet"), three
 * signed gates per minute per wallet (bucket "petw") and six per client IP
 * across wallets (bucket "petip"); refused gates count per client IP too
 * (bucket "petbad", 20 per minute). The counts are read before anything
 * costly, so an exhausted window costs one read, and incremented only after
 * the rules, so a refused gate spends no slot. Against throwaway wallets
 * (migrations/0009_pet_sybil.sql): one client IP may sign with three wallets
 * a UTC day (`pet_wallet_ips`, hashed address) and the wallet must have an
 * account on Solana (getAccountInfo through the Worker's RPC rotation,
 * cached in `pet_wallets`). Badges follow from the gates written, so they
 * obey the same rules.
 */

import type {
  Gate,
  PetAction,
  PetBadge,
  PetDay,
  PetLeader,
  PetOutcome,
  PetQpu,
  PetQpuCompare,
  PetQpuRun,
  PetQpuStatus,
  PetQubit,
  PetState,
} from "../src/lib/pet";
import {
  ANON_PET_LIMIT,
  GATE_MESSAGE,
  PET_WINDOW_MS,
  SIGNED_IP_LIMIT,
  SIGNED_PET_LIMIT,
  WALLETS_PER_IP_PER_DAY,
  isGateNonce,
  isWalletAddress,
  verifyGateSig,
} from "../src/lib/petGate";
import {
  COLLAPSE_SHOTS,
  DISTRIBUTION_SHOTS,
  IbmError,
  MAX_SUBMIT_ATTEMPTS,
  MAX_TWO_QUBIT_GATES,
  MIN_EXPECTED_MATCHES,
  MONTH_BUDGET_SECONDS,
  QPU_POLL_GAP_MS,
  SMOKE_DEADLINE_MS,
  SMOKE_EVERY_MS,
  SMOKE_POLL_GAP_MS,
  SMOKE_RETRY_GAP_MS,
  SMOKE_SHOTS,
  SUBMIT_LEASE_MS,
  SUBMIT_RETRY_GAP_MS,
  UNKNOWN_USAGE_SECONDS,
  bellSummary,
  buildCircuit,
  compareDistributions,
  connect,
  deadlineOf,
  deadlinePassed,
  finishedAtFrom,
  forgetToken,
  instanceQuotaVerdict,
  isQpuCollapse,
  jobPhaseFrom,
  logFromRows,
  monthStart,
  nextQpuCollapse,
  parseSamplerResult,
  publicReason,
  quotaVerdict,
  readSmokeResult,
  runQpuCheck,
  smokeTag,
  smokeVerdict,
  submitDay,
  submitSmoke,
  usageSecondsFrom,
  type ActionLogRow,
  type IbmQuantum,
  type LogGate,
  type QpuCheck,
  type SamplerOutcome,
  type SmokeReading,
} from "./qpu";
import { postDayToX } from "./x";

export interface Env {
  DB: D1Database;
  SITE_URL?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
  /** IBM Cloud API key (`wrangler secret put IBM_QUANTUM_API_KEY`); without it every day is drawn on the simulator */
  IBM_QUANTUM_API_KEY?: string;
  /** optional: the IBM Quantum instance CRN, when the key cannot list the account's instances */
  IBM_QUANTUM_CRN?: string;
}

/** What the router hands the module beyond the bindings. */
export interface PetDeps {
  /**
   * One Solana JSON-RPC call through the Worker's upstream rotation
   * (worker/index.ts `rpcCall`); throws on failure. Without it the on-chain
   * wallet check is skipped (the self-tests), never in production.
   */
  rpc?: (method: string, params: unknown) => Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* Physics                                                             */
/* ------------------------------------------------------------------ */

export const N_QUBITS = 10;
/** 2^10 basis states. */
export const DIM = 1 << N_QUBITS;

/** A state vector: amplitude of basis state i is re[i] + i·im[i]. */
export interface QState {
  re: Float64Array;
  im: Float64Array;
}

/** The JSON form of a state: 2 × 1024 numbers rounded to 1e-12. */
export interface SerialisedState {
  re: number[];
  im: number[];
}

const emptyState = (): QState => ({ re: new Float64Array(DIM), im: new Float64Array(DIM) });

export const cloneState = (s: QState): QState => ({ re: Float64Array.from(s.re), im: Float64Array.from(s.im) });

/** |0…0⟩ */
export function zeroState(): QState {
  const s = emptyState();
  s.re[0] = 1;
  return s;
}

/** The day-start state: |0…0⟩ then H on every qubit, so every outcome is equally likely. */
export function dayStartState(): QState {
  let s = zeroState();
  for (let q = 0; q < N_QUBITS; q++) s = H(s, q);
  return s;
}

export const isQubitIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < N_QUBITS;

function assertQubit(q: number, what = "qubit"): void {
  if (!isQubitIndex(q)) throw new RangeError(`${what} must be an integer in 0..${N_QUBITS - 1}`);
}

/** Calls `fn(i0, i1)` for every pair of basis states that differ only in bit q (i0 has the bit clear). */
function forEachPair(q: number, fn: (i0: number, i1: number) => void): void {
  const mask = 1 << q;
  for (let i = 0; i < DIM; i++) {
    if ((i & mask) === 0) fn(i, i | mask);
  }
}

/** Hadamard: H = 1/√2 [[1, 1], [1, −1]] on qubit q. */
export function H(state: QState, q: number): QState {
  assertQubit(q);
  const out = cloneState(state);
  const k = Math.SQRT1_2;
  forEachPair(q, (i0, i1) => {
    const r0 = state.re[i0];
    const m0 = state.im[i0];
    const r1 = state.re[i1];
    const m1 = state.im[i1];
    out.re[i0] = (r0 + r1) * k;
    out.im[i0] = (m0 + m1) * k;
    out.re[i1] = (r0 - r1) * k;
    out.im[i1] = (m0 - m1) * k;
  });
  return out;
}

/** Pauli X (bit flip) on qubit q. */
export function X(state: QState, q: number): QState {
  assertQubit(q);
  const out = cloneState(state);
  forEachPair(q, (i0, i1) => {
    out.re[i0] = state.re[i1];
    out.im[i0] = state.im[i1];
    out.re[i1] = state.re[i0];
    out.im[i1] = state.im[i0];
  });
  return out;
}

/** Rotation about Y: RY(θ) = [[cos θ/2, −sin θ/2], [sin θ/2, cos θ/2]] on qubit q. */
export function RY(state: QState, q: number, theta: number): QState {
  assertQubit(q);
  if (!Number.isFinite(theta)) throw new RangeError("theta must be a finite angle");
  const out = cloneState(state);
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  forEachPair(q, (i0, i1) => {
    const r0 = state.re[i0];
    const m0 = state.im[i0];
    const r1 = state.re[i1];
    const m1 = state.im[i1];
    out.re[i0] = c * r0 - s * r1;
    out.im[i0] = c * m0 - s * m1;
    out.re[i1] = s * r0 + c * r1;
    out.im[i1] = s * m0 + c * m1;
  });
  return out;
}

/** Controlled NOT: flips qubit t in every basis state where bit c is 1. */
export function CNOT(state: QState, c: number, t: number): QState {
  assertQubit(c, "control");
  assertQubit(t, "target");
  if (c === t) throw new RangeError("control and target must differ");
  const out = cloneState(state);
  const cm = 1 << c;
  const tm = 1 << t;
  for (let i = 0; i < DIM; i++) {
    if ((i & cm) !== 0 && (i & tm) === 0) {
      const j = i | tm;
      out.re[i] = state.re[j];
      out.im[i] = state.im[j];
      out.re[j] = state.re[i];
      out.im[j] = state.im[i];
    }
  }
  return out;
}

/** |a_i|² for every basis state. */
export function probabilities(state: QState): Float64Array {
  const p = new Float64Array(DIM);
  for (let i = 0; i < DIM; i++) p[i] = state.re[i] * state.re[i] + state.im[i] * state.im[i];
  return p;
}

/** Σ|a_i|², 1 for a normalised state. */
export function normSquared(state: QState): number {
  let total = 0;
  for (let i = 0; i < DIM; i++) total += state.re[i] * state.re[i] + state.im[i] * state.im[i];
  return total;
}

/** P(qubit q reads 1) for every qubit. */
export function qubitP1(state: QState): number[] {
  const p = probabilities(state);
  const out = new Array<number>(N_QUBITS).fill(0);
  for (let i = 0; i < DIM; i++) {
    if (p[i] === 0) continue;
    for (let q = 0; q < N_QUBITS; q++) {
      if ((i & (1 << q)) !== 0) out[q] += p[i];
    }
  }
  return out;
}

/**
 * Uniform in [0, 1) with 53 random bits from `crypto.getRandomValues`
 * (32 from the first word, 21 from the second), so every double in the
 * range is reachable and the outcome never rounds to 1.
 */
export function randomUnit(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return (words[0] * 2 ** 21 + (words[1] >>> 11)) / 2 ** 53;
}

export type RandomSource = () => number;

/**
 * Measures qubit q: p1 = Σ|a|² over basis states with bit q set, the outcome
 * is 1 when a uniform draw is below p1, the other branch is zeroed and the
 * rest renormalised. Returns the outcome and the collapsed state.
 */
export function measure(state: QState, q: number, random: RandomSource = randomUnit): { outcome: 0 | 1; state: QState } {
  assertQubit(q);
  const mask = 1 << q;
  const p = probabilities(state);
  let total = 0;
  let p1 = 0;
  for (let i = 0; i < DIM; i++) {
    total += p[i];
    if ((i & mask) !== 0) p1 += p[i];
  }
  if (!(total > 0)) throw new RangeError("state has zero norm");

  let outcome: 0 | 1 = random() * total < p1 ? 1 : 0;
  let mass = outcome === 1 ? p1 : total - p1;
  // A branch with no probability cannot be observed; rounding must not pick it.
  if (mass <= Number.EPSILON * total) {
    outcome = outcome === 1 ? 0 : 1;
    mass = outcome === 1 ? p1 : total - p1;
  }
  const scale = 1 / Math.sqrt(mass);
  const out = emptyState();
  for (let i = 0; i < DIM; i++) {
    if (((i & mask) !== 0) === (outcome === 1)) {
      out.re[i] = state.re[i] * scale;
      out.im[i] = state.im[i] * scale;
    }
  }
  return { outcome, state: out };
}

/** Samples one basis state from |a|² and returns its 10-bit string, bit 0 (qubit 0) first. */
export function measureAll(state: QState, random: RandomSource = randomUnit): string {
  const p = probabilities(state);
  let total = 0;
  for (let i = 0; i < DIM; i++) total += p[i];
  if (!(total > 0)) throw new RangeError("state has zero norm");
  const r = random() * total;
  let acc = 0;
  let last = 0;
  for (let i = 0; i < DIM; i++) {
    if (p[i] <= 0) continue;
    last = i;
    acc += p[i];
    if (r < acc) return bitsOf(i);
  }
  // Rounding left r just above the accumulated total: the last reachable state.
  return bitsOf(last);
}

/** The 10-character bit string of a basis index, bit 0 first. */
export function bitsOf(index: number): string {
  let bits = "";
  for (let q = 0; q < N_QUBITS; q++) bits += (index >> q) & 1;
  return bits;
}

const BITS_PATTERN = /^[01]{10}$/;
export const isBits = (value: unknown): value is string => typeof value === "string" && BITS_PATTERN.test(value);

/** The basis index of a 10-character bit string (bit 0 first). */
export function indexOf(bits: string): number {
  if (!isBits(bits)) throw new RangeError("bits must be 10 characters of 0 and 1");
  let index = 0;
  for (let q = 0; q < N_QUBITS; q++) {
    if (bits[q] === "1") index |= 1 << q;
  }
  return index;
}

/** The probability of one bit string. */
export function probabilityOf(state: QState, bits: string): number {
  const i = indexOf(bits);
  return state.re[i] * state.re[i] + state.im[i] * state.im[i];
}

/* --- replay ------------------------------------------------------------ */

/**
 * Qubit q projected onto a known outcome and renormalised: a logged MEASURE
 * replayed with the result the site drew. Null when that outcome has no
 * probability in `state`.
 */
export function projectOnto(state: QState, q: number, outcome: 0 | 1): QState | null {
  assertQubit(q);
  const mask = 1 << q;
  let mass = 0;
  for (let i = 0; i < DIM; i++) {
    if (((i & mask) !== 0) === (outcome === 1)) mass += state.re[i] * state.re[i] + state.im[i] * state.im[i];
  }
  if (!(mass > 1e-12)) return null;
  const scale = 1 / Math.sqrt(mass);
  const out = emptyState();
  for (let i = 0; i < DIM; i++) {
    if (((i & mask) !== 0) === (outcome === 1)) {
      out.re[i] = state.re[i] * scale;
      out.im[i] = state.im[i] * scale;
    }
  }
  return out;
}

/** |⟨a|b⟩|² over the norms: 1 when the two states are equal up to a global phase. */
export function stateFidelity(a: QState, b: QState): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < DIM; i++) {
    re += a.re[i] * b.re[i] + a.im[i] * b.im[i];
    im += a.re[i] * b.im[i] - a.im[i] * b.re[i];
  }
  const norms = normSquared(a) * normSquared(b);
  return norms > 0 ? (re * re + im * im) / norms : 0;
}

/**
 * A day's state rebuilt from its gate log: the day-start state, then every
 * gate in order, each MEASURE forced to its logged outcome. Null when a
 * logged outcome is impossible.
 */
export function replayLog(gates: LogGate[]): QState | null {
  return replayWithOdds(gates)?.state ?? null;
}

/** P(qubit q reads `outcome`) in `state`. */
function outcomeMass(state: QState, q: number, outcome: 0 | 1): number {
  const mask = 1 << q;
  let mass = 0;
  for (let i = 0; i < DIM; i++) {
    if (((i & mask) !== 0) === (outcome === 1)) mass += state.re[i] * state.re[i] + state.im[i] * state.im[i];
  }
  return mass;
}

/**
 * `replayLog`, plus `pMids`: the probability that the day's measurements
 * give the logged outcomes, in order. On the chip, that is the share of
 * shots that repeat them and so count as draws of the site's register.
 */
export function replayWithOdds(gates: LogGate[]): { state: QState; pMids: number } | null {
  let s: QState | null = dayStartState();
  let pMids = 1;
  for (const g of gates) {
    if (s === null) return null;
    if (g.gate === "MEASURE") pMids *= outcomeMass(s, g.q, g.outcome);
    switch (g.gate) {
      case "H":
        s = H(s, g.q);
        break;
      case "X":
        s = X(s, g.q);
        break;
      case "CNOT":
        s = CNOT(s, g.q, g.t);
        break;
      case "MUTATE":
        s = RY(s, g.q, g.theta);
        break;
      case "MEASURE":
        s = projectOnto(s, g.q, g.outcome);
        break;
      case "PROTECT":
        break;
    }
  }
  return s === null ? null : { state: s, pMids };
}

/** A replay this close to the stored state (rounding to 1e-12 per stored gate) is the same state. */
export const REPLAY_FIDELITY = 1 - 1e-6;

/* --- traits ----------------------------------------------------------- */

export const TRAITS = {
  /** bits 0..2 */
  form: ["cat", "virus", "black hole", "cube", "moth", "jellyfish", "crystal", "fox"],
  /** bits 3..4 */
  character: ["curious", "sleepy", "chaotic", "stoic"],
  /** bits 5..7 */
  ability: [
    "phase shift",
    "tunneling",
    "entanglement",
    "decoherence",
    "teleportation",
    "superposition",
    "interference",
    "measurement",
  ],
  /** bits 8..9 */
  palette: ["ice", "ember", "violet", "mint"],
} as const;

export interface Traits {
  form: string;
  character: string;
  ability: string;
  palette: string;
}

/** Day 1 has no previous collapse; this is its body. */
export const DAY_ONE_BODY: Traits = { form: "cat", character: "curious", ability: "superposition", palette: "ice" };

/** The value of bits[from..from+width) read as a little-endian integer (bit i = qubit i). */
function field(bits: string, from: number, width: number): number {
  let value = 0;
  for (let k = 0; k < width; k++) {
    if (bits[from + k] === "1") value |= 1 << k;
  }
  return value;
}

/** The body a 10-bit string collapses into. */
export function traitsFromBits(bits: string): Traits {
  if (!isBits(bits)) throw new RangeError("bits must be 10 characters of 0 and 1");
  return {
    form: TRAITS.form[field(bits, 0, 3)],
    character: TRAITS.character[field(bits, 3, 2)],
    ability: TRAITS.ability[field(bits, 5, 3)],
    palette: TRAITS.palette[field(bits, 8, 2)],
  };
}

/** P(form) for each of the eight forms, from the low three bits of every basis state. */
export function formProbabilities(state: QState): Record<string, number> {
  const p = probabilities(state);
  const out: Record<string, number> = {};
  for (const form of TRAITS.form) out[form] = 0;
  for (let i = 0; i < DIM; i++) out[TRAITS.form[i & 7]] += p[i];
  return out;
}

/** The n most likely outcomes, highest first (ties: lower index first). */
export function topOutcomes(state: QState, n: number): { bits: string; p: number }[] {
  const p = probabilities(state);
  const order: number[] = [];
  for (let i = 0; i < DIM; i++) order.push(i);
  order.sort((a, b) => p[b] - p[a] || a - b);
  return order.slice(0, Math.max(0, n)).map((i) => ({ bits: bitsOf(i), p: p[i] }));
}

/* --- serialisation ------------------------------------------------------ */

const round12 = (v: number): number => {
  const r = Math.round(v * 1e12) / 1e12;
  return r === 0 ? 0 : r;
};

export function serialise(state: QState): SerialisedState {
  return { re: Array.from(state.re, round12), im: Array.from(state.im, round12) };
}

function isNumberArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((v) => typeof v === "number" && Number.isFinite(v));
}

/** Rebuilds a state from its JSON form; throws on anything but 2 × 1024 finite numbers. */
export function deserialise(data: unknown): QState {
  if (typeof data !== "object" || data === null) throw new TypeError("state must be an object");
  const { re, im } = data as Record<string, unknown>;
  if (!isNumberArray(re, DIM) || !isNumberArray(im, DIM)) {
    throw new TypeError(`state needs re and im arrays of ${DIM} finite numbers`);
  }
  return { re: Float64Array.from(re), im: Float64Array.from(im) };
}

/* --- day boundary ------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The next 00:00 UTC after `dayStartedAt` (unix ms). */
export const collapseAtFor = (dayStartedAt: number): number => Math.floor(dayStartedAt / DAY_MS) * DAY_MS + DAY_MS;

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PROTECT_MS = 30 * 60 * 1000;
const MAX_PROTECTED = 3;
const TOP_OUTCOMES = 8;
const RECENT_ACTIONS = 12;
const HISTORY_DAYS = 7;
const DEFAULT_HISTORY = 30;
const MAX_HISTORY = 90;
/** An act body is a few dozen bytes; the signed form adds a wallet, a nonce and a base64 signature. */
const MAX_BODY_BYTES = 4 * 1024;
/** Every pet limit counts in the same fixed window. */
interface LimitConfig {
  bucket: string;
  limit: number;
}
/** Anonymous gates: per client IP. */
const PET_LIMIT: LimitConfig = { bucket: "pet", limit: ANON_PET_LIMIT };
/** Signed gates: per wallet, regardless of IP. */
const PET_WALLET_LIMIT: LimitConfig = { bucket: "petw", limit: SIGNED_PET_LIMIT };
/** Signed gates: per client IP across wallets, so a bag of throwaway keys is still one visitor. */
const PET_IP_LIMIT: LimitConfig = { bucket: "petip", limit: SIGNED_IP_LIMIT };
/** Refused gates (bad signature, stale day, replay, refused wallet, protected qubit) per client IP: a flood is cut off at one read. */
const PET_BAD_LIMIT: LimitConfig = { bucket: "petbad", limit: 20 };
/** GET /api/pet/qpu/check per client IP: the route asks IBM at most once per CHECK_TTL_MS anyway. */
const QPU_CHECK_LIMIT: LimitConfig = { bucket: "qpucheck", limit: 2 };
/** POST /api/pet/qpu/smoke per client IP, refusals included. */
const QPU_SMOKE_LIMIT: LimitConfig = { bucket: "qpusmoke", limit: 2 };
/** A wallet found on chain is trusted for a day; one that is not is asked again sooner, it may just have been funded. */
const WALLET_ON_CHAIN_TTL_MS = 24 * 60 * 60 * 1000;
const WALLET_OFF_CHAIN_TTL_MS = 5 * 60 * 1000;
/** Wallet checks nobody asked about for this long are dropped with the nonces. */
const WALLET_CHECK_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Badges listed per wallet. */
const MAX_BADGES = 90;
/** A nonce is bound to its day, so one older than two days can never verify again; prune it. */
const NONCE_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const GATES: readonly Gate[] = ["H", "X", "CNOT", "MEASURE", "PROTECT", "MUTATE"];

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

const SQL_GET_STATE = `SELECT day, day_started_at, state, protected, actions_today FROM pet_state WHERE id = 1`;

/** First run: day 1 with the day-start state. OR IGNORE so two first requests cannot both create it. */
const SQL_INIT_STATE = `
INSERT OR IGNORE INTO pet_state (id, day, day_started_at, state, protected, actions_today, updated_at)
VALUES (1, 1, ?1, ?2, '{}', 0, ?3)`;

/** Starts day+1; the `day = ?3` guard makes a concurrent second collapse a no-op. */
const SQL_START_NEXT_DAY = `
UPDATE pet_state
SET day = day + 1, day_started_at = ?1, state = ?2, protected = '{}', actions_today = 0, updated_at = ?3
WHERE id = 1 AND day = ?4`;

/**
 * ?12 source ('simulator' | 'qpu'), ?13 backend, ?14 job id, ?15 why a Sunday stayed on the simulator.
 * Two collapses can run at once (both crons fire at 00:00, a visit collapses lazily): when the other
 * one parked this day for the hardware (SQL_QPU_START), the day belongs to that run and this row is not written.
 */
const SQL_INSERT_DAY = `
INSERT OR IGNORE INTO pet_days (day, bits, form, character, ability, palette, actions, p_top, measured_at, posted_at, top_wallet, top_gates, source, qpu_backend, qpu_job, qpu_note)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13, ?14, ?15
WHERE NOT EXISTS (SELECT 1 FROM pet_qpu_runs WHERE day = ?1)`;

const SQL_MARK_POSTED = `UPDATE pet_days SET posted_at = ?1 WHERE day = ?2`;

/**
 * Writes a gate's result. The `day = ?4` guard refuses a state computed for a
 * day that just collapsed; the nonce guard (?5, null for an anonymous gate)
 * refuses a signed gate whose nonce a concurrent request spent first. The
 * nonce itself is spent by SQL_USE_NONCE later in the same batch, so a gate
 * that is not applied writes nothing.
 */
const SQL_APPLY = `
UPDATE pet_state
SET state = ?1, protected = ?2, actions_today = actions_today + 1, updated_at = ?3
WHERE id = 1 AND day = ?4 AND (?5 IS NULL OR NOT EXISTS (SELECT 1 FROM pet_nonces WHERE nonce = ?5))`;

/**
 * Logged only under SQL_APPLY's guards (day still current, nonce ?10 unspent), so a refused SQL_APPLY leaves
 * no phantom action. ?11 is MUTATE's angle, so the day can be replayed as a circuit.
 */
const SQL_INSERT_ACTION = `
INSERT INTO pet_actions (day, gate, q, t, outcome, client, wallet, at, theta)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?11
WHERE EXISTS (SELECT 1 FROM pet_state WHERE id = 1 AND day = ?9)
  AND (?10 IS NULL OR NOT EXISTS (SELECT 1 FROM pet_nonces WHERE nonce = ?10))`;

const DAY_COLUMNS = `day, bits, form, character, ability, palette, actions, p_top, measured_at, top_wallet, top_gates, source, qpu_backend, qpu_job, qpu_note`;
/** Today's body: the latest collapse before the current day. A day measuring on hardware has no row yet. */
const SQL_BODY = `SELECT ${DAY_COLUMNS} FROM pet_days WHERE day < ?1 ORDER BY day DESC LIMIT 1`;
const SQL_HISTORY = `SELECT ${DAY_COLUMNS} FROM pet_days ORDER BY day DESC LIMIT ?1`;
const SQL_RECENT = `SELECT gate, q, t, theta, outcome, wallet, at FROM pet_actions WHERE day = ?1 ORDER BY at DESC, id DESC LIMIT ?2`;

/* --- hardware runs (migrations/0012_pet_qpu.sql) ------------------------- */

/** The day's gates in the order they were applied (the row id follows the apply batch). */
const SQL_DAY_LOG = `SELECT gate, q, t, theta, outcome FROM pet_actions WHERE day = ?1 ORDER BY id ASC`;
const QPU_OPEN = `('submitting', 'queued', 'running')`;
const SQL_QPU_HAS_PENDING = `SELECT day FROM pet_qpu_runs WHERE status IN ${QPU_OPEN} LIMIT 1`;
/**
 * QPU seconds of the jobs sent since ?1, the Sunday runs and the smoke jobs (migrations/0014_qpu_smoke.sql)
 * together, so both draw on one monthly budget; a job without reported usage counts ?2.
 */
export const SQL_QPU_MONTH = `
SELECT COALESCE(SUM(seconds), 0) AS seconds FROM (
  SELECT COALESCE(usage_seconds, ?2) AS seconds FROM pet_qpu_runs WHERE job_id IS NOT NULL AND submitted_at >= ?1
  UNION ALL
  SELECT COALESCE(usage_seconds, ?2) AS seconds FROM qpu_smoke WHERE job_id IS NOT NULL AND submitted_at >= ?1
)`;
/**
 * Written in the collapse batch: the day waits here for the hardware. Not when a concurrent collapse
 * already drew the day on the simulator (the mirror of SQL_INSERT_DAY's guard).
 */
const SQL_QPU_START = `
INSERT OR IGNORE INTO pet_qpu_runs (day, status, created_at, collapse_at, actions, state, mids, two_qubit)
SELECT ?1, 'submitting', ?2, ?3, ?4, ?5, ?6, ?7
WHERE NOT EXISTS (SELECT 1 FROM pet_days WHERE day = ?1)`;
/** What the page reads: everything but the state vector, the histogram and the circuit. */
const RUN_COLUMNS = `day, status, created_at, collapse_at, actions, mids, two_qubit, attempts, polled_at, crn, backend, job_id, chain,
  submitted_at, finished_at, bits, mid_hw, matched, summary, usage_seconds, reason`;
const SQL_QPU_RECENT = `SELECT ${RUN_COLUMNS} FROM pet_qpu_runs ORDER BY day DESC LIMIT ?1`;
const SQL_QPU_ONE = `SELECT ${RUN_COLUMNS}, qasm FROM pet_qpu_runs WHERE day = ?1`;
const SQL_QPU_NEXT_OPEN = `SELECT ${RUN_COLUMNS}, state FROM pet_qpu_runs WHERE status IN ${QPU_OPEN} ORDER BY day ASC LIMIT 1`;
/** One poller at a time across isolates: the claim moves `polled_at` only when the last poll is ?3 or older. */
const SQL_QPU_CLAIM = `
UPDATE pet_qpu_runs SET polled_at = ?1
WHERE day = ?2 AND status IN ${QPU_OPEN} AND (polled_at IS NULL OR polled_at <= ?3)`;
/** The job is with IBM: the submission lease ends (polled_at = now), so the job is followed at the usual pace. */
const SQL_QPU_SUBMITTED = `
UPDATE pet_qpu_runs SET status = 'queued', crn = ?2, backend = ?3, job_id = ?4, chain = ?5, qasm = ?6, submitted_at = ?7,
  attempts = attempts + 1, reason = NULL, polled_at = ?7
WHERE day = ?1 AND status = 'submitting'`;
/** A failed attempt; ?3 moves the claim so the next attempt waits SUBMIT_RETRY_GAP_MS. */
const SQL_QPU_ATTEMPT_FAILED = `
UPDATE pet_qpu_runs SET attempts = attempts + 1, reason = ?2, polled_at = ?3
WHERE day = ?1 AND status = 'submitting'`;
const SQL_QPU_PHASE = `UPDATE pet_qpu_runs SET status = ?2 WHERE day = ?1 AND status IN ('queued', 'running')`;
/** Settles a run once: guarded by the status it was read with (?11). The state vector is dropped. */
const SQL_QPU_SETTLE = `
UPDATE pet_qpu_runs SET status = ?2, bits = ?3, mid_hw = ?4, counts = ?5, matched = ?6, summary = ?7,
  usage_seconds = COALESCE(?8, usage_seconds), reason = ?9, finished_at = ?10, state = NULL
WHERE day = ?1 AND status = ?11`;
/** The settled day's row, written only by the settler whose SQL_QPU_SETTLE went through (same bits and time). */
const SQL_INSERT_SETTLED_DAY = `
INSERT OR IGNORE INTO pet_days (day, bits, form, character, ability, palette, actions, p_top, measured_at, posted_at, top_wallet, top_gates, source, qpu_backend, qpu_job, qpu_note)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13, ?14, ?15
WHERE EXISTS (SELECT 1 FROM pet_qpu_runs WHERE day = ?1 AND status = ?16 AND finished_at = ?9 AND bits = ?2)`;
const QPU_RUNS_LISTED = 12;

/* --- verification before a Sunday (migrations/0014_qpu_smoke.sql) ------- */

const SMOKE_COLUMNS = `id, status, created_at, polled_at, crn, backend, pair, job_id, qasm, submitted_at, finished_at,
  counts, collapse, parsed, shape, usage_seconds, reason`;
const SQL_SMOKE_LATEST = `SELECT ${SMOKE_COLUMNS} FROM qpu_smoke ORDER BY id DESC LIMIT 1`;
const SQL_SMOKE_ONE = `SELECT ${SMOKE_COLUMNS} FROM qpu_smoke WHERE id = ?1`;
const SQL_SMOKE_NEXT_OPEN = `SELECT ${SMOKE_COLUMNS} FROM qpu_smoke WHERE status IN ${QPU_OPEN} ORDER BY id ASC LIMIT 1`;
/** A smoke job "ran" when it completed or IBM charged it QPU time: that starts the 6-day wait. */
const SMOKE_RAN = `job_id IS NOT NULL AND (status = 'done' OR COALESCE(usage_seconds, 0) > 0)`;
/** What `smokeVerdict` needs besides the month's seconds. */
export const SQL_SMOKE_GUARD = `
SELECT
  (SELECT COUNT(*) FROM qpu_smoke WHERE status IN ${QPU_OPEN}) AS pending,
  (SELECT COUNT(*) FROM pet_qpu_runs WHERE status IN ${QPU_OPEN}) AS sunday_open,
  (SELECT MAX(submitted_at) FROM qpu_smoke WHERE ${SMOKE_RAN}) AS last_ran_at,
  (SELECT MAX(created_at) FROM qpu_smoke) AS last_attempt_at`;
/**
 * Opens a smoke attempt under the same rules as `smokeVerdict` (?2 = now − 6 days, ?3 = now − 10 minutes),
 * so two requests racing past the read cannot both send a job. The budget was checked by the caller.
 */
const SQL_SMOKE_INSERT = `
INSERT INTO qpu_smoke (status, created_at)
SELECT 'submitting', ?1
WHERE NOT EXISTS (SELECT 1 FROM qpu_smoke WHERE status IN ${QPU_OPEN})
  AND NOT EXISTS (SELECT 1 FROM pet_qpu_runs WHERE status IN ${QPU_OPEN})
  AND NOT EXISTS (SELECT 1 FROM qpu_smoke WHERE ${SMOKE_RAN} AND submitted_at > ?2)
  AND NOT EXISTS (SELECT 1 FROM qpu_smoke WHERE created_at > ?3)
RETURNING id, created_at`;
/**
 * The job is with IBM. Guarded by `job_id IS NULL` only, so a job that reached IBM is always recorded and
 * followed, even when a poller gave the attempt up in the meantime.
 */
const SQL_SMOKE_SENT = `
UPDATE qpu_smoke SET status = 'queued', crn = ?2, backend = ?3, pair = ?4, job_id = ?5, qasm = ?6, submitted_at = ?7,
  polled_at = ?7, finished_at = NULL, reason = NULL
WHERE id = ?1 AND job_id IS NULL`;
/** Settles a smoke attempt as failed, guarded by the status it was read with (?5). */
const SQL_SMOKE_FAILED = `
UPDATE qpu_smoke SET status = 'failed', reason = ?2, finished_at = ?3, usage_seconds = COALESCE(?4, usage_seconds)
WHERE id = ?1 AND status = ?5`;
/** A completed job: what the Sunday's parser made of IBM's payload, guarded by the status it was read with (?9). */
const SQL_SMOKE_DONE = `
UPDATE qpu_smoke SET status = 'done', counts = ?2, collapse = ?3, parsed = ?4, shape = ?5, usage_seconds = COALESCE(?6, usage_seconds),
  finished_at = ?7, reason = ?8
WHERE id = ?1 AND status = ?9`;
const SQL_SMOKE_PHASE = `UPDATE qpu_smoke SET status = ?2, reason = NULL WHERE id = ?1 AND status IN ('queued', 'running')`;
/** A poll that could not read IBM: the job stays open, the reason is shown. */
const SQL_SMOKE_NOTE = `UPDATE qpu_smoke SET reason = ?2 WHERE id = ?1 AND status IN ${QPU_OPEN}`;
/** One poller at a time across isolates: `polled_at` moves only when the last poll is ?4 or older. */
const SQL_SMOKE_CLAIM = `
UPDATE qpu_smoke SET polled_at = ?1
WHERE id = ?2 AND status = ?3 AND (polled_at IS NULL OR polled_at <= ?4)`;

/** The check's cache: one row, the last result and a claim so only one isolate asks IBM at a time. */
const SQL_CHECK_READ = `SELECT result, checked_at FROM qpu_check WHERE id = 1`;
const SQL_CHECK_CLAIM = `
INSERT INTO qpu_check (id, result, checked_at, claimed_at) VALUES (1, '', 0, ?1)
ON CONFLICT(id) DO UPDATE SET claimed_at = excluded.claimed_at
WHERE qpu_check.claimed_at IS NULL OR qpu_check.claimed_at <= ?2`;
const SQL_CHECK_STORE = `UPDATE qpu_check SET result = ?1, checked_at = ?2, claimed_at = NULL WHERE id = 1`;
const SQL_CHECK_RELEASE = `UPDATE qpu_check SET claimed_at = NULL WHERE id = 1 AND claimed_at = ?1`;
/** A live check is reused this long. */
const CHECK_TTL_MS = 5 * 60 * 1000;
/** A check that has not stored its result this long after claiming is presumed cut off. */
const CHECK_CLAIM_MS = 2 * 60 * 1000;

/* --- signed gates and badges ------------------------------------------ */

const SQL_SIGNED_TODAY = `SELECT COUNT(*) AS n FROM pet_actions WHERE day = ?1 AND wallet IS NOT NULL`;
const SQL_MY_GATES = `SELECT COUNT(*) AS n FROM pet_actions WHERE day = ?1 AND wallet = ?2`;

/** The wallet with the most signed gates in a day; ties go to the one that reached the count first. */
const SQL_LEADER = `
SELECT wallet, COUNT(*) AS gates, MAX(at) AS reached_at
FROM pet_actions WHERE day = ?1 AND wallet IS NOT NULL
GROUP BY wallet
ORDER BY gates DESC, reached_at ASC, wallet ASC
LIMIT 1`;

/** Spends a nonce, last in the apply batch: zero changes means it was spent before (replay). */
const SQL_USE_NONCE = `INSERT OR IGNORE INTO pet_nonces (nonce, wallet, at) VALUES (?1, ?2, ?3)`;
/** Read before any verification: a replay is refused at the cost of one read. */
const SQL_NONCE_USED = `SELECT 1 AS used FROM pet_nonces WHERE nonce = ?1`;
const SQL_PRUNE_NONCES = `DELETE FROM pet_nonces WHERE at < ?1`;

/* --- Sybil caps (migrations/0009_pet_sybil.sql) ------------------------- */

/** Adds the wallet to the address's wallets of the day while the address is under its allowance (?4); a known wallet is a no-op. */
const SQL_REGISTER_WALLET_IP = `
INSERT OR IGNORE INTO pet_wallet_ips (utc_day, ip_hash, wallet)
SELECT ?1, ?2, ?3
WHERE (SELECT COUNT(*) FROM pet_wallet_ips WHERE utc_day = ?1 AND ip_hash = ?2) < ?4`;
/** Whether the wallet is among the address's wallets of the day, after SQL_REGISTER_WALLET_IP in the same batch. */
const SQL_WALLET_IP_KNOWN = `SELECT 1 AS known FROM pet_wallet_ips WHERE utc_day = ?1 AND ip_hash = ?2 AND wallet = ?3`;
const SQL_PRUNE_WALLET_IPS = `DELETE FROM pet_wallet_ips WHERE utc_day < ?1`;

const SQL_WALLET_CHECK = `SELECT on_chain, checked_at FROM pet_wallets WHERE wallet = ?1`;
const SQL_WALLET_CHECKED = `
INSERT INTO pet_wallets (wallet, on_chain, checked_at) VALUES (?1, ?2, ?3)
ON CONFLICT(wallet) DO UPDATE SET on_chain = excluded.on_chain, checked_at = excluded.checked_at`;
const SQL_PRUNE_WALLET_CHECKS = `DELETE FROM pet_wallets WHERE checked_at < ?1`;

/** Every wallet with a signed gate that day witnessed it. */
const SQL_AWARD_WITNESS = `
INSERT OR IGNORE INTO pet_badges (wallet, day, kind)
SELECT DISTINCT wallet, ?1, 'witness' FROM pet_actions WHERE day = ?1 AND wallet IS NOT NULL`;
const SQL_AWARD_INFLUENCER = `INSERT OR IGNORE INTO pet_badges (wallet, day, kind) VALUES (?1, ?2, 'influencer')`;

/** A wallet's badges with the day they belong to; influencer before witness within a day. */
const SQL_BADGES = `
SELECT b.wallet, b.day, b.kind, d.form, d.measured_at,
  (SELECT COUNT(*) FROM pet_actions a WHERE a.day = b.day AND a.wallet = b.wallet) AS gates
FROM pet_badges b LEFT JOIN pet_days d ON d.day = b.day
WHERE b.wallet = ?1
ORDER BY b.day DESC, b.kind ASC
LIMIT ?2`;

/** Shared fixed-window counter (docs/CONTRACT-WEEK2.md). */
const SQL_RATE_LIMIT = `
INSERT INTO ratelimit (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN ratelimit.window_start = excluded.window_start THEN ratelimit.count + 1 ELSE 1 END,
  window_start = excluded.window_start
RETURNING count`;

/** Read-only: the current-window counts of `n` keys (?2..); a key without a row in this window counts 0. */
const sqlReadCounts = (n: number): string =>
  `SELECT key, count FROM ratelimit WHERE window_start = ?1 AND key IN (${Array.from({ length: n }, (_, i) => `?${i + 2}`).join(", ")})`;

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface StateRow {
  day: number;
  day_started_at: number;
  state: string;
  protected: string;
  actions_today: number;
}

interface DayRow {
  day: number;
  bits: string;
  form: string;
  character: string;
  ability: string;
  palette: string;
  actions: number;
  p_top: number;
  measured_at: number;
  top_wallet: string | null;
  top_gates: number | null;
  source: string | null;
  qpu_backend: string | null;
  qpu_job: string | null;
  qpu_note: string | null;
}

interface ActionRow {
  gate: string;
  q: number;
  t: number | null;
  theta: number | null;
  outcome: number | null;
  wallet: string | null;
  at: number;
}

/** A pet_qpu_runs row as RUN_COLUMNS reads it; `state` and `qasm` only where selected. */
interface RunRow {
  day: number;
  status: string;
  created_at: number;
  collapse_at: number;
  actions: number;
  mids: string;
  two_qubit: number | null;
  attempts: number;
  polled_at: number | null;
  crn: string | null;
  backend: string | null;
  job_id: string | null;
  chain: string | null;
  submitted_at: number | null;
  finished_at: number | null;
  bits: string | null;
  mid_hw: string | null;
  matched: number | null;
  summary: string | null;
  usage_seconds: number | null;
  reason: string | null;
  state?: string | null;
  qasm?: string | null;
}

/** A qpu_smoke row (migrations/0014_qpu_smoke.sql). `crn` is read for polling, never returned. */
interface SmokeRow {
  id: number;
  status: string;
  created_at: number;
  polled_at: number | null;
  crn: string | null;
  backend: string | null;
  pair: string | null;
  job_id: string | null;
  qasm: string | null;
  submitted_at: number | null;
  finished_at: number | null;
  counts: string | null;
  collapse: string | null;
  parsed: number | null;
  shape: string | null;
  usage_seconds: number | null;
  reason: string | null;
}

interface SmokeGuardRow {
  pending: number;
  sunday_open: number;
  last_ran_at: number | null;
  last_attempt_at: number | null;
}

interface CheckRow {
  result: string;
  checked_at: number;
}

interface LeaderRow {
  wallet: string;
  gates: number;
}

interface BadgeRow {
  wallet: string;
  day: number;
  kind: string;
  form: string | null;
  measured_at: number | null;
  gates: number;
}

interface CountRow {
  key: string;
  count: number;
}

interface WalletCheckRow {
  on_chain: number;
  checked_at: number;
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

/** The connecting IP, or "anon" when the header is missing (local dev). */
const clientIp = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "anon";

/** What the action log stores about a client: the first 16 hex of sha256(ip), never the address itself. */
async function clientTag(request: Request): Promise<string> {
  const ip = clientIp(request);
  if (ip === "anon") return ip;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
  let hex = "";
  for (const byte of digest.subarray(0, 8)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
/** One limit applied to one key: `[PET_WALLET_LIMIT, wallet]`. */
type Counted = [LimitConfig, string];

const currentWindow = (): number => Math.floor(Date.now() / PET_WINDOW_MS);
const windowEnd = (window: number): number => (window + 1) * PET_WINDOW_MS;
const limitKey = ([cfg, key]: Counted): string => `${cfg.bucket}:${key}`;

/**
 * Counts one request against every pair in one batch and reports the first
 * over its limit. Runs after the rules, so only an accepted gate spends a
 * slot. The counter fails open and logs, like the scanner's.
 */
async function countAgainst(env: Env, pairs: Counted[]): Promise<Limit> {
  const window = currentWindow();
  try {
    const results = await env.DB.batch<{ count: number }>(
      pairs.map((pair) => env.DB.prepare(SQL_RATE_LIMIT).bind(limitKey(pair), window)),
    );
    for (let i = 0; i < pairs.length; i++) {
      if ((results[i]?.results[0]?.count ?? 0) > pairs[i][0].limit) return { limited: true, retryAt: windowEnd(window) };
    }
    return { limited: false };
  } catch (error) {
    console.warn("pet rate limiter failed", error);
    return { limited: false };
  }
}

interface Precheck {
  /** when a pair has already reached its limit in this window */
  retryAt: number | null;
  /** the signed gate's nonce was spent before */
  nonceUsed: boolean;
}

/**
 * The cheap gate in front of `act`, one read: whether the address (or the
 * wallet) has used up its minute or keeps sending refused gates, and whether
 * a signed gate's nonce was spent already. Nothing is written, so a refused
 * or rate-limited request costs no slot, no state read, no signature check
 * and no row. Fails open and logs.
 */
async function precheckAct(env: Env, ip: string, signed: SignedFields | null): Promise<Precheck> {
  const window = currentWindow();
  const pairs: Counted[] = signed
    ? [[PET_BAD_LIMIT, ip], [PET_WALLET_LIMIT, signed.wallet], [PET_IP_LIMIT, ip]]
    : [[PET_BAD_LIMIT, ip], [PET_LIMIT, ip]];
  const statements = [env.DB.prepare(sqlReadCounts(pairs.length)).bind(window, ...pairs.map(limitKey))];
  if (signed) statements.push(env.DB.prepare(SQL_NONCE_USED).bind(signed.nonce));
  try {
    const [countsRes, nonceRes] = await env.DB.batch(statements);
    const counts = new Map((countsRes.results as CountRow[]).map((r) => [r.key, r.count]));
    for (const pair of pairs) {
      if ((counts.get(limitKey(pair)) ?? 0) >= pair[0].limit) return { retryAt: windowEnd(window), nonceUsed: false };
    }
    return { retryAt: null, nonceUsed: (nonceRes?.results.length ?? 0) > 0 };
  } catch (error) {
    console.warn("pet pre-check failed", error);
    return { retryAt: null, nonceUsed: false };
  }
}

const rateLimited = (retryAt: number): Response =>
  json({ error: "rate limited", retryAt }, 429, {
    "Retry-After": String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))),
  });

/** A refused gate counts against the address's "petbad" allowance, after the response is sent. */
function refused(env: Env, ctx: ExecutionContext, ip: string, response: Response): Response {
  ctx.waitUntil(countAgainst(env, [[PET_BAD_LIMIT, ip]]).then(() => undefined));
  return response;
}

/* ------------------------------------------------------------------ */
/* Sybil caps on signed gates                                          */
/* ------------------------------------------------------------------ */

type WalletVerdict = { ok: true } | { ok: false; response: Response };

/** Whether the wallet has an account on Solana; null when there is no RPC or it could not say. */
async function accountOnChain(deps: PetDeps, wallet: string): Promise<boolean | null> {
  if (!deps.rpc) return null;
  try {
    const result = await deps.rpc("getAccountInfo", [wallet, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    if (!isRecord(result) || !("value" in result)) throw new Error("unexpected getAccountInfo response");
    return result.value !== null;
  } catch (error) {
    console.warn("pet: wallet check failed", wallet, error);
    return null;
  }
}

/**
 * The Sybil rules of a signed gate, after the signature and the gate rules
 * have passed: at most WALLETS_PER_IP_PER_DAY distinct wallets sign from one
 * address per UTC day (`pet_wallet_ips`, keyed by the hashed address), and
 * the wallet must have an account on Solana (`pet_wallets` caches the
 * answer, a day when found, five minutes when not). A throwaway key thus
 * costs one of the address's daily slots and a funded account. An RPC that
 * cannot answer lets the gate through unrecorded, like the limiters.
 */
async function sybilCheck(env: Env, deps: PetDeps, ipTag: string, wallet: string, now: number): Promise<WalletVerdict> {
  const utcDay = Math.floor(now / DAY_MS);
  const [, known] = await env.DB.batch([
    env.DB.prepare(SQL_REGISTER_WALLET_IP).bind(utcDay, ipTag, wallet, WALLETS_PER_IP_PER_DAY),
    env.DB.prepare(SQL_WALLET_IP_KNOWN).bind(utcDay, ipTag, wallet),
  ]);
  if (known.results.length === 0) {
    return {
      ok: false,
      response: json(
        {
          error: `this network address has already signed with ${WALLETS_PER_IP_PER_DAY} wallets today, the most it may; use one of them, or disconnect the wallet to apply gates anonymously`,
          limit: WALLETS_PER_IP_PER_DAY,
        },
        403,
      ),
    };
  }

  const cached = await env.DB.prepare(SQL_WALLET_CHECK).bind(wallet).first<WalletCheckRow>();
  let onChain: boolean | null = null;
  if (cached && now - cached.checked_at < (cached.on_chain ? WALLET_ON_CHAIN_TTL_MS : WALLET_OFF_CHAIN_TTL_MS)) {
    onChain = cached.on_chain !== 0;
  } else {
    onChain = await accountOnChain(deps, wallet);
    if (onChain !== null) await env.DB.prepare(SQL_WALLET_CHECKED).bind(wallet, onChain ? 1 : 0, now).run();
  }
  if (onChain === false) {
    return {
      ok: false,
      response: json(
        {
          error:
            "this wallet has no account on Solana yet; fund it once (the check repeats after a few minutes), or disconnect it to apply gates anonymously",
        },
        403,
      ),
    };
  }
  return { ok: true };
}

/** Opportunistic cleanup after a signed gate: old nonces, past days' wallet-per-address rows, forgotten wallet checks. */
function prune(env: Env, now: number): Promise<void> {
  return env.DB.batch([
    env.DB.prepare(SQL_PRUNE_NONCES).bind(now - NONCE_TTL_MS),
    env.DB.prepare(SQL_PRUNE_WALLET_IPS).bind(Math.floor(now / DAY_MS) - 1),
    env.DB.prepare(SQL_PRUNE_WALLET_CHECKS).bind(now - WALLET_CHECK_KEEP_MS),
  ])
    .then(() => undefined)
    .catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* State rows                                                          */
/* ------------------------------------------------------------------ */

function parseState(text: string): QState {
  return deserialise(JSON.parse(text));
}

/** The stored protection map: qubit index → unix ms. Anything malformed reads as empty. */
function parseProtected(text: string): Record<number, number> {
  const out: Record<number, number> = {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!isRecord(data)) return out;
  for (const [key, value] of Object.entries(data)) {
    const q = Number(key);
    if (isQubitIndex(q) && typeof value === "number" && Number.isFinite(value)) out[q] = value;
  }
  return out;
}

/** Only the protections still running at `now`. */
function activeProtection(map: Record<number, number>, now: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [key, until] of Object.entries(map)) {
    if (until > now) out[Number(key)] = until;
  }
  return out;
}

async function readState(env: Env): Promise<StateRow | null> {
  return env.DB.prepare(SQL_GET_STATE).first<StateRow>();
}

/** The pet_state row, created as day 1 on the very first call. */
async function ensureState(env: Env): Promise<StateRow> {
  const row = await readState(env);
  if (row) return row;
  const now = Date.now();
  await env.DB.prepare(SQL_INIT_STATE).bind(now, JSON.stringify(serialise(dayStartState())), now).run();
  const created = await readState(env);
  if (!created) throw new Error("pet_state could not be created");
  return created;
}

/** The current row, collapsed first when its day is over (the cron may have missed). */
async function currentState(env: Env, ctx?: ExecutionContext): Promise<StateRow> {
  let row = await ensureState(env);
  if (Date.now() >= collapseAtFor(row.day_started_at)) {
    await collapsePet(env, ctx);
    row = (await readState(env)) ?? row;
  }
  return row;
}

const isGate = (value: unknown): value is Gate => typeof value === "string" && (GATES as readonly string[]).includes(value);

function dayOf(row: DayRow): PetDay {
  return {
    day: row.day,
    bits: row.bits,
    form: row.form,
    character: row.character,
    ability: row.ability,
    palette: row.palette,
    actions: row.actions,
    pTop: row.p_top,
    measuredAt: row.measured_at,
    topWallet: row.top_wallet ?? null,
    topGates: row.top_gates ?? null,
    source: row.source === "qpu" ? "qpu" : "simulator",
    qpuBackend: row.qpu_backend ?? null,
    qpuJob: row.qpu_job ?? null,
    qpuNote: row.qpu_note ?? null,
  };
}

function actionOf(row: ActionRow): PetAction | null {
  if (!isGate(row.gate)) return null;
  return {
    gate: row.gate,
    q: row.q,
    t: row.t,
    outcome: row.outcome,
    at: row.at,
    wallet: row.wallet ?? null,
    theta: typeof row.theta === "number" ? row.theta : null,
  };
}

const QPU_STATUSES: readonly PetQpuStatus[] = ["submitting", "queued", "running", "done", "fallback"];
const isQpuStatus = (value: string): value is PetQpuStatus => (QPU_STATUSES as readonly string[]).includes(value);
const isOpenStatus = (status: string): boolean => status === "submitting" || status === "queued" || status === "running";

/** A JSON column, or null when it is missing or malformed. */
function jsonColumn(text: string | null | undefined): unknown {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const bitList = (value: unknown): (0 | 1)[] | null =>
  Array.isArray(value) && value.every((b) => b === 0 || b === 1) ? (value as (0 | 1)[]) : null;
const intList = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === "number" && Number.isInteger(v)) ? (value as number[]) : null;

function compareOf(value: unknown): PetQpuCompare | null {
  if (!isRecord(value) || typeof value.shots !== "number" || typeof value.fidelity !== "number") return null;
  if (!Array.isArray(value.forms) || !Array.isArray(value.top)) return null;
  return value as unknown as PetQpuCompare;
}

function runOf(row: RunRow): PetQpuRun {
  const site = bitList(jsonColumn(row.mids)) ?? [];
  return {
    day: row.day,
    status: isQpuStatus(row.status) ? row.status : "fallback",
    backend: row.backend ?? null,
    jobId: row.job_id ?? null,
    startedAt: row.created_at,
    deadlineAt: deadlineOf(row.created_at),
    submittedAt: row.submitted_at ?? null,
    finishedAt: row.finished_at ?? null,
    bits: row.bits ?? null,
    twoQubitGates: row.two_qubit ?? null,
    chain: intList(jsonColumn(row.chain)),
    partial: site.length > 0 ? { site, hardware: bitList(jsonColumn(row.mid_hw)), matched: row.matched ?? null } : null,
    compare: compareOf(jsonColumn(row.summary)),
    usageSeconds: row.usage_seconds ?? null,
    reason: row.reason ?? null,
  };
}

const isBadgeKind = (value: string): value is PetBadge["kind"] => value === "witness" || value === "influencer";

function badgeOf(row: BadgeRow): PetBadge | null {
  if (!isBadgeKind(row.kind)) return null;
  return {
    wallet: row.wallet,
    day: row.day,
    kind: row.kind,
    form: row.form ?? null,
    measuredAt: row.measured_at ?? null,
    gates: row.gates,
  };
}

/** Today's (or a past day's) leading signed wallet, null when nobody signed. */
async function leaderOf(env: Env, day: number): Promise<PetLeader | null> {
  const row = await env.DB.prepare(SQL_LEADER).bind(day).first<LeaderRow>();
  return row ? { wallet: row.wallet, gates: row.gates } : null;
}

/* ------------------------------------------------------------------ */
/* Collapse                                                            */
/* ------------------------------------------------------------------ */

/**
 * Ends the day when it is over: samples the register, records the day with
 * its influencer, awards the badges, starts day+1 with a fresh superposition
 * and posts to X. Returns the recorded day, or null when nothing was due (or
 * another isolate got there first). With `ctx` the X post runs after the
 * response; without it (the cron) it is awaited.
 *
 * The badge statements are INSERT OR IGNORE over the day's own rows, so the
 * isolate that loses the race writes nothing new.
 *
 * A Sunday collapse that goes to IBM hardware (`planHardware`) is not drawn
 * here: the batch starts the next day and parks the state in pet_qpu_runs,
 * `pollQpu` sends the job (after the response with `ctx`), and the result is
 * null because no body was decided yet.
 */
export async function collapsePet(env: Env, ctx?: ExecutionContext): Promise<PetDay | null> {
  const row = await ensureState(env);
  const now = Date.now();
  const collapseAt = collapseAtFor(row.day_started_at);
  if (now < collapseAt) return null;

  const state = parseState(row.state);
  const fresh = JSON.stringify(serialise(dayStartState()));
  const leader = await leaderOf(env, row.day);
  const plan = await planHardware(env, row, state, collapseAt, now);
  const badges = [env.DB.prepare(SQL_AWARD_WITNESS).bind(row.day)];
  if (leader) badges.push(env.DB.prepare(SQL_AWARD_INFLUENCER).bind(leader.wallet, row.day));

  if (plan.kind === "qpu") {
    const results = await env.DB.batch([
      env.DB.prepare(SQL_START_NEXT_DAY).bind(now, fresh, now, row.day),
      env.DB.prepare(SQL_QPU_START).bind(row.day, now, collapseAt, row.actions_today, row.state, JSON.stringify(plan.mids), plan.twoQubit),
      ...badges,
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) return null;
    const sending = pollQpu(env);
    if (ctx) ctx.waitUntil(sending);
    else await sending;
    return null;
  }

  const bits = measureAll(state);
  const pTop = probabilityOf(state, bits);
  const traits = traitsFromBits(bits);
  const results = await env.DB.batch([
    env.DB.prepare(SQL_START_NEXT_DAY).bind(now, fresh, now, row.day),
    env.DB.prepare(SQL_INSERT_DAY).bind(
      row.day,
      bits,
      traits.form,
      traits.character,
      traits.ability,
      traits.palette,
      row.actions_today,
      pTop,
      now,
      leader?.wallet ?? null,
      leader?.gates ?? null,
      "simulator",
      null,
      null,
      plan.note,
    ),
    ...badges,
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) return null;

  const day: PetDay = {
    day: row.day,
    bits,
    ...traits,
    actions: row.actions_today,
    pTop,
    measuredAt: now,
    topWallet: leader?.wallet ?? null,
    topGates: leader?.gates ?? null,
    source: "simulator",
    qpuBackend: null,
    qpuJob: null,
    qpuNote: plan.note,
  };
  const posting = postDay(env, day);
  if (ctx) ctx.waitUntil(posting);
  else await posting;
  return day;
}

/* ------------------------------------------------------------------ */
/* Sundays on IBM hardware                                             */
/* ------------------------------------------------------------------ */

type HardwarePlan = { kind: "qpu"; mids: (0 | 1)[]; twoQubit: number } | { kind: "simulator"; note: string | null };

/**
 * Whether this collapse runs on hardware: a Sunday 00:00 UTC collapse, the
 * key set, no job pending, this month's QPU time under budget, a log that
 * rebuilds the stored state exactly (every mutate has its angle, every
 * measure its outcome, no gate lost to a race), a circuit small enough to
 * be more than noise, and partial measurements likely enough that at least
 * MIN_EXPECTED_MATCHES shots should repeat them (post-selection). Otherwise
 * the simulator draws it; on a Sunday the day records why (`note`).
 */
async function planHardware(env: Env, row: StateRow, state: QState, collapseAt: number, now: number): Promise<HardwarePlan> {
  if (!isQpuCollapse(collapseAt)) return { kind: "simulator", note: null };
  if (!env.IBM_QUANTUM_API_KEY) return { kind: "simulator", note: "hardware runs are not configured on this server" };
  try {
    const [pendingRes, monthRes, logRes] = await env.DB.batch([
      env.DB.prepare(SQL_QPU_HAS_PENDING),
      env.DB.prepare(SQL_QPU_MONTH).bind(monthStart(now), UNKNOWN_USAGE_SECONDS),
      env.DB.prepare(SQL_DAY_LOG).bind(row.day),
    ]);
    const monthSeconds = (monthRes.results as { seconds: number }[])[0]?.seconds ?? 0;
    const quota = quotaVerdict({ pending: pendingRes.results.length > 0, monthSeconds });
    if (quota) return { kind: "simulator", note: quota };
    const log = logFromRows(logRes.results as ActionLogRow[], row.actions_today);
    if (!log.ok) return { kind: "simulator", note: `the day cannot be rebuilt as a circuit: ${log.reason}` };
    const replayed = replayWithOdds(log.value);
    if (!replayed || stateFidelity(replayed.state, state) < REPLAY_FIDELITY) {
      return { kind: "simulator", note: "the gate log does not rebuild the stored state (two gates landed at the same moment), so the day cannot run as a circuit" };
    }
    const circuit = buildCircuit(log.value);
    if (circuit.twoQubit > MAX_TWO_QUBIT_GATES) {
      return {
        kind: "simulator",
        note: `the circuit needs ${circuit.twoQubit} CZ gates, more than the ${MAX_TWO_QUBIT_GATES} this site sends to hardware`,
      };
    }
    // Only shots that repeat the site's partial measurements are draws of the site's register.
    const expected = replayed.pMids * (COLLAPSE_SHOTS + DISTRIBUTION_SHOTS);
    if (expected < MIN_EXPECTED_MATCHES) {
      const k = circuit.line.mids.length;
      return {
        kind: "simulator",
        note: `the day's ${k} partial ${k === 1 ? "measurement" : "measurements"} would repeat on about ${Math.floor(expected)} of ${COLLAPSE_SHOTS + DISTRIBUTION_SHOTS} hardware shots, too few to draw from`,
      };
    }
    return { kind: "qpu", mids: circuit.line.mids, twoQubit: circuit.twoQubit };
  } catch (error) {
    console.warn("pet: hardware plan failed", error);
    return { kind: "simulator", note: "the hardware run could not be prepared" };
  }
}

/**
 * Moves the open hardware run one step, never throws: sends the job
 * (`submitting`), follows it (`queued` / `running`), and settles the day with
 * the hardware's draw when IBM completes it, or with a simulator draw of the
 * stored state when the job fails, cannot be sent in three attempts (20
 * minutes apart), or is not finished six hours after the collapse. One poller at a time: a poll
 * claims the run for a minute first (a submission for SUBMIT_LEASE_MS, and a
 * retry adopts a job already tagged for the day). For the cron (every 15
 * minutes) and, lazily, GET /api/pet. Then a pending smoke job is advanced
 * too (`pollSmoke`), so the cron follows it without a GET.
 */
export async function pollQpu(env: Env): Promise<void> {
  await pollSundayRun(env);
  await pollSmoke(env);
}

async function pollSundayRun(env: Env): Promise<void> {
  try {
    const run = await env.DB.prepare(SQL_QPU_NEXT_OPEN).first<RunRow>();
    if (!run) return;
    const now = Date.now();
    // A submission holds the run for SUBMIT_LEASE_MS (the claim lands in the future), so a slow one is not sent twice.
    const holdUntil = run.status === "submitting" ? now + SUBMIT_LEASE_MS - QPU_POLL_GAP_MS : now;
    const claim = await env.DB.prepare(SQL_QPU_CLAIM).bind(holdUntil, run.day, now - QPU_POLL_GAP_MS).run();
    if ((claim.meta.changes ?? 0) === 0) return;
    await advanceRun(env, run, now);
  } catch (error) {
    console.warn("pet: hardware poll failed", error);
  }
}

const describeFailure = (error: unknown, secrets: readonly (string | null | undefined)[] = []): string =>
  publicReason(error instanceof IbmError ? error.message : error instanceof Error ? error.message : "unknown error", secrets);

async function advanceRun(env: Env, run: RunRow, now: number): Promise<void> {
  const late = deadlinePassed(run.created_at, now);
  const fallback = (reason: string, usage: number | null = null) => settleRun(env, run, { kind: "fallback", reason, usage }, now);
  if (!env.IBM_QUANTUM_API_KEY) return fallback("the IBM Quantum key was removed before the job finished");

  if (run.status === "submitting") {
    if (late || run.attempts >= MAX_SUBMIT_ATTEMPTS) {
      return fallback(`the job could not be sent to IBM${run.reason ? `: ${run.reason}` : ""}`);
    }
    try {
      const client = await connect(env, null);
      const quota = instanceQuotaVerdict(await client.instanceUsage().catch(() => null));
      if (quota) return fallback(quota);
      const rows = await env.DB.prepare(SQL_DAY_LOG).bind(run.day).all<ActionLogRow>();
      const log = logFromRows(rows.results, run.actions);
      if (!log.ok) return fallback(`the day cannot be rebuilt as a circuit: ${log.reason}`);
      // An earlier attempt (counted, or claimed and cut off before it could record anything) may have reached IBM.
      const sent = await submitDay(client, run.day, buildCircuit(log.value), run.attempts > 0 || run.polled_at !== null);
      await env.DB.prepare(SQL_QPU_SUBMITTED)
        .bind(run.day, client.crn, sent.backend, sent.jobId, sent.chain.length > 0 ? JSON.stringify(sent.chain) : null, sent.qasm || null, now)
        .run();
    } catch (error) {
      if (error instanceof IbmError && error.status === 401) forgetToken();
      const reason = describeFailure(error);
      console.warn("pet: hardware submission failed", run.day, reason);
      if (run.attempts + 1 >= MAX_SUBMIT_ATTEMPTS) return fallback(`the job could not be sent to IBM: ${reason}`);
      await env.DB.prepare(SQL_QPU_ATTEMPT_FAILED).bind(run.day, reason, now + SUBMIT_RETRY_GAP_MS - QPU_POLL_GAP_MS).run();
    }
    return;
  }

  if (!run.job_id || !run.crn) return fallback("the job id was not recorded");
  const jobId = run.job_id;
  const mids = bitList(jsonColumn(run.mids)) ?? [];
  try {
    const client = await connect(env, run.crn);
    const phase = jobPhaseFrom(await client.job(jobId));
    if (!phase) throw new IbmError("IBM answered an unreadable job status");
    if (phase.phase === "completed") {
      const parsed = parseSamplerResult(await client.results(jobId), mids);
      const metrics = await client.metrics(jobId).catch(() => null);
      if (!parsed.ok) return fallback(`IBM's result could not be read: ${parsed.reason}`, usageSecondsFrom(metrics));
      const { bits } = parsed.value;
      if (bits === null) {
        const k = mids.length;
        return fallback(
          `none of the ${parsed.value.shots + COLLAPSE_SHOTS} shots on ${run.backend ?? "IBM"} repeated the site's ${k} partial ${k === 1 ? "measurement" : "measurements"}`,
          usageSecondsFrom(metrics),
        );
      }
      return settleRun(
        env,
        run,
        { kind: "qpu", outcome: { ...parsed.value, bits }, usage: usageSecondsFrom(metrics), finishedAt: finishedAtFrom(metrics) ?? now },
        now,
      );
    }
    if (phase.phase === "failed" || phase.phase === "cancelled") {
      const metrics = await client.metrics(jobId).catch(() => null);
      return fallback(publicReason(`IBM reported the job ${phase.phase}${phase.reason ? `: ${phase.reason}` : ""}`), usageSecondsFrom(metrics));
    }
    if (late) {
      await client.cancel(jobId).catch(() => undefined);
      return fallback(`the job was still ${phase.phase} on ${run.backend ?? "IBM"} six hours after the collapse`);
    }
    if (phase.phase !== run.status) await env.DB.prepare(SQL_QPU_PHASE).bind(run.day, phase.phase).run();
  } catch (error) {
    if (error instanceof IbmError && error.status === 401) forgetToken();
    const reason = describeFailure(error);
    console.warn("pet: hardware job check failed", run.day, reason);
    if (late) return fallback(`IBM could not be read for six hours (${reason})`);
  }
}

type Settlement =
  | { kind: "qpu"; outcome: SamplerOutcome & { bits: string }; usage: number | null; finishedAt: number }
  | { kind: "fallback"; reason: string; usage: number | null };

/**
 * Writes the day of a hardware run: the hardware's draw, or a simulator draw
 * of the stored state with the reason, then posts it to X. The run update is
 * guarded by the status it was read with, and the day row by that update, so
 * a second settler writes nothing.
 */
async function settleRun(env: Env, run: RunRow, how: Settlement, now: number): Promise<void> {
  if (!run.state) throw new Error(`hardware run of day ${run.day} has no stored state`);
  const state = parseState(run.state);
  const qpu = how.kind === "qpu";
  const bits = how.kind === "qpu" ? how.outcome.bits : measureAll(state);
  const finishedAt = how.kind === "qpu" ? how.finishedAt : now;
  const status: PetQpuStatus = qpu ? "done" : "fallback";
  const note = how.kind === "fallback" ? how.reason : null;
  const traits = traitsFromBits(bits);
  const pTop = probabilityOf(state, bits);
  const leader = await leaderOf(env, run.day);
  // the shots that repeated the site's partial measurements against the stored state they sample
  const summary =
    how.kind === "qpu" ? compareDistributions(how.outcome.counts, probabilities(state), TRAITS.form, how.outcome.shots) : null;

  const results = await env.DB.batch([
    env.DB.prepare(SQL_QPU_SETTLE).bind(
      run.day,
      status,
      bits,
      how.kind === "qpu" ? JSON.stringify(how.outcome.midsHardware) : null,
      how.kind === "qpu" ? JSON.stringify(how.outcome.counts) : null,
      how.kind === "qpu" ? how.outcome.matched : null,
      summary ? JSON.stringify(summary) : null,
      how.usage,
      note,
      finishedAt,
      run.status,
    ),
    env.DB.prepare(SQL_INSERT_SETTLED_DAY).bind(
      run.day,
      bits,
      traits.form,
      traits.character,
      traits.ability,
      traits.palette,
      run.actions,
      pTop,
      finishedAt,
      leader?.wallet ?? null,
      leader?.gates ?? null,
      qpu ? "qpu" : "simulator",
      qpu ? run.backend : null,
      qpu ? run.job_id : null,
      note,
      status,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0 || (results[1]?.meta.changes ?? 0) === 0) return;

  await postDay(env, {
    day: run.day,
    bits,
    ...traits,
    actions: run.actions,
    pTop,
    measuredAt: finishedAt,
    topWallet: leader?.wallet ?? null,
    topGates: leader?.gates ?? null,
    source: qpu ? "qpu" : "simulator",
    qpuBackend: qpu ? run.backend : null,
    qpuJob: qpu ? run.job_id : null,
    qpuNote: note,
  });
}

/** Posts a day to X and records `posted_at` on success. Missing secrets are silent; failures are logged. */
async function postDay(env: Env, day: PetDay): Promise<void> {
  try {
    const result = await postDayToX(env, day);
    if (result.ok) {
      await env.DB.prepare(SQL_MARK_POSTED).bind(Date.now(), day.day).run();
    } else if (result.error !== "no credentials") {
      console.warn("pet: x post failed", result.error);
    }
  } catch (error) {
    console.warn("pet: x post failed", error);
  }
}

/* ------------------------------------------------------------------ */
/* Verification before a Sunday: the check and the smoke job           */
/* ------------------------------------------------------------------ */

/** QPU seconds this UTC month, Sunday runs and smoke jobs together. */
async function monthSeconds(env: Env, now: number): Promise<number> {
  const row = await env.DB.prepare(SQL_QPU_MONTH).bind(monthStart(now), UNKNOWN_USAGE_SECONDS).first<{ seconds: number }>();
  return row?.seconds ?? 0;
}

const budgetOf = (seconds: number) => ({ monthSeconds: seconds, monthBudgetSeconds: MONTH_BUDGET_SECONDS });

/** A stored check result, or null when the cache row is empty or unreadable. */
function checkOf(text: string): QpuCheck | null {
  const value = jsonColumn(text);
  return isRecord(value) && Array.isArray(value.steps) && typeof value.checkedAt === "number" ? (value as unknown as QpuCheck) : null;
}

/**
 * `GET /api/pet/qpu/check`: the Sunday's own steps against the live IBM
 * service, nothing submitted (`runQpuCheck`). 2 requests a minute per client
 * IP; a live check is reused for 5 minutes by every caller (qpu_check), and
 * while one isolate runs it the others answer the previous result, so IBM is
 * asked at most once per 5 minutes. Adds `cached` and this month's `budget`.
 */
async function qpuCheck(request: Request, env: Env): Promise<Response> {
  const limit = await countAgainst(env, [[QPU_CHECK_LIMIT, clientIp(request)]]);
  if (limit.limited) return rateLimited(limit.retryAt);
  const now = Date.now();
  const budget = budgetOf(await monthSeconds(env, now));
  if (!env.IBM_QUANTUM_API_KEY) return json({ ...(await runQpuCheck(env)), cached: false, budget });

  const row = await env.DB.prepare(SQL_CHECK_READ).first<CheckRow>();
  const previous = row ? checkOf(row.result) : null;
  if (previous && row && now - row.checked_at < CHECK_TTL_MS) return json({ ...previous, cached: true, budget });
  const claim = await env.DB.prepare(SQL_CHECK_CLAIM).bind(now, now - CHECK_CLAIM_MS).run();
  if ((claim.meta.changes ?? 0) === 0) {
    if (previous) return json({ ...previous, cached: true, budget });
    return json({ error: "a check is running right now; ask again in a minute" }, 409, { "Retry-After": "60" });
  }
  let result: QpuCheck;
  try {
    result = await runQpuCheck(env);
  } catch (error) {
    await env.DB.prepare(SQL_CHECK_RELEASE).bind(now).run().catch(() => undefined);
    throw error;
  }
  await env.DB.prepare(SQL_CHECK_STORE).bind(JSON.stringify(result), result.checkedAt).run();
  return json({ ...result, cached: false, budget });
}

export type QpuSmokeStatus = "submitting" | "queued" | "running" | "done" | "failed";

/** A smoke job as GET/POST /api/pet/qpu/smoke report it (never the instance CRN). */
export interface QpuSmoke {
  id: number;
  status: QpuSmokeStatus;
  /** the tag the job carries on IBM */
  tag: string;
  backend: string | null;
  /** the physical qubits: pair[0] gets the H and is c[0] */
  pair: [number, number] | null;
  jobId: string | null;
  createdAt: number;
  submittedAt: number | null;
  finishedAt: number | null;
  /** shots of the distribution pub (a 1-shot pub goes first, as on a Sunday) */
  shots: number;
  /** the distribution pub's histogram, c[0] first: a Bell pair gives about half "00" and half "11" */
  counts: Record<string, number> | null;
  /** p00, p11 and their sum (`correlated`, near 1 on a healthy pair) */
  bell: { shots: number; p00: number; p11: number; correlated: number } | null;
  /** the 1-shot pub's outcome */
  collapse: string | null;
  /** whether the Sunday's parseSamplerResult understood IBM's payload; null until the job completed */
  parser: { ok: boolean; reason: string | null } | null;
  /** keys-only skeleton of IBM's raw result payload */
  shape: string | null;
  usageSeconds: number | null;
  /** why it failed, why the parser refused the payload, or the last poll error while open */
  reason: string | null;
  qasm: string | null;
}

const SMOKE_STATUSES: readonly QpuSmokeStatus[] = ["submitting", "queued", "running", "done", "failed"];

function smokeOf(row: SmokeRow): QpuSmoke {
  const counts = jsonColumn(row.counts);
  const histogram =
    isRecord(counts) && Object.values(counts).every((n) => typeof n === "number") ? (counts as Record<string, number>) : null;
  const pair = intList(jsonColumn(row.pair));
  return {
    id: row.id,
    status: (SMOKE_STATUSES as readonly string[]).includes(row.status) ? (row.status as QpuSmokeStatus) : "failed",
    tag: smokeTag(row.id, row.created_at),
    backend: row.backend ?? null,
    pair: pair && pair.length === 2 ? [pair[0], pair[1]] : null,
    jobId: row.job_id ?? null,
    createdAt: row.created_at,
    submittedAt: row.submitted_at ?? null,
    finishedAt: row.finished_at ?? null,
    shots: SMOKE_SHOTS,
    counts: histogram,
    bell: histogram ? bellSummary(histogram) : null,
    collapse: row.collapse ?? null,
    parser: row.parsed === null ? null : { ok: row.parsed === 1, reason: row.parsed === 1 ? null : (row.reason ?? null) },
    shape: row.shape ?? null,
    usageSeconds: row.usage_seconds ?? null,
    reason: row.reason ?? null,
    qasm: row.qasm ?? null,
  };
}

/** Whether a smoke job may be sent now, with the month's seconds. */
async function smokeGuard(env: Env, now: number): Promise<{ verdict: { reason: string; retryAt: number | null } | null; seconds: number }> {
  const [guardRes, monthRes] = await env.DB.batch([
    env.DB.prepare(SQL_SMOKE_GUARD),
    env.DB.prepare(SQL_QPU_MONTH).bind(monthStart(now), UNKNOWN_USAGE_SECONDS),
  ]);
  const g = (guardRes.results as SmokeGuardRow[])[0];
  const seconds = (monthRes.results as { seconds: number }[])[0]?.seconds ?? 0;
  const verdict = smokeVerdict({
    now,
    smokePending: (g?.pending ?? 0) > 0,
    sundayOpen: (g?.sunday_open ?? 0) > 0,
    lastRanAt: g?.last_ran_at ?? null,
    lastAttemptAt: g?.last_attempt_at ?? null,
    monthSeconds: seconds,
  });
  return { verdict, seconds };
}

async function readSmoke(env: Env, id: number): Promise<QpuSmoke | null> {
  const row = await env.DB.prepare(SQL_SMOKE_ONE).bind(id).first<SmokeRow>();
  return row ? smokeOf(row) : null;
}

/**
 * `POST /api/pet/qpu/smoke`: sends one Bell-pair job (`submitSmoke`) when
 * `smokeVerdict` allows it (else 409 with the reason and `retryAt`), and
 * answers 202 with the queued job, or 502 when IBM could not take it. The
 * attempt row is inserted under the same rules first, so racing requests
 * send one job at most. 2 requests a minute per client IP.
 */
async function startSmoke(request: Request, env: Env): Promise<Response> {
  const limit = await countAgainst(env, [[QPU_SMOKE_LIMIT, clientIp(request)]]);
  if (limit.limited) return rateLimited(limit.retryAt);
  if (!env.IBM_QUANTUM_API_KEY) return json({ error: "hardware runs are not configured on this server (no IBM Quantum key)" }, 503);
  const now = Date.now();
  const guard = await smokeGuard(env, now);
  if (guard.verdict) {
    const latest = await env.DB.prepare(SQL_SMOKE_LATEST).first<SmokeRow>();
    return json({ error: guard.verdict.reason, retryAt: guard.verdict.retryAt, smoke: latest ? smokeOf(latest) : null, budget: budgetOf(guard.seconds) }, 409);
  }
  const opened = await env.DB.prepare(SQL_SMOKE_INSERT).bind(now, now - SMOKE_EVERY_MS, now - SMOKE_RETRY_GAP_MS).first<{ id: number; created_at: number }>();
  if (!opened) return json({ error: "another smoke attempt started a moment ago; GET /api/pet/qpu/smoke follows it" }, 409);

  let client: IbmQuantum | null = null;
  try {
    client = await connect(env, null);
    const quota = instanceQuotaVerdict(await client.instanceUsage().catch(() => null));
    if (quota) {
      await env.DB.prepare(SQL_SMOKE_FAILED).bind(opened.id, quota, Date.now(), null, "submitting").run();
      return json({ error: quota, smoke: await readSmoke(env, opened.id) }, 409);
    }
    const sent = await submitSmoke(client, smokeTag(opened.id, opened.created_at));
    await env.DB.prepare(SQL_SMOKE_SENT)
      .bind(opened.id, client.crn, sent.backend, JSON.stringify(sent.pair), sent.jobId, sent.qasm, Date.now())
      .run();
    return json({ ok: true, smoke: await readSmoke(env, opened.id) }, 202);
  } catch (error) {
    if (error instanceof IbmError && error.status === 401) forgetToken();
    const reason = `the smoke job could not be sent: ${describeFailure(error, [env.IBM_QUANTUM_API_KEY, client?.crn])}`;
    console.warn("pet: smoke submission failed", reason);
    await env.DB.prepare(SQL_SMOKE_FAILED).bind(opened.id, publicReason(reason), Date.now(), null, "submitting").run();
    return json({ error: publicReason(reason), smoke: await readSmoke(env, opened.id) }, 502);
  }
}

/**
 * `GET /api/pet/qpu/smoke`: the latest smoke job; an open one is polled
 * first (`advanceSmoke`, at most once per 30 s across isolates). `next` says
 * whether a POST would be accepted now and from when.
 */
async function smokeStatus(env: Env): Promise<Response> {
  const now = Date.now();
  let row = await env.DB.prepare(SQL_SMOKE_LATEST).first<SmokeRow>();
  let polled = false;
  if (row && isOpenStatus(row.status)) {
    polled = await advanceSmoke(env, row, now);
    if (polled) row = (await env.DB.prepare(SQL_SMOKE_ONE).bind(row.id).first<SmokeRow>()) ?? row;
  }
  const guard = await smokeGuard(env, Date.now());
  return json({
    smoke: row ? smokeOf(row) : null,
    polled,
    next: {
      allowed: Boolean(env.IBM_QUANTUM_API_KEY) && guard.verdict === null,
      reason: env.IBM_QUANTUM_API_KEY ? (guard.verdict?.reason ?? null) : "hardware runs are not configured on this server",
      retryAt: guard.verdict?.retryAt ?? null,
    },
    budget: budgetOf(guard.seconds),
  });
}

/**
 * Moves an open smoke job one step, when this caller wins the claim (one
 * poll per SMOKE_POLL_GAP_MS across isolates); returns whether it polled.
 * `submitting` older than the submission lease: the request that sent it was
 * cut off, so the job is looked up by its tag (adopted) or the attempt
 * fails. `queued | running`: the job's status; completed → results through
 * the Sunday's parser (`readSmokeResult`) and metrics; failed / cancelled →
 * failed with IBM's reason; open 24 h after it was sent → cancelled.
 * A poll that cannot read IBM leaves the job open with the reason.
 */
async function advanceSmoke(env: Env, row: SmokeRow, now: number): Promise<boolean> {
  if (row.status === "submitting" && now - row.created_at < SUBMIT_LEASE_MS) return false;
  const claim = await env.DB.prepare(SQL_SMOKE_CLAIM).bind(now, row.id, row.status, now - SMOKE_POLL_GAP_MS).run();
  if ((claim.meta.changes ?? 0) === 0) return false;
  const secrets = [env.IBM_QUANTUM_API_KEY, row.crn];
  const fail = async (reason: string, usage: number | null = null) => {
    await env.DB.prepare(SQL_SMOKE_FAILED).bind(row.id, publicReason(reason, secrets), Date.now(), usage, row.status).run();
  };
  if (!env.IBM_QUANTUM_API_KEY) {
    await fail("the IBM Quantum key was removed before the smoke job finished");
    return true;
  }
  try {
    if (row.status === "submitting") {
      const client = await connect(env, null);
      const found = await client.jobByTag(smokeTag(row.id, row.created_at));
      if (found) await env.DB.prepare(SQL_SMOKE_SENT).bind(row.id, client.crn, found.backend, null, found.id, null, now).run();
      else await fail("the submission was cut off before IBM answered, and IBM holds no job with its tag");
      return true;
    }
    if (!row.job_id || !row.crn) {
      await fail("the job id was not recorded");
      return true;
    }
    const jobId = row.job_id;
    const client = await connect(env, row.crn);
    const phase = jobPhaseFrom(await client.job(jobId));
    if (!phase) throw new IbmError("IBM answered an unreadable job status");
    if (phase.phase === "completed") {
      let reading: SmokeReading;
      try {
        reading = readSmokeResult(await client.results(jobId));
      } catch (error) {
        reading = { parsed: false, reason: `the results could not be fetched: ${describeFailure(error, secrets)}`, counts: null, collapse: null, shape: "" };
      }
      const metrics = await client.metrics(jobId).catch(() => null);
      await env.DB.prepare(SQL_SMOKE_DONE)
        .bind(
          row.id,
          reading.counts ? JSON.stringify(reading.counts) : null,
          reading.collapse,
          reading.parsed ? 1 : 0,
          reading.shape || null,
          usageSecondsFrom(metrics),
          finishedAtFrom(metrics) ?? now,
          reading.parsed ? null : publicReason(`the Sunday's parser refused IBM's result: ${reading.reason ?? "unknown"}`, secrets),
          row.status,
        )
        .run();
      return true;
    }
    if (phase.phase === "failed" || phase.phase === "cancelled") {
      const metrics = await client.metrics(jobId).catch(() => null);
      await fail(`IBM reported the job ${phase.phase}${phase.reason ? `: ${phase.reason}` : ""}`, usageSecondsFrom(metrics));
      return true;
    }
    if (row.submitted_at !== null && now - row.submitted_at >= SMOKE_DEADLINE_MS) {
      await client.cancel(jobId).catch(() => undefined);
      await fail(`the job was still ${phase.phase} on ${row.backend ?? "IBM"} 24 hours after it was sent; cancelled`);
      return true;
    }
    await env.DB.prepare(SQL_SMOKE_PHASE).bind(row.id, phase.phase).run();
  } catch (error) {
    if (error instanceof IbmError && error.status === 401) forgetToken();
    const reason = describeFailure(error, secrets);
    console.warn("pet: smoke poll failed", row.id, reason);
    // IBM unreadable for a day: give the attempt up, so it does not block the next smoke test forever
    if (now - (row.submitted_at ?? row.created_at) >= SMOKE_DEADLINE_MS) {
      await fail(`IBM could not be read for 24 hours (${reason})`);
    } else {
      await env.DB.prepare(SQL_SMOKE_NOTE).bind(row.id, `the last poll could not read IBM: ${reason}`).run();
    }
  }
  return true;
}

/**
 * Advances the oldest open smoke job, never throws. `pollQpu` (the cron, every
 * 15 minutes) calls it, so a smoke job settles without anyone asking.
 */
export async function pollSmoke(env: Env): Promise<void> {
  try {
    const row = await env.DB.prepare(SQL_SMOKE_NEXT_OPEN).first<SmokeRow>();
    if (row) await advanceSmoke(env, row, Date.now());
  } catch (error) {
    console.warn("pet: smoke poll failed", error);
  }
}

/* ------------------------------------------------------------------ */
/* PetState                                                            */
/* ------------------------------------------------------------------ */

/** The full state; with `wallet` also that wallet's signed gates today. */
async function buildPetState(env: Env, row: StateRow, wallet: string | null = null): Promise<PetState> {
  return (await readPetState(env, row, wallet)).state;
}

/** Hardware runs read with the state: the open one and the latest settled one are among the newest three. */
const QPU_RUNS_READ = 3;

/** The state, and whether the open hardware run is due a lazy poll (none in the last minute). */
async function readPetState(env: Env, row: StateRow, wallet: string | null): Promise<{ state: PetState; pollDue: boolean }> {
  const now = Date.now();
  const statements = [
    env.DB.prepare(SQL_BODY).bind(row.day),
    env.DB.prepare(SQL_RECENT).bind(row.day, RECENT_ACTIONS),
    env.DB.prepare(SQL_HISTORY).bind(HISTORY_DAYS),
    env.DB.prepare(SQL_SIGNED_TODAY).bind(row.day),
    env.DB.prepare(SQL_LEADER).bind(row.day),
    env.DB.prepare(SQL_QPU_RECENT).bind(QPU_RUNS_READ),
    env.DB.prepare(SQL_QPU_MONTH).bind(monthStart(now), UNKNOWN_USAGE_SECONDS),
  ];
  if (wallet !== null) statements.push(env.DB.prepare(SQL_MY_GATES).bind(row.day, wallet));
  const [bodyRes, recentRes, historyRes, signedRes, leaderRes, runsRes, monthRes, mineRes] = await env.DB.batch(statements);
  const runRows = runsRes.results as RunRow[];
  const openRow = runRows.find((r) => isOpenStatus(r.status)) ?? null;
  const settledRow = runRows.find((r) => !isOpenStatus(r.status)) ?? null;
  const collapseAt = collapseAtFor(row.day_started_at);
  const qpu: PetQpu = {
    enabled: Boolean(env.IBM_QUANTUM_API_KEY),
    next: nextQpuCollapse(row.day, collapseAt),
    pending: openRow ? runOf(openRow) : null,
    last: settledRow ? runOf(settledRow) : null,
    monthSeconds: (monthRes.results as { seconds: number }[])[0]?.seconds ?? 0,
    monthBudgetSeconds: MONTH_BUDGET_SECONDS,
  };
  const pollDue = openRow !== null && (openRow.polled_at === null || now - openRow.polled_at >= QPU_POLL_GAP_MS);
  const bodyRow = (bodyRes.results as DayRow[])[0];
  const signedToday = (signedRes.results as { n: number }[])[0]?.n ?? 0;
  const leaderRow = (leaderRes.results as LeaderRow[])[0];
  const leader: PetLeader | null = leaderRow ? { wallet: leaderRow.wallet, gates: leaderRow.gates } : null;
  const myGates = wallet === null ? null : ((mineRes?.results as { n: number }[] | undefined)?.[0]?.n ?? 0);
  const body: Traits = bodyRow
    ? { form: bodyRow.form, character: bodyRow.character, ability: bodyRow.ability, palette: bodyRow.palette }
    : DAY_ONE_BODY;

  const state = parseState(row.state);
  const protection = activeProtection(parseProtected(row.protected), now);
  const p1 = qubitP1(state);
  const qubits: PetQubit[] = p1.map((p, i) => ({ i, p1: p, protectedUntil: protection[i] ?? null }));
  const pForm = formProbabilities(state);
  const top: PetOutcome[] = topOutcomes(state, TOP_OUTCOMES).map((o) => ({ ...o, form: traitsFromBits(o.bits).form }));
  const recent = (recentRes.results as ActionRow[]).map(actionOf).filter((a): a is PetAction => a !== null);
  const history = (historyRes.results as DayRow[]).map(dayOf);

  return {
    state: {
      day: row.day,
      dayStartedAt: row.day_started_at,
      collapseAt,
      ...body,
      pForm,
      pCat: pForm.cat ?? 0,
      top,
      qubits,
      actionsToday: row.actions_today,
      recent,
      history,
      signedToday,
      myGates,
      leader,
      qpu,
    },
    pollDue,
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

/** The `?wallet=` of a read: null when absent, an error when malformed. */
function walletParam(url: URL): Parsed<string | null> {
  const raw = url.searchParams.get("wallet");
  if (raw === null || raw === "") return { ok: true, value: null };
  if (!isWalletAddress(raw)) return fail("wallet must be a base58 Solana address");
  return { ok: true, value: raw };
}

async function getPet(env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const wallet = walletParam(url);
  if (!wallet.ok) return badRequest(wallet.error);
  const row = await currentState(env, ctx);
  const { state, pollDue } = await readPetState(env, row, wallet.value);
  // A day measuring on hardware is followed by the cron; a visit nudges it too, at most once a minute.
  if (pollDue) ctx.waitUntil(pollQpu(env));
  return json(state);
}

/**
 * `GET /api/pet/qpu`: the newest hardware runs; `?day=N` one run with its
 * circuit, `&format=qasm` the circuit alone as text (the exact OpenQASM 3
 * sent to IBM).
 */
async function qpuRuns(env: Env, url: URL): Promise<Response> {
  const rawDay = url.searchParams.get("day");
  if (rawDay === null) {
    const { results } = await env.DB.prepare(SQL_QPU_RECENT).bind(QPU_RUNS_LISTED).all<RunRow>();
    return json(results.map(runOf));
  }
  const day = Number(rawDay);
  if (!Number.isInteger(day) || day < 1) return badRequest("day must be a positive integer");
  const row = await env.DB.prepare(SQL_QPU_ONE).bind(day).first<RunRow>();
  if (!row) return json({ error: "no hardware run for that day" }, 404);
  if (url.searchParams.get("format") === "qasm") {
    if (!row.qasm) return json({ error: "this run has no circuit on record" }, 404);
    return new Response(row.qasm, {
      headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return json({ ...runOf(row), qasm: row.qasm ?? null });
}

type ActRequest = { gate: "CNOT"; q: number; t: number } | { gate: Exclude<Gate, "CNOT">; q: number; t: null };
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): Parsed<never> => ({ ok: false, error });

export function parseAct(input: unknown): Parsed<ActRequest> {
  if (!isRecord(input)) return fail("body must be a JSON object");
  const { gate, q, t } = input;
  if (!isGate(gate)) return fail("gate must be one of H, X, CNOT, MEASURE, PROTECT, MUTATE");
  if (!isQubitIndex(q)) return fail("q must be an integer in 0..9");
  if (gate === "CNOT") {
    if (!isQubitIndex(t)) return fail("t must be an integer in 0..9 for CNOT");
    if (t === q) return fail("t must differ from q");
    return { ok: true, value: { gate, q, t } };
  }
  if (t !== undefined && t !== null) return fail("t is only used by CNOT");
  return { ok: true, value: { gate, q, t: null } };
}

/** The optional signed fields of an act body: all three or none; `day` may come alone. */
export interface SignedFields {
  wallet: string;
  nonce: string;
  sig: string;
}

export interface ActExtras {
  /** the day the client signed (or saw); null when not sent */
  day: number | null;
  signed: SignedFields | null;
}

export function parseActExtras(input: unknown): Parsed<ActExtras> {
  if (!isRecord(input)) return fail("body must be a JSON object");
  const { day, wallet, nonce, sig } = input;
  let dayValue: number | null = null;
  if (day !== undefined && day !== null) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1) return fail("day must be a positive integer");
    dayValue = day;
  }
  const given = [wallet, nonce, sig].filter((v) => v !== undefined && v !== null).length;
  if (given === 0) return { ok: true, value: { day: dayValue, signed: null } };
  if (given !== 3) return fail("a signed gate needs wallet, nonce and sig together");
  if (!isWalletAddress(wallet)) return fail("wallet must be a base58 Solana address");
  if (!isGateNonce(nonce)) return fail("nonce must be 32 hex characters (16 random bytes)");
  if (typeof sig !== "string" || sig.length === 0 || sig.length > 128) return fail("sig must be a base64 Ed25519 signature");
  if (dayValue === null) return fail("a signed gate needs the day it was signed for");
  return { ok: true, value: { day: dayValue, signed: { wallet, nonce, sig } } };
}

async function act(request: Request, env: Env, ctx: ExecutionContext, deps: PetDeps): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const parsed = parseAct(body.value);
  if (!parsed.ok) return badRequest(parsed.error);
  const extras = parseActExtras(body.value);
  if (!extras.ok) return badRequest(extras.error);
  const { gate, q, t } = parsed.value;
  const { signed } = extras.value;
  const ip = clientIp(request);

  // The cheap gate first: an address or wallet that has used up its minute, keeps
  // sending refused gates or replays a nonce is answered from one read, before
  // the state is loaded, the signature checked or anything written.
  const pre = await precheckAct(env, ip, signed);
  if (pre.retryAt !== null) return rateLimited(pre.retryAt);
  if (pre.nonceUsed) return refused(env, ctx, ip, json({ error: "nonce already used" }, 409));

  const row = await currentState(env, ctx);
  const now = Date.now();
  const protection = activeProtection(parseProtected(row.protected), now);

  // A gate signed (or aimed) at another day is stale: the register it meant is gone.
  if (extras.value.day !== null && extras.value.day !== row.day) {
    return refused(env, ctx, ip, json({ error: "day mismatch, the register is on another day", day: row.day }, 409));
  }
  if (signed && !verifyGateSig(signed.wallet, GATE_MESSAGE(row.day, gate, q, t, signed.nonce), signed.sig)) {
    return refused(env, ctx, ip, json({ error: "bad signature" }, 401));
  }

  // Rules first, so a refused gate does not spend a slot or a nonce.
  const touched = t === null ? [q] : [q, t];
  for (const i of touched) {
    const until = protection[i];
    if (until !== undefined) return refused(env, ctx, ip, json({ error: "qubit protected", q: i, until }, 409));
  }
  const protectedCount = Object.keys(protection).length;
  if (gate === "PROTECT" && protectedCount >= MAX_PROTECTED) {
    const until = Math.min(...Object.values(protection));
    return refused(env, ctx, ip, json({ error: `${MAX_PROTECTED} qubits are already protected`, until }, 409));
  }

  // A signed gate also passes the Sybil rules: the address's wallets of the day and an account on chain.
  const tag = await clientTag(request);
  if (signed) {
    const verdict = await sybilCheck(env, deps, tag, signed.wallet, now);
    if (!verdict.ok) return refused(env, ctx, ip, verdict.response);
  }

  // Only now is a slot spent: per wallet and per address for a signed gate, per address for an anonymous one.
  const limit = await countAgainst(env, signed ? [[PET_WALLET_LIMIT, signed.wallet], [PET_IP_LIMIT, ip]] : [[PET_LIMIT, ip]]);
  if (limit.limited) return rateLimited(limit.retryAt);

  const state = parseState(row.state);
  let next = state;
  let nextProtection = protection;
  let outcome: 0 | 1 | null = null;
  // MUTATE's angle is logged, so the day can be replayed as a circuit on hardware.
  let theta: number | null = null;
  switch (gate) {
    case "H":
      next = H(state, q);
      break;
    case "X":
      next = X(state, q);
      break;
    case "CNOT":
      next = CNOT(state, q, t);
      break;
    case "MEASURE": {
      const measured = measure(state, q);
      next = measured.state;
      outcome = measured.outcome;
      break;
    }
    case "PROTECT":
      nextProtection = { ...protection, [q]: now + PROTECT_MS };
      break;
    case "MUTATE":
      theta = (randomUnit() - 0.5) * Math.PI;
      next = RY(state, q, theta);
      break;
  }

  // One transaction: the state, the action row and (signed) the nonce, so nothing is written unless the gate is applied.
  const nonce = signed?.nonce ?? null;
  const statements = [
    env.DB.prepare(SQL_APPLY).bind(JSON.stringify(serialise(next)), JSON.stringify(nextProtection), now, row.day, nonce),
    env.DB.prepare(SQL_INSERT_ACTION).bind(row.day, gate, q, t, outcome, tag, signed?.wallet ?? null, now, row.day, nonce, theta),
  ];
  if (signed) statements.push(env.DB.prepare(SQL_USE_NONCE).bind(signed.nonce, signed.wallet, now));
  const results = await env.DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // Nothing applied: a signed gate whose nonce insert was also a no-op lost the race against its own replay.
    if (signed && (results[2]?.meta.changes ?? 0) === 0) return refused(env, ctx, ip, json({ error: "nonce already used" }, 409));
    return refused(env, ctx, ip, json({ error: "the day collapsed while your gate was in flight, reload" }, 409));
  }
  if (signed && randomUnit() < 0.02) ctx.waitUntil(prune(env, now));

  const fresh = await ensureState(env);
  const petState = await buildPetState(env, fresh, signed?.wallet ?? null);
  return json(outcome === null ? { ok: true, state: petState } : { ok: true, outcome, state: petState });
}

/** `GET /api/pet/badges?wallet=`: the wallet's badges, newest day first (influencer before witness). */
async function badges(env: Env, url: URL): Promise<Response> {
  const wallet = walletParam(url);
  if (!wallet.ok) return badRequest(wallet.error);
  if (wallet.value === null) return badRequest("wallet is required");
  const { results } = await env.DB.prepare(SQL_BADGES).bind(wallet.value, MAX_BADGES).all<BadgeRow>();
  return json(results.map(badgeOf).filter((b): b is PetBadge => b !== null));
}

async function history(env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get("limit");
  let limit = DEFAULT_HISTORY;
  if (raw !== null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return badRequest("limit must be a positive integer");
    limit = Math.min(n, MAX_HISTORY);
  }
  const { results } = await env.DB.prepare(SQL_HISTORY).bind(limit).all<DayRow>();
  return json(results.map(dayOf));
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * Serves /api/pet, /api/pet/act, /api/pet/history, /api/pet/badges,
 * /api/pet/qpu, /api/pet/qpu/check and /api/pet/qpu/smoke; null for any other path.
 * `parts` is `url.pathname.split("/").filter(Boolean)`;
 * `deps.rpc` is the Worker's RPC rotation for the on-chain wallet check.
 */
export async function handlePet(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  parts: string[],
  url: URL,
  deps: PetDeps = {},
): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "pet" || parts.length > 4) return null;
  const sub = parts.length > 2 ? parts.slice(2).join("/") : undefined;
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  try {
    if (sub === undefined && method === "GET") return await getPet(env, ctx, url);
    if (sub === "act" && method === "POST") return await act(request, env, ctx, deps);
    if (sub === "history" && method === "GET") return await history(env, url);
    if (sub === "badges" && method === "GET") return await badges(env, url);
    if (sub === "qpu" && method === "GET") return await qpuRuns(env, url);
    if (sub === "qpu/check" && method === "GET") return await qpuCheck(request, env);
    if (sub === "qpu/smoke" && method === "POST") return await startSmoke(request, env);
    if (sub === "qpu/smoke" && method === "GET") return await smokeStatus(env);
  } catch (error) {
    console.error("pet api error", method, url.pathname, error);
    return json({ error: "internal error" }, 500);
  }
  return null;
}

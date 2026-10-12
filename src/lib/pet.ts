/**
 * Quantum pet: types shared by the Worker (worker/pet.ts) and the pages, plus
 * the browser client for `GET /api/pet/history`. `GET /api/pet` and
 * `POST /api/pet/act` go through src/lib/petGate.ts (signed and anonymous gates).
 *
 * The Worker imports the types from this file and type-checks it with its own
 * tsconfig, which has no `@/` path alias. That is why nothing here is imported
 * from `./api`: `API_BASE` follows the same rule as there, repeated in one line
 * (see src/lib/scan.ts for the same arrangement).
 */

export type Gate = "H" | "X" | "CNOT" | "MEASURE" | "PROTECT" | "MUTATE";

export const GATES: readonly Gate[] = ["H", "X", "CNOT", "MEASURE", "PROTECT", "MUTATE"];

export interface PetQubit {
  i: number;
  /** Probability of reading 1, from the current state vector. */
  p1: number;
  /** unix ms until which gates on this qubit are refused, or null. */
  protectedUntil: number | null;
}

export interface PetOutcome {
  /** 10 characters, bit 0 (qubit 0) first. */
  bits: string;
  p: number;
  form: string;
}

export interface PetAction {
  gate: Gate;
  q: number;
  t: number | null;
  outcome: number | null;
  /** unix ms */
  at: number;
  /** base58 wallet that signed the gate; null or absent for an anonymous one (src/lib/petGate.ts) */
  wallet?: string | null;
  /** MUTATE: the RY angle in radians; null for other gates and for mutates logged before angles were kept */
  theta?: number | null;
}

/** Where a day's collapse was drawn: the statevector simulator, or an IBM quantum computer (Sundays). */
export type PetSource = "simulator" | "qpu";

export interface PetDay {
  day: number;
  bits: string;
  form: string;
  character: string;
  ability: string;
  palette: string;
  /** gates applied during that day */
  actions: number;
  /** probability of the measured string just before the collapse */
  pTop: number;
  /** unix ms */
  measuredAt: number;
  /** the wallet with the most signed gates that day (the "influencer"), null when nobody signed */
  topWallet?: string | null;
  /** how many signed gates topWallet applied that day */
  topGates?: number | null;
  /** where the collapse was drawn; absent on days before hardware runs existed (the simulator) */
  source?: PetSource;
  /** the IBM backend that measured the day ("ibm_fez"), null on simulator days */
  qpuBackend?: string | null;
  /** the IBM Quantum job id of a hardware day */
  qpuJob?: string | null;
  /** a Sunday drawn on the simulator: why the hardware run did not happen or did not finish */
  qpuNote?: string | null;
}

/**
 * A hardware run's life: `submitting` (the day collapsed, the job is being
 * sent), `queued` / `running` (IBM has it), then `done` (the hardware drew
 * the collapse) or `fallback` (the simulator drew it, `reason` says why).
 */
export type PetQpuStatus = "submitting" | "queued" | "running" | "done" | "fallback";

/**
 * The hardware's distribution next to the simulator's probabilities. With
 * partial measurements in the day, only the shots that repeated the site's
 * outcomes are draws of the site's register, so only those are compared.
 */
export interface PetQpuCompare {
  /** shots compared: the distribution shots that repeated the site's partial measurements (all of them without any) */
  shots: number;
  /** every distribution shot (1000); absent on summaries written before it was recorded */
  totalShots?: number;
  /** per form: the hardware's frequency and the simulator's probability */
  forms: { form: string; hardware: number; simulator: number }[];
  /** the most frequent hardware outcomes (bit 0 first), up to 8 */
  top: { bits: string; hardware: number; simulator: number }[];
  /** Hellinger fidelity between the two distributions, 0..1 */
  fidelity: number;
}

/** One weekly hardware collapse, as `GET /api/pet` and `GET /api/pet/qpu` report it. */
export interface PetQpuRun {
  /** the register day whose collapse this measures */
  day: number;
  status: PetQpuStatus;
  backend: string | null;
  jobId: string | null;
  /** unix ms: when the day collapsed and the run started */
  startedAt: number;
  /** unix ms: the run falls back to the simulator if IBM has not finished by then */
  deadlineAt: number;
  submittedAt: number | null;
  finishedAt: number | null;
  /** the collapse the hardware drew (the first shot that repeated the site's partial measurements), bit 0 first; null until done */
  bits: string | null;
  /** CZ gates in the compiled circuit */
  twoQubitGates: number | null;
  /** the physical qubits of the line, position 0 first */
  chain: number[] | null;
  /** mid-circuit measurements: the site's outcomes, the hardware's in the collapse shot, distribution shots that matched the site */
  partial: { site: number[]; hardware: number[] | null; matched: number | null } | null;
  compare: PetQpuCompare | null;
  /** QPU seconds IBM charged */
  usageSeconds: number | null;
  /** why a run fell back, or the last submission error while it retries */
  reason: string | null;
}

/** The weekly hardware collapse as the pet page shows it. */
export interface PetQpu {
  /** the server holds an IBM Quantum key; without it every day is drawn on the simulator */
  enabled: boolean;
  /** the next Sunday 00:00 UTC collapse and the day it ends */
  next: { day: number; at: number };
  /** a collapse being measured on hardware right now */
  pending: PetQpuRun | null;
  /** the latest settled run */
  last: PetQpuRun | null;
  /** QPU seconds used this UTC month and what the site allows itself */
  monthSeconds: number;
  monthBudgetSeconds: number;
}

/** The wallet leading today's signed gates, as `GET /api/pet` reports it. */
export interface PetLeader {
  wallet: string;
  gates: number;
}

export type PetBadgeKind = "witness" | "influencer";

/** One badge row from `GET /api/pet/badges?wallet=`: awarded at the collapse of `day`. */
export interface PetBadge {
  wallet: string;
  day: number;
  kind: PetBadgeKind;
  /** the form that day collapsed into, null if the day row is missing */
  form: string | null;
  /** unix ms of the collapse, null if the day row is missing */
  measuredAt: number | null;
  /** signed gates the wallet applied that day */
  gates: number;
}

/** The signed form of a gate (src/lib/petGate.ts `signGate`): sent next to gate, q and t. */
export interface SignedGate {
  /** the register day the message was signed for; the Worker refuses another day */
  day: number;
  wallet: string;
  /** 32 hex characters, single use */
  nonce: string;
  /** base64 Ed25519 signature over GATE_MESSAGE(day, gate, q, t, nonce) */
  sig: string;
}

export interface PetState {
  day: number;
  /** unix ms */
  dayStartedAt: number;
  /** unix ms: the next 00:00 UTC after dayStartedAt */
  collapseAt: number;
  /** today's body: yesterday's collapse (day 1 = cat/curious/superposition/ice) */
  form: string;
  character: string;
  ability: string;
  palette: string;
  /** tonight's odds */
  pForm: Record<string, number>;
  pCat: number;
  /** top 8 outcomes */
  top: PetOutcome[];
  qubits: PetQubit[];
  actionsToday: number;
  /** last 12 actions of the current day, newest first */
  recent: PetAction[];
  /** last 7 collapsed days, newest first */
  history: PetDay[];
  /** wallet-signed gates applied today */
  signedToday?: number;
  /** signed gates by the wallet of `?wallet=` (or of a signed act) today; null without one */
  myGates?: number | null;
  /** the wallet with the most signed gates so far today (tonight's influencer if it holds), null when nobody signed */
  leader?: PetLeader | null;
  /** the weekly collapse on IBM hardware (SPEC 3.6) */
  qpu?: PetQpu;
}

export interface ActResult {
  ok: true;
  /** MEASURE only */
  outcome?: number;
  state: PetState;
}

/** Tints per palette: `accent` multiplies into the picture, `glow` is for CSS halos. */
export const PALETTES: Record<string, { accent: string; glow: string }> = {
  ice: { accent: "#dfe8ff", glow: "#4d8bff" },
  ember: { accent: "#ffd9b0", glow: "#ff7a3d" },
  violet: { accent: "#e6d8ff", glow: "#9b6dff" },
  mint: { accent: "#d9ffef", glow: "#2fd39a" },
};

export const DEFAULT_PALETTE = { accent: "#ffffff", glow: "#4d8bff" };

/** The tint pair for a palette name; white for anything unknown. */
export function paletteOf(name: string): { accent: string; glow: string } {
  return PALETTES[name] ?? DEFAULT_PALETTE;
}

const capitalise = (s: string): string => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));

/** An IBM backend name or job id as it may appear in a post: short, letters, digits, "_" and "-" only. */
const qpuToken = (value: string | null | undefined): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

/** X's limit on a post. */
const POST_MAX_CHARS = 280;

/**
 * The X post for a collapsed day. The Worker posts exactly this text at the
 * collapse (worker/x.ts) and the pet page offers it to copy, so the two
 * never drift. `siteUrl` is the site origin, with or without a trailing slash.
 * A day measured on IBM hardware says so, with the backend and the job id
 * ("Measured on IBM quantum hardware: ibm_fez · job <id>."); the job id is
 * left out if the post would pass 280 characters. Simulator days are unchanged.
 */
export function postTextForDay(day: PetDay, siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, "");
  const post = (hardware: string) =>
    `Day ${day.day}: the quantum pet collapsed into a ${day.form}. ` +
    `${capitalise(day.character)}, with ${day.ability}. ` +
    `${day.actions} gates applied by visitors.${hardware} A new superposition starts now. ${base}/pet`;
  if (day.source !== "qpu") return post("");

  const backend = qpuToken(day.qpuBackend);
  const job = qpuToken(day.qpuJob);
  const where = backend ? `IBM quantum hardware: ${backend}` : "IBM quantum hardware";
  const full = post(` Measured on ${where}${job ? ` · job ${job}` : ""}.`);
  return full.length <= POST_MAX_CHARS || !job ? full : post(` Measured on ${where}.`);
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/** Same rule as `API_BASE` in ./api: empty in production (same origin), the deployed Worker for local dev. */
const API_BASE: string = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

/** Thrown on any non-2xx response. A 429 carries `retryAt` (unix ms) and a message that names the wait. */
export class PetApiError extends Error {
  readonly status: number;
  readonly retryAt: number | null;

  constructor(status: number, message: string, retryAt: number | null = null) {
    super(message);
    this.name = "PetApiError";
    this.status = status;
    this.retryAt = retryAt;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const serverMessage = isRecord(data) && typeof data.error === "string" ? data.error : null;
    if (res.status === 429) {
      const retryAt = isRecord(data) && typeof data.retryAt === "number" ? data.retryAt : null;
      const wait = retryAt === null ? null : Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
      const message =
        wait === null ? (serverMessage ?? "rate limited") : `${serverMessage ?? "rate limited"}, next gate in ${wait} s`;
      throw new PetApiError(429, message, retryAt);
    }
    throw new PetApiError(res.status, serverMessage ?? `request failed with status ${res.status}`);
  }
  return data as T;
}

export async function fetchPetHistory(limit = 30): Promise<PetDay[]> {
  return request<PetDay[]>(`/api/pet/history?limit=${encodeURIComponent(String(limit))}`);
}

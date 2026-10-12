/**
 * Pure helpers for the quantum pet views: countdowns, probabilities, bit
 * strings and one-line descriptions of gates. Nothing here reads the clock;
 * "now" is always passed in, so every function can run during render.
 */

import type { Gate, PetAction, PetQpuStatus, PetQubit } from "@/lib/pet";

export const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "day 07" */
export const dayLabel = (day: number): string => `day ${pad2(day)}`;

/** "HH:MM:SS" for a duration in ms; never negative. */
export function formatCountdown(ms: number): string {
  const d = Math.max(0, ms);
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  const s = Math.floor((d % 60_000) / 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** "12.5%" with two decimals under 1%, so tiny odds do not read as zero. */
export function formatPct(p: number): string {
  if (!Number.isFinite(p)) return "—";
  const pct = p * 100;
  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

/** Two decimals for a probability shown next to a bar. */
export const formatP = (p: number): string => (Number.isFinite(p) ? p.toFixed(2) : "—");

/** Groups the ten bits by trait field: form (3) · character (2) · ability (3) · palette (2). */
export function groupBits(bits: string): string {
  if (bits.length !== 10) return bits;
  return `${bits.slice(0, 3)} ${bits.slice(3, 5)} ${bits.slice(5, 8)} ${bits.slice(8, 10)}`;
}

/** Seconds left until `retryAt`, 0 when it has passed or either side is unknown. */
export function waitSeconds(retryAt: number | null, now: number | null): number {
  if (retryAt === null || now === null || retryAt <= now) return 0;
  return Math.ceil((retryAt - now) / 1000);
}

/** Whether a qubit refuses gates at `now`. Unknown time counts as not protected. */
export function isProtected(q: PetQubit, now: number | null): boolean {
  return q.protectedUntil !== null && now !== null && q.protectedUntil > now;
}

/** Minutes left on a protection, rounded up; 0 when it has passed. */
export function protectedMinutes(q: PetQubit, now: number | null): number {
  if (!isProtected(q, now) || q.protectedUntil === null || now === null) return 0;
  return Math.max(1, Math.ceil((q.protectedUntil - now) / 60_000));
}

/** The CNOT target for a selected control: the next qubit around. */
export const cnotTarget = (q: number): number => (q + 1) % 10;

/**
 * A qubit to act on when none is selected: a random unprotected one, or any
 * at all when every qubit is protected. Uses Math.random, so call it from an
 * event handler only.
 */
export function pickRandomQubit(qubits: PetQubit[], now: number | null): number {
  const open = qubits.filter((q) => !isProtected(q, now)).map((q) => q.i);
  const pool = open.length > 0 ? open : qubits.map((q) => q.i);
  if (pool.length === 0) return 0;
  return pool[Math.floor(Math.random() * pool.length)];
}

export const GATE_INFO: Record<Gate, { label: string; title: string }> = {
  H: { label: "H", title: "Hadamard: superposition" },
  X: { label: "X", title: "Pauli X: flip" },
  CNOT: { label: "CNOT", title: "Controlled NOT: entangle with the next qubit" },
  MEASURE: { label: "Measure", title: "Collapse one qubit" },
  PROTECT: { label: "Protect", title: "Freeze a qubit for 30 minutes" },
  MUTATE: { label: "Mutate", title: "Random Y rotation" },
};

/** "H on q3", "CNOT q3 → q4", "measure q3 → 1", "protect q3", "mutate q3" */
export function describeAction(a: PetAction): string {
  switch (a.gate) {
    case "CNOT":
      return `CNOT q${a.q} → q${a.t ?? "?"}`;
    case "MEASURE":
      return `measure q${a.q}${a.outcome === null ? "" : ` → ${a.outcome}`}`;
    case "PROTECT":
      return `protect q${a.q}`;
    case "MUTATE":
      return typeof a.theta === "number" ? `mutate q${a.q} · RY(${a.theta.toFixed(2)})` : `mutate q${a.q}`;
    default:
      return `${a.gate} on q${a.q}`;
  }
}

/** "6 d 14 h", "3 h 12 min", "12 min" for a duration in ms; "now" under a minute. */
export function formatSpan(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "now";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m % 60} min`;
  return `${m} min`;
}

/** "2026-10-18 06:00 UTC" from unix ms. */
export function formatUtcMinute(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What a hardware run is doing, in a few words. */
export const QPU_STATUS_LABEL: Record<PetQpuStatus, string> = {
  submitting: "sending",
  queued: "queued",
  running: "running",
  done: "measured",
  fallback: "simulator fallback",
};

/** "ibm_fez" or "IBM Quantum" while the backend is not chosen yet. */
export const backendLabel = (backend: string | null): string => backend ?? "IBM Quantum";

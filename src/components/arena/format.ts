/**
 * Pure helpers for the arena views: probabilities, results from one side's
 * point of view, countdowns, short ids. Nothing here reads the clock; "now"
 * is passed in, so every function can run during render.
 */

import type { ArenaBout, BoutResult, Circuit } from "@/lib/arena";
import { fighterStyle } from "@/lib/arena";

/** "0.750" */
export const formatP3 = (p: number | null | undefined): string =>
  typeof p === "number" && Number.isFinite(p) ? p.toFixed(3) : "—";

/** "75.0%" */
export const formatPct = (p: number): string => `${(p * 100).toFixed(1)}%`;

/** "1216" */
export const formatElo = (elo: number): string => String(Math.round(elo));

/** The first 8 hex of a commit or bout id. */
export const shortHex = (hex: string): string => hex.slice(0, 8);

/** "23 h 59 m" / "4 m" / "0 m"; never negative. */
export function formatHoursLeft(ms: number): string {
  const d = Math.max(0, ms);
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} m` : `${m} m`;
}

/** "4 h 05 m" above an hour, "12 m 07 s" below; never negative. For the tournament's live countdown. */
export function formatCountdown(ms: number): string {
  const d = Math.max(0, ms);
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  const s = Math.floor((d % 60_000) / 1000);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} m` : `${m} m ${String(s).padStart(2, "0")} s`;
}

/** "21:00 UTC" from unix ms. */
export function formatUtcClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(11, 16)} UTC`;
}

/** "+0.250" / "−0.125" / "0.000": a tournament margin. */
export function formatMargin(m: number): string {
  const r = Math.round(m * 1000) / 1000;
  if (r === 0) return "0.000";
  return r > 0 ? `+${r.toFixed(3)}` : `−${Math.abs(r).toFixed(3)}`;
}

/** "1st", "2nd", "3rd", "4th", "11th", "21st" */
export function placeName(place: number): string {
  const tens = place % 100;
  if (tens >= 11 && tens <= 13) return `${place}th`;
  switch (place % 10) {
    case 1:
      return `${place}st`;
    case 2:
      return `${place}nd`;
    case 3:
      return `${place}rd`;
    default:
      return `${place}th`;
  }
}

/** "4" / "3.5": tournament points. */
export const formatPoints = (p: number): string => (Number.isInteger(p) ? String(p) : p.toFixed(1));

/** "2026-10-10 14:02 UTC" from unix ms. */
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export type Outcome = "won" | "lost" | "drew" | "void";

/** What a result means for `role`. A void bout (nobody revealed) has a draw result and no pA. */
export function outcomeFor(result: BoutResult, role: "a" | "b", pA: number | null): Outcome {
  if (result === "draw") return pA === null ? "void" : "drew";
  const aWon = result === "a" || result === "b_forfeit";
  return (role === "a") === aWon ? "won" : "lost";
}

/** "won", "lost by forfeit", "drew", "void (nobody revealed)" */
export function describeOutcome(result: BoutResult, role: "a" | "b", pA: number | null): string {
  const o = outcomeFor(result, role, pA);
  if (o === "void") return "void · nobody revealed";
  if (o === "drew") return "draw";
  const forfeit = result === "a_forfeit" || result === "b_forfeit";
  if (o === "won") return forfeit ? "won · opponent forfeited" : "won";
  return forfeit ? "lost · forfeit" : "lost";
}

/** The side a wallet plays in a bout, or null when it is not in it. */
export function roleOf(bout: ArenaBout, wallet: string | null): "a" | "b" | null {
  if (!wallet) return null;
  return bout.a === wallet ? "a" : bout.b === wallet ? "b" : null;
}

export const opponentOf = (bout: ArenaBout, role: "a" | "b"): string => (role === "a" ? bout.b : bout.a);

/**
 * "A wins" / "B wins" / "draw" for a neutral view. A draw with no pA is a
 * void bout: nobody revealed, nothing was rated.
 */
export function describeResult(result: BoutResult | null, pA: number | null): string {
  switch (result) {
    case "a":
      return "A wins";
    case "b":
      return "B wins";
    case "draw":
      return pA === null ? "void · nobody revealed" : "draw";
    case "a_forfeit":
      return "B wins · A forfeited";
    case "b_forfeit":
      return "A wins · B forfeited";
    default:
      return "open";
  }
}

/**
 * One accent colour per circuit: Hadamard fighters start cold blue, Pauli
 * fighters start warm; every RY shifts the hue by a quarter of its angle.
 * `glow(alpha)` is a valid CSS colour (an hsl() cannot take a hex alpha suffix).
 */
export function circuitTint(c: Circuit): { glow(alpha?: number): string; hueShift: number } {
  const base = fighterStyle(c) === "pauli" ? 32 : 220;
  let shift = 0;
  for (const g of [...c.pre, ...c.post]) if (g.g === "RY") shift += (g.t ?? 0) / 4;
  const hue = ((((base + shift) % 360) + 360) % 360).toFixed(0);
  return { glow: (alpha = 1) => `hsl(${hue} 85% 64% / ${alpha})`, hueShift: shift };
}

/** The ten rounds of a 100-shot exhibition: who took more shots in each chunk of ten. */
export function roundsOf(sequence: string, roundSize = 10): { a: number; b: number; winner: "a" | "b" | "tie" }[] {
  const rounds: { a: number; b: number; winner: "a" | "b" | "tie" }[] = [];
  for (let i = 0; i < sequence.length; i += roundSize) {
    const chunk = sequence.slice(i, i + roundSize);
    let a = 0;
    for (const ch of chunk) if (ch === "0" || ch === "3") a++;
    const b = chunk.length - a;
    rounds.push({ a, b, winner: a > b ? "a" : b > a ? "b" : "tie" });
  }
  return rounds;
}

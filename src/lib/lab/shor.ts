/**
 * Shor's algorithm on N = 15, computed exactly on a classical simulator of the
 * two registers: 8 counting qubits (Q = 256 values of x) and 4 work qubits
 * (a^x mod 15 fits in 4 bits). Nothing here touches quantum hardware; the
 * arithmetic is the real algorithm at a size a laptop handles in milliseconds
 * (the exact QFT spectrum is O(Q²)).
 *
 * Pure module (no React, no DOM, no `@/` imports) so the self-test can run it
 * under node.
 */

export const N = 15;
export const COUNT_QUBITS = 8;
export const WORK_QUBITS = 4;
/** Size of the counting register, 2^COUNT_QUBITS. */
export const Q = 2 ** COUNT_QUBITS;
/** Values of x shown in the modular exponentiation row. */
export const ROW_LEN = 16;

/**
 * Bases the visitor can pick. All are coprime with 15; 14 is the honest
 * failure (its square root of unity is -1, so the gcd step yields 15 and 1).
 */
export const CANDIDATES = [2, 4, 7, 8, 11, 13, 14] as const;
export type Candidate = (typeof CANDIDATES)[number];
export const DEFAULT_A: Candidate = 7;

export type ShorOutcome = "factored" | "odd-period" | "trivial-root" | "lucky-gcd";

export interface ShorRun {
  a: number;
  n: number;
  /** gcd(a, n); 1 means the quantum part is needed */
  g: number;
  /** a^x mod n for x in 0..ROW_LEN-1 */
  sequence: number[];
  /** the period: smallest r > 0 with a^r ≡ 1 (mod n) */
  r: number;
  /** P(y) of the counting register after the QFT, y in 0..Q-1 */
  spectrum: number[];
  /** the y values that carry probability, multiples of Q/r */
  peaks: number[];
  /** a^(r/2) mod n, or null when r is odd */
  half: number | null;
  /** gcd(half - 1, n) and gcd(half + 1, n), or null when the trick cannot run */
  factors: [number, number] | null;
  outcome: ShorOutcome;
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

export function modPow(base: number, exp: number, m: number): number {
  let result = 1;
  let b = base % m;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = (result * b) % m;
    b = (b * b) % m;
    e = Math.floor(e / 2);
  }
  return result;
}

/** a^x mod n for x = 0 .. len-1. */
export function powerSequence(a: number, n: number, len: number): number[] {
  const out: number[] = [];
  let v = 1;
  for (let x = 0; x < len; x++) {
    out.push(v);
    v = (v * a) % n;
  }
  return out;
}

/** Smallest r > 0 with a^r ≡ 1 (mod n); 0 when a and n share a factor. */
export function findPeriod(a: number, n: number): number {
  if (gcd(a, n) !== 1) return 0;
  let v = a % n;
  let r = 1;
  while (v !== 1) {
    v = (v * a) % n;
    r++;
  }
  return r;
}

/**
 * Probability of reading y from the counting register after the QFT, with
 * the work register left unmeasured: the sum over every residue class
 * x ≡ x0 (mod r) of |(1/Q) Σ e^{2πi x y / Q}|². Exact, O(Q²).
 */
export function qftSpectrum(r: number, q: number = Q): number[] {
  const out = new Array<number>(q).fill(0);
  if (r <= 0) return out;
  for (let y = 0; y < q; y++) {
    let total = 0;
    for (let x0 = 0; x0 < r && x0 < q; x0++) {
      let re = 0;
      let im = 0;
      for (let x = x0; x < q; x += r) {
        const phase = (2 * Math.PI * x * y) / q;
        re += Math.cos(phase);
        im += Math.sin(phase);
      }
      total += (re * re + im * im) / (q * q);
    }
    out[y] = total;
  }
  return out;
}

/** The y values that carry more than a millionth of the largest probability. */
export function spectrumPeaks(spectrum: number[]): number[] {
  const max = spectrum.reduce((m, p) => Math.max(m, p), 0);
  const out: number[] = [];
  spectrum.forEach((p, y) => {
    if (max > 0 && p > max * 1e-6) out.push(y);
  });
  return out;
}

/** The whole walkthrough for one base. */
export function runShor(a: number, n: number = N): ShorRun {
  const g = gcd(a, n);
  const sequence = powerSequence(a, n, ROW_LEN);
  if (g !== 1) {
    return {
      a,
      n,
      g,
      sequence,
      r: 0,
      spectrum: new Array<number>(Q).fill(0),
      peaks: [],
      half: null,
      factors: [g, n / g],
      outcome: "lucky-gcd",
    };
  }
  const r = findPeriod(a, n);
  const spectrum = qftSpectrum(r);
  const peaks = spectrumPeaks(spectrum);
  if (r % 2 !== 0) {
    return { a, n, g, sequence, r, spectrum, peaks, half: null, factors: null, outcome: "odd-period" };
  }
  const half = modPow(a, r / 2, n);
  const factors: [number, number] = [gcd(half - 1, n), gcd(half + 1, n)];
  const trivial = half === n - 1;
  return {
    a,
    n,
    g,
    sequence,
    r,
    spectrum,
    peaks,
    half,
    factors,
    outcome: trivial ? "trivial-root" : "factored",
  };
}

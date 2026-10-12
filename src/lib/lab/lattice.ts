/**
 * A two-dimensional lattice with two bases for the same set of points: a
 * short, nearly orthogonal one (the private key) and a long, skewed one (the
 * public key; a unimodular transform of the first). Babai's rounding, the
 * one-step closest-vector guess, works with the short basis and fails with
 * the long one. ML-KEM is built on the same gap, in hundreds of dimensions.
 *
 * Pure module (no React, no DOM, no `@/` imports) so the self-test can run it
 * under node.
 */

export type Vec = readonly [number, number];
/** Two column vectors; a lattice point is c1·b1 + c2·b2 with integer c. */
export type Basis = readonly [Vec, Vec];
export type BasisKind = "private" | "public";

/** Short and nearly orthogonal: b1·b2 = -1, |b1| ≈ 5.1, |b2| ≈ 4.1, det 21. */
export const PRIVATE_BASIS: Basis = [
  [5, 1],
  [-1, 4],
];

/**
 * The same lattice through U = [[11, 4], [8, 3]] (det 1):
 * b1' = 11·b1 + 4·b2 = (51, 27), b2' = 8·b1 + 3·b2 = (37, 20). Long and almost parallel.
 */
export const PUBLIC_BASIS: Basis = [
  [51, 27],
  [37, 20],
];

export const BASES: Record<BasisKind, Basis> = { private: PRIVATE_BASIS, public: PUBLIC_BASIS };

/** Half-extents of the drawing, in lattice units. */
export const VIEW_W = 48;
export const VIEW_H = 32;

export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
export const length = (a: Vec): number => Math.hypot(a[0], a[1]);
export const det = (b: Basis): number => b[0][0] * b[1][1] - b[0][1] * b[1][0];

/** c1·b1 + c2·b2. */
export const combine = (b: Basis, c: Vec): Vec => add(scale(b[0], c[0]), scale(b[1], c[1]));

/** The real coefficients c with t = c1·b1 + c2·b2. */
export function coefficients(b: Basis, t: Vec): Vec {
  const d = det(b);
  const c1 = (t[0] * b[1][1] - t[1] * b[1][0]) / d;
  const c2 = (b[0][0] * t[1] - b[0][1] * t[0]) / d;
  return [c1, c2];
}

export interface Rounding {
  /** the real coefficients before rounding */
  coeffs: Vec;
  /** the rounded coefficients */
  rounded: Vec;
  /** the lattice point they select */
  point: Vec;
  /** distance from the target to that point */
  error: number;
}

/** Babai's rounding: express t in the basis, round each coefficient, recombine. */
export function babaiRound(b: Basis, t: Vec): Rounding {
  const coeffs = coefficients(b, t);
  const rounded: Vec = [Math.round(coeffs[0]), Math.round(coeffs[1])];
  const point = combine(b, rounded);
  return { coeffs, rounded, point, error: length(sub(t, point)) };
}

/**
 * The true closest lattice point, by searching the private-basis coefficients
 * around the rounding guess. In two dimensions this window always contains it.
 */
export function closestPoint(t: Vec): { point: Vec; distance: number } {
  const guess = babaiRound(PRIVATE_BASIS, t);
  let best: Vec = guess.point;
  let bestD = guess.error;
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      const p = combine(PRIVATE_BASIS, [guess.rounded[0] + i, guess.rounded[1] + j]);
      const d = length(sub(t, p));
      if (d < bestD - 1e-9) {
        best = p;
        bestD = d;
      }
    }
  }
  return { point: best, distance: bestD };
}

/** Every lattice point inside the drawing, generated from the private basis. */
export function latticePoints(w: number = VIEW_W, h: number = VIEW_H): Vec[] {
  const out: Vec[] = [];
  // coefficient bounds that cover the rectangle with margin
  const corners: Vec[] = [
    [-w, -h],
    [w, -h],
    [-w, h],
    [w, h],
  ];
  let minI = Infinity;
  let maxI = -Infinity;
  let minJ = Infinity;
  let maxJ = -Infinity;
  for (const c of corners) {
    const [i, j] = coefficients(PRIVATE_BASIS, c);
    minI = Math.min(minI, i);
    maxI = Math.max(maxI, i);
    minJ = Math.min(minJ, j);
    maxJ = Math.max(maxJ, j);
  }
  for (let i = Math.floor(minI) - 1; i <= Math.ceil(maxI) + 1; i++) {
    for (let j = Math.floor(minJ) - 1; j <= Math.ceil(maxJ) + 1; j++) {
      const p = combine(PRIVATE_BASIS, [i, j]);
      if (Math.abs(p[0]) <= w && Math.abs(p[1]) <= h) out.push(p);
    }
  }
  return out;
}

/** True when both bases generate the same lattice: same |det| and each vector of one lies in the other. */
export function sameLattice(a: Basis, b: Basis): boolean {
  if (Math.abs(det(a)) !== Math.abs(det(b))) return false;
  const integral = (c: Vec) => Math.abs(c[0] - Math.round(c[0])) < 1e-9 && Math.abs(c[1] - Math.round(c[1])) < 1e-9;
  return integral(coefficients(a, b[0])) && integral(coefficients(a, b[1]));
}

/** "(12.3, -4.0)" */
export const fmtVec = (v: Vec, digits = 1): string => `(${v[0].toFixed(digits)}, ${v[1].toFixed(digits)})`;

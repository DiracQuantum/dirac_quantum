/**
 * The toy discrete-log group for "Crack a key": the multiplicative group of
 * integers mod a prime p just above 2^bits, with a generator g. A private key
 * is x in [0, 2^bits); the public key is g^x mod p. Brute force derives the
 * public key from every candidate x until it matches, which is exactly what
 * a brute force against a curve key would do, on a group small enough for a
 * browser.
 *
 * Pure module (no React, no DOM, no `@/` imports) so the self-test can run it
 * under node.
 */

export interface ToyGroup {
  bits: number;
  /** prime modulus, the first prime above 2^bits */
  p: number;
  /** a primitive root mod p (smallest one) */
  g: number;
}

/** Group sizes the lab offers. 26 bits keeps p² under 2^53 so squaring stays exact in doubles. */
export const TOY_BITS = [16, 18, 20, 22, 24, 26] as const;
export const DEFAULT_TOY_BITS = 22;
export const MAX_TOY_BITS = 26;

function isPrime(n: number): boolean {
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
  return true;
}

/** Distinct prime factors of n (trial division; n stays below 2^27 here). */
function primeFactors(n: number): number[] {
  const out: number[] = [];
  let m = n;
  for (let d = 2; d * d <= m; d++) {
    if (m % d === 0) {
      out.push(d);
      while (m % d === 0) m /= d;
    }
  }
  if (m > 1) out.push(m);
  return out;
}

/**
 * base^exp mod m with square-and-multiply. All intermediates stay below m²,
 * so it is exact as long as m < 2^26.5; `toyGroup` never hands out more.
 */
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

/**
 * Fixed-length square-and-multiply: always `bits` squarings, so every guess
 * costs the same and the measured rate means something.
 */
export function derivePublic(g: number, x: number, p: number, bits: number): number {
  let result = 1;
  for (let i = bits - 1; i >= 0; i--) {
    result = (result * result) % p;
    if ((x >>> i) & 1) result = (result * g) % p;
  }
  return result;
}

const cache = new Map<number, ToyGroup>();

/** The group for a bit size; p is the first prime above 2^bits, g its smallest primitive root. */
export function toyGroup(bits: number): ToyGroup {
  if (!Number.isInteger(bits) || bits < 4 || bits > MAX_TOY_BITS) {
    throw new RangeError(`toy group bits must be an integer in 4..${MAX_TOY_BITS}`);
  }
  const hit = cache.get(bits);
  if (hit) return hit;
  let p = 2 ** bits + 1;
  while (!isPrime(p)) p++;
  const factors = primeFactors(p - 1);
  let g = 2;
  for (; g < p; g++) {
    if (factors.every((q) => modPow(g, (p - 1) / q, p) !== 1)) break;
  }
  const group = { bits, p, g };
  cache.set(bits, group);
  return group;
}

/** "0x2a3f10" style for a found key. */
export const hexKey = (x: number, bits: number): string =>
  `0x${x.toString(16).padStart(Math.ceil(bits / 4), "0")}`;

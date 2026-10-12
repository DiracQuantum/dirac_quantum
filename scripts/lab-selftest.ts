/**
 * Self-test for the attack lab's pure modules (src/lib/lab/*). Run from the
 * project root:
 *   node scripts/lab-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure.
 */

import { humanSeconds, humanUniverses, pow2, sci, UNIVERSE_AGE_YEARS, yearsAt } from "../src/lib/lab/format.ts";
import { derivePublic, hexKey, modPow, toyGroup, TOY_BITS } from "../src/lib/lab/toygroup.ts";
import { CANDIDATES, findPeriod, gcd, Q, qftSpectrum, runShor } from "../src/lib/lab/shor.ts";
import {
  babaiRound,
  closestPoint,
  det,
  latticePoints,
  PRIVATE_BASIS,
  PUBLIC_BASIS,
  sameLattice,
  type Vec,
} from "../src/lib/lab/lattice.ts";
import { hexPreview, sealClassical, sealPostQuantum } from "../src/lib/lab/hndl.ts";

let failed = 0;
let passed = 0;

function check(name: string, fn: () => boolean | void): void {
  const started = performance.now();
  try {
    const result = fn();
    const ms = (performance.now() - started).toFixed(0);
    if (result === false) {
      failed++;
      console.log(`FAIL  ${name}  (${ms} ms)`);
    } else {
      passed++;
      console.log(`PASS  ${name}  (${ms} ms)`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}  threw ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* format */
check("sci formats", () => sci(6.28e57) === "6.28e57" && sci(0) === "0" && sci(9.999e5) === "1.00e6" && sci(123) === "1.23e2");
check("yearsAt 2^192 at 1e18/s is beyond the universe", () => {
  const years = yearsAt(pow2(192), 1e18);
  return years > UNIVERSE_AGE_YEARS * 1e20 && sci(years, 1) === "2.0e32";
});
check("humanSeconds ladder", () =>
  humanSeconds(0.4) === "0.40 s" && humanSeconds(130_000) === "1.5 days" && humanSeconds(1e20).endsWith("years"));
check("humanUniverses", () => humanUniverses(1e5) === "a blink" && humanUniverses(1.38e12).startsWith("100 universes"));

/* toy group */
for (const bits of TOY_BITS) {
  check(`toyGroup(${bits}) prime above 2^bits with a generator`, () => {
    const { p, g } = toyGroup(bits);
    if (p <= 2 ** bits) return false;
    // g has full order: g^(p-1) = 1 and g^((p-1)/q) != 1 for every prime q | p-1
    if (modPow(g, p - 1, p) !== 1) return false;
    let m = p - 1;
    for (let q = 2; q * q <= m; q++) {
      if (m % q === 0) {
        if (modPow(g, (p - 1) / q, p) === 1) return false;
        while (m % q === 0) m /= q;
      }
    }
    if (m > 1 && modPow(g, (p - 1) / m, p) === 1) return false;
    return true;
  });
}
check("derivePublic agrees with modPow and brute force finds a 16-bit key", () => {
  const { p, g, bits } = toyGroup(16);
  const secret = 40_321;
  const y = derivePublic(g, secret, p, bits);
  if (y !== modPow(g, secret, p)) return false;
  for (let x = 0; x < 2 ** bits; x++) {
    if (derivePublic(g, x, p, bits) === y) return x === secret;
  }
  return false;
});
check("hexKey pads", () => hexKey(255, 22) === "0x0000ff");

/* shor */
check("gcd", () => gcd(12, 18) === 6 && gcd(7, 15) === 1 && gcd(0, 5) === 5);
check("period of 7 mod 15 is 4, sequence 1 7 4 13", () => {
  const run = runShor(7);
  return run.r === 4 && run.sequence.slice(0, 5).join(",") === "1,7,4,13,1";
});
check("QFT spectrum sums to 1 and peaks at multiples of Q/r", () => {
  for (const r of [2, 4]) {
    const s = qftSpectrum(r);
    const sum = s.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) return false;
    for (let y = 0; y < Q; y++) {
      const peak = y % (Q / r) === 0;
      if (peak && Math.abs(s[y] - 1 / r) > 1e-9) return false;
      if (!peak && s[y] > 1e-9) return false;
    }
  }
  return true;
});
check("every candidate base is honest about its outcome", () => {
  const expect: Record<number, string> = { 2: "factored", 4: "factored", 7: "factored", 8: "factored", 11: "factored", 13: "factored", 14: "trivial-root" };
  for (const a of CANDIDATES) {
    const run = runShor(a);
    if (run.outcome !== expect[a]) {
      console.log(`  a=${a} outcome ${run.outcome} r=${run.r} half=${run.half} factors=${run.factors}`);
      return false;
    }
    if (run.outcome === "factored") {
      const f = run.factors;
      if (!f || !((f[0] === 3 && f[1] === 5) || (f[0] === 5 && f[1] === 3))) return false;
    }
    if (run.peaks.length !== run.r) return false;
    if (findPeriod(a, 15) !== run.r) return false;
  }
  return true;
});
check("a base sharing a factor skips the quantum part", () => runShor(6).outcome === "lucky-gcd" && runShor(6).factors?.join(",") === "3,5");

/* lattice */
check("both bases generate the same lattice, |det| 21", () =>
  sameLattice(PRIVATE_BASIS, PUBLIC_BASIS) && sameLattice(PUBLIC_BASIS, PRIVATE_BASIS) && Math.abs(det(PRIVATE_BASIS)) === 21);
check("private rounding is the closest point; public rounding is worse on average", () => {
  let privateExact = 0;
  let privateSum = 0;
  let publicSum = 0;
  const trials = 400;
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < trials; i++) {
    const t: Vec = [(rand() - 0.5) * 80, (rand() - 0.5) * 50];
    const priv = babaiRound(PRIVATE_BASIS, t);
    const pub = babaiRound(PUBLIC_BASIS, t);
    const best = closestPoint(t);
    if (Math.abs(priv.error - best.distance) < 1e-9) privateExact++;
    privateSum += priv.error;
    publicSum += pub.error;
  }
  console.log(`  private exact ${privateExact}/${trials}, mean error private ${(privateSum / trials).toFixed(2)} public ${(publicSum / trials).toFixed(2)}`);
  return privateExact > trials * 0.9 && publicSum > privateSum * 4;
});
check("lattice points fill the view", () => {
  const pts = latticePoints();
  return pts.length > 200 && pts.some((p) => p[0] === 0 && p[1] === 0);
});

/* hndl */
check("classical envelope round-trips with 32-byte keys", () => {
  const s = sealClassical("Wire 40 SOL to the treasury on Friday.");
  return s.recovered === "Wire 40 SOL to the treasury on Friday." && s.publicKey.length === 32 && s.header.length === 32;
});
check("ML-KEM-768 envelope round-trips with 1184/2400/1088-byte keys and ciphertext", () => {
  const s = sealPostQuantum("Wire 40 SOL to the treasury on Friday.");
  const sizes = Object.fromEntries(s.sizes.map((l) => [l.label, l.bytes]));
  console.log(`  timings ${s.timings.map((t) => `${t.label} ${t.ms.toFixed(2)} ms`).join(", ")}`);
  return (
    s.recovered === "Wire 40 SOL to the treasury on Friday." &&
    sizes["public key"] === 1184 &&
    sizes["secret key"] === 2400 &&
    sizes["KEM ciphertext"] === 1088 &&
    sizes["shared secret"] === 32
  );
});
check("hexPreview groups and truncates", () => hexPreview(new Uint8Array([1, 2, 3]), 2) === "01 02 …" && hexPreview(new Uint8Array([255])) === "ff");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

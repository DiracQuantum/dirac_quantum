/**
 * Numbers for the attack lab: scientific notation, durations, the age of the
 * universe. Pure module (no React, no DOM) so the self-test can import it.
 */

/** 13.8 billion years, the Planck 2018 figure rounded. */
export const UNIVERSE_AGE_YEARS = 1.38e10;
/** Julian year in seconds. */
export const SECONDS_PER_YEAR = 31_557_600;

/** 2^bits as a double; exact up to 2^53 and good to 15 digits above that. */
export const pow2 = (bits: number): number => 2 ** bits;

/** "6.28e57" style. Zero is "0"; infinities and NaN come back as "—". */
export function sci(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(n)));
  let mant = n / 10 ** exp;
  let e = exp;
  if (Math.abs(Number(mant.toFixed(digits))) >= 10) {
    mant /= 10;
    e += 1;
  }
  return `${mant.toFixed(digits)}e${e}`;
}

/** "4,194,304" style integer. */
export const int = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Seconds at a rate, in years. */
export const yearsAt = (operations: number, perSecond: number): number =>
  operations / perSecond / SECONDS_PER_YEAR;

/** How many ages of the universe a span of years is. */
export const universes = (years: number): number => years / UNIVERSE_AGE_YEARS;

/**
 * A duration in seconds as something a person can read: "0.4 s", "3 min",
 * "36 h", "12 days", "4,100 years", "2.0e32 years".
 */
export function humanSeconds(s: number): string {
  if (!Number.isFinite(s)) return "—";
  if (s < 1) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)} h`;
  if (s < SECONDS_PER_YEAR) return `${(s / 86_400).toFixed(1)} days`;
  const years = s / SECONDS_PER_YEAR;
  if (years < 1e6) return `${int(years)} years`;
  return `${sci(years)} years`;
}

/** "1.4e22 universes", or "0.3 of a universe" under one. */
export function humanUniverses(years: number): string {
  const u = universes(years);
  if (!Number.isFinite(u)) return "—";
  if (u < 1e-3) return "a blink";
  if (u < 1) return `${u.toFixed(2)} of a universe`;
  if (u < 1e4) return `${u.toFixed(0)} universes`;
  return `${sci(u, 1)} universes`;
}

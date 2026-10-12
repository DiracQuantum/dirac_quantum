/**
 * Formatting for the exposure report: relative and absolute UTC dates, SOL and
 * token amounts, USD. No dependencies; every function is pure so it can run
 * during render. "Now" is always passed in (the report's own `scannedAt`), so
 * nothing here calls Date.now(). A null number never reaches these helpers:
 * the panels render "Unavailable" for it (see atoms.tsx).
 */

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdWhole = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const twoDecimals = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fourDecimals = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

/** A priced amount that is not zero but rounds to $0.00; it reads "<$0.01", never "$0.00". */
function belowOneCent(n: number): boolean {
  return n > 0 && n < 0.005;
}

/** "$1,234.56"; "<$0.01" for a non-zero amount under half a cent. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (belowOneCent(n)) return "<$0.01";
  return usd.format(n);
}

/** Headline money: whole dollars from $1,000 up ("$184,230"), cents below it. Used by the indicators and the share card. */
export function formatUsdHeadline(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (belowOneCent(n)) return "<$0.01";
  return Math.abs(n) >= 1000 ? usdWhole.format(n) : usd.format(n);
}

/** "1,234" */
export function formatInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return integer.format(n);
}

/** Token amount: "1,234.56" above one, four significant digits below it. */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  return Math.abs(n) >= 1 ? twoDecimals.format(n) : significant.format(n);
}

/**
 * SOL amount: two decimals from 1,000 SOL up, up to four decimals above one
 * SOL, four significant digits below. Keeps large balances short enough for
 * the stat columns.
 */
export function formatSolAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1000) return twoDecimals.format(n);
  return abs >= 1 ? fourDecimals.format(n) : significant.format(n);
}

/** "1,000+" for the capped signature page, plain count otherwise. */
export function formatTxCount(n: number): string {
  return n >= 1000 ? `${formatInt(1000)}+` : formatInt(n);
}

/** "2024-11-03" in UTC, from unix seconds. */
export function formatUtcDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

/** "2024-11-03 14:02 UTC", from unix seconds. */
export function formatUtcDateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * "3 days ago" / "2 months ago", measured from `nowMs` (unix ms) back to
 * `unixSeconds`. Future timestamps (clock skew) read as "just now".
 */
export function relativeTime(unixSeconds: number, nowMs: number): string {
  const diff = Math.floor(nowMs / 1000) - unixSeconds;
  if (!Number.isFinite(diff) || diff < MINUTE) return "just now";
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), "minute");
  if (diff < DAY) return plural(Math.floor(diff / HOUR), "hour");
  if (diff < MONTH) return plural(Math.floor(diff / DAY), "day");
  if (diff < YEAR) return plural(Math.floor(diff / MONTH), "month");
  return plural(Math.floor(diff / YEAR), "year");
}

/** "a, b and c" */
export function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "3 tokens" / "1 token" */
export function count(n: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${formatInt(n)} ${n === 1 ? noun : pluralNoun}`;
}

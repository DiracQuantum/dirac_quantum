// Display helpers for Solana addresses, signatures and amounts.

/** `7xKq…9AsU`: the first `head` and last `tail` characters around an ellipsis. Short strings pass through. */
export function truncate(address: string, head = 4, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Lamports as a SOL string, trailing zeros trimmed: 5000 → "0.000005". */
export function formatSol(lamports: number, maxDecimals = 9): string {
  return (lamports / 1_000_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

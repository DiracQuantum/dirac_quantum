"use client";

/**
 * The paper passport card, the same look as the landing's document. Used by
 * /passport (the holder's own) and /p (anyone's, read from the registry).
 */

import { fingerprint, passportHash, type Passport } from "@/lib/pq";
import { truncate } from "@/lib/solana/format";
import { explorerTx } from "@/lib/solana/rpc";
import { CopyButton } from "@/components/app/ui";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10 Oct 2026 · 14:02 UTC" */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${hh}:${mm} UTC`;
}

export const MODE_LABEL: Record<Passport["mode"], string> = {
  simple: "Simple",
  hardened: "Hardened",
};

interface PassportDocumentProps {
  passport: Passport;
  /** the anchor transaction named for this passport, verified or not */
  anchorTx?: string | null;
  /** the registry found anchorTx on chain (signed by the wallet, memo with this hash); only then is it "Anchored" */
  anchorVerified?: boolean;
  /** block time of the verified anchor, unix ms */
  anchorTime?: number | null;
  /** version number in the registry, shown from 2 up */
  version?: number;
  className?: string;
}

export default function PassportDocument({
  passport,
  anchorTx = null,
  anchorVerified = false,
  anchorTime = null,
  version = 1,
  className = "",
}: PassportDocumentProps) {
  const anchored = anchorTx !== null && anchorVerified;
  const hash = passportHash(passport);
  const number = hash.slice(0, 6).toUpperCase().replace(/(.{3})(.{3})/, "$1 $2");

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "Holder",
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span title={passport.wallet}>{truncate(passport.wallet)}</span>
          <CopyButton value={passport.wallet} label="wallet address" tone="ink" />
        </span>
      ),
    },
    { label: "Fingerprint", value: fingerprint(passport) },
    {
      label: "Encryption",
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>ML-KEM-768</span>
          <span className="text-ink/45" title={passport.kem_pk}>
            {truncate(passport.kem_pk, 6, 4)}
          </span>
          <CopyButton value={passport.kem_pk} label="ML-KEM-768 public key" tone="ink" />
        </span>
      ),
    },
    {
      label: "Signature",
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span>ML-DSA-65</span>
          <span className="text-ink/45" title={passport.dsa_pk}>
            {truncate(passport.dsa_pk, 6, 4)}
          </span>
          <CopyButton value={passport.dsa_pk} label="ML-DSA-65 public key" tone="ink" />
        </span>
      ),
    },
    { label: "Mode", value: MODE_LABEL[passport.mode] },
    { label: "Issued", value: formatUtc(passport.created_at) },
    {
      label: "Hash",
      value: (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span title={hash}>{truncate(hash, 8, 6)}</span>
          <CopyButton value={hash} label="passport hash" tone="ink" />
        </span>
      ),
    },
  ];

  return (
    <div className={`paper relative w-full overflow-hidden p-6 sm:p-7 md:p-9 ${className}`}>
      <div className="flex items-start justify-between border-b border-line-ink pb-4">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink/55">Dirac passport</div>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink/55">
            № {number} · {version > 1 ? `version ${version} · ` : ""}Solana mainnet
          </div>
        </div>
        <span className="font-serif text-3xl italic leading-none">⟩</span>
      </div>

      <div className="mt-8 break-all font-serif text-[2.4rem] leading-none tracking-[-0.01em] md:text-[3rem]">
        <span className="text-ink/40">|</span>
        {truncate(passport.wallet)}
        <span className="text-ink/40">⟩</span>
      </div>

      {/* On a phone the label column and the values tighten a notch so the fingerprint and the
          issue date stay on one line (92 px still fits FINGERPRINT). */}
      <dl className="mt-8">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-[92px_1fr] items-baseline gap-3 border-t border-line-ink py-2.5 first:border-t-0 sm:grid-cols-[110px_1fr] sm:gap-4"
          >
            <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink/55">{r.label}</dt>
            <dd className="tnum min-w-0 font-mono text-[13px] sm:text-sm">{r.value}</dd>
          </div>
        ))}
      </dl>

      {/* The 34-bar code is 134 px with 2 px gaps on a phone (167 px from sm), so it and the stamp share a row
          at 375 px; on a narrower screen the stamp wraps and keeps to the right edge. */}
      <div className="mt-8 flex flex-wrap items-end justify-between gap-4">
        <div className="flex gap-[2px] sm:gap-[3px]" aria-hidden>
          {Array.from({ length: 34 }).map((_, i) => (
            <span
              key={i}
              className="h-7 w-[2px] bg-ink"
              style={{ opacity: 0.25 + (parseInt(hash[(i * 3) % hash.length], 16) / 15) * 0.7 }}
            />
          ))}
        </div>
        {anchored ? (
          <span className="stamp ml-auto text-signal">Anchored</span>
        ) : anchorTx ? (
          <span className="stamp ml-auto text-ink/45">Anchor unverified</span>
        ) : (
          <span className="stamp ml-auto text-ink/30">Unanchored</span>
        )}
      </div>

      <div className="mt-6 font-mono text-[10px] uppercase tracking-[0.16em] text-ink/45">
        {anchorTx ? (
          <a
            href={explorerTx(anchorTx)}
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-ink"
            title={anchorTx}
          >
            tx {truncate(anchorTx)} ·{" "}
            {anchored
              ? anchorTime !== null
                ? `block time ${formatUtc(anchorTime)}`
                : "verified on chain"
              : "not verified on chain yet"}{" "}
            ↗
          </a>
        ) : (
          "no on-chain anchor yet"
        )}
      </div>
    </div>
  );
}

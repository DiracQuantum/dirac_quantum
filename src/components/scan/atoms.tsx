"use client";

/**
 * Atoms shared by the /scan panels and indicators. The render rules of the v2
 * contract (kept by v3) live here: a null number reads "Unavailable" (mono, muted), never
 * "0"; a skipped source reads "not checked"; counts cut off at the DAS cap
 * carry a "lower bound" tag; every source has a human label, a method line
 * and a status tag.
 */

import type { ReactNode } from "react";
import { CopyButton } from "@/components/app/ui";
import type { ScanReport, SourceName, SourceState, SourceStatus } from "@/lib/scan";
import { truncate } from "@/lib/solana/format";
import { explorerAddress } from "@/lib/solana/rpc";

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

/** Every source of the report, in the order the panels list them. */
export const SOURCE_ORDER: SourceName[] = [
  "address",
  "balance",
  "assets",
  "signatures",
  "stake",
  "mintAuthorities",
  "programAuthorities",
  "price",
  "registry",
  "multisigs",
];

export const SOURCE_LABEL: Record<SourceName, string> = {
  address: "Address",
  balance: "SOL balance",
  assets: "Tokens and NFTs",
  signatures: "Activity",
  stake: "Stake",
  mintAuthorities: "Mint authorities",
  programAuthorities: "Program authorities",
  price: "SOL price",
  registry: "Dirac registry",
  multisigs: "Squads multisigs",
};

/** How each source is read, for the methodology panel. */
export const SOURCE_METHOD: Record<SourceName, string> = {
  address: "getAccountInfo and an Ed25519 curve check, plus the known list of system, token and loader programs",
  balance: "getBalance",
  assets: "DAS getAssetsByOwner, up to 3 pages of 1,000 assets",
  signatures: "getSignaturesForAddress, newest 1,000 signatures",
  stake: "stake accounts whose withdraw authority is the address",
  mintAuthorities:
    "tokens the address holds where it is also the mint or freeze authority (Token and Token-2022), cap 20; burned authorities (111…111) are ignored",
  programAuthorities: "upgradeable program data with the address as upgrade authority, cap 50",
  price: "CoinGecko SOL/USD, cached 5 minutes",
  registry: "the Dirac passport registry",
  multisigs:
    "Squads v4 program accounts: the address as a multisig (owner and layout), memberships by memcmp on the first 10 member slots of both account layouts, the first 16 members listed, vault 0 valued from getBalance and one DAS page",
};

export const STATUS_LABEL: Record<SourceStatus, string> = {
  ok: "ok",
  failed: "failed",
  skipped: "skipped",
  truncated: "truncated",
};

const NOT_REPORTED: SourceState = { status: "failed", error: "not reported by the scanner" };

/** The state of one source. A missing entry counts as failed, never as ok. */
export function sourceOf(report: ScanReport, name: SourceName): SourceState {
  const sources: Partial<Record<SourceName, SourceState>> = report.sources;
  return sources[name] ?? NOT_REPORTED;
}

/** Sources that did not answer in full, in display order. */
export function unreadSources(report: ScanReport): SourceName[] {
  return SOURCE_ORDER.filter((name) => sourceOf(report, name).status !== "ok");
}

/* ------------------------------------------------------------------ */
/* Atoms                                                               */
/* ------------------------------------------------------------------ */

/** The status of one source: a dot and the word. */
export function StatusTag({ status }: { status: SourceStatus }) {
  const dot = status === "ok" ? "bg-paper" : status === "truncated" ? "bg-signal" : "bg-paper/30";
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] ${
        status === "ok" ? "text-paper" : "text-mute"
      }`}
    >
      <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

interface UnavailableProps {
  /** The source behind the missing number; "not checked" when it was skipped. */
  source?: SourceState;
  /** Also print the short error after the word, not only in the title. */
  inline?: boolean;
  className?: string;
}

/** The value of a null number: "Unavailable" (failed), "not checked" (skipped). Mono, muted, the short error on hover. */
export function Unavailable({ source, inline = false, className = "" }: UnavailableProps) {
  const text = source?.status === "skipped" ? "not checked" : "Unavailable";
  const error = source?.error;
  return (
    <span className={`font-mono text-mute ${className}`} title={error}>
      {text}
      {inline && error ? <span className="text-mute"> · {error}</span> : null}
    </span>
  );
}

/** Tag for counts that stopped at the DAS cap. */
export function LowerBound({ className = "" }: { className?: string }) {
  return (
    <span
      className={`chip !px-2 !py-0.5 text-[10px] uppercase tracking-[0.14em] text-mute ${className}`}
      title="The asset read stopped at its cap of 3,000. The real count is at least this."
    >
      lower bound
    </span>
  );
}

interface PanelProps {
  eyebrow: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Panel({ eyebrow, aside, className = "", children }: PanelProps) {
  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">{eyebrow}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

interface AddressProps {
  value: string;
  label: string;
  head?: number;
  tail?: number;
}

/** Mono address with explorer link and copy button. */
export function Address({ value, label, head = 4, tail = 4 }: AddressProps) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 font-mono text-sm text-paper">
      <a
        href={explorerAddress(value)}
        target="_blank"
        rel="noreferrer"
        title={value}
        className="underline-offset-4 hover:underline"
      >
        {truncate(value, head, tail)} ↗
      </a>
      <CopyButton value={value} label={label} />
    </span>
  );
}

interface StatProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Small tag next to the value, e.g. "lower bound". */
  tag?: ReactNode;
}

export function Stat({ label, value, sub, tag }: StatProps) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="tnum mt-2 flex flex-wrap items-center gap-2 font-mono text-xl text-paper md:text-2xl">
        <span className="min-w-0 break-words">{value}</span>
        {tag}
      </div>
      {sub ? <div className="tnum mt-1 font-mono text-[11px] text-mute">{sub}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-mute">{children}</p>;
}

/** What to say under an empty list, given the source that produced it. */
export function EmptyFor({ source, whenEmpty }: { source: SourceState; whenEmpty: string }) {
  if (source.status === "ok" || source.status === "truncated") return <Empty>{whenEmpty}</Empty>;
  return (
    <Empty>
      <Unavailable source={source} inline />
    </Empty>
  );
}

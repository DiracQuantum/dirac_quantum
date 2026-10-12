"use client";

/**
 * The three headline indicators of a v2 report, and the banner for addresses
 * that are not signing wallets. There is no score: quantum exposure (USD under
 * one Ed25519 key), PQ identity (passport level and anchoring) and data
 * confidence (which sources answered) stand on their own.
 */

import Link from "next/link";
import { CopyButton, Row } from "@/components/app/ui";
import {
  Address,
  LowerBound,
  SOURCE_LABEL,
  SOURCE_ORDER,
  StatusTag,
  Unavailable,
  sourceOf,
} from "@/components/scan/atoms";
import { formatSolAmount, formatUsd, formatUsdHeadline } from "@/components/scan/format";
import type { AddressKind, Confidence, IdentityLevel, ScanReport } from "@/lib/scan";
import { truncate } from "@/lib/solana/format";
import { explorerTx } from "@/lib/solana/rpc";

/* ------------------------------------------------------------------ */
/* Headline                                                            */
/* ------------------------------------------------------------------ */

interface HeadlineProps {
  report: ScanReport;
  /** Re-runs the scan; offered on the confidence block when the report is not complete. */
  onRescan?: () => void;
  className?: string;
}

export function Headline({ report, onRescan, className = "" }: HeadlineProps) {
  return (
    <div className={`flex flex-col gap-5 ${className}`}>
      <ExposureBlock report={report} />
      <IdentityBlock report={report} />
      <ConfidenceBlock report={report} onRescan={onRescan} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Quantum exposure                                                    */
/* ------------------------------------------------------------------ */

/**
 * The first core source that did not answer, as a short reason for a missing
 * total. Stake is not core: the total stands without it.
 */
function exposureReason(report: ScanReport): string | null {
  for (const name of ["balance", "assets", "price"] as const) {
    const s = sourceOf(report, name);
    if (s.status === "failed" || s.status === "skipped") {
      return `${SOURCE_LABEL[name]} ${s.status}${s.error ? `: ${s.error}` : ""}`;
    }
  }
  return null;
}

export function ExposureBlock({ report }: { report: ScanReport }) {
  const { exposure, assetsTruncated } = report;
  const reason = exposure.usd === null ? exposureReason(report) : null;

  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-end justify-between gap-6">
        <div>
          <span className="eyebrow">Quantum exposure</span>
          <div className="mt-1 font-mono text-[11px] text-mute">
            {/* No key signs for a mint, a PDA or a multisig account: say what the number is instead. */}
            {report.address.kind === "wallet" ? "what this key can move today" : "held at this address today"}
          </div>
        </div>
        {assetsTruncated ? <LowerBound /> : null}
      </div>

      {exposure.usd !== null ? (
        <div className="display tnum mt-5 text-5xl leading-none md:text-6xl">{formatUsdHeadline(exposure.usd)}</div>
      ) : (
        <div className="mt-5 text-2xl md:text-3xl">
          <Unavailable />
        </div>
      )}
      {exposure.usd !== null && exposure.sol !== null ? (
        <div className="tnum mt-2 font-mono text-xs text-mute">
          ≈ {formatSolAmount(exposure.sol)} SOL{report.stakeSol !== null ? " including stake" : ", stake not included"}
        </div>
      ) : null}
      {reason ? <div className="mt-2 break-words font-mono text-[11px] text-mute">{reason}</div> : null}

      {exposure.lines.length > 0 ? (
        <ul className="mt-5 border-t border-line">
          {exposure.lines.map((line) => (
            <li
              key={line.label}
              className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 text-sm"
            >
              <span className="min-w-0">
                <span className="text-paper">{line.label}</span>
                {line.note ? <span className="ml-2 text-xs text-mute">{line.note}</span> : null}
              </span>
              <span className="tnum shrink-0 font-mono text-paper">
                {line.usd !== null ? formatUsd(line.usd) : <Unavailable />}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-4 text-xs leading-relaxed text-mute">{exposure.note}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PQ identity                                                         */
/* ------------------------------------------------------------------ */

const LEVEL_LABEL: Record<IdentityLevel, string> = {
  none: "None",
  simple: "Simple",
  hardened: "Hardened",
};

const LEVEL_SUB: Record<IdentityLevel, string> = {
  none: "no Dirac passport in the registry",
  simple: "passport keys derived from a wallet signature",
  hardened: "passport with independent keys",
};

export function IdentityBlock({ report }: { report: ScanReport }) {
  const { identity, passport, wallet } = report;
  const registry = sourceOf(report, "registry");
  const known = registry.status === "ok" || passport !== null;
  const isWallet = report.address.kind === "wallet";
  const publicPage = `/p?a=${encodeURIComponent(wallet)}`;

  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-end justify-between gap-6">
        <div>
          <span className="eyebrow">PQ identity</span>
          <div className="mt-1 font-mono text-[11px] text-mute">
            {known ? LEVEL_SUB[identity.level] : "registry not read"}
          </div>
        </div>
        {identity.anchored ? (
          <span className="stamp text-paper">Anchored</span>
        ) : passport ? (
          <span className="chip">not anchored</span>
        ) : null}
      </div>

      {known ? (
        <div className="display mt-5 text-5xl leading-none md:text-6xl">{LEVEL_LABEL[identity.level]}</div>
      ) : (
        <div className="mt-5 text-2xl md:text-3xl">
          <Unavailable source={registry} />
        </div>
      )}
      <p className="mt-4 text-sm leading-relaxed text-mute">{identity.note}</p>

      {passport ? (
        <dl className="mt-5 border-t border-line pt-1">
          <Row label="Mode">
            {passport.mode === "hardened" ? "Hardened" : "Simple"}
            <span className="text-mute">
              {passport.mode === "hardened"
                ? " · independent keys, no Ed25519 dependence"
                : " · keys derived from a wallet signature"}
            </span>
          </Row>
          <Row label="Hash">
            <span className="inline-flex flex-wrap items-center gap-2">
              <span title={passport.hash}>{truncate(passport.hash, 8, 8)}</span>
              <CopyButton value={passport.hash} label="passport hash" />
            </span>
          </Row>
          <Row label="Anchor">
            {passport.anchored && passport.anchorTx ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <a
                  href={explorerTx(passport.anchorTx)}
                  target="_blank"
                  rel="noreferrer"
                  title={passport.anchorTx}
                  className="underline-offset-4 hover:underline"
                >
                  tx {truncate(passport.anchorTx, 6, 6)} ↗
                </a>
                <CopyButton value={passport.anchorTx} label="anchor transaction" />
              </span>
            ) : (
              <span className="text-mute">not anchored on Solana yet</span>
            )}
          </Row>
        </dl>
      ) : null}

      {isWallet ? (
        <div className="mt-5 flex flex-wrap gap-3">
          {!passport && known ? (
            <Link href="/passport" className="pill">
              Create passport
            </Link>
          ) : null}
          {passport && !passport.anchored ? (
            <Link href="/passport" className="pill">
              Anchor it
            </Link>
          ) : null}
          {passport ? (
            <Link href={publicPage} className="pill pill-ghost">
              Public passport page
            </Link>
          ) : null}
          {passport && passport.mode === "simple" ? (
            <Link href="/passport" className="pill pill-ghost">
              Switch to hardened
            </Link>
          ) : null}
          {!passport ? (
            <Link href="/#passport" className="pill pill-ghost">
              What is a passport?
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data confidence                                                     */
/* ------------------------------------------------------------------ */

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  complete: "Complete",
  partial: "Partial",
  unavailable: "Unavailable",
};

const CONFIDENCE_NOTE: Record<Confidence, string> = {
  complete: "Every source answered. The report is cached for 60 seconds and can be shared.",
  partial:
    "Some sources did not answer. Their numbers read Unavailable, not zero. The report is not cached and cannot be shared; scan again in a moment.",
  unavailable:
    "Both the balance and the asset read failed, so the report says almost nothing about this address. Scan again in a moment.",
};

interface ConfidenceBlockProps {
  report: ScanReport;
  onRescan?: () => void;
}

export function ConfidenceBlock({ report, onRescan }: ConfidenceBlockProps) {
  const { confidence, limited } = report;
  const states = SOURCE_ORDER.map((name) => [name, sourceOf(report, name)] as const);
  const okCount = states.filter(([, s]) => s.status === "ok").length;
  const complete = confidence === "complete";

  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-end justify-between gap-6">
        <div>
          <span className="eyebrow">Data confidence</span>
          <div className="tnum mt-1 font-mono text-[11px] text-mute">
            {okCount} of {states.length} sources answered in full
          </div>
        </div>
        {!complete ? <span className="chip">not cached</span> : null}
      </div>

      <div className={`display mt-5 text-5xl leading-none md:text-6xl ${complete ? "" : "text-mute"}`}>
        {CONFIDENCE_LABEL[confidence]}
      </div>
      <p className="mt-4 text-sm leading-relaxed text-mute">{CONFIDENCE_NOTE[confidence]}</p>

      <ul className="mt-5 border-t border-line">
        {states.map(([name, s]) => (
          <li key={name} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 border-b border-line py-2 text-sm">
            <span className="text-paper">{SOURCE_LABEL[name]}</span>
            <StatusTag status={s.status} />
            {s.status !== "ok" && s.error ? (
              <span className="col-span-2 break-words font-mono text-[11px] leading-relaxed text-mute">{s.error}</span>
            ) : null}
          </li>
        ))}
      </ul>

      {limited ? (
        <div className="mt-5 rounded-xl border border-line bg-ink-3 px-4 py-3 font-mono text-[11px] leading-relaxed text-paper">
          <span className="text-mute">limited data · </span>
          No private RPC is configured on the server, so assets, stake and authorities were not read.
        </div>
      ) : null}

      {!complete && onRescan ? (
        <button type="button" onClick={onRescan} className="pill pill-ghost mt-5 !px-4 !py-2">
          Scan again
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Address kind banner                                                 */
/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<AddressKind, string> = {
  wallet: "Wallet",
  pda: "Program-derived address",
  program: "Program",
  mint: "Token mint",
  "token-account": "Token account",
  "stake-account": "Stake account",
  multisig: "Squads multisig",
  system: "System program or sysvar",
  unknown: "Unclassified account",
};

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

/** The closing line of the banner: why no passport applies to this kind of address. */
function bannerFootnote(report: ScanReport): string {
  const listed = "Balances and assets below are listed for reference.";
  if (report.address.kind === "multisig") {
    return "The multisig account itself holds rent only; its members and vault 0 are under Control. A Dirac passport binds to a member's wallet, not to the multisig.";
  }
  if (report.address.kind !== "unknown") {
    return `${listed} A Dirac passport binds to a signing key, so there is nothing to create for this address.`;
  }
  return sourceOf(report, "address").status === "ok"
    ? `${listed} The owning program decides what this account holds, so no passport advice is given.`
    : `${listed} The account could not be read, so no passport advice is given; scan again in a moment.`;
}

/** Shown at the top for every address kind other than "wallet": what the address is and why no passport applies. */
export function AddressBanner({ report, className = "" }: { report: ScanReport; className?: string }) {
  const { address } = report;
  if (address.kind === "wallet") return null;

  return (
    <div className={`rounded-[18px] border border-line bg-ink-3 p-6 md:p-8 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="eyebrow">
          {address.kind === "unknown" ? "Address type unclear" : "Not a signing wallet"}
        </span>
        <span className="chip">{KIND_LABEL[address.kind]}</span>
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-paper">{address.note}</p>
      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px] text-mute">
        <div className="flex items-center gap-2">
          <dt>owner</dt>
          <dd className="text-paper">
            {address.owner ? (
              <Address value={address.owner} label="owner program" head={6} tail={6} />
            ) : (
              "none (no account)"
            )}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt>executable</dt>
          <dd className="text-paper">{yesNo(address.executable)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt>on curve</dt>
          <dd className="text-paper">{yesNo(address.onCurve)}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt>exists</dt>
          <dd className="text-paper">{yesNo(address.exists)}</dd>
        </div>
      </dl>
      <p className="mt-4 max-w-2xl text-xs leading-relaxed text-mute">{bannerFootnote(report)}</p>
    </div>
  );
}

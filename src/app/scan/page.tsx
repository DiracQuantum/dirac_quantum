"use client";

/**
 * /scan?a=<address>: the exposure report for one Solana address. Static
 * export; the address comes from the query on the client and the report from
 * the Worker (`GET /api/scan/:wallet`). Without `?a=` the page is the scan
 * form. The headline is three indicators (quantum exposure, PQ identity, data
 * confidence); there is no score.
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import { CopyButton, ErrorNote, StatusLine, describeError } from "@/components/app/ui";
import { formatUtcDateTime, relativeTime } from "@/components/scan/format";
import { AddressBanner, Headline } from "@/components/scan/Indicators";
import ScanForm from "@/components/scan/ScanForm";
import ShareCard from "@/components/scan/ShareCard";
import {
  ActivityPanel,
  ControlPanel,
  HoldingsPanel,
  MethodologyPanel,
  RecommendationsPanel,
} from "@/components/scan/ReportPanels";
import { fetchScan, isValidWallet, type ScanReport } from "@/lib/scan";
import { truncate } from "@/lib/solana/format";
import { explorerAddress } from "@/lib/solana/rpc";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function ScanPage() {
  return (
    <>
      <Nav />
      <main className="relative z-10 mx-auto w-full max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <Suspense fallback={<Shell address={null} />}>
          <Scan />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}

/** The route's metadata title (layout.tsx "Scan" through the root template). */
const STATIC_TITLE = "Scan · Dirac";

interface Result {
  wallet: string;
  report: ScanReport;
}

function Scan() {
  const params = useSearchParams();
  const address = params.get("a")?.trim() ?? "";
  const valid = address.length > 0 && isValidWallet(address);

  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<{ wallet: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    fetchScan(address)
      .then((report) => {
        if (cancelled) return;
        setResult({ wallet: address, report });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ wallet: address, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [address, valid, attempt]);

  const report = valid && result?.wallet === address ? result.report : null;
  const error = valid && failure?.wallet === address ? failure.message : null;
  const loading = valid && !report && !error;

  // The tab names the scanned address. Next writes the static metadata title
  // ("Scan · Dirac") once more after hydration, which used to wipe this; put
  // the address back whenever the head shows exactly that static title, and
  // leave any other page's title alone.
  useEffect(() => {
    if (!valid) return;
    const title = `Scan · ${truncate(address)} · Dirac`;
    document.title = title;
    const observer = new MutationObserver(() => {
      if (document.title === STATIC_TITLE) document.title = title;
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (document.title === title) document.title = STATIC_TITLE;
    };
  }, [address, valid]);

  // Drops the current report so the skeleton shows while the scan runs again.
  const rescan = () => {
    setResult(null);
    setFailure(null);
    setAttempt((n) => n + 1);
  };

  return (
    <Shell
      address={address || null}
      valid={valid}
      failed={error !== null}
      report={report}
      banner={report && report.address.kind !== "wallet" ? <AddressBanner report={report} /> : null}
      aside={
        report ? (
          <>
            <Headline report={report} onRescan={rescan} className="mt-10" />
            <ShareCard report={report} className="mt-5" />
          </>
        ) : null
      }
      footer={
        report ? (
          <>
            <span className="eyebrow">Scan another address</span>
            <ScanForm className="mt-3" current={report.wallet} />
          </>
        ) : null
      }
    >
      {!address ? <IdleForm /> : null}

      {address && !valid ? (
        <div className="panel p-6 md:p-8">
          <span className="eyebrow">Not an address</span>
          <ErrorNote className="mt-4">
            <span className="break-all">{address.length > 64 ? `${address.slice(0, 64)}…` : address}</span> is not a
            Solana address. Expected a base58 public key of 32 bytes.
          </ErrorNote>
          <ScanForm className="mt-5" autoFocus />
        </div>
      ) : null}

      {loading ? <Skeleton address={address} /> : null}

      {error ? (
        <div className="panel p-6 md:p-8">
          <span className="eyebrow">Scan failed</span>
          <ErrorNote className="mt-4">{error}</ErrorNote>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
            No report came back at all: the scanner itself could not be reached, or it rejected the
            request. A single slow chain read does not cause this; it would show up in the report under
            Data confidence. Retrying usually works.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" onClick={rescan} className="pill">
              Try again
            </button>
            <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="pill pill-ghost">
              Open in explorer ↗
            </a>
          </div>
        </div>
      ) : null}

      {report ? (
        <>
          <RecommendationsPanel report={report} />
          <HoldingsPanel report={report} />
          <ControlPanel report={report} />
          <ActivityPanel report={report} />
          <MethodologyPanel report={report} />
        </>
      ) : null}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

interface ShellProps {
  address: string | null;
  /** The address parses as a Solana public key. */
  valid?: boolean;
  /** The scan request failed and no report came back. */
  failed?: boolean;
  report?: ScanReport | null;
  /** Rendered above the two columns, e.g. the address-kind banner. */
  banner?: ReactNode;
  /** Rendered under the chapter header, in the left column. */
  aside?: ReactNode;
  /** Closes the report: under the aside on wide screens, after every panel once the columns stack. */
  footer?: ReactNode;
  children?: ReactNode;
}

function Shell({ address, valid = false, failed = false, report = null, banner, aside, footer, children }: ShellProps) {
  const isWallet = !report || report.address.kind === "wallet";
  const cached = report?.confidence === "complete" ? "cached up to 60 s" : "not cached";
  const meta = !address
    ? "open methodology · v3"
    : !valid
      ? "not an address"
      : `${isWallet ? "wallet" : "address"} ${truncate(address)}`;

  return (
    <>
      {banner ? <div className="mb-10">{banner}</div> : null}
      {/* Stacked (below lg) a report reads as one run of panels, so the column gap matches the panel gap. */}
      <div
        className={`grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16 ${report ? "gap-5" : "gap-12"}`}
      >
        <div>
          <ChapterHeader
            as="h1"
            index={2}
            eyebrow="Exposure report"
            meta={meta}
            title={
              <>
                What hangs
                <br />
                <span className="display-serif text-paper-2">on one key.</span>
              </>
            }
            lede={
              address
                ? undefined
                : "Paste any Solana address. Three things come back: what its Ed25519 key can move today, in USD; whether a post-quantum identity is bound to it; and how much of the chain answered. No score."
            }
          />

          {address && valid ? (
            <div className="mt-8 border-t border-line pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={explorerAddress(address)}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all font-mono text-sm text-paper underline-offset-4 hover:underline"
                >
                  {address}
                </a>
                <CopyButton value={address} label="address" />
              </div>
              <div className="tnum mt-2 font-mono text-[11px] text-mute">
                {report
                  ? `scanned ${relativeTime(Math.floor(report.scannedAt / 1000), report.scannedAt)} · ${formatUtcDateTime(Math.floor(report.scannedAt / 1000))} · ${cached}`
                  : failed
                    ? "scan failed · no report came back"
                    : "reading public chain data"}
              </div>
              {report && report.address.kind === "wallet" && !report.address.exists ? (
                <div className="mt-1 font-mono text-[11px] text-mute">
                  no account on chain yet: this address has never been funded
                </div>
              ) : null}
            </div>
          ) : null}

          {aside}
          {footer ? <div className="mt-8 hidden lg:block">{footer}</div> : null}

          {!report ? (
            <p className="mt-8 max-w-md text-xs leading-relaxed text-mute">
              Nothing is signed or sent. The scan reads public data only: the account, balances, assets,
              signatures, stake and program accounts, the SOL price and the Dirac registry.
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-5">{children}</div>
        {footer ? <div className="mt-7 lg:hidden">{footer}</div> : null}
      </div>
    </>
  );
}

function IdleForm() {
  return (
    <div className="panel p-6 md:p-8">
      <span className="eyebrow">Scan an address</span>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
        Any address works, yours or not. The report is public data arranged around one question: how
        much depends on this key, and what to do about it.
      </p>
      <ScanForm className="mt-5" autoFocus />
    </div>
  );
}

const SKELETON_ROWS = [72, 48, 64, 40, 56, 44];

function Skeleton({ address }: { address: string }) {
  return (
    <>
      <div className="panel p-6 md:p-8">
        <span className="eyebrow">Reading the chain</span>
        <StatusLine className="mt-4">Scanning {truncate(address)}</StatusLine>
        <div className="mt-6 space-y-3">
          {SKELETON_ROWS.map((w, i) => (
            <div
              key={i}
              aria-hidden
              className="shimmer h-3 rounded bg-paper/10"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
        <p className="mt-6 border-t border-line pt-4 font-mono text-[11px] leading-relaxed text-mute">
          Ten reads in two rounds: address, balance, assets, signatures, stake, programs, price, registry;
          then mint authorities and Squads multisigs. Usually a few seconds.
        </p>
      </div>
      <div className="panel p-6 md:p-8">
        <span className="eyebrow">Holdings</span>
        <div className="mt-6 grid grid-cols-2 gap-6 md:grid-cols-4 lg:grid-cols-2">
          {SKELETON_ROWS.slice(0, 4).map((_, i) => (
            <div key={i} aria-hidden className="space-y-2">
              <div className="shimmer h-2 w-12 rounded bg-paper/10" />
              <div className="shimmer h-5 w-20 rounded bg-paper/10" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

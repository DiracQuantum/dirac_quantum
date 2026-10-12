"use client";

/**
 * Collapsed days, newest first: the day number, the measured bits in mono,
 * where they were drawn (a chip with the IBM backend, or "simulator"), the
 * traits, the gate count, the probability the string had just before the
 * collapse and the influencer wallet (the most signed gates that day). A day
 * still measuring on hardware (`pending`) heads the list without bits. Can
 * extend itself to 30 days from `GET /api/pet/history`.
 */

import Link from "next/link";
import { useState } from "react";
import { describeError } from "@/components/app/ui";
import { formatUtcDate } from "@/components/scan/format";
import { fetchPetHistory, type PetDay, type PetQpuRun } from "@/lib/pet";
import { truncate } from "@/lib/solana/format";
import { QPU_STATUS_LABEL, backendLabel, dayLabel, formatPct, groupBits } from "@/components/pet/format";

interface Props {
  days: PetDay[];
  /** a day whose collapse is being measured on hardware right now */
  pending?: PetQpuRun | null;
  className?: string;
}

const MORE = 30;

/** Where the day was drawn: the IBM backend for a hardware day, "simulator" otherwise. */
function SourceChip({ day }: { day: PetDay }) {
  const qpu = day.source === "qpu";
  return (
    <span
      className={`chip !px-2 !py-0.5 !text-[10px] ${qpu ? "" : "text-mute"}`}
      title={qpu ? `measured on IBM quantum hardware${day.qpuJob ? `, job ${day.qpuJob}` : ""}` : "drawn on the statevector simulator"}
    >
      {qpu ? (day.qpuBackend ?? "ibm") : "simulator"}
    </span>
  );
}

export default function HistoryList({ days, pending = null, className = "" }: Props) {
  const [more, setMore] = useState<PetDay[] | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const list = more ?? days;
  const canExtend = more === null && days.length >= 7;

  const extend = () => {
    setLoadingMore(true);
    setMoreError(null);
    fetchPetHistory(MORE)
      .then((d) => setMore(d))
      .catch((e: unknown) => setMoreError(describeError(e)))
      .finally(() => setLoadingMore(false));
  };

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Past days</span>
        <span className="eyebrow tnum hidden sm:inline">{list.length === 0 ? "none yet" : `${list.length} collapsed`}</span>
      </div>

      {pending ? (
        <div className="mt-4 grid gap-1 border-b border-line pb-3 sm:grid-cols-[64px_minmax(0,1fr)] sm:gap-4">
          <span className="tnum font-mono text-[11px] uppercase tracking-[0.14em] text-mute">{dayLabel(pending.day)}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="tnum font-mono text-sm text-mute">··· ·· ··· ··</span>
              <span className="chip !px-2 !py-0.5 !text-[10px]">{backendLabel(pending.backend)}</span>
              <span className="font-mono text-[11px] text-mute">{QPU_STATUS_LABEL[pending.status]}</span>
            </div>
            <div className="mt-1 break-all font-mono text-[11px] text-mute">
              measuring on quantum hardware{pending.jobId ? ` · job ${pending.jobId}` : ""}
            </div>
          </div>
        </div>
      ) : null}

      {list.length === 0 ? (
        pending ? null : (
          <p className="mt-4 text-sm leading-relaxed text-mute">
            No collapse yet. The first one happens at 00:00 UTC; the result lands here with its bits.
          </p>
        )
      ) : (
        <ul className={`divide-y divide-line ${pending ? "" : "mt-4"}`}>
          {list.map((d) => (
            <li key={d.day} className="grid gap-1 py-3 sm:grid-cols-[64px_minmax(0,1fr)] sm:gap-4">
              <span className="tnum font-mono text-[11px] uppercase tracking-[0.14em] text-mute">{dayLabel(d.day)}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="tnum font-mono text-sm text-paper">{groupBits(d.bits)}</span>
                  <SourceChip day={d} />
                  <span className="text-sm text-paper">
                    {d.form} <span className="text-mute">· {d.character} · {d.ability} · {d.palette}</span>
                  </span>
                </div>
                {d.source === "qpu" && d.qpuJob ? (
                  <div className="mt-1 break-all font-mono text-[11px] text-mute">IBM job {d.qpuJob}</div>
                ) : null}
                {d.qpuNote ? (
                  <div className="mt-1 font-mono text-[11px] text-mute">not on hardware · {d.qpuNote}</div>
                ) : null}
                <div className="tnum mt-1 font-mono text-[11px] text-mute">
                  {d.actions} {d.actions === 1 ? "gate" : "gates"} · drawn at {formatPct(d.pTop)} ·{" "}
                  {formatUtcDate(Math.floor(d.measuredAt / 1000))}
                </div>
                <div className="tnum mt-0.5 font-mono text-[11px] text-mute">
                  {d.topWallet ? (
                    <>
                      influencer{" "}
                      <Link
                        href={`/p?a=${encodeURIComponent(d.topWallet)}`}
                        title={d.topWallet}
                        className="text-paper underline-offset-4 hover:underline"
                      >
                        {truncate(d.topWallet)}
                      </Link>
                      {typeof d.topGates === "number" ? ` · ${d.topGates} signed` : ""}
                    </>
                  ) : (
                    "no signed gates"
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {canExtend ? (
        <div className="mt-4">
          <button type="button" onClick={extend} disabled={loadingMore} className="pill pill-ghost !px-4 !py-2">
            {loadingMore ? "Loading…" : `Show ${MORE} days`}
          </button>
          {moreError ? <p className="mt-2 font-mono text-[11px] text-mute">error · {moreError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

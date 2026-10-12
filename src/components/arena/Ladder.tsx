"use client";

/** The ladder: top 20 wallets by ELO, with record and bout count; your row is marked. */

import Link from "next/link";
import { ErrorNote } from "@/components/app/ui";
import { formatElo } from "@/components/arena/format";
import type { ArenaLadder } from "@/lib/arena";
import { truncate } from "@/lib/solana/format";

interface Props {
  ladder: ArenaLadder | null;
  loading: boolean;
  error: string | null;
  wallet: string | null;
  className?: string;
}

export default function Ladder({ ladder, loading, error, wallet, className = "" }: Props) {
  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Ladder</span>
        <span className="eyebrow tnum hidden sm:inline">
          {ladder ? `${ladder.totals.fighters} fighters · ${ladder.totals.resolved} resolved · ${ladder.totals.queued} queued` : ""}
        </span>
      </div>

      {error ? <ErrorNote className="mt-4">{error}</ErrorNote> : null}
      {loading ? (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} aria-hidden className="shimmer h-2 rounded bg-paper/10" style={{ width: `${50 + ((i * 31) % 45)}%` }} />
          ))}
        </div>
      ) : null}

      {ladder && ladder.ladder.length === 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-mute">No rated wallet yet. The first resolved ranked bout opens the ladder.</p>
      ) : null}

      {ladder && ladder.ladder.length > 0 ? (
        <table className="mt-4 w-full border-collapse font-mono text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-mute">
              <th className="py-2 pr-3 font-normal">#</th>
              <th className="py-2 pr-3 font-normal">wallet</th>
              <th className="py-2 pr-3 text-right font-normal">elo</th>
              <th className="py-2 pr-3 text-right font-normal">w</th>
              <th className="py-2 pr-3 text-right font-normal">l</th>
              <th className="py-2 pr-3 text-right font-normal">d</th>
              <th className="py-2 text-right font-normal">bouts</th>
            </tr>
          </thead>
          <tbody>
            {ladder.ladder.map((r, i) => {
              const me = r.wallet === wallet;
              return (
                <tr key={r.wallet} className={`border-t border-line ${me ? "bg-paper/5 text-paper" : "text-paper/90"}`}>
                  <td className="tnum py-2 pr-3 text-mute">{i + 1}</td>
                  <td className="py-2 pr-3">
                    <Link href={`/p?a=${encodeURIComponent(r.wallet)}`} className="underline-offset-4 hover:underline" title={r.wallet}>
                      {truncate(r.wallet, 6, 4)}
                    </Link>
                    {me ? <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-mute">you</span> : null}
                  </td>
                  <td className="tnum py-2 pr-3 text-right">{formatElo(r.elo)}</td>
                  <td className="tnum py-2 pr-3 text-right">{r.wins}</td>
                  <td className="tnum py-2 pr-3 text-right">{r.losses}</td>
                  <td className="tnum py-2 pr-3 text-right">{r.draws}</td>
                  <td className="tnum py-2 text-right">{r.bouts}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      <p className="mt-4 text-xs leading-relaxed text-mute">
        ELO, K = 32, everyone starts at 1200, a draw counts half. A forfeit is a loss. Rank is the only prize.
      </p>
    </section>
  );
}

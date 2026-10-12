"use client";

/** The latest resolved ranked bouts, both circuits public, with the exact pA. */

import { describeResult, formatP3, formatWhen, shortHex } from "@/components/arena/format";
import { circuitLabel, type ArenaBout } from "@/lib/arena";
import { truncate } from "@/lib/solana/format";

interface Props {
  bouts: ArenaBout[];
  className?: string;
}

export default function RecentBouts({ bouts, className = "" }: Props) {
  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Latest bouts</span>
        <span className="eyebrow hidden sm:inline">circuits public once resolved</span>
      </div>
      {bouts.length === 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-mute">No ranked bout has resolved yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {bouts.map((b) => (
            <li key={b.id} className="py-3 font-mono text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-paper">
                  {truncate(b.a)} <span className="text-mute">vs</span> {truncate(b.b)}
                </span>
                <span className="tnum text-[11px] text-mute">
                  {describeResult(b.result, b.pA)} · pA {formatP3(b.pA)} · {shortHex(b.id)}
                </span>
              </div>
              <div className="tnum mt-1 text-[11px] text-mute">
                A {b.aCircuit ? circuitLabel(b.aCircuit) : "—"} · B {b.bCircuit ? circuitLabel(b.bCircuit) : "—"}
                {b.resolvedAt ? ` · ${formatWhen(b.resolvedAt)}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

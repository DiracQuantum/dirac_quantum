"use client";

/** The last gates applied today, newest first, with a relative time. */

import type { PetAction } from "@/lib/pet";
import { relativeTime } from "@/components/scan/format";
import { describeAction } from "@/components/pet/format";

interface Props {
  actions: PetAction[];
  actionsToday: number;
  now: number | null;
  className?: string;
}

export default function ActionsFeed({ actions, actionsToday, now, className = "" }: Props) {
  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Recent gates</span>
        <span className="eyebrow tnum text-paper">{actionsToday} today</span>
      </div>
      {actions.length === 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-mute">No gates yet today. The register is still the even superposition.</p>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {actions.map((a, i) => (
            <li key={`${a.at}-${i}`} className="flex items-baseline justify-between gap-4 font-mono text-xs">
              <span className="text-paper">{describeAction(a)}</span>
              <span className="tnum whitespace-nowrap text-[11px] text-mute">
                {now === null ? "" : relativeTime(Math.floor(a.at / 1000), now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

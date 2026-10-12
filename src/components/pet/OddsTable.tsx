"use client";

/**
 * Tonight's odds: the eight most likely outcomes of the full measurement with
 * the form each one collapses into, and the probability of every form.
 */

import type { PetOutcome } from "@/lib/pet";
import { formatPct, groupBits } from "@/components/pet/format";

interface Props {
  top: PetOutcome[];
  pForm: Record<string, number>;
  className?: string;
}

export default function OddsTable({ top, pForm, className = "" }: Props) {
  const maxTop = top.reduce((m, o) => Math.max(m, o.p), 0);
  const forms = Object.entries(pForm).sort(([, a], [, b]) => b - a);
  const maxForm = forms.reduce((m, [, p]) => Math.max(m, p), 0);

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Tonight&apos;s odds</span>
        <span className="eyebrow hidden sm:inline">top 8 of 1024 outcomes</span>
      </div>

      {/* The form name has a fixed width (the longest, "black hole", is 10 characters), so every
          bar starts at the same x. Under 640px the bar moves under its row, as on the share card,
          instead of being squeezed to a dot next to the text. */}
      <ol className="mt-5 space-y-3 sm:space-y-2">
        {top.map((o, i) => (
          <li
            key={o.bits}
            className="grid grid-cols-[18px_minmax(0,1fr)_56px] items-center gap-x-3 gap-y-1 sm:grid-cols-[18px_auto_minmax(0,1fr)_60px]"
          >
            <span className="tnum font-mono text-[11px] text-mute">{i + 1}</span>
            <span className="truncate font-mono text-xs text-paper">
              <span className="tnum">{groupBits(o.bits)}</span>
              <span className="ml-2 inline-block w-[10ch] text-mute">{o.form}</span>
            </span>
            <span className="relative col-span-2 col-start-2 row-start-2 h-1.5 overflow-hidden rounded-full bg-paper/10 sm:col-span-1 sm:col-start-3 sm:row-start-1">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-paper transition-[width] duration-500"
                style={{ width: `${maxTop > 0 ? (o.p / maxTop) * 100 : 0}%` }}
              />
            </span>
            <span className="tnum text-right font-mono text-[11px] text-paper">{formatPct(o.p)}</span>
          </li>
        ))}
      </ol>

      <div className="mt-7 border-t border-line pt-5">
        <span className="eyebrow">By form</span>
        <ul className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-2">
          {forms.map(([form, p]) => (
            <li key={form} className="grid grid-cols-[88px_minmax(0,1fr)_56px] items-center gap-3">
              <span className="truncate font-mono text-xs text-paper">{form}</span>
              <span className="relative h-1 overflow-hidden rounded-full bg-paper/10">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-paper/70 transition-[width] duration-500"
                  style={{ width: `${maxForm > 0 ? (p / maxForm) * 100 : 0}%` }}
                />
              </span>
              <span className="tnum text-right font-mono text-[11px] text-mute">{formatPct(p)}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-5 text-xs leading-relaxed text-mute">
        The low three bits pick the form, the next two the character, three more the ability, the last
        two the palette. At 00:00 UTC one outcome is drawn from the full distribution.
      </p>
    </section>
  );
}

"use client";

import Pinned from "@/components/ui/Pinned";
import { ChapterHeader } from "@/components/ui/Section";
import ScanForm from "@/components/scan/ScanForm";
import { step } from "@/lib/anim";

/*
 * A sample of what `GET /api/scan/:wallet` (report v3) returns: the headline
 * is three indicators, quantum exposure in USD, the PQ identity level and the
 * data confidence; there is no score. The rows mirror real report fields
 * (authorities, Squads multisigs with their vault value, last activity).
 */
const EXAMPLE_EXPOSURE_USD = 184_230;

const rows: [string, string][] = [
  ["Authorities", "3 mints · 1 program"],
  ["Squads multisigs", "member of 1 · vault $42,900"],
  ["Last activity", "2024-11-03"],
];

const recommendations = [
  "Create a Dirac passport, hardened mode",
  "Move the 3 mint authorities to a 2/3 multisig",
  "Rotate holdings dormant since 2024",
];

export default function Scanner() {
  return (
    <section id="scanner" data-scene={1} className="relative">
      <Pinned height="280vh">
        {(p) => {
          const exposure = Math.round(EXAMPLE_EXPOSURE_USD * step(p, 0.55, 0.8));
          const show = step(p, 0.86, 0.95);
          return (
            <div className="mx-auto grid max-w-[1400px] items-center gap-10 px-5 py-24 md:px-8 lg:grid-cols-[1fr_1.05fr] lg:gap-16">
              <div>
                <ChapterHeader
                  index={1}
                  eyebrow="What a key holds"
                  meta="Open methodology · v3"
                  title={
                    <>
                      Know your
                      <br />
                      <span className="display-serif text-paper-2">quantum exposure.</span>
                    </>
                  }
                  lede="Paste any address. See what hangs on one Ed25519 key: assets, authorities, Squads multisigs, dormant holdings. Three indicators, no score; the method is published."
                />
                {/* room for the one error line, so a bad address does not re-centre the column and jump the title */}
                <ScanForm className="mt-8 max-w-md lg:min-h-[5.75rem]" />
              </div>

              <div data-scene-anchor className="panel relative overflow-hidden p-6 md:p-8">
                <div className="flex items-center justify-between">
                  <span className="eyebrow">Exposure report</span>
                  <span className="chip">
                    <span className="h-1.5 w-1.5 rounded-full bg-signal" /> example
                  </span>
                </div>
                <div className="tnum mt-5 font-mono text-xl text-paper md:text-2xl">
                  7xKq…9AsU
                </div>

                <dl className="mt-7">
                  {rows.map(([k, v], i) => {
                    const t = step(p, 0.08 + i * 0.09, 0.18 + i * 0.09);
                    return (
                      <div
                        key={k}
                        style={{ opacity: t, transform: `translateY(${(1 - t) * 10}px)` }}
                        className="flex items-baseline justify-between gap-6 border-t border-line py-3 first:border-t-0"
                      >
                        <dt className="text-sm text-mute">{k}</dt>
                        <dd className="tnum font-mono text-sm text-paper">{v}</dd>
                      </div>
                    );
                  })}
                </dl>

                <div className="mt-7 border-t border-line pt-5">
                  <div className="flex items-end justify-between gap-6">
                    <div>
                      <span className="eyebrow">Quantum exposure</span>
                      <div className="mt-1 font-mono text-[11px] text-mute">what this key can move today</div>
                    </div>
                    <span className="display tnum text-5xl leading-none">
                      ${exposure.toLocaleString("en-US")}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-6 border-t border-line pt-4">
                    <div>
                      <span className="eyebrow">PQ identity</span>
                      <div className="display mt-1 text-2xl leading-none">None</div>
                      <div className="mt-1 font-mono text-[11px] text-mute">no Dirac passport</div>
                    </div>
                    <div>
                      <span className="eyebrow">Data confidence</span>
                      <div className="display mt-1 text-2xl leading-none">Complete</div>
                      <div className="mt-1 font-mono text-[11px] text-mute">every source answered</div>
                    </div>
                  </div>
                </div>

                <div
                  style={{ opacity: show, transform: `translateY(${(1 - show) * 12}px)` }}
                  className="mt-7 rounded-xl border border-line bg-ink p-4"
                >
                  <div className="eyebrow">Do this first</div>
                  <ul className="mt-2 space-y-1.5 text-sm text-paper">
                    {recommendations.map((r) => (
                      <li key={r} className="flex gap-3">
                        <span className="text-mute">→</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          );
        }}
      </Pinned>
    </section>
  );
}

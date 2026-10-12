"use client";

import Section, { ChapterHeader } from "@/components/ui/Section";
import Reveal from "@/components/ui/Reveal";

const facts: [string, string][] = [
  ["Contract", "TBA at launch"],
  ["Fees", "pump.fun creator fee → buyback wallet"],
  ["Buyback wallet", "Squads multisig 2 of 3"],
  ["Rule", "Every 24 h the full balance buys $DIRAC via Jupiter"],
  ["Utility", "Cosmetics, playground votes, priority on real QPU runs"],
];

/** What the ledger will list once the token exists; every row carries a transaction signature. */
const ledgerColumns = ["Date (UTC)", "SOL spent", "Transaction"];

export default function Token() {
  return (
    <Section id="token" index={6}>
      <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
        <div>
          <ChapterHeader
            index={6}
            eyebrow="Token"
            meta="pump.fun · launch TBA"
            title={
              <>
                <span className="font-mono font-medium tracking-[-0.02em]">$DIRAC</span>
                <br />
                <span className="display-serif text-paper-2">bought back, in public.</span>
              </>
            }
            lede="Creator fees flow to a public buyback wallet. Every buyback is listed here with its transaction. No feature of Dirac requires holding the token."
          />
          <Reveal className="mt-10">
            <dl>
              {facts.map(([k, v]) => (
                <div
                  key={k}
                  className="flex flex-col gap-1 border-t border-line py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8"
                >
                  <dt className="text-sm text-mute">{k}</dt>
                  <dd className="font-mono text-sm text-paper sm:text-right">{v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
          <Reveal delay={0.15} className="mt-8 flex flex-wrap gap-3">
            <span className="pill pill-ghost cursor-not-allowed opacity-60">pump.fun · soon</span>
            <span className="pill pill-ghost cursor-not-allowed opacity-60">DexScreener · soon</span>
          </Reveal>
        </div>

        <Reveal y={48} className="lg:pt-12">
          <div data-scene-anchor className="panel p-6 md:p-8">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Buyback ledger</span>
              <span className="chip">
                <span className="h-1.5 w-1.5 rounded-full bg-mute" /> before launch
              </span>
            </div>

            <div className="mt-8 grid grid-cols-2 gap-6">
              <div>
                <div className="eyebrow">Fees collected</div>
                <div className="display tnum mt-2 text-4xl text-mute md:text-5xl">
                  0.0<span className="ml-2 text-lg">SOL</span>
                </div>
              </div>
              <div>
                <div className="eyebrow">Bought back</div>
                <div className="display tnum mt-2 text-4xl text-mute md:text-5xl">
                  0.0<span className="ml-2 text-lg">SOL</span>
                </div>
              </div>
            </div>

            <div className="mt-8">
              <div className="flex justify-between font-mono text-[11px] text-mute">
                <span>First buyback</span>
                <span className="tnum">24 h after launch</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper/10">
                <div className="h-full w-0 rounded-full bg-paper" />
              </div>
            </div>

            <div className="mt-8 border-t border-line">
              <div className="tnum flex items-center justify-between border-b border-line py-3 font-mono text-[11px] text-mute">
                {ledgerColumns.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              <p className="py-6 text-center font-mono text-xs text-mute">
                No buybacks yet. The wallet, the token and every purchase will appear here with a signature you can open in an explorer.
              </p>
            </div>
            <p className="mt-5 text-xs leading-relaxed text-mute">
              Fees are used to buy the token on the open market. The ledger reads the buyback wallet directly from the chain once it exists; nothing on this panel is an estimate.
            </p>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

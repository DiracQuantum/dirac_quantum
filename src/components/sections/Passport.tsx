"use client";

import Link from "next/link";
import Pinned from "@/components/ui/Pinned";
import { ChapterHeader } from "@/components/ui/Section";
import { step } from "@/lib/anim";

const fields: [string, string][] = [
  ["Holder", "7xKq…9AsU"],
  ["Encryption", "ML-KEM-768"],
  ["Signature", "ML-DSA-65"],
  ["Mode", "Hardened"],
  ["Issued", "10 Oct 2026 · 14:02 UTC"],
  ["Slot", "318,204,511"],
];

export default function Passport() {
  return (
    <section id="passport" data-scene={2} className="relative">
      <Pinned height="300vh">
        {(p) => {
          const docIn = step(p, 0.02, 0.2);
          const stamp = step(p, 0.78, 0.88);
          return (
            <div className="mx-auto grid max-w-[1400px] items-center gap-10 px-5 py-24 md:px-8 lg:grid-cols-[1fr_1fr] lg:gap-16">
              <ChapterHeader
                index={2}
                eyebrow="The document"
                meta="Anchored by one memo transaction"
                title={
                  <>
                    A passport
                    <br />
                    <span className="display-serif text-paper-2">
                      issued before <span className="whitespace-nowrap">Q-Day.</span>
                    </span>
                  </>
                }
                lede="Two post-quantum keys bound to your wallet. The wallet signs the passport, the passport signs itself, and one memo on Solana fixes the date. After Ed25519 falls, this date shows the passport existed before."
              />

              <div
                data-scene-anchor
                style={{
                  opacity: docIn,
                  transform: `translateY(${(1 - docIn) * 40}px) rotate(${(1 - docIn) * -2}deg)`,
                }}
                className="paper relative mx-auto w-full max-w-md overflow-hidden p-7 md:p-9"
              >
                <div className="flex items-start justify-between border-b border-line-ink pb-4">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink/55">
                      Dirac passport
                    </div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink/55">
                      № 000 001 · Solana mainnet
                    </div>
                  </div>
                  <span className="font-serif text-3xl italic leading-none">⟩</span>
                </div>

                <div className="mt-8 font-serif text-[2.6rem] leading-none tracking-[-0.01em] md:text-[3.2rem]">
                  <span className="text-ink/40">|</span>7xKq…9AsU<span className="text-ink/40">⟩</span>
                </div>

                <dl className="mt-8">
                  {fields.map(([k, v], i) => {
                    const t = step(p, 0.22 + i * 0.07, 0.3 + i * 0.07);
                    return (
                      <div
                        key={k}
                        style={{ opacity: t, transform: `translateX(${(1 - t) * -8}px)` }}
                        className="grid grid-cols-[110px_1fr] items-baseline gap-4 border-t border-line-ink py-2.5 first:border-t-0"
                      >
                        <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink/55">
                          {k}
                        </dt>
                        <dd className="tnum font-mono text-sm">{v}</dd>
                      </div>
                    );
                  })}
                </dl>

                <div className="mt-8 flex items-end justify-between">
                  <div className="flex gap-[3px]" aria-hidden>
                    {Array.from({ length: 34 }).map((_, i) => (
                      <span
                        key={i}
                        className="h-7 w-[2px] bg-ink"
                        style={{ opacity: 0.25 + ((i * 7919) % 100) / 130 }}
                      />
                    ))}
                  </div>
                  <span
                    style={{
                      opacity: stamp,
                      transform: `rotate(-8deg) scale(${1.6 - stamp * 0.6})`,
                    }}
                    className="stamp text-signal"
                  >
                    Anchored
                  </span>
                </div>

                <div className="mt-6 font-mono text-[10px] uppercase tracking-[0.16em] text-ink/45">
                  tx 5gH2…kQ9e · block time 10 Oct 2026
                </div>
              </div>
            </div>
          );
        }}
      </Pinned>

      <div className="mx-auto grid max-w-[1400px] gap-4 px-5 pb-24 md:grid-cols-2 md:px-8">
        {[
          {
            name: "Simple",
            body: "Keys derived from your wallet signature. Nothing to store, works on any device.",
          },
          {
            name: "Hardened",
            body: "Independent keys plus a recovery phrase. Zero dependence on Ed25519.",
          },
        ].map((m) => (
          <div key={m.name} className="panel p-6">
            <div className="flex items-center justify-between">
              <span className="eyebrow text-paper">{m.name}</span>
              <span className="eyebrow">mode</span>
            </div>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-mute">{m.body}</p>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <Link href="/passport" className="pill">
            Create passport
          </Link>
          <span className="eyebrow">Two wallet signatures, no transaction until you anchor</span>
        </div>
      </div>
    </section>
  );
}

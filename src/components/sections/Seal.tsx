"use client";

import { useEffect, useState } from "react";
import Pinned from "@/components/ui/Pinned";
import { ChapterHeader } from "@/components/ui/Section";
import { scramble } from "@/lib/scramble";
import { step } from "@/lib/anim";

const AGREEMENT =
  "I, 7xKq…9AsU, agree to sell 12,000 USDC worth of SOL to 3mPz…Lk1d at 184.20 USDC per SOL. Settlement within 24 hours. Both parties sealed.";

function useTick(active: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 70);
    return () => clearInterval(id);
  }, [active]);
  return tick;
}

function Stage({ p }: { p: number }) {
  const amount = Math.max(0, Math.sin(step(p, 0.05, 0.75) * Math.PI) * 1.15 - 0.08);
  const tick = useTick(amount > 0);
  const sealed = step(p, 0.72, 0.8);

  return (
    <div className="mx-auto grid max-w-[1400px] items-center gap-10 px-5 py-24 md:px-8 lg:grid-cols-[1fr_1fr] lg:gap-16">
      <div>
        <ChapterHeader
          index={3}
          eyebrow="The stamp"
          meta="otc-terms.txt · 3.4 KB"
          title={
            <>
              Sign anything.
              <br />
              <span className="display-serif text-paper-2">Prove it forever.</span>
            </>
          }
        />
        {/* The clean text holds the box at its resting size and the scramble is
            drawn over it, so the wider noise glyphs never reflow the column. */}
        <p
          className="relative mt-10 max-w-xl font-serif text-2xl leading-[1.25] text-paper md:text-[2rem]"
          style={{ fontVariantLigatures: "none" }}
        >
          <span aria-hidden className="invisible">
            {AGREEMENT}
          </span>
          <span className="absolute inset-0">{scramble(AGREEMENT, amount, tick)}</span>
        </p>
      </div>

      <div data-scene-anchor className="relative mx-auto w-full max-w-md">
        <div className="panel p-6 md:p-8">
          <div className="flex items-center justify-between">
            <span className="eyebrow">otc-terms.qseal</span>
            <span className="eyebrow">json</span>
          </div>
          <pre className="mt-5 overflow-x-auto whitespace-pre font-mono text-[12px] leading-6 text-mute">
{`{
  "v": 1,
  "hash_alg": "sha256",
  "doc_hash": "9f2c…e41a",
  "passport": "7xKq…9AsU",
  "sig_alg": "ML-DSA-65",
  "signature": "a7f1…c09d",
  "signed_at": 1791640920,
  "anchor_tx": "5gH2…kQ9e"
}`}
          </pre>
          <p className="mt-5 text-sm leading-relaxed text-mute">
            Verification runs in the browser. The file stays on your device.
            Only its hash is checked against the signature and the on-chain
            anchor.
          </p>
        </div>

        <div
          style={{
            opacity: sealed,
            transform: `translate(-50%, -50%) rotate(-10deg) scale(${1.8 - sealed * 0.8})`,
          }}
          className="pointer-events-none absolute left-1/2 top-1/2"
        >
          {/* opaque like a pressed sticker, so the JSON underneath does not run through the letters */}
          <span className="stamp whitespace-nowrap bg-ink-2 text-[22px] text-paper md:text-[28px]">
            Sealed · ML-DSA-65
          </span>
        </div>
      </div>
    </div>
  );
}

export default function Seal() {
  return (
    <section id="seal" data-scene={3} className="relative">
      <Pinned height="260vh">{(p) => <Stage p={p} />}</Pinned>
    </section>
  );
}

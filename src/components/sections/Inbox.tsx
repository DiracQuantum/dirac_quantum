"use client";

import { animate, useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import Section, { ChapterHeader } from "@/components/ui/Section";
import Reveal from "@/components/ui/Reveal";
import { scramble } from "@/lib/scramble";

type Msg = { from: string; who: string; text: string; at: string };

const messages: Msg[] = [
  {
    from: "3mPz…Lk1d",
    who: "Counterparty",
    text: "Still selling 12k at 184.20? I can settle within two hours.",
    at: "14:02",
  },
  {
    from: "9hTe…Qw2a",
    who: "DAO treasury",
    text: "Draft proposal attached. Please seal it before we post publicly.",
    at: "13:40",
  },
  {
    from: "anon",
    who: "Security researcher",
    text: "Found a critical bug in your vault program. Details inside.",
    at: "09:12",
  },
];

function DecryptLine({ msg, delay }: { msg: Msg; delay: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, { once: true, margin: "-15% 0px" });
  const [amount, setAmount] = useState(1);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const controls = animate(1, 0, {
      duration: 1.4,
      delay,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: setAmount,
    });
    const id = setInterval(() => setTick((t) => t + 1), 60);
    return () => {
      controls.stop();
      clearInterval(id);
    };
  }, [inView, delay]);

  const open = amount < 0.02;

  return (
    <li ref={ref} className="panel p-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-paper font-mono text-[10px] text-ink">
            {msg.from.slice(0, 2)}
          </span>
          <div>
            <div className="text-sm text-paper">{msg.who}</div>
            {/* on phones the time moves under the name, so the name keeps one line */}
            <div className="tnum font-mono text-[11px] text-mute">
              {msg.from}
              <span className="sm:hidden"> · {msg.at}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="tnum hidden font-mono text-[11px] text-mute sm:inline">{msg.at}</span>
          <span className={`chip whitespace-nowrap transition-colors duration-500 ${open ? "border-paper/40" : ""}`}>
            {open ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-signal" /> decrypted
              </>
            ) : (
              <>
                ML-KEM-768<span className="hidden sm:inline"> · 1088 B</span>
              </>
            )}
          </span>
        </div>
      </div>
      {/* The clean text holds the card at its resting height and the noise is drawn
          over it, so the card does not grow and shrink while it decrypts. */}
      <p
        className={`relative mt-4 overflow-hidden text-base leading-relaxed transition-colors duration-700 ${
          open ? "text-paper" : "text-mute"
        }`}
        style={{ fontVariantLigatures: "none" }}
      >
        <span aria-hidden className="invisible">
          {msg.text}
        </span>
        <span className="absolute inset-0">{scramble(msg.text, amount, tick)}</span>
      </p>
    </li>
  );
}

export default function Inbox() {
  return (
    <Section id="inbox" index={4}>
      <div className="grid items-start gap-12 lg:grid-cols-[1fr_1fr] lg:gap-16">
        <div>
          <ChapterHeader
            index={4}
            eyebrow="The inbox"
            meta="dirac.network/7xKq…9AsU"
            title={
              <>
                An inbox
                <br />
                <span className="display-serif text-paper-2">only you can open.</span>
              </>
            }
            lede="Every passport gets a public address. Senders encrypt in their own browser with your ML-KEM key. The server keeps ciphertext, the explorer shows ciphertext, and a quantum computer years from now reads nothing."
          />
          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {[
              ["Public address", "Anyone can write to it."],
              ["Sender signs", "Spam control without reading a word."],
              ["USDC + note", "Pay and attach a private memo in one transaction."],
            ].map(([h, b], i) => (
              <Reveal key={h} delay={0.1 + i * 0.08}>
                <div className="border-t border-line pt-4">
                  <div className="eyebrow text-paper">{h}</div>
                  <p className="mt-2 text-sm text-mute">{b}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        <div className="lg:pt-12">
          {/* page-coloured backdrop: the particle formation behind the list does not shine through the gaps */}
          <ul data-scene-anchor className="space-y-3 rounded-[18px] bg-ink">
            {messages.map((m, i) => (
              <DecryptLine key={m.from} msg={m} delay={0.2 + i * 0.45} />
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

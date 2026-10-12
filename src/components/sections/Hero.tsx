"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import LiveStats from "@/components/app/LiveStats";
import { EASE } from "@/lib/anim";
import { useIntroStarted } from "@/lib/introStore";

const lines = [
  { text: "Identity", serif: false },
  { text: "that survives", serif: true },
  { text: "Q-Day.", serif: false },
];

const stats: [string, string][] = [
  ["ML-KEM-768", "Encryption"],
  ["ML-DSA-65", "Signatures"],
  ["Memo anchor", "On Solana"],
];

export default function Hero() {
  // every reveal waits for the page-load burst (shared clock in introStore)
  const started = useIntroStarted();
  return (
    <section
      id="top"
      data-scene={0}
      className="relative min-h-[100svh] pt-32 md:pt-36"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-ink via-ink/70 to-ink/10"
      />

      <div className="relative mx-auto max-w-[1400px] px-5 md:px-8">
        {/* capped by the viewport height too, so on laptop screens the lede and the
            buttons still fit above the fold instead of being cut by it */}
        <h1 className="display text-[clamp(3.6rem,min(12.8vw,20vh),12.5rem)]">
          {lines.map((l, i) => (
            <span key={l.text} className="block overflow-hidden pb-[0.06em]">
              <motion.span
                initial={{ y: "125%" }}
                animate={started ? { y: 0 } : { y: "125%" }}
                transition={{ duration: 1.1, delay: 1.6 + i * 0.12, ease: EASE }}
                className={`block ${l.serif ? "display-serif text-paper-2" : ""}`}
              >
                {l.text}
              </motion.span>
            </span>
          ))}
        </h1>

        <div className="mt-12 grid gap-8 md:grid-cols-[1fr_auto] md:items-end">
          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={started ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }}
            transition={{ duration: 0.9, delay: 2.1, ease: EASE }}
            className="max-w-md text-base leading-relaxed text-mute md:text-lg"
          >
            Falcon leads Solana&apos;s signature plans. Dirac covers the rest: a
            post-quantum passport for your wallet, seals for your documents and
            an inbox nobody else can open. Anchored on-chain before the quantum
            era.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={started ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }}
            transition={{ duration: 0.9, delay: 2.25, ease: EASE }}
            className="flex flex-wrap gap-3"
          >
            <a href="#scanner" className="pill">
              Scroll <span aria-hidden>↓</span>
            </a>
            <Link href="/passport" className="pill pill-ghost">
              Create passport
            </Link>
          </motion.div>
        </div>

        <motion.ul
          initial={{ opacity: 0 }}
          animate={started ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 1, delay: 2.6 }}
          className="mt-16 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-line pt-6 pb-16 md:mt-24 md:grid-cols-4"
        >
          {stats.map(([value, label]) => (
            <li key={value}>
              <div className="font-mono text-sm text-paper">{value}</div>
              <div className="eyebrow mt-1">{label}</div>
            </li>
          ))}
          <li>
            <LiveStats />
          </li>
        </motion.ul>
      </div>
    </section>
  );
}

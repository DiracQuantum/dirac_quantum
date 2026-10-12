"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mark } from "@/components/ui/Nav";

// [label, href]: app pages are real routes, "/#…" are landing-page anchors, and an
// empty href is a channel that does not exist yet (shown as text, not as a link).
const cols: [string, [string, string][]][] = [
  [
    "Product",
    [
      ["Scanner", "/scan"],
      ["Passport", "/passport"],
      ["Seal", "/seal"],
      ["Inbox", "/inbox"],
    ],
  ],
  [
    "Playground",
    [
      ["Attack lab", "/lab"],
      ["Quantum pet", "/pet"],
      ["Qubit arena", "/arena"],
    ],
  ],
  [
    "Company",
    [
      ["Token", "/#token"],
      ["Docs", ""],
      ["GitHub", "https://github.com/DiracQuantum/dirac_quantum"],
      ["X", ""],
    ],
  ],
];

const linkCls = "text-sm text-paper/80 transition-colors hover:text-paper";

export default function Footer() {
  // On the landing page a plain anchor keeps Lenis' smooth scroll; from an app page
  // a client-side Link reaches the anchor without reloading (and replaying the intro).
  const home = usePathname() === "/";
  return (
    // z-[5]: above the fixed particle canvas (z-0) but below every <main> (z-10 or more),
    // so a menu that opens near the end of a page paints over the footer, not under it.
    <footer className="relative z-[5] border-t border-line">
      <div className="mx-auto max-w-[1400px] px-5 py-16 md:px-8 md:py-24">
        <div className="display text-[clamp(3rem,11vw,10rem)]">
          Look
          <br />
          <span className="display-serif text-paper-2">under the key.</span>
        </div>

        {/* Phones and tablets: the brand block on its own row above the link columns (two, then three across). */}
        <div className="mt-16 grid grid-cols-2 gap-x-6 gap-y-12 border-t border-line pt-10 md:grid-cols-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="col-span-2 md:col-span-3 lg:col-span-1">
            <div className="flex items-center gap-2">
              <Mark />
              <span className="display text-[17px]">Dirac</span>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-mute">
              Post-quantum identity layer for Solana. Passports, seals and
              inboxes that survive Q-Day.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="chip">
                <span className="text-mute">CA</span> TBA
              </span>
              <Link href="/passport" className="pill !px-4 !py-2">
                Create passport
              </Link>
            </div>
          </div>
          {cols.map(([h, items]) => (
            <div key={h}>
              <div className="eyebrow">{h}</div>
              <ul className="mt-4 space-y-2.5">
                {items.map(([label, href]) => (
                  <li key={label}>
                    {!href ? (
                      <span className="text-sm text-mute">
                        {label} <span className="font-mono text-[10px] uppercase tracking-[0.14em]">· soon</span>
                      </span>
                    ) : href.startsWith("https://") ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className={linkCls}>
                        {label}
                      </a>
                    ) : href.startsWith("/#") && home ? (
                      <a href={href} className={linkCls}>
                        {label}
                      </a>
                    ) : (
                      <Link href={href} className={linkCls}>
                        {label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-line pt-6 font-mono text-[11px] text-mute md:flex-row md:items-center md:justify-between">
          <span>
            © 2026 Dirac. Built on Solana. <span className="whitespace-nowrap">ML-KEM-768</span> ·{" "}
            <span className="whitespace-nowrap">ML-DSA-65.</span>
          </span>
          <span>Set in Archivo, Newsreader and IBM Plex Mono.</span>
        </div>
      </div>
    </footer>
  );
}

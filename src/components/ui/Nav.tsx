"use client";

import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useScroll,
} from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import ConnectButton from "@/components/wallet/ConnectButton";

// Section anchors on the landing page, prefixed with "/" so they also work from /passport, /seal, /p.
// "Scanner" and "Inbox" are real routes.
const links: [string, string][] = [
  ["Scanner", "/scan"],
  ["Passport", "/#passport"],
  ["Seal", "/#seal"],
  ["Inbox", "/inbox"],
  ["Playground", "/#playground"],
  ["Token", "/#token"],
];

// The menu below lg, where the centred links do not fit: every page, app routes first.
const menuLinks: [string, string, string][] = [
  ["Scanner", "/scan", "what one key can move"],
  ["Passport", "/passport", "your post-quantum identity"],
  ["Seal", "/seal", "sign any document"],
  ["Inbox", "/inbox", "letters only you can open"],
  ["Quantum pet", "/pet", "one creature, everyone's gates"],
  ["Qubit arena", "/arena", "a fighter built from a circuit"],
  ["Attack lab", "/lab", "break it yourself"],
  ["Docs", "/docs", "a guide to your identity"],
  ["Token", "/#token", "$DIRAC, bought back in public"],
];

export function Mark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <path
        d="M20 12 L44 32 L20 52"
        fill="none"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Nav() {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);
  const [solid, setSolid] = useState(false);
  // On the landing page plain anchors keep Lenis' smooth scroll; elsewhere the app pages
  // navigate client-side so the in-memory passport session survives.
  const pathname = usePathname();
  const home = pathname === "/";
  // A route link is current on its own page; /write is the sending half of the inbox.
  const current = (href: string) =>
    !href.includes("#") &&
    (pathname === href || (href === "/inbox" && pathname === "/write"));

  // The menu is open for the page it was opened on, so any navigation closes it
  // without an effect (React Compiler: no setState in effect bodies).
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const menuOpen = menuAt === pathname;
  const closeMenu = () => setMenuAt(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuAt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  useMotionValueEvent(scrollY, "change", (y) => {
    const prev = scrollY.getPrevious() ?? 0;
    setHidden(y > 200 && y > prev);
    setSolid(y > 40);
  });

  return (
    <>
      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            key="menu-backdrop"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={closeMenu}
            className="fixed inset-0 z-30 bg-ink/70 backdrop-blur-sm lg:hidden"
          />
        ) : null}
      </AnimatePresence>
      {/* initial={false}: every page mounts its own Nav, so an entrance animation would
        replay on each client-side navigation (on the first load the intro covers it). */}
      <motion.header
        initial={false}
        animate={{ y: hidden && !menuOpen ? -96 : 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        // a keyboard user tabbing back into the hidden bar gets it back on screen
        onFocus={() => setHidden(false)}
        className={`fixed inset-x-0 top-0 z-40 transition-colors duration-500 ${
          solid || menuOpen ? "bg-ink/85 backdrop-blur-md" : ""
        }`}
      >
        {/* Three columns on desktop, so the centred links stay put when the right group widens (wallet connected);
          max-content keeps the side groups from wrapping on a narrow desktop. */}
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-5 py-4 md:px-8 lg:grid lg:grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]">
          {home ? (
            <a
              href="#top"
              className="flex items-center gap-2 justify-self-start"
            >
              <Mark />
              <span className="display text-[17px]">Dirac</span>
            </a>
          ) : (
            <Link
              href="/"
              className="flex items-center gap-2 justify-self-start"
            >
              <Mark />
              <span className="display text-[17px]">Dirac</span>
            </Link>
          )}

          <nav className="hidden items-center gap-6 lg:flex">
            {links.map(([label, href]) =>
              home && href.startsWith("/#") ? (
                <a
                  key={href}
                  href={href}
                  className="text-[13px] font-medium text-mute transition-colors hover:text-paper"
                >
                  {label}
                </a>
              ) : (
                <Link
                  key={href}
                  href={href}
                  aria-current={current(href) ? "page" : undefined}
                  className={`text-[13px] font-medium transition-colors hover:text-paper ${
                    current(href) ? "text-paper" : "text-mute"
                  }`}
                >
                  {label}
                </Link>
              ),
            )}
          </nav>

          <div className="flex items-center gap-2 justify-self-end">
            <span className="chip hidden sm:inline-flex">
              <span className="text-mute">CA</span> TBA
            </span>
            {/* Wallet state on every page: the ghost "Connect" pill, or the address chip with a disconnect action. */}
            <ConnectButton compact />
            {/* on phones the passport call to action lives in the menu, so the bar keeps room for the wallet */}
            <Link
              href="/passport"
              className="pill hidden !px-4 !py-2.5 sm:inline-flex"
            >
              Create passport
            </Link>
            <button
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="site-menu"
              onClick={() => setMenuAt(menuOpen ? null : pathname)}
              className="relative grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full border border-line transition-colors hover:border-paper/40 lg:hidden"
            >
              <span
                aria-hidden
                className={`absolute h-px w-4 bg-paper transition-transform duration-300 ${menuOpen ? "rotate-45" : "-translate-y-[3px]"}`}
              />
              <span
                aria-hidden
                className={`absolute h-px w-4 bg-paper transition-transform duration-300 ${menuOpen ? "-rotate-45" : "translate-y-[3px]"}`}
              />
            </button>
          </div>
        </div>

        <AnimatePresence>
          {menuOpen ? (
            <motion.nav
              id="site-menu"
              key="menu"
              aria-label="Site"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="max-h-[calc(100svh-72px)] overflow-y-auto border-t border-line lg:hidden"
            >
              <ul className="mx-auto max-w-[1400px] px-5 pb-6 md:px-8">
                {menuLinks.map(([label, href, note], i) => {
                  const here = current(href);
                  const row = (
                    <span className="flex items-baseline justify-between gap-4 py-3.5">
                      <span
                        className={`display shrink-0 whitespace-nowrap text-[1.65rem] leading-none ${here ? "text-paper" : "text-paper-2"}`}
                      >
                        {label}
                      </span>
                      <span className="eyebrow hidden min-w-0 truncate text-right text-[10px] sm:block">
                        {note}
                      </span>
                    </span>
                  );
                  return (
                    <motion.li
                      key={href}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.3, delay: 0.03 * i }}
                      className="border-b border-line"
                    >
                      {home && href.startsWith("/#") ? (
                        <a
                          href={href.slice(1)}
                          onClick={closeMenu}
                          className="block"
                        >
                          {row}
                        </a>
                      ) : (
                        <Link
                          href={href}
                          onClick={closeMenu}
                          aria-current={here ? "page" : undefined}
                          className="block"
                        >
                          {row}
                        </Link>
                      )}
                    </motion.li>
                  );
                })}
              </ul>
              <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-5 pb-6 md:px-8">
                <span className="chip">
                  <span className="text-mute">CA</span> TBA
                </span>
                <Link
                  href="/passport"
                  onClick={closeMenu}
                  className="pill !px-5 !py-3"
                >
                  Create passport
                </Link>
              </div>
            </motion.nav>
          ) : null}
        </AnimatePresence>
      </motion.header>
    </>
  );
}

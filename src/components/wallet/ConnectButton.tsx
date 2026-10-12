"use client";

import { useEffect, useId, useRef, useState } from "react";
import { truncate } from "@/lib/solana/format";
import { explorerAddress } from "@/lib/solana/rpc";
import { useWallet, type WalletOption } from "@/lib/solana/wallet";

const INSTALL_LINKS: [string, string][] = [
  ["Phantom", "https://phantom.com"],
  ["Solflare", "https://solflare.com"],
  ["Backpack", "https://backpack.app"],
];

/** Option panel width (19rem, wide enough for the three install chips on one row) and the screen-edge gutter. */
const PANEL_W = 304;
const GUTTER = 16;

/**
 * Horizontal shift (px) that keeps the option panel inside the viewport. The panel hangs from one
 * edge of the button; in the phone nav the button sits mid-row, so a right-aligned panel would
 * otherwise run off the left edge of the screen.
 */
function panelShift(root: HTMLElement, align: "left" | "right"): number {
  const r = root.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const w = Math.min(PANEL_W, vw - 2 * GUTTER);
  const left = align === "right" ? r.right - w : r.left;
  const clamped = Math.min(Math.max(left, GUTTER), vw - GUTTER - w);
  return Math.round(clamped - left);
}

interface ConnectButtonProps {
  className?: string;
  /** Which edge of the button the option panel hangs from. */
  align?: "left" | "right";
  /** Navigation bar variant: a small ghost "Connect" pill. The connected chip is the same in both modes. */
  compact?: boolean;
}

export default function ConnectButton({
  className = "",
  align = "right",
  compact = false,
}: ConnectButtonProps) {
  const { wallet, options, connect, disconnect, connecting, error } = useWallet();
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const showPanel = open && !wallet;

  // Close on outside click or Escape while the option panel is open.
  useEffect(() => {
    if (!showPanel) return;
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showPanel]);

  if (wallet) {
    return (
      <div className={`chip !py-1.5 ${compact ? "!pl-3 sm:!pl-1.5" : "!pl-1.5"} ${className}`}>
        {/* The phone nav has no room for the icon next to the logo and the passport pill. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wallet.icon} alt="" className={`h-5 w-5 rounded-full ${compact ? "hidden sm:block" : ""}`} />
        <a
          href={explorerAddress(wallet.address)}
          target="_blank"
          rel="noreferrer"
          title={wallet.address}
          className="tnum transition-colors hover:text-signal"
        >
          {truncate(wallet.address)}
        </a>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            void disconnect();
          }}
          aria-label="Disconnect wallet"
          title="Disconnect"
          className="-mr-1 ml-0.5 grid h-6 w-6 place-items-center rounded-full text-mute transition-colors hover:bg-paper/10 hover:text-paper"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        className={`pill ${compact ? "pill-ghost !px-4 !py-2.5" : ""}`}
        aria-haspopup="menu"
        aria-expanded={showPanel}
        aria-controls={panelId}
        aria-busy={connecting}
        disabled={connecting}
        onClick={() => {
          if (!open && rootRef.current) setShift(panelShift(rootRef.current, align));
          setOpen(!open);
        }}
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${
            connecting ? "animate-pulse bg-signal" : compact ? "bg-paper/40" : "bg-ink/35"
          }`}
        />
        {/* The nav pill keeps its label (the pulsing dot shows progress): a wider label would push into the logo on phones. */}
        {compact ? "Connect" : connecting ? "Connecting…" : "Connect wallet"}
      </button>

      {showPanel && (
        <div
          id={panelId}
          role="menu"
          className={`panel absolute top-[calc(100%+10px)] z-50 p-2 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.9)] ${
            align === "right" ? "right-0" : "left-0"
          }`}
          style={{
            width: `min(${PANEL_W}px, calc(100vw - ${2 * GUTTER}px))`,
            transform: shift ? `translateX(${shift}px)` : undefined,
          }}
        >
          <div className="eyebrow px-3 pb-2 pt-1.5">
            {options.length > 0 ? "Choose a wallet" : "No wallet found"}
          </div>

          {options.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {options.map((o) => (
                <WalletRow
                  key={o.name}
                  option={o}
                  disabled={connecting}
                  onPick={() => void connect(o)}
                />
              ))}
            </ul>
          ) : (
            <div className="px-3 pb-2">
              <p className="text-sm leading-relaxed text-mute">
                Install a Solana wallet that speaks Wallet Standard, then reload this page.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {INSTALL_LINKS.map(([name, href]) => (
                  <a
                    key={name}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="chip flex-1 justify-center !py-1 transition-colors hover:!border-paper/40 hover:bg-paper/5"
                  >
                    {name}
                  </a>
                ))}
              </div>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mt-2 border-t border-line px-3 pb-1 pt-2.5 font-mono text-[11px] leading-relaxed text-paper"
            >
              <span className="text-mute">error · </span>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function WalletRow({
  option,
  disabled,
  onPick,
}: {
  option: WalletOption;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={onPick}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-paper/10 disabled:opacity-50"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={option.icon} alt="" className="h-6 w-6 rounded-md" />
        <span className="flex-1">{option.name}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-mute">detected</span>
      </button>
    </li>
  );
}

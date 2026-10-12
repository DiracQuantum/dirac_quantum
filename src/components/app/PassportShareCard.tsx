"use client";

/**
 * Share block for a public passport: a 1200×630 PNG drawn on a canvas in the
 * browser with the same chrome as the scan card: the fingerprint, the mode,
 * the issue date, the wallet, and a lattice of dots seeded by the passport
 * hash so no two cards look alike. Once drawn with the fonts in, the card is
 * stored with the Worker (PUT /api/share/passport/:wallet) so a pasted
 * /p?a= link previews it; a refused upload changes nothing on the page. The
 * Worker keeps the first card stored per registered passport; when the
 * connected wallet is the holder, "Re-store card" signs a fresh card with it
 * (SHARE_MESSAGE in lib/share) and replaces the stored one.
 */

import { useEffect, useRef, useState } from "react";
import { CopyButton, describeError } from "@/components/app/ui";
import { formatUtc, MODE_LABEL } from "@/components/app/PassportDocument";
import {
  CARD_H,
  CARD_W,
  LINE,
  MUTE,
  PAD,
  PAPER,
  PAPER_2,
  SIGNAL,
  cardFonts,
  drawChrome,
  drawFooter,
  drawHeadline,
  drawLabel,
  ensureFonts,
  fontsReady,
  setSpacing,
  setStretch,
  utcDate,
} from "@/components/share/canvas";
import { fingerprint, passportHash, type Passport } from "@/lib/pq";
import { canvasToBlob, downloadBlob, hostOf, signShareCard, siteOrigin, uploadShareCard, xIntent } from "@/lib/share";
import { truncate } from "@/lib/solana/format";
import { useWallet } from "@/lib/solana/wallet";

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

export function passportPageUrl(origin: string, wallet: string): string {
  return `${origin}/p?a=${encodeURIComponent(wallet)}`;
}

export function passportShareText(mode: Passport["mode"], anchored: boolean): string {
  const level = `${MODE_LABEL[mode].toLowerCase()} mode${anchored ? ", anchored on Solana" : ""}`;
  return `My Solana wallet carries a post-quantum passport: ML-KEM-768 + ML-DSA-65, ${level}. Anyone can re-check it.`;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

interface CardData {
  wallet: string;
  fingerprint: string;
  mode: Passport["mode"];
  anchored: boolean;
  /** unix ms */
  createdAt: number;
  /** hex sha256 of the canonical passport: seeds the lattice */
  hash: string;
  host: string;
}

/** Dots on a 9×7 lattice, each jittered and shaded by two hex digits of the hash. */
function drawLattice(ctx: CanvasRenderingContext2D, hash: string): void {
  const cols = 9;
  const rows = 7;
  const x0 = 808;
  const y0 = 150;
  const step = 40;
  const digit = (k: number) => parseInt(hash[k % hash.length] ?? "0", 16) / 15;
  ctx.save();
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const k = (i * rows + j) * 2;
      const h = digit(k);
      const g = digit(k + 1);
      const x = x0 + i * step + (h - 0.5) * 16;
      const y = y0 + j * step + (g - 0.5) * 16;
      ctx.globalAlpha = 0.2 + g * 0.7;
      ctx.fillStyle = (i * rows + j) % 5 === 0 ? SIGNAL : PAPER;
      ctx.beginPath();
      ctx.arc(x, y, 1.5 + h * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export async function drawPassportCard(canvas: HTMLCanvasElement, data: CardData): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");

  const fonts = cardFonts();
  await ensureFonts([
    `800 112px ${fonts.sans}`,
    `800 40px ${fonts.sans}`,
    `800 30px ${fonts.sans}`,
    `italic 400 112px ${fonts.serif}`,
    `500 20px ${fonts.mono}`,
    `500 34px ${fonts.mono}`,
    `400 22px ${fonts.mono}`,
  ]);

  const right = CARD_W - PAD;
  drawChrome(ctx, fonts, "02 / PUBLIC PASSPORT");
  drawLattice(ctx, data.hash);

  const number = data.hash.slice(0, 6).toUpperCase().replace(/(.{3})(.{3})/, "$1 $2");
  drawLabel(ctx, fonts, `DIRAC PASSPORT · № ${number}`, PAD, 176);

  // Headline: condensed sans over serif italic, the site's display pairing.
  const size = drawHeadline(ctx, fonts, "Post-quantum", PAD - 4, 296, 690, 112);
  ctx.fillStyle = PAPER_2;
  ctx.font = `italic 400 ${size}px ${fonts.serif}`;
  setStretch(ctx, "normal");
  setSpacing(ctx, -Math.round(size * 0.02));
  ctx.textAlign = "left";
  ctx.fillText("passport.", PAD - 2, 296 + Math.round(size * 0.98));
  setSpacing(ctx, 0);

  ctx.fillStyle = LINE;
  ctx.fillRect(PAD, 440, right - PAD, 1);

  // Three columns: fingerprint, mode, issued.
  const col2 = PAD + 470;
  const col3 = PAD + 790;
  drawLabel(ctx, fonts, "FINGERPRINT", PAD, 486);
  drawLabel(ctx, fonts, "MODE", col2, 486);
  drawLabel(ctx, fonts, "ISSUED", col3, 486);

  // All three values in the display sans, as on the scan card: in mono the fingerprint read as one
  // block with the mono wallet line right under it.
  ctx.fillStyle = PAPER;
  ctx.font = `800 40px ${fonts.sans}`;
  setStretch(ctx, "semi-condensed");
  setSpacing(ctx, -0.8);
  ctx.fillText(data.fingerprint, PAD, 528);
  ctx.fillText(`${MODE_LABEL[data.mode]}${data.anchored ? ", anchored" : ""}`, col2, 528);
  const issued = utcDate(data.createdAt);
  ctx.fillStyle = issued ? PAPER : MUTE;
  ctx.fillText(issued || "unknown", col3, 528);
  setStretch(ctx, "normal");
  setSpacing(ctx, 0);

  drawFooter(ctx, fonts, `|${truncate(data.wallet, 6, 6)}⟩`, `${data.host}/p`);
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface PassportShareCardProps {
  passport: Passport;
  /**
   * The registry verified the anchor on chain (PassportRecord.anchor_verified). An anchor_tx the
   * Worker has not found yet is not "anchored" on the card, matching the key the Worker files the
   * card under (passports.anchor_tx holds verified anchors only).
   */
  anchored: boolean;
  className?: string;
}

export default function PassportShareCard({ passport, anchored, className = "" }: PassportShareCardProps) {
  const preview = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** the card id the Worker accepted (`${hash}:${anchored}`) */
  const [stored, setStored] = useState<string | null>(null);
  const uploadedFor = useRef<string | null>(null);
  const { wallet: connected } = useWallet();

  const { wallet, mode, created_at: createdAt } = passport;
  const hash = passportHash(passport);
  const fp = fingerprint(passport);
  const cardId = `${hash}:${anchored}`;
  /** the connected wallet when it is this passport's holder: it may replace the stored card */
  const holder = connected !== null && connected.address === wallet ? connected : null;

  useEffect(() => {
    const canvas = preview.current;
    if (!canvas) return;
    let cancelled = false;
    const data: CardData = { wallet, fingerprint: fp, mode, anchored, createdAt, hash, host: hostOf(siteOrigin()) };
    // Fonts may still be loading on first paint; redraw once they are in.
    const run = () => {
      if (!cancelled) void drawPassportCard(canvas, data).catch(() => undefined);
    };
    run();
    fontsReady().then(run, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [wallet, fp, mode, anchored, createdAt, hash]);

  // Once per passport record: the card, drawn offscreen with the fonts in,
  // goes to the Worker. Silent on failure.
  useEffect(() => {
    if (uploadedFor.current === cardId) return;
    uploadedFor.current = cardId;
    const data: CardData = { wallet, fingerprint: fp, mode, anchored, createdAt, hash, host: hostOf(siteOrigin()) };
    const run = async () => {
      await fontsReady();
      const canvas = document.createElement("canvas");
      await drawPassportCard(canvas, data);
      const ok = await uploadShareCard("passport", wallet, await canvasToBlob(canvas));
      if (ok && uploadedFor.current === cardId) setStored(cardId);
    };
    run().catch(() => undefined);
  }, [cardId, wallet, fp, mode, anchored, createdAt, hash]);

  const download = async () => {
    setBusy(true);
    setNote(null);
    try {
      const canvas = document.createElement("canvas");
      await drawPassportCard(canvas, { wallet, fingerprint: fp, mode, anchored, createdAt, hash, host: hostOf(siteOrigin()) });
      downloadBlob(`dirac-passport-${wallet.slice(0, 4)}.png`, await canvasToBlob(canvas));
      setNote("saved");
    } catch (e: unknown) {
      setNote(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  // The holder's override: a fresh card, signed by the wallet, replaces whatever is stored.
  const restore = async () => {
    if (!holder) return;
    setBusy(true);
    setNote(null);
    try {
      await fontsReady();
      const canvas = document.createElement("canvas");
      await drawPassportCard(canvas, { wallet, fingerprint: fp, mode, anchored, createdAt, hash, host: hostOf(siteOrigin()) });
      const png = await canvasToBlob(canvas);
      const ok = await uploadShareCard("passport", wallet, png, await signShareCard(holder, png));
      if (ok) setStored(cardId);
      setNote(ok ? "card stored" : "the registry refused the card");
    } catch (e: unknown) {
      setNote(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const postOnX = () => {
    const origin = siteOrigin();
    window.open(xIntent(passportShareText(mode, anchored), passportPageUrl(origin, wallet)), "_blank", "noopener,noreferrer");
  };

  return (
    <div className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Share</span>
        <span className="font-mono text-[11px] text-mute">1200 × 630 · drawn in your browser</span>
      </div>
      <canvas
        ref={preview}
        width={CARD_W}
        height={CARD_H}
        role="img"
        aria-label={`Share card: post-quantum passport of wallet ${truncate(wallet)}, ${MODE_LABEL[mode]} mode${
          anchored ? ", anchored" : ""
        }, fingerprint ${fp}, issued ${formatUtc(createdAt)}`}
        className="mt-4 h-auto w-full rounded-xl border border-line bg-ink"
      />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void download()} disabled={busy} className="pill disabled:opacity-50">
          {busy ? "Rendering…" : "Download PNG"}
        </button>
        <button type="button" onClick={postOnX} className="pill pill-ghost">
          Post on X ↗
        </button>
        <CopyButton value={() => passportPageUrl(siteOrigin(), wallet)} label="passport link" text="copy link" className="!px-3 !py-1.5" />
        {holder ? (
          <button
            type="button"
            onClick={() => void restore()}
            disabled={busy}
            title="Sign with your wallet to replace the stored preview card"
            className="pill pill-ghost disabled:opacity-50"
          >
            Re-store card
          </button>
        ) : null}
        {note ? <span className="font-mono text-[11px] text-mute">{note}</span> : null}
      </div>
      {stored === cardId ? <p className="mt-3 font-mono text-[11px] text-mute">preview card stored</p> : null}
    </div>
  );
}

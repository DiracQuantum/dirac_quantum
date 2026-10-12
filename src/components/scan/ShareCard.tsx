"use client";

/**
 * Share block for a complete scan: a 1200×630 PNG card drawn on a canvas in
 * the browser (no server-side images), an X intent and a copyable link. The
 * visible canvas is a preview; the download renders a fresh offscreen canvas
 * with the same code. Sharing is off for partial reports, where the card
 * would carry numbers that may be wrong. The site origin is read inside
 * handlers and effects, never during render; NEXT_PUBLIC_SITE_URL wins when
 * it is set.
 */

import { useEffect, useRef, useState } from "react";
import { CopyButton, describeError } from "@/components/app/ui";
import { SOURCE_LABEL, unreadSources } from "@/components/scan/atoms";
import { count, formatUsdHeadline, formatUtcDate, joinList } from "@/components/scan/format";
import type { IdentityLevel, ScanReport } from "@/lib/scan";
import { uploadShareCard } from "@/lib/share";
import { truncate } from "@/lib/solana/format";

const CARD_W = 1200;
const CARD_H = 630;
const INK = "#070708";
const PAPER = "#f2f1ec";
const MUTE = "#8c8c87";
const LINE = "rgba(242, 241, 236, 0.12)";

const LEVEL_LABEL: Record<IdentityLevel, string> = {
  none: "None",
  simple: "Simple",
  hardened: "Hardened",
};

/* ------------------------------------------------------------------ */
/* URLs and text                                                       */
/* ------------------------------------------------------------------ */

/**
 * The site origin for share links: `NEXT_PUBLIC_SITE_URL` when set, otherwise
 * the origin of the current page. Call it from handlers or effects only.
 */
export function siteOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** "dirac.network" from "https://dirac.network" */
export function hostOf(origin: string): string {
  return origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}

export function sharePageUrl(origin: string, wallet: string): string {
  return `${origin}/scan?a=${encodeURIComponent(wallet)}`;
}

/** The post text. A mint, PDA or multisig account has no key of its own, so it is not "my wallet". */
export function shareText(exposureUsd: number | null, level: IdentityLevel, isWallet = true): string {
  const amount = exposureUsd !== null ? formatUsdHeadline(exposureUsd) : "an unknown amount";
  if (!isWallet) return `Quantum exposure of a Solana address: ${amount} held there, no key of its own. Check yours.`;
  return `Quantum exposure of my Solana wallet: ${amount} under one key. PQ identity: ${LEVEL_LABEL[level]}. Check yours.`;
}

export function xIntentUrl(
  origin: string,
  wallet: string,
  exposureUsd: number | null,
  level: IdentityLevel,
  isWallet = true,
): string {
  const text = encodeURIComponent(shareText(exposureUsd, level, isWallet));
  const url = encodeURIComponent(sharePageUrl(origin, wallet));
  return `https://x.com/intent/post?text=${text}&url=${url}`;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

interface CardData {
  wallet: string;
  exposureUsd: number | null;
  level: IdentityLevel;
  anchored: boolean;
  /** A signing wallet; any other kind of address has no key to put the amount "under". */
  isWallet: boolean;
  /** unix ms */
  scannedAt: number;
  /** "dirac.network", for the footer */
  host: string;
}

/** The family list behind a next/font CSS variable, with a generic fallback. */
function cssFamily(variable: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return v ? `${v}, ${fallback}` : fallback;
}

async function ensureFonts(specs: string[]): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => [])));
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${px}px`;
}

function setStretch(ctx: CanvasRenderingContext2D, value: CanvasFontStretch): void {
  if ("fontStretch" in ctx) ctx.fontStretch = value;
}

function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  // The Dirac mark: a chevron, the same path as the Nav mark (64-unit viewBox).
  const s = size / 64;
  ctx.save();
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 8 * s;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x + 20 * s, y + 12 * s);
  ctx.lineTo(x + 44 * s, y + 32 * s);
  ctx.lineTo(x + 20 * s, y + 52 * s);
  ctx.stroke();
  ctx.restore();
}

export async function drawShareCard(canvas: HTMLCanvasElement, data: CardData): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");

  const sans = cssFamily("--font-archivo", "sans-serif");
  const mono = cssFamily("--font-plex-mono", "monospace");
  const bigFont = (px: number) => `800 ${px}px ${sans}`;
  const valueFont = `800 40px ${sans}`;
  const brandFont = `800 30px ${sans}`;
  const monoLabel = `500 20px ${mono}`;
  const monoWallet = `500 34px ${mono}`;
  const monoBody = `400 26px ${mono}`;
  const monoSmall = `400 22px ${mono}`;
  await ensureFonts([bigFont(200), valueFont, brandFont, monoLabel, monoWallet, monoBody, monoSmall]);

  const pad = 72;
  const right = CARD_W - pad;

  // Background
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Header: mark + DIRAC, chapter eyebrow on the right, a rule under both.
  drawMark(ctx, pad - 4, 50, 40);
  ctx.fillStyle = PAPER;
  ctx.font = brandFont;
  setStretch(ctx, "semi-condensed");
  setSpacing(ctx, -0.6);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText("DIRAC", pad + 44, 82);

  ctx.font = monoLabel;
  setStretch(ctx, "normal");
  setSpacing(ctx, 3);
  ctx.fillStyle = MUTE;
  ctx.textAlign = "right";
  ctx.fillText("02 / EXPOSURE REPORT", right, 80);

  ctx.fillStyle = LINE;
  ctx.fillRect(pad, 112, right - pad, 1);

  // Label
  ctx.textAlign = "left";
  ctx.fillStyle = MUTE;
  ctx.font = monoLabel;
  ctx.fillText("QUANTUM EXPOSURE", pad, 176);

  // The amount, shrunk to fit the width when it is long.
  const amount = data.exposureUsd !== null ? formatUsdHeadline(data.exposureUsd) : "Unavailable";
  ctx.fillStyle = data.exposureUsd !== null ? PAPER : MUTE;
  setStretch(ctx, "semi-condensed");
  let size = 200;
  ctx.font = bigFont(size);
  setSpacing(ctx, -Math.round(size * 0.04));
  const maxWidth = right - pad;
  const width = ctx.measureText(amount).width;
  if (width > maxWidth) {
    size = Math.floor((size * maxWidth) / width);
    ctx.font = bigFont(size);
    setSpacing(ctx, -Math.round(size * 0.04));
  }
  ctx.fillText(amount, pad - 4, 352);

  // Under the amount
  setStretch(ctx, "normal");
  setSpacing(ctx, 0);
  ctx.fillStyle = MUTE;
  ctx.font = monoBody;
  ctx.fillText(data.isWallet ? "under one Ed25519 key" : "held at this address", pad, 404);

  ctx.fillStyle = LINE;
  ctx.fillRect(pad, 440, right - pad, 1);

  // Two columns: PQ identity, data
  const col2 = pad + Math.round((right - pad) / 2);
  ctx.fillStyle = MUTE;
  ctx.font = monoLabel;
  setSpacing(ctx, 3);
  ctx.fillText("PQ IDENTITY", pad, 486);
  ctx.fillText("DATA", col2, 486);

  ctx.fillStyle = PAPER;
  ctx.font = valueFont;
  setStretch(ctx, "semi-condensed");
  setSpacing(ctx, -0.8);
  ctx.fillText(`${LEVEL_LABEL[data.level]}${data.anchored ? ", anchored" : ""}`, pad, 528);
  ctx.fillText("Complete", col2, 528);

  // Footer: wallet left, date and host right
  setStretch(ctx, "normal");
  setSpacing(ctx, 0);
  ctx.fillStyle = PAPER;
  ctx.font = monoWallet;
  ctx.fillText(truncate(data.wallet, 6, 6), pad, 582);

  ctx.fillStyle = MUTE;
  ctx.font = monoSmall;
  ctx.textAlign = "right";
  const date = formatUtcDate(Math.floor(data.scannedAt / 1000));
  ctx.fillText(`${date === "—" ? "" : `${date} · `}${data.host}/scan`, right, 582);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not render the card."));
    }, "image/png");
  });
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface ShareCardProps {
  report: ScanReport;
  className?: string;
}

export default function ShareCard({ report, className = "" }: ShareCardProps) {
  const preview = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** the report whose card the Worker accepted, as `${wallet}:${scannedAt}` */
  const [stored, setStored] = useState<string | null>(null);
  const uploadedFor = useRef<string | null>(null);

  const shareable = report.confidence === "complete";
  const { wallet, scannedAt } = report;
  const exposureUsd = report.exposure.usd;
  const level = report.identity.level;
  const anchored = report.identity.anchored;
  const isWallet = report.address.kind === "wallet";

  useEffect(() => {
    if (!shareable) return;
    const canvas = preview.current;
    if (!canvas) return;
    let cancelled = false;
    const data: CardData = { wallet, exposureUsd, level, anchored, isWallet, scannedAt, host: hostOf(siteOrigin()) };
    // Fonts may still be loading on first paint; redraw once they are in.
    const run = () => {
      if (!cancelled) void drawShareCard(canvas, data).catch(() => undefined);
    };
    run();
    if ("fonts" in document) document.fonts.ready.then(run, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [shareable, wallet, exposureUsd, level, anchored, isWallet, scannedAt]);

  // Once per complete report: the same card, drawn offscreen with the fonts
  // in, goes to the Worker so a pasted /scan?a= link previews it. Failures
  // are silent; the page does not depend on it.
  useEffect(() => {
    if (!shareable) return;
    const id = `${wallet}:${scannedAt}`;
    if (uploadedFor.current === id) return;
    uploadedFor.current = id;
    const data: CardData = { wallet, exposureUsd, level, anchored, isWallet, scannedAt, host: hostOf(siteOrigin()) };
    const run = async () => {
      if ("fonts" in document) await document.fonts.ready.catch(() => undefined);
      const canvas = document.createElement("canvas");
      await drawShareCard(canvas, data);
      const ok = await uploadShareCard("scan", wallet, await toBlob(canvas));
      if (ok && uploadedFor.current === id) setStored(id);
    };
    run().catch(() => undefined);
  }, [shareable, wallet, exposureUsd, level, anchored, isWallet, scannedAt]);

  const download = async () => {
    setBusy(true);
    setNote(null);
    try {
      const canvas = document.createElement("canvas");
      await drawShareCard(canvas, { wallet, exposureUsd, level, anchored, isWallet, scannedAt, host: hostOf(siteOrigin()) });
      downloadBlob(`dirac-scan-${wallet.slice(0, 4)}.png`, await toBlob(canvas));
      setNote("saved");
    } catch (e: unknown) {
      setNote(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const postOnX = () => {
    window.open(xIntentUrl(siteOrigin(), wallet, exposureUsd, level, isWallet), "_blank", "noopener,noreferrer");
  };

  if (!shareable) {
    const missing = unreadSources(report).map((name) => SOURCE_LABEL[name]);
    return (
      <div className={`panel p-6 md:p-8 ${className}`}>
        <div className="flex items-center justify-between gap-4">
          <span className="eyebrow">Share</span>
          <span className="font-mono text-[11px] text-mute">off for incomplete reports</span>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-mute">
          Sharing is available for complete reports only. {count(missing.length, "source")} did not answer in
          full ({joinList(missing)}), so the card would carry numbers that may be wrong. Scan again when they
          answer.
        </p>
        {/* Same row as the live one, dimmed; no hover lift on a button that does nothing. */}
        <div className="pointer-events-none mt-5 flex flex-wrap items-center gap-3 opacity-50">
          <button type="button" disabled className="pill">
            Download PNG
          </button>
          <button type="button" disabled className="pill pill-ghost">
            Post on X ↗
          </button>
          <button
            type="button"
            disabled
            className="inline-flex items-center rounded-full border border-line px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-mute"
          >
            copy
          </button>
        </div>
      </div>
    );
  }

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
        aria-label={`Share card: quantum exposure ${
          exposureUsd !== null ? formatUsdHeadline(exposureUsd) : "unavailable"
        } ${isWallet ? "under one key for wallet" : "held at address"} ${truncate(wallet)}, PQ identity ${level}${
          anchored ? ", anchored" : ""
        }`}
        className="mt-4 h-auto w-full rounded-xl border border-line bg-ink"
      />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy}
          className="pill disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "Rendering…" : "Download PNG"}
        </button>
        <button type="button" onClick={postOnX} className="pill pill-ghost">
          Post on X ↗
        </button>
        <CopyButton value={() => sharePageUrl(siteOrigin(), wallet)} label="scan link" text="copy link" className="!px-3 !py-1.5" />
        {note ? <span className="font-mono text-[11px] text-mute">{note}</span> : null}
      </div>
      {stored === `${wallet}:${scannedAt}` ? (
        <p className="mt-3 font-mono text-[11px] text-mute">preview card stored</p>
      ) : null}
    </div>
  );
}

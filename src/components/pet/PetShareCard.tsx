"use client";

/**
 * Share block for the pet's day: a 1200×630 PNG drawn on a canvas in the
 * browser with the same chrome as the scan card: the day, today's form,
 * character and ability, the palette swatch, the bits that produced the body
 * and tonight's top outcomes. Once drawn with the fonts in, the card is
 * stored with the Worker under the current day (PUT /api/share/pet/:day) so
 * a pasted /pet link previews it. The Worker accepts the current day only
 * and keeps a stored card for ten minutes before a visit may replace it; a
 * refused upload changes nothing here.
 *
 * "Copy post" gives the text the Worker would post to X for the latest
 * collapse (src/lib/pet.ts `postTextForDay`), since the account posts by hand.
 */

import { useEffect, useRef, useState } from "react";
import { describeError } from "@/components/app/ui";
import { formatPct, groupBits, pad2 } from "@/components/pet/format";
import {
  CARD_H,
  CARD_W,
  LINE,
  MUTE,
  PAD,
  PAPER,
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
import { paletteOf, postTextForDay, type PetDay, type PetOutcome, type PetState } from "@/lib/pet";
import { rigFor } from "@/lib/petForms";
import { canvasToBlob, downloadBlob, hostOf, siteOrigin, uploadShareCard, xIntent } from "@/lib/share";

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

const TOP_ROWS = 4;

/** The picture of today's body, left column: a square box the creature is fitted into. */
const ART_SIZE = 268;
const ART_X = PAD - 8;
const ART_Y = 184;

interface Art {
  img: HTMLImageElement;
  /** square source crop around the creature (the renders carry wide black margins) */
  sx: number;
  sy: number;
  s: number;
}

const artCache = new Map<string, Promise<Art | null>>();

/** The smallest square around the lit pixels of a render on black, with a small margin. */
function cropOf(img: HTMLImageElement): { sx: number; sy: number; s: number } {
  const full = { sx: 0, sy: 0, s: Math.min(img.naturalWidth, img.naturalHeight) };
  const N = 96;
  const c = document.createElement("canvas");
  c.width = N;
  c.height = N;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return full;
  ctx.drawImage(img, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;
  let x0 = N;
  let y0 = N;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const k = (y * N + x) * 4;
      if (Math.max(px[k], px[k + 1], px[k + 2]) > 28) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return full;
  const scale = img.naturalWidth / N;
  const side = Math.min(full.s, (Math.max(x1 - x0, y1 - y0) + 1) * scale * 1.08);
  const cx = ((x0 + x1 + 1) / 2) * scale;
  const cy = ((y0 + y1 + 1) / 2) * scale;
  const clamp = (v: number) => Math.max(0, Math.min(full.s - side, v));
  return { sx: clamp(cx - side / 2), sy: clamp(cy - side / 2), s: side };
}

/**
 * The form's picture (same origin, so the canvas stays exportable), loaded
 * once per form, decoded and cropped to the creature; null when it cannot be
 * loaded, and the card falls back to the form's name as a headline.
 */
function loadArt(form: string): Promise<Art | null> {
  const src = `/characters/${rigFor(form).rig.file}`;
  let p = artCache.get(src);
  if (!p) {
    p = new Promise<Art | null>((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve({ img, ...cropOf(img) });
      img.onerror = () => resolve(null);
      img.src = src;
    });
    artCache.set(src, p);
  }
  return p;
}

interface CardData {
  day: number;
  form: string;
  character: string;
  ability: string;
  palette: string;
  /** the palette's CSS glow colour, for the swatch */
  glow: string;
  /** the bits that produced today's body, or null on day 1 */
  bits: string | null;
  /** the IBM backend measuring yesterday's collapse right now (bits are null meanwhile) */
  measuring: string | null;
  actions: number;
  /** tonight's most likely outcomes, highest first */
  top: PetOutcome[];
  /** unix ms of the day's start, for the footer date */
  dayStartedAt: number;
  host: string;
}

export async function drawPetCard(canvas: HTMLCanvasElement, data: CardData): Promise<void> {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");

  const fonts = cardFonts();
  await ensureFonts([
    `800 150px ${fonts.sans}`,
    `800 58px ${fonts.sans}`,
    `800 40px ${fonts.sans}`,
    `800 30px ${fonts.sans}`,
    `500 20px ${fonts.mono}`,
    `400 26px ${fonts.mono}`,
    `500 34px ${fonts.mono}`,
    `400 22px ${fonts.mono}`,
  ]);

  const right = CARD_W - PAD;
  const colR = 740;
  const art = await loadArt(data.form);
  drawChrome(ctx, fonts, "05 / QUANTUM PET");

  // Left: today's body as a picture, its name and traits under it. The
  // render sits on black; a screen blend lets the card's ink show through.
  drawLabel(ctx, fonts, `DAY ${pad2(data.day)} · TODAY'S BODY`, PAD, 176);
  if (art) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.drawImage(art.img, art.sx, art.sy, art.s, art.s, ART_X, ART_Y, ART_SIZE, ART_SIZE);
    ctx.restore();
    ctx.fillStyle = PAPER;
    ctx.font = `800 58px ${fonts.sans}`;
    setStretch(ctx, "semi-condensed");
    setSpacing(ctx, -1.2);
    ctx.textAlign = "left";
    ctx.fillText(data.form, PAD, 500, colR - PAD - 40);
  } else {
    drawHeadline(ctx, fonts, data.form, PAD - 4, 420, colR - PAD - 40, 150);
  }

  // Character · ability, then the palette swatch and its name.
  ctx.fillStyle = PAPER;
  ctx.font = `400 24px ${fonts.mono}`;
  setStretch(ctx, "normal");
  setSpacing(ctx, 0);
  ctx.textAlign = "left";
  const traits = `${data.character} · ${data.ability}`;
  ctx.fillText(traits, PAD, 538);
  const swatchX = PAD + ctx.measureText(traits).width + 28;
  ctx.fillStyle = data.glow;
  ctx.beginPath();
  ctx.arc(swatchX, 530, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = MUTE;
  ctx.fillText(data.palette, swatchX + 16, 538);

  // Tonight's odds on the right: the top outcomes with a bar each.
  drawLabel(ctx, fonts, "TONIGHT'S ODDS", colR, 176);
  const rows = data.top.slice(0, TOP_ROWS);
  if (rows.length === 0) {
    ctx.fillStyle = MUTE;
    ctx.font = `400 22px ${fonts.mono}`;
    ctx.fillText("not available", colR, 226);
  }
  const maxP = rows.reduce((m, o) => Math.max(m, o.p), 0);
  rows.forEach((o, i) => {
    const y = 226 + i * 56;
    ctx.font = `400 20px ${fonts.mono}`;
    ctx.textAlign = "left";
    ctx.fillStyle = PAPER;
    const bits = groupBits(o.bits);
    ctx.fillText(bits, colR, y);
    const pct = formatPct(o.p);
    const pctX = right - ctx.measureText(pct).width;
    ctx.textAlign = "right";
    ctx.fillText(pct, right, y);
    ctx.textAlign = "left";
    // The form sits between the bits and the percentage; it is dropped when it would collide.
    const formX = colR + ctx.measureText(bits).width + 20;
    if (formX + ctx.measureText(o.form).width <= pctX - 14) {
      ctx.fillStyle = MUTE;
      ctx.fillText(o.form, formX, y);
    }
    ctx.fillStyle = LINE;
    ctx.fillRect(colR, y + 12, right - colR, 4);
    ctx.fillStyle = PAPER;
    ctx.fillRect(colR, y + 12, maxP > 0 ? Math.round(((right - colR) * o.p) / maxP) : 0, 4);
  });

  // Right, under the odds: the bits behind today's body, and the gate count
  // right-aligned on the same row (the left column belongs to the picture).
  ctx.fillStyle = LINE;
  ctx.fillRect(colR, 432, right - colR, 1);
  drawLabel(ctx, fonts, "COLLAPSED BITS", colR, 468);
  // drawLabel aligns left: place the right-hand label by its measured width
  ctx.font = `500 20px ${fonts.mono}`;
  setSpacing(ctx, 3);
  const gatesLabelW = ctx.measureText("GATES").width;
  setSpacing(ctx, 0);
  drawLabel(ctx, fonts, "GATES", right - gatesLabelW + 3, 468);

  // Both values in the display sans, as on the scan and passport cards.
  ctx.font = `800 40px ${fonts.sans}`;
  setStretch(ctx, "semi-condensed");
  setSpacing(ctx, -0.8);
  const gates = String(data.actions);
  const gatesW = ctx.measureText(gates).width;
  const bitsMax = right - colR - gatesW - 28;
  if (data.bits !== null) {
    // The sans's word space is narrow under the tight tracking: the trait groups get a real gap.
    ctx.fillStyle = PAPER;
    let x = colR;
    for (const group of groupBits(data.bits).split(" ")) {
      ctx.fillText(group, x, 512);
      x += ctx.measureText(group).width + 14;
    }
  } else if (data.measuring !== null) {
    ctx.fillStyle = MUTE;
    ctx.font = `400 20px ${fonts.mono}`;
    setStretch(ctx, "normal");
    setSpacing(ctx, 0);
    ctx.fillText(`measuring on ${data.measuring}`, colR, 506, bitsMax);
    ctx.font = `800 40px ${fonts.sans}`;
    setStretch(ctx, "semi-condensed");
    setSpacing(ctx, -0.8);
  } else {
    ctx.fillStyle = MUTE;
    ctx.fillText("none yet · day 1", colR, 512, bitsMax);
  }
  ctx.fillStyle = PAPER;
  ctx.textAlign = "right";
  ctx.fillText(gates, right, 512);
  ctx.textAlign = "left";
  setStretch(ctx, "normal");
  setSpacing(ctx, 0);

  const date = utcDate(data.dayStartedAt);
  drawFooter(ctx, fonts, "collapses 00:00 UTC", `${date ? `${date} · ` : ""}${data.host}/pet`);
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/** The collapse that produced today's body: the newest history entry when it is yesterday's. */
function latestCollapse(state: PetState): PetDay | null {
  const latest = state.history[0];
  return latest && latest.day === state.day - 1 ? latest : null;
}

function cardDataOf(state: PetState, host: string): CardData {
  const collapse = latestCollapse(state);
  return {
    day: state.day,
    form: state.form,
    character: state.character,
    ability: state.ability,
    palette: state.palette,
    glow: paletteOf(state.palette).glow,
    bits: collapse?.bits ?? null,
    measuring:
      !collapse && state.qpu?.pending && state.qpu.pending.day === state.day - 1 ? (state.qpu.pending.backend ?? "IBM Quantum") : null,
    actions: state.actionsToday,
    top: state.top,
    dayStartedAt: state.dayStartedAt,
    host,
  };
}

interface PetShareCardProps {
  state: PetState;
  className?: string;
}

export default function PetShareCard({ state, className = "" }: PetShareCardProps) {
  const preview = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** the day whose card the Worker accepted */
  const [stored, setStored] = useState<number | null>(null);
  const uploadedDay = useRef<number | null>(null);
  const copyTimer = useRef<number | null>(null);

  const collapse = latestCollapse(state);
  const { day } = state;

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  // The preview follows the state: the odds move with every gate.
  useEffect(() => {
    const canvas = preview.current;
    if (!canvas) return;
    let cancelled = false;
    const data = cardDataOf(state, hostOf(siteOrigin()));
    const run = () => {
      if (!cancelled) void drawPetCard(canvas, data).catch(() => undefined);
    };
    run();
    fontsReady().then(run, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [state]);

  // Once per day per visit: the card, drawn offscreen with the fonts in,
  // goes to the Worker under the day's key. The first visit of the day
  // stores it; a later one replaces it once the Worker's cooldown is over.
  useEffect(() => {
    if (uploadedDay.current === day) return;
    uploadedDay.current = day;
    const data = cardDataOf(state, hostOf(siteOrigin()));
    const run = async () => {
      await fontsReady();
      const canvas = document.createElement("canvas");
      await drawPetCard(canvas, data);
      const ok = await uploadShareCard("pet", String(day), await canvasToBlob(canvas));
      if (ok && uploadedDay.current === day) setStored(day);
    };
    run().catch(() => undefined);
  }, [day, state]);

  /** A short confirmation next to the buttons that clears itself; an error stays until the next try. */
  const flash = (text: string) => {
    setNote(text);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setNote(null), 1600);
  };

  const download = async () => {
    setBusy(true);
    setNote(null);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    try {
      const canvas = document.createElement("canvas");
      await drawPetCard(canvas, cardDataOf(state, hostOf(siteOrigin())));
      downloadBlob(`dirac-pet-day-${pad2(day)}.png`, await canvasToBlob(canvas));
      flash("saved");
    } catch (e: unknown) {
      setNote(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const postText = collapse ? postTextForDay(collapse, siteOrigin()) : null;

  const copyPost = async () => {
    if (postText === null) return;
    try {
      await navigator.clipboard.writeText(postText);
      flash("post copied");
    } catch {
      flash("copy failed");
    }
  };

  const postOnX = () => {
    if (postText === null) return;
    window.open(xIntent(postText), "_blank", "noopener,noreferrer");
  };

  return (
    <div className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Share</span>
        <span className="eyebrow hidden sm:inline">1200 × 630 · drawn in your browser</span>
      </div>
      <canvas
        ref={preview}
        width={CARD_W}
        height={CARD_H}
        role="img"
        aria-label={`Share card: quantum pet day ${day}, a ${state.character} ${state.form} with ${state.ability}, palette ${state.palette}, ${state.actionsToday} gates today`}
        className="mt-4 h-auto w-full rounded-xl border border-line bg-ink"
      />
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void download()} disabled={busy} className="pill disabled:opacity-50">
          {busy ? "Rendering…" : "Download card"}
        </button>
        <button
          type="button"
          onClick={() => void copyPost()}
          disabled={postText === null}
          title={postText === null ? "The post text exists after the first collapse" : "Copy the post for the latest collapse"}
          className="pill pill-ghost disabled:opacity-50"
        >
          Copy post
        </button>
        <button
          type="button"
          onClick={postOnX}
          disabled={postText === null}
          title={postText === null ? "The post text exists after the first collapse" : undefined}
          className="pill pill-ghost disabled:opacity-50"
        >
          Post on X ↗
        </button>
        {note ? <span className="font-mono text-[11px] text-mute">{note}</span> : null}
      </div>
      {stored === day ? <p className="mt-3 font-mono text-[11px] text-mute">preview card stored</p> : null}
      <p className="mt-4 text-xs leading-relaxed text-mute">
        {postText !== null
          ? `The post is the one the registry writes for day ${collapse?.day}: the collapse that made today's body.`
          : state.qpu?.pending && state.qpu.pending.day === day - 1
            ? `Day ${state.qpu.pending.day} is still measuring on quantum hardware; its post exists once the result is in.`
            : "No collapse yet, so there is no post to copy; the first one comes at 00:00 UTC."}
      </p>
    </div>
  );
}

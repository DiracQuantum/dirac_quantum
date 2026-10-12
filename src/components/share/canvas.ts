/**
 * Canvas helpers shared by the passport and pet share cards: the palette of
 * the black editorial cards, the site fonts resolved from the next/font CSS
 * variables, the header with the Dirac mark and the footer. The scan card
 * (src/components/scan/ShareCard.tsx) draws the same chrome with its own
 * code; the values here match it so every card reads as one family.
 *
 * Everything reads the document (fonts, computed styles), so call it from
 * effects and handlers only.
 */

export const CARD_W = 1200;
export const CARD_H = 630;
export const PAD = 72;
export const INK = "#070708";
export const PAPER = "#f2f1ec";
export const PAPER_2 = "#d9d7cf";
export const MUTE = "#8c8c87";
export const SIGNAL = "#4d8bff";
export const LINE = "rgba(242, 241, 236, 0.12)";

export interface CardFonts {
  sans: string;
  mono: string;
  serif: string;
}

/** The family list behind a next/font CSS variable, with a generic fallback. */
export function cssFamily(variable: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  return v ? `${v}, ${fallback}` : fallback;
}

export function cardFonts(): CardFonts {
  return {
    sans: cssFamily("--font-archivo", "sans-serif"),
    mono: cssFamily("--font-plex-mono", "monospace"),
    serif: cssFamily("--font-newsreader", "serif"),
  };
}

/** Asks the browser to load every font spec; a spec that fails to load falls back silently. */
export async function ensureFonts(specs: string[]): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => [])));
}

/** Resolves once the document's fonts are in; never rejects. */
export async function fontsReady(): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  try {
    await document.fonts.ready;
  } catch {
    // nothing to wait for
  }
}

export function setSpacing(ctx: CanvasRenderingContext2D, px: number): void {
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${px}px`;
}

export function setStretch(ctx: CanvasRenderingContext2D, value: CanvasFontStretch): void {
  if ("fontStretch" in ctx) ctx.fontStretch = value;
}

/** The Dirac mark: a chevron, the same path as the Nav mark (64-unit viewBox). */
export function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
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

/** Black background, the mark with DIRAC on the left, the chapter eyebrow on the right, a rule under both. */
export function drawChrome(ctx: CanvasRenderingContext2D, fonts: CardFonts, eyebrow: string): void {
  const right = CARD_W - PAD;
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  drawMark(ctx, PAD - 4, 50, 40);
  ctx.fillStyle = PAPER;
  ctx.font = `800 30px ${fonts.sans}`;
  setStretch(ctx, "semi-condensed");
  setSpacing(ctx, -0.6);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText("DIRAC", PAD + 44, 82);

  ctx.font = `500 20px ${fonts.mono}`;
  setStretch(ctx, "normal");
  setSpacing(ctx, 3);
  ctx.fillStyle = MUTE;
  ctx.textAlign = "right";
  ctx.fillText(eyebrow, right, 80);

  ctx.fillStyle = LINE;
  ctx.fillRect(PAD, 112, right - PAD, 1);
  ctx.textAlign = "left";
  setSpacing(ctx, 0);
}

/** A mono label in the card's small caps style. */
export function drawLabel(ctx: CanvasRenderingContext2D, fonts: CardFonts, text: string, x: number, y: number): void {
  ctx.fillStyle = MUTE;
  ctx.font = `500 20px ${fonts.mono}`;
  setStretch(ctx, "normal");
  setSpacing(ctx, 3);
  ctx.textAlign = "left";
  ctx.fillText(text, x, y);
  setSpacing(ctx, 0);
}

/**
 * Big condensed sans, shrunk until `text` fits `maxWidth`. Returns the size
 * used so the caller can place what follows.
 */
export function drawHeadline(
  ctx: CanvasRenderingContext2D,
  fonts: CardFonts,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  startPx: number,
  color = PAPER,
): number {
  const font = (px: number) => `800 ${px}px ${fonts.sans}`;
  ctx.fillStyle = color;
  setStretch(ctx, "semi-condensed");
  let size = startPx;
  ctx.font = font(size);
  setSpacing(ctx, -Math.round(size * 0.04));
  const width = ctx.measureText(text).width;
  if (width > maxWidth) {
    size = Math.floor((size * maxWidth) / width);
    ctx.font = font(size);
    setSpacing(ctx, -Math.round(size * 0.04));
  }
  ctx.textAlign = "left";
  ctx.fillText(text, x, y);
  setStretch(ctx, "normal");
  setSpacing(ctx, 0);
  return size;
}

/** Wallet or key on the left in mono, date and host on the right in small mute mono. */
export function drawFooter(ctx: CanvasRenderingContext2D, fonts: CardFonts, left: string, right: string): void {
  setStretch(ctx, "normal");
  setSpacing(ctx, 0);
  ctx.fillStyle = PAPER;
  ctx.font = `500 34px ${fonts.mono}`;
  ctx.textAlign = "left";
  ctx.fillText(left, PAD, 582);

  ctx.fillStyle = MUTE;
  ctx.font = `400 22px ${fonts.mono}`;
  ctx.textAlign = "right";
  ctx.fillText(right, CARD_W - PAD, 582);
  ctx.textAlign = "left";
}

/** "2026-10-10" in UTC from unix ms. */
export function utcDate(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

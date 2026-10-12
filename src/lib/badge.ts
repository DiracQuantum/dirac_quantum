/**
 * Embeddable passport badge: one SVG per wallet, rendered by the Worker
 * (worker/badge.ts, GET /api/badge/<wallet>.svg) from the registry row and
 * embedded anywhere with an <img>. The Worker, the Badge panel on /p and
 * scripts/badge-selftest.ts share this module, so they agree on the URL, the
 * query and the drawing (docs/CONTRACT-BADGE.md).
 *
 * The drawing is a chip in the site's language: ink (or paper) ground, a
 * hairline border, the Dirac mark, monospace uppercase words split by
 * hairlines. No web fonts: the text asks for the system monospace stack and
 * every word carries `textLength`, so the layout holds in any monospace face.
 * No scripts, no styles, no links, no external references; every piece of
 * text is escaped.
 *
 * Pure module: strings in, strings out. No React, no DOM, no fetch; the only
 * import is the base58 decoder for the wallet check.
 */

import { base58 } from "@scure/base";

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export const BADGE_SIZES = ["s", "m"] as const;
export type BadgeSize = (typeof BADGE_SIZES)[number];

export const BADGE_THEMES = ["dark", "light"] as const;
export type BadgeTheme = (typeof BADGE_THEMES)[number];

export const DEFAULT_BADGE_SIZE: BadgeSize = "m";
export const DEFAULT_BADGE_THEME: BadgeTheme = "dark";

export interface BadgeOptions {
  size: BadgeSize;
  theme: BadgeTheme;
}

/** The signature scheme a passport badge names. */
export const BADGE_SCHEME = "ML-DSA-65";
/** Browser and proxy cache lifetime of a badge, in seconds. */
export const BADGE_MAX_AGE_SECONDS = 600;
/** Alt text of the embed snippets: it does not name the state, which changes when the passport is anchored. */
export const BADGE_ALT = "Dirac post-quantum passport";

/** `?size=`: "s" or "m"; anything else is the default, a badge never fails on its query. */
export function parseBadgeSize(value: string | null | undefined): BadgeSize {
  return value === "s" || value === "m" ? value : DEFAULT_BADGE_SIZE;
}

/** `?theme=`: "dark" or "light"; anything else is the default. */
export function parseBadgeTheme(value: string | null | undefined): BadgeTheme {
  return value === "dark" || value === "light" ? value : DEFAULT_BADGE_THEME;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export type BadgeMode = "simple" | "hardened";

export type BadgeState =
  /** a registered passport; `mode` is null when the stored value is not one the badge knows */
  | { status: "ready"; mode: BadgeMode | null; anchored: boolean }
  /** a valid wallet without a passport */
  | { status: "none" }
  /** the path does not carry a Solana address */
  | { status: "invalid" }
  /** the registry could not be read */
  | { status: "unavailable" };

/** The columns of `passports` the badge reads. */
export interface BadgeRow {
  mode: string;
  anchor_tx: string | null;
}

export function stateFromRow(row: BadgeRow | null): BadgeState {
  if (row === null) return { status: "none" };
  const mode = row.mode === "simple" || row.mode === "hardened" ? row.mode : null;
  return { status: "ready", mode, anchored: typeof row.anchor_tx === "string" && row.anchor_tx.length > 0 };
}

const ED25519_PK_LEN = 32;

/** A Solana wallet address: 32 to 44 base58 characters decoding to exactly 32 bytes. */
export function isBadgeWallet(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    return base58.decode(value).length === ED25519_PK_LEN;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/** Text safe as XML character data and inside a double- or single-quoted attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `7xKq…9AsU` */
const shorten = (value: string): string => (value.length <= 9 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`);

type Lead = "mark" | "signal" | "mute" | null;

export interface Segment {
  /** what stands before the word: the Dirac mark, a status dot, or nothing */
  lead: Lead;
  text: string;
  tone: "fg" | "mute";
  weight: 400 | 600;
}

/** The words of a badge, left to right. */
export function badgeSegments(state: BadgeState): Segment[] {
  const brand: Segment = { lead: "mark", text: "DIRAC", tone: "fg", weight: 400 };
  switch (state.status) {
    case "ready": {
      const detail = [state.mode?.toUpperCase(), state.anchored ? "ANCHORED" : undefined].filter(
        (part): part is string => part !== undefined,
      );
      const segments: Segment[] = [brand, { lead: "signal", text: "Q-READY", tone: "fg", weight: 600 }];
      if (detail.length > 0) segments.push({ lead: null, text: detail.join(" · "), tone: "fg", weight: 400 });
      segments.push({ lead: null, text: BADGE_SCHEME, tone: "mute", weight: 400 });
      return segments;
    }
    case "none":
      return [brand, { lead: "mute", text: "NO PASSPORT", tone: "fg", weight: 600 }];
    case "invalid":
      return [brand, { lead: "mute", text: "INVALID ADDRESS", tone: "fg", weight: 600 }];
    case "unavailable":
      return [brand, { lead: "mute", text: "UNAVAILABLE", tone: "fg", weight: 600 }];
  }
}

/** The badge in one sentence, for its <title>, aria-label and the JSON route. */
export function badgeSummary(state: BadgeState, wallet?: string): string {
  const of = wallet ? ` of ${shorten(wallet)}` : "";
  switch (state.status) {
    case "ready": {
      const parts = ["Q-ready"];
      if (state.mode) parts.push(state.mode);
      parts.push(state.anchored ? "anchored on Solana" : "not anchored yet", BADGE_SCHEME);
      return `Dirac passport${of}: ${parts.join(", ")}`;
    }
    case "none":
      return `Dirac: no passport registered${wallet ? ` for ${shorten(wallet)}` : ""}`;
    case "invalid":
      return "Dirac: not a Solana address";
    case "unavailable":
      return "Dirac: registry unavailable, try again later";
  }
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

interface Metrics {
  height: number;
  /** font size, px */
  font: number;
  /** space between glyphs, px */
  tracking: number;
  /** padding at the rounded ends */
  outer: number;
  /** padding on either side of a divider */
  pad: number;
  /** height of the mark's ink */
  ink: number;
  /** between the mark or the dot and its word */
  gap: number;
  /** status dot radius */
  dot: number;
}

const METRICS: Record<BadgeSize, Metrics> = {
  s: { height: 20, font: 9, tracking: 0.45, outer: 9, pad: 7, ink: 9, gap: 5, dot: 2.25 },
  m: { height: 28, font: 11, tracking: 0.9, outer: 13, pad: 10, ink: 12, gap: 7, dot: 2.75 },
};

/** Advance of one glyph in em: 0.6 for Menlo, SF Mono, DejaVu Sans Mono, Courier; Consolas is 0.55 and gets stretched by textLength. */
const MONO_ADVANCE = 0.6;
/** Half the cap height of the usual monospace faces, in em: the baseline that centres uppercase words. */
const HALF_CAP = 0.35;

const FONT_STACK = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";

interface Palette {
  bg: string;
  fg: string;
  mute: string;
  line: string;
  lineOpacity: number;
  signal: string;
}

/** The site's tokens (globals.css): ink #070708, paper #f2f1ec, mute #8c8c87, signal #4d8bff. */
const PALETTES: Record<BadgeTheme, Palette> = {
  dark: { bg: "#070708", fg: "#f2f1ec", mute: "#8c8c87", line: "#f2f1ec", lineOpacity: 0.16, signal: "#4d8bff" },
  // mute darkened on paper: #8c8c87 reads at 3:1 there, #5f5f5a at 6:1
  light: { bg: "#f2f1ec", fg: "#070708", mute: "#5f5f5a", line: "#070708", lineOpacity: 0.16, signal: "#4d8bff" },
};

/** Two decimals at most, no trailing zeros. */
const n = (value: number): string => String(Math.round(value * 100) / 100);

/** Width of a word set in the monospace stack with the size's tracking. */
function textWidth(text: string, m: Metrics): number {
  return text.length * MONO_ADVANCE * m.font + Math.max(0, text.length - 1) * m.tracking;
}

export interface RenderedBadge {
  svg: string;
  width: number;
  height: number;
}

/**
 * The badge as a standalone SVG document. `wallet` only goes into the
 * <title> (shortened); pass it for a valid address and leave it out
 * otherwise, so nothing from the request is echoed.
 */
export function renderBadge(state: BadgeState, options: BadgeOptions, wallet?: string): RenderedBadge {
  const m = METRICS[options.size];
  const p = PALETTES[options.theme];
  const h = m.height;
  const cy = h / 2;
  const baseline = cy + HALF_CAP * m.font;
  /** the mark's path is drawn on a 64-unit square whose ink spans 32 × 48 units */
  const k = m.ink / 48;
  const markWidth = 32 * k;

  const shapes: string[] = [];
  const words: string[] = [];
  const dividers: number[] = [];
  const segments = badgeSegments(state);
  let x = 0;

  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    let cursor = x + (i === 0 ? m.outer : m.pad);
    if (segment.lead === "mark") {
      // Nav's Mark, "M20 12 L44 32 L20 52" with an 8-unit round stroke, scaled into the badge.
      shapes.push(
        `<path d="M${n(cursor + 4 * k)} ${n(cy - 20 * k)}L${n(cursor + 28 * k)} ${n(cy)}L${n(cursor + 4 * k)} ${n(cy + 20 * k)}" fill="none" stroke="${p.fg}" stroke-width="${n(8 * k)}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
      cursor += markWidth + m.gap;
    } else if (segment.lead !== null) {
      shapes.push(`<circle cx="${n(cursor + m.dot)}" cy="${n(cy)}" r="${n(m.dot)}" fill="${segment.lead === "signal" ? p.signal : p.mute}"/>`);
      cursor += 2 * m.dot + m.gap;
    }
    const width = textWidth(segment.text, m);
    words.push(
      `<text x="${n(cursor + width / 2)}" y="${n(baseline)}" textLength="${n(width)}" lengthAdjust="spacing" fill="${segment.tone === "mute" ? p.mute : p.fg}"${
        segment.weight === 600 ? ' font-weight="600"' : ""
      }>${escapeXml(segment.text)}</text>`,
    );
    x = cursor + width + (last ? m.outer : m.pad);
    if (!last) dividers.push(x);
  });

  const width = Math.ceil(x);
  const summary = escapeXml(badgeSummary(state, wallet));
  const lines = dividers
    .map((d) => `<path d="M${n(Math.round(d) + 0.5)} 1V${n(h - 1)}" stroke="${p.line}" stroke-opacity="${p.lineOpacity}"/>`)
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" role="img" aria-label="${summary}">` +
    `<title>${summary}</title>` +
    `<rect x="0.5" y="0.5" width="${n(width - 1)}" height="${n(h - 1)}" rx="${n((h - 1) / 2)}" fill="${p.bg}" stroke="${p.line}" stroke-opacity="${p.lineOpacity}"/>` +
    lines +
    shapes.join("") +
    `<g font-family="${FONT_STACK}" font-size="${m.font}" text-anchor="middle">${words.join("")}</g>` +
    `</svg>`;
  return { svg, width, height: h };
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

/** `/api/badge/<wallet>.svg`, with only the non-default options in the query so the common URL stays short. */
export function badgePath(wallet: string, options: Partial<BadgeOptions> = {}, format: "svg" | "json" = "svg"): string {
  const query: string[] = [];
  if (options.size && options.size !== DEFAULT_BADGE_SIZE) query.push(`size=${options.size}`);
  if (options.theme && options.theme !== DEFAULT_BADGE_THEME) query.push(`theme=${options.theme}`);
  return `/api/badge/${encodeURIComponent(wallet)}.${format}${query.length > 0 ? `?${query.join("&")}` : ""}`;
}

/** `/p?a=<wallet>`: where an embedded badge links to. */
export const passportPagePath = (wallet: string): string => `/p?a=${encodeURIComponent(wallet)}`;

export interface BadgeSnippets {
  /** the badge image, absolute */
  url: string;
  /** the passport page the badge links to, absolute */
  page: string;
  /** `<a href="page"><img src="url" alt height></a>` */
  html: string;
  /** `[![alt](url)](page)` */
  markdown: string;
}

/**
 * Copy-ready embeds. `api` is the origin serving /api/badge (the site itself
 * in production), `site` the origin of the passport page.
 */
export function badgeSnippets(wallet: string, options: BadgeOptions, origins: { api: string; site: string }): BadgeSnippets {
  const trim = (origin: string) => origin.replace(/\/+$/, "");
  const url = `${trim(origins.api)}${badgePath(wallet, options)}`;
  const page = `${trim(origins.site)}${passportPagePath(wallet)}`;
  return {
    url,
    page,
    html: `<a href="${escapeXml(page)}"><img src="${escapeXml(url)}" alt="${BADGE_ALT}" height="${METRICS[options.size].height}"></a>`,
    markdown: `[![${BADGE_ALT}](${url})](${page})`,
  };
}

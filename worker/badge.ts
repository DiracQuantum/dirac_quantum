/**
 * Embeddable passport badge (docs/CONTRACT-BADGE.md): an SVG chip that says
 * whether a wallet carries a Dirac passport, for READMEs, profiles and sites.
 *
 * Routes (mounted by worker/index.ts through `handleBadge`):
 *   GET|HEAD /api/badge/:wallet.svg[?size=s|m&theme=dark|light]
 *   GET|HEAD /api/badge/:wallet.json
 *
 * The SVG never fails an embedding page: a valid wallet without a passport
 * gets the "NO PASSPORT" badge, a path that is not a Solana address the
 * "INVALID ADDRESS" one, a D1 failure "UNAVAILABLE" (cached one minute), all
 * with 200. An unknown `size` or `theme` falls back to m / dark. The JSON
 * route is for programs and answers errors the API way: 400 for a bad wallet,
 * 503 when D1 fails.
 *
 * Both read one row by primary key (`passports`: mode, anchor_tx,
 * anchor_verified, hash, registered_at). ANCHORED, `anchored` and `anchor_tx`
 * mean an anchor the registry verified on chain (anchor_verified = 1,
 * migrations/0013); an unverified one is not shown at all, and on a database
 * without that column the read falls back to the older one and treats every
 * anchor as unverified. Both are public for ten minutes with a strong ETag over the
 * body; If-None-Match answers 304. No rate limit, like the other read routes
 * (GET /api/passports/:wallet, GET /api/share/...): a badge is fetched by
 * image proxies that share one address across many pages (GitHub's camo), a
 * 429 would break the image, and a limiter costs a D1 write per request where
 * the badge itself costs one read.
 *
 * The drawing and the URL shapes live in src/lib/badge.ts, shared with the
 * /p page. The document carries no script, style, link or external
 * reference; the response adds `Content-Security-Policy: default-src 'none';
 * sandbox` for anyone opening it directly.
 */

import {
  BADGE_MAX_AGE_SECONDS,
  BADGE_SCHEME,
  badgePath,
  badgeSegments,
  badgeSummary,
  isBadgeWallet,
  parseBadgeSize,
  parseBadgeTheme,
  passportPagePath,
  renderBadge,
  stateFromRow,
  type BadgeState,
} from "../src/lib/badge";
import { etagMatches } from "./share";

export interface Env {
  DB: D1Database;
  /** Public origin of the site, for the absolute links in the JSON (default: the request origin). */
  SITE_URL?: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PUBLIC_CACHE = `public, max-age=${BADGE_MAX_AGE_SECONDS}`;
/** A badge drawn while D1 failed: short-lived, so the real one comes back soon. */
const UNAVAILABLE_CACHE = "public, max-age=60";
const DEFAULT_SITE_URL = "https://dirac.digital";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** One primary-key read: what the badge shows and what the JSON adds. */
const SQL_BADGE = `SELECT mode, anchor_tx, anchor_verified, hash, registered_at FROM passports WHERE wallet = ?1`;
/** The same read on a registry without migrations/0013 (no anchor_verified): no anchor there counts as verified. */
const SQL_BADGE_LEGACY = `SELECT mode, anchor_tx, hash, registered_at FROM passports WHERE wallet = ?1`;

interface BadgeDbRow {
  mode: string;
  anchor_tx: string | null;
  /** 1 once the Worker found the anchor on chain (migrations/0013); absent on an older schema */
  anchor_verified?: number | null;
  hash: string;
  registered_at: number;
}

/** The anchor transaction when the registry verified it on chain, else null: ANCHORED means a verified anchor. */
function verifiedAnchor(row: BadgeDbRow | null): string | null {
  if (row === null || row.anchor_verified !== 1) return null;
  return typeof row.anchor_tx === "string" && row.anchor_tx.length > 0 ? row.anchor_tx : null;
}

/** What the badge draws for a row: the mode, and ANCHORED only for a verified anchor. */
const badgeState = (row: BadgeDbRow | null): BadgeState =>
  stateFromRow(row === null ? null : { mode: row.mode, anchor_tx: verifiedAnchor(row) });

const isMissingColumn = (error: unknown): boolean => /no such column/i.test(error instanceof Error ? error.message : String(error));

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

const badRequest = (error: string): Response => json({ error }, 400);
const notFound = (): Response => json({ error: "not found: expected /api/badge/<wallet>.svg or /api/badge/<wallet>.json" }, 404);
const methodNotAllowed = (): Response => json({ error: "method not allowed" }, 405, { Allow: "GET, HEAD, OPTIONS" });

/** The public origin without a trailing slash: SITE_URL when set, otherwise the request's origin. */
function siteOrigin(env: Env, url: URL): string {
  const configured = (env.SITE_URL ?? "").trim().replace(/\/+$/, "");
  return configured || url.origin || DEFAULT_SITE_URL;
}

/** A strong validator over the exact body: any change to the drawing or the record changes it. */
export async function etagOf(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  let hex = "";
  for (const byte of digest.subarray(0, 12)) hex += byte.toString(16).padStart(2, "0");
  return `"${hex}"`;
}

/**
 * 200 with the body, 304 when If-None-Match names its ETag, headers only for
 * HEAD. `headers` carries the type and the cache policy.
 */
async function cacheable(request: Request, body: string, headers: Record<string, string>): Promise<Response> {
  const etag = await etagOf(body);
  const all: Record<string, string> = { ...headers, ETag: etag };
  if (etagMatches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: all });
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: { ...all, "Content-Length": String(new TextEncoder().encode(body).byteLength) } });
  }
  return new Response(body, { status: 200, headers: all });
}

type Lookup = { ok: true; row: BadgeDbRow | null } | { ok: false };

async function lookup(env: Env, wallet: string): Promise<Lookup> {
  try {
    return { ok: true, row: await env.DB.prepare(SQL_BADGE).bind(wallet).first<BadgeDbRow>() };
  } catch (error) {
    if (isMissingColumn(error)) {
      // The registry predates anchor verification: read without the column, every anchor unverified.
      try {
        const row = await env.DB.prepare(SQL_BADGE_LEGACY).bind(wallet).first<BadgeDbRow>();
        return { ok: true, row: row === null ? null : { ...row, anchor_verified: 0 } };
      } catch (legacyError) {
        console.warn("badge: registry read failed", legacyError);
        return { ok: false };
      }
    }
    console.warn("badge: registry read failed", error);
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function serveSvg(request: Request, env: Env, wallet: string | null, url: URL): Promise<Response> {
  const options = {
    size: parseBadgeSize(url.searchParams.get("size")),
    theme: parseBadgeTheme(url.searchParams.get("theme")),
  };
  const valid = wallet !== null && isBadgeWallet(wallet);
  let state: BadgeState = { status: "invalid" };
  let cache = PUBLIC_CACHE;
  if (valid) {
    const found = await lookup(env, wallet);
    if (found.ok) {
      state = badgeState(found.row);
    } else {
      state = { status: "unavailable" };
      cache = UNAVAILABLE_CACHE;
    }
  }
  const { svg } = renderBadge(state, options, valid ? wallet : undefined);
  return cacheable(request, svg, {
    ...CORS_HEADERS,
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Disposition": `inline; filename="dirac-badge${valid ? `-${wallet.slice(0, 8)}` : ""}.svg"`,
  });
}

async function serveJson(request: Request, env: Env, wallet: string | null, url: URL): Promise<Response> {
  if (wallet === null || !isBadgeWallet(wallet)) return badRequest("wallet must be a base58 Solana address (32 bytes)");
  const found = await lookup(env, wallet);
  if (!found.ok) return json({ error: "registry unavailable, try again later" }, 503, { "Retry-After": "60" });
  const { row } = found;
  const state = badgeState(row);
  const site = siteOrigin(env, url);
  const ready = state.status === "ready";
  const body = JSON.stringify({
    wallet,
    status: ready ? "ready" : "none",
    /** the words on the badge, left to right after DIRAC */
    text: badgeSegments(state)
      .slice(1)
      .map((segment) => segment.text)
      .join(" · "),
    summary: badgeSummary(state, wallet),
    mode: ready ? state.mode : null,
    anchored: ready ? state.anchored : false,
    anchor_tx: verifiedAnchor(row),
    scheme: ready ? BADGE_SCHEME : null,
    hash: row?.hash ?? null,
    registered_at: row?.registered_at ?? null,
    page: `${site}${passportPagePath(wallet)}`,
    badge: `${site}${badgePath(wallet)}`,
  });
  return cacheable(request, body, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": PUBLIC_CACHE,
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * Serves GET and HEAD /api/badge/<wallet>.svg and .json (and the OPTIONS
 * preflight if it ever gets here); null for any path outside /api/badge.
 * `parts` is `url.pathname.split("/").filter(Boolean)`. Catches its own
 * errors: the SVG route still answers a badge.
 */
export async function handleBadge(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  parts: string[],
  url: URL,
): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "badge") return null;
  if (parts.length !== 3) return notFound();
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed();

  const segment = parts[2];
  const dot = segment.lastIndexOf(".");
  const format = dot < 0 ? "" : segment.slice(dot + 1);
  if (format !== "svg" && format !== "json") return notFound();
  // base58 never needs percent-encoding; a segment that does not decode is simply not a wallet.
  let wallet: string | null;
  try {
    wallet = decodeURIComponent(segment.slice(0, dot));
  } catch {
    wallet = null;
  }

  try {
    return format === "svg" ? await serveSvg(request, env, wallet, url) : await serveJson(request, env, wallet, url);
  } catch (error) {
    console.error("badge api error", method, url.pathname, error);
    if (format === "json") return json({ error: "internal error" }, 500);
    const { svg } = renderBadge({ status: "unavailable" }, { size: parseBadgeSize(url.searchParams.get("size")), theme: parseBadgeTheme(url.searchParams.get("theme")) });
    return new Response(request.method === "HEAD" ? null : svg, {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  }
}

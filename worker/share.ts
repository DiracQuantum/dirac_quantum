/**
 * Share cards: 1200×630 PNGs drawn in the browser, stored in D1 and served
 * back as the og:image of the page they belong to. The static export emits
 * the same HTML for every query, so the Worker rewrites the head of /scan,
 * /p and /pet per target; nothing is rendered on the server.
 *
 * Routes (mounted by worker/index.ts through `handleShare`):
 *   PUT /api/share/scan/:wallet         body: the PNG (Content-Type image/png, ≤ 160 KB, exactly 1200×630)
 *   PUT /api/share/passport/:wallet
 *   PUT /api/share/pet/:day
 *   GET /api/share/scan/:wallet.png     the stored PNG, public for an hour, with an ETag; 404 when missing
 *   GET /api/share/passport/:wallet.png (HEAD answers the same headers without a body)
 *   GET /api/share/pet/:day.png
 *
 * `rewriteHtml` is called by `serveAsset` for HTML responses. For
 * /scan?a=<wallet>, /p?a=<wallet> and /pet it sets og:title, og:description,
 * og:url, twitter:card and friends, and points og:image / twitter:image at
 * the stored card when one exists (one D1 lookup). Without a stored card the
 * image tags Next emitted stay as they are. Any other path, an invalid
 * wallet or a D1 failure leaves the response untouched: the page must never
 * break because of a preview.
 *
 * Who may store a card. Uploads come from the site's own pages only: the
 * request's Origin (or, without one, Sec-Fetch-Site) must be this site, and
 * the CORS preflight does not offer PUT, so another page cannot upload from a
 * browser. Each key is bound to a record it describes:
 *   - pet:<day> is accepted for the current `pet_state.day` only;
 *   - passport cards need a registered passport and are stored under
 *     passport:<wallet>:<hash>:<a|u> (the passport hash and whether it is
 *     anchored), so a replaced passport gets a fresh card. The first card per
 *     registered passport wins; only the wallet can replace it, with the
 *     `X-Share-Sig` header: an Ed25519 signature (base64 or base58) over
 *     `share:passport:<wallet>:<sha256 hex of the png>` (SHARE_MESSAGE);
 *   - scan:<wallet> is accepted while a complete report for the wallet sits
 *     in the edge cache (worker/index.ts getScan, 60 s), i.e. right after a
 *     scan. A scan card has no owner, so whoever scans a wallet can store its
 *     card: scan cards are forgeable by design and the figures on them are
 *     only as trustworthy as the link's sender.
 * A stored card is not replaced for ten minutes (429 with Retry-After), so a
 * link that is being shared keeps its preview; a wallet-signed passport
 * upload is exempt. Uploads are rate limited to 6 per minute per client
 * (IPv4 address or IPv6 /64) through the shared D1 `ratelimit` table, and
 * the PNG is decoded far enough to know it renders: chunk walk with CRCs,
 * 8-bit RGB/RGBA IHDR, IDAT inflating to exactly the image's scanlines, IEND
 * closing the body. Rows older than 14 days are pruned on upload (cards of
 * live passports stay), and the table is capped at MAX_SHARE_ROWS (507).
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";

export interface Env {
  DB: D1Database;
  /** Public origin of the site, for absolute og:image and og:url values (default: the request origin). */
  SITE_URL?: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
/** Largest PNG accepted; a real card measures 85..100 KB. */
export const MAX_PNG_BYTES = 160 * 1024;
const IMAGE_MAX_AGE_SECONDS = 3600;
const SHARE_LIMIT = { bucket: "share", limit: 6, periodMs: 60_000 };
/** A stored card keeps its place this long before an unsigned upload may replace it. */
const REPLACE_COOLDOWN_MS = 10 * 60_000;
/** Rows older than this are pruned on upload, except cards of live passports. */
const RETENTION_MS = 14 * 24 * 60 * 60_000;
/** Hard cap on share_images rows (× MAX_PNG_BYTES bounds the table at ~640 MB). */
const MAX_SHARE_ROWS = 4000;
/**
 * No 1200×630 PNG is smaller: deflate shrinks at most ~1032:1, and a flat RGB
 * card's scanlines are 2.27 MB, so the IDAT alone is over 2 KB. Rows below it
 * are stale probes from before the decoder check and are pruned.
 */
const MIN_CARD_BYTES = 2048;
const ED25519_PK_LEN = 32;
const ED25519_SIG_LEN = 64;
/** pet days are small positive integers. */
const DAY_PATTERN = /^[1-9]\d{0,8}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** signature (8) + IHDR chunk (25) + IEND chunk (12); IDAT comes on top. */
const PNG_MIN_BYTES = 8 + 25 + 12;
const DEFAULT_SITE_URL = "https://dirac.digital";
/** The wallet's signature over SHARE_MESSAGE, when it replaces its passport card. */
const SHARE_SIG_HEADER = "X-Share-Sig";

const KINDS = ["scan", "passport", "pet"] as const;
export type ShareKind = (typeof KINDS)[number];

// PUT is same-origin only and never preflighted from the site's own pages, so
// the preflight offers the read methods only (worker/index.ts hands the
// OPTIONS for /api/share here).
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** Message a passport's wallet signs to replace its stored card (mirrored in src/lib/share.ts). */
export const SHARE_MESSAGE = (wallet: string, pngSha256Hex: string): string => `share:passport:${wallet}:${pngSha256Hex}`;

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

/** A passport's card key, from the passports row aliased `p`; `passportKey` is the same in TS. */
const SQL_PASSPORT_KEY = `'passport:' || p.wallet || ':' || p.hash || ':' || CASE WHEN p.anchor_tx IS NULL THEN 'u' ELSE 'a' END`;

const SQL_PUT_IMAGE = `
INSERT OR REPLACE INTO share_images (key, png, bytes, created_at)
VALUES (?1, ?2, ?3, ?4)`;

/** First card wins: no row is touched when one exists (meta.changes = 0). */
const SQL_PUT_IMAGE_ONCE = `
INSERT OR IGNORE INTO share_images (key, png, bytes, created_at)
VALUES (?1, ?2, ?3, ?4)`;

const SQL_GET_IMAGE = `SELECT png, bytes, created_at FROM share_images WHERE key = ?1`;

/** The cheap existence check for the rewriter and HEAD: no blob is read. */
const SQL_HAS_IMAGE = `SELECT bytes, created_at FROM share_images WHERE key = ?1`;

/** A passport's current card, through the registered passport: no passport, no card. */
const SQL_GET_PASSPORT_IMAGE = `
SELECT i.png, i.bytes, i.created_at
FROM passports p JOIN share_images i ON i.key = ${SQL_PASSPORT_KEY}
WHERE p.wallet = ?1`;

const SQL_HAS_PASSPORT_IMAGE = `
SELECT i.bytes, i.created_at
FROM passports p JOIN share_images i ON i.key = ${SQL_PASSPORT_KEY}
WHERE p.wallet = ?1`;

/** What binds a passport card: the hash and the anchor state of the registered passport. */
const SQL_PASSPORT_BINDING = `SELECT hash, anchor_tx FROM passports WHERE wallet = ?1`;

/** The passport page's target in one read: the summary and whether its current card is stored. */
const SQL_PASSPORT_META = `
SELECT p.mode, p.anchor_tx, i.bytes, i.created_at
FROM passports p LEFT JOIN share_images i ON i.key = ${SQL_PASSPORT_KEY}
WHERE p.wallet = ?1`;

const SQL_PET_DAY = `SELECT day FROM pet_state WHERE id = 1`;

/**
 * The pet page's target in one read: the current day from pet_state, today's
 * body (the latest collapse before it) and whether a card is stored for the
 * day. No row when the pet was never initialised.
 */
const SQL_PET_TARGET = `
SELECT s.day AS day, d.form AS form, d.character AS character, d.ability AS ability, d.palette AS palette,
       i.bytes AS bytes, i.created_at AS created_at
FROM pet_state s
LEFT JOIN pet_days d ON d.day = (SELECT MAX(day) FROM pet_days WHERE day < s.day)
LEFT JOIN share_images i ON i.key = 'pet:' || s.day
WHERE s.id = 1`;

/**
 * Retention: everything older than ?1 goes, except the card of a live
 * passport; a row under MIN_CARD_BYTES goes regardless (stored before the
 * PNG was decoded: nothing that small renders at 1200×630).
 */
const SQL_PRUNE = `
DELETE FROM share_images
WHERE bytes < ?2
   OR (created_at < ?1 AND key NOT IN (SELECT ${SQL_PASSPORT_KEY} FROM passports p))`;

const SQL_COUNT = `SELECT COUNT(*) AS n FROM share_images`;

/** Shared fixed-window counter (docs/CONTRACT-WEEK2.md). */
const SQL_RATE_LIMIT = `
INSERT INTO ratelimit (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN ratelimit.window_start = excluded.window_start THEN ratelimit.count + 1 ELSE 1 END,
  window_start = excluded.window_start
RETURNING count`;

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface ImageRow {
  /** D1 returns BLOB columns as ArrayBuffer; older runtimes sent number[]. */
  png: ArrayBuffer | number[];
  bytes: number;
  created_at: number;
}

interface ImageStampRow {
  bytes: number;
  created_at: number;
}

interface PassportBindingRow {
  hash: string;
  anchor_tx: string | null;
}

interface PassportMetaRow {
  mode: string;
  anchor_tx: string | null;
  bytes: number | null;
  created_at: number | null;
}

interface PetTargetRow {
  day: number;
  form: string | null;
  character: string | null;
  ability: string | null;
  palette: string | null;
  bytes: number | null;
  created_at: number | null;
}

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

/** `Retry-After` in whole seconds, at least one. */
const retryAfter = (retryAt: number): Record<string, string> => ({
  "Retry-After": String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))),
});

/**
 * The limiter key for a client: its IPv4 address, or the /64 of its IPv6
 * address, so rotating through one allocation does not multiply the budget.
 * "anon" when the header is missing (local dev).
 */
function limitKey(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip");
  if (ip === null) return "anon";
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const zeros = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array.from({ length: zeros }, () => "0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => (parseInt(group, 16) || 0).toString(16))
    .join(":")}::/64`;
}

/** A Solana wallet address: 32..44 base58 characters decoding to 32 bytes. */
export function isWallet(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  try {
    return base58.decode(value).length === ED25519_PK_LEN;
  } catch {
    return false;
  }
}

export const isDay = (value: string): boolean => DAY_PATTERN.test(value);

const isKind = (value: string): value is ShareKind => (KINDS as readonly string[]).includes(value);

export interface ShareTarget {
  kind: ShareKind;
  /** the wallet, or the day */
  id: string;
}

/** A validated route target, or null when the kind or the id is not acceptable. */
export function parseTarget(kind: string, id: string): ShareTarget | null {
  if (!isKind(kind)) return null;
  if (kind === "pet") return isDay(id) ? { kind, id } : null;
  return isWallet(id) ? { kind, id } : null;
}

/** The share_images key of a scan or pet card. Passport cards use `passportKey`. */
const plainKey = (target: ShareTarget): string => `${target.kind}:${target.id}`;

/** passport:<wallet>:<hash>:<a|u>, the TS twin of SQL_PASSPORT_KEY. */
const passportKey = (wallet: string, hash: string, anchored: boolean): string =>
  `passport:${wallet}:${hash}:${anchored ? "a" : "u"}`;

/** `/api/share/scan/<wallet>.png?v=<created_at>`: the version query makes a replaced card re-fetched by crawlers. */
export function imagePath(target: ShareTarget, createdAt: number): string {
  return `/api/share/${target.kind}/${encodeURIComponent(target.id)}.png?v=${createdAt.toString(36)}`;
}

function toBytes(png: ArrayBuffer | number[]): Uint8Array {
  return Array.isArray(png) ? Uint8Array.from(png) : new Uint8Array(png);
}

/** `7xKq…9AsU` */
const shorten = (value: string): string => (value.length <= 9 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`);

/** Text safe inside a double-quoted HTML attribute. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The public origin without a trailing slash: SITE_URL when set, otherwise the request's origin. */
function siteOrigin(env: Env, url: URL): string {
  const configured = (env.SITE_URL ?? "").trim().replace(/\/+$/, "");
  return configured || url.origin || DEFAULT_SITE_URL;
}

/**
 * True when the request comes from one of this site's own pages: its Origin
 * is the site (or the origin it was requested on), or, for a client that
 * sends no Origin, Sec-Fetch-Site says same-origin. Anything else, including
 * a request with neither header, is refused.
 */
function isSameSite(request: Request, site: string, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === site || origin === url.origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** True when `If-None-Match` names `etag`, weak or strong, alone or in a list. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((part) => {
    const candidate = part.trim();
    return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
  });
}

type Body = { ok: true; value: Uint8Array } | { ok: false; status: number; error: string };

/** Reads the raw body without ever buffering more than MAX_PNG_BYTES. */
async function readBytes(request: Request): Promise<Body> {
  const tooLarge: Body = { ok: false, status: 413, error: `png exceeds ${MAX_PNG_BYTES} bytes` };
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_PNG_BYTES) return tooLarge;

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PNG_BYTES) {
        await reader.cancel();
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  if (total === 0) return { ok: false, status: 400, error: "empty body" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (PNG) of bytes[start, end). */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngImage {
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA */
  channels: number;
  /** the IDAT payloads in order: one zlib stream */
  idat: Uint8Array[];
}

type PngParse = { ok: true; value: PngImage } | { ok: false; error: string };

/**
 * Walks the PNG: signature, IHDR first (8-bit RGB or RGBA, no interlace),
 * every chunk's length within the body and its CRC right, at least one IDAT,
 * IEND as the last chunk ending exactly at the end of the body. Anything a
 * decoder would refuse is refused here, with the reason.
 */
export function parsePng(bytes: Uint8Array): PngParse {
  const fail = (error: string): PngParse => ({ ok: false, error });
  if (bytes.length < PNG_MIN_BYTES) return fail("too short to be a PNG");
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return fail("missing PNG signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: Omit<PngImage, "idat"> | null = null;
  const idat: Uint8Array[] = [];
  let offset = PNG_MAGIC.length;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return fail("truncated chunk");
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return fail("chunk length exceeds the body");
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail("invalid chunk type");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (crc32(bytes, offset + 4, dataEnd) !== view.getUint32(dataEnd)) return fail(`bad CRC in ${type}`);

    if (header === null) {
      if (type !== "IHDR" || length !== 13) return fail("first chunk is not IHDR");
      const colour = bytes[dataStart + 9];
      if (bytes[dataStart + 8] !== 8) return fail("bit depth must be 8");
      if (colour !== 2 && colour !== 6) return fail("colour type must be RGB or RGBA");
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0) {
        return fail("unsupported compression, filter or interlace method");
      }
      header = { width: view.getUint32(dataStart), height: view.getUint32(dataStart + 4), channels: colour === 6 ? 4 : 3 };
    } else if (type === "IHDR") {
      return fail("duplicate IHDR");
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0) return fail("IEND is not empty");
      if (dataEnd + 4 !== bytes.length) return fail("data after IEND");
      if (idat.length === 0) return fail("no IDAT chunk");
      return { ok: true, value: { ...header, idat } };
    }
    offset = dataEnd + 4;
  }
  return fail("missing IEND");
}

/**
 * True when the IDAT stream inflates to exactly the image's raw scanlines
 * ((width × channels + 1) × height bytes): a corrupt or foreign stream does
 * not. Reading stops as soon as the output runs over.
 */
export async function inflatesToImage(image: PngImage): Promise<boolean> {
  const expected = (image.width * image.channels + 1) * image.height;
  try {
    const reader = new Blob(image.idat).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expected) {
        await reader.cancel();
        return false;
      }
    }
    return total === expected;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

type Limit = { limited: false } | { limited: true; retryAt: number };

/** Six uploads per minute per client. The counter fails open and logs, like the pet's. */
async function checkLimit(env: Env, key: string): Promise<Limit> {
  const window = Math.floor(Date.now() / SHARE_LIMIT.periodMs);
  try {
    const row = await env.DB.prepare(SQL_RATE_LIMIT)
      .bind(`${SHARE_LIMIT.bucket}:${key}`, window)
      .first<{ count: number }>();
    if ((row?.count ?? 0) > SHARE_LIMIT.limit) return { limited: true, retryAt: (window + 1) * SHARE_LIMIT.periodMs };
    return { limited: false };
  } catch (error) {
    console.warn("share rate limiter failed", error);
    return { limited: false };
  }
}

const rateLimited = (retryAt: number): Response => json({ error: "rate limited", retryAt }, 429, retryAfter(retryAt));

const inCooldown = (retryAt: number): Response =>
  json({ error: "card replaced recently, try again later", retryAt }, 429, retryAfter(retryAt));

/* ------------------------------------------------------------------ */
/* Ownership                                                           */
/* ------------------------------------------------------------------ */

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** A base64 (or base58, which Solana tooling also emits) Ed25519 signature as bytes, or null. */
function signatureBytes(value: string): Uint8Array | null {
  if (value.length === 0 || value.length > 128) return null;
  for (const decode of [base64.decode, base58.decode]) {
    try {
      const bytes = decode(value);
      if (bytes.length === ED25519_SIG_LEN) return bytes;
    } catch {
      // try the other encoding
    }
  }
  return null;
}

type Ownership = "none" | "valid" | "invalid";

/** "none" without the header, "valid" when the wallet signed SHARE_MESSAGE for this exact PNG, "invalid" otherwise. */
async function ownerSignature(request: Request, wallet: string, png: Uint8Array): Promise<Ownership> {
  const header = request.headers.get(SHARE_SIG_HEADER);
  if (header === null) return "none";
  const sig = signatureBytes(header.trim());
  if (sig === null) return "invalid";
  try {
    const message = new TextEncoder().encode(SHARE_MESSAGE(wallet, await sha256Hex(png)));
    return ed25519.verify(sig, message, base58.decode(wallet)) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

type Bound = { ok: true; key: string; owner: boolean } | { ok: false; response: Response };

/**
 * The row key for an upload, once the target is bound to the record it
 * describes (see the file header). `owner` is true for a passport card the
 * wallet signed.
 */
async function bindTarget(request: Request, env: Env, target: ShareTarget, png: Uint8Array, url: URL): Promise<Bound> {
  const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): Bound => ({
    ok: false,
    response: json({ error, ...extra }, status),
  });

  if (target.kind === "pet") {
    const row = await env.DB.prepare(SQL_PET_DAY).first<{ day: number }>();
    if (!row) return refuse(409, "the pet has not started yet");
    if (Number(target.id) !== row.day) return refuse(409, "not the current pet day", { day: row.day });
    return { ok: true, key: plainKey(target), owner: false };
  }

  if (target.kind === "passport") {
    const row = await env.DB.prepare(SQL_PASSPORT_BINDING).bind(target.id).first<PassportBindingRow>();
    if (!row) return refuse(404, "no passport is registered for this wallet");
    const signature = await ownerSignature(request, target.id, png);
    if (signature === "invalid") {
      return refuse(401, `bad ${SHARE_SIG_HEADER}: expected the wallet's Ed25519 signature over ${SHARE_MESSAGE(target.id, "<sha256 hex of the png>")}`);
    }
    return { ok: true, key: passportKey(target.id, row.hash, row.anchor_tx !== null), owner: signature === "valid" };
  }

  // scan: a complete report for the wallet must sit in the edge cache (the
  // ShareCard uploads right after one renders). A cache failure refuses.
  let cached: Response | undefined;
  try {
    cached = await caches.default.match(`${url.origin}/api/scan/${target.id}`);
  } catch (error) {
    console.warn("share: scan cache read failed", error);
  }
  if (!cached) return refuse(409, "scan the wallet first: a card is stored for a complete report only");
  return { ok: true, key: plainKey(target), owner: false };
}

async function putImage(request: Request, env: Env, target: ShareTarget, url: URL): Promise<Response> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("image/png")) return badRequest("body must be a PNG sent as image/png");
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_PNG_BYTES) {
    return json({ error: `png exceeds ${MAX_PNG_BYTES} bytes` }, 413);
  }
  if (!isSameSite(request, siteOrigin(env, url), url)) {
    return json({ error: "share cards are stored by the site's own pages only" }, 403);
  }

  const limit = await checkLimit(env, limitKey(request));
  if (limit.limited) return rateLimited(limit.retryAt);

  const body = await readBytes(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const png = parsePng(body.value);
  if (!png.ok) return badRequest(`body is not a decodable PNG: ${png.error}`);
  const { width, height } = png.value;
  if (width !== CARD_WIDTH || height !== CARD_HEIGHT) {
    return badRequest(`png must be ${CARD_WIDTH}×${CARD_HEIGHT}, got ${width}×${height}`);
  }
  if (!(await inflatesToImage(png.value))) {
    return badRequest("body is not a decodable PNG: the image data does not inflate to the image's size");
  }

  const bound = await bindTarget(request, env, target, body.value, url);
  if (!bound.ok) return bound.response;
  const { key, owner } = bound;

  const now = Date.now();
  const existing = await env.DB.prepare(SQL_HAS_IMAGE).bind(key).first<ImageStampRow>();
  if (existing) {
    if (target.kind === "passport" && !owner) {
      return json(
        { error: "a card is already stored for this passport; only its wallet can replace it", url: imagePath(target, existing.created_at) },
        409,
      );
    }
    if (!owner && now - existing.created_at < REPLACE_COOLDOWN_MS) return inCooldown(existing.created_at + REPLACE_COOLDOWN_MS);
  } else {
    // A new row: make room first, then respect the cap.
    await env.DB.prepare(SQL_PRUNE).bind(now - RETENTION_MS, MIN_CARD_BYTES).run();
    const count = await env.DB.prepare(SQL_COUNT).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_SHARE_ROWS) return json({ error: "share storage is full, try again later" }, 507);
  }

  // Two first uploads for one passport can race past the check above: the
  // INSERT OR IGNORE settles it, so the first stored card really is the first.
  const once = target.kind === "passport" && !owner;
  const result = await env.DB.prepare(once ? SQL_PUT_IMAGE_ONCE : SQL_PUT_IMAGE)
    .bind(key, body.value.buffer, body.value.byteLength, now)
    .run();
  if (once && result.meta.changes === 0) {
    return json({ error: "a card is already stored for this passport; only its wallet can replace it" }, 409);
  }
  return json({ ok: true, key, bytes: body.value.byteLength, url: imagePath(target, now) });
}

/** The stored card's row: the blob too for GET, the stamp only for HEAD. Passport cards resolve through the registered passport. */
function imageQuery(env: Env, target: ShareTarget, withBlob: boolean): D1PreparedStatement {
  if (target.kind === "passport") {
    return env.DB.prepare(withBlob ? SQL_GET_PASSPORT_IMAGE : SQL_HAS_PASSPORT_IMAGE).bind(target.id);
  }
  return env.DB.prepare(withBlob ? SQL_GET_IMAGE : SQL_HAS_IMAGE).bind(plainKey(target));
}

async function getImage(request: Request, env: Env, target: ShareTarget, head: boolean): Promise<Response> {
  let row: ImageStampRow | null;
  let png: ArrayBuffer | number[] | null = null;
  if (head) {
    row = await imageQuery(env, target, false).first<ImageStampRow>();
  } else {
    const full = await imageQuery(env, target, true).first<ImageRow>();
    row = full;
    png = full?.png ?? null;
  }
  if (!row) return json({ error: "not found" }, 404);

  const etag = `"${row.created_at.toString(36)}-${row.bytes}"`;
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "image/png",
    "Cache-Control": `public, max-age=${IMAGE_MAX_AGE_SECONDS}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="dirac-${target.kind}-${target.id.slice(0, 8)}.png"`,
    ETag: etag,
  };
  if (etagMatches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  if (png === null) return new Response(null, { status: 200, headers: { ...headers, "Content-Length": String(row.bytes) } });
  return new Response(toBytes(png), { status: 200, headers });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * Serves PUT /api/share/<kind>/<id>, GET and HEAD /api/share/<kind>/<id>.png
 * and the OPTIONS preflight; null for any other path or method. `parts` is
 * `url.pathname.split("/").filter(Boolean)`.
 */
export async function handleShare(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  parts: string[],
  url: URL,
): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "share" || parts.length !== 4) return null;
  const method = request.method;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const kind = parts[2];
  let raw: string;
  try {
    raw = decodeURIComponent(parts[3]);
  } catch {
    return badRequest("malformed path");
  }
  try {
    if (method === "GET" || method === "HEAD") {
      if (!raw.endsWith(".png")) return json({ error: "not found" }, 404);
      const target = parseTarget(kind, raw.slice(0, -4));
      if (!target) return badRequest("unknown share target");
      return await getImage(request, env, target, method === "HEAD");
    }
    if (method === "PUT") {
      const target = parseTarget(kind, raw);
      if (!target) return badRequest("unknown share target: expected scan|passport|pet and a wallet or a day");
      return await putImage(request, env, target, url);
    }
  } catch (error) {
    console.error("share api error", method, url.pathname, error);
    return json({ error: "internal error" }, 500);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HTML rewriting                                                      */
/* ------------------------------------------------------------------ */

export interface PageMeta {
  title: string;
  description: string;
  /** canonical page URL, absolute */
  url: string;
  /** absolute PNG URL when a card is stored, null otherwise */
  image: string | null;
}

const SITE_DESCRIPTION_SCAN = (short: string): string =>
  `Quantum exposure report for ${short}: what one Ed25519 key can move today, the post-quantum identity bound to it, and how complete the read was.`;

/** Day 1 has no previous collapse (worker/pet.ts DAY_ONE_BODY). */
const DAY_ONE_BODY = { form: "cat", character: "curious", ability: "superposition", palette: "ice" };

/** The stored image's absolute URL, or null. */
function imageUrl(site: string, target: ShareTarget, stamp: ImageStampRow | null): string | null {
  return stamp ? `${site}${imagePath(target, stamp.created_at)}` : null;
}

/** A stamp from nullable columns of a LEFT JOIN, or null when no card is stored. */
function stampOf(row: { bytes: number | null; created_at: number | null } | null): ImageStampRow | null {
  return row && row.bytes !== null && row.created_at !== null ? { bytes: row.bytes, created_at: row.created_at } : null;
}

async function scanMeta(env: Env, site: string, wallet: string): Promise<PageMeta> {
  const target: ShareTarget = { kind: "scan", id: wallet };
  const stamp = await env.DB.prepare(SQL_HAS_IMAGE).bind(plainKey(target)).first<ImageStampRow>();
  const short = shorten(wallet);
  return {
    title: `Quantum exposure report · ${short}`,
    description: SITE_DESCRIPTION_SCAN(short),
    url: `${site}/scan?a=${encodeURIComponent(wallet)}`,
    image: imageUrl(site, target, stamp),
  };
}

async function passportMeta(env: Env, site: string, wallet: string): Promise<PageMeta> {
  const target: ShareTarget = { kind: "passport", id: wallet };
  const row = await env.DB.prepare(SQL_PASSPORT_META).bind(wallet).first<PassportMetaRow>();
  const short = shorten(wallet);
  let description: string;
  if (row === null) {
    description = `No Dirac passport is registered for ${short}. Its assets and signatures depend on Ed25519 alone.`;
  } else {
    const mode = row.mode === "hardened" ? "Hardened" : "Simple";
    const anchor = row.anchor_tx ? "anchored on Solana" : "not yet anchored";
    description = `${mode} passport, ${anchor}: ML-KEM-768 and ML-DSA-65 keys bound to ${short}. Every reader re-checks the signatures in the browser.`;
  }
  return {
    title: `Post-quantum passport · ${short}`,
    description,
    url: `${site}/p?a=${encodeURIComponent(wallet)}`,
    image: imageUrl(site, target, stampOf(row)),
  };
}

async function petMeta(env: Env, site: string): Promise<PageMeta> {
  const row = await env.DB.prepare(SQL_PET_TARGET).first<PetTargetRow>();
  const day = row?.day ?? 1;
  const body = {
    form: row?.form ?? DAY_ONE_BODY.form,
    character: row?.character ?? DAY_ONE_BODY.character,
    ability: row?.ability ?? DAY_ONE_BODY.ability,
    palette: row?.palette ?? DAY_ONE_BODY.palette,
  };
  const target: ShareTarget = { kind: "pet", id: String(day) };
  return {
    title: `Quantum pet · day ${day} · ${body.form}`,
    description: `Day ${day}: today's body is a ${body.character} ${body.form} with ${body.ability}, in ${body.palette}. One 10-qubit register shared by every visitor; at 00:00 UTC it collapses again.`,
    url: `${site}/pet`,
    image: imageUrl(site, target, stampOf(row)),
  };
}

/**
 * The per-target meta for a page URL, or null when the path is not one of
 * /scan?a=, /p?a=, /pet or the wallet in the query is not a valid address.
 * Exported for the local test harness.
 */
export async function pageMeta(url: URL, env: Env): Promise<PageMeta | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const site = siteOrigin(env, url);
  if (path === "/pet") return petMeta(env, site);
  if (path !== "/scan" && path !== "/p") return null;
  const wallet = (url.searchParams.get("a") ?? "").trim();
  if (!isWallet(wallet)) return null;
  return path === "/scan" ? scanMeta(env, site, wallet) : passportMeta(env, site, wallet);
}

/** attribute name ("property" | "name"), its value and the content to set. */
type MetaTag = [attr: "property" | "name", key: string, content: string];

/** Every tag the rewriter owns for a target; the image tags only when a card is stored. */
export function metaTags(meta: PageMeta): MetaTag[] {
  const tags: MetaTag[] = [
    ["property", "og:title", meta.title],
    ["property", "og:description", meta.description],
    ["property", "og:url", meta.url],
    ["property", "og:type", "website"],
    ["property", "og:site_name", "Dirac"],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", meta.title],
    ["name", "twitter:description", meta.description],
  ];
  if (meta.image !== null) {
    const w = String(CARD_WIDTH);
    const h = String(CARD_HEIGHT);
    tags.push(
      ["property", "og:image", meta.image],
      ["property", "og:image:type", "image/png"],
      ["property", "og:image:width", w],
      ["property", "og:image:height", h],
      ["property", "og:image:alt", meta.title],
      ["name", "twitter:image", meta.image],
      ["name", "twitter:image:type", "image/png"],
      ["name", "twitter:image:width", w],
      ["name", "twitter:image:height", h],
      ["name", "twitter:image:alt", meta.title],
    );
  }
  return tags;
}

/**
 * Rewrites the head of an HTML response for /scan?a=, /p?a= and /pet: the
 * meta tags Next emitted are updated in place, missing ones are appended
 * before </head>. Anything that is not a 200 text/html for one of those
 * targets passes through untouched, and so does the response when D1 fails.
 */
export async function rewriteHtml(response: Response, url: URL, env: Env): Promise<Response> {
  if (response.status !== 200) return response;
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("text/html")) return response;

  let meta: PageMeta | null;
  try {
    meta = await pageMeta(url, env);
  } catch (error) {
    console.warn("share: head rewrite skipped", url.pathname, error);
    return response;
  }
  if (meta === null) return response;

  const wanted = new Map<string, MetaTag>();
  for (const tag of metaTags(meta)) wanted.set(`${tag[0]}=${tag[1]}`, tag);
  const seen = new Set<string>();

  // The body changes per query: the asset's length and validator no longer describe it.
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  const base = new Response(response.body, { status: response.status, statusText: response.statusText, headers });

  return new HTMLRewriter()
    .on("meta", {
      element(element) {
        const property = element.getAttribute("property");
        const name = element.getAttribute("name");
        const id = property ? `property=${property}` : name ? `name=${name}` : null;
        if (id === null) return;
        const tag = wanted.get(id);
        if (!tag) return;
        element.setAttribute("content", tag[2]);
        seen.add(id);
      },
    })
    .on("head", {
      element(element) {
        element.onEndTag((end) => {
          let html = "";
          for (const [id, [attr, key, content]] of wanted) {
            if (seen.has(id)) continue;
            html += `<meta ${attr}="${escapeAttr(key)}" content="${escapeAttr(content)}"/>`;
          }
          if (html) end.before(html, { html: true });
        });
      },
    })
    .transform(base);
}

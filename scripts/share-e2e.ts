/**
 * End-to-end check of the share-card routes (worker/share.ts) and the og:*
 * head rewrite against a running Worker. Run from the project root:
 *   node scripts/share-e2e.ts [http://localhost:8793]
 * Generates valid PNGs with node:zlib (no image library), registers a
 * throwaway passport, PUTs cards under every key kind, reads them back and
 * checks the validation paths: same-site uploads only, the PNG chunk walk,
 * the bindings (current pet day, registered passport, cached scan), the
 * first card per passport and its wallet-signed replacement, the ten-minute
 * cooldown, the rate limit (six uploads per minute per client), HEAD and
 * weak ETags, and the rewritten heads of /scan?a=, /p?a= and /pet. Prints
 * PASS/FAIL per check, exits 1 on failure. The uploads are spread over three
 * one-minute windows of the limiter, so a run takes about two and a half
 * minutes.
 *
 * Against production the run registers a throwaway passport (as
 * scripts/api-e2e.ts does), stores its cards, may store today's pet card when
 * none is stored yet, and spends this IP's share uploads for three minutes.
 */

import { createHash, randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { WALLET_MESSAGE, b64, buildPassport, keysFromSeeds, seedsFromSignature, selfSign, utf8 } from "../src/lib/pq.ts";

const BASE = (process.argv[2] ?? "http://localhost:8793").replace(/\/+$/, "");
const SIG_HEADER = "X-Share-Sig";
/** The same string worker/share.ts verifies (SHARE_MESSAGE). */
const SHARE_MESSAGE = (wallet: string, pngSha256Hex: string): string => `share:passport:${wallet}:${pngSha256Hex}`;
const WINDOW_MS = 60_000;

/** A fresh 32-byte key as base58: passes the wallet check and belongs to nobody. */
const randomWallet = (): string => base58.encode(new Uint8Array(randomBytes(32)));

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (ok) passed++;
  else failed++;
}

/* --- a minimal PNG encoder --------------------------------------------- */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** An 8-bit RGB PNG: flat `rgb`, or per-pixel noise when `noisy` (incompressible, for the size cap). */
function makePng(width: number, height: number, rgb: [number, number, number], noisy = false): Uint8Array {
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  let seed = 0x9e3779b9;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      if (noisy) {
        const v = next();
        raw[p] = v & 0xff;
        raw[p + 1] = (v >>> 8) & 0xff;
        raw[p + 2] = (v >>> 16) & 0xff;
      } else {
        raw[p] = rgb[0];
        raw[p + 1] = rgb[1];
        raw[p + 2] = rgb[2];
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const magic = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concat([magic, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))]);
}

/* --- helpers ------------------------------------------------------------ */

interface PutOptions {
  contentType?: string;
  /** the Origin header; null sends none */
  origin?: string | null;
  headers?: Record<string, string>;
}

async function put(path: string, body: Uint8Array | string, { contentType = "image/png", origin = BASE, headers = {} }: PutOptions = {}) {
  const h: Record<string, string> = { "Content-Type": contentType, ...headers };
  if (origin !== null) h.Origin = origin;
  const res = await fetch(`${BASE}${path}`, { method: "PUT", headers: h, body });
  let data: Record<string, unknown> | null = null;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = null;
  }
  return { status: res.status, data, headers: res.headers };
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The wallet-signed header for `png`. */
const signed = (sk: Uint8Array, wallet: string, png: Uint8Array): Record<string, string> => ({
  [SIG_HEADER]: base64.encode(ed25519.sign(utf8(SHARE_MESSAGE(wallet, sha256Hex(png))), sk)),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the limiter's next fixed one-minute window. */
async function nextWindow(): Promise<void> {
  const now = Date.now();
  const at = (Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS + 1500;
  console.log(`… waiting ${Math.ceil((at - now) / 1000)} s for the next rate-limit window`);
  await sleep(at - now);
}

const metaContent = (html: string, attr: "property" | "name", key: string): string | null => {
  const re = new RegExp(`<meta\\s+${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s+content="([^"]*)"`, "i");
  const m = html.match(re);
  return m ? m[1] : null;
};
const countMeta = (html: string, attr: "property" | "name", key: string): number =>
  (html.match(new RegExp(`<meta\\s+${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "gi")) ?? []).length;

async function html(path: string): Promise<string> {
  const page = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const text = await page.text();
  return text.match(/<head>[\s\S]*?<\/head>/i)?.[0] ?? "";
}

/* --- the run ------------------------------------------------------------ */

const started = Date.now();

// A throwaway wallet with a registered passport (simple mode, as scripts/api-e2e.ts).
const sk = new Uint8Array(randomBytes(32));
const WALLET = base58.encode(ed25519.getPublicKey(sk));
const OTHER = randomWallet();
const keys = keysFromSeeds(seedsFromSignature(ed25519.sign(utf8("derive"), sk)));
const passport = buildPassport(WALLET, keys, "simple");
const registration = await fetch(`${BASE}/api/passports`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    passport,
    self_sig: selfSign(passport, keys.dsaSk),
    wallet_sig: b64.encode(ed25519.sign(utf8(WALLET_MESSAGE(passport)), sk)),
  }),
});
check("throwaway passport registered", registration.status === 200, `status ${registration.status} wallet ${WALLET}`);

const petRes = await fetch(`${BASE}/api/pet`);
const petState = (await petRes.json().catch(() => null)) as { day?: unknown } | null;
const petDay = typeof petState?.day === "number" ? petState.day : NaN;
check("GET /api/pet gives the current day", Number.isInteger(petDay) && petDay >= 1, `day ${petDay}`);

const card = makePng(1200, 630, [7, 7, 8]);
const card2 = makePng(1200, 630, [12, 12, 14]);
const card3 = makePng(1200, 630, [20, 20, 24]);
const wrongSize = makePng(1199, 630, [7, 7, 8]);
const oversize = makePng(1200, 630, [0, 0, 0], true);
const ihdrOnly = card.subarray(0, 33);
const polyglot = concat([card.subarray(0, 33), utf8("<html><script>alert(document.domain)</script></html>")]);
const badCrc = Uint8Array.from(card);
badCrc[29] ^= 1; // the IHDR CRC's first byte
console.log(`card ${card.length} bytes, oversize ${oversize.length} bytes, base ${BASE}`);

// Refused before the limiter: content type, ids, declared size, origin.
let r = await put(`/api/share/scan/${WALLET}`, card, { contentType: "application/octet-stream" });
check("wrong content type → 400", r.status === 400, `status ${r.status}`);
r = await put(`/api/share/scan/not-a-wallet`, card);
check("invalid wallet → 400", r.status === 400, `status ${r.status}`);
r = await put(`/api/share/pet/0`, card);
check("day 0 → 400", r.status === 400, `status ${r.status}`);
r = await put(`/api/share/other/${WALLET}`, card);
check("unknown kind → 400", r.status === 400, `status ${r.status}`);
r = await put(`/api/share/scan/${WALLET}`, oversize);
check("oversize png → 413", r.status === 413, `status ${r.status} (${oversize.length} bytes)`);
r = await put(`/api/share/passport/${WALLET}`, card, { origin: "https://evil.example" });
check("cross-site Origin → 403", r.status === 403, `status ${r.status}`);
r = await put(`/api/share/passport/${WALLET}`, card, { origin: null });
check("no Origin and no Sec-Fetch-Site → 403", r.status === 403, `status ${r.status}`);
const preflight = await fetch(`${BASE}/api/share/scan/${WALLET}`, {
  method: "OPTIONS",
  headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "PUT" },
});
const allowed = preflight.headers.get("access-control-allow-methods") ?? "";
check("preflight does not offer PUT", preflight.status === 204 && !/\bPUT\b/.test(allowed), `status ${preflight.status} allow ${allowed || "none"}`);

// Window 1: the bindings and the PNG checks (six counted uploads, the seventh is refused).
r = await put(`/api/share/pet/${petDay}`, card); // 1
const petStored = r.status === 200 || (r.status === 429 && r.data?.error === "card replaced recently, try again later");
check("PUT pet card for the current day → 200 (or 429 while a fresh one is stored)", petStored, `status ${r.status} ${JSON.stringify(r.data)}`);
r = await put(`/api/share/pet/${petDay + 1}`, card); // 2
check("PUT pet card for another day → 409", r.status === 409 && r.data?.day === petDay, `status ${r.status} ${JSON.stringify(r.data)}`);
r = await put(`/api/share/passport/${OTHER}`, card); // 3
check("PUT passport card for an unregistered wallet → 404", r.status === 404, `status ${r.status}`);
r = await put(`/api/share/scan/${WALLET}`, ihdrOnly); // 4
check("IHDR-only png → 400", r.status === 400, `status ${r.status} ${JSON.stringify(r.data)}`);
r = await put(`/api/share/scan/${WALLET}`, badCrc); // 5
check("flipped IHDR CRC → 400", r.status === 400, `status ${r.status} ${JSON.stringify(r.data)}`);
r = await put(`/api/share/scan/${WALLET}`, polyglot); // 6
check("png header + html polyglot → 400", r.status === 400, `status ${r.status} ${JSON.stringify(r.data)}`);
r = await put(`/api/share/pet/${petDay + 1}`, card); // 7
check("seventh upload in a minute → 429 rate limited", r.status === 429 && r.data?.error === "rate limited" && r.headers.get("retry-after") !== null, `status ${r.status} ${JSON.stringify(r.data)}`);

// Window 2: the passport's card, first wins, the wallet replaces.
await nextWindow();
r = await put(`/api/share/passport/${WALLET}`, card); // 1
check("PUT passport card → 200", r.status === 200 && r.data?.ok === true, `status ${r.status} ${JSON.stringify(r.data)}`);
const firstUrl = String(r.data?.url ?? "");
r = await put(`/api/share/passport/${WALLET}`, card2); // 2
check("second unsigned passport card → 409 (first wins)", r.status === 409, `status ${r.status} ${JSON.stringify(r.data)}`);
r = await put(`/api/share/passport/${WALLET}`, card2, { headers: signed(new Uint8Array(randomBytes(32)), WALLET, card2) }); // 3
check("passport card signed by another key → 401", r.status === 401, `status ${r.status}`);
r = await put(`/api/share/passport/${WALLET}`, card2, { headers: signed(sk, WALLET, card3) }); // 4
check("passport card signed over a different png → 401", r.status === 401, `status ${r.status}`);
await sleep(5);
r = await put(`/api/share/passport/${WALLET}`, card2, { headers: signed(sk, WALLET, card2) }); // 5
check("passport card signed by the wallet → 200 (replaced)", r.status === 200, `status ${r.status} ${JSON.stringify(r.data)}`);
const secondUrl = String(r.data?.url ?? "");
check("replacement has a new version query", firstUrl !== "" && secondUrl !== "" && firstUrl !== secondUrl, `${firstUrl} → ${secondUrl}`);
r = await put(`/api/share/scan/${WALLET}`, wrongSize); // 6
check("1199×630 → 400", r.status === 400, `status ${r.status} ${JSON.stringify(r.data)}`);

// Window 3: the scan binding and the cooldown.
await nextWindow();
r = await put(`/api/share/scan/${WALLET}`, "not a png at all"); // 1
check("png magic missing → 400", r.status === 400, `status ${r.status}`);
r = await put(`/api/share/scan/${WALLET}`, card); // 2
check("scan card before any scan → 409", r.status === 409, `status ${r.status} ${JSON.stringify(r.data)}`);
console.log("… scanning the throwaway wallet (its report is complete only with a private RPC)");
const scan = await fetch(`${BASE}/api/scan/${WALLET}`);
const report = (await scan.json().catch(() => null)) as { confidence?: unknown } | null;
const complete = scan.status === 200 && report?.confidence === "complete";
console.log(`    scan ${scan.status}, confidence ${String(report?.confidence ?? "?")}`);
r = await put(`/api/share/scan/${WALLET}`, card); // 3
const scanStored = complete && r.status === 200;
check(complete ? "scan card after a complete scan → 200" : "scan card after a partial scan → 409", complete ? r.status === 200 : r.status === 409, `status ${r.status} ${JSON.stringify(r.data)}`);
if (scanStored) {
  r = await put(`/api/share/scan/${WALLET}`, card2); // 4
  check("scan card replaced within ten minutes → 429 cooldown", r.status === 429 && r.data?.error === "card replaced recently, try again later" && r.headers.get("retry-after") !== null, `status ${r.status} ${JSON.stringify(r.data)}`);
}

// Reading back: the passport's signed card.
let res = await fetch(`${BASE}/api/share/passport/${WALLET}.png`);
const png = new Uint8Array(await res.arrayBuffer());
check("GET passport png → 200 image/png", res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("image/png"), `status ${res.status}`);
check("GET body is the wallet-signed PNG", png.length === card2.length && png.every((b, i) => b === card2[i]), `${png.length} bytes`);
check("GET has public cache and ETag", (res.headers.get("cache-control") ?? "").includes("max-age=3600") && !!res.headers.get("etag"), `${res.headers.get("cache-control")} ${res.headers.get("etag")}`);
const etag = res.headers.get("etag") ?? "";
res = await fetch(`${BASE}/api/share/passport/${WALLET}.png`, { headers: { "If-None-Match": etag } });
check("If-None-Match (strong) → 304", res.status === 304, `status ${res.status}`);
res = await fetch(`${BASE}/api/share/passport/${WALLET}.png`, { headers: { "If-None-Match": `W/${etag}` } });
check("If-None-Match (weak) → 304", res.status === 304, `status ${res.status}`);
res = await fetch(`${BASE}/api/share/passport/${WALLET}.png`, { headers: { "If-None-Match": `"other", W/${etag}` } });
check("If-None-Match (list) → 304", res.status === 304, `status ${res.status}`);
res = await fetch(`${BASE}/api/share/passport/${WALLET}.png`, { method: "HEAD" });
const headBody = await res.arrayBuffer();
check(
  "HEAD → 200 image/png with the length and no body",
  res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("image/png") && res.headers.get("content-length") === String(card2.length) && headBody.byteLength === 0,
  `status ${res.status} type ${res.headers.get("content-type")} length ${res.headers.get("content-length")}`,
);
res = await fetch(`${BASE}/api/share/passport/${OTHER}.png`);
check("passport png for an unregistered wallet → 404", res.status === 404, `status ${res.status}`);
res = await fetch(`${BASE}/api/share/pet/${petDay + 1}.png`);
check("missing card → 404", res.status === 404, `status ${res.status}`);
res = await fetch(`${BASE}/api/share/scan/${WALLET}`);
check("GET without .png → 404", res.status === 404, `status ${res.status}`);
res = await fetch(`${BASE}/api/share/scan/not-a-wallet.png`);
check("GET invalid wallet → 400", res.status === 400, `status ${res.status}`);

// The rewritten heads
let head = await html(`/scan?a=${WALLET}`);
check("/scan?a= og:title names the report", metaContent(head, "property", "og:title") === `Quantum exposure report · ${WALLET.slice(0, 4)}…${WALLET.slice(-4)}`, metaContent(head, "property", "og:title") ?? "none");
const scanImage = metaContent(head, "property", "og:image") ?? "";
check(
  scanStored ? "/scan?a= og:image points at the stored card" : "/scan?a= has no share image without a stored card",
  scanStored ? scanImage.includes(`/api/share/scan/${WALLET}.png?v=`) : !scanImage.includes("/api/share/"),
  scanImage || "none",
);
check("/scan?a= twitter:card is summary_large_image", metaContent(head, "name", "twitter:card") === "summary_large_image");
check("/scan?a= og:url is the page", metaContent(head, "property", "og:url") === `${BASE}/scan?a=${WALLET}`, metaContent(head, "property", "og:url") ?? "none");
check("/scan?a= has exactly one og:title", countMeta(head, "property", "og:title") === 1);
check("/scan?a= keeps its <title>", /<title>[^<]*Scan[^<]*<\/title>/.test(head));

head = await html(`/p?a=${WALLET}`);
check("/p?a= og:title names the passport", metaContent(head, "property", "og:title") === `Post-quantum passport · ${WALLET.slice(0, 4)}…${WALLET.slice(-4)}`, metaContent(head, "property", "og:title") ?? "none");
check("/p?a= og:image points at the stored card", (metaContent(head, "property", "og:image") ?? "").includes(`/api/share/passport/${WALLET}.png?v=`), metaContent(head, "property", "og:image") ?? "none");
check("/p?a= twitter:image matches og:image", metaContent(head, "name", "twitter:image") === metaContent(head, "property", "og:image"));
check("/p?a= og:image:width/height are 1200/630", metaContent(head, "property", "og:image:width") === "1200" && metaContent(head, "property", "og:image:height") === "630");
check("/p?a= has exactly one og:image", countMeta(head, "property", "og:image") === 1);
check("/p?a= describes the registered passport", (metaContent(head, "property", "og:description") ?? "").startsWith("Simple passport, not yet anchored"), metaContent(head, "property", "og:description") ?? "none");
head = await html(`/p?a=${OTHER}`);
check("/p?a= for an unregistered wallet has no share image", !(metaContent(head, "property", "og:image") ?? "").includes("/api/share/"), metaContent(head, "property", "og:image") ?? "none");
check("/p?a= describes a missing passport honestly", (metaContent(head, "property", "og:description") ?? "").startsWith("No Dirac passport is registered"), metaContent(head, "property", "og:description") ?? "none");

head = await html(`/pet`);
check("/pet og:title names the day", /^Quantum pet · day \d+ · [a-z ]+$/.test(metaContent(head, "property", "og:title") ?? ""), metaContent(head, "property", "og:title") ?? "none");
const titleDay = (metaContent(head, "property", "og:title") ?? "").match(/day (\d+)/)?.[1];
const petImage = metaContent(head, "property", "og:image") ?? "";
check(
  "/pet og:image is the current day's card when stored, absent otherwise",
  titleDay === String(petDay) && (petStored ? petImage.includes(`/api/share/pet/${petDay}.png?v=`) : !petImage.includes("/api/share/pet/")),
  `day ${titleDay ?? "?"} image ${petImage || "none"}`,
);

head = await html(`/scan`);
check("/scan without ?a= is untouched", metaContent(head, "property", "og:title") === null || !(metaContent(head, "property", "og:title") ?? "").startsWith("Quantum exposure report"));
head = await html(`/scan?a=${encodeURIComponent('"><script>alert(1)</script>')}`);
check("/scan with a non-wallet query is untouched", !head.includes("alert(1)") && (metaContent(head, "property", "og:title") === null || !(metaContent(head, "property", "og:title") ?? "").startsWith("Quantum exposure report")));
head = await html(`/scan?a=${OTHER}`);
check("/scan?a= for a wallet without a card has no share image", !(metaContent(head, "property", "og:image") ?? "").includes("/api/share/"), metaContent(head, "property", "og:image") ?? "none");
check("/scan?a= for a wallet without a card still has its og:title", (metaContent(head, "property", "og:title") ?? "").startsWith("Quantum exposure report"), metaContent(head, "property", "og:title") ?? "none");

console.log(`\n${passed} passed, ${failed} failed in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failed > 0 ? 1 : 0);

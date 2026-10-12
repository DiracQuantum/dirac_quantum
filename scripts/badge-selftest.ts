/**
 * Self-test for the embeddable passport badge (src/lib/badge.ts and
 * worker/badge.ts): SVG well-formedness through a small XML checker, an
 * element and attribute allow-list (no script, no link, no external
 * reference), escaping, wallet validation, the layout, the snippets, and the
 * routes with a stubbed D1 (unknown wallet, registered passports, verified and
 * unverified anchors, a schema without anchor_verified, invalid path, D1
 * failure, ETag / 304, HEAD, JSON, 404 / 405). Run from the project
 * root:
 *   node scripts/badge-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure. Pass
 * `--write <dir>` to also save every rendered variant as an .svg file.
 *
 * Worker sources import their siblings without an extension; a resolve hook
 * adds it, then the modules are loaded dynamically so the hook is in place
 * first.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(`${path.join(ROOT, "src", specifier.slice(2))}.ts`).href, context);
    }
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return next(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const lib = await import("../src/lib/badge.ts");
const worker = await import("../worker/badge.ts");
const { base58 } = await import("@scure/base");

const {
  BADGE_ALT,
  BADGE_MAX_AGE_SECONDS,
  BADGE_SIZES,
  BADGE_THEMES,
  badgePath,
  badgeSnippets,
  escapeXml,
  isBadgeWallet,
  parseBadgeSize,
  parseBadgeTheme,
  renderBadge,
  stateFromRow,
} = lib;
const { etagOf, handleBadge } = worker;

type BadgeState = Parameters<typeof renderBadge>[0];
type Env = Parameters<typeof handleBadge>[1];
type Ctx = Parameters<typeof handleBadge>[2];

let failed = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (ok) passed++;
  else failed++;
}

const writeDir = (() => {
  const i = process.argv.indexOf("--write");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

/* --- a small XML checker --------------------------------------------- */

interface XmlElement {
  name: string;
  attrs: Map<string, string>;
  /** character data directly inside the element, entities decoded */
  text: string;
}

type XmlResult = { ok: true; elements: XmlElement[] } | { ok: false; error: string };

const NAME = /^[A-Za-z_][\w.:-]*/;
const ATTR = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const BARE_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

function decode(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Character data: no raw "<", every "&" opens a known entity. */
function badText(text: string): string | null {
  if (text.includes("<")) return "raw < in character data";
  if (BARE_AMP.test(text)) return "bare & in character data";
  return null;
}

/** Index of the ">" closing the tag that opens at `start`, skipping quoted attribute values. */
function tagEnd(doc: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < doc.length; i++) {
    const c = doc[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "<") {
      return -1;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Well-formedness for the subset an SVG badge uses: an optional XML
 * declaration, comments, elements with quoted attributes (no duplicates),
 * balanced tags, a single root, entities only from the predefined set or
 * character references. No DOCTYPE, no CDATA, no processing instructions.
 */
function parseXml(doc: string): XmlResult {
  const fail = (error: string): XmlResult => ({ ok: false, error });
  const stack: XmlElement[] = [];
  const elements: XmlElement[] = [];
  let roots = 0;
  let i = 0;
  while (i < doc.length) {
    const lt = doc.indexOf("<", i);
    const text = lt < 0 ? doc.slice(i) : doc.slice(i, lt);
    const bad = badText(text);
    if (bad) return fail(bad);
    if (text.trim() !== "") {
      if (stack.length === 0) return fail("text outside the root element");
      stack[stack.length - 1].text += decode(text);
    }
    if (lt < 0) break;
    if (doc.startsWith("<?xml", lt)) {
      if (lt !== 0) return fail("XML declaration not at the start");
      const end = doc.indexOf("?>", lt);
      if (end < 0) return fail("unterminated XML declaration");
      i = end + 2;
      continue;
    }
    if (doc.startsWith("<!--", lt)) {
      const end = doc.indexOf("-->", lt + 4);
      if (end < 0) return fail("unterminated comment");
      if (doc.slice(lt + 4, end).includes("--")) return fail("-- inside a comment");
      i = end + 3;
      continue;
    }
    if (doc.startsWith("<!", lt) || doc.startsWith("<?", lt)) return fail("DOCTYPE, CDATA or a processing instruction");
    const gt = tagEnd(doc, lt);
    if (gt < 0) return fail(`unterminated tag at ${lt}`);
    const inner = doc.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) return fail(`</${name}> closes <${open?.name ?? "nothing"}>`);
      i = gt + 1;
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const name = NAME.exec(body)?.[0];
    if (!name) return fail(`bad element name at ${lt}`);
    const attrs = new Map<string, string>();
    ATTR.lastIndex = name.length;
    let rest = name.length;
    for (let m = ATTR.exec(body); m; m = ATTR.exec(body)) {
      const [, key, double, single] = m;
      if (attrs.has(key)) return fail(`duplicate attribute ${key} on <${name}>`);
      const value = double ?? single ?? "";
      const badValue = badText(value);
      if (badValue) return fail(`${badValue} in ${key} on <${name}>`);
      attrs.set(key, decode(value));
      rest = ATTR.lastIndex;
    }
    if (body.slice(rest).trim() !== "") return fail(`unparsed attribute text on <${name}>: ${body.slice(rest).trim()}`);
    if (stack.length === 0) {
      roots++;
      if (roots > 1) return fail("more than one root element");
    }
    const element: XmlElement = { name, attrs, text: "" };
    elements.push(element);
    if (!selfClosing) stack.push(element);
    i = gt + 1;
  }
  if (stack.length > 0) return fail(`unclosed <${stack[stack.length - 1].name}>`);
  if (roots !== 1) return fail("no root element");
  return { ok: true, elements };
}

/** What a badge may contain: shapes, text and a title. Nothing that can run or fetch. */
const ALLOWED: Record<string, string[]> = {
  svg: ["xmlns", "width", "height", "viewBox", "role", "aria-label"],
  title: [],
  rect: ["x", "y", "width", "height", "rx", "fill", "stroke", "stroke-opacity"],
  path: ["d", "fill", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin"],
  circle: ["cx", "cy", "r", "fill"],
  g: ["font-family", "font-size", "text-anchor"],
  text: ["x", "y", "textLength", "lengthAdjust", "fill", "font-weight"],
};

/** null when the document is a well-formed, allow-listed SVG; the reason otherwise. */
function badgeProblem(svg: string): string | null {
  const parsed = parseXml(svg);
  if (!parsed.ok) return parsed.error;
  const [root] = parsed.elements;
  if (root.name !== "svg") return "root is not <svg>";
  if (root.attrs.get("xmlns") !== "http://www.w3.org/2000/svg") return "missing the SVG namespace";
  for (const element of parsed.elements) {
    const allowed = ALLOWED[element.name];
    if (!allowed) return `element <${element.name}> is not allowed`;
    for (const key of element.attrs.keys()) {
      if (!allowed.includes(key)) return `attribute ${key} on <${element.name}> is not allowed`;
    }
    for (const value of element.attrs.values()) {
      if (/url\s*\(|javascript:|https?:\/\//i.test(value) && value !== "http://www.w3.org/2000/svg") return `reference in ${value}`;
    }
  }
  if (/<script|<style|<image|<use|<foreignObject|href|@import|on[a-z]+\s*=/i.test(svg)) return "script, style, link or handler text";
  return null;
}

const words = (svg: string): string[] => {
  const parsed = parseXml(svg);
  return parsed.ok ? parsed.elements.filter((e) => e.name === "text").map((e) => e.text) : [];
};

/* --- the checker itself --------------------------------------------- */

check("xml: accepts a well-formed sample", parseXml(`<a x="1" y='2'><b/>t &amp; &#39; &#x41;</a>`).ok);
for (const [label, doc] of [
  ["unclosed", "<a><b></a>"],
  ["bare &", "<a>x & y</a>"],
  ["raw < in attribute", `<a x="<"/>`],
  ["duplicate attribute", `<a x="1" x="2"/>`],
  ["unquoted attribute", "<a x=1/>"],
  ["two roots", "<a/><b/>"],
  ["text outside", "x<a/>"],
  ["doctype", "<!DOCTYPE a><a/>"],
] as const) {
  check(`xml: rejects ${label}`, !parseXml(doc).ok);
}
check("allow-list: rejects a script", badgeProblem(`<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>`) !== null);
check("allow-list: rejects an onload", badgeProblem(`<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>`) !== null);
check("allow-list: rejects an external image", badgeProblem(`<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x"/></svg>`) !== null);

/* --- escaping --------------------------------------------------------- */

check("escapeXml: the five characters", escapeXml(`<a href="x">&'</a>`) === "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
check("escapeXml: escapes & first (no double escape of the output)", escapeXml("&lt;") === "&amp;lt;");
const hostile = `"><script>alert(1)</script><x a='`;
const hostileSvg = renderBadge({ status: "none" }, { size: "m", theme: "dark" }, hostile).svg;
check("a hostile wallet string stays text", badgeProblem(hostileSvg) === null && !hostileSvg.includes("<script"), badgeProblem(hostileSvg) ?? "");

/* --- wallet validation ------------------------------------------------ */

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const wallet = base58.encode(randomBytes(32));
const zeroKey = base58.encode(new Uint8Array(32));
check("wallet: a random 32-byte key", isBadgeWallet(wallet), wallet);
check("wallet: the system program (32 zero bytes)", isBadgeWallet(zeroKey) && zeroKey === "11111111111111111111111111111111");
check("wallet: a real mainnet address", isBadgeWallet("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"));
check("wallet: 31 bytes refused", !isBadgeWallet(base58.encode(randomBytes(31))));
check("wallet: 33 bytes refused", !isBadgeWallet(base58.encode(Uint8Array.from([1, ...randomBytes(32)]))));
check("wallet: 64-byte signature refused", !isBadgeWallet(base58.encode(randomBytes(64))));
check("wallet: non-base58 characters refused", ["0", "O", "I", "l"].every((c) => !isBadgeWallet(`${c}${wallet.slice(1)}`)));
check("wallet: empty, padded, too long, not a string", !isBadgeWallet("") && !isBadgeWallet(` ${wallet}`) && !isBadgeWallet(`${wallet}${wallet}`) && !isBadgeWallet(42) && !isBadgeWallet(null));

/* --- state ------------------------------------------------------------ */

check("state: no row is none", stateFromRow(null).status === "none");
const hardenedAnchored = stateFromRow({ mode: "hardened", anchor_tx: base58.encode(randomBytes(64)) });
check("state: hardened, anchored", hardenedAnchored.status === "ready" && hardenedAnchored.mode === "hardened" && hardenedAnchored.anchored);
const simple = stateFromRow({ mode: "simple", anchor_tx: null });
check("state: simple, unanchored", simple.status === "ready" && simple.mode === "simple" && !simple.anchored);
const odd = stateFromRow({ mode: "<b>", anchor_tx: "" });
check("state: an unknown mode is dropped, an empty anchor is no anchor", odd.status === "ready" && odd.mode === null && !odd.anchored);

/* --- every variant renders well-formed and safe ------------------------ */

const STATES: [string, BadgeState][] = [
  ["hardened-anchored", { status: "ready", mode: "hardened", anchored: true }],
  ["hardened", { status: "ready", mode: "hardened", anchored: false }],
  ["simple-anchored", { status: "ready", mode: "simple", anchored: true }],
  ["simple", { status: "ready", mode: "simple", anchored: false }],
  ["unknown-mode", { status: "ready", mode: null, anchored: false }],
  ["none", { status: "none" }],
  ["invalid", { status: "invalid" }],
  ["unavailable", { status: "unavailable" }],
];

if (writeDir) mkdirSync(writeDir, { recursive: true });
let allSafe = true;
let worst = "";
for (const [label, state] of STATES) {
  for (const size of BADGE_SIZES) {
    for (const theme of BADGE_THEMES) {
      const { svg, width, height } = renderBadge(state, { size, theme }, wallet);
      const problem = badgeProblem(svg);
      if (problem) {
        allSafe = false;
        worst = `${label}/${size}/${theme}: ${problem}`;
      }
      if (!Number.isInteger(width) || width <= 0 || height !== (size === "s" ? 20 : 28)) {
        allSafe = false;
        worst = `${label}/${size}/${theme}: ${width}x${height}`;
      }
      if (writeDir) writeFileSync(path.join(writeDir, `badge-${label}-${size}-${theme}.svg`), svg);
    }
  }
}
check(`all ${STATES.length * 4} variants are well-formed, allow-listed, integer-sized`, allSafe, worst);

/* --- words, sizes, themes -------------------------------------------- */

const m = renderBadge({ status: "ready", mode: "hardened", anchored: true }, { size: "m", theme: "dark" }, wallet);
check("ready badge words", JSON.stringify(words(m.svg)) === JSON.stringify(["DIRAC", "Q-READY", "HARDENED · ANCHORED", "ML-DSA-65"]), JSON.stringify(words(m.svg)));
check(
  "simple unanchored badge words",
  JSON.stringify(words(renderBadge({ status: "ready", mode: "simple", anchored: false }, { size: "m", theme: "dark" }).svg)) ===
    JSON.stringify(["DIRAC", "Q-READY", "SIMPLE", "ML-DSA-65"]),
);
check("no-passport badge words", JSON.stringify(words(renderBadge({ status: "none" }, { size: "m", theme: "dark" }).svg)) === JSON.stringify(["DIRAC", "NO PASSPORT"]));
check("the Dirac mark is drawn", /<path d="M[\d.]+ [\d.]+L[\d.]+ 14L[\d.]+ [\d.]+" fill="none" stroke="#f2f1ec" stroke-width="2"/.test(m.svg));
check("dark: ink ground, paper text", m.svg.includes(`fill="#070708" stroke="#f2f1ec"`) && m.svg.includes(`fill="#f2f1ec">DIRAC`));
const light = renderBadge({ status: "ready", mode: "hardened", anchored: true }, { size: "m", theme: "light" }).svg;
check("light: paper ground, ink text", light.includes(`fill="#f2f1ec" stroke="#070708"`) && light.includes(`fill="#070708">DIRAC`));
check("Q-READY carries the signal dot, NO PASSPORT the mute one", m.svg.includes(`fill="#4d8bff"`) && renderBadge({ status: "none" }, { size: "m", theme: "dark" }).svg.includes(`r="2.75" fill="#8c8c87"`));
const s = renderBadge({ status: "ready", mode: "hardened", anchored: true }, { size: "s", theme: "dark" });
check("size s is 20 px tall and narrower than m", s.height === 20 && m.height === 28 && s.width < m.width, `s ${s.width}x${s.height}, m ${m.width}x${m.height}`);
check("widest badge stays under 420 px (m) and 330 px (s)", m.width <= 420 && s.width <= 330);
check("the title names the state and the shortened wallet", m.svg.includes(`<title>Dirac passport of ${wallet.slice(0, 4)}…${wallet.slice(-4)}: Q-ready, hardened, anchored on Solana, ML-DSA-65</title>`));
check("no web fonts: a system monospace stack", m.svg.includes(`font-family="ui-monospace,`) && m.svg.includes("monospace\"") && !/@font-face|woff/i.test(m.svg));
check("query parsing falls back to m / dark", parseBadgeSize("xl") === "m" && parseBadgeSize(null) === "m" && parseBadgeSize("s") === "s" && parseBadgeTheme("neon") === "dark" && parseBadgeTheme("light") === "light");

/* --- links and snippets ----------------------------------------------- */

check("path: defaults leave no query", badgePath(wallet) === `/api/badge/${wallet}.svg` && badgePath(wallet, { size: "m", theme: "dark" }) === `/api/badge/${wallet}.svg`);
check("path: options and json", badgePath(wallet, { size: "s", theme: "light" }) === `/api/badge/${wallet}.svg?size=s&theme=light` && badgePath(wallet, {}, "json") === `/api/badge/${wallet}.json`);
const snippets = badgeSnippets(wallet, { size: "s", theme: "light" }, { api: "https://dirac.test/", site: "https://dirac.test" });
check("snippet: url", snippets.url === `https://dirac.test/api/badge/${wallet}.svg?size=s&theme=light`, snippets.url);
check("snippet: page", snippets.page === `https://dirac.test/p?a=${wallet}`);
check(
  "snippet: html escapes the & and links the page",
  snippets.html ===
    `<a href="https://dirac.test/p?a=${wallet}"><img src="https://dirac.test/api/badge/${wallet}.svg?size=s&amp;theme=light" alt="${BADGE_ALT}" height="20"></a>`,
  snippets.html,
);
check("snippet: html parses", parseXml(snippets.html.replace(/height="20">/, 'height="20"/>')).ok);
check("snippet: markdown", snippets.markdown === `[![${BADGE_ALT}](${snippets.url})](${snippets.page})`);

/* --- routes with a stubbed D1 ----------------------------------------- */

interface Row {
  mode: string;
  anchor_tx: string | null;
  /** migrations/0013: 1 once the Worker found the anchor on chain */
  anchor_verified: number;
  hash: string;
  registered_at: number;
}

/**
 * A D1 that answers the badge's primary-key read from `rows`. `broken`: every
 * read fails. `legacy`: the schema before migrations/0013, so a read naming
 * anchor_verified fails the way D1 does and rows come back without it.
 */
function stubDb(rows: Record<string, Row>, broken = false, legacy = false): { env: Env; reads: unknown[][] } {
  const reads: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              reads.push([sql, ...args]);
              if (broken) throw new Error("D1_ERROR: stub");
              if (legacy && sql.includes("anchor_verified")) throw new Error("D1_ERROR: no such column: anchor_verified: SQLITE_ERROR");
              const row = rows[String(args[0])];
              if (!row) return null;
              if (!legacy) return row;
              const { anchor_verified: _dropped, ...older } = row;
              void _dropped;
              return older;
            },
          };
        },
      };
    },
  };
  return { env: { DB: db as unknown as Env["DB"] }, reads };
}

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as Ctx;

async function call(env: Env, pathname: string, init: RequestInit = {}): Promise<Response | null> {
  const url = new URL(pathname, "https://dirac.test");
  const request = new Request(url, init);
  return handleBadge(request, env, ctx, url.pathname.split("/").filter(Boolean), url);
}

const anchored = base58.encode(randomBytes(64));
const registered = base58.encode(randomBytes(32));
const hash = "ab".repeat(32);
const claimed = base58.encode(randomBytes(32));
const claimTx = base58.encode(randomBytes(64));
const db = stubDb({
  [registered]: { mode: "hardened", anchor_tx: anchored, anchor_verified: 1, hash, registered_at: 1_760_000_000_000 },
  // An anchor named but not (yet) found on chain: the badge must not say ANCHORED.
  [claimed]: { mode: "hardened", anchor_tx: claimTx, anchor_verified: 0, hash, registered_at: 1_760_000_000_000 },
});

const unknown = await call(db.env, `/api/badge/${wallet}.svg`);
const unknownSvg = unknown ? await unknown.text() : "";
check("unknown wallet: 200 with the NO PASSPORT badge", unknown?.status === 200 && words(unknownSvg).includes("NO PASSPORT"), String(unknown?.status));
check("unknown wallet: image/svg+xml", unknown?.headers.get("content-type") === "image/svg+xml; charset=utf-8");
check("unknown wallet: public for ten minutes", unknown?.headers.get("cache-control") === `public, max-age=${BADGE_MAX_AGE_SECONDS}` && BADGE_MAX_AGE_SECONDS === 600);
check("unknown wallet: strong ETag over the body", unknown?.headers.get("etag") === (await etagOf(unknownSvg)) && /^"[0-9a-f]{24}"$/.test(unknown?.headers.get("etag") ?? ""));
check(
  "headers: CORS, nosniff, CSP, CORP",
  unknown?.headers.get("access-control-allow-origin") === "*" &&
    unknown.headers.get("x-content-type-options") === "nosniff" &&
    unknown.headers.get("content-security-policy") === "default-src 'none'; sandbox" &&
    unknown.headers.get("cross-origin-resource-policy") === "cross-origin",
);
check("unknown wallet: the body is a safe badge", badgeProblem(unknownSvg) === null);
check("one primary-key read", db.reads.length === 1 && String(db.reads[0][0]).includes("FROM passports WHERE wallet = ?1") && db.reads[0][1] === wallet);

const etag = unknown?.headers.get("etag") ?? "";
const revalidated = await call(db.env, `/api/badge/${wallet}.svg`, { headers: { "If-None-Match": `W/${etag}` } });
check("If-None-Match: 304 without a body", revalidated?.status === 304 && (await revalidated.text()) === "" && revalidated.headers.get("etag") === etag);
const head = await call(db.env, `/api/badge/${wallet}.svg`, { method: "HEAD" });
check("HEAD: 200, same ETag, no body", head?.status === 200 && head.headers.get("etag") === etag && (await head.text()) === "" && head.headers.get("content-length") === String(new TextEncoder().encode(unknownSvg).byteLength));

const ready = await call(db.env, `/api/badge/${registered}.svg?size=s&theme=light`);
const readySvg = ready ? await ready.text() : "";
check("registered: Q-READY · HARDENED · ANCHORED · ML-DSA-65", JSON.stringify(words(readySvg)) === JSON.stringify(["DIRAC", "Q-READY", "HARDENED · ANCHORED", "ML-DSA-65"]));
check("registered: size and theme from the query", readySvg.includes(`height="20"`) && readySvg.includes(`fill="#f2f1ec" stroke="#070708"`));
check("registered: a different ETag", ready?.headers.get("etag") !== etag);
const odds = await call(db.env, `/api/badge/${registered}.svg?size=huge&theme=%3Cscript%3E`);
check("an unknown size or theme falls back, nothing echoed", odds?.status === 200 && !(await odds.text()).includes("script"));

const before = db.reads.length;
const invalid = await call(db.env, `/api/badge/${encodeURIComponent("<script>alert(1)</script>")}.svg`);
const invalidSvg = invalid ? await invalid.text() : "";
check("invalid wallet: 200 with the INVALID ADDRESS badge", invalid?.status === 200 && words(invalidSvg).includes("INVALID ADDRESS"));
check("invalid wallet: nothing echoed, D1 not read", !invalidSvg.includes("script") && !invalidSvg.includes("alert") && db.reads.length === before);
const badPercent = await call(db.env, "/api/badge/%E0%A4%A.svg");
check("undecodable path: the invalid badge", badPercent?.status === 200 && words(await badPercent.text()).includes("INVALID ADDRESS"));

const down = stubDb({}, true);
// The module logs the D1 failure; keep the expected warnings out of the report.
const warn = console.warn;
console.warn = () => undefined;
const unavailable = await call(down.env, `/api/badge/${wallet}.svg`);
check(
  "D1 failure: 200 UNAVAILABLE, cached one minute",
  unavailable?.status === 200 && words(await unavailable.text()).includes("UNAVAILABLE") && unavailable.headers.get("cache-control") === "public, max-age=60",
);
const unavailableJson = await call(down.env, `/api/badge/${wallet}.json`);
console.warn = warn;
check("D1 failure: JSON 503 with Retry-After", unavailableJson?.status === 503 && unavailableJson.headers.get("retry-after") === "60");

const info = await call(db.env, `/api/badge/${registered}.json`);
const body = info ? ((await info.json()) as Record<string, unknown>) : {};
check("json: 200, public, ETag", info?.status === 200 && info.headers.get("cache-control") === "public, max-age=600" && !!info.headers.get("etag"));
check(
  "json: the record",
  body.wallet === registered &&
    body.status === "ready" &&
    body.mode === "hardened" &&
    body.anchored === true &&
    body.anchor_tx === anchored &&
    body.scheme === "ML-DSA-65" &&
    body.hash === hash &&
    body.registered_at === 1_760_000_000_000 &&
    body.text === "Q-READY · HARDENED · ANCHORED · ML-DSA-65",
  JSON.stringify(body),
);
check("json: links", body.page === `https://dirac.test/p?a=${registered}` && body.badge === `https://dirac.test/api/badge/${registered}.svg`);

/* --- ANCHORED means a verified anchor (migrations/0013) ---------------- */

const unverified = await call(db.env, `/api/badge/${claimed}.svg`);
const unverifiedSvg = unverified ? await unverified.text() : "";
check(
  "unverified anchor: HARDENED, no ANCHORED and no UNVERIFIED segment",
  unverified?.status === 200 &&
    JSON.stringify(words(unverifiedSvg)) === JSON.stringify(["DIRAC", "Q-READY", "HARDENED", "ML-DSA-65"]) &&
    !/UNVERIFIED/i.test(unverifiedSvg) &&
    unverifiedSvg.includes("not anchored yet"),
  JSON.stringify(words(unverifiedSvg)),
);
check("unverified anchor: the read names anchor_verified", String(db.reads[db.reads.length - 1][0]).includes("anchor_verified"));
const unverifiedInfo = await call(db.env, `/api/badge/${claimed}.json`);
const unverifiedBody = unverifiedInfo ? ((await unverifiedInfo.json()) as Record<string, unknown>) : {};
check(
  "unverified anchor json: anchored false, anchor_tx null, text without ANCHORED",
  unverifiedInfo?.status === 200 &&
    unverifiedBody.status === "ready" &&
    unverifiedBody.anchored === false &&
    unverifiedBody.anchor_tx === null &&
    unverifiedBody.text === "Q-READY · HARDENED · ML-DSA-65",
  JSON.stringify(unverifiedBody),
);

const legacy = stubDb(
  { [registered]: { mode: "hardened", anchor_tx: anchored, anchor_verified: 1, hash, registered_at: 1_760_000_000_000 } },
  false,
  true,
);
const legacyWarn = console.warn;
let legacyWarnings = 0;
console.warn = () => {
  legacyWarnings++;
};
const legacySvgRes = await call(legacy.env, `/api/badge/${registered}.svg`);
const legacySvg = legacySvgRes ? await legacySvgRes.text() : "";
const legacyJsonRes = await call(legacy.env, `/api/badge/${registered}.json`);
const legacyBody = legacyJsonRes ? ((await legacyJsonRes.json()) as Record<string, unknown>) : {};
const legacyNone = await call(legacy.env, `/api/badge/${wallet}.svg`);
const legacyNoneSvg = legacyNone ? await legacyNone.text() : "";
console.warn = legacyWarn;
check(
  "schema without anchor_verified: the badge still renders, the anchor counts as unverified",
  legacySvgRes?.status === 200 &&
    legacySvgRes.headers.get("cache-control") === "public, max-age=600" &&
    JSON.stringify(words(legacySvg)) === JSON.stringify(["DIRAC", "Q-READY", "HARDENED", "ML-DSA-65"]),
  JSON.stringify(words(legacySvg)),
);
check(
  "schema without anchor_verified: json 200, anchored false, anchor_tx null",
  legacyJsonRes?.status === 200 && legacyBody.status === "ready" && legacyBody.anchored === false && legacyBody.anchor_tx === null && legacyBody.hash === hash,
  JSON.stringify(legacyBody),
);
check("schema without anchor_verified: no passport is still NO PASSPORT", legacyNone?.status === 200 && words(legacyNoneSvg).includes("NO PASSPORT"));
check(
  "schema without anchor_verified: one failed read, then the older one, nothing logged",
  legacy.reads.length === 6 && !String(legacy.reads[1][0]).includes("anchor_verified") && legacyWarnings === 0,
  `${legacy.reads.length} reads, ${legacyWarnings} warnings`,
);
const none = await call(db.env, `/api/badge/${wallet}.json`);
const noneBody = none ? ((await none.json()) as Record<string, unknown>) : {};
check("json: unknown wallet is status none", none?.status === 200 && noneBody.status === "none" && noneBody.mode === null && noneBody.scheme === null && noneBody.text === "NO PASSPORT");
const site = await call({ ...db.env, SITE_URL: "https://dirac.example/" }, `/api/badge/${wallet}.json`);
check("json: SITE_URL wins over the request origin", ((await site?.json()) as Record<string, unknown>).page === `https://dirac.example/p?a=${wallet}`);
const badJson = await call(db.env, "/api/badge/nope.json");
check("json: invalid wallet is 400 { error }", badJson?.status === 400 && typeof ((await badJson.json()) as Record<string, unknown>).error === "string");

check("other paths are not handled", (await call(db.env, "/api/share/passport/x.png")) === null && (await call(db.env, "/api/badges/x.svg")) === null);
check("no extension or another one: 404", (await call(db.env, `/api/badge/${wallet}`))?.status === 404 && (await call(db.env, `/api/badge/${wallet}.png`))?.status === 404);
check("deeper path: 404", (await call(db.env, `/api/badge/${wallet}/x.svg`))?.status === 404);
const post = await call(db.env, `/api/badge/${wallet}.svg`, { method: "POST" });
check("POST: 405 with Allow", post?.status === 405 && post.headers.get("allow") === "GET, HEAD, OPTIONS");
check("OPTIONS: 204 with CORS", (await call(db.env, `/api/badge/${wallet}.svg`, { method: "OPTIONS" }))?.status === 204);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

/**
 * HTML responses. worker/index.ts serveAsset hands every text/html asset to
 * `finishHtml`, which sets the security headers and the
 * Content-Security-Policy, and writes the target of /scan?a=<wallet>,
 * /p?a=<wallet> and /pet into the head. It replaces share.ts `rewriteHtml`
 * (same og:* / twitter:* tags, from share.ts `pageMeta` and `metaTags`, one
 * D1 read) and adds the rest of the head.
 *
 * Per-target head. The static export has one HTML file per route, whatever
 * the query. For a valid wallet in ?a= on /scan and /p the Worker sets the
 * <title> ("Scan · 7xKq…9AsU · Dirac", the title the scan page also sets in
 * the browser) and <link rel="canonical"> (the page with ?a=, nothing else in
 * the query). For those two and /pet it sets <meta name="description"> and the
 * og:* / twitter:* tags. Tags Next emitted are updated in place, missing ones
 * are appended before </head>. Any other path, a missing or invalid ?a=
 * (canonical stays the bare route), a non-200 response or a D1 failure leaves
 * the head as Next built it.
 *
 * The RSC payload. Next renders the metadata again on the client: the tags
 * are React 19 hoistables, and when React mounts them it adopts an existing
 * <meta> only if name/property and content are both equal (a <link> by rel
 * and href); <title> is reused and its text reset to the static one. A head
 * rewritten on the server alone therefore gets a second, static set of
 * og:title, og:description, og:image, twitter:* ... after hydration, and its
 * static title back (production /p?a= on 2026-10-11: eight duplicated tags).
 * So the same values are also written into the page's inline payload,
 * `self.__next_f.push([1,"..."])`: the client then renders exactly the head
 * the server sent. Crawlers that do not run scripts read the rewritten head;
 * those that do (Googlebot) read the same head after hydration. When the
 * payload does not have the expected shape nothing in it changes and the
 * page works as before (with the duplicates). Client-side navigation to these
 * pages uses the static payload: the head is generic there, which only
 * people see.
 *
 * Content-Security-Policy. connect-src is 'self' blob:. Every fetch the pages
 * make goes to the site's own origin (src/lib/api.ts and friends with an empty
 * NEXT_PUBLIC_API_BASE in production builds, web3.js to /api/rpc, the Next
 * router's .txt payloads, the pet's GLB under /models); blob: is GLTFLoader
 * reading the textures embedded in the GLB. web3.js opens no WebSocket (no
 * subscriptions are used) and wallets talk to their extension through
 * postMessage, not the network. img-src keeps data: (Wallet Standard icons)
 * and https:, worker-src blob: and 'wasm-unsafe-eval' stay for the meshopt
 * decoder, style-src keeps 'unsafe-inline' (React style attributes, Framer
 * Motion).
 *
 * script-src keeps 'unsafe-inline' by default. In Chrome, Edge and Brave a
 * wallet cannot inject inline code into the page any more (Manifest V3; an
 * inline <script> a content script inserts is blocked by the extension's own
 * policy, checked in Chrome 155), and Phantom (world: MAIN content script),
 * Backpack and SafePal (<script src="chrome-extension://...">) load under a
 * hash-only policy. Firefox is different: the page's policy applies to
 * whatever a content script inserts (bugzilla 1267027, open), and Solflare's
 * Firefox add-on is Manifest V2 and closed source, so its injection could not
 * be checked. Set CSP_SCRIPT_HASHES to:
 *   "report": the enforced policy stays, the hash policy is sent as
 *             Content-Security-Policy-Report-Only (a violation shows in the
 *             browser console, nothing breaks): open /passport in Firefox
 *             with Solflare to see whether it injects inline code;
 *   "on":     script-src lists the sha256 of every inline script instead of
 *             'unsafe-inline'.
 * The hashes come from /_csp.json, which scripts/csp-hashes.ts writes after
 * `next build`; a payload script patched above is hashed here. No manifest,
 * or a page missing from it, falls back to 'unsafe-inline' and logs.
 */

import { escapeAttr, isWallet, metaTags, pageMeta, type Env as ShareEnv, type PageMeta } from "./share";

export interface Env extends ShareEnv {
  ASSETS: Fetcher;
  /** "on" enforces script-src hashes, "report" sends them report-only; unset keeps 'unsafe-inline'. */
  CSP_SCRIPT_HASHES?: string;
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

/** Every HTML response gets these and a Content-Security-Policy; HSTS is set by serveAsset for all assets. */
export const HTML_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** The whole policy for a script-src source list ('unsafe-inline' or the page's hashes). */
export function contentSecurityPolicy(scriptSources: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src ${["'self'", ...scriptSources, "'wasm-unsafe-eval'"].join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/** The default policy: inline scripts allowed (see the file header for why). */
export const CSP_INLINE = contentSecurityPolicy(["'unsafe-inline'"]);

type ScriptMode = "inline" | "hashes" | "report";

function scriptMode(env: Env): ScriptMode {
  const value = (env.CSP_SCRIPT_HASHES ?? "").trim().toLowerCase();
  if (value === "on") return "hashes";
  if (value === "report") return "report";
  return "inline";
}

/** Sets the policy headers; `hashes` null means no hash list for this page, so the inline policy only. */
function applyCsp(headers: Headers, mode: ScriptMode, hashes: readonly string[] | null): void {
  headers.delete("Content-Security-Policy-Report-Only");
  if (mode === "inline" || hashes === null) {
    headers.set("Content-Security-Policy", CSP_INLINE);
    return;
  }
  const hashed = contentSecurityPolicy([...new Set(hashes)].map((hash) => `'${hash}'`));
  if (mode === "hashes") {
    headers.set("Content-Security-Policy", hashed);
  } else {
    headers.set("Content-Security-Policy", CSP_INLINE);
    headers.set("Content-Security-Policy-Report-Only", hashed);
  }
}

/* ------------------------------------------------------------------ */
/* Script hashes (/_csp.json from scripts/csp-hashes.ts)               */
/* ------------------------------------------------------------------ */

export const CSP_MANIFEST_PATH = "/_csp.json";

export interface CspManifest {
  v: 1;
  /** route ("/", "/scan", "/404") → "sha256-<base64>" of every inline script in its HTML */
  pages: Record<string, string[]>;
}

const HASH_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;
const MANIFEST_RETRY_MS = 60_000;

/** The manifest when it has the expected shape, otherwise null. */
export function parseManifest(value: unknown): CspManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const { v, pages } = value as { v?: unknown; pages?: unknown };
  if (v !== 1 || typeof pages !== "object" || pages === null) return null;
  const out: Record<string, string[]> = {};
  for (const [route, hashes] of Object.entries(pages)) {
    if (!route.startsWith("/") || !Array.isArray(hashes)) return null;
    if (!hashes.every((hash) => typeof hash === "string" && HASH_PATTERN.test(hash))) return null;
    out[route] = hashes as string[];
  }
  return { v: 1, pages: out };
}

/**
 * The manifest key of a served page: "/404" for the not-found page, else the
 * path without a trailing slash, ".html" or a final "/index".
 */
export function manifestKey(pathname: string, status: number): string {
  if (status === 404) return "/404";
  let path = pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  path = path.replace(/\/+$/, "").replace(/\.html$/, "").replace(/\/index$/, "");
  return path === "" ? "/" : path;
}

// One read per isolate (an isolate serves one deployed version and its
// assets); a miss is retried after a minute rather than on every request.
let manifest: CspManifest | null = null;
let manifestMissUntil = 0;

async function loadManifest(env: Env, origin: string): Promise<CspManifest | null> {
  if (manifest !== null) return manifest;
  if (Date.now() < manifestMissUntil) return null;
  try {
    const res = await env.ASSETS.fetch(new Request(`${origin}${CSP_MANIFEST_PATH}`));
    if (res.ok) {
      const parsed = parseManifest(await res.json());
      if (parsed !== null) {
        manifest = parsed;
        return parsed;
      }
      console.warn("csp: /_csp.json has an unexpected shape");
    } else {
      await res.body?.cancel();
      console.warn("csp: /_csp.json missing, status", res.status);
    }
  } catch (error) {
    console.warn("csp: /_csp.json unreadable", error);
  }
  manifestMissUntil = Date.now() + MANIFEST_RETRY_MS;
  return null;
}

async function pageHashes(env: Env, url: URL, status: number): Promise<string[] | null> {
  const loaded = await loadManifest(env, url.origin);
  if (loaded === null) return null;
  const key = manifestKey(url.pathname, status);
  const hashes = loaded.pages[key];
  if (hashes === undefined) {
    console.warn("csp: no script hashes for", key);
    return null;
  }
  return hashes;
}

/** "sha256-<base64>" of a script's text, as CSP computes it (UTF-8 bytes). */
export async function scriptHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

/* ------------------------------------------------------------------ */
/* Per-target head                                                     */
/* ------------------------------------------------------------------ */

/** attribute name ("property" | "name"), its value and the content (share.ts metaTags). */
type MetaTag = ReturnType<typeof metaTags>[number];

export interface TargetHead {
  meta: PageMeta;
  /** the document title, or null to keep the one Next built */
  title: string | null;
  /** the canonical URL, or null to keep the one Next built */
  canonical: string | null;
}

/** `7xKq…9AsU`, as src/lib/solana/format.ts truncate. */
const shorten = (wallet: string): string => `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

/** Per-route title prefix; the static titles are "Scan · Dirac" and "Public passport · Dirac". */
const TITLE_LABELS: Readonly<Record<string, string>> = { "/scan": "Scan", "/p": "Public passport" };

/**
 * What the head of this request should say, or null when the request is not
 * one of /scan?a=, /p?a=, /pet (share.ts pageMeta: a valid wallet in ?a= on
 * /scan and /p; one D1 read).
 */
export async function targetHead(url: URL, env: ShareEnv): Promise<TargetHead | null> {
  const meta = await pageMeta(url, env);
  if (meta === null) return null;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const label = TITLE_LABELS[path];
  const wallet = (url.searchParams.get("a") ?? "").trim();
  if (label === undefined || !isWallet(wallet)) return { meta, title: null, canonical: null };
  return { meta, title: `${label} · ${shorten(wallet)} · Dirac`, canonical: meta.url };
}

/** The meta tags the head owns: the description and share.ts's og:* / twitter:* set. */
export function headTags(meta: PageMeta): MetaTag[] {
  return [["name", "description", meta.description], ...metaTags(meta)];
}

/* ------------------------------------------------------------------ */
/* RSC payload                                                         */
/* ------------------------------------------------------------------ */

export interface FlightEdits {
  title: string | null;
  canonical: string | null;
  tags: readonly MetaTag[];
}

const PUSH_PREFIX = "self.__next_f.push(";
const PUSH_SUFFIX = ")";
/** A JSON string literal. */
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
/** A row of the payload that holds a JSON array (the metadata row is one); text rows ("<id>:T<len>,") are left alone. */
const ARRAY_ROW = /^[0-9a-f]+:\[/;

/** A string as an RSC value: one starting with "$" is escaped as "$$...". */
const rscString = (value: string): string => JSON.stringify(value.startsWith("$") ? `$${value}` : value);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
/** Next's htmlEscapeJsonString: the payload sits in a <script>, so these are written as \u escapes. */
const HTML_JSON_ESCAPES: Readonly<Record<string, string>> = {
  "&": "\\u0026",
  ">": "\\u003e",
  "<": "\\u003c",
  [LINE_SEPARATOR]: "\\u2028",
  [PARAGRAPH_SEPARATOR]: "\\u2029",
};
const HTML_JSON_SPECIALS = new RegExp(`[&><${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, "g");
const htmlEscapeJson = (json: string): string => json.replace(HTML_JSON_SPECIALS, (c) => HTML_JSON_ESCAPES[c]);

/**
 * The payload with the metadata elements' values replaced (a development
 * build appends debug fields after the props object, hence no closing "]"):
 *   ["$","title","0",{"children":"Scan · Dirac"}]
 *   {"property":"og:title","content":"Scan · Dirac"}  /  {"name":"twitter:title","content":...}
 *   {"rel":"canonical","href":"https://.../scan"}
 * Only array rows are touched, and only a JSON string is ever replaced by
 * another one, so every row stays valid JSON.
 */
export function patchFlightPayload(payload: string, edits: FlightEdits): string {
  const replacers: [RegExp, string][] = [];
  if (edits.title !== null) {
    replacers.push([new RegExp(String.raw`(\["\$","title","[^"]*",\{"children":)${JSON_STRING}(\})`, "g"), rscString(edits.title)]);
  }
  for (const [attr, key, content] of edits.tags) {
    const prefix = `\\{"${attr}":${escapeRegExp(JSON.stringify(key))},"content":`;
    replacers.push([new RegExp(`(${prefix})${JSON_STRING}(\\})`, "g"), rscString(content)]);
  }
  if (edits.canonical !== null) {
    replacers.push([new RegExp(String.raw`(\{"rel":"canonical","href":)${JSON_STRING}()`, "g"), rscString(edits.canonical)]);
  }
  if (replacers.length === 0) return payload;
  return payload
    .split("\n")
    .map((row) => {
      if (!ARRAY_ROW.test(row)) return row;
      let next = row;
      for (const [pattern, value] of replacers) next = next.replace(pattern, (_match, head: string, tail: string) => `${head}${value}${tail}`);
      return next;
    })
    .join("\n");
}

/**
 * One inline script with the edits applied when it is a payload push
 * (`self.__next_f.push([1,"..."])`), re-encoded the way Next writes it;
 * any other script, or a payload without the elements, comes back unchanged.
 */
export function patchFlightScript(script: string, edits: FlightEdits): string {
  if (!script.startsWith(PUSH_PREFIX) || !script.endsWith(PUSH_SUFFIX)) return script;
  let args: unknown;
  try {
    args = JSON.parse(script.slice(PUSH_PREFIX.length, script.length - PUSH_SUFFIX.length));
  } catch {
    return script;
  }
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== 1 || typeof args[1] !== "string") return script;
  const payload: string = args[1];
  const patched = patchFlightPayload(payload, edits);
  if (patched === payload) return script;
  return `${PUSH_PREFIX}${htmlEscapeJson(JSON.stringify([1, patched]))}${PUSH_SUFFIX}`;
}

/* ------------------------------------------------------------------ */
/* Rewriting                                                           */
/* ------------------------------------------------------------------ */

/** The head rewriter for one target; payload scripts it changed are pushed onto `patched`. */
function headRewriter(head: TargetHead, patched: string[]): HTMLRewriter {
  const tags = headTags(head.meta);
  const wanted = new Map<string, MetaTag>();
  for (const tag of tags) wanted.set(`${tag[0]}=${tag[1]}`, tag);
  const seen = new Set<string>();
  const edits: FlightEdits = { title: head.title, canonical: head.canonical, tags };
  let titleSeen = false;
  let canonicalSeen = false;
  let script = "";

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
    .on("head > title", {
      element(element) {
        if (head.title === null || titleSeen) return;
        element.setInnerContent(head.title);
        titleSeen = true;
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        if (head.canonical === null) return;
        element.setAttribute("href", head.canonical);
        canonicalSeen = true;
      },
    })
    .on("script", {
      element() {
        script = "";
      },
      text(chunk) {
        script += chunk.text;
        if (!chunk.lastInTextNode) {
          chunk.remove();
          return;
        }
        const original = script;
        script = "";
        const next = patchFlightScript(original, edits);
        if (next !== original) patched.push(next);
        chunk.replace(next, { html: true });
      },
    })
    .on("head", {
      element(element) {
        element.onEndTag((end) => {
          let html = "";
          if (head.title !== null && !titleSeen) html += `<title>${escapeAttr(head.title)}</title>`;
          for (const [id, [attr, key, content]] of wanted) {
            if (seen.has(id)) continue;
            html += `<meta ${attr}="${escapeAttr(key)}" content="${escapeAttr(content)}"/>`;
          }
          if (head.canonical !== null && !canonicalSeen) html += `<link rel="canonical" href="${escapeAttr(head.canonical)}"/>`;
          if (html) end.before(html, { html: true });
        });
      },
    });
}

/**
 * The finished HTML response: security headers, the CSP for this page and,
 * for /scan?a=, /p?a= and /pet, the per-target head and payload. Call it for
 * every text/html asset response (worker/index.ts serveAsset).
 */
export async function finishHtml(response: Response, url: URL, env: Env): Promise<Response> {
  const mode = scriptMode(env);
  const { status, statusText } = response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(HTML_HEADERS)) headers.set(name, value);

  let head: TargetHead | null = null;
  if (status === 200) {
    try {
      head = await targetHead(url, env);
    } catch (error) {
      // the page must never break because of a preview
      console.warn("html: head rewrite skipped", url.pathname, error);
    }
  }
  const hashes = mode === "inline" ? null : await pageHashes(env, url, status);

  if (head === null) {
    applyCsp(headers, mode, hashes);
    return new Response(response.body, { status, statusText, headers });
  }

  // The body changes per query: the asset's length and validator no longer describe it.
  headers.delete("content-length");
  headers.delete("etag");
  const patched: string[] = [];
  if (hashes === null) {
    applyCsp(headers, mode, null);
    return headRewriter(head, patched).transform(new Response(response.body, { status, statusText, headers }));
  }
  // A hash policy has to name the patched payload script, which exists only
  // once the body has been rewritten: buffer it (pages are 20..120 KB).
  const body = await headRewriter(head, patched).transform(new Response(response.body, { status, statusText, headers })).arrayBuffer();
  applyCsp(headers, mode, [...hashes, ...(await Promise.all(patched.map(scriptHash)))]);
  return new Response(body, { status, statusText, headers });
}

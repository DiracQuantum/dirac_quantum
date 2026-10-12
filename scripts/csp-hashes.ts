/**
 * Post-build step: the sha256 of every inline <script> in the static export,
 * per page, for the script-src hash policy in worker/html.ts. Run from the
 * project root after `next build`:
 *   node scripts/csp-hashes.ts [dir=out] [--out <file>] [--check] [--manifest <file>]
 *
 * Writes <dir>/_csp.json (or --out <file>):
 *   { "v": 1, "pages": { "/": ["sha256-..."], "/scan": [...], "/404": [...] } }
 * Keys are the routes worker/html.ts manifestKey derives from a request:
 * out/index.html → "/", out/scan.html → "/scan", out/a/index.html → "/a",
 * out/404.html → "/404" (served for every unknown path).
 *
 * A script is inline when its start tag has no src attribute. The hash is
 * taken over its text with CR LF and lone CR turned into LF, as the HTML
 * parser does before CSP sees it; nothing else is decoded inside <script>.
 *
 * --check writes nothing: it extracts again, counts every "<script" in each
 * file independently of the extraction and verifies that each script was
 * classified (with src, or inline and hashed), and, with --manifest, that the
 * manifest lists every inline script's hash for its page. Exits 1 on any
 * mismatch.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Manifest {
  v: 1;
  pages: Record<string, string[]>;
}

interface PageScripts {
  route: string;
  file: string;
  /** scripts with a src attribute */
  external: number;
  /** text of every inline script, in document order */
  inline: string[];
}

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
function option(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const positional = args.filter((arg, i) => !arg.startsWith("--") && !["--out", "--manifest"].includes(args[i - 1] ?? ""));
const DIR = path.resolve(positional[0] ?? "out");
const OUT = path.resolve(option("--out") ?? path.join(DIR, "_csp.json"));
const CHECK = flag("--check");
const MANIFEST = option("--manifest");

/** Every .html file under dir, sorted. */
function htmlFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...htmlFiles(full));
    else if (name.toLowerCase().endsWith(".html")) found.push(full);
  }
  return found;
}

/** The route a file is served at: index.html is its directory, other files drop ".html". */
function routeOf(dir: string, file: string): string {
  const rel = path.relative(dir, file).split(path.sep).join("/").replace(/\.html$/i, "");
  const route = `/${rel}`.replace(/(^|\/)index$/, "");
  return route === "" ? "/" : route;
}

// A <script> start tag: attributes may hold ">" inside quotes. The element
// ends at the first "</script" followed by whitespace, "/" or ">" (HTML
// script data state; Next writes "<" inside its payload as <).
const SCRIPT = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script[\s/>]/gi;
const SRC_ATTR = /(?:^|\s)src\s*=/i;

/** The inline scripts and the count of external ones in one document. */
function scriptsOf(html: string): { external: number; inline: string[] } {
  let external = 0;
  const inline: string[] = [];
  for (const match of html.matchAll(SCRIPT)) {
    if (SRC_ATTR.test(match[1])) external++;
    else inline.push(match[2]);
  }
  return { external, inline };
}

/** "sha256-<base64>" of a script's text after the parser's newline normalisation. */
function hashScript(text: string): string {
  return `sha256-${createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("base64")}`;
}

function scan(dir: string): PageScripts[] {
  return htmlFiles(dir).map((file) => ({ route: routeOf(dir, file), file, ...scriptsOf(readFileSync(file, "utf8")) }));
}

function buildManifest(pages: PageScripts[]): Manifest {
  const out: Record<string, string[]> = {};
  for (const page of pages) out[page.route] = [...new Set(page.inline.map(hashScript))];
  return { v: 1, pages: out };
}

function check(pages: PageScripts[]): number {
  let failures = 0;
  const fail = (message: string): void => {
    console.log(`FAIL  ${message}`);
    failures++;
  };
  let listed: Manifest | null = null;
  if (MANIFEST !== null) listed = JSON.parse(readFileSync(path.resolve(MANIFEST), "utf8")) as Manifest;
  const routes = new Set<string>();
  for (const page of pages) {
    if (routes.has(page.route)) fail(`${page.route}: two files map to the same route`);
    routes.add(page.route);
    const html = readFileSync(page.file, "utf8");
    // Independent count: every "<script" opening, against what the extraction classified.
    const openings = (html.match(/<script[\s>/]/gi) ?? []).length;
    if (openings !== page.external + page.inline.length) {
      fail(`${page.route}: ${openings} <script> tags, ${page.external} external + ${page.inline.length} inline classified`);
    }
    if (listed !== null) {
      const have = new Set(listed.pages[page.route] ?? []);
      const missing = page.inline.filter((text) => !have.has(hashScript(text)));
      if (missing.length > 0) fail(`${page.route}: ${missing.length} inline script(s) have no hash in the manifest`);
    }
    console.log(`${page.inline.length > 0 ? "ok  " : "none"}  ${page.route}  ${page.inline.length} inline, ${page.external} external`);
  }
  if (listed !== null) {
    for (const route of Object.keys(listed.pages)) if (!routes.has(route)) fail(`${route}: in the manifest, no such page`);
  }
  return failures;
}

const pages = scan(DIR);
if (pages.length === 0) {
  console.error(`no .html files under ${DIR}`);
  process.exit(1);
}
if (CHECK) {
  const failures = check(pages);
  const inline = pages.reduce((n, page) => n + page.inline.length, 0);
  console.log(`\n${pages.length} pages, ${inline} inline scripts, ${failures} failure(s)`);
  process.exit(failures > 0 ? 1 : 0);
}
const manifest = buildManifest(pages);
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
const hashes = new Set(Object.values(manifest.pages).flat());
console.log(`csp: ${pages.length} pages, ${hashes.size} distinct inline script hashes → ${path.relative(process.cwd(), OUT) || OUT}`);

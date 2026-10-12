# Contract: embeddable passport badge

An SVG chip that says whether a Solana wallet carries a Dirac passport, for READMEs, profiles and sites. It reads the `passports` row (migrations/0001_init.sql) and links back to the public passport page `/p?a=<wallet>`, where every reader re-checks the signatures. The badge repeats what the registry holds; it proves nothing on its own, and the page says so.

## Files

- `src/lib/badge.ts`: shared by the Worker, the page and the self-test. `renderBadge(state, { size, theme }, wallet?)` → `{ svg, width, height }`, `badgeSegments`, `badgeSummary`, `stateFromRow`, `isBadgeWallet` (32 to 44 base58 characters decoding to 32 bytes), `escapeXml`, `parseBadgeSize` / `parseBadgeTheme` (fall back to m / dark), `badgePath(wallet, options?, "svg" | "json")` (only non-default options in the query), `passportPagePath`, `badgeSnippets(wallet, options, { api, site })` → `{ url, page, html, markdown }`, constants `BADGE_SIZES`, `BADGE_THEMES`, `BADGE_SCHEME`, `BADGE_ALT`, `BADGE_MAX_AGE_SECONDS`. Pure: no React, no DOM, no fetch; imports `@scure/base` only.
- `worker/badge.ts`: `handleBadge(request, env, ctx, parts, url): Promise<Response | null>`, plus `etagOf` for tests. Reads `env.DB` and `env.SITE_URL` (both already in `Env`).
- `src/components/app/BadgeEmbed.tsx`: the Badge panel on `/p` (preview from the API, size and theme toggles, HTML / Markdown / URL with copy buttons) and `useSiteOrigin()`.
- `src/app/p/page.tsx`: the Badge panel after the share card for a registered passport; "Share an invite link" (the Blink of `/invite/<wallet>`, `inviteBlinkUrl` from `src/lib/blink.ts`) in the not-found state only; a line in the Inbox panel pointing holders to look up a friend's wallet, whose page carries that link.
- `scripts/badge-selftest.ts`: `node scripts/badge-selftest.ts [--write <dir>]`.

## Routes

`GET` and `HEAD` only; `OPTIONS` 204 with CORS; any other method 405 `{ error }` with `Allow: GET, HEAD, OPTIONS`. A path under `/api/badge/` that is not `<wallet>.svg` or `<wallet>.json` is 404 `{ error }`; paths outside `/api/badge` return `null`.

### `GET /api/badge/:wallet.svg[?size=s|m&theme=dark|light]`

- `size`: `s` is 20 px tall, `m` (default) 28 px. `theme`: `dark` (default) is ink `#070708` with paper `#f2f1ec` text, `light` the inverse. Any other value falls back to the default: a badge never fails on its query.
- Words, left to right: the Dirac mark and `DIRAC`, then
  - registered passport: a signal dot and `Q-READY`, then the mode and `ANCHORED` when `anchor_tx` is set (`HARDENED · ANCHORED`, `SIMPLE`, ...), then `ML-DSA-65`;
  - valid wallet, no passport: `NO PASSPORT`;
  - a path that is not a Solana address (or does not percent-decode): `INVALID ADDRESS`, without reading D1;
  - D1 failure: `UNAVAILABLE`.
- Always 200 with a badge: an `<img>` must never break the page that embeds it. Widest variant: 410 × 28 (m), 313 × 20 (s).
- Headers: `Content-Type: image/svg+xml; charset=utf-8`, `Cache-Control: public, max-age=600` (`public, max-age=60` for UNAVAILABLE), `ETag` (strong, 24 hex of the SHA-256 of the body; `If-None-Match` answers 304), `Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin` (pages with COEP can embed it), `Content-Disposition: inline; filename="dirac-badge-<8 chars>.svg"`.
- The document: `<svg>` with `role="img"`, an `aria-label` and a `<title>` (the state in one sentence, the wallet shortened to `7xKq…9AsU`), a rounded rect, hairline dividers, the mark as one path, status dots, `<text>` in a system monospace stack (`ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace`) with `textLength` per word, so the layout holds in any monospace face. No script, style, link, image, `use`, `foreignObject`, `url()` or web font. Every text is escaped; nothing from the request is echoed except a validated wallet in the title.
- Unknown query parameters are ignored (the page adds `v=<hash prefix><a|u>` to its own preview so the browser does not show a badge cached before the record changed).

### `GET /api/badge/:wallet.json`

200, `Cache-Control: public, max-age=600`, ETag as above:

```json
{
  "wallet": "<base58>",
  "status": "ready" | "none",
  "text": "Q-READY · HARDENED · ANCHORED · ML-DSA-65" | "NO PASSPORT",
  "summary": "Dirac passport of 7xKq…9AsU: Q-ready, hardened, anchored on Solana, ML-DSA-65",
  "mode": "simple" | "hardened" | null,
  "anchored": true | false,
  "anchor_tx": "<base58>" | null,
  "scheme": "ML-DSA-65" | null,
  "hash": "<hex sha256 of the canonical passport>" | null,
  "registered_at": 1760000000000 | null,
  "page": "<site>/p?a=<wallet>",
  "badge": "<site>/api/badge/<wallet>.svg"
}
```

`<site>` is `SITE_URL` when set, otherwise the request origin. 400 `{ error }` for an invalid wallet, 503 `{ error }` with `Retry-After: 60` when D1 fails.

### Load

One primary-key read per request, no write. No rate limit, like the other read routes (`GET /api/passports/:wallet`, `GET /api/share/...`): image proxies such as GitHub's camo fetch for many pages from one address, a 429 would break the image, and the shared `ratelimit` counter costs a D1 write per request where the badge costs one read. Browsers and proxies cache for ten minutes and revalidate with the ETag.

## Embed snippets

Medium, dark (the defaults, no query):

```html
<a href="https://dirac.deeper-cf.workers.dev/p?a=<wallet>"><img src="https://dirac.deeper-cf.workers.dev/api/badge/<wallet>.svg" alt="Dirac post-quantum passport" height="28"></a>
```

```markdown
[![Dirac post-quantum passport](https://dirac.deeper-cf.workers.dev/api/badge/<wallet>.svg)](https://dirac.deeper-cf.workers.dev/p?a=<wallet>)
```

Small, light: `https://dirac.deeper-cf.workers.dev/api/badge/<wallet>.svg?size=s&theme=light` (in HTML the `&` is written `&amp;`, `height="20"`). The alt text does not name the state, which changes when the passport is anchored. The `/p` page builds these with the page's origin (`NEXT_PUBLIC_SITE_URL` when set) and the API origin (`NEXT_PUBLIC_API_BASE`, the same origin in production).

## Integrator duties

`worker/index.ts`, two lines. Next to the other module imports:

```ts
import { handleBadge } from "./badge";
```

In `route()`, right after `const parts = url.pathname.split("/").filter(Boolean);` and before the `decodeSegment` check (that check answers 400 JSON `malformed path` for a segment that does not percent-decode, which would turn an embedded badge into a broken image; `handleBadge` returns `null` for every path outside `/api/badge`, so it cannot shadow another route):

```ts
  const badge = await handleBadge(request, env, ctx, parts, url);
  if (badge) return badge;
```

No Env field, migration or wrangler change. The generic OPTIONS answer in `fetch` covers the preflight (a GET of an image or a plain JSON fetch is never preflighted anyway).

`public/robots.txt`: add `Allow: /api/badge/` next to `Allow: /api/share/`, above `Disallow: /api/`, so crawlers that honour robots.txt fetch embedded badges.

## Checks

`npx tsc --noEmit`, `npx tsc -p worker`, `npx eslint worker/badge.ts src/lib/badge.ts src/components/app/BadgeEmbed.tsx src/app/p/page.tsx scripts/badge-selftest.ts`, `node scripts/badge-selftest.ts` (76 checks: an XML well-formedness checker and an element / attribute allow-list over all 32 variants, escaping and a hostile wallet string, wallet validation, words, sizes, themes, snippets, and the routes with a stubbed D1: unknown wallet, registered passports, invalid path, D1 failure, ETag / 304, HEAD, JSON, 404 / 405 / OPTIONS). A local run (`npx wrangler dev --local` with the module mounted in front of the Worker) with curl on every route, and `/p` against it in headless Chrome at 1440 and 375 px.

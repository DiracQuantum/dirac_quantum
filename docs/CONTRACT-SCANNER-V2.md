# Scanner v2 contract (QA fixes)

Supersedes the report shape in docs/CONTRACT-SCANNER.md. Everything else in CONTRACT.md and CONTRACT-SCANNER.md still applies (lint rules, design classes, data sources). Motivation, from external QA of the live site:

1. A single "readiness 95/100" misleads: a passport does not change who can move the SOL, tokens and NFTs. Replace the score with three separate indicators.
2. Any address was treated as a signing wallet; the System Program `11111111111111111111111111111111` got "create a passport" and authorities set to `111…111` (burned) counted as live control.
3. When an RPC call failed, panels showed zeros ("0 transactions", "No authority is held") and the report could be shared; partial reports must say "Unavailable / not checked", must not be shareable and must not be cached.
4. "No multisig −5" was applied although multisig detection does not exist; it must read "unknown" with no penalty.
5. DAS returned exactly 1000 assets (the page limit) and the UI showed it as an exact count.
6. Share links hard-code https://dirac.network (does not resolve); use the current origin.
7. No per-page titles/H1, footer still says "Example data until launch", no HTTPS redirect, no HSTS/CSP, no rate limiting on /api/scan, wallet connection state invisible on subpages.

## Report shape v2 (`src/lib/scan.ts`; the Worker imports these types)

```ts
export type AddressKind = "wallet" | "pda" | "program" | "mint" | "token-account" | "stake-account" | "system" | "unknown";
export type SourceStatus = "ok" | "failed" | "skipped" | "truncated";
export type SourceName = "address" | "balance" | "assets" | "signatures" | "stake" | "mintAuthorities" | "programAuthorities" | "price" | "registry";
export interface SourceState { status: SourceStatus; error?: string }   // error: short human message when failed/skipped/truncated
export type Confidence = "complete" | "partial" | "unavailable";
export type IdentityLevel = "none" | "simple" | "hardened";

export interface ScanToken { mint: string; symbol: string; name: string; amount: number; decimals: number; usd: number | null }
export interface ScanAuthorityMint { mint: string; supply: number | null; role: "mint" | "freeze" | "both" }

export interface ScanReport {
  v: 2;
  wallet: string;
  scannedAt: number;                       // unix ms
  address: {
    kind: AddressKind;
    executable: boolean;
    owner: string | null;                  // owner program of the account, null when the account does not exist (never funded)
    onCurve: boolean;                      // Ed25519 point decodes: a key can exist
    exists: boolean;
    note: string;                          // one sentence a reader can act on, e.g. "A program: nobody holds a private key for it."
  };
  sources: Record<SourceName, SourceState>;
  confidence: Confidence;                  // complete: every source ok; unavailable: balance AND assets failed; otherwise partial
  limited: boolean;                        // no private RPC configured
  sol: number | null;                      // null when the source failed (never 0 for a failed read)
  solUsd: number | null;
  tokens: ScanToken[];                     // top 25
  tokenCount: number | null;
  tokensUsd: number | null;                // sum over priced tokens, null when assets failed
  nfts: number | null;
  assetsTruncated: boolean;                // DAS pages exhausted at the cap: counts are lower bounds
  stakeSol: number | null;
  stakeAccounts: number | null;
  txCount: number | null;                  // 1000 = "1000+"
  lastActivity: number | null;             // unix s
  oldestSeen: number | null;
  authorities: {
    mints: ScanAuthorityMint[];            // checked across the tokens the wallet holds, cap 20
    programs: string[];                    // ProgramData accounts with this upgrade authority, cap 50
    burnedIgnored: number;                 // authorities equal to 111…111 or other off-curve/system values that were ignored
    status: "ok" | "partial" | "unavailable";
  };
  multisig: "unknown";                     // detection not implemented in v2; shown as unknown, never penalised
  passport: { hash: string; mode: "simple" | "hardened"; anchored: boolean; anchorTx: string | null } | null;
  exposure: {                              // what this single Ed25519 key can move today
    usd: number | null;                    // sol + priced tokens + stake, at SOL price; null when a core source failed or no price
    sol: number | null;                    // SOL + stake in SOL
    lines: { label: string; usd: number | null; note?: string }[];   // "SOL balance", "Tokens (priced)", "Stake", "Authority over mints (supply × price unknown)" etc.
    note: string;                          // "A Dirac passport does not change this: whoever signs with the Ed25519 key moves these assets."
  };
  identity: {
    level: IdentityLevel;
    anchored: boolean;
    note: string;                          // what it means, e.g. "Hardened passport, anchored: identity and documents survive Q-Day; assets do not."
  };
  recommendations: string[];               // derived facts, max 5, no fear language
}
```

Rules:
- Address classification first (`getAccountInfo` jsonParsed + on-curve check with @noble/curves ed25519 `Point.fromHex` / decode in try/catch, plus the known list: System Program, sysvars, token programs, BPF loaders → "system"/"program"). Only `kind === "wallet"` gets the passport/identity recommendations and the "whoever can sign" wording. For "pda"/"program"/"mint"/"token-account"/"stake-account"/"system": still report balances/assets where meaningful, but `identity.note` explains that no private key exists and recommendations stay empty except "Nothing to do here". Authorities that equal `11111111111111111111111111111111` or are off-curve are counted in `burnedIgnored`, not as control.
- Every source failure → `sources[x] = { status: "failed", error }` and the related fields are `null`; the UI renders "Unavailable" / "not checked". Skipped (no private RPC) → `"skipped"`. DAS pagination: read up to 3 pages of 1000; if the last page was full, `assetsTruncated = true` and `sources.assets = { status: "truncated", error: "more than 3000 assets, counts are lower bounds" }`.
- `confidence` as defined above. Partial/unavailable reports are returned with `Cache-Control: no-store` and never written to the cache. Complete reports: 60 s.
- No overall score anywhere. `exposure`, `identity`, `confidence` are the three headline indicators.
- Multisig: not checked; `multisig: "unknown"`; no penalties exist any more (there is no score).
- Recommendations (wallet kind only): no passport → "Create a Dirac passport"; simple → "Switch to hardened mode"; not anchored → "Anchor the passport on Solana"; authorities.mints/programs non-empty → "Move authorities to a multisig (Squads)"; lastActivity older than 180 days with exposure ≥ 1 SOL → "Rotate dormant holdings to a fresh key"; exposure.usd ≥ 10 000 → "Large balance under one key: split across keys or a multisig".

## Worker changes (worker/index.ts, wrangler.jsonc)

- `GET /api/scan/:wallet` returns v2. Keep helpers; add `classifyAddress`.
- Rate limiting: add a Workers rate-limit binding in wrangler.jsonc: `"ratelimits": [{ "name": "SCAN_LIMITER", "namespace_id": "1001", "simple": { "limit": 12, "period": 60 } }]` and `SCAN_LIMITER: RateLimit` in Env; key = `cf-connecting-ip` header (fallback "anon"); apply to `/api/scan/*` (12 per minute) and to `/api/rpc` with a second binding `RPC_LIMITER` (`namespace_id: "1002"`, 120 per minute). Over the limit → 429 JSON `{ error: "rate limited, try again in a minute" }` with `Retry-After: 60`.
- Security: set `"run_worker_first": true` in wrangler.jsonc assets config so every request passes through the Worker. For non-API requests: if `url.protocol === "http:"` → 301 to the https URL. Otherwise fetch from `env.ASSETS` and return the response with added headers: `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, and `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`. Keep the existing prefetch-path rewrite. Only add the headers to HTML responses (content-type text/html); other assets pass through untouched except HSTS.
- CSP note (2026-10-11, supersedes the policy above): the HTML headers and the policy now live in `worker/html.ts` (`finishHtml`, called by serveAsset for every text/html asset). `connect-src` is `'self' blob:` (every runtime fetch is same-origin: /api, /api/rpc for web3.js, the router's .txt payloads, /models; blob: is GLTFLoader reading textures embedded in the GLB; no WebSocket, wallets talk to their extension, not the network). `script-src` keeps `'unsafe-inline'` by default: Chromium wallets cannot inject inline code under Manifest V3 (Phantom uses a MAIN-world content script, Backpack and SafePal `<script src="chrome-extension://…">`, all of which run under a hash-only policy), but Firefox applies the page policy to what content scripts insert and Solflare's Firefox add-on (Manifest V2, closed source) could not be checked. `CSP_SCRIPT_HASHES=report` sends the hash policy as Content-Security-Policy-Report-Only, `=on` enforces it; the per-page hashes come from `out/_csp.json`, written by `node scripts/csp-hashes.ts out` after `next build`. A Draco-compressed GLB would need its decoder self-hosted (drei's default fetches it from www.gstatic.com, which connect-src no longer allows).

## Frontend changes

- `src/app/scan/page.tsx` + `src/components/scan/*`: render the three indicators as the headline (Quantum exposure in USD with its lines; PQ identity level + anchored; Data confidence with a list of what was and was not read). Every panel reads `sources` and shows "Unavailable" / "not checked" (mono, muted, with the short error on hover or inline) instead of zeros; counts show "1000+" and "lower bound" when truncated. Address kinds other than wallet get an explanatory banner at the top and no passport CTA. Share buttons (PNG, X, copy link) are disabled with a note when `confidence !== "complete"`. The share card shows: wallet, "Quantum exposure $X under one Ed25519 key", "PQ identity: none / simple / hardened (anchored)", "Data: complete", date. The X text: "Quantum exposure of my Solana wallet: $X under one key. PQ identity: <level>. Check yours." Share URL and card footer use `window.location.origin` read inside the click handler (never during render), with `process.env.NEXT_PUBLIC_SITE_URL` taking precedence when set.
- Nav (`src/components/ui/Nav.tsx`): render the wallet state on every page: when connected, a `chip` with the truncated address and a disconnect action (reuse `ConnectButton` in compact mode, add a `compact` prop to it if needed); when not connected, a small ghost "Connect" pill next to "Create passport". The provider's silent reconnect on load already restores the connection.
- Titles: root layout `metadata.title = { default: "Dirac", template: "%s · Dirac" }`; add `layout.tsx` files (server components, just `export const metadata` + pass-through) for `/scan` ("Scan"), `/passport` ("Passport"), `/seal` ("Seal"), `/p` ("Public passport") with descriptions. Each page's chapter title must be an `<h1>` (ChapterHeader gets an `as?: "h1" | "h2"` prop; app pages pass "h1").
- Footer: drop "Example data until launch"; keep the colophon.
- Nothing else on the landing changes.

## Out of scope (documented, not built)

- Backpack's "blocked this origin" warning comes from its domain reputation list; `*.workers.dev` hosts are commonly flagged. The fix is a custom domain on the Worker, then a review request with Backpack/Blowfish.
- Attaching the PNG to the X intent is not possible (intents take text and a URL only). Per-report og:image needs server-rendered images; deferred.
- Squads multisig detection: deferred to v3; v2 reports "unknown".
- Helius key restrictions (allowed origins/quota) are set in the Helius dashboard by the owner.

## v3: Squads multisig detection

Adds to the v2 shape; nothing from v2 is removed except the placeholder `multisig: "unknown"`, replaced by `multisigs`. `v` is `3`. Code: `worker/squads.ts` (pure parsing, PDAs, the member search), the scan section of `worker/index.ts`, `src/lib/scan.ts`, `src/components/scan/ReportPanels.tsx` (Control panel), `scripts/squads-selftest.ts`.

```ts
export type AddressKind = /* v2 kinds */ | "multisig";    // a Squads v4 multisig account: owner SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf and the account parses
export type SourceName = /* v2 names */ | "multisigs";

export interface ScanMultisigMember { key: string; mask: number; initiate: boolean; vote: boolean; execute: boolean }   // mask bits: initiate 1, vote 2, execute 4
export interface ScanVault {
  address: string; index: number;            // vault 0 only: seeds ["multisig", multisig, "vault", 0] under the program
  sol: number | null;                        // null when getBalance failed
  tokensUsd: number | null;                  // priced tokens on the first DAS page; null when DAS failed or was skipped
  tokenCount: number | null;
  usd: number | null;                        // sol × SOL price + tokensUsd; null without a balance or a price
  note: string;                              // what is missing from usd: "tokens not checked", "tokens are a lower bound", "no SOL price", ""
}
export interface ScanMultisigAccount {
  address: string; createKey: string;
  configAuthority: string | null;            // null when 111…111 (the multisig governs itself)
  threshold: number; timeLock: number;       // k of n; seconds between approval and execution
  memberCount: number; members: ScanMultisigMember[];   // first 16 members; memberCount is the real count
  transactionIndex: number;
  vault: ScanVault | null;                   // null when not valued (beyond the first 10 memberships)
}
export interface ScanMultisigs {
  self: ScanMultisigAccount | null;          // set when the scanned address is a multisig
  memberOf: ScanMultisigAccount[];           // multisigs listing the address in one of their first 10 member slots, cap 20
  memberOfTruncated: boolean;                // cap hit, or a slot search ran out of pages: lower bound, memberships may be missing
  coControlledUsd: number | null;            // Σ vault.usd over memberOf; reported apart from exposure, never added to it
  coControlledSol: number | null;
  valued: number;                            // memberOf entries with a vault value
  note: string;                              // one sentence: what was found and the search coverage
}
export interface ScanReport { v: 3; /* v2 fields */ multisigs: ScanMultisigs }
```

Rules:
- Classification: an account owned by the Squads v4 program whose data parses as `Multisig` (8-byte discriminator `sha256("account:Multisig")[0..8]`, Option-encoded `rent_collector`, members at offset 100 or 132) is kind `"multisig"`; `address.note` carries "k of n member keys sign". It is off-curve, so `hasKey` stays false: `exposure` is the account's own holdings (rent), `exposure.note` points at the vaults, `identity.note` says a passport binds to a member's wallet.
- Membership search (every address except system ones and multisig accounts: a multisig's own memberships are not searched, nested multisigs are rare and a multisig scan adds the vault reads only): 20 filtered `getProgramAccounts` (discriminator at 0, the address at each of the first 10 member slots under both layouts), pubkeys only (`dataSlice 0/0`; a value that is not a 32-byte base58 key is dropped), then one `getMultipleAccounts` for the bodies. The calls are `getProgramAccountsV2` on the private RPC with `limit 10000` and pagination: a page scans a bounded slice of the program and may come back empty with a `paginationKey` (one or two pages per slot when the index is idle, more under load; at most 12 pages per slot, then the slot counts as exhausted). The indexed calls of every search in flight on an isolate share one rate gate: at least 125 ms apart between them all (eight per second, under the Helius free tier's ten; two scans at once still make eight, not sixteen), three slots in flight per search. A failed slot is retried three times with a backoff of 1 s, 2 s and 4 s (plus up to a quarter of jitter) that also holds the gate, so the other slots pause while a 429 clears. There is no public fallback from the Worker: the one free node verified (2026-10) to serve filtered scans of this program from an ordinary client, `https://api.mainnet.solana.com`, answers 403 "Your IP or provider is blocked" from workerd (publicnode and leorpc refuse outright), so without a private RPC the source is `skipped`; `worker/squads.ts` still takes an optional public caller, which only the self-test uses. The search runs in the second phase, after the first batch of reads has settled, so the scan's initial burst stays under the private RPC's per-second limit; it stops early once 20 are found. A completed search is kept in the edge cache under `/api/scan/.multisigs/<wallet>` with its `searchedAt` (memberships change rarely, a search is 20 to 60 calls): served as is for 15 minutes, and for up to an hour when a fresh search fails (the index refusing a burst), in which case `multisigs.note` dates it ("Memberships are from a search N minutes ago; the index did not answer just now") and the source stays `ok`. Both layouts exist on mainnet (91 k with a rent collector, 67 k without, of 158 k multisigs); 99.9 % of multisigs have at most ten members.
- Vault 0 of `self` and of the first 10 memberships is valued with `getBalance` plus one DAS page (`fetchHoldings` with `maxPages = 1`), two at a time. Without a private RPC the tokens are "not checked" and `usd` is SOL only.
- `sources.multisigs`: `ok` (also for a multisig account, whose `memberOf` is empty by construction); `skipped` for a system address or without a private RPC; `failed` with the error when a slot could not be searched at all and no earlier list stands in (the report says "Unavailable", the scan itself never fails); `truncated` when memberships exceed the cap, a slot ran out of pages, vaults beyond the first 10 were not valued, or a vault read was incomplete (error names it). `confidence` keeps its v2 definition, so a truncated or failed multisig source makes the report partial.
- Timing and cost: a wallet scan grows by the search (about 3 to 5 s uncached, 30 to 60 `getProgramAccountsV2` calls on the private RPC, each billed as a getProgramAccounts) plus two reads per valued vault; a cached search costs nothing. A multisig scan adds the vault reads only.
- Recommendations: kind `multisig` → "The signer keys are the exposure: …" and "Raise the threshold and rotate members to fresh keys; scan each member wallet". A wallet with memberships gets "Member of N Squads multisig(s): raise their thresholds and rotate members to fresh keys" after the authority line, within the cap of 5.
- The quantum exposure indicator stays the key's own figure. The co-controlled total appears only in the Control panel ("Co-controlled through multisigs", with "not in Quantum exposure") and in the blast-radius sentence ("one of the keys on N Squads multisigs holding $X, which it cannot move alone").
- Limits, stated in the Methodology panel: Squads v4 only (no v3, no other multisig programs), the first 10 member slots, vault 0 only, members cut at 16 in the report, the first page of vault tokens.
- Worker entry exports: `KNOWN_SYSTEM_ADDRESSES` and `PROGRAM_DATA_DISCRIMINANT` are no longer exported; workerd rejects a non-function export from the entry module ("Incorrect type for map entry") and `wrangler dev` would not start.

Verification: `node scripts/squads-selftest.ts` (fixtures from three mainnet accounts, garbage never throws, vault PDA matches the funded vault, the search against a fake RPC merges, dedupes, caps, drops non-key strings, falls back, shares one gate between concurrent searches and backs off from a 429 while holding it); `node scripts/squads-selftest.ts http://localhost:8794` adds live scans of a multisig (`12dEW8L9GqAXTkFKkz1wWRzFZCMmiPeYkX7Vg7FqFp2`), its member (`2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE`) and a plain wallet; set `SQUADS_PAUSE_MS=45000` when the local Worker's `RPC_URL` is the production proxy, whose 120 calls per minute per client one scan can spend half of.

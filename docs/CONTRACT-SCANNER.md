# Dirac scanner contract (v0.1)

Builds on docs/CONTRACT.md (read it first: stack facts, lint rules, design classes, module layout). The scanner answers one question: how much depends on this one Ed25519 key, and what to do about it. Methodology is public and must be shown on the page.

## Data source

The Worker already proxies Solana JSON-RPC at `POST /api/rpc` with upstream order `[env.RPC_URL, ...free fallbacks]`. For the scanner the Worker calls the upstream directly (same helper, not through its own HTTP route). `env.RPC_URL` is expected to be a Helius endpoint (`https://mainnet.helius-rpc.com/?api-key=...`), which also serves the DAS methods below. When `env.RPC_URL` is unset, DAS and getProgramAccounts calls are skipped and the report carries `limited: true` with the reasons; balance and signatures still use the fallbacks (they may fail; return partial data with `errors[]` rather than a 500).

SOL/USD price: `https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd` (cache 5 min with the Cache API; on failure `solUsd: null`).

## Module A: Worker `GET /api/scan/:wallet` (+ `src/lib/scan.ts` types and client)

Add to `worker/index.ts` (keep the existing style: helpers, CORS, json()). Response is cached for 60 s per wallet with `caches.default` (key = request URL). Validate the wallet as base58 of 32 bytes.

Calls (all tolerate failure; each failure appends a short string to `errors`):
1. `getBalance` → lamports.
2. DAS `getAssetsByOwner` `{ ownerAddress, page: 1, limit: 1000, displayOptions: { showFungible: true, showNativeBalance: true, showZeroBalance: false } }` → fungible tokens: for items with `interface` "FungibleToken" or "FungibleAsset": `{ mint: id, symbol: token_info.symbol ?? content.metadata.symbol ?? "?", name, amount: token_info.balance / 10^decimals, decimals, usd: token_info.price_info?.total_price ?? null }`; NFTs = items that are not fungible (count them). Sort tokens by usd desc then amount desc; keep the top 25 in the response, but sum `tokensUsd` over all.
3. `getSignaturesForAddress` `[wallet, { limit: 1000 }]` → `txCount` (1000 means "1000+"), `lastActivity` (blockTime of the newest, unix seconds), `oldestSeen` (blockTime of the oldest in that page).
4. Stake: `getProgramAccounts` on `Stake11111111111111111111111111111111111111` with `{ encoding: "jsonParsed", filters: [{ memcmp: { offset: 44, bytes: wallet } }] }` (withdraw authority) → `stakeLamports` = sum of lamports; `stakeAccounts` count.
5. Mint authorities: `getProgramAccounts` on `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` with `{ encoding: "jsonParsed", filters: [{ dataSize: 82 }, { memcmp: { offset: 4, bytes: wallet } }] }` → mints where the wallet is mint authority; same with offset 50 for freeze authority. Also the Token-2022 program `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` with only the memcmp filters (no dataSize, extensions change the size) — cap at 200 results. For each unique mint (cap 20): `getTokenSupply` → `{ mint, supply (ui amount), role: "mint" | "freeze" | "both" }`.
6. Program upgrade authorities: `getProgramAccounts` on `BPFLoaderUpgradeab1e11111111111111111111111` with `{ encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: "4" } }, { memcmp: { offset: 13, bytes: wallet } }] }` → ProgramData accounts whose upgrade authority is the wallet (`"4"` is base58 for the single byte 0x03, the ProgramData discriminant; verify by trying the equivalent `bytes` for [3,0,0,0] at offset 0 which base58-encodes to "2VfUX" and use that instead if the single-byte filter is wrong; the integrator can test both). Return `{ programData: pubkey }` entries (cap 50).
7. Registry: look up the passport row for the wallet in D1 → `{ hash, mode, anchored: boolean, anchor_tx }` or null.

Report shape (export the types from `src/lib/scan.ts` and import them in the Worker):
```ts
export interface ScanToken { mint: string; symbol: string; name: string; amount: number; decimals: number; usd: number | null }
export interface ScanAuthorityMint { mint: string; supply: number | null; role: "mint" | "freeze" | "both" }
export interface ScanReport {
  v: 1;
  wallet: string;
  scannedAt: number;                 // unix ms
  limited: boolean;                  // true when no private RPC (DAS/gPA skipped)
  errors: string[];
  sol: number;                       // SOL balance
  solUsd: number | null;             // price
  tokens: ScanToken[];               // top 25
  tokenCount: number;
  tokensUsd: number;                 // sum over all tokens with a price
  nfts: number;
  stakeSol: number;
  stakeAccounts: number;
  txCount: number;                   // 1000 means 1000+
  lastActivity: number | null;       // unix seconds
  oldestSeen: number | null;         // unix seconds, within the last 1000 signatures
  authorities: { mints: ScanAuthorityMint[]; programs: string[] };
  passport: { hash: string; mode: "simple" | "hardened"; anchored: boolean; anchorTx: string | null } | null;
  score: number;                     // 0..100 readiness
  breakdown: { label: string; delta: number; note: string }[];
  totalUsd: number | null;           // sol*solUsd + tokensUsd + stakeSol*solUsd when price known
}
export async function fetchScan(wallet: string): Promise<ScanReport>;   // GET `${API_BASE}/api/scan/${wallet}`, throws with the server's error message
export function isValidWallet(s: string): boolean;                      // base58 decode to 32 bytes
```

Readiness score (`methodology v1`, computed in the Worker, also documented verbatim on the page):
- start at 100
- no passport: −30; passport but not anchored: −15; passport in simple mode: −5
- dormant: no activity for > 365 days and holdings ≥ 1 SOL equivalent: −20; > 180 days: −10
- each mint authority held: −8 (cap −24); each program upgrade authority: −10 (cap −30)
- authorities held and no multisig detected (always true in v1, Squads detection comes later): −5
- stake ≥ 100 SOL under a single key: −5
- clamp to 0..100. Each applied rule becomes a breakdown line; rules that did not apply are omitted. Scores are rounded integers.

## Module B: pages and wiring

`src/app/scan/page.tsx` ("use client", static export, reads `?a=` via useSearchParams inside Suspense; when no `a`, shows an input form with "Scan" and "Use connected wallet" (from useWallet)). States: idle form, loading (skeleton rows with the chapter header), error panel (readable message, retry), report.

Report layout (reuse the landing's visual language, `panel` cards, `eyebrow`, `display` titles, `tnum` numbers):
- Header: "02 / EXPOSURE REPORT" eyebrow, wallet (mono, copy button), scanned time; title "What hangs on one key." with a `display-serif` second line.
- Score block: big `display` number `score/100`, a 1.5 px bar, and the breakdown list (label, delta as "−20", note).
- Holdings panel: SOL (and USD), top tokens table (symbol, amount with tabular numerals, USD), NFTs count, stake SOL, total USD.
- Control panel: mint authorities (mint truncated with copy, supply, role), program upgrade authorities (program data pubkeys truncated), "Blast radius" note = what depends on this key.
- Activity panel: last activity ("3 days ago", absolute date in mono), tx count ("1000+"), oldest seen.
- Passport panel: registry status with a link to `/p?a=` or the CTA "Create passport" → `/passport`.
- "Do this first" recommendations derived from the breakdown (passport, anchor, multisig for authorities, rotate dormant holdings).
- Methodology panel: the rules above, verbatim, plus "limited data" notice when `limited`, and the errors list collapsed under "What could not be read".
- Share: a `canvas`-rendered 1200×630 PNG card (black background, paper text, the score, wallet truncated, "dirac.network/scan") downloadable as `dirac-scan-<wallet4>.png`, and an X intent link `https://x.com/intent/post?text=...&url=<page url>` with the score. No server-side images.

Landing wiring: `src/components/sections/Scanner.tsx` keeps the pinned demo but adds under the chapter header an address input + "Scan" button (navigates to `/scan?a=<value>` with router.push; validates with isValidWallet) and a "Use connected wallet" ghost pill when a wallet is connected. `src/components/ui/Nav.tsx`: "Scanner" link → `/scan` (keep the others). Footer "Scanner" → `/scan`.

Copy: plain, no fear language. The page says what was read and what was not. Addresses and hashes in mono with copy buttons. Dates absolute in mono plus relative in text.

# Dirac v0.1 implementation contract

This file is the single source of truth for module boundaries. Four modules are written in parallel; the function signatures below are binding. Read SPEC.md sections 3.2, 3.3, 8 for product intent.

## Stack facts (already installed, do not add dependencies)

- Next.js 16.4 App Router, React 19.3, TypeScript strict, Tailwind 4. `output: "export"` (static): NO dynamic route segments, NO server components that fetch, NO route handlers. Dynamic data comes from query params on the client (`/p?a=<wallet>`) and from the Worker API.
- Client components start with `"use client"`. Lint uses React Compiler rules: never call setState synchronously inside a useEffect body (call it from callbacks/timers), never call `Math.random`/`Date.now` during render (only in handlers, effects, or useFrame), never mutate values returned from hooks or passed as props, never mutate module-level objects directly inside a component (call a function exported by the module instead).
- Design classes in `src/app/globals.css`: `display` (heavy uppercase headline), `display-serif` (italic serif second line), `eyebrow` (mono label), `panel` (dark card), `paper` (light document card), `pill` + `pill-ghost` (buttons), `chip` (mono tag), `stamp` (rubber stamp), `tnum`. Colour tokens: `text-paper`, `text-mute`, `bg-ink`, `bg-ink-2`, `border-line`, `text-signal`, `bg-signal`. Fonts: `font-mono`, `font-serif`, default sans. Page wrapper used by sections: `mx-auto max-w-[1400px] px-5 md:px-8`. Look at `src/components/sections/Passport.tsx` and `Token.tsx` for the visual language. The layout already renders a fixed 3D background and the Nav; pages must have `relative z-10` content and top padding `pt-32 md:pt-40`.
- Libraries and import paths (exact):
  - `import { ml_kem768 } from "@noble/post-quantum/ml-kem.js"` → `ml_kem768.keygen(seed64)` returns `{ publicKey (1184 B), secretKey }`; `encapsulate(publicKey)` → `{ cipherText, sharedSecret }`; `decapsulate(cipherText, secretKey)`.
  - `import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js"` → `ml_dsa65.keygen(seed32)` returns `{ publicKey (1952 B), secretKey }`; `ml_dsa65.sign(msg, secretKey)` → Uint8Array (3309 B); `ml_dsa65.verify(sig, msg, publicKey)` → boolean.
  - `import { sha256 } from "@noble/hashes/sha2.js"`, `import { hkdf } from "@noble/hashes/hkdf.js"` (`hkdf(sha256, ikm, salt, info, length)`), `import { argon2id } from "@noble/hashes/argon2.js"` (`argon2id(password, salt, { t, m, p, dkLen })`), `import { randomBytes } from "@noble/hashes/utils.js"`.
  - `import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"` (`xchacha20poly1305(key32, nonce24).encrypt(data)`).
  - `import { ed25519 } from "@noble/curves/ed25519.js"` (`ed25519.verify(sig, msg, publicKey)`).
  - `import { generateMnemonic, mnemonicToSeedSync, validateMnemonic, mnemonicToEntropy, entropyToMnemonic } from "@scure/bip39"`, `import { wordlist } from "@scure/bip39/wordlists/english.js"`.
  - `import { base58, base64 } from "@scure/base"` (`base58.encode(bytes)`, `base58.decode(str)`).
  - Solana: `@solana/web3.js` v1 (`Connection`, `PublicKey`, `Transaction`, `TransactionInstruction`).
  - Wallet Standard: `import { getWallets } from "@wallet-standard/app"`; feature names `"standard:connect"`, `"standard:events"`, `"solana:signMessage"`, `"solana:signAndSendTransaction"`, `"solana:signTransaction"` (types from `@solana/wallet-standard-features`).
- Node 24 runs TypeScript directly with type stripping (`node scripts/x.ts`): scripts must import relative files WITH the `.ts` extension, and library files they import must avoid TS-only runtime syntax (no `enum`, no parameter properties, no namespaces). Type-only imports/exports are fine.

## Module 1: `src/lib/pq.ts` (single file, pure, no React, no DOM except TextEncoder)

```ts
export type PassportMode = "simple" | "hardened";
export interface Passport {
  v: 1;
  wallet: string;      // base58 Solana address (Ed25519 public key)
  kem_pk: string;      // base64 ML-KEM-768 public key
  dsa_pk: string;      // base64 ML-DSA-65 public key
  mode: PassportMode;
  created_at: number;  // unix ms
}
export interface PassportKeys { kemPk: Uint8Array; kemSk: Uint8Array; dsaPk: Uint8Array; dsaSk: Uint8Array; }
export interface Seeds { kemSeed: Uint8Array /*64*/; dsaSeed: Uint8Array /*32*/; }

export const KEY_DERIVATION_MESSAGE = (wallet: string) =>
  `Dirac keys v1\nwallet: ${wallet}\nThis signature derives your post-quantum passport keys. Only sign it on dirac.network.`;
export function seedsFromSignature(sig: Uint8Array): Seeds;          // HKDF-SHA256, salt "dirac-passport-v1", info "ml-kem-768" (64 B) / "ml-dsa-65" (32 B)
export function seedsFromEntropy(entropy32: Uint8Array): Seeds;      // same HKDF over the 32-byte entropy
export function newEntropy(): Uint8Array;                            // 32 random bytes
export function entropyToPhrase(entropy32: Uint8Array): string;      // 24-word BIP39 english
export function phraseToEntropy(phrase: string): Uint8Array;         // throws on invalid phrase
export function keysFromSeeds(seeds: Seeds): PassportKeys;
export function buildPassport(wallet: string, keys: PassportKeys, mode: PassportMode, createdAt?: number): Passport;
export function canonicalBytes(p: Passport): Uint8Array;             // JSON with keys sorted alphabetically, no whitespace, UTF-8
export function passportHash(p: Passport): string;                   // hex sha256 of canonicalBytes
export function selfSign(p: Passport, dsaSk: Uint8Array): string;    // base64 ML-DSA-65 signature over canonicalBytes
export function verifySelf(p: Passport, selfSig: string): boolean;
export const WALLET_MESSAGE = (p: Passport) => `Dirac passport v1\nwallet: ${p.wallet}\nhash: ${passportHash(p)}`;
export function verifyWalletSig(p: Passport, walletSig: string): boolean; // ed25519.verify over utf8(WALLET_MESSAGE(p)) with base58-decoded p.wallet
export const ANCHOR_MEMO = (p: Passport) => `dirac:passport:v1:${passportHash(p)}`;
export function fingerprint(p: Passport): string;                    // first 8 bytes hex of sha256(kem_pk_bytes || dsa_pk_bytes), shown as "ab12 cd34 ef56 7890"

export interface QSeal {
  v: 1; hash_alg: "sha256"; doc_hash: string /*hex*/; passport: string /*wallet*/; dsa_pk: string /*base64*/;
  sig_alg: "ML-DSA-65"; signature: string /*base64*/; signed_at: number /*unix seconds*/; name?: string; anchor_tx?: string;
}
export function hashBytes(data: Uint8Array): string;                 // hex sha256
export const SEAL_MESSAGE = (docHash: string, signedAt: number) => `dirac:seal:v1:${docHash}:${signedAt}`;
export function createSeal(docHash: string, p: Passport, dsaSk: Uint8Array, opts?: { name?: string; anchorTx?: string; signedAt?: number }): QSeal;
export function verifySeal(seal: QSeal): { ok: boolean; reason?: string }; // checks fields and ML-DSA signature with seal.dsa_pk
export function sealId(seal: QSeal): string;                          // hex sha256 of canonical JSON of the seal (sorted keys)

export interface RecoveryFile { v: 1; kdf: "argon2id"; t: number; m: number; p: number; salt: string; nonce: string; ct: string; wallet: string; }
export function encryptRecovery(entropy32: Uint8Array, password: string, wallet: string): RecoveryFile; // argon2id t=3 m=65536 p=1 dkLen=32, xchacha20poly1305, base64 fields
export function decryptRecovery(file: RecoveryFile, password: string): Uint8Array;                    // throws on wrong password
export const b64 = { encode: (b: Uint8Array) => string, decode: (s: string) => Uint8Array };
export const utf8 = (s: string) => Uint8Array;
```
Also write `scripts/pq-selftest.ts` (run with `node scripts/pq-selftest.ts`) that exercises: seeds → keys → passport → selfSign/verifySelf → fingerprint → seal create/verify (and a tampered seal fails) → recovery encrypt/decrypt round trip (and wrong password throws) → ed25519 wallet signature verify using a throwaway `ed25519` key (`import { ed25519 } from "@noble/curves/ed25519.js"`, `ed25519.sign(msg, sk)`). Print PASS/FAIL per check and exit code 1 on any failure.

## Module 2: `src/lib/solana/` (Wallet Standard, no wallet-adapter packages)

`src/lib/solana/wallet.tsx` ("use client"):
```ts
export interface ConnectedWallet {
  name: string;                 // wallet name, e.g. "Phantom"
  icon: string;                 // data URL from the wallet
  address: string;              // base58
  publicKey: Uint8Array;
  signMessage(message: Uint8Array): Promise<Uint8Array>;                 // via solana:signMessage
  signAndSend(tx: Uint8Array /*serialized legacy tx*/): Promise<string>; // via solana:signAndSendTransaction (chain "solana:mainnet"), fallback solana:signTransaction + sendRawTransaction through rpc.ts; returns base58 signature
  disconnect(): Promise<void>;
}
export interface WalletOption { name: string; icon: string; connect(): Promise<ConnectedWallet>; }
export function listWallets(): WalletOption[];     // wallets from getWallets() that support standard:connect, solana:signMessage and (signAndSendTransaction or signTransaction) and chain solana:mainnet
export function useWallet(): { wallet: ConnectedWallet | null; options: WalletOption[]; connect(o: WalletOption): Promise<void>; disconnect(): Promise<void>; connecting: boolean; error: string | null };
export function WalletProvider({ children }): JSX.Element;            // context; subscribes to getWallets().on("register") so late-injected wallets appear; remembers last wallet name in localStorage and auto-reconnects silently if available
```
`src/components/wallet/ConnectButton.tsx` ("use client"): a `pill` button "Connect wallet"; when wallets exist opens a small panel listing options with icons; when connected shows truncated address `7xKq…9AsU` in a `chip` with a disconnect action. Export `truncate(address)` helper from `src/lib/solana/format.ts`: first 4 + "…" + last 4.

`src/lib/solana/rpc.ts`:
```ts
export const RPC_URL: string;                                  // process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.mainnet-beta.solana.com"
export function getConnection(): Connection;                   // memoized
export function explorerTx(sig: string): string;               // https://solscan.io/tx/<sig>
export function explorerAddress(a: string): string;            // https://solscan.io/account/<a>
```
`src/lib/solana/memo.ts`:
```ts
export const MEMO_PROGRAM_ID: PublicKey;                       // MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
export async function buildMemoTx(payer: string, memo: string): Promise<Uint8Array>; // legacy Transaction with one memo instruction, recent blockhash, feePayer=payer, serialized with requireAllSignatures:false
export async function anchorMemo(wallet: ConnectedWallet, memo: string): Promise<string>; // builds, signs and sends, returns tx signature; waits for confirmation (confirmed commitment) with a 60 s timeout
```

## Module 3: Worker API + D1 (`worker/index.ts`, `worker/tsconfig.json`, `migrations/0001_init.sql`, `src/lib/api.ts`)

Routes (JSON, CORS: `Access-Control-Allow-Origin: *`, methods GET/POST/OPTIONS, headers Content-Type):
- `POST /api/passports` body `{ passport: Passport, self_sig: string, wallet_sig: string, anchor_tx?: string }`. Server: validates shape (lengths of decoded keys: kem_pk 1184 B, dsa_pk 1952 B), `verifySelf`, `verifyWalletSig` (import from `../src/lib/pq`), computes hash. Upsert by wallet: if a row exists with the same hash, update anchor_tx when provided; if a row exists with a different hash, reject 409 `{ error: "passport exists" }` unless the new bundle carries a valid wallet_sig (it does, so allow replace: newer passport wins; keep it simple: replace). Returns `{ ok: true, hash, registered_at }`.
- `GET /api/passports/:wallet` → `{ passport, self_sig, wallet_sig, anchor_tx, hash, registered_at }` or 404.
- `POST /api/seals` body `{ seal: QSeal }` → verifies with `verifySeal`, stores by `sealId`, returns `{ ok: true, id }`.
- `GET /api/seals/:id` → `{ seal, registered_at }` or 404.
- `GET /api/stats` → `{ passports: number, seals: number }`.
- Anything else under /api → 404 JSON. Non-/api requests never reach the Worker (assets are served first), but as a fallback return `env.ASSETS.fetch(request)`.

D1 schema (`migrations/0001_init.sql`):
```sql
CREATE TABLE IF NOT EXISTS passports (wallet TEXT PRIMARY KEY, hash TEXT NOT NULL, bundle TEXT NOT NULL, self_sig TEXT NOT NULL, wallet_sig TEXT NOT NULL, anchor_tx TEXT, mode TEXT NOT NULL, registered_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS seals (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, doc_hash TEXT NOT NULL, seal TEXT NOT NULL, registered_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS seals_wallet ON seals(wallet);
```
Env bindings (already in wrangler.jsonc): `DB: D1Database`, `ASSETS: Fetcher`. `worker/tsconfig.json`: `{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "noEmit": true, "types": ["@cloudflare/workers-types"], "lib": ["ES2022"], "skipLibCheck": true }, "include": ["./**/*.ts", "../src/lib/pq.ts"] }`. The root tsconfig excludes `worker`. Type-check with `npx tsc -p worker`.

`src/lib/api.ts` (client helpers, plain fetch, typed):
```ts
export const API_BASE: string; // process.env.NEXT_PUBLIC_API_BASE ?? "" (same origin in production; set to https://dirac.deeper-cf.workers.dev for local dev)
export async function registerPassport(body: { passport: Passport; self_sig: string; wallet_sig: string; anchor_tx?: string }): Promise<{ ok: true; hash: string; registered_at: number }>;
export async function fetchPassport(wallet: string): Promise<PassportRecord | null>;   // PassportRecord = { passport, self_sig, wallet_sig, anchor_tx: string | null, hash, registered_at }
export async function registerSeal(seal: QSeal): Promise<{ ok: true; id: string }>;
export async function fetchSeal(id: string): Promise<{ seal: QSeal; registered_at: number } | null>;
export async function fetchStats(): Promise<{ passports: number; seals: number }>;
```
Also create `.env.local` with `NEXT_PUBLIC_API_BASE=https://dirac.deeper-cf.workers.dev` (dev only; it is gitignored).

## Module 4: pages (`src/app/passport/page.tsx`, `src/app/seal/page.tsx`, `src/app/p/page.tsx`, components in `src/components/app/`)

Session state `src/components/app/session.tsx` ("use client"): context holding `{ passport: Passport | null; keys: PassportKeys | null; selfSig: string | null; walletSig: string | null; anchorTx: string | null }` plus setters; persist the non-secret parts (passport, selfSig, walletSig, anchorTx) in localStorage under `dirac:passport:<wallet>`; secrets stay in memory only. Provide `useSession()`.

`/passport` flow (one page, stepper with chapter-style headers, `panel` cards, `paper` document preview using the same look as the landing's passport card):
1. Connect wallet (ConnectButton).
2. Choose mode: Simple (derive from wallet signature) or Hardened (generate entropy, show 24-word phrase with a "I wrote it down" checkbox, optional recovery file download with a password: `encryptRecovery` → download JSON named `dirac-recovery-<wallet>.json`).
3. Generate keys → build passport → `selfSign` → wallet `signMessage(utf8(WALLET_MESSAGE))` → `registerPassport` (without anchor) → show the paper document with fingerprint, keys, mode, date.
4. Anchor: button "Anchor on Solana" → `anchorMemo(wallet, ANCHOR_MEMO(passport))` → `registerPassport` again with `anchor_tx` → show stamp "Anchored" and the explorer link. Explain the fee (about 0.000005 SOL) before sending.
5. Done: links to `/p?a=<wallet>` and `/seal`.
If a passport already exists in the registry for the wallet: show it, offer "Restore keys" (simple: sign the derivation message and check fingerprint matches; hardened: paste phrase or upload recovery file + password) and "Replace passport".

`/seal`: two panels. Sign: textarea or file input; compute `hashBytes` (file read as ArrayBuffer in the browser, never uploaded); requires session keys (link to /passport otherwise); produces a `.qseal` download (`<name>.qseal`, JSON pretty) and a "Publish verification link" button → `registerSeal` → link `/seal?id=<id>`. Verify: drop a `.qseal` file (or load from `?id=`) plus the original text/file; show verdict: signed by `|wallet⟩`, unchanged, signed at, and whether the registry has a passport whose dsa_pk matches (fetchPassport) → "passport bound to wallet, anchored tx …" or "unregistered key".

`/p?a=<wallet>`: public passport page: fetch record; show the paper document (fingerprint, keys truncated with copy buttons, mode, issued date, anchor tx link), a "Verify a document from this passport" link to `/seal`, and an empty state when not found. Reads the query on the client (`useSearchParams` inside a Suspense boundary, or `window.location`).

Wire-up (pages agent also does this): add `WalletProvider` and `SessionProvider` to `src/components/Providers.tsx`; change Nav "Create passport" and the hero/landing CTAs (`#passport` / `#seal` anchors) to real links `/passport` and `/seal`; add a small `src/components/app/LiveStats.tsx` using `fetchStats` (counts of passports and seals, "—" while loading) and place it in the landing Hero stats row replacing "Open source · Launch week".

## Copy and tone
English UI. Short sentences, no hype. Mono labels for addresses and hashes. Honest notes where relevant: the wallet binding uses Ed25519, so a binding made after Q-Day could be forged; an anchor proves only that the record existed before its block time, nothing more; a registered passport is replaced only with a signature from its current ML-DSA key; simple mode is a convenience ("Convenience · not Q-Day safe": its keys come from a wallet signature, so a broken wallet key breaks them too), hardened mode is the default and recommended one.

## Registry v2: rotation, history, verified anchors (migration 0013)

Supersedes the Module 3 upsert rule ("newer passport wins") and the Module 4 "Replace passport" flow above.

### Rotation rule
- `src/lib/pq.ts`: `ROTATE_MESSAGE(wallet, oldHash, newHash) = "dirac:passport:rotate:v1:<wallet>:<old hash>:<new hash>"`; `signRotation(current, currentDsaSk, next): string` (base64 ML-DSA-65, throws unless the key is `current`'s and both name the same wallet); `verifyRotation(current, next, sig): boolean`.
- `POST /api/passports` body `{ passport, self_sig, wallet_sig, anchor_tx?, rotation_sig? }`. Self-signature and wallet signature are checked first, as before (400).
  - No passport for the wallet: registers as version 1.
  - Same hash as the active version: idempotent (registration time unchanged); may attach an anchor (below).
  - Different hash: needs `rotation_sig` by the ACTIVE version's ML-DSA key over `ROTATE_MESSAGE(wallet, activeHash, newHash)`. Missing: 409 `{ error: "this wallet already has a passport; replacing it needs a signature from its current key", code: "rotation_required", hash, version }`. Wrong key or wrong message: 409 `{ code: "rotation_invalid" }`. Malformed (not 3309 bytes of base64): 400. A rotation that loses a race to another one: 409 `{ code: "conflict" }` (or `rotation_invalid` when it reads the winner first). A passport that already was a version of this wallet: 409 `{ code: "passport_reused" }`, even with a valid signature; a rotation_sig is therefore single-use, since the pair (old hash, new hash) it covers can never be the active pair again.
  - Success: `{ ok: true, hash, registered_at, version, rotated, anchor_tx, anchor_verified, anchor_status: "none" | "pending" | "verified" | "unseen", anchor_note? }`. `anchor_tx` / `anchor_verified` describe what is stored for the active version; `"unseen"` means the anchor_tx sent with a re-register is not visible on chain and nothing was recorded.
- Consequence: after Q-Day a forged Ed25519 wallet signature alone cannot swap a passport. An earlier anchored, verified version keeps priority: it can be superseded only through a valid `rotation_sig` from its own key. Simple mode does not get this protection in full: its keys derive from a wallet signature (`seedsFromSignature`), so whoever breaks the wallet key re-derives them and can sign a rotation. Without its current keys a passport cannot be replaced by anyone, its holder included; a fresh wallet is the way out.

### History
- D1 `passport_versions(wallet, version, hash, bundle, self_sig, wallet_sig, rotation_sig, anchor_tx, anchor_verified, anchor_slot, anchor_time, anchor_checked_at, mode, registered_at, superseded_at, PRIMARY KEY(wallet, version))`. Every accepted rotation inserts the next version and stamps `superseded_at` on the previous one (one D1 batch, guarded by the version and hash read). Times are unix ms.
- `passports` keeps the active version: new columns `version`, `anchor_verified`, `anchor_time`. `passports.anchor_tx` now holds a VERIFIED anchor only (NULL otherwise), so the badge, share cards and scanner, which read that column, never show a claim as an anchor.
- `GET /api/passports/:wallet` (backward compatible): `{ passport, self_sig, wallet_sig, anchor_tx, hash, registered_at, version, anchor_verified, anchor_slot, anchor_time, rotated_from }`. `anchor_tx` is the transaction named for the active version, verified or not: only `anchor_verified` makes it an anchor. `rotated_from` is the previous version's hash (null for version 1).
- `GET /api/passports/:wallet/history`: `{ wallet, total, truncated, versions: [{ version, hash, mode, passport, self_sig, wallet_sig, rotation_sig, rotation_signed, registered_at, superseded_at, anchor_tx, anchor_verified, anchor_slot, anchor_time }] }`, newest first, at most 50. 200 with an empty list when the wallet has no passport (a 404 means the route is missing). Readers re-check each `rotation_sig` against the previous version's `dsa_pk` in the browser (/p does).
- Migration 0013 backfills version 1 from every existing row (anchor kept as an unverified claim, `passports.anchor_tx` cleared). A passports row written by a pre-0013 Worker after the migration is repaired on its next read (it becomes the next version, `rotation_signed: false`).

### Anchor verification
- When `anchor_tx` is supplied (first registration, rotation, or an idempotent re-register), the Worker calls `getTransaction(tx, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 })` through the scanner's upstreams (RPC_URL first, then the free endpoints, asking the next when one fails or answers null; a node that answers "Transaction version (N) is not supported" is asked once more with that version) and requires: `meta.err` null, the wallet among the signers, and a top-level SPL Memo (v2 or v1) instruction whose text equals `ANCHOR_MEMO(passport)`.
  - All true: `anchor_verified = 1` with the slot and block time.
  - The chain contradicts the claim (failed tx, other signer, no such memo): 400 `{ error: "anchor_tx refused: <reason>" }`; nothing else changes.
  - Not visible (null everywhere, or no upstream answered), named in a first registration or a rotation (requests that carry a fresh signature): stored as an unverified claim; re-checked lazily on `GET /api/passports/:wallet` and `/history`, at most once a minute per version (claimed through `anchor_checked_at`). A re-check that finds a contradiction drops the claim.
  - Not visible, named in a re-register: nothing is recorded, `anchor_status: "unseen"`. A registered passport's `self_sig` and `wallet_sig` are public, so anyone can send that request; storing the claim would let a stranger pin a made-up transaction on any passport or overwrite the holder's claim. /passport asks three times, 4 s apart, then keeps the transaction in the tab for "Record the anchor".
- A verified anchor is never overwritten. The two production passports carry real anchors: their first read after the deploy verifies them.
- Trust model: "verified" means the Worker's RPC upstream returned that transaction. Anyone can repeat the check from the explorer link.

### Seal identity (`/seal`)
- `pq.sealIdentity(seal, versions: KeyVersion[], evidence?: SealEvidence): SealIdentity`, pure. `KeyVersion = { version, dsa_pk, registered_at, superseded_at, created_at? }` (from the history route; `created_at` is `passport.created_at`). `SealEvidence = { now?, publishedAt? }`: the verifier's clock and the registry's first receipt of this exact seal (`GET /api/seals/:id` `registered_at`, null when never published), unix ms.
- Windows: version 1 from its `created_at` (unbounded when not given), later versions from their registration, each until its `superseded_at`, widened by `SEAL_CLOCK_SKEW_MS` (10 min) for the signer's clock. A history without version 1 (truncated) gives its oldest listed version no open start.
- Results: `verified` (the key of the version active at `signed_at`, still active), `earlier` (the key of a superseded version whose window contains `signed_at`; `rotatedAt`; `proven` when `publishedAt <= rotatedAt`), `unbound` (no passport), `mismatch` with `reason: "unknown-key"` (no version has this key), `"future"` (`signed_at` later than `min(now, publishedAt)` plus the skew) or `"outside-window"` (a version's key, but not at the stated time).
- Verdicts: Invalid (signature), Sealed (no document yet), Modified (hash differs), then Verified identity (signal colour, the only one), Verified identity · earlier key (proven only), Retired key · date unproven (an earlier key without a registry receipt from before the rotation: whoever holds a retired key can date a seal into its old window), Unbound signature (the seal proves only that someone holding the key signed), Identity mismatch (inverted stamp), Registry unreachable (never green). /seal looks a seal loaded from a file up by its id to find the receipt, and shows it as "Published".
- `POST /api/seals` refuses a seal whose `signed_at` is more than `SEAL_CLOCK_SKEW_MS` ahead of the Worker's clock (400 "seal.signed_at is in the future").

### Tests
`node scripts/pq-selftest.ts` (rotation and seal identity included); `node scripts/rotation-e2e.ts http://127.0.0.1:<port>` and `node scripts/api-e2e.ts http://127.0.0.1:<port>` against a local `wrangler dev` with migration 0013 (both refuse non-loopback hosts without `--allow-remote`).

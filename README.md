# Dirac

Post-quantum identity for Solana wallets: a passport (ML-KEM-768 + ML-DSA-65 keys bound to an Ed25519 wallet and anchored on-chain), seals for documents, an encrypted inbox, a quantum exposure scanner, and a playground (Quantum Pet, Qubit Arena, Attack Lab) that feeds the product.

Production domain: https://dirac.digital (requires DNS activation and deployment; see [domain setup](docs/DOMAIN.md)).
Existing Worker address: https://dirac.deeper-cf.workers.dev

## What is real

| Module | Status |
| --- | --- |
| Scanner (`/scan?a=<address>`) | Live data over Helius and public RPC: holdings, authorities, Squads multisigs, three indicators, recommendations, shareable report |
| Passport (`/passport`, `/p?a=<wallet>`) | Keys generated in the browser, simple or hardened mode, self-signed and wallet-signed, one memo on mainnet as the anchor |
| Seal (`/seal`) | ML-DSA-65 signature over any file hash, `.qseal` files, verification in the browser |
| Inbox (`/inbox`, `/write`) | ML-KEM-768 envelopes, wallet-signed send and read, invites with a memo |
| Quantum Pet (`/pet`) | One shared 10-qubit register simulated exactly in the Worker, gates per visitor, collapse at 00:00 UTC, badges for signed gates |
| Qubit Arena (`/arena`) | Two-qubit Bell battles, exact probabilities, commit-reveal with the passport, ELO ladder |
| Attack Lab (`/lab`) | Toy brute force, Shor step by step, lattice closest vector, harvest-now-decrypt-later |
| Blink invite (`/invite/<wallet>`, `/actions.json`, `/api/actions/invite/<wallet>[/confirm]`) | Solana Action that sends the same 0.0001 SOL + memo invite as `/write?to=`; `worker/actions.ts`, contract in `docs/CONTRACT-ACTIONS.md`. Not yet registered with Dialect, so X does not unfurl it; `/invite/<wallet>` redirects visitors without a Blink client to `/write`. Live only once the Worker that mounts it is deployed |
| Token | Not launched; the ledger panel is an honest empty state |

The cryptography is `@noble/post-quantum`, `@noble/curves`, `@noble/hashes` and `@noble/ciphers`; nothing custom.

## Stack

- Next.js 16 App Router, static export (`output: "export"`), React 19, TypeScript strict, Tailwind 4.
- three.js + @react-three/fiber for the particle scene and the pet bodies (depth-animated pictures or GLB models).
- Cloudflare Worker (`worker/`) serving the static files and `/api/*`, D1 for the registry, rate limits in D1, one cron at 00:00 UTC.
- Wallet Standard for wallets (no wallet-adapter packages), `@solana/web3.js` for transactions.

## Run

```bash
npm install
cp .env.example .env.development.local   # NEXT_PUBLIC_API_BASE: the API the dev server's pages call (src/lib/api.ts)
npm run dev          # http://localhost:3000, pages talk to the production Worker API (static export: next dev serves no /api)
npm run build        # writes ./out, which wrangler serves as the ASSETS binding
npx wrangler d1 migrations apply dirac --local
npx wrangler dev --local   # the Worker with a local D1 on http://localhost:8787 (set NEXT_PUBLIC_API_BASE to it to point the dev pages there)
```

Self-tests run with plain Node, one file each under `scripts/`: `pq-selftest.ts`, `pet-selftest.ts`, `arena-selftest.ts`, `inbox-selftest.ts`, `lab-selftest.ts`, `squads-selftest.ts`, `actions-selftest.ts` (`node scripts/<name>.ts`).

## Deploy

```bash
npx wrangler d1 migrations apply dirac --remote   # when migrations/ changed
npm run deploy                                    # next build && wrangler deploy
```

Secrets are set with `wrangler secret put` (RPC_URL for Helius; X credentials are optional). `wrangler.jsonc` must stay in place: without it wrangler converts the project to OpenNext.

## Layout

- `SPEC.md` product spec, `docs/CONTRACT*.md` binding module contracts, `docs/PROMPTS.md` image prompts.
- `src/app` pages, `src/components` UI, `src/lib` crypto and shared logic (also imported by the Worker).
- `worker/index.ts` router, scanner, registry; `worker/pet.ts`, `worker/inbox.ts`, `worker/arena.ts`, `worker/share.ts`, `worker/squads.ts`, `worker/actions.ts` (Blink invite), `worker/x.ts` (the pet's X post) modules.
- `migrations/` D1 schema, `scripts/` self-tests and end-to-end checks, `public/characters` art, `public/models` GLB bodies.

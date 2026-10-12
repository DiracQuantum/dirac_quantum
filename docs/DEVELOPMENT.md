# Development guide

Technical setup and maintenance instructions for contributors. For the product overview, visit [Dirac](https://dirac.digital) or read the [project README](../README.md).

## Run locally

Use **Node.js 24+** for the TypeScript self-test scripts, and npm.

```powershell
git clone https://github.com/DiracQuantum/dirac_quantum.git
cd dirac_quantum
npm ci
Copy-Item .env.example .env.development.local
npm run dev
```

Open `http://localhost:3000`. The example development environment points the browser API client at the deployed Worker. Next.js development serves the frontend; the Worker owns `/api/*`.

For a fully local API, start the Worker in another terminal:

```powershell
npx wrangler d1 migrations apply dirac --local
npx wrangler dev --local
```

Set `NEXT_PUBLIC_API_BASE=http://localhost:8787` in `.env.development.local`, then restart the frontend. Configure `RPC_URL` in a local `.dev.vars` file when a private RPC is needed. Helius is used for the scanner's DAS and account-index queries; unavailable sources remain explicitly marked in the report.

### Validate changes

```powershell
npm run lint
npx tsc --noEmit
npx tsc -p worker
node scripts/pq-selftest.ts
node scripts/inbox-selftest.ts
node scripts/pet-selftest.ts
node scripts/arena-selftest.ts
node scripts/qpu-selftest.ts
node scripts/actions-selftest.ts
node scripts/badge-selftest.ts
npm run build
```

Additional self-tests and end-to-end utilities live in [`scripts/`](../scripts/). End-to-end scripts may require a running Worker or a configured service; pure self-tests run without production credentials.

## Deploy

The production site is **[dirac.digital](https://dirac.digital)**. Domain configuration is described in [DOMAIN.md](DOMAIN.md).

Authenticate Wrangler to the intended Cloudflare account. When deploying your own instance, create a D1 database and replace the existing database binding in `wrangler.jsonc` with yours.

```powershell
# Apply new migrations when the database schema changes.
npx wrangler d1 migrations apply dirac --remote

# Build, generate CSP hashes, and publish the Worker + static assets.
npm run deploy
```

Production uses same-origin API requests: keep `NEXT_PUBLIC_API_BASE` unset or empty in production builds. `SITE_URL` sets the Worker's public origin; `NEXT_PUBLIC_SITE_URL` can override frontend share and metadata URLs at build time.

| Configuration | Purpose |
| --- | --- |
| `DB` | Cloudflare D1 binding defined in `wrangler.jsonc` |
| `RPC_URL` | Optional private Solana RPC; a Helius endpoint supports the scanner's indexed sources |
| `IBM_QUANTUM_API_KEY` | Optional IBM hardware integration |
| `IBM_QUANTUM_CRN` | Optional explicit IBM Quantum instance |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | Optional daily pet posts on X |

Set production secrets with `npx wrangler secret put <NAME>`. Local environment files, secrets, dependencies, build output, and original source models are excluded from Git.

## Repository map

```text
src/
  app/                 Product pages and route metadata
  components/          Interface, wallet, scanner, pet, arena, and 3D components
  lib/                 Shared cryptography, protocol formats, and simulation logic
worker/                API router, storage, verification, RPC, and scheduled jobs
migrations/            D1 database schema
scripts/               Self-tests, end-to-end checks, and CSP build tooling
public/
  characters/          Creature artwork
  models/              Web-ready GLB models
docs/                  Module contracts, domain setup, and README artwork
SPEC.md                Product specification and original design intent
wrangler.jsonc         Worker, assets, D1, domain, limits, and scheduling configuration
```

## Module documentation

- [Passport, seals, and API contracts](CONTRACT.md)
- [Scanner data and confidence](CONTRACT-SCANNER-V2.md)
- [Inbox, quantum pet, and IBM integration](CONTRACT-WEEK2.md)
- [Arena protocol](CONTRACT-ARENA.md)
- [Passport badges](CONTRACT-BADGE.md)
- [Solana Actions](CONTRACT-ACTIONS.md)

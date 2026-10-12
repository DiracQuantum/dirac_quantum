# Contract: Solana Actions / Blink "Invite to Dirac"

Builds on docs/CONTRACT-WEEK2.md (invites: `src/lib/solana/invite.ts`, `worker/inbox.ts`, the `invites` table from `migrations/0004_inbox.sql`) and the live Worker in `worker/index.ts`. One Action, implemented in `worker/actions.ts` and mounted by the integrator with one line in `fetch`.

A link to `https://dirac.deeper-cf.workers.dev/invite/<wallet>` unfurls in X (once the domain is in the Dialect registry) and in Blink-aware wallets as a card with one button, "Send invite". The button sends the invite the site already sends from `/write?to=<wallet>`: a legacy transaction, fee payer = the signer, `SystemProgram.transfer` of `INVITE_LAMPORTS = 100_000` (0.0001 SOL) to `<wallet>` and an SPL Memo (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) with the data `dirac:invite:v1 <site>/passport?from=<signer>`, byte for byte `INVITE_MEMO(siteUrl, from)` from `src/lib/solana/invite.ts`. `<site>` is `SITE_URL` when set, otherwise the request origin (in production both are `https://dirac.deeper-cf.workers.dev`, what the site uses through `window.location.origin`).

## Files

- `public/actions.json`: the rules. `/invite/*` maps to `/api/actions/invite/*`, `/api/actions/**` to itself. The Worker serves the same document itself (`ACTIONS_JSON` in `worker/actions.ts`, the self-test keeps the two equal) because the Actions clients require `Access-Control-Allow-Origin: *` and the Actions headers on it, which the static assets path does not add. The file in `public/` is the fallback if the Worker line is ever removed.
- `worker/actions.ts`: `handleActions(request, env, ctx, parts, url): Promise<Response | null>`. Pure helpers exported for tests: `checkWallet`, `isOnCurve`, `isTxSignature`, `inviteMemo`, `buildInviteTransaction`, `checkInviteTransaction`, `truncate`, and the constants `ACTION_VERSION`, `BLOCKCHAIN_ID`, `ACTIONS_HEADERS`, `ACTIONS_JSON`, `INVITE_LAMPORTS`, `INVITE_MEMO_PREFIX`, `MEMO_PROGRAM_ID`.
- `src/lib/blink.ts`: `inviteBlinkUrl(wallet, origin = siteOrigin())` → `<origin>/invite/<wallet>`.
- `scripts/actions-selftest.ts`: `node scripts/actions-selftest.ts`. Memo format against the site's builder, wallet validation (base58, 32 bytes, on curve, PDA refused), transaction assembly (deserialized: fee payer, blockhash, two instructions, program ids, lamports, memo bytes, unsigned), the on-chain check, and the routing with a stubbed D1 and RPC (headers, actions.json, redirect, disabled card, self-invite, 405/404, 429, POST transaction and `links.next`, confirm records / refuses).

## Routes

All answers carry `X-Action-Version: 2.4`, `X-Blockchain-Ids: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` and the Actions CORS headers: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET,POST,PUT,OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids`, `Access-Control-Expose-Headers: X-Action-Version, X-Blockchain-Ids`. Errors are `{ message }` (the spec's `ActionError`) with a 4xx or 500 status.

- `OPTIONS` on any route below: 200, the headers above (the generic OPTIONS answer in `worker/index.ts` lacks the Accept-* headers, so the mount must come first).
- `GET /actions.json`: `{ rules: [...] }`, `Cache-Control: public, max-age=3600`.
- `GET /invite/:wallet`: 302 to `<site>/write?to=<wallet>` for a valid wallet (a visitor without a Blink client lands on the site's own invite flow, X's crawler gets that page's card). An invalid wallet answers `null`, so the site's 404 page shows.
- `GET /api/actions/invite/:wallet` → `ActionGetResponse`: `type: "action"`, `icon: <site>/opengraph-image`, `title: "Invite <7xKq…9AsU> to Dirac"`, a description naming 0.0001 SOL, the memo and the recipient's passport page `<site>/p?a=<wallet>`, `label: "Send invite"`, `links.actions: [{ type: "transaction", href: <site>/api/actions/invite/<wallet>, label: "Send invite" }]`. A wallet that is not base58, not 32 bytes or off the curve gets the same card with `disabled: true` and `error.message` (HTTP 200, the clients render the disabled button with the message).
- `POST /api/actions/invite/:wallet` body `{ account }` → `{ type: "transaction", transaction: <base64 legacy tx, unsigned, blockhash from the RPC>, message, links: { next: { type: "post", href: <site>/api/actions/invite/<wallet>/confirm } } }`. 400 for a bad wallet, a bad account or `account === wallet` ("A wallet cannot invite itself."), 429 with `Retry-After` over the limit.
- `POST /api/actions/invite/:wallet/confirm` body `{ account, signature }` (the spec's `NextActionPostRequest`, sent by the client after the wallet signed and sent): reads the transaction through the RPC (`getTransaction`, jsonParsed, confirmed), polling for up to 15 s. Verified (landed without error, paid by `account`, transfer of at least 100 000 lamports from `account` to `wallet`, a `dirac:invite:v1` memo): `INSERT OR IGNORE INTO invites (from_wallet, to_wallet, tx, created_at)`, the row the site writes through `POST /api/invites`, then a `CompletedAction` (`type: "completed"`, "Invite sent to <wallet>", the passport link). Not visible yet after 15 s: the same completed card ("still confirming") and the check continues in `ctx.waitUntil` for another 25 s, recording when it lands. Visible but not an invite: 400 with the reason, nothing recorded.

Rate limit: both POSTs count in the shared D1 `ratelimit` table, bucket `actions`, key = `cf-connecting-ip` (or "anon"), 10 per fixed one-minute window; the same statement as `worker/inbox.ts`. Over the limit: 429 `{ message }` with `Retry-After`.

RPC: `env.RPC_URL` first (the Helius secret in production), then the same public fallbacks as `worker/index.ts`, skipping an upstream on 403/429/5xx, 15 s per attempt.

## Integrator duties

`worker/index.ts`, two lines: `import { handleActions } from "./actions";` next to the other module imports, and at the top of `fetch`, before the `/api` check and before the generic OPTIONS answer:

```ts
const actions = await handleActions(request, env, ctx, url.pathname.split("/").filter(Boolean), url);
if (actions) return actions;
```

Nothing else: no new Env fields (`DB`, `RPC_URL`, `SITE_URL` already exist), no migration, no wrangler change. `handleActions` catches its own errors (500 `{ message }`) and answers `null` for every path that is not `/actions.json`, `/invite/:wallet` or `/api/actions/...`.

The three Env fields are read structurally (`DB: D1Database; RPC_URL?: string; SITE_URL?: string`).

## Where the site could show the link

Not done here (another agent owns `src/app/p/page.tsx`): the public passport page `/p?a=<wallet>` could show "Share an invite link" with `inviteBlinkUrl(wallet)` (copy button) next to the "invited by N wallets" line, and `/write?to=<wallet>` could offer the same link in its "Send an invite" state so a visitor can post it to X instead of sending from the site. For a wallet without a passport, the Blink link is the lowest-friction invite: no site visit, one click in the feed.

## Registry

Blinks only unfurl in X for domains in the Dialect registry (docs.dialect.to, "Blink registry"). Registration is a manual review: submit the production URL of the Action, `https://dirac.deeper-cf.workers.dev/api/actions/invite/<a real wallet>` (or the website URL with the `actions.json`), with a contact address, through the form linked from the registry page or by mail to hello@dialect.to, after checking the card renders at `https://dial.to/?action=solana-action:https://dirac.deeper-cf.workers.dev/api/actions/invite/<wallet>`. Registry entries are per domain; a shared platform subdomain (`*.workers.dev`) may be refused or classified as unverified, in which case the site needs a custom domain (a `routes` / `custom_domain` entry in `wrangler.jsonc`, `SITE_URL` set to it; the Worker then serves `actions.json` and the Action from that origin without a code change). Until the domain is registered, the dial.to link above and Blink wallets with "unregistered" actions enabled render the card; X shows the plain link card of the redirect target.

## Checks

`npx tsc --noEmit`, `npx tsc -p worker`, `npx eslint worker/actions.ts src/lib/blink.ts scripts/actions-selftest.ts`, `node scripts/actions-selftest.ts`, and a local run (`npx wrangler dev --local --port 8795 --var RPC_URL:https://dirac.deeper-cf.workers.dev/api/rpc` with the module mounted) with curl on OPTIONS, GET, POST (decode the transaction), confirm and the rate limit.

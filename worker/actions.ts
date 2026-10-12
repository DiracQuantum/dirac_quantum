/**
 * Solana Actions (Blinks) for one action: "Invite to Dirac".
 *
 * A link to /invite/<wallet> unfurls in X (through the Dialect registry) and
 * in Blink-aware wallets as a button that sends the same on-chain invite the
 * site sends from /write: a SystemProgram transfer of 0.0001 SOL to <wallet>
 * plus an SPL Memo "dirac:invite:v1 <site>/passport?from=<inviter>".
 *
 * Routes (mounted by worker/index.ts through `handleActions`, which answers
 * `null` for every other path):
 *   GET     /actions.json                       the rules mapping /invite/* to the API, with the Actions headers
 *   GET     /invite/:wallet                     a visitor without a Blink client: 302 to /write?to=<wallet>
 *   GET     /api/actions/invite/:wallet         ActionGetResponse (disabled, with an error, for a bad wallet)
 *   POST    /api/actions/invite/:wallet         { account } -> { type: "transaction", transaction, message, links.next }
 *   POST    /api/actions/invite/:wallet/confirm { account, signature } -> CompletedAction; records the invite
 *   OPTIONS any of the above                    the Actions CORS preflight
 *
 * The site records an invite by POSTing /api/invites after the transaction
 * confirms (src/app/write/page.tsx); nothing indexes the chain. A Blink
 * client has no such step, so the POST response carries `links.next`
 * (Actions spec 2.x action chaining): once the wallet has signed and sent,
 * the client POSTs { account, signature } to /confirm, which reads the
 * transaction through the Worker's RPC, checks that it is an invite from
 * `account` to `:wallet` and writes the same `invites` row the site writes
 * (migrations/0004_inbox.sql). When the transaction is not visible yet the
 * response still says "sent" and the check carries on in `ctx.waitUntil`.
 *
 * Every response carries X-Action-Version: 2.4, X-Blockchain-Ids:
 * solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp (mainnet) and the Actions CORS
 * headers. POSTs are rate limited to 10 per minute per client IP through the
 * shared D1 `ratelimit` table (bucket "actions"). The pure parts (wallet
 * check, memo, transaction assembly, on-chain check) are exported for
 * scripts/actions-selftest.ts.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";

export interface Env {
  DB: D1Database;
  /** Private Solana RPC (Helius), tried first; the public endpoints are the fallback. */
  RPC_URL?: string;
  /** Public origin of the site, for the memo link, the icon and every href (default: the request origin). */
  SITE_URL?: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Solana Actions spec version announced in X-Action-Version. */
export const ACTION_VERSION = "2.4";
/** CAIP-2 id of Solana mainnet, announced in X-Blockchain-Ids. */
export const BLOCKCHAIN_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** What an invite transfers: 0.0001 SOL, the same as src/lib/solana/invite.ts. */
export const INVITE_LAMPORTS = 100_000;
/** SPL Memo program v2. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const INVITE_MEMO_PREFIX = "dirac:invite:v1";
/** The memo attached to the transfer, byte for byte what the site writes (INVITE_MEMO in src/lib/solana/invite.ts). */
export const inviteMemo = (siteUrl: string, from: string): string =>
  `${INVITE_MEMO_PREFIX} ${siteUrl}/passport?from=${from}`;

/** The actions.json rules; public/actions.json is the same document, the self-test keeps them equal. */
export const ACTIONS_JSON = {
  rules: [
    { pathPattern: "/invite/*", apiPath: "/api/actions/invite/*" },
    { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
  ],
};

/** Every Actions response: CORS for any origin plus the version and chain headers the clients negotiate on. */
export const ACTIONS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "Access-Control-Max-Age": "86400",
  "X-Action-Version": ACTION_VERSION,
  "X-Blockchain-Ids": BLOCKCHAIN_ID,
};

/** POSTs (transaction and confirm) per minute from one client IP. */
const POST_LIMIT = { bucket: "actions", limit: 10, periodMs: 60_000 };
/** An Actions POST body is { account, signature? }; anything bigger is not one. */
const MAX_BODY_BYTES = 4 * 1024;

/** Same public endpoints as worker/index.ts, rotated from a random start; a private RPC_URL always goes first. */
const RPC_FALLBACKS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet.solana.com",
  "https://solana.leorpc.com/?api_key=FREE",
];
const RPC_TIMEOUT_MS = 15_000;
/** How long /confirm waits for the transaction before answering. */
const CONFIRM_WAIT_MS = 15_000;
/** How much longer the check carries on after the answer (ctx.waitUntil). */
const CONFIRM_BACKGROUND_MS = 25_000;
const CONFIRM_INTERVAL_MS = 2_000;

const ED25519_PK_LEN = 32;
const TX_SIG_LEN = 64;

const SQL_RATE_LIMIT = `
INSERT INTO ratelimit (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN ratelimit.window_start = excluded.window_start THEN ratelimit.count + 1 ELSE 1 END,
  window_start = excluded.window_start
RETURNING count`;

/** The pair is the primary key: a second invite transaction keeps the first row (same as worker/inbox.ts). */
const SQL_INSERT_INVITE = `
INSERT OR IGNORE INTO invites (from_wallet, to_wallet, tx, created_at)
VALUES (?, ?, ?, ?)`;

/* ------------------------------------------------------------------ */
/* Actions spec types (the subset this action uses)                    */
/* ------------------------------------------------------------------ */

export interface ActionError {
  message: string;
}

export interface LinkedAction {
  type: "transaction";
  href: string;
  label: string;
}

export interface ActionGetResponse {
  type: "action";
  icon: string;
  title: string;
  description: string;
  label: string;
  disabled?: boolean;
  links?: { actions: LinkedAction[] };
  error?: ActionError;
}

export interface ActionPostResponse {
  type: "transaction";
  /** base64 serialized transaction, unsigned */
  transaction: string;
  message?: string;
  links?: { next: { type: "post"; href: string } };
}

export interface CompletedAction {
  type: "completed";
  icon: string;
  title: string;
  description: string;
  label: string;
  disabled?: boolean;
  error?: ActionError;
}

/* ------------------------------------------------------------------ */
/* Validation (pure)                                                   */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryBase58(value: string): Uint8Array | null {
  try {
    return base58.decode(value);
  } catch {
    return null;
  }
}

/**
 * True when the 32 bytes decode to a point on Ed25519, so a private key can
 * exist for the address; program-derived addresses are off-curve by
 * construction. ZIP-215 decoding, the same check as the scanner.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

export type WalletCheck = { ok: true; wallet: string } | { ok: false; error: string };

/** A base58 string of 32 bytes on the curve, or the reason it is not a wallet. */
export function checkWallet(value: unknown, what = "wallet"): WalletCheck {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) {
    return { ok: false, error: `${what} must be a base58 Solana address` };
  }
  const bytes = tryBase58(value);
  if (!bytes || bytes.length !== ED25519_PK_LEN) {
    return { ok: false, error: `${what} must be a base58 Solana address (32 bytes)` };
  }
  if (!isOnCurve(bytes)) {
    return { ok: false, error: `${what} is a program-derived address, not a wallet` };
  }
  return { ok: true, wallet: value };
}

/** True for a base58 string that decodes to a 64-byte transaction signature. */
export function isTxSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 64 || value.length > 128) return false;
  const bytes = tryBase58(value);
  return bytes !== null && bytes.length === TX_SIG_LEN;
}

/** `7xKq…9AsU`, the same shape as src/lib/solana/format.ts. */
export const truncate = (address: string): string =>
  address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;

/* ------------------------------------------------------------------ */
/* Transaction assembly (pure)                                         */
/* ------------------------------------------------------------------ */

export interface RecentBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Legacy transaction, fee payer `from`, with a SystemProgram transfer of
 * INVITE_LAMPORTS to `to` and the invite memo; serialized without signatures
 * and base64 encoded, as the Actions POST response carries it. Mirrors
 * `buildInviteTx` in src/lib/solana/invite.ts with the blockhash passed in.
 */
export function buildInviteTransaction(from: string, to: string, siteUrl: string, recent: RecentBlockhash): string {
  const fromPubkey = new PublicKey(from);
  const toPubkey = new PublicKey(to);
  if (fromPubkey.equals(toPubkey)) throw new Error("A wallet cannot invite itself.");
  const tx = new Transaction({
    feePayer: fromPubkey,
    blockhash: recent.blockhash,
    lastValidBlockHeight: recent.lastValidBlockHeight,
  });
  tx.add(SystemProgram.transfer({ fromPubkey, toPubkey, lamports: INVITE_LAMPORTS }));
  tx.add(
    new TransactionInstruction({
      keys: [],
      programId: new PublicKey(MEMO_PROGRAM_ID),
      data: Buffer.from(inviteMemo(siteUrl, from), "utf8"),
    }),
  );
  return base64.encode(new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })));
}

/* ------------------------------------------------------------------ */
/* On-chain check (pure)                                               */
/* ------------------------------------------------------------------ */

export type InviteCheck = { ok: true } | { ok: false; error: string };

/** The memo text of a jsonParsed memo instruction, or of a raw one (base58 data). */
function memoText(ix: Record<string, unknown>): string | null {
  if (typeof ix.parsed === "string") return ix.parsed;
  if (typeof ix.data !== "string") return null;
  const bytes = tryBase58(ix.data);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/**
 * Checks a `getTransaction` result (jsonParsed encoding): it landed without
 * error, `from` paid for it, it transfers at least INVITE_LAMPORTS from
 * `from` to `to` and it carries a dirac:invite memo. Anything else is not an
 * invite and must not be recorded.
 */
export function checkInviteTransaction(tx: unknown, from: string, to: string): InviteCheck {
  if (!isRecord(tx) || !isRecord(tx.meta) || !isRecord(tx.transaction) || !isRecord(tx.transaction.message)) {
    return { ok: false, error: "the transaction could not be read" };
  }
  if (tx.meta.err !== null && tx.meta.err !== undefined) return { ok: false, error: "the transaction failed on chain" };
  const message = tx.transaction.message;
  const keys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const first: unknown = keys[0];
  const payer = isRecord(first) ? first.pubkey : first;
  if (payer !== from) return { ok: false, error: "the transaction was not paid by the inviting wallet" };

  let transfer = false;
  let memo = false;
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  for (const ix of instructions) {
    if (!isRecord(ix)) continue;
    if (ix.program === "system" && isRecord(ix.parsed) && ix.parsed.type === "transfer" && isRecord(ix.parsed.info)) {
      const { source, destination, lamports } = ix.parsed.info;
      if (source === from && destination === to && typeof lamports === "number" && lamports >= INVITE_LAMPORTS) {
        transfer = true;
      }
    }
    if (ix.programId === MEMO_PROGRAM_ID || ix.program === "spl-memo") {
      const text = memoText(ix);
      if (text !== null && text.startsWith(INVITE_MEMO_PREFIX)) memo = true;
    }
  }
  if (!transfer) return { ok: false, error: `it does not transfer ${INVITE_LAMPORTS} lamports from the inviter to the invitee` };
  if (!memo) return { ok: false, error: `it carries no ${INVITE_MEMO_PREFIX} memo` };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200, cacheControl = "no-store", extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...ACTIONS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
      ...extraHeaders,
    },
  });
}

/** Actions clients show `message` to the user, so it is written for them. */
const actionError = (status: number, message: string, extraHeaders: Record<string, string> = {}): Response =>
  json({ message } satisfies ActionError, status, "no-store", extraHeaders);

const preflight = (): Response => new Response(null, { status: 200, headers: ACTIONS_HEADERS });

const methodNotAllowed = (allow: string): Response => actionError(405, "method not allowed", { Allow: allow });

/** 429 with the unix ms at which the window turns over and the matching Retry-After. */
function rateLimited(retryAt: number): Response {
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  return actionError(429, `Too many invites from this address; try again in ${seconds} s.`, {
    "Retry-After": String(seconds),
  });
}

/** The rate-limit key: the connecting IP, or "anon" when the header is missing (local dev). */
const clientKey = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "anon";

/** The public origin everything is linked from: SITE_URL when set, otherwise the request's. */
function siteOf(env: Env, url: URL): string {
  const configured = (env.SITE_URL ?? "").trim().replace(/\/+$/, "");
  return configured || url.origin;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

/**
 * One upsert per request in a fixed window. Returns the unix ms when the
 * window turns over if `key` is over the limit, else null. A failing
 * database never blocks a request: the limiter fails open and logs.
 */
async function overLimit(env: Env, cfg: typeof POST_LIMIT, key: string): Promise<number | null> {
  const window = Math.floor(Date.now() / cfg.periodMs);
  try {
    const row = await env.DB.prepare(SQL_RATE_LIMIT)
      .bind(`${cfg.bucket}:${key}`, window)
      .first<{ count: number }>();
    return (row?.count ?? 0) > cfg.limit ? (window + 1) * cfg.periodMs : null;
  } catch (error) {
    console.warn("actions rate limiter failed", error);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Body reading                                                        */
/* ------------------------------------------------------------------ */

type Body = { ok: true; value: Record<string, unknown> } | { ok: false; status: number; error: string };

/** The JSON object of a small request body, or why there is none. */
async function readJsonObject(request: Request): Promise<Body> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: `body exceeds ${MAX_BODY_BYTES} bytes` };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, status: 413, error: `body exceeds ${MAX_BODY_BYTES} bytes` };
  if (text.length === 0) return { ok: false, status: 400, error: "empty body" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: "body is not valid JSON" };
  }
  if (!isRecord(value)) return { ok: false, status: 400, error: "body must be a JSON object" };
  return { ok: true, value };
}

/* ------------------------------------------------------------------ */
/* Solana RPC                                                          */
/* ------------------------------------------------------------------ */

function rpcUpstreams(env: Env): string[] {
  const start = Math.floor(Math.random() * RPC_FALLBACKS.length);
  const rotated = RPC_FALLBACKS.map((_, i) => RPC_FALLBACKS[(start + i) % RPC_FALLBACKS.length]);
  return env.RPC_URL ? [env.RPC_URL, ...rotated] : rotated;
}

/** The host of an upstream, for messages: the private URL carries its API key in the query string. */
function upstreamHost(upstream: string): string {
  try {
    return new URL(upstream).host;
  } catch {
    return "upstream";
  }
}

/** A JSON-RPC level error (the upstream answered, the method failed); transport failures stay plain Errors. */
export class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** getTransaction's answer for a transaction newer than `maxSupportedTransactionVersion`; an invite is always legacy. */
export const RPC_UNSUPPORTED_VERSION = -32015;

/**
 * One JSON-RPC call by the Worker: the first upstream that answers with
 * anything but 403/429/5xx is used. Throws on transport failure and, as an
 * RpcError, on a JSON-RPC error, with a short message that is safe to show.
 */
async function rpcCall<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let lastError = "no upstream";
  let response: Response | null = null;
  for (const upstream of rpcUpstreams(env)) {
    try {
      const attempt = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (attempt.status >= 500 || attempt.status === 403 || attempt.status === 429) {
        lastError = `${upstreamHost(upstream)} responded ${attempt.status}`;
        continue;
      }
      response = attempt;
      break;
    } catch (error) {
      lastError = `${upstreamHost(upstream)}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!response) throw new Error(`rpc upstream unavailable: ${lastError}`);
  if (!response.ok) throw new Error(`upstream responded ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("upstream returned invalid JSON");
  }
  if (!isRecord(payload)) throw new Error("upstream returned no result");
  if (isRecord(payload.error)) {
    const { code, message } = payload.error;
    const errorCode = typeof code === "number" ? code : 0;
    throw new RpcError(errorCode, typeof message === "string" ? message : `rpc error ${String(code)}`);
  }
  return payload.result as T;
}

async function latestBlockhash(env: Env): Promise<RecentBlockhash> {
  const result = await rpcCall<{ value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>(
    env,
    "getLatestBlockhash",
    [{ commitment: "confirmed" }],
  );
  const value = result?.value;
  if (!value || typeof value.blockhash !== "string" || typeof value.lastValidBlockHeight !== "number") {
    throw new Error("getLatestBlockhash returned no blockhash");
  }
  return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
}

/** The confirmed transaction (jsonParsed), or null while the cluster has not seen it. */
function fetchTransaction(env: Env, signature: string): Promise<unknown> {
  return rpcCall<unknown>(env, "getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ]);
}

/**
 * Polls for the transaction for up to `budgetMs` and checks it. Null when it
 * is still not visible at the end of the budget.
 */
async function waitForInvite(
  env: Env,
  signature: string,
  from: string,
  to: string,
  budgetMs: number,
): Promise<InviteCheck | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const tx = await fetchTransaction(env, signature);
    if (tx !== null && tx !== undefined) return checkInviteTransaction(tx, from, to);
    if (Date.now() + CONFIRM_INTERVAL_MS > deadline) return null;
    await sleep(CONFIRM_INTERVAL_MS);
  }
}

async function recordInvite(env: Env, from: string, to: string, signature: string): Promise<void> {
  await env.DB.prepare(SQL_INSERT_INVITE).bind(from, to, signature, Date.now()).run();
}

/** The background half of /confirm: keeps polling after the answer went out, records on success, logs otherwise. */
async function recordWhenConfirmed(env: Env, signature: string, from: string, to: string): Promise<void> {
  try {
    const result = await waitForInvite(env, signature, from, to, CONFIRM_BACKGROUND_MS);
    if (result === null) console.warn("actions: invite still unconfirmed after the background wait", signature);
    else if (!result.ok) console.warn("actions: transaction is not an invite", signature, result.error);
    else await recordInvite(env, from, to, signature);
  } catch (error) {
    console.warn("actions: background confirm failed", signature, error);
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

const actionsJson = (): Response => json(ACTIONS_JSON, 200, "public, max-age=3600");

/** A person following the link without a Blink client lands on the site's own invite flow. */
function inviteRedirect(request: Request, rawWallet: string, site: string): Response | null {
  const wallet = decodeSegment(rawWallet);
  if (wallet === null || !checkWallet(wallet).ok) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  return Response.redirect(`${site}/write?to=${wallet}`, 302);
}

function getInvite(wallet: string, site: string): Response {
  const icon = `${site}/opengraph-image`;
  const check = checkWallet(wallet);
  if (!check.ok) {
    const body: ActionGetResponse = {
      type: "action",
      icon,
      title: "Invite to Dirac",
      description: "Send 0.0001 SOL and a Dirac memo to a Solana wallet to invite it to the post-quantum identity layer.",
      label: "Send invite",
      disabled: true,
      error: { message: `This link does not name a Solana wallet: ${check.error}.` },
    };
    return json(body);
  }
  const short = truncate(wallet);
  const body: ActionGetResponse = {
    type: "action",
    icon,
    title: `Invite ${short} to Dirac`,
    description:
      `Sends 0.0001 SOL to ${wallet} with the memo "${INVITE_MEMO_PREFIX} ${site}/passport?from=<your wallet>", ` +
      `the same invite the Dirac site sends. The invite is recorded, and ${short} sees who invited them on their ` +
      `public passport page ${site}/p?a=${wallet}. Network fee about 0.000005 SOL.`,
    label: "Send invite",
    links: {
      actions: [{ type: "transaction", href: `${site}/api/actions/invite/${wallet}`, label: "Send invite" }],
    },
  };
  return json(body);
}

/** Common first half of the two POSTs: the invitee, the body, the signer, no self-invite, the limit. */
type PostContext =
  | { ok: true; wallet: string; account: string; body: Record<string, unknown> }
  | { ok: false; response: Response };

async function postContext(request: Request, env: Env, rawWallet: string): Promise<PostContext> {
  const target = checkWallet(rawWallet, "the invited wallet");
  if (!target.ok) return { ok: false, response: actionError(400, target.error) };
  const body = await readJsonObject(request);
  if (!body.ok) return { ok: false, response: actionError(body.status, body.error) };
  const signer = checkWallet(body.value.account, "account");
  if (!signer.ok) return { ok: false, response: actionError(400, signer.error) };
  if (signer.wallet === target.wallet) {
    return { ok: false, response: actionError(400, "A wallet cannot invite itself.") };
  }
  const retry = await overLimit(env, POST_LIMIT, clientKey(request));
  if (retry !== null) return { ok: false, response: rateLimited(retry) };
  return { ok: true, wallet: target.wallet, account: signer.wallet, body: body.value };
}

async function postInvite(request: Request, env: Env, rawWallet: string, site: string): Promise<Response> {
  const ctx = await postContext(request, env, rawWallet);
  if (!ctx.ok) return ctx.response;
  const recent = await latestBlockhash(env);
  const transaction = buildInviteTransaction(ctx.account, ctx.wallet, site, recent);
  const body: ActionPostResponse = {
    type: "transaction",
    transaction,
    message: `Invite ${truncate(ctx.wallet)} to Dirac: 0.0001 SOL plus the Dirac memo.`,
    links: { next: { type: "post", href: `${site}/api/actions/invite/${ctx.wallet}/confirm` } },
  };
  return json(body);
}

function completed(site: string, wallet: string, description: string): Response {
  const body: CompletedAction = {
    type: "completed",
    icon: `${site}/opengraph-image`,
    title: `Invite sent to ${truncate(wallet)}`,
    description,
    label: "Invite sent",
  };
  return json(body);
}

async function confirmInvite(
  request: Request,
  env: Env,
  exec: ExecutionContext,
  rawWallet: string,
  site: string,
): Promise<Response> {
  const ctx = await postContext(request, env, rawWallet);
  if (!ctx.ok) return ctx.response;
  const { signature } = ctx.body;
  if (!isTxSignature(signature)) {
    return actionError(400, "The confirmation needs the transaction signature the wallet returned.");
  }
  const passport = `${site}/p?a=${ctx.wallet}`;
  let result: InviteCheck | null;
  try {
    result = await waitForInvite(env, signature, ctx.account, ctx.wallet, CONFIRM_WAIT_MS);
  } catch (error) {
    if (error instanceof RpcError && error.code === RPC_UNSUPPORTED_VERSION) {
      // The cluster has it, as a versioned transaction: not one this action built.
      result = { ok: false, error: "it is a versioned transaction; an invite is a legacy transaction" };
    } else {
      // The RPC could not be reached: the invite was sent regardless, so keep checking in the background.
      console.warn("actions: confirm could not read the transaction", signature, error);
      result = null;
    }
  }
  if (result === null) {
    exec.waitUntil(recordWhenConfirmed(env, signature, ctx.account, ctx.wallet));
    return completed(
      site,
      ctx.wallet,
      `The invite transaction ${truncate(signature)} is still confirming; it is recorded as soon as it lands, ` +
        `and ${truncate(ctx.wallet)} will see it on ${passport}.`,
    );
  }
  if (!result.ok) {
    return actionError(400, `Transaction ${truncate(signature)} is not a Dirac invite to ${truncate(ctx.wallet)}: ${result.error}.`);
  }
  await recordInvite(env, ctx.account, ctx.wallet, signature);
  return completed(
    site,
    ctx.wallet,
    `0.0001 SOL and the Dirac memo reached ${truncate(ctx.wallet)} in transaction ${truncate(signature)}. ` +
      `The invite is recorded; they see it on ${passport}.`,
  );
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * Answers the Actions routes (/actions.json, /invite/:wallet and everything
 * under /api/actions/), or `null` for any other path. `parts` is
 * `url.pathname.split("/").filter(Boolean)`. Mount it in `fetch` before the
 * /api check and before the generic OPTIONS answer: the Actions preflight
 * needs its own headers.
 */
export async function handleActions(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  parts: string[],
  url: URL,
): Promise<Response | null> {
  const site = siteOf(env, url);
  const [head, second, third, fourth, ...more] = parts;

  if (head === "actions.json" && second === undefined) {
    if (request.method === "OPTIONS") return preflight();
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD, OPTIONS");
    return actionsJson();
  }
  if (head === "invite" && second !== undefined && third === undefined) return inviteRedirect(request, second, site);
  if (head !== "api" || second !== "actions") return null;

  if (request.method === "OPTIONS") return preflight();
  try {
    if (third !== "invite" || fourth === undefined) return actionError(404, "no such action");
    const wallet = decodeSegment(fourth);
    if (wallet === null) return actionError(400, "malformed path");
    const method = request.method;
    if (more.length === 0) {
      if (method === "GET") return getInvite(wallet, site);
      if (method === "POST") return postInvite(request, env, wallet, site);
      return methodNotAllowed("GET, POST, OPTIONS");
    }
    if (more.length === 1 && more[0] === "confirm") {
      if (method === "POST") return confirmInvite(request, env, ctx, wallet, site);
      return methodNotAllowed("POST, OPTIONS");
    }
    return actionError(404, "no such action");
  } catch (error) {
    console.error("actions error", request.method, url.pathname, error);
    return actionError(500, "The invite could not be prepared right now; try again in a moment.");
  }
}

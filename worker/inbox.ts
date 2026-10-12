/**
 * Inbox and invites: the Worker routes under /api/inbox and /api/invites.
 *
 *   POST   /api/inbox/:to          store a sealed letter for a passport holder, optionally with a USDC payment
 *   GET    /api/inbox/:wallet      the owner's newest 50 envelopes (signed read), pending payments re-checked
 *   DELETE /api/inbox/:wallet/:id  drop one envelope (same signature)
 *   POST   /api/invites            record an invite transaction (from, to, tx)
 *   GET    /api/invites/:to        who invited a wallet
 *
 * `handleInbox` is called by the router in index.ts with the path split into
 * segments (`parts[0] === "api"`) and answers `null` for any route that is
 * not one of these. It keeps its own small helpers (JSON with CORS, body
 * reading with a size cap) so index.ts stays untouched.
 *
 * The server never sees a letter: it checks the envelope's shape and the
 * sender's Ed25519 signature over the envelope hash, and it stores
 * ciphertext. Reads and deletes are signed by the owner's wallet over a
 * message that carries the current minute, accepted two minutes either way.
 *
 * Rate limits live in the shared D1 `ratelimit` table (fixed one-minute
 * windows, keyed by client IP or by sender wallet). Over the limit: 429 with
 * `retryAt` and Retry-After.
 *
 * USDC with a sealed note (SPEC 3.4 extension): a letter may carry
 * `payment: { signature, amount }`. Before storing it the Worker reads the
 * transaction (getTransaction, jsonParsed, confirmed) through RPC_URL and the
 * well-known public endpoints of worker/index.ts (not the anonymous free one)
 * and checks it with `checkUsdcPayment`
 * (src/lib/solana/usdc.ts): a USDC TransferChecked of exactly `amount` from
 * the sender to the recipient's associated token account and the memo
 * `dirac:pay:v1:<first 32 hex of the envelope hash>`. Not visible yet: the
 * letter is stored with the payment "pending" and looked at again, a bounded
 * number of times, when the owner reads the inbox; it turns invalid after 8
 * "not visible" answers, or after 3 once the letter is 15 minutes old (an
 * unreachable RPC counts as none). A verified signature is
 * recorded in `inbox_payments`, so one transaction pays for one letter only.
 */

import {
  INBOX_PAGE,
  INVITES_PAGE,
  envelopeHash,
  isTxSignature,
  isWalletAddress,
  parseAuthHeader,
  parseEnvelope,
  parsePaymentClaim,
  verifyReadSig,
  verifySendSig,
  type Envelope,
  type InboxMessage,
  type LetterPayment,
  type PaymentClaim,
  type PaymentStatus,
} from "../src/lib/inbox";
import { checkUsdcPayment, type PaymentExpectation } from "../src/lib/solana/usdc";

export interface Env {
  DB: D1Database;
  /** Private Solana RPC (Helius), tried first; the public endpoints are the fallback. */
  RPC_URL?: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Largest request body parsed: a 16 KB letter is about 22 KB of base64 plus the signature. */
const MAX_BODY_BYTES = 32 * 1024;

/** Letters per minute from one client IP. */
const SEND_IP_LIMIT = { bucket: "inbox-send", limit: 10, periodMs: 60_000 };
/** Letters per minute from one (verified) sender wallet, across IPs. */
const SEND_WALLET_LIMIT = { bucket: "inbox-sender", limit: 30, periodMs: 60_000 };
/** Invite registrations per minute from one client IP. */
const INVITE_IP_LIMIT = { bucket: "invite", limit: 10, periodMs: 60_000 };
/** Inbox reads per minute, per owner wallet, that may re-check pending payments on chain; later reads just list. */
const PAY_RECHECK_LIMIT = { bucket: "inbox-paycheck", limit: 12, periodMs: 60_000 };

/**
 * Where a payment verdict may come from, rotated from a random start; a
 * private RPC_URL always goes first. A subset of worker/index.ts: an upstream
 * that answered with a forged transaction would mark a payment verified, so
 * the anonymous free endpoint (solana.leorpc.com) is left out. With none of
 * these reachable the payment stays pending and is checked again later.
 */
const RPC_FALLBACKS = ["https://solana-rpc.publicnode.com", "https://api.mainnet.solana.com"];
/** Longest wait for one upstream. */
const RPC_TIMEOUT_MS = 8_000;
/** getTransaction's answer for a transaction newer than maxSupportedTransactionVersion 0. */
const RPC_UNSUPPORTED_VERSION = -32015;

/** While a letter is posted: how long the payment is looked for (the client already waited for "confirmed"). */
const PAY_POST_BUDGET_MS = 10_000;
const PAY_POST_INTERVAL_MS = 2_500;
/** While the inbox is read: the budget for all re-checks of that read, run in parallel. */
const PAY_READ_BUDGET_MS = 6_000;
/** Pending payments re-checked per read. */
const PAY_RECHECKS_PER_READ = 5;
/** A pending payment is looked at no more than once per this interval. */
const PAY_RECHECK_INTERVAL_MS = 20_000;
/** "Not visible" answers from the chain before a pending payment becomes invalid. */
const PAY_MAX_CHECKS = 8;
/**
 * A pending payment this old (since the letter was stored) becomes invalid at
 * its next "not visible" answer once PAY_EXPIRY_MIN_CHECKS answers said so. A
 * transaction's blockhash expires after about two minutes, so one not seen in
 * fifteen will not land; the minimum keeps a slow first read of the inbox from
 * judging on a single look.
 */
const PAY_EXPIRY_MS = 15 * 60_000;
const PAY_EXPIRY_MIN_CHECKS = 3;

const REASON_ALREADY_ATTACHED = "this payment is already attached to another letter";
const REASON_NOT_FOUND = `the transaction was not found on chain after ${PAY_MAX_CHECKS} checks`;
const REASON_EXPIRED = `the transaction was not found on chain within ${PAY_EXPIRY_MS / 60_000} minutes`;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

const SQL_RATE_LIMIT = `
INSERT INTO ratelimit (key, window_start, count) VALUES (?1, ?2, 1)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN ratelimit.window_start = excluded.window_start THEN ratelimit.count + 1 ELSE 1 END,
  window_start = excluded.window_start
RETURNING count`;

const SQL_HAS_PASSPORT = `SELECT 1 AS found FROM passports WHERE wallet = ?`;

const SQL_INSERT_LETTER = `
INSERT INTO inbox (to_wallet, from_wallet, envelope, sender_sig, created_at)
VALUES (?, ?, ?, ?, ?)
RETURNING id`;

const SQL_INSERT_PAID_LETTER = `
INSERT INTO inbox (to_wallet, from_wallet, envelope, sender_sig, created_at,
                   payment_sig, payment_amount, payment_status, payment_reason, payment_checks, payment_checked_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING id`;

const SQL_LIST_INBOX = `
SELECT id, to_wallet, from_wallet, envelope, created_at,
       payment_sig, payment_amount, payment_status, payment_reason, payment_checks, payment_checked_at
FROM inbox WHERE to_wallet = ?
ORDER BY created_at DESC, id DESC
LIMIT ${INBOX_PAGE}`;

/** Every letter that names a payment signature, for the idempotent repeat and the uniqueness check. */
const SQL_LETTERS_BY_PAYMENT = `
SELECT id, to_wallet, from_wallet, envelope, created_at,
       payment_sig, payment_amount, payment_status, payment_reason, payment_checks, payment_checked_at
FROM inbox WHERE payment_sig = ?`;

const SQL_PAYMENT_SPENT = `SELECT letter_id FROM inbox_payments WHERE signature = ?`;

/** The verified transition, three statements in one batch (a transaction): claim, settle, supersede. */
const SQL_CLAIM_PAYMENT = `INSERT OR IGNORE INTO inbox_payments (signature, letter_id, created_at) VALUES (?1, ?2, ?3)`;

/** Verified when this letter holds the claim, invalid when another letter got there first. */
const SQL_SETTLE_CLAIM = `
UPDATE inbox SET
  payment_status = CASE WHEN EXISTS (SELECT 1 FROM inbox_payments WHERE signature = ?1 AND letter_id = ?2)
                        THEN 'verified' ELSE 'invalid' END,
  payment_reason = CASE WHEN EXISTS (SELECT 1 FROM inbox_payments WHERE signature = ?1 AND letter_id = ?2)
                        THEN NULL ELSE ?4 END,
  payment_checked_at = ?3
WHERE id = ?2 AND payment_status = 'pending'
RETURNING payment_status, payment_reason`;

/** Other letters still pending on the same signature can never verify any more. */
const SQL_SUPERSEDE = `
UPDATE inbox SET payment_status = 'invalid', payment_reason = ?2
WHERE payment_sig = ?1 AND payment_status = 'pending'
  AND id <> (SELECT letter_id FROM inbox_payments WHERE signature = ?1)`;

const SQL_PAYMENT_INVALID = `
UPDATE inbox SET payment_status = 'invalid', payment_reason = ?2, payment_checked_at = ?3
WHERE id = ?1 AND payment_status = 'pending'`;

/**
 * One more "not visible" answer. The payment turns invalid at the last allowed
 * check (?3, reason ?4), or once the letter is at least ?6 ms old (since
 * created_at) and this is at least the ?5th such answer (reason ?7). SET
 * expressions read the row as it was before the update.
 */
const SQL_PAYMENT_ABSENT = `
UPDATE inbox SET
  payment_checks = payment_checks + 1,
  payment_checked_at = ?2,
  payment_status = CASE
    WHEN payment_checks + 1 >= ?3 THEN 'invalid'
    WHEN payment_checks + 1 >= ?5 AND ?2 - created_at >= ?6 THEN 'invalid'
    ELSE 'pending' END,
  payment_reason = CASE
    WHEN payment_checks + 1 >= ?3 THEN ?4
    WHEN payment_checks + 1 >= ?5 AND ?2 - created_at >= ?6 THEN ?7
    ELSE NULL END
WHERE id = ?1 AND payment_status = 'pending'
RETURNING payment_status, payment_reason, payment_checks`;

/** The chain could not be asked: only the time of the attempt is kept, no retry is spent. */
const SQL_PAYMENT_UNREACHABLE = `UPDATE inbox SET payment_checked_at = ?2 WHERE id = ?1 AND payment_status = 'pending'`;

const SQL_PAYMENT_STATE = `SELECT payment_status, payment_reason FROM inbox WHERE id = ?`;

const SQL_DROP_LETTER = `DELETE FROM inbox WHERE id = ?`;

const SQL_DELETE_LETTER = `DELETE FROM inbox WHERE id = ? AND to_wallet = ?`;

/** The pair is the primary key, so a repeat (a second invite transaction) keeps the first row. */
const SQL_INSERT_INVITE = `
INSERT OR IGNORE INTO invites (from_wallet, to_wallet, tx, created_at)
VALUES (?, ?, ?, ?)`;

const SQL_COUNT_INVITES = `SELECT COUNT(*) AS count FROM invites WHERE to_wallet = ?`;

const SQL_LIST_INVITES = `
SELECT from_wallet FROM invites WHERE to_wallet = ?
ORDER BY created_at DESC
LIMIT ${INVITES_PAGE}`;

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface InboxRow {
  id: number;
  to_wallet: string;
  from_wallet: string;
  envelope: string;
  created_at: number;
  payment_sig: string | null;
  payment_amount: number | null;
  payment_status: string | null;
  payment_reason: string | null;
  payment_checks: number;
  payment_checked_at: number | null;
}

interface InviteRow {
  from_wallet: string;
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

const badRequest = (error: string): Response => json({ error }, 400);
const unauthorized = (): Response => json({ error: "unauthorized" }, 401);
const notFound = (error = "not found"): Response => json({ error }, 404);
const methodNotAllowed = (allow: string): Response => json({ error: "method not allowed" }, 405, { Allow: allow });

/** 429 with the unix ms at which the window turns over and the matching Retry-After. */
function rateLimited(retryAt: number): Response {
  const seconds = Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  return json({ error: "rate limited", retryAt }, 429, { "Retry-After": String(seconds) });
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rate-limit key: the connecting IP, or "anon" when the header is missing (local dev). */
const clientKey = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "anon";

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

interface Limit {
  bucket: string;
  limit: number;
  periodMs: number;
}

/**
 * One upsert per request in a fixed window. Returns the unix ms when the
 * window turns over if `key` is over `cfg.limit`, else null. A failing
 * database never blocks a request: the limiter fails open and logs.
 */
async function overLimit(env: Env, cfg: Limit, key: string): Promise<number | null> {
  const window = Math.floor(Date.now() / cfg.periodMs);
  try {
    const row = await env.DB.prepare(SQL_RATE_LIMIT)
      .bind(`${cfg.bucket}:${key}`, window)
      .first<{ count: number }>();
    return (row?.count ?? 0) > cfg.limit ? (window + 1) * cfg.periodMs : null;
  } catch (error) {
    console.warn("inbox rate limiter failed", error);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Body reading                                                        */
/* ------------------------------------------------------------------ */

type Body = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/** Reads the body as JSON without ever buffering more than MAX_BODY_BYTES. */
async function readJsonBody(request: Request): Promise<Body> {
  const tooLarge: Body = { ok: false, status: 413, error: `body exceeds ${MAX_BODY_BYTES} bytes` };
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return tooLarge;

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return tooLarge;
      }
      chunks.push(value);
    }
  }
  if (total === 0) return { ok: false, status: 400, error: "empty body" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: "body is not valid JSON" };
  }
}

/* ------------------------------------------------------------------ */
/* Authorization: Dirac <wallet>:<bucket>:<sig>                        */
/* ------------------------------------------------------------------ */

/** True when the request carries a fresh read signature by `wallet` itself. */
function authorizedOwner(request: Request, wallet: string): boolean {
  const auth = parseAuthHeader(request.headers.get("authorization"));
  if (!auth || auth.wallet !== wallet) return false;
  return verifyReadSig(wallet, auth.bucket, auth.sig);
}

/* ------------------------------------------------------------------ */
/* Solana RPC                                                          */
/* ------------------------------------------------------------------ */

function rpcUpstreams(env: Env): string[] {
  const start = Math.floor(Math.random() * RPC_FALLBACKS.length);
  const rotated = RPC_FALLBACKS.map((_, i) => RPC_FALLBACKS[(start + i) % RPC_FALLBACKS.length]);
  return env.RPC_URL ? [env.RPC_URL, ...rotated] : rotated;
}

/** The host of an upstream, for logs: the private URL carries its API key in the query string. */
function upstreamHost(upstream: string): string {
  try {
    return new URL(upstream).host;
  } catch {
    return "upstream";
  }
}

/** A JSON-RPC level error (the upstream answered, the method failed); transport failures stay plain Errors. */
class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/**
 * One JSON-RPC call: the first upstream that answers with anything but
 * 403/429/5xx before `deadline` (unix ms) is used. Throws on transport
 * failure and, as an RpcError, on a JSON-RPC error.
 */
async function rpcCall<T>(env: Env, method: string, params: unknown[], deadline: number): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let lastError = "no upstream";
  let response: Response | null = null;
  for (const upstream of rpcUpstreams(env)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      lastError = "out of time";
      break;
    }
    try {
      const attempt = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(Math.min(RPC_TIMEOUT_MS, remaining)),
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
    throw new RpcError(typeof code === "number" ? code : 0, typeof message === "string" ? message : `rpc error ${String(code)}`);
  }
  return payload.result as T;
}

/* ------------------------------------------------------------------ */
/* USDC payments                                                       */
/* ------------------------------------------------------------------ */

/** What one look at the chain said about a payment. */
type ChainLook =
  | { kind: "verified" }
  | { kind: "invalid"; reason: string }
  /** the cluster answered: no such transaction yet */
  | { kind: "absent" }
  /** no upstream answered in time */
  | { kind: "unreachable" };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** getTransaction (jsonParsed, confirmed, legacy and v0) and the verdict of `checkUsdcPayment`. */
async function lookOnChain(env: Env, signature: string, expect: PaymentExpectation, deadline: number): Promise<ChainLook> {
  try {
    const tx = await rpcCall<unknown>(
      env,
      "getTransaction",
      [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      deadline,
    );
    if (tx === null || tx === undefined) return { kind: "absent" };
    const check = checkUsdcPayment(tx, expect);
    return check.ok ? { kind: "verified" } : { kind: "invalid", reason: check.error };
  } catch (error) {
    if (error instanceof RpcError && error.code === RPC_UNSUPPORTED_VERSION) {
      return { kind: "invalid", reason: "it is a transaction version newer than v0; the site sends legacy transactions" };
    }
    console.warn("inbox: payment lookup failed", signature, error);
    return { kind: "unreachable" };
  }
}

/** While a letter is posted: a few polls within PAY_POST_BUDGET_MS, stopping at the first verdict. */
async function lookWithPolls(env: Env, signature: string, expect: PaymentExpectation): Promise<ChainLook> {
  const deadline = Date.now() + PAY_POST_BUDGET_MS;
  for (;;) {
    const look = await lookOnChain(env, signature, expect, deadline);
    if (look.kind === "verified" || look.kind === "invalid") return look;
    if (Date.now() + PAY_POST_INTERVAL_MS >= deadline) return look;
    await sleep(PAY_POST_INTERVAL_MS);
  }
}

function asStatus(value: string | null): PaymentStatus {
  return value === "verified" || value === "invalid" ? value : "pending";
}

/** The payment of a row as the API reports it, or null for a letter without one. */
function paymentOf(row: InboxRow): LetterPayment | null {
  if (row.payment_sig === null || row.payment_amount === null) return null;
  const status = asStatus(row.payment_status);
  return {
    signature: row.payment_sig,
    amount: row.payment_amount,
    status,
    reason: status === "invalid" ? (row.payment_reason ?? "the payment did not verify") : null,
  };
}

interface Settled {
  status: PaymentStatus;
  reason: string | null;
}

async function currentState(env: Env, id: number): Promise<Settled> {
  const row = await env.DB.prepare(SQL_PAYMENT_STATE).bind(id).first<{ payment_status: string | null; payment_reason: string | null }>();
  return { status: asStatus(row?.payment_status ?? null), reason: row?.payment_reason ?? null };
}

/**
 * The verified transition of letter `id`: claims the signature in
 * `inbox_payments` (first letter wins), settles the row to verified or, when
 * another letter holds the claim, invalid; other letters still pending on the
 * signature become invalid. One D1 batch, so it is atomic.
 */
async function claimPayment(env: Env, signature: string, id: number, now: number): Promise<Settled> {
  const [, settled] = await env.DB.batch([
    env.DB.prepare(SQL_CLAIM_PAYMENT).bind(signature, id, now),
    env.DB.prepare(SQL_SETTLE_CLAIM).bind(signature, id, now, REASON_ALREADY_ATTACHED),
    env.DB.prepare(SQL_SUPERSEDE).bind(signature, REASON_ALREADY_ATTACHED),
  ]);
  const row = (settled.results as { payment_status: string | null; payment_reason: string | null }[] | undefined)?.[0];
  if (!row) return currentState(env, id);
  return { status: asStatus(row.payment_status), reason: row.payment_reason };
}

/** Writes what one look found for a stored, pending payment; returns the state the row ends in. */
async function settleLook(env: Env, id: number, signature: string, look: ChainLook, now: number): Promise<Settled> {
  switch (look.kind) {
    case "verified":
      return claimPayment(env, signature, id, now);
    case "invalid":
      await env.DB.prepare(SQL_PAYMENT_INVALID).bind(id, look.reason, now).run();
      return currentState(env, id);
    case "absent": {
      const row = await env.DB.prepare(SQL_PAYMENT_ABSENT)
        .bind(id, now, PAY_MAX_CHECKS, REASON_NOT_FOUND, PAY_EXPIRY_MIN_CHECKS, PAY_EXPIRY_MS, REASON_EXPIRED)
        .first<{ payment_status: string | null; payment_reason: string | null }>();
      return row ? { status: asStatus(row.payment_status), reason: row.payment_reason } : currentState(env, id);
    }
    case "unreachable":
      await env.DB.prepare(SQL_PAYMENT_UNREACHABLE).bind(id, now).run();
      return { status: "pending", reason: null };
  }
}

/**
 * Lazy re-check on read: up to PAY_RECHECKS_PER_READ pending payments that
 * still have checks left and were not looked at in the last
 * PAY_RECHECK_INTERVAL_MS, in parallel within PAY_READ_BUDGET_MS. Updates
 * the rows in place; a failure leaves the row pending and never fails the read.
 */
async function recheckPending(env: Env, wallet: string, rows: InboxRow[]): Promise<void> {
  const now = Date.now();
  const due = rows
    .filter(
      (r) =>
        r.payment_sig !== null &&
        r.payment_amount !== null &&
        r.payment_status === "pending" &&
        r.payment_checks < PAY_MAX_CHECKS &&
        (r.payment_checked_at === null || now - r.payment_checked_at >= PAY_RECHECK_INTERVAL_MS),
    )
    .slice(0, PAY_RECHECKS_PER_READ);
  if (due.length === 0) return;
  if ((await overLimit(env, PAY_RECHECK_LIMIT, wallet)) !== null) return;

  const deadline = now + PAY_READ_BUDGET_MS;
  await Promise.all(
    due.map(async (row) => {
      const signature = row.payment_sig as string;
      try {
        const parsed = parseEnvelope(JSON.parse(row.envelope));
        if (!parsed.ok) return;
        const expect: PaymentExpectation = {
          sender: row.from_wallet,
          recipient: row.to_wallet,
          amount: row.payment_amount as number,
          envelopeHash: envelopeHash(parsed.value),
        };
        const look = await lookOnChain(env, signature, expect, deadline);
        const settled = await settleLook(env, row.id, signature, look, Date.now());
        row.payment_status = settled.status;
        row.payment_reason = settled.reason;
      } catch (error) {
        console.warn("inbox: payment re-check failed", row.id, error);
      }
    }),
  );
}

/** Same letter: same recipient, sender, envelope and claimed amount. */
function sameLetter(row: InboxRow, to: string, sender: string, envelopeJson: string, claim: PaymentClaim): boolean {
  return (
    row.to_wallet === to &&
    row.from_wallet === sender &&
    row.envelope === envelopeJson &&
    row.payment_amount === claim.amount
  );
}

/**
 * Stores a letter that claims a payment. A repeat of the same letter with the
 * same payment answers the stored one; a signature already spent on another
 * letter is 409. Otherwise the chain is asked (a few polls), the row is
 * written with the verdict and, when verified, the signature is claimed.
 */
async function storePaidLetter(
  env: Env,
  to: string,
  sender: string,
  sealed: Envelope,
  senderSig: string,
  claim: PaymentClaim,
): Promise<Response> {
  const envelopeJson = JSON.stringify(sealed);
  const prior = (await env.DB.prepare(SQL_LETTERS_BY_PAYMENT).bind(claim.signature).all<InboxRow>()).results ?? [];
  const repeat = prior.find((r) => sameLetter(r, to, sender, envelopeJson, claim));
  if (repeat) return json({ ok: true, id: repeat.id, payment: paymentOf(repeat) });

  const spent = await env.DB.prepare(SQL_PAYMENT_SPENT).bind(claim.signature).first<{ letter_id: number }>();
  if (spent) return json({ error: REASON_ALREADY_ATTACHED }, 409);

  const expect: PaymentExpectation = { sender, recipient: to, amount: claim.amount, envelopeHash: envelopeHash(sealed) };
  const look = await lookWithPolls(env, claim.signature, expect);
  const now = Date.now();
  const status: PaymentStatus = look.kind === "invalid" ? "invalid" : "pending";
  const reason = look.kind === "invalid" ? look.reason : null;
  const checks = look.kind === "absent" ? 1 : 0;

  const row = await env.DB.prepare(SQL_INSERT_PAID_LETTER)
    .bind(to, sender, envelopeJson, senderSig, now, claim.signature, claim.amount, status, reason, checks, now)
    .first<{ id: number }>();
  if (!row) throw new Error("inbox insert returned no row");

  let settled: Settled = { status, reason };
  if (look.kind === "verified") {
    settled = await claimPayment(env, claim.signature, row.id, now);
    if (settled.status !== "verified") {
      // Lost the claim to a concurrent post: drop this copy, as the spent pre-check above would have.
      // When the winner is this very letter (a double submit), answer with it.
      await env.DB.prepare(SQL_DROP_LETTER).bind(row.id).run();
      const winner = await env.DB.prepare(SQL_PAYMENT_SPENT).bind(claim.signature).first<{ letter_id: number }>();
      const twin = winner
        ? ((await env.DB.prepare(SQL_LETTERS_BY_PAYMENT).bind(claim.signature).all<InboxRow>()).results ?? []).find(
            (r) => r.id === winner.letter_id && sameLetter(r, to, sender, envelopeJson, claim),
          )
        : undefined;
      if (twin) return json({ ok: true, id: twin.id, payment: paymentOf(twin) });
      return json({ error: REASON_ALREADY_ATTACHED }, 409);
    }
  }

  const payment: LetterPayment = { signature: claim.signature, amount: claim.amount, status: settled.status, reason: settled.reason };
  return json({ ok: true, id: row.id, payment });
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function sendLetter(request: Request, env: Env, to: string): Promise<Response> {
  if (!isWalletAddress(to)) return badRequest("recipient must be a base58 Solana address");
  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");

  const { envelope, sender, sender_sig, payment } = body.value;
  if (!isWalletAddress(sender)) return badRequest("sender must be a base58 Solana address");
  if (typeof sender_sig !== "string" || sender_sig.length === 0 || sender_sig.length > 128) {
    return badRequest("sender_sig must be a base64 Ed25519 signature");
  }
  const parsed = parseEnvelope(envelope);
  if (!parsed.ok) return badRequest(parsed.error);
  const sealed: Envelope = parsed.value;
  const claim = parsePaymentClaim(payment);
  if (!claim.ok) return badRequest(claim.error);
  if (claim.value && sender === to) return badRequest("a payment to your own wallet moves nothing");

  // Per IP first: an unverifiable signature still costs the client its quota.
  const ipRetry = await overLimit(env, SEND_IP_LIMIT, clientKey(request));
  if (ipRetry !== null) return rateLimited(ipRetry);

  if (!verifySendSig(to, sealed, sender, sender_sig)) {
    return badRequest("sender_sig does not verify: it must sign SEND_MESSAGE(to, envelopeHash(envelope)) with the sender wallet");
  }

  // Per sender only after the signature checks out, so nobody can spend another wallet's quota.
  const senderRetry = await overLimit(env, SEND_WALLET_LIMIT, sender);
  if (senderRetry !== null) return rateLimited(senderRetry);

  const recipient = await env.DB.prepare(SQL_HAS_PASSPORT).bind(to).first<{ found: number }>();
  if (!recipient) return notFound("recipient has no passport");

  if (claim.value) return storePaidLetter(env, to, sender, sealed, sender_sig, claim.value);

  const row = await env.DB.prepare(SQL_INSERT_LETTER)
    .bind(to, sender, JSON.stringify(sealed), sender_sig, Date.now())
    .first<{ id: number }>();
  if (!row) throw new Error("inbox insert returned no row");

  return json({ ok: true, id: row.id });
}

async function listInbox(request: Request, env: Env, wallet: string): Promise<Response> {
  if (!isWalletAddress(wallet)) return badRequest("wallet must be a base58 Solana address");
  if (!authorizedOwner(request, wallet)) return unauthorized();

  const { results } = await env.DB.prepare(SQL_LIST_INBOX).bind(wallet).all<InboxRow>();
  const rows = results ?? [];
  await recheckPending(env, wallet, rows);

  const messages: InboxMessage[] = [];
  for (const row of rows) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(row.envelope);
    } catch {
      continue;
    }
    const parsed = parseEnvelope(envelope);
    if (!parsed.ok) continue;
    messages.push({
      id: row.id,
      from: row.from_wallet,
      envelope: parsed.value,
      created_at: row.created_at,
      payment: paymentOf(row),
    });
  }
  return json({ messages });
}

async function deleteLetter(request: Request, env: Env, wallet: string, rawId: string): Promise<Response> {
  if (!isWalletAddress(wallet)) return badRequest("wallet must be a base58 Solana address");
  if (!/^\d{1,15}$/.test(rawId)) return badRequest("message id must be a positive integer");
  if (!authorizedOwner(request, wallet)) return unauthorized();

  await env.DB.prepare(SQL_DELETE_LETTER).bind(Number(rawId), wallet).run();
  return json({ ok: true });
}

async function registerInvite(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");

  const { from, to, tx } = body.value;
  if (!isWalletAddress(from)) return badRequest("from must be a base58 Solana address");
  if (!isWalletAddress(to)) return badRequest("to must be a base58 Solana address");
  if (from === to) return badRequest("a wallet cannot invite itself");
  if (!isTxSignature(tx)) return badRequest("tx must be a base58 Solana transaction signature");

  const retry = await overLimit(env, INVITE_IP_LIMIT, clientKey(request));
  if (retry !== null) return rateLimited(retry);

  await env.DB.prepare(SQL_INSERT_INVITE).bind(from, to, tx, Date.now()).run();
  return json({ ok: true });
}

async function listInvites(env: Env, to: string): Promise<Response> {
  if (!isWalletAddress(to)) return badRequest("wallet must be a base58 Solana address");
  const [counted, listed] = await env.DB.batch([
    env.DB.prepare(SQL_COUNT_INVITES).bind(to),
    env.DB.prepare(SQL_LIST_INVITES).bind(to),
  ]);
  const countRow = (counted.results as { count: number }[] | undefined)?.[0];
  const rows = (listed.results as InviteRow[] | undefined) ?? [];
  return json({ count: countRow?.count ?? 0, from: rows.map((r) => r.from_wallet) });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

/**
 * Answers the inbox and invite routes, or `null` when `parts` is not one of
 * them. `parts` is `url.pathname.split("/").filter(Boolean)`.
 */
export async function handleInbox(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  parts: string[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the shared handleX signature; these routes need only `parts`
  _url: URL,
): Promise<Response | null> {
  const [api, resource, ...rawRest] = parts;
  if (api !== "api" || (resource !== "inbox" && resource !== "invites")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const rest: string[] = [];
  for (const segment of rawRest) {
    const decoded = decodeSegment(segment);
    if (decoded === null) return badRequest("malformed path");
    rest.push(decoded);
  }
  const method = request.method;

  if (resource === "inbox") {
    if (rest.length === 1) {
      if (method === "POST") return sendLetter(request, env, rest[0]);
      if (method === "GET") return listInbox(request, env, rest[0]);
      return methodNotAllowed("GET, POST, OPTIONS");
    }
    if (rest.length === 2) {
      if (method === "DELETE") return deleteLetter(request, env, rest[0], rest[1]);
      return methodNotAllowed("DELETE, OPTIONS");
    }
    return null;
  }

  // invites
  if (rest.length === 0) {
    if (method === "POST") return registerInvite(request, env);
    return methodNotAllowed("POST, OPTIONS");
  }
  if (rest.length === 1) {
    if (method === "GET") return listInvites(env, rest[0]);
    return methodNotAllowed("GET, OPTIONS");
  }
  return null;
}

/**
 * Dirac registry API: a Cloudflare Worker in front of the static Next.js export.
 *
 * Routes (JSON, CORS "*"):
 *   POST /api/passports          register a passport bundle; replacing a wallet's passport needs
 *                                rotation_sig from its current ML-DSA key; anchor_tx is checked on chain
 *   GET  /api/passports/:wallet  fetch the active passport record (re-checks an unverified anchor)
 *   GET  /api/passports/:wallet/history  every version of the wallet's passport, newest first
 *   POST /api/seals              register a verified seal (idempotent by id)
 *   GET  /api/seals/:id          fetch a seal
 *   GET  /api/stats              registry counts
 *   GET  /api/scan/:wallet       exposure report v3 for one address (edge-cached 60 s when complete)
 *   POST /api/rpc                Solana JSON-RPC proxy
 *   /api/pet, /api/pet/act, /api/pet/history      the quantum pet (worker/pet.ts)
 *   /api/inbox/:wallet[/:id], /api/invites[/:to]  sealed letters and invites (worker/inbox.ts)
 *   /api/arena, /api/arena/me, /api/arena/spar, /api/arena/commit, /api/arena/reveal, /api/arena/bout/:id  qubit arena (worker/arena.ts)
 *   PUT /api/share/{scan|passport}/:wallet, PUT /api/share/pet/:day (same-origin pages only), GET|HEAD /api/share/<kind>/<id>.png
 *                                                 browser-drawn share cards; worker/html.ts finishHtml writes the per-target head
 *
 * The pet and inbox modules are delegated to after the routes above; the
 * `scheduled` export collapses the pet's day at 00:00 UTC (wrangler.jsonc
 * `triggers.crons`).
 *
 * Every other /api path answers 404 JSON. Every request passes through the
 * Worker (`run_worker_first: true`): non-/api requests are redirected to
 * https, fetched from the ASSETS binding and answered with the security
 * headers (HSTS on everything, CSP and friends on HTML).
 *
 * Rate limits (Workers rate-limit bindings, keyed by client IP): 12 scans and
 * 120 proxied RPC calls per minute. Over the limit: 429 with Retry-After.
 *
 * The Worker verifies everything it stores with the same `pq` module the
 * browser uses: the ML-DSA self-signature, the Ed25519 wallet binding, the
 * ML-DSA rotation signature and the ML-DSA seal signature. Nothing unverified
 * is written to D1, except an anchor transaction named in a first
 * registration or a rotation that is not visible on chain yet: it is kept as
 * an unverified claim (passport_versions.anchor_verified = 0) and never shown
 * as an anchor until the Worker has found it.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import {
  ANCHOR_MEMO,
  SEAL_CLOCK_SKEW_MS,
  b64,
  passportHash,
  sealId,
  verifyRotation,
  verifySeal,
  verifySelf,
  verifyWalletSig,
} from "../src/lib/pq";
import type { Passport, QSeal } from "../src/lib/pq";
import type {
  AddressKind,
  ScanAddress,
  ScanAuthorities,
  ScanAuthorityMint,
  ScanExposure,
  ScanExposureLine,
  ScanIdentity,
  ScanMultisigAccount,
  ScanMultisigs,
  ScanPassport,
  ScanReport,
  ScanToken,
  ScanVault,
  SourceName,
  SourceState,
} from "../src/lib/scan";
import { handleInbox } from "./inbox";
import { collapsePet, handlePet, pollQpu } from "./pet";
import { handleArena, resolveTournaments } from "./arena";
import { handleShare } from "./share";
import { finishHtml } from "./html";
import { handleActions } from "./actions";
import { handleBadge } from "./badge";
import {
  MEMBER_SLOTS,
  SQUADS_V4_PROGRAM,
  findMultisigsForMember,
  multisigFromAccount,
  vaultPda,
  type MemberSearch,
  type MultisigAccount,
  type ParsedMultisig,
  type SquadsRpc,
} from "./squads";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Optional private Solana RPC set with `wrangler secret put RPC_URL`. Expected
   * to be a Helius endpoint: the scanner needs its DAS methods and
   * getProgramAccounts, which the free fallbacks do not serve.
   */
  RPC_URL?: string;
  /** IBM Cloud API key for the pet's Sunday collapse on IBM Quantum (worker/qpu.ts); unset = every day on the simulator */
  IBM_QUANTUM_API_KEY?: string;
  /** optional IBM Quantum instance CRN, when the key cannot list the account's instances */
  IBM_QUANTUM_CRN?: string;
  /** Rate-limit binding for /api/scan/*: 12 requests per minute per client IP. */
  SCAN_LIMITER: RateLimit;
  /** Rate-limit binding for /api/rpc: 120 requests per minute per client IP. */
  RPC_LIMITER: RateLimit;
  /** Public origin of the site, used in the pet's X posts (default https://dirac.digital). */
  SITE_URL?: string;
  /** X API OAuth 1.0a credentials for the pet's daily post; all four are secrets, posting is skipped without them. */
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_WINDOW_SECONDS = 60;

/** The rate-limit key: the connecting IP, or "anon" when the header is missing (local dev). */
const clientKey = (request: Request): string => request.headers.get("cf-connecting-ip") ?? "anon";

/**
 * True when `key` is over the binding's limit. A missing or failing binding
 * never blocks a request: the limiter fails open and logs.
 */
// Rate limits need shared state: consecutive requests from one client land on
// different machines, so neither an in-memory counter nor the platform binding
// (which counts per machine and proved permissive) is enough on its own. The
// authoritative counter lives in D1: one upsert per request in a fixed
// one-minute window. The platform binding is kept as a cheap secondary check.
const SCAN_LIMIT = { limit: 12, periodMs: 60_000 };
const RPC_LIMIT = { limit: 120, periodMs: 60_000 };
/** Passport registrations per minute per client IP: throwaway identities for the arena queue cost at least time. */
const PASSPORT_LIMIT = { limit: 10, periodMs: 60_000 };

async function dbOverLimit(env: Env, bucket: string, key: string, cfg: { limit: number; periodMs: number }): Promise<boolean> {
  const window = Math.floor(Date.now() / cfg.periodMs);
  try {
    const row = await env.DB.prepare(
      `INSERT INTO ratelimit (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN ratelimit.window_start = excluded.window_start THEN ratelimit.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
      .bind(`${bucket}:${key}`, window)
      .first<{ count: number }>();
    if (Math.random() < 0.02) {
      // occasional cleanup of stale windows; failure is harmless
      env.DB.prepare("DELETE FROM ratelimit WHERE window_start < ?1").bind(window - 10).run().catch(() => undefined);
    }
    return (row?.count ?? 0) > cfg.limit;
  } catch (error) {
    console.warn("db rate limiter failed", error);
    return false;
  }
}

async function overLimit(
  env: Env,
  limiter: RateLimit | undefined,
  key: string,
  cfg: { limit: number; periodMs: number },
): Promise<boolean> {
  if (await dbOverLimit(env, String(cfg.limit), key, cfg)) return true;
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch (error) {
    console.warn("rate limiter failed", error);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Solana RPC                                                          */
/* ------------------------------------------------------------------ */

// The public Solana endpoint refuses browser requests (403), so the site talks
// to /api/rpc on its own origin and the Worker forwards JSON-RPC upstream.
// Free public endpoints rate-limit per IP, so requests rotate across several
// and fall through on 429/403/5xx. A private RPC_URL always goes first. The
// scanner uses the same upstreams through `rpcCall`.
const RPC_FALLBACKS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet.solana.com",
  "https://solana.leorpc.com/?api_key=FREE",
];
const MAX_RPC_BYTES = 256 * 1024;
/** Budget for one of the scanner's own RPC calls; the proxy forwards without a timeout. */
const RPC_TIMEOUT_MS = 20_000;

/** Upstreams in call order: the private RPC first, then the free endpoints from a random start. */
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

type Forwarded = { ok: true; response: Response } | { ok: false; error: string };

/**
 * POSTs a JSON-RPC body to the first upstream that answers with anything but
 * 403/429/5xx. The body goes out verbatim; the caller reads the response.
 */
async function forwardRpc(body: string, upstreams: string[], timeoutMs?: number): Promise<Forwarded> {
  let lastError = "no upstream";
  for (const upstream of upstreams) {
    try {
      const response = await fetch(upstream, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 500 || response.status === 403 || response.status === 429) {
        lastError = `${upstreamHost(upstream)} responded ${response.status}`;
        continue;
      }
      return { ok: true, response };
    } catch (error) {
      lastError = `${upstreamHost(upstream)}: ${describeError(error)}`;
    }
  }
  return { ok: false, error: `rpc upstream unavailable: ${lastError}` };
}

async function proxyRpc(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_RPC_BYTES) return json({ error: "rpc body too large" }, 413);
  try {
    JSON.parse(text);
  } catch {
    return json({ error: "rpc body must be JSON" }, 400);
  }
  const forwarded = await forwardRpc(text, rpcUpstreams(env));
  if (!forwarded.ok) return json({ error: forwarded.error }, 502);
  const body = await forwarded.response.text();
  return new Response(body, {
    status: forwarded.response.status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * One JSON-RPC call made by the Worker itself. `params` is an array for the
 * standard methods and an object for the DAS methods. Throws on transport
 * failure and on a JSON-RPC error, with a short message that is safe to show.
 */
async function rpcCall<T>(env: Env, method: string, params: unknown, upstreams = rpcUpstreams(env)): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const forwarded = await forwardRpc(body, upstreams, RPC_TIMEOUT_MS);
  if (!forwarded.ok) throw new Error(forwarded.error);
  const { response } = forwarded;
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
    throw new Error(typeof message === "string" ? message : `rpc error ${String(code)}`);
  }
  return payload.result as T;
}

/** Marks a call that was not attempted because it needs the private RPC. Listed, but not a failure. */
class SkippedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkippedError";
  }
}

/** A call only the private RPC can serve (DAS, getProgramAccounts): no fallback rotation. */
async function privateRpc<T>(env: Env, method: string, params: unknown): Promise<T> {
  if (!env.RPC_URL) throw new SkippedError("no private RPC configured");
  return rpcCall<T>(env, method, params, [env.RPC_URL]);
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Largest request body we are willing to parse (a passport bundle is ~9 KB). */
const MAX_BODY_BYTES = 64 * 1024;
const KEM_PK_LEN = 1184;
const DSA_PK_LEN = 1952;
const DSA_SIG_LEN = 3309;
const ED25519_PK_LEN = 32;
/** Solana transaction signatures are 64 bytes, base58 encoded. */
const TX_SIG_LEN = 64;
const MAX_NAME_LEN = 256;
/** Oldest `created_at` we accept (2024-01-01T00:00:00Z); guards against garbage timestamps. */
const MIN_CREATED_AT = 1_704_067_200_000;
/** Tolerated client clock skew into the future. */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const HEX_64 = /^[0-9a-f]{64}$/;

const PASSPORT_FIELDS = ["v", "wallet", "kem_pk", "dsa_pk", "mode", "created_at"] as const;
const SEAL_FIELDS = [
  "v",
  "hash_alg",
  "doc_hash",
  "passport",
  "dsa_pk",
  "sig_alg",
  "signature",
  "signed_at",
  "name",
  "anchor_tx",
] as const;

// DELETE and Authorization are for the inbox routes: the preflight for every
// /api path is answered here, before the router, so the headers must cover
// what worker/inbox.ts accepts.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, solana-client",
  "Access-Control-Max-Age": "86400",
};

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

/*
 * Passport registry v2 (migration 0013). `passports` holds the active version
 * per wallet; `passport_versions` every version, version 1 first. A wallet's
 * first passport registers as before. A different passport replaces it only
 * with `rotation_sig` from the active version's ML-DSA key (pq.ROTATE_MESSAGE),
 * so a forged Ed25519 wallet signature alone can never swap a passport.
 *
 * Anchors: `passport_versions.anchor_tx` is the memo transaction the client
 * named, `anchor_verified` says whether the Worker found it on chain from the
 * wallet with the passport's memo. `passports.anchor_tx` carries a VERIFIED
 * anchor only (NULL otherwise), so the other readers of that column (badge,
 * share cards, scanner) never show a claim as an anchor.
 *
 * Writes that depend on what was read are guarded by WHERE clauses on the
 * row read (version and hash) and run as one D1 batch (a transaction): a
 * concurrent rotation makes the guarded statements touch no row, which the
 * handler reports as a conflict instead of interleaving.
 */

/** The active passport with its version row; LEFT JOIN because a row written by a pre-0013 Worker has none. */
const SQL_GET_ACTIVE = `
SELECT p.hash, p.bundle, p.self_sig, p.wallet_sig, p.mode, p.registered_at, p.version,
       p.anchor_tx AS p_anchor_tx, p.anchor_verified AS p_anchor_verified,
       v.version AS v_version, v.hash AS v_hash, v.anchor_tx, v.anchor_verified, v.anchor_slot,
       v.anchor_time, v.anchor_checked_at, v.rotation_sig,
       (SELECT hash FROM passport_versions WHERE wallet = p.wallet AND version = p.version - 1) AS rotated_from
FROM passports p
LEFT JOIN passport_versions v ON v.wallet = p.wallet AND v.version = p.version
WHERE p.wallet = ?1`;

const VERSION_COLUMNS = `wallet, version, hash, bundle, self_sig, wallet_sig, rotation_sig, anchor_tx, anchor_verified,
  anchor_slot, anchor_time, anchor_checked_at, mode, registered_at, superseded_at`;

/** First passport of a wallet. DO NOTHING on a concurrent first registration: the handler re-reads and reports it. */
const SQL_INSERT_FIRST_PASSPORT = `
INSERT INTO passports (wallet, hash, bundle, self_sig, wallet_sig, anchor_tx, mode, registered_at, version, anchor_verified, anchor_time)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10)
ON CONFLICT(wallet) DO NOTHING`;

/** Version 1, only when the passports row just written is ours (same hash and registration time). */
const SQL_INSERT_FIRST_VERSION = `
INSERT OR IGNORE INTO passport_versions (${VERSION_COLUMNS})
SELECT ?1, 1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL
WHERE EXISTS (SELECT 1 FROM passports WHERE wallet = ?1 AND hash = ?2 AND version = 1 AND registered_at = ?12)`;

/** Rotation step 1: the new version, while the active row is still the one the rotation_sig covers (?15 = old hash). */
const SQL_INSERT_ROTATED_VERSION = `
INSERT INTO passport_versions (${VERSION_COLUMNS})
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL
WHERE EXISTS (SELECT 1 FROM passports WHERE wallet = ?1 AND version = ?2 - 1 AND hash = ?15)`;

/** Rotation step 2: stamp the previous version as superseded. */
const SQL_SUPERSEDE_VERSION = `
UPDATE passport_versions SET superseded_at = ?3
WHERE wallet = ?1 AND version = ?2 - 1 AND superseded_at IS NULL
  AND EXISTS (SELECT 1 FROM passports WHERE wallet = ?1 AND version = ?2 - 1 AND hash = ?4)`;

/** Rotation step 3: point the active row at the new version (?12 = old hash). Zero changes = lost a race. */
const SQL_ROTATE_ACTIVE = `
UPDATE passports SET hash = ?3, bundle = ?4, self_sig = ?5, wallet_sig = ?6, mode = ?7, registered_at = ?8,
  version = ?2, anchor_tx = ?9, anchor_verified = ?10, anchor_time = ?11
WHERE wallet = ?1 AND version = ?2 - 1 AND hash = ?12`;

/** A new anchor claim or result for one version. A verified anchor is never overwritten. */
const SQL_SET_VERSION_ANCHOR = `
UPDATE passport_versions SET anchor_tx = ?3, anchor_verified = ?4, anchor_slot = ?5, anchor_time = ?6, anchor_checked_at = ?7
WHERE wallet = ?1 AND version = ?2 AND anchor_verified = 0`;

/** Copies a verified anchor onto the active row, when that version is still the active one. */
const SQL_SET_ACTIVE_ANCHOR = `
UPDATE passports SET anchor_tx = ?3, anchor_verified = 1, anchor_time = ?4
WHERE wallet = ?1 AND version = ?2
  AND EXISTS (SELECT 1 FROM passport_versions WHERE wallet = ?1 AND version = ?2 AND anchor_tx = ?3 AND anchor_verified = 1)`;

/** Claims the next on-chain re-check of an unverified anchor: one change means this request does it. */
const SQL_CLAIM_ANCHOR_CHECK = `
UPDATE passport_versions SET anchor_checked_at = ?3
WHERE wallet = ?1 AND version = ?2 AND anchor_verified = 0 AND anchor_tx IS NOT NULL
  AND (anchor_checked_at IS NULL OR anchor_checked_at <= ?3 - ?4)`;

/** Drops a claim the chain contradicts (the transaction exists but does not anchor this passport). */
const SQL_DROP_ANCHOR_CLAIM = `
UPDATE passport_versions SET anchor_tx = NULL, anchor_slot = NULL, anchor_time = NULL
WHERE wallet = ?1 AND version = ?2 AND anchor_verified = 0 AND anchor_tx = ?3`;

const SQL_HISTORY = `
SELECT version, hash, bundle, self_sig, wallet_sig, rotation_sig, anchor_tx, anchor_verified, anchor_slot,
       anchor_time, anchor_checked_at, mode, registered_at, superseded_at
FROM passport_versions WHERE wallet = ?1 ORDER BY version DESC LIMIT ?2`;

const SQL_HISTORY_COUNT = `SELECT COUNT(*) AS n FROM passport_versions WHERE wallet = ?1`;

/*
 * Repair of a passports row a pre-0013 Worker wrote after the migration ran
 * (deploy order): it has no matching version row, or carries an unverified
 * anchor_tx. The row becomes the next version (plain INSERT: a concurrent
 * repair hits the primary key and rolls the batch back), older open versions
 * are closed, and its anchor turns into an unverified claim.
 */
const SQL_HEAL_SUPERSEDE = `
UPDATE passport_versions SET superseded_at = ?3
WHERE wallet = ?1 AND superseded_at IS NULL AND version < ?2`;

const SQL_HEAL_INSERT = `
INSERT INTO passport_versions (${VERSION_COLUMNS})
SELECT wallet, ?2, hash, bundle, self_sig, wallet_sig, NULL, anchor_tx, 0, NULL, NULL, NULL, mode, registered_at, NULL
FROM passports WHERE wallet = ?1 AND hash = ?3`;

const SQL_HEAL_POINT = `
UPDATE passports SET version = ?2, anchor_tx = NULL, anchor_verified = 0, anchor_time = NULL
WHERE wallet = ?1 AND hash = ?3`;

const SQL_HEAL_MOVE_CLAIM = `
UPDATE passport_versions SET anchor_tx = COALESCE(anchor_tx, ?3)
WHERE wallet = ?1 AND version = ?2 AND anchor_verified = 0`;

/** The active row's anchor columns from its version row: the verified anchor, or nothing. */
const SQL_HEAL_SYNC_ACTIVE = `
UPDATE passports SET
  anchor_tx       = (SELECT CASE WHEN anchor_verified = 1 THEN anchor_tx END FROM passport_versions WHERE wallet = ?1 AND version = ?2),
  anchor_verified = COALESCE((SELECT anchor_verified FROM passport_versions WHERE wallet = ?1 AND version = ?2), 0),
  anchor_time     = (SELECT CASE WHEN anchor_verified = 1 THEN anchor_time END FROM passport_versions WHERE wallet = ?1 AND version = ?2)
WHERE wallet = ?1 AND version = ?2`;

const SQL_MAX_VERSION = `SELECT MAX(version) AS v FROM passport_versions WHERE wallet = ?1`;

/** A passport that already was a version of this wallet (a rotation back to it is refused). */
const SQL_VERSION_BY_HASH = `SELECT version FROM passport_versions WHERE wallet = ?1 AND hash = ?2 LIMIT 1`;

/** What the scanner needs to know about a passport: its hash, mode and whether it is anchored. */
const SQL_GET_PASSPORT_SUMMARY = `SELECT hash, mode, anchor_tx FROM passports WHERE wallet = ?`;

/** Same id means byte-identical canonical seal, so a repeat is a no-op. */
const SQL_INSERT_SEAL = `
INSERT OR IGNORE INTO seals (id, wallet, doc_hash, seal, registered_at)
VALUES (?, ?, ?, ?, ?)`;

const SQL_GET_SEAL = `SELECT seal, registered_at FROM seals WHERE id = ?`;

const SQL_STATS = `
SELECT (SELECT COUNT(*) FROM passports) AS passports,
       (SELECT COUNT(*) FROM seals)     AS seals`;

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

/** SQL_GET_ACTIVE: the passports row and, joined, its version row (v_* null when missing). */
interface ActiveRow {
  hash: string;
  bundle: string;
  self_sig: string;
  wallet_sig: string;
  mode: string;
  registered_at: number;
  version: number;
  p_anchor_tx: string | null;
  p_anchor_verified: number;
  v_version: number | null;
  v_hash: string | null;
  anchor_tx: string | null;
  anchor_verified: number | null;
  anchor_slot: number | null;
  anchor_time: number | null;
  anchor_checked_at: number | null;
  rotation_sig: string | null;
  rotated_from: string | null;
}

/** One passport_versions row (SQL_HISTORY). */
interface VersionRow {
  version: number;
  hash: string;
  bundle: string;
  self_sig: string;
  wallet_sig: string;
  rotation_sig: string | null;
  anchor_tx: string | null;
  anchor_verified: number;
  anchor_slot: number | null;
  anchor_time: number | null;
  anchor_checked_at: number | null;
  mode: string;
  registered_at: number;
  superseded_at: number | null;
}

interface PassportSummaryRow {
  hash: string;
  mode: string;
  anchor_tx: string | null;
}

interface SealRow {
  seal: string;
  registered_at: number;
}

interface StatsRow {
  passports: number;
  seals: number;
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

function json(data: unknown, status = 200, cacheControl = "no-store", extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      ...extraHeaders,
    },
  });
}

const badRequest = (error: string): Response => json({ error }, 400);
const notFound = (): Response => json({ error: "not found" }, 404);
const rateLimited = (): Response =>
  json({ error: "rate limited, try again in a minute" }, 429, "no-store", {
    "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
  });

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): Parsed<never> => ({ ok: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A finite number, or null for anything else (upstream JSON is never trusted blindly). */
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A non-empty string, or null. */
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** base58 string that decodes to exactly `length` bytes. */
function isBase58OfLength(value: unknown, length: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  try {
    return base58.decode(value).length === length;
  } catch {
    return false;
  }
}

/** base64 string that decodes to exactly `length` bytes. */
function isBase64OfLength(value: unknown, length: number): value is string {
  // base64 grows bytes by 4/3; anything far beyond that is not worth decoding.
  if (typeof value !== "string" || value.length === 0 || value.length > length * 2) return false;
  try {
    return b64.decode(value).length === length;
  } catch {
    return false;
  }
}

/** A Solana wallet address: base58 of a 32-byte Ed25519 public key. */
const isWallet = (value: unknown): value is string => isBase58OfLength(value, ED25519_PK_LEN);

/** A Solana transaction signature: base58 of 64 bytes. */
const isTxSignature = (value: unknown): value is string => isBase58OfLength(value, TX_SIG_LEN);

function unknownField(input: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

/**
 * Rebuilds a Passport from untrusted JSON with every field checked. Extra
 * fields are rejected rather than dropped: they would change the canonical
 * bytes the signatures and the hash are computed over.
 */
function parsePassport(input: unknown): Parsed<Passport> {
  if (!isRecord(input)) return fail("passport must be an object");
  const extra = unknownField(input, PASSPORT_FIELDS);
  if (extra !== null) return fail(`passport has an unknown field: ${extra}`);

  const { v, wallet, kem_pk, dsa_pk, mode, created_at } = input;
  if (v !== 1) return fail("passport.v must be 1");
  if (!isWallet(wallet)) return fail("passport.wallet is not a Solana address");
  if (!isBase64OfLength(kem_pk, KEM_PK_LEN)) {
    return fail(`passport.kem_pk is not a ${KEM_PK_LEN}-byte ML-KEM-768 public key`);
  }
  if (!isBase64OfLength(dsa_pk, DSA_PK_LEN)) {
    return fail(`passport.dsa_pk is not a ${DSA_PK_LEN}-byte ML-DSA-65 public key`);
  }
  if (mode !== "simple" && mode !== "hardened") {
    return fail("passport.mode must be \"simple\" or \"hardened\"");
  }
  if (!isPositiveInt(created_at) || created_at < MIN_CREATED_AT || created_at > Date.now() + MAX_FUTURE_MS) {
    return fail("passport.created_at must be a plausible unix ms timestamp");
  }
  return { ok: true, value: { v: 1, wallet, kem_pk, dsa_pk, mode, created_at } };
}

/**
 * Shape check for a seal before the cryptographic check in `verifySeal`.
 * Optional fields are only copied when present so `sealId` matches the id
 * the client computed over the same object.
 */
function parseSeal(input: unknown): Parsed<QSeal> {
  if (!isRecord(input)) return fail("seal must be an object");
  const extra = unknownField(input, SEAL_FIELDS);
  if (extra !== null) return fail(`seal has an unknown field: ${extra}`);

  const { v, hash_alg, doc_hash, passport, dsa_pk, sig_alg, signature, signed_at, name, anchor_tx } = input;
  if (v !== 1) return fail("seal.v must be 1");
  if (hash_alg !== "sha256") return fail("seal.hash_alg must be \"sha256\"");
  if (sig_alg !== "ML-DSA-65") return fail("seal.sig_alg must be \"ML-DSA-65\"");
  if (typeof doc_hash !== "string" || !HEX_64.test(doc_hash)) {
    return fail("seal.doc_hash must be a hex sha256 digest");
  }
  if (!isWallet(passport)) return fail("seal.passport is not a Solana address");
  if (!isBase64OfLength(dsa_pk, DSA_PK_LEN)) {
    return fail(`seal.dsa_pk is not a ${DSA_PK_LEN}-byte ML-DSA-65 public key`);
  }
  if (typeof signature !== "string" || signature.length === 0) return fail("seal.signature must be a string");
  if (!isPositiveInt(signed_at)) return fail("seal.signed_at must be a unix timestamp in seconds");
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_NAME_LEN)) {
    return fail(`seal.name must be a string of at most ${MAX_NAME_LEN} characters`);
  }
  if (anchor_tx !== undefined && !isTxSignature(anchor_tx)) {
    return fail("seal.anchor_tx is not a Solana transaction signature");
  }

  const seal: QSeal = {
    v: 1,
    hash_alg: "sha256",
    doc_hash,
    passport,
    dsa_pk,
    sig_alg: "ML-DSA-65",
    signature,
    signed_at,
  };
  if (name !== undefined) seal.name = name;
  if (anchor_tx !== undefined) seal.anchor_tx = anchor_tx;
  return { ok: true, value: seal };
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
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

/* --- passport registry ---------------------------------------------- */

const ROTATION_REQUIRED = "this wallet already has a passport; replacing it needs a signature from its current key";
const ROTATION_INVALID = "rotation_sig does not verify against the current passport key";

/** An unverified anchor is re-checked on chain at most this often per version, on read. */
const ANCHOR_RECHECK_MS = 60_000;
/** Time budget for one anchor lookup: a registration can wait longer than a page read. */
const ANCHOR_BUDGET_POST_MS = 15_000;
const ANCHOR_BUDGET_GET_MS = 8_000;
/**
 * Per-upstream timeout inside that budget. Every upstream is asked in turn (RPC_URL first) until
 * one has the transaction: some free endpoints prune history and answer null for a real one.
 */
const ANCHOR_RPC_TIMEOUT_MS = 6_000;
/** Versions the history route returns, newest first; `total` says how many exist. */
const MAX_HISTORY_VERSIONS = 50;
/** Unverified anchors re-checked per history read. */
const MAX_HISTORY_RECHECKS = 2;
/** SPL Memo v2 and v1: an anchor memo may come from either. */
const MEMO_PROGRAMS: ReadonlySet<string> = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

type AnchorCheck =
  | { status: "verified"; slot: number; /** block time, unix ms */ time: number }
  | { status: "pending"; reason: string }
  | { status: "invalid"; reason: string };

/** The active version of a wallet's passport, as SQL_GET_ACTIVE reads it. */
interface Active {
  passport: Passport;
  hash: string;
  self_sig: string;
  wallet_sig: string;
  registered_at: number;
  version: number;
  /** the claimed anchor (verified or not) of the active version */
  anchor_tx: string | null;
  anchor_verified: boolean;
  anchor_slot: number | null;
  anchor_time: number | null;
  rotated_from: string | null;
}

/** The memo text of a jsonParsed instruction: `parsed` for the memo programs, base58 `data` otherwise. */
function memoText(ix: Record<string, unknown>): string | null {
  if (typeof ix.parsed === "string") return ix.parsed;
  if (typeof ix.data !== "string") return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(base58.decode(ix.data));
  } catch {
    return null;
  }
}

/**
 * What a getTransaction (jsonParsed) result says about an anchor claim. Pure.
 * Invalid only on positive evidence (the transaction failed, the wallet did
 * not sign it, or no top-level SPL Memo carries ANCHOR_MEMO); anything
 * missing is pending, since a lagging or pruned node answers null for a real
 * transaction.
 */
function judgeAnchorTx(result: unknown, wallet: string, memo: string): AnchorCheck {
  if (result === null || result === undefined) return { status: "pending", reason: "transaction not visible on chain yet" };
  if (!isRecord(result) || !isRecord(result.meta) || !isRecord(result.transaction)) {
    return { status: "pending", reason: "unexpected getTransaction response" };
  }
  const message = isRecord(result.transaction.message) ? result.transaction.message : null;
  if (message === null || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) {
    return { status: "pending", reason: "unexpected getTransaction response" };
  }
  if (result.meta.err !== null && result.meta.err !== undefined) {
    return { status: "invalid", reason: "the anchor transaction failed on chain" };
  }
  const signed = message.accountKeys.some((k) => isRecord(k) && k.pubkey === wallet && k.signer === true);
  if (!signed) return { status: "invalid", reason: "the wallet did not sign the anchor transaction" };
  const carries = message.instructions.some(
    (ix) => isRecord(ix) && typeof ix.programId === "string" && MEMO_PROGRAMS.has(ix.programId) && memoText(ix) === memo,
  );
  if (!carries) return { status: "invalid", reason: "the transaction carries no memo with this passport's hash" };
  const slot = num(result.slot);
  const blockTime = num(result.blockTime);
  if (slot === null || blockTime === null) return { status: "pending", reason: "block time not available yet" };
  return { status: "verified", slot, time: blockTime * 1000 };
}

/**
 * Looks the anchor transaction up on chain through the scanner's upstreams
 * (RPC_URL first, then the free endpoints), asking the next upstream when one
 * fails or has not seen the transaction, within `budgetMs`. The pending
 * reason names every upstream's answer, so a skipped test or a stuck claim
 * says why.
 */
async function checkAnchor(env: Env, passport: Passport, tx: string, budgetMs: number): Promise<AnchorCheck> {
  const body = (version: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [tx, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: version }],
    });
  const memo = ANCHOR_MEMO(passport);
  const deadline = Date.now() + budgetMs;
  const answers: string[] = [];
  for (const upstream of rpcUpstreams(env)) {
    // Version 0 first (the contract); a node that names a newer transaction version is asked once more with it.
    let version = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const left = deadline - Date.now();
      if (left < 500) {
        answers.push("time budget spent");
        return { status: "pending", reason: clip(answers.join("; ")) };
      }
      const forwarded = await forwardRpc(body(version), [upstream], Math.min(ANCHOR_RPC_TIMEOUT_MS, left));
      if (!forwarded.ok) {
        answers.push(forwarded.error.replace(/^rpc upstream unavailable: /, ""));
        break;
      }
      let payload: unknown;
      try {
        payload = await forwarded.response.json();
      } catch {
        answers.push(`${upstreamHost(upstream)}: invalid JSON`);
        break;
      }
      if (isRecord(payload) && isRecord(payload.error)) {
        const message = typeof payload.error.message === "string" ? payload.error.message : "";
        const asked = /maxSupportedTransactionVersion"?:\s*(\d+)/.exec(message);
        if (attempt === 0 && asked && Number(asked[1]) > version && Number(asked[1]) <= 2) {
          version = Number(asked[1]);
          continue;
        }
        answers.push(`${upstreamHost(upstream)}: RPC error ${clip(message)}`);
        break;
      }
      if (!isRecord(payload) || !("result" in payload)) {
        answers.push(`${upstreamHost(upstream)}: no result`);
        break;
      }
      const verdict = judgeAnchorTx(payload.result, passport.wallet, memo);
      if (verdict.status !== "pending") return verdict;
      answers.push(`${upstreamHost(upstream)}: ${verdict.reason}`);
      break;
    }
  }
  return { status: "pending", reason: clip(answers.join("; ") || "no RPC upstream answered") };
}

/**
 * Stores the result of an anchor check for one version: a claim (pending) or
 * a verified anchor, which is also copied onto the active row when that
 * version is active. A refused claim is dropped. A verified anchor is never
 * overwritten (the guards in the SQL).
 */
async function recordAnchor(env: Env, wallet: string, version: number, tx: string, check: AnchorCheck): Promise<void> {
  const now = Date.now();
  if (check.status === "invalid") {
    await env.DB.prepare(SQL_DROP_ANCHOR_CLAIM).bind(wallet, version, tx).run();
    return;
  }
  const verified = check.status === "verified" ? check : null;
  const statements = [
    env.DB.prepare(SQL_SET_VERSION_ANCHOR).bind(
      wallet,
      version,
      tx,
      verified ? 1 : 0,
      verified?.slot ?? null,
      verified?.time ?? null,
      now,
    ),
  ];
  if (verified) statements.push(env.DB.prepare(SQL_SET_ACTIVE_ANCHOR).bind(wallet, version, tx, verified.time));
  await env.DB.batch(statements);
}

/**
 * The lazy re-check of an unverified anchor on read: at most once per
 * ANCHOR_RECHECK_MS per version (claimed in D1, so parallel reads do not all
 * call the RPC). True when a result was written. Never throws: a read must
 * not fail because the chain could not be asked.
 */
async function recheckAnchor(env: Env, wallet: string, version: number, passport: Passport, tx: string): Promise<boolean> {
  try {
    const claim = await env.DB.prepare(SQL_CLAIM_ANCHOR_CHECK).bind(wallet, version, Date.now(), ANCHOR_RECHECK_MS).run();
    if ((claim.meta.changes ?? 0) === 0) return false;
    const check = await checkAnchor(env, passport, tx, ANCHOR_BUDGET_GET_MS);
    if (check.status === "pending") return false;
    await recordAnchor(env, wallet, version, tx, check);
    return true;
  } catch (error) {
    console.warn("anchor re-check failed", wallet, error);
    return false;
  }
}

/**
 * A passports row a pre-0013 Worker wrote or changed: no matching version row,
 * or anchor columns that differ from the version row's verified anchor.
 */
function needsRepair(row: ActiveRow): boolean {
  if (row.v_version === null || row.v_hash !== row.hash) return true;
  const verified = row.anchor_verified === 1 ? row.anchor_tx : null;
  return row.p_anchor_tx !== verified || (row.p_anchor_verified === 1) !== (verified !== null);
}

/** Brings such a row in line with passport_versions (see SQL_HEAL_*). A concurrent repair wins the primary key. */
async function repairPassport(env: Env, wallet: string, row: ActiveRow): Promise<void> {
  try {
    if (row.v_version !== null && row.v_hash === row.hash) {
      // Only the anchor columns are off: a claim written there becomes an unverified claim on the version.
      const claim = row.p_anchor_tx !== null && row.p_anchor_tx !== row.anchor_tx ? row.p_anchor_tx : null;
      await env.DB.batch([
        env.DB.prepare(SQL_HEAL_MOVE_CLAIM).bind(wallet, row.version, claim),
        env.DB.prepare(SQL_HEAL_SYNC_ACTIVE).bind(wallet, row.version),
      ]);
      return;
    }
    const max = await env.DB.prepare(SQL_MAX_VERSION).bind(wallet).first<{ v: number | null }>();
    const next = (max?.v ?? 0) + 1;
    await env.DB.batch([
      env.DB.prepare(SQL_HEAL_SUPERSEDE).bind(wallet, next, Date.now()),
      env.DB.prepare(SQL_HEAL_INSERT).bind(wallet, next, row.hash),
      env.DB.prepare(SQL_HEAL_POINT).bind(wallet, next, row.hash),
    ]);
  } catch (error) {
    console.warn("passport repair skipped", wallet, error);
  }
}

/** The active version of the wallet's passport, or null. Repairs a row written by a pre-0013 Worker first. */
async function loadActive(env: Env, wallet: string): Promise<Active | null> {
  let row = await env.DB.prepare(SQL_GET_ACTIVE).bind(wallet).first<ActiveRow>();
  if (row && needsRepair(row)) {
    await repairPassport(env, wallet, row);
    row = await env.DB.prepare(SQL_GET_ACTIVE).bind(wallet).first<ActiveRow>();
  }
  if (!row) return null;
  return {
    passport: JSON.parse(row.bundle) as Passport,
    hash: row.hash,
    self_sig: row.self_sig,
    wallet_sig: row.wallet_sig,
    registered_at: row.registered_at,
    version: row.version,
    anchor_tx: row.v_version === null ? null : row.anchor_tx,
    anchor_verified: row.anchor_verified === 1 && row.anchor_tx !== null,
    anchor_slot: row.anchor_verified === 1 ? row.anchor_slot : null,
    anchor_time: row.anchor_verified === 1 ? row.anchor_time : null,
    rotated_from: row.rotated_from,
  };
}

/** GET /api/passports/:wallet body: the v1 fields plus version, anchor status and the previous version's hash. */
function activeRecord(active: Active): Record<string, unknown> {
  return {
    passport: active.passport,
    self_sig: active.self_sig,
    wallet_sig: active.wallet_sig,
    anchor_tx: active.anchor_tx,
    hash: active.hash,
    registered_at: active.registered_at,
    version: active.version,
    anchor_verified: active.anchor_verified,
    anchor_slot: active.anchor_slot,
    anchor_time: active.anchor_time,
    rotated_from: active.rotated_from,
  };
}

/**
 * POST /api/passports body on success. `anchor_note` says why a claim is still unverified. A
 * re-register whose anchor_tx the chain does not show yet overrides `anchor_status` with
 * "unseen" (nothing recorded; anchor_tx / anchor_verified still describe what is stored).
 */
function registerResult(active: Active, rotated: boolean, note: string | null): Record<string, unknown> {
  return {
    ok: true,
    hash: active.hash,
    registered_at: active.registered_at,
    version: active.version,
    rotated,
    anchor_tx: active.anchor_tx,
    anchor_verified: active.anchor_verified,
    anchor_status: active.anchor_tx === null ? "none" : active.anchor_verified ? "verified" : "pending",
    ...(note !== null && !active.anchor_verified && active.anchor_tx !== null ? { anchor_note: note } : {}),
  };
}

/**
 * POST /api/passports. The first passport of a wallet registers with a valid
 * self-signature and wallet signature. The same passport again is a no-op
 * that may attach an anchor. A different passport replaces the active one
 * only with `rotation_sig` by the active version's ML-DSA key (409
 * otherwise), and never with a passport that was a version before; the old
 * version stays in the history, superseded. An anchor_tx is looked up on
 * chain first: refused (400) when the chain contradicts it. When it is not
 * visible yet, a first registration or a rotation keeps it as an unverified
 * claim; a re-register, which anyone can send, records nothing ("unseen").
 */
async function registerPassport(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");

  const parsed = parsePassport(body.value.passport);
  if (!parsed.ok) return badRequest(parsed.error);
  const passport = parsed.value;
  const wallet = passport.wallet;

  const { self_sig, wallet_sig, anchor_tx, rotation_sig } = body.value;
  if (typeof self_sig !== "string" || self_sig.length === 0) return badRequest("self_sig must be a string");
  if (typeof wallet_sig !== "string" || wallet_sig.length === 0) return badRequest("wallet_sig must be a string");
  const anchor = anchor_tx === undefined || anchor_tx === null ? null : anchor_tx;
  if (anchor !== null && !isTxSignature(anchor)) {
    return badRequest("anchor_tx is not a Solana transaction signature");
  }
  const rotation = rotation_sig === undefined || rotation_sig === null ? null : rotation_sig;
  if (rotation !== null && !isBase64OfLength(rotation, DSA_SIG_LEN)) {
    return badRequest(`rotation_sig is not a base64 ${DSA_SIG_LEN}-byte ML-DSA-65 signature`);
  }

  if (!verifySelf(passport, self_sig)) return badRequest("self_sig does not verify against passport.dsa_pk");
  if (!verifyWalletSig(passport, wallet_sig)) return badRequest("wallet_sig does not verify against passport.wallet");

  const hash = passportHash(passport);
  const active = await loadActive(env, wallet);

  // The same passport again: nothing changes except, possibly, its anchor. Anyone can send this
  // request (a registered passport's signatures are public), so it records an anchor only on
  // positive evidence: a transaction the chain shows, signed by the wallet, carrying this memo.
  // One the chain does not show yet is not stored ("unseen"): a stranger could otherwise pin a
  // made-up claim on any passport, or overwrite the holder's. The holder sends it again.
  if (active !== null && active.hash === hash) {
    if (anchor === null || active.anchor_verified) return json(registerResult(active, false, null));
    const check = await checkAnchor(env, passport, anchor, ANCHOR_BUDGET_POST_MS);
    if (check.status === "invalid") {
      // Only a stored claim the chain contradicts is touched (dropped); the record stays as it was.
      if (active.anchor_tx === anchor) await recordAnchor(env, wallet, active.version, anchor, check);
      return badRequest(`anchor_tx refused: ${check.reason}`);
    }
    if (check.status === "pending") {
      if (active.anchor_tx === anchor) return json(registerResult(active, false, check.reason));
      return json({
        ...registerResult(active, false, null),
        anchor_status: "unseen",
        anchor_note: `not recorded: ${check.reason}; send it again once the transaction is visible`,
      });
    }
    await recordAnchor(env, wallet, active.version, anchor, check);
    return json(registerResult((await loadActive(env, wallet)) ?? active, false, null));
  }

  // A replacement: signed by the key it replaces, or refused.
  if (active !== null) {
    const refusal = { code: rotation === null ? "rotation_required" : "rotation_invalid", hash: active.hash, version: active.version };
    if (rotation === null) return json({ error: ROTATION_REQUIRED, ...refusal }, 409);
    // A passport that was a version before never comes back: a rotation_sig is then single-use,
    // since the pair (old hash, new hash) it covers cannot become the active pair again.
    const reused = await env.DB.prepare(SQL_VERSION_BY_HASH).bind(wallet, hash).first<{ version: number }>();
    if (reused) {
      return json(
        {
          error: `this passport was already registered as version ${reused.version}; a replacement must be a new passport`,
          code: "passport_reused",
          hash: active.hash,
          version: active.version,
        },
        409,
      );
    }
    if (!verifyRotation(active.passport, passport, rotation)) return json({ error: ROTATION_INVALID, ...refusal }, 409);
  }

  // The new passport's anchor, before anything is written: a refused anchor stops the request.
  let check: AnchorCheck | null = null;
  if (anchor !== null) {
    check = await checkAnchor(env, passport, anchor, ANCHOR_BUDGET_POST_MS);
    if (check.status === "invalid") return badRequest(`anchor_tx refused: ${check.reason}`);
  }
  const verified = check !== null && check.status === "verified" ? check : null;
  const note = check !== null && check.status === "pending" ? check.reason : null;
  const now = Date.now();
  const bundle = JSON.stringify(passport);
  const anchorFlag = verified ? 1 : 0;
  const anchorSlot = verified?.slot ?? null;
  const anchorTime = verified?.time ?? null;
  const checkedAt = anchor === null ? null : now;

  if (active === null) {
    const [inserted] = await env.DB.batch([
      env.DB.prepare(SQL_INSERT_FIRST_PASSPORT).bind(
        wallet,
        hash,
        bundle,
        self_sig,
        wallet_sig,
        verified ? anchor : null,
        passport.mode,
        now,
        anchorFlag,
        anchorTime,
      ),
      env.DB.prepare(SQL_INSERT_FIRST_VERSION).bind(
        wallet,
        hash,
        bundle,
        self_sig,
        wallet_sig,
        anchor,
        anchorFlag,
        anchorSlot,
        anchorTime,
        checkedAt,
        passport.mode,
        now,
      ),
    ]);
    if ((inserted.meta.changes ?? 0) === 0) {
      // Another first registration landed in between: the same passport is fine, a different one is a replacement.
      const raced = await loadActive(env, wallet);
      if (raced !== null && raced.hash === hash) return json(registerResult(raced, false, note));
      return json({ error: ROTATION_REQUIRED, code: "rotation_required", hash: raced?.hash ?? null, version: raced?.version ?? null }, 409);
    }
  } else {
    const next = active.version + 1;
    const results = await env.DB.batch([
      env.DB.prepare(SQL_INSERT_ROTATED_VERSION).bind(
        wallet,
        next,
        hash,
        bundle,
        self_sig,
        wallet_sig,
        rotation,
        anchor,
        anchorFlag,
        anchorSlot,
        anchorTime,
        checkedAt,
        passport.mode,
        now,
        active.hash,
      ),
      env.DB.prepare(SQL_SUPERSEDE_VERSION).bind(wallet, next, now, active.hash),
      env.DB.prepare(SQL_ROTATE_ACTIVE).bind(
        wallet,
        next,
        hash,
        bundle,
        self_sig,
        wallet_sig,
        passport.mode,
        now,
        verified ? anchor : null,
        anchorFlag,
        anchorTime,
        active.hash,
      ),
    ]);
    if ((results[2]?.meta.changes ?? 0) === 0) {
      // The rotation_sig covers the version read above; another rotation replaced it first.
      return json({ error: "the passport was replaced while this request ran; sign the rotation again", code: "conflict" }, 409);
    }
  }

  const stored = await loadActive(env, wallet);
  if (!stored) throw new Error("passport write returned no row");
  return json(registerResult(stored, active !== null, note));
}

/** GET /api/passports/:wallet: the active version; an unverified anchor is re-checked on chain first (bounded). */
async function getPassport(env: Env, wallet: string): Promise<Response> {
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  let active = await loadActive(env, wallet);
  if (!active) return notFound();
  if (active.anchor_tx !== null && !active.anchor_verified) {
    if (await recheckAnchor(env, wallet, active.version, active.passport, active.anchor_tx)) {
      active = (await loadActive(env, wallet)) ?? active;
    }
  }
  return json(activeRecord(active));
}

/** One history entry: the version's full record, so a reader can re-check every signature itself. */
function versionRecord(row: VersionRow): Record<string, unknown> {
  const verified = row.anchor_verified === 1 && row.anchor_tx !== null;
  return {
    version: row.version,
    hash: row.hash,
    mode: row.mode,
    passport: JSON.parse(row.bundle) as Passport,
    self_sig: row.self_sig,
    wallet_sig: row.wallet_sig,
    rotation_sig: row.rotation_sig,
    rotation_signed: row.rotation_sig !== null,
    registered_at: row.registered_at,
    superseded_at: row.superseded_at,
    anchor_tx: row.anchor_tx,
    anchor_verified: verified,
    anchor_slot: verified ? row.anchor_slot : null,
    anchor_time: verified ? row.anchor_time : null,
  };
}

/**
 * GET /api/passports/:wallet/history: every version, newest first (at most
 * MAX_HISTORY_VERSIONS). 200 with an empty list when the wallet has no
 * passport, so a 404 always means the route itself is missing.
 */
async function getPassportHistory(env: Env, wallet: string): Promise<Response> {
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");
  // Repairs a row a pre-0013 Worker wrote, so the history includes it.
  await loadActive(env, wallet);
  const read = async () =>
    (await env.DB.prepare(SQL_HISTORY).bind(wallet, MAX_HISTORY_VERSIONS).all<VersionRow>()).results ?? [];
  let rows = await read();
  const unverified = rows.filter((r) => r.anchor_tx !== null && r.anchor_verified !== 1).slice(0, MAX_HISTORY_RECHECKS);
  if (unverified.length > 0) {
    const results = await Promise.all(
      unverified.map((r) => recheckAnchor(env, wallet, r.version, JSON.parse(r.bundle) as Passport, r.anchor_tx as string)),
    );
    if (results.some(Boolean)) rows = await read();
  }
  const total =
    rows.length < MAX_HISTORY_VERSIONS
      ? rows.length
      : ((await env.DB.prepare(SQL_HISTORY_COUNT).bind(wallet).first<{ n: number }>())?.n ?? rows.length);
  return json({ wallet, total, truncated: total > rows.length, versions: rows.map(versionRecord) });
}

async function registerSeal(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  if (!isRecord(body.value)) return badRequest("body must be a JSON object");

  const parsed = parseSeal(body.value.seal);
  if (!parsed.ok) return badRequest(parsed.error);
  const seal = parsed.value;

  const verdict = verifySeal(seal);
  if (!verdict.ok) return badRequest(verdict.reason ?? "seal does not verify");
  // A seal cannot have been signed after it reached the registry (pq.sealIdentity reads the
  // registry time as that bound); the signer's clock gets the same skew as there.
  if (seal.signed_at * 1000 > Date.now() + SEAL_CLOCK_SKEW_MS) return badRequest("seal.signed_at is in the future");

  const id = sealId(seal);
  await env.DB.prepare(SQL_INSERT_SEAL)
    .bind(id, seal.passport, seal.doc_hash, JSON.stringify(seal), Date.now())
    .run();

  return json({ ok: true, id });
}

async function getSeal(env: Env, id: string): Promise<Response> {
  if (!HEX_64.test(id)) return badRequest("seal id must be a hex sha256 digest");
  const row = await env.DB.prepare(SQL_GET_SEAL).bind(id).first<SealRow>();
  if (!row) return notFound();
  const seal: QSeal = JSON.parse(row.seal);
  return json({ seal, registered_at: row.registered_at });
}

async function getStats(env: Env): Promise<Response> {
  const row = await env.DB.prepare(SQL_STATS).first<StatsRow>();
  return json({ passports: row?.passports ?? 0, seals: row?.seals ?? 0 });
}

/* ------------------------------------------------------------------ */
/* Scanner: GET /api/scan/:wallet                                      */
/* ------------------------------------------------------------------ */

// One question: how much depends on this one Ed25519 key. Every upstream call
// has its own entry in `sources`; what could not be read is `null` in the
// report, never zero. Only a report with every source ok is cached. DAS and
// getProgramAccounts need the private RPC and are skipped without one
// (`limited: true`). There is no overall score: the three headline
// indicators are `exposure`, `identity` and `confidence`. v3 adds Squads v4
// multisig detection (worker/squads.ts): the address as a multisig, and the
// multisigs it is a member of, with their vault-0 holdings reported apart
// from the key's own exposure.

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

/**
 * Addresses nobody holds a key for, classified "system" before anything else
 * is looked at. The System Program (all zero bytes) decodes as a valid Ed25519
 * point, so the on-curve check alone would call it a wallet; the token
 * programs and loaders are executable and would otherwise read as "program".
 * Not exported: workerd rejects non-function exports from the entry module
 * ("Incorrect type for map entry"), which stopped `wrangler dev` from starting.
 */
const KNOWN_SYSTEM_ADDRESSES: ReadonlySet<string> = new Set([
  SYSTEM_PROGRAM,
  STAKE_PROGRAM,
  BPF_UPGRADEABLE_LOADER,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "NativeLoader1111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "StakeConfig11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarEpochSchedu1e111111111111111111111111",
  "SysvarEpochRewards1111111111111111111111111",
  "SysvarFees111111111111111111111111111111111",
  "SysvarRecentB1ockHashes11111111111111111111",
  "SysvarS1otHashes111111111111111111111111111",
  "SysvarS1otHistory11111111111111111111111111",
  "SysvarStakeHistory1111111111111111111111111",
  "SysvarLastRestartS1ot1111111111111111111111",
]);
/** Any other sysvar: the "Sysvar" prefix padded with zero bytes (a run of 1s) at the end. */
const SYSVAR_PATTERN = /^Sysvar[1-9A-HJ-NP-Za-km-z]*1{8}$/;

/** SPL mint layout: COption<Pubkey> mint_authority (key at 4), supply, decimals, is_initialized, COption<Pubkey> freeze_authority (key at 50). */
/** Stake account: u32 state, Meta { rent_exempt_reserve: u64, Authorized { staker at 12, withdrawer at 44 } }. */
const STAKE_WITHDRAWER_OFFSET = 44;
/** ProgramData: u32 discriminant (3), u64 slot, Option<Pubkey> upgrade authority (tag at 12, key at 13). */
const PROGRAM_DATA_AUTHORITY_OFFSET = 13;
/**
 * memcmp bytes for the ProgramData discriminant at offset 0: the little-endian
 * u32 `3`, base58-encoded. Computed rather than written by hand because a
 * typo here silently returns no programs. Not exported (see KNOWN_SYSTEM_ADDRESSES).
 */
const PROGRAM_DATA_DISCRIMINANT = base58.encode(new Uint8Array([3, 0, 0, 0]));

const LAMPORTS_PER_SOL = 1_000_000_000;
const DAY_SECONDS = 86_400;
const SIGNATURE_PAGE = 1000;
const DAS_PAGE_LIMIT = 1000;
/** DAS pages read per scan; a full last page marks the counts as lower bounds. */
const DAS_MAX_PAGES = 3;
const MAX_REPORT_TOKENS = 25;
const MAX_AUTHORITY_MINTS = 20;
const MAX_PROGRAMS = 50;
const MAX_ERROR_LEN = 160;
const SCAN_CACHE_SECONDS = 60;
const PRICE_CACHE_SECONDS = 300;
const PRICE_TIMEOUT_MS = 8_000;
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
/** Recommendation thresholds: dormant after this many days with at least DORMANT_MIN_SOL held; "large" from this USD value. */
const DORMANT_DAYS = 180;
const DORMANT_MIN_SOL = 1;
const LARGE_BALANCE_USD = 10_000;
const MAX_RECOMMENDATIONS = 5;
/**
 * Squads v4 (worker/squads.ts). The member search is 20 filtered
 * getProgramAccountsV2 calls on the private RPC, rate-gated across the
 * isolate. The one free node verified (2026-10) to serve filtered scans of
 * this program, api.mainnet.solana.com, answers 403 from workerd and the
 * other free endpoints refuse indexed calls, so there is no fallback: without
 * a private RPC the source is skipped. Memberships are capped, and vault 0
 * is valued for the first MAX_VALUED_VAULTS of them (two reads each).
 */
const MAX_MEMBER_MULTISIGS = 20;
const MAX_VALUED_VAULTS = 10;
const MAX_REPORT_MEMBERS = 16;
const VAULT_CONCURRENCY = 2;
/** DAS pages read for a vault: one, the vault value is a side figure */
const VAULT_DAS_PAGES = 1;
/**
 * A membership search is 20 to 60 indexed calls, and memberships change
 * rarely, so a successful search is kept in the edge cache regardless of
 * whether the report around it was complete: served as is for
 * MEMBERSHIP_CACHE_SECONDS, and after that only when a fresh search fails
 * (the index rate-limiting a burst of scans), for up to
 * MEMBERSHIP_STALE_SECONDS, dated in the report's note.
 */
const MEMBERSHIP_CACHE_SECONDS = 900;
const MEMBERSHIP_STALE_SECONDS = 3600;

interface Holdings {
  tokens: ScanToken[];
  tokenCount: number;
  /** tokens with a price, across every page read */
  pricedCount: number;
  tokensUsd: number;
  nfts: number;
  /** SOL/USD as DAS reports it alongside the native balance; a fallback when CoinGecko fails */
  rpcSolUsd: number | null;
  /** every fungible mint the wallet holds (largest positions first), for the authority check */
  mints: string[];
  /** the page cap was hit (or a later page failed): counts are lower bounds */
  truncated: boolean;
  /** why the counts are lower bounds, when `truncated` */
  truncation: string | null;
}

interface Activity {
  txCount: number;
  lastActivity: number | null;
  oldestSeen: number | null;
}

interface Stake {
  stakeSol: number;
  stakeAccounts: number;
}

interface MintAuthorities {
  mints: ScanAuthorityMint[];
  /** unique mints found before the cap */
  total: number;
}

interface ProgramAuthorities {
  programs: string[];
  total: number;
}

/** getMultipleAccounts accepts at most 100 pubkeys per call */
const MAX_AUTHORITY_CHECK = 100;
const NO_MINTS: MintAuthorities = { mints: [], total: 0 };

type Sources = Record<SourceName, SourceState>;

const clip = (text: string): string => (text.length > MAX_ERROR_LEN ? `${text.slice(0, MAX_ERROR_LEN)}…` : text);
const shorten = (address: string): string => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** The source state for a rejected call: a skip is listed as such, anything else failed. */
function failure(error: unknown): SourceState {
  if (error instanceof SkippedError) return { status: "skipped", error: clip(error.message) };
  return { status: "failed", error: clip(describeError(error)) };
}

/** Unwraps one `Promise.allSettled` entry into `sources[name]`; a rejection yields undefined. */
function settle<T>(sources: Sources, name: SourceName, result: PromiseSettledResult<T>): T | undefined {
  if (result.status === "fulfilled") {
    sources[name] = { status: "ok" };
    return result.value;
  }
  sources[name] = failure(result.reason);
  return undefined;
}

/* --- address classification (pure) ---------------------------------- */

/**
 * True when the 32 bytes decode to a point on Ed25519, so a private key can
 * exist for the address. Program-derived addresses are off-curve by
 * construction. ZIP-215 decoding matches what the Solana runtime accepts.
 */
export function isOnCurve(address: string): boolean {
  try {
    ed25519.Point.fromBytes(base58.decode(address), true);
    return true;
  } catch {
    return false;
  }
}

/** `data.parsed.type` of a jsonParsed account ("mint", "account", ...), or null. */
function parsedAccountType(account: Record<string, unknown>): string | null {
  if (!isRecord(account.data) || !isRecord(account.data.parsed)) return null;
  return str(account.data.parsed.type);
}

/**
 * What the address is, from the `getAccountInfo` (jsonParsed) value and the
 * on-curve check. `info` is the account record, `null` when the account does
 * not exist, or `undefined` when the call failed. Known system addresses win
 * over everything else. Pure; exported for the smoke test.
 */
export function classifyAddress(address: string, info: unknown): ScanAddress {
  const onCurve = isOnCurve(address);
  const account = isRecord(info) ? info : null;
  const executable = account?.executable === true;
  const owner = account === null ? null : str(account.owner);
  const base = { executable, owner, onCurve };
  const classified = (kind: AddressKind, exists: boolean, note: string): ScanAddress => ({ ...base, kind, exists, note });

  if (KNOWN_SYSTEM_ADDRESSES.has(address) || SYSVAR_PATTERN.test(address)) {
    return classified("system", true, "A system program or sysvar: nobody holds a private key for it.");
  }
  if (info === undefined) {
    return classified(
      "unknown",
      false,
      onCurve
        ? "The account could not be read, so its type is unknown; a key can exist for this address."
        : "The account could not be read; the address is off-curve, so no private key exists for it.",
    );
  }
  if (account === null) {
    return onCurve
      ? classified("wallet", false, "An address that has never been funded: a key can exist for it, but nothing is on chain yet.")
      : classified("pda", false, "An off-curve address with no account: no private key can exist for it.");
  }
  if (executable) {
    return classified("program", true, "A program: nobody holds a private key for it; its upgrade authority, if any, is what matters.");
  }
  const parsedType = parsedAccountType(account);
  if (owner !== null && TOKEN_PROGRAMS.has(owner)) {
    if (parsedType === "mint") {
      return classified("mint", true, "A token mint: no private key exists for it; its mint and freeze authorities control it.");
    }
    if (parsedType === "account") {
      return classified("token-account", true, "A token account: its owner wallet moves it, not a key of its own.");
    }
  }
  if (owner === STAKE_PROGRAM) {
    return classified("stake-account", true, "A stake account: its staker and withdrawer authorities control it, not a key of its own.");
  }
  if (owner === SQUADS_V4_PROGRAM) {
    const multisig = multisigFromAccount(account);
    if (multisig !== null) {
      return classified(
        "multisig",
        true,
        `A Squads v4 multisig: no private key exists for it; its vaults move when ${multisig.threshold} of ${multisig.members.length} member keys sign.`,
      );
    }
  }
  if (!onCurve) {
    return classified("pda", true, "A program-derived address: no private key exists for it; the owning program controls it.");
  }
  if (owner === SYSTEM_PROGRAM || owner === null) {
    return classified("wallet", true, "A wallet: whoever signs with its Ed25519 key moves what it holds.");
  }
  return classified(
    "unknown",
    true,
    `An account owned by ${shorten(owner)}: a key can exist for the address, but the owning program controls what it holds.`,
  );
}

/* --- upstream calls, each returning a checked shape ----------------- */

/** The `getAccountInfo` value: the account record, or null when the account does not exist. */
async function fetchAccountInfo(env: Env, wallet: string): Promise<Record<string, unknown> | null> {
  const result = await rpcCall<unknown>(env, "getAccountInfo", [wallet, { encoding: "jsonParsed" }]);
  if (!isRecord(result) || !("value" in result)) throw new Error("unexpected getAccountInfo response");
  if (result.value === null) return null;
  if (!isRecord(result.value)) throw new Error("unexpected getAccountInfo response");
  return result.value;
}

async function fetchBalance(env: Env, wallet: string): Promise<number> {
  const result = await rpcCall<unknown>(env, "getBalance", [wallet]);
  const lamports = isRecord(result) ? num(result.value) : null;
  if (lamports === null) throw new Error("unexpected getBalance response");
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * DAS `getAssetsByOwner`, up to `maxPages` pages of DAS_PAGE_LIMIT. The
 * first page must succeed; a later page that fails (or a full last page)
 * leaves the counts as lower bounds rather than failing the whole read.
 */
async function fetchHoldings(env: Env, wallet: string, maxPages = DAS_MAX_PAGES): Promise<Holdings> {
  const items: Record<string, unknown>[] = [];
  let native: Record<string, unknown> = {};
  let truncation: string | null = null;

  for (let page = 1; page <= maxPages; page += 1) {
    let result: unknown;
    try {
      result = await privateRpc<unknown>(env, "getAssetsByOwner", {
        ownerAddress: wallet,
        page,
        limit: DAS_PAGE_LIMIT,
        displayOptions: { showFungible: true, showNativeBalance: true, showZeroBalance: false },
      });
      if (!isRecord(result) || !Array.isArray(result.items)) throw new Error("unexpected getAssetsByOwner response");
    } catch (error) {
      if (page === 1) throw error;
      truncation = `asset page ${page} could not be read (${clip(describeError(error))}), counts are lower bounds`;
      break;
    }
    if (page === 1 && isRecord(result.nativeBalance)) native = result.nativeBalance;
    for (const item of result.items) {
      if (isRecord(item)) items.push(item);
    }
    if (result.items.length < DAS_PAGE_LIMIT) break;
    if (page === maxPages) {
      truncation = `more than ${maxPages * DAS_PAGE_LIMIT} assets, counts are lower bounds`;
    }
  }

  const tokens: ScanToken[] = [];
  let nfts = 0;
  let tokensUsd = 0;
  let pricedCount = 0;
  for (const item of items) {
    if (typeof item.id !== "string") continue;
    if (item.interface !== "FungibleToken" && item.interface !== "FungibleAsset") {
      nfts += 1;
      continue;
    }
    const info: Record<string, unknown> = isRecord(item.token_info) ? item.token_info : {};
    const content: Record<string, unknown> = isRecord(item.content) ? item.content : {};
    const meta: Record<string, unknown> = isRecord(content.metadata) ? content.metadata : {};
    const priceInfo: Record<string, unknown> = isRecord(info.price_info) ? info.price_info : {};
    const decimals = num(info.decimals) ?? 0;
    const usd = num(priceInfo.total_price);
    tokens.push({
      mint: item.id,
      symbol: str(info.symbol) ?? str(meta.symbol) ?? "?",
      name: str(meta.name) ?? "",
      amount: (num(info.balance) ?? 0) / 10 ** decimals,
      decimals,
      usd,
    });
    if (usd !== null) {
      tokensUsd += usd;
      pricedCount += 1;
    }
  }
  // Priced positions first, largest value on top; unpriced ones by amount.
  tokens.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.amount - a.amount);

  return {
    tokens: tokens.slice(0, MAX_REPORT_TOKENS),
    tokenCount: tokens.length,
    pricedCount,
    tokensUsd,
    nfts,
    rpcSolUsd: num(native.price_per_sol),
    mints: tokens.slice(0, MAX_AUTHORITY_CHECK).map((t) => t.mint),
    truncated: truncation !== null,
    truncation,
  };
}

async function fetchActivity(env: Env, wallet: string): Promise<Activity> {
  const result = await rpcCall<unknown>(env, "getSignaturesForAddress", [wallet, { limit: SIGNATURE_PAGE }]);
  if (!Array.isArray(result)) throw new Error("unexpected getSignaturesForAddress response");
  const times: number[] = [];
  for (const entry of result) {
    const time = isRecord(entry) ? num(entry.blockTime) : null;
    if (time !== null) times.push(time);
  }
  return {
    txCount: result.length,
    lastActivity: times.length > 0 ? Math.max(...times) : null,
    oldestSeen: times.length > 0 ? Math.min(...times) : null,
  };
}

/**
 * Program accounts without account data (only pubkeys and lamports are ever needed).
 * Helius refuses plain getProgramAccounts on the token programs ("too many
 * accounts") and asks for getProgramAccountsV2 with a page limit, so that is
 * tried first; nodes without it answer "method not found" and get the classic call.
 */
async function programAccounts(
  env: Env,
  program: string,
  filters: unknown[],
  limit = 1000,
): Promise<Record<string, unknown>[]> {
  const config = { encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters };
  try {
    const v2 = await privateRpc<unknown>(env, "getProgramAccountsV2", [program, { ...config, limit }]);
    if (isRecord(v2) && Array.isArray(v2.accounts)) return v2.accounts.filter(isRecord);
    if (Array.isArray(v2)) return v2.filter(isRecord);
    throw new Error("unexpected getProgramAccountsV2 response");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/method not found|-32601|unsupported|unknown method/i.test(message)) throw error;
  }
  const result = await privateRpc<unknown>(env, "getProgramAccounts", [program, config]);
  if (!Array.isArray(result)) throw new Error("unexpected getProgramAccounts response");
  return result.filter(isRecord);
}

function pubkeys(accounts: Record<string, unknown>[], cap: number): string[] {
  const keys: string[] = [];
  for (const account of accounts) {
    if (keys.length >= cap) break;
    if (typeof account.pubkey === "string") keys.push(account.pubkey);
  }
  return keys;
}

async function fetchStake(env: Env, wallet: string): Promise<Stake> {
  const accounts = await programAccounts(env, STAKE_PROGRAM, [
    { memcmp: { offset: STAKE_WITHDRAWER_OFFSET, bytes: wallet } },
  ]);
  let lamports = 0;
  for (const entry of accounts) {
    lamports += (isRecord(entry.account) ? num(entry.account.lamports) : null) ?? 0;
  }
  return { stakeSol: lamports / LAMPORTS_PER_SOL, stakeAccounts: accounts.length };
}

/**
 * Mints whose mint or freeze authority is the wallet, on both token programs.
 * A program-wide search for "mints with this authority" is not possible on
 * the token programs (tens of millions of accounts), so the check covers the
 * mints the wallet holds: creators keep their own token. One batched read.
 */
async function fetchMintAuthorities(env: Env, wallet: string, heldMints: string[]): Promise<MintAuthorities> {
  if (!env.RPC_URL) throw new SkippedError("no private RPC configured");
  if (heldMints.length === 0) return NO_MINTS;
  const result = await rpcCall<unknown>(env, "getMultipleAccounts", [
    heldMints.slice(0, MAX_AUTHORITY_CHECK),
    { encoding: "jsonParsed" },
  ]);
  const values = isRecord(result) && Array.isArray(result.value) ? result.value : null;
  if (values === null) throw new Error("unexpected getMultipleAccounts response");

  const mints: ScanAuthorityMint[] = [];
  values.forEach((account, i) => {
    if (!isRecord(account) || !isRecord(account.data)) return;
    const parsed = isRecord(account.data.parsed) ? account.data.parsed : null;
    if (parsed === null || parsed.type !== "mint" || !isRecord(parsed.info)) return;
    const info = parsed.info;
    const isMint = info.mintAuthority === wallet;
    const isFreeze = info.freezeAuthority === wallet;
    if (!isMint && !isFreeze) return;
    const decimals = num(info.decimals) ?? 0;
    const rawSupply = typeof info.supply === "string" ? Number(info.supply) : num(info.supply);
    mints.push({
      mint: heldMints[i],
      supply: rawSupply === null || !Number.isFinite(rawSupply) ? null : rawSupply / 10 ** decimals,
      role: isMint && isFreeze ? "both" : isMint ? "mint" : "freeze",
    });
  });
  return { mints: mints.slice(0, MAX_AUTHORITY_MINTS), total: mints.length };
}

async function fetchProgramAuthorities(env: Env, wallet: string): Promise<ProgramAuthorities> {
  const accounts = await programAccounts(env, BPF_UPGRADEABLE_LOADER, [
    { memcmp: { offset: 0, bytes: PROGRAM_DATA_DISCRIMINANT } },
    { memcmp: { offset: PROGRAM_DATA_AUTHORITY_OFFSET, bytes: wallet } },
  ]);
  return { programs: pubkeys(accounts, MAX_PROGRAMS), total: accounts.length };
}

async function fetchPassportSummary(env: Env, wallet: string): Promise<ScanPassport | null> {
  const row = await env.DB.prepare(SQL_GET_PASSPORT_SUMMARY).bind(wallet).first<PassportSummaryRow>();
  if (!row) return null;
  return {
    hash: row.hash,
    mode: row.mode === "hardened" ? "hardened" : "simple",
    anchored: row.anchor_tx !== null,
    anchorTx: row.anchor_tx,
  };
}

/* --- Squads v4 ------------------------------------------------------- */

/** The callers worker/squads.ts needs: v2 scans on the private RPC, no public fallback (403 from workerd), bodies through the rotation. */
function squadsRpc(env: Env): SquadsRpc {
  return {
    indexed: env.RPC_URL ? (method, params) => privateRpc<unknown>(env, method, params) : null,
    public: null,
    any: (method, params) => rpcCall<unknown>(env, method, params),
  };
}

/** Addresses nobody signs for cannot be members; the search is skipped rather than spent on them. */
const isSystemAddress = (address: string): boolean => KNOWN_SYSTEM_ADDRESSES.has(address) || SYSVAR_PATTERN.test(address);

interface Memberships {
  multisigs: MultisigAccount[];
  /** the cap was hit: the list is a lower bound */
  truncated: boolean;
  /** a slot search ran out of pages: memberships may be missing */
  pagesExhausted: boolean;
  /** unix ms of the search that produced the list */
  searchedAt: number;
}

function isMemberships(value: unknown): value is Memberships {
  return (
    isRecord(value) &&
    Array.isArray(value.multisigs) &&
    typeof value.truncated === "boolean" &&
    typeof value.pagesExhausted === "boolean" &&
    typeof value.searchedAt === "number"
  );
}

/** The age of a membership list at `now`: older than the fresh window means it stood in for a search that failed. */
const membershipsStale = (memberships: Memberships, now: number): boolean =>
  now - memberships.searchedAt > MEMBERSHIP_CACHE_SECONDS * 1000;

/**
 * Multisigs listing the address as a member (first MEMBER_SLOTS slots, cap
 * MAX_MEMBER_MULTISIGS), from the edge cache under `cacheKey` when a search
 * ran in the last MEMBERSHIP_CACHE_SECONDS. When the search fails (the index
 * rate-limiting a burst of scans, say) and the cache still holds an older
 * list, from the last MEMBERSHIP_STALE_SECONDS, that list stands in instead
 * of a failed source. Cache failures are logged and ignored, like the price
 * cache.
 */
async function fetchMemberships(env: Env, wallet: string, cacheKey: string): Promise<Memberships> {
  if (isSystemAddress(wallet)) throw new SkippedError("a system address cannot be a multisig member");
  if (!env.RPC_URL) throw new SkippedError("no private RPC configured");
  const cache = caches.default;
  let stale: Memberships | null = null;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const cached: unknown = await hit.json();
      if (isMemberships(cached)) {
        if (!membershipsStale(cached, Date.now())) return cached;
        stale = cached;
      }
    }
  } catch (error) {
    console.warn("membership cache read failed", error);
  }
  let found: MemberSearch;
  try {
    found = await findMultisigsForMember(squadsRpc(env), wallet, MAX_MEMBER_MULTISIGS);
  } catch (error) {
    if (stale === null) throw error;
    console.warn(`membership search failed, serving the search of ${new Date(stale.searchedAt).toISOString()}`, error);
    return stale;
  }
  const memberships: Memberships = {
    multisigs: found.multisigs,
    truncated: found.truncated,
    pagesExhausted: found.pagesExhausted,
    searchedAt: Date.now(),
  };
  // Only a full scan is worth remembering; a search cut short gets a fresh attempt next time.
  if (found.pagesExhausted) return memberships;
  try {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(memberships), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${MEMBERSHIP_STALE_SECONDS}` },
      }),
    );
  } catch (error) {
    console.warn("membership cache write failed", error);
  }
  return memberships;
}

/**
 * What a vault holds: SOL plus the first DAS page of priced tokens. Each
 * number is null when its read failed; `usd` needs the balance and a price,
 * tokens are added when read. `note` names what is missing from `usd`.
 */
async function valueVault(env: Env, address: string, index: number, solPrice: number | null): Promise<ScanVault> {
  const [balance, holdings] = await Promise.allSettled([
    fetchBalance(env, address),
    fetchHoldings(env, address, VAULT_DAS_PAGES),
  ]);
  const sol = balance.status === "fulfilled" ? balance.value : null;
  const held = holdings.status === "fulfilled" ? holdings.value : null;
  const notes: string[] = [];
  if (sol === null) notes.push("SOL not read");
  else if (solPrice === null) notes.push("no SOL price");
  if (held === null) {
    notes.push(holdings.status === "rejected" && holdings.reason instanceof SkippedError ? "tokens not checked" : "tokens not read");
  } else if (held.truncated) {
    notes.push("tokens are a lower bound");
  }
  return {
    address,
    index,
    sol,
    tokensUsd: held === null ? null : held.tokensUsd,
    tokenCount: held === null ? null : held.tokenCount,
    usd: sol === null || solPrice === null ? null : sol * solPrice + (held === null ? 0 : held.tokensUsd),
    note: notes.join(", "),
  };
}

/** The report shape of a multisig: members cut at MAX_REPORT_MEMBERS, a self-governing config authority shown as null. */
function reportMultisig(address: string, parsed: ParsedMultisig, vault: ScanVault | null): ScanMultisigAccount {
  return {
    address,
    createKey: parsed.createKey,
    configAuthority: parsed.selfGoverned ? null : parsed.configAuthority,
    threshold: parsed.threshold,
    timeLock: parsed.timeLock,
    memberCount: parsed.members.length,
    members: parsed.members.slice(0, MAX_REPORT_MEMBERS).map(({ key, mask, initiate, vote, execute }) => ({
      key,
      mask,
      initiate,
      vote,
      execute,
    })),
    transactionIndex: parsed.transactionIndex,
    vault,
  };
}

/** A vault whose SOL or token read did not complete: its figure is a lower bound. */
const vaultIncomplete = (vault: ScanVault | null): boolean =>
  vault !== null && (vault.sol === null || vault.tokensUsd === null);

/** Values vault 0 of the first MAX_VALUED_VAULTS multisigs, a few at a time; the rest get null. */
async function valueVaults(env: Env, multisigs: MultisigAccount[], solPrice: number | null): Promise<(ScanVault | null)[]> {
  const vaults: (ScanVault | null)[] = multisigs.map(() => null);
  const todo = multisigs.slice(0, MAX_VALUED_VAULTS).map((m, i) => ({ i, address: vaultPda(m.address, 0) }));
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < todo.length) {
      const job = todo[next];
      next += 1;
      vaults[job.i] = await valueVault(env, job.address, 0, solPrice);
    }
  };
  await Promise.all(Array.from({ length: Math.min(VAULT_CONCURRENCY, todo.length) }, run));
  return vaults;
}

function parsePrice(payload: unknown): number | null {
  return isRecord(payload) && isRecord(payload.solana) ? num(payload.solana.usd) : null;
}

/**
 * SOL/USD from CoinGecko, kept in the edge cache for five minutes under
 * `cacheKey` (a URL on the Worker's own origin, so the entry is ours and not
 * confused with a cached copy of the CoinGecko response itself). Throws when
 * no price can be had.
 */
async function fetchSolPrice(cacheKey: string): Promise<number> {
  const cache = caches.default;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const cached = parsePrice(await hit.json());
      if (cached !== null) return cached;
    }
  } catch (error) {
    console.warn("price cache read failed", error);
  }

  // Several public sources in turn: CoinGecko blocks some edge IPs with 403,
  // so exchanges' public tickers back it up. The cached payload is normalised
  // to the CoinGecko shape so parsePrice reads it either way.
  // exchanges return the price as a string
  const numLike = (value: unknown): number | null => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const sources: { name: string; url: string; pick: (p: unknown) => number | null }[] = [
    { name: "coingecko", url: COINGECKO_URL, pick: parsePrice },
    {
      name: "coinbase",
      url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
      pick: (p) => (isRecord(p) && isRecord(p.data) ? numLike(p.data.amount) : null),
    },
    {
      name: "kraken",
      url: "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
      pick: (p) => {
        if (!isRecord(p) || !isRecord(p.result)) return null;
        const pair = Object.values(p.result)[0];
        return isRecord(pair) && Array.isArray(pair.c) ? numLike(pair.c[0]) : null;
      },
    },
    {
      name: "binance",
      url: "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
      pick: (p) => (isRecord(p) ? numLike(p.price) : null),
    },
  ];
  let price: number | null = null;
  const failures: string[] = [];
  for (const source of sources) {
    try {
      const res = await fetch(source.url, {
        headers: { Accept: "application/json", "User-Agent": "dirac-scanner/1.0" },
        signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
      });
      if (!res.ok) {
        failures.push(`${source.name} ${res.status}`);
        continue;
      }
      price = source.pick(await res.json());
      if (price !== null && price > 0) break;
      failures.push(`${source.name} no price`);
      price = null;
    } catch (error) {
      failures.push(`${source.name} ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  if (price === null) throw new Error(`price sources failed: ${failures.join("; ")}`);
  const text = JSON.stringify({ solana: { usd: price } });

  try {
    await cache.put(
      cacheKey,
      new Response(text, {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${PRICE_CACHE_SECONDS}` },
      }),
    );
  } catch (error) {
    console.warn("price cache write failed", error);
  }
  return price;
}

/* --- derived indicators (pure) -------------------------------------- */

/** Two decimals from one SOL up, four significant digits below it (the client's formatSolAmount): a dust balance reads "0.004566 SOL", not "0 SOL" next to its USD value. */
const formatSol = (sol: number): string =>
  sol !== 0 && Math.abs(sol) < 1
    ? sol.toLocaleString("en-US", { maximumSignificantDigits: 4 })
    : sol.toLocaleString("en-US", { maximumFractionDigits: 2 });
/** "$1,234" from a thousand up, cents below it: a vault with 0.001 SOL reads $0.11, not $0. */
const formatUsd = (usd: number): string =>
  `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd >= 1000 ? 0 : 2, maximumFractionDigits: usd >= 1000 ? 0 : 2 })}`;
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** Why a line has no number: the source was skipped ("not checked") or failed ("not read"). */
const missing = (what: string, source: SourceState): string =>
  `${what} ${source.status === "skipped" ? "not checked" : "not read"}`;

/** A wallet-like address: a private key can exist for it and it is not a system address. */
const hasKey = (address: ScanAddress): boolean => address.onCurve && address.kind !== "system";

/** Everything the recommendations depend on, so that `buildRecommendations` stays pure. */
export interface RecommendationInput {
  kind: AddressKind;
  /** null when no passport is registered or the registry could not be read */
  passport: { mode: "simple" | "hardened"; anchored: boolean } | null;
  /** false when the registry could not be read: no passport advice is given then */
  registryRead: boolean;
  /** mints plus programs under live control of this key */
  authorityCount: number;
  /** unix seconds of the newest signature; null when unknown (then never dormant) */
  lastActivity: number | null;
  /** unix ms */
  now: number;
  /** SOL equivalent held (SOL, stake and priced tokens at the SOL price); null when unknown */
  heldSol: number | null;
  exposureUsd: number | null;
  /** Squads v4 multisigs the address is a member of (0 when none or not searched) */
  memberOfCount: number;
}

/**
 * Recommendations: derived facts, at most MAX_RECOMMENDATIONS, plain wording.
 * Only a wallet gets passport advice; a multisig is told where its exposure
 * sits (the member keys); any other address nobody holds a key for gets
 * "Nothing to do here"; an unclassified address gets nothing. No clock and no
 * I/O: `now` comes in as an argument. Exported for the smoke test.
 */
export function buildRecommendations(input: RecommendationInput): string[] {
  if (input.kind === "unknown") return [];
  if (input.kind === "multisig") {
    return [
      "The signer keys are the exposure: each member's Ed25519 key, not this address, is what moves the vaults",
      "Raise the threshold and rotate members to fresh keys; scan each member wallet",
    ];
  }
  if (input.kind !== "wallet") return ["Nothing to do here"];

  const out: string[] = [];
  if (input.registryRead && input.passport === null) out.push("Create a Dirac passport");
  if (input.passport?.mode === "simple") out.push("Switch to hardened mode");
  if (input.passport !== null && !input.passport.anchored) out.push("Anchor the passport on Solana");
  if (input.authorityCount > 0) out.push("Move authorities to a multisig (Squads)");
  if (input.memberOfCount > 0) {
    out.push(
      `Member of ${count(input.memberOfCount, "Squads multisig", "Squads multisigs")}: raise their thresholds and rotate members to fresh keys`,
    );
  }
  if (
    input.lastActivity !== null &&
    input.heldSol !== null &&
    input.heldSol >= DORMANT_MIN_SOL &&
    input.now / 1000 - input.lastActivity > DORMANT_DAYS * DAY_SECONDS
  ) {
    out.push("Rotate dormant holdings to a fresh key");
  }
  if (input.exposureUsd !== null && input.exposureUsd >= LARGE_BALANCE_USD) {
    out.push("Large balance under one key: split across keys or a multisig");
  }
  return out.slice(0, MAX_RECOMMENDATIONS);
}

/** The identity indicator: passport level and what it means for this kind of address. */
function describeIdentity(address: ScanAddress, passport: ScanPassport | null, registryRead: boolean): ScanIdentity {
  const level = passport === null ? "none" : passport.mode;
  const anchored = passport !== null && passport.anchored;
  if (address.kind === "multisig") {
    return { level, anchored, note: "A multisig has no key of its own; a passport binds to each member's wallet, not to the multisig." };
  }
  if (!hasKey(address)) {
    return { level, anchored, note: "No private key exists for this address, so there is no identity for a passport to bind." };
  }
  if (!registryRead) {
    return { level, anchored, note: "The registry could not be read, so the passport status is unknown." };
  }
  if (passport === null) {
    return {
      level,
      anchored,
      note: "No Dirac passport is registered for this wallet. A passport binds a post-quantum identity to the address; it does not move the assets.",
    };
  }
  if (passport.mode === "hardened") {
    return {
      level,
      anchored,
      note: anchored
        ? "Hardened passport, anchored: the record existed before its block time and only its own key can replace it; assets still move with the Ed25519 key."
        : "Hardened passport, not anchored: the keys do not depend on the wallet signature; anchoring records the hash on Solana.",
    };
  }
  return {
    level,
    anchored,
    note: anchored
      ? "Simple passport, anchored: the identity is recorded on Solana, but its keys derive from a wallet signature."
      : "Simple passport, not anchored: the keys derive from a wallet signature and the hash is not yet recorded on Solana.",
  };
}

/* --- the report ----------------------------------------------------- */

async function buildReport(env: Env, wallet: string, origin: string): Promise<ScanReport> {
  const notRead: SourceState = { status: "failed", error: "not read" };
  const sources: Sources = {
    address: notRead,
    balance: notRead,
    assets: notRead,
    signatures: notRead,
    stake: notRead,
    mintAuthorities: notRead,
    programAuthorities: notRead,
    price: notRead,
    registry: notRead,
    multisigs: notRead,
  };

  const [accountInfo, balance, holdings, activity, stake, programAuthorities, passport, price] =
    await Promise.allSettled([
      fetchAccountInfo(env, wallet),
      fetchBalance(env, wallet),
      fetchHoldings(env, wallet),
      fetchActivity(env, wallet),
      fetchStake(env, wallet),
      fetchProgramAuthorities(env, wallet),
      fetchPassportSummary(env, wallet),
      fetchSolPrice(priceCacheKey(origin)),
    ]);

  const info = settle(sources, "address", accountInfo);
  const address = classifyAddress(wallet, accountInfo.status === "fulfilled" ? info : undefined);
  const sol = settle(sources, "balance", balance) ?? null;
  const held = settle(sources, "assets", holdings);
  if (held?.truncated) sources.assets = { status: "truncated", error: held.truncation ?? "counts are lower bounds" };
  const seen = settle(sources, "signatures", activity);
  const staked = settle(sources, "stake", stake);
  const programs = settle(sources, "programAuthorities", programAuthorities);
  const passportRow = settle(sources, "registry", passport) ?? null;
  const registryRead = sources.registry.status === "ok";

  // Second phase. The mint check covers the tokens the wallet holds, so it
  // runs after the holdings settle; the membership search (20 to 60 indexed
  // calls, rate-gated) waits for the first batch too, so the burst above does
  // not push the private RPC over its per-second limit.
  const mintCheck: Promise<MintAuthorities> =
    held === undefined
      ? Promise.reject(
          new SkippedError(
            sources.assets.status === "skipped" ? "no private RPC configured" : "needs the token list, which could not be read",
          ),
        )
      : fetchMintAuthorities(env, wallet, held.mints);
  // A multisig's own memberships are not searched: nested multisigs are
  // rare, and a multisig scan adds the vault reads only (the contract).
  const [mintAuthorities, memberships] = await Promise.allSettled([
    mintCheck,
    address.kind === "multisig"
      ? Promise.resolve<Memberships>({ multisigs: [], truncated: false, pagesExhausted: false, searchedAt: Date.now() })
      : fetchMemberships(env, wallet, membershipCacheKey(origin, wallet)),
  ]);
  const mints = settle(sources, "mintAuthorities", mintAuthorities);

  let solUsd: number | null = null;
  if (price.status === "fulfilled") {
    solUsd = price.value;
    sources.price = { status: "ok" };
  } else if (held !== undefined && held.rpcSolUsd !== null && held.rpcSolUsd > 0) {
    solUsd = held.rpcSolUsd;
    sources.price = { status: "ok" };
  } else {
    sources.price = failure(price.reason);
  }

  // An authority value only means control when a private key can sign for
  // it: matches found for a system address or an off-curve address (111…111
  // and other burned values) are counted as ignored, not as control.
  const controls = hasKey(address);
  const mintsFound = mints?.total ?? 0;
  const programsFound = programs?.total ?? 0;
  const mintSource = sources.mintAuthorities.status === "ok";
  const programSource = sources.programAuthorities.status === "ok";
  const authorities: ScanAuthorities = {
    mints: controls && mints !== undefined ? mints.mints : [],
    programs: controls && programs !== undefined ? programs.programs : [],
    burnedIgnored: controls ? 0 : mintsFound + programsFound,
    status: mintSource && programSource ? "ok" : mintSource || programSource ? "partial" : "unavailable",
  };
  const authorityCount = controls ? mintsFound + programsFound : 0;

  // A usable price, or null: every USD figure below is null without one.
  const solPrice: number | null = solUsd !== null && solUsd > 0 ? solUsd : null;
  const atPrice = (amount: number | null): number | null =>
    amount === null || solPrice === null ? null : amount * solPrice;

  // Squads v4: the address as a multisig (from the account already read) and
  // the multisigs it is a member of; vault 0 of each is valued afterwards,
  // since the valuation needs the price and the membership list.
  const selfMultisig = address.kind === "multisig" ? multisigFromAccount(info) : null;
  const member = settle(sources, "multisigs", memberships);
  const memberOfAccounts = member === undefined ? [] : member.multisigs;
  const [selfVault, memberVaults] = await Promise.all([
    selfMultisig === null ? Promise.resolve(null) : valueVault(env, vaultPda(wallet, 0), 0, solPrice),
    valueVaults(env, memberOfAccounts, solPrice),
  ]);
  const memberOf = memberOfAccounts.map((m, i) => reportMultisig(m.address, m, memberVaults[i]));
  const valuedVaults = memberVaults.filter((v): v is ScanVault => v !== null);
  const pricedVaults = valuedVaults.filter((v) => v.usd !== null);
  const coControlledUsd = pricedVaults.length > 0 ? pricedVaults.reduce((sum, v) => sum + (v.usd ?? 0), 0) : null;
  const solVaults = valuedVaults.filter((v) => v.sol !== null);
  const coControlledSol = solVaults.length > 0 ? solVaults.reduce((sum, v) => sum + (v.sol ?? 0), 0) : null;
  if (member !== undefined) {
    const caveats: string[] = [];
    if (member.truncated) caveats.push(`more than ${MAX_MEMBER_MULTISIGS} memberships, the list is a lower bound`);
    if (member.pagesExhausted) caveats.push("the index answered in too many pages for some member slots, memberships may be missing");
    if (memberOfAccounts.length > MAX_VALUED_VAULTS) {
      caveats.push(`vaults valued for the first ${MAX_VALUED_VAULTS} of ${memberOfAccounts.length} multisigs`);
    }
    const incomplete = memberVaults.filter(vaultIncomplete).length + (vaultIncomplete(selfVault) ? 1 : 0);
    if (incomplete > 0) caveats.push(`${count(incomplete, "vault read", "vault reads")} incomplete, values are lower bounds`);
    if (caveats.length > 0) sources.multisigs = { status: "truncated", error: clip(caveats.join("; ")) };
  }
  const selfReport = selfMultisig === null ? null : reportMultisig(wallet, selfMultisig, selfVault);
  const coverage = `first ${MEMBER_SLOTS} member slots searched`;
  // A list older than the fresh cache window stood in for a search the index refused: the note dates it.
  const searchedAt = Date.now();
  const dated =
    member !== undefined && membershipsStale(member, searchedAt)
      ? ` Memberships are from a search ${Math.round((searchedAt - member.searchedAt) / 60_000)} minutes ago; the index did not answer just now.`
      : "";
  const multisigNote = (): string => {
    if (selfReport !== null) {
      const held =
        selfVault !== null && selfVault.usd !== null
          ? `Vault 0 holds ${formatUsd(selfVault.usd)}${selfVault.note ? ` (${selfVault.note})` : ""}.`
          : "Vault 0 could not be valued.";
      return `A Squads v4 multisig: ${selfReport.threshold} of ${selfReport.memberCount} member keys sign for its vaults. ${held} Its own memberships in other multisigs are not searched.`;
    }
    if (member === undefined) {
      return sources.multisigs.status === "skipped"
        ? `Not searched: ${sources.multisigs.error ?? "skipped"}.`
        : "Squads v4 membership could not be searched.";
    }
    if (memberOf.length === 0) return `Not listed in any Squads v4 multisig (${coverage}).${dated}`;
    return `Member of ${memberOf.length}${member.truncated ? "+" : ""} Squads v4 ${memberOf.length === 1 && !member.truncated ? "multisig" : "multisigs"} (${coverage}). Vault-0 holdings are co-controlled: each needs its threshold of member keys, this key alone moves none of it.${dated}`;
  };
  const multisigs: ScanMultisigs = {
    self: selfReport,
    memberOf,
    memberOfTruncated: member !== undefined && (member.truncated || member.pagesExhausted),
    coControlledUsd,
    coControlledSol,
    valued: valuedVaults.length,
    note: multisigNote(),
  };
  const stakeSol = staked === undefined ? null : staked.stakeSol;
  const tokensUsd = held === undefined ? null : held.tokensUsd;
  const exposureSol = sol === null ? null : sol + (stakeSol ?? 0);
  // Stake is not a core source: when it was not read, the total is what the other sources show.
  const coreUsd = atPrice(sol === null ? null : sol + (stakeSol ?? 0));
  const exposureUsd = coreUsd !== null && tokensUsd !== null ? coreUsd + tokensUsd : null;
  const heldSol = exposureUsd !== null && solPrice !== null ? exposureUsd / solPrice : exposureSol;

  const lines: ScanExposureLine[] = [
    {
      label: "SOL balance",
      usd: atPrice(sol),
      note: sol === null ? "balance not read" : `${formatSol(sol)} SOL`,
    },
    {
      label: "Tokens (priced)",
      usd: tokensUsd,
      note:
        held === undefined
          ? missing("assets", sources.assets)
          : `${held.pricedCount} of ${held.tokenCount} tokens have a price${held.truncated ? ", lower bound" : ""}`,
    },
    {
      label: "Stake",
      usd: atPrice(stakeSol),
      note:
        staked === undefined
          ? missing("stake", sources.stake)
          : `${formatSol(staked.stakeSol)} SOL in ${count(staked.stakeAccounts, "stake account", "stake accounts")}`,
    },
  ];
  if (authorities.mints.length > 0) {
    lines.push({
      label: "Authority over mints",
      usd: null,
      note: `${count(mintsFound, "mint", "mints")} can be minted or frozen by this key; supply × price unknown`,
    });
  }
  if (authorities.programs.length > 0) {
    lines.push({
      label: "Upgrade authority over programs",
      usd: null,
      note: `${count(programsFound, "program", "programs")} can be upgraded by this key`,
    });
  }
  const exposure: ScanExposure = {
    usd: exposureUsd,
    sol: exposureSol,
    lines,
    note: controls
      ? "A Dirac passport does not change this: whoever signs with the Ed25519 key moves these assets."
      : selfReport !== null
        ? `This is the multisig account itself, which holds rent only. What ${selfReport.threshold} of ${selfReport.memberCount} member keys can move sits in its vaults; vault 0 is under Control.`
        : "No private key exists for this address: what it holds is moved by program logic, not by a signature.",
  };

  const now = Date.now();
  const recommendations = buildRecommendations({
    kind: address.kind,
    passport: passportRow === null ? null : { mode: passportRow.mode, anchored: passportRow.anchored },
    registryRead,
    authorityCount,
    lastActivity: seen === undefined ? null : seen.lastActivity,
    now,
    heldSol,
    exposureUsd,
    memberOfCount: memberOf.length,
  });

  const statuses = Object.values(sources);
  const confidence = statuses.every((s) => s.status === "ok")
    ? "complete"
    : sources.balance.status === "failed" && sources.assets.status === "failed"
      ? "unavailable"
      : "partial";

  return {
    v: 3,
    wallet,
    scannedAt: now,
    address,
    sources,
    confidence,
    limited: !env.RPC_URL,
    sol,
    solUsd,
    tokens: held === undefined ? [] : held.tokens,
    tokenCount: held === undefined ? null : held.tokenCount,
    tokensUsd,
    nfts: held === undefined ? null : held.nfts,
    assetsTruncated: held !== undefined && held.truncated,
    stakeSol,
    stakeAccounts: staked === undefined ? null : staked.stakeAccounts,
    txCount: seen === undefined ? null : seen.txCount,
    lastActivity: seen === undefined ? null : seen.lastActivity,
    oldestSeen: seen === undefined ? null : seen.oldestSeen,
    authorities,
    multisigs,
    passport: passportRow,
    exposure,
    identity: describeIdentity(address, passportRow, registryRead),
    recommendations,
  };
}

/** Cache key for the SOL price: a URL on this Worker's origin that no route serves. */
const priceCacheKey = (origin: string): string => `${origin}/api/scan/.sol-usd`;
/** Cache key for a wallet's Squads membership search, same idea. */
const membershipCacheKey = (origin: string, wallet: string): string => `${origin}/api/scan/.multisigs/${wallet}`;

async function getScan(request: Request, env: Env, ctx: ExecutionContext, wallet: string): Promise<Response> {
  if (!isWallet(wallet)) return badRequest("wallet must be a base58 Solana address");

  // One entry per wallet: the canonical route URL without the query string,
  // so `?anything` cannot force a fresh set of upstream calls.
  const origin = new URL(request.url).origin;
  const cacheKey = `${origin}/api/scan/${wallet}`;
  const cache = caches.default;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (error) {
    console.warn("scan cache read failed", error);
  }

  const report = await buildReport(env, wallet, origin);
  // Only a report with every source read is worth serving again; a partial
  // one is never stored and gets a fresh attempt on the next request.
  if (report.confidence !== "complete") return json(report);
  const response = json(report, 200, `public, max-age=${SCAN_CACHE_SECONDS}`);
  ctx.waitUntil(
    cache.put(cacheKey, response.clone()).catch((error: unknown) => {
      console.warn("scan cache write failed", error);
    }),
  );
  return response;
}

/* ------------------------------------------------------------------ */
/* Static assets: https redirect and security headers                  */
/* ------------------------------------------------------------------ */

const HSTS = "max-age=31536000; includeSubDomains";
/** Added to HTML responses only; other assets pass through untouched except HSTS. */
// HTML security headers and the CSP live in worker/html.ts (finishHtml).

/**
 * Non-/api requests: plain http is redirected to https (except on loopback
 * hosts, so `wrangler dev` keeps working); everything else comes from the
 * ASSETS binding with the security headers added. Next.js static
 * export writes the per-page prefetch payload to
 * /<page>/__next.<page>/__PAGE__.txt but the client requests
 * /<page>/__next.<page>.__PAGE__.txt; one is mapped onto the other.
 */
/** Hosts `wrangler dev` serves over plain http; redirecting them to https would break local runs. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Files the static export writes without an extension, so the ASSETS binding
 * cannot infer their type and sends no Content-Type at all. Crawlers refuse an
 * og:image without an image/* type (src/app/opengraph-image.tsx exports
 * `contentType = "image/png"`; the file lands at out/opengraph-image).
 */
const EXTENSIONLESS_ASSET_TYPES: Readonly<Record<string, string>> = {
  "/opengraph-image": "image/png",
};

async function serveAsset(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    const secure = new URL(url);
    secure.protocol = "https:";
    return Response.redirect(secure.toString(), 301);
  }
  let upstream = request;
  const m = url.pathname.match(/^\/([^/]+)\/__next\.\1\.__PAGE__\.txt$/);
  if (m) {
    const rewritten = new URL(url);
    rewritten.pathname = `/${m[1]}/__next.${m[1]}/__PAGE__.txt`;
    upstream = new Request(rewritten.toString(), request);
  }
  const asset = await env.ASSETS.fetch(upstream);
  const response = new Response(asset.body, asset);
  response.headers.set("Strict-Transport-Security", HSTS);
  const knownType = EXTENSIONLESS_ASSET_TYPES[url.pathname];
  if (knownType !== undefined && asset.ok && !asset.headers.has("content-type")) {
    response.headers.set("Content-Type", knownType);
    response.headers.set("X-Content-Type-Options", "nosniff");
  }
  if ((asset.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
    // Security headers, this page's CSP, and the per-target <title>, canonical, description and
    // og:* / twitter:* of /scan?a=, /p?a= and /pet, mirrored into the RSC payload (worker/html.ts).
    return finishHtml(response, url, env);
  }
  return response;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  // Badges first: an embedding page must always get an image, never the
  // registry's 400 for a segment that does not decode (worker/badge.ts).
  const badge = await handleBadge(request, env, ctx, parts, url);
  if (badge) return badge;
  const [, resource, rawParam, ...rest] = parts;
  const param = rawParam === undefined ? undefined : decodeSegment(rawParam);
  if (param === null) return badRequest("malformed path");
  const method = request.method;

  // GET /api/passports/:wallet/history: the one registry route with a second segment.
  if (resource === "passports" && param !== undefined && rest.length === 1 && rest[0] === "history" && method === "GET") {
    return getPassportHistory(env, param);
  }

  // The registry routes take at most one path parameter; deeper paths belong
  // to the modules below (DELETE /api/inbox/:wallet/:id) or are not found.
  if (rest.length === 0) {
    if (resource === "passports") {
      if (param === undefined && method === "POST") {
        if (await dbOverLimit(env, "passports", clientKey(request), PASSPORT_LIMIT)) return rateLimited();
        return registerPassport(request, env);
      }
      if (param !== undefined && method === "GET") return getPassport(env, param);
    }
    if (resource === "seals") {
      if (param === undefined && method === "POST") return registerSeal(request, env);
      if (param !== undefined && method === "GET") return getSeal(env, param);
    }
    if (resource === "stats" && param === undefined && method === "GET") return getStats(env);
    if (resource === "scan" && param !== undefined && method === "GET") {
      if (await overLimit(env, env.SCAN_LIMITER, clientKey(request), SCAN_LIMIT)) return rateLimited();
      return getScan(request, env, ctx, param);
    }
    if (resource === "rpc" && param === undefined && method === "POST") {
      if (await overLimit(env, env.RPC_LIMITER, clientKey(request), RPC_LIMIT)) return rateLimited();
      return proxyRpc(request, env);
    }
  }

  // Week 2 modules, after the registry routes and before the 404 (docs/CONTRACT-WEEK2.md).
  const pet = await handlePet(request, env, ctx, parts, url, { rpc: (method, params) => rpcCall<unknown>(env, method, params) });
  if (pet) return pet;
  const inbox = await handleInbox(request, env, ctx, parts, url);
  if (inbox) return inbox;
  const arena = await handleArena(request, env, ctx, parts, url);
  if (arena) return arena;
  const share = await handleShare(request, env, ctx, parts, url);
  if (share) return share;

  return notFound();
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    // Solana Actions (Blinks): /actions.json, /invite/:wallet and /api/actions/* answer their own CORS preflight (worker/actions.ts).
    const actions = await handleActions(request, env, ctx, url.pathname.split("/").filter(Boolean), url);
    if (actions) return actions;
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      return serveAsset(request, env, url);
    }
    if (request.method === "OPTIONS") {
      // /api/share answers its own preflight: uploads are same-origin only there, so PUT is not offered (worker/share.ts).
      const share = await handleShare(request, env, ctx, url.pathname.split("/").filter(Boolean), url);
      if (share) return share;
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      return await route(request, env, ctx, url);
    } catch (error) {
      console.error("api error", request.method, url.pathname, error);
      return json({ error: "internal error" }, 500);
    }
  },

  /**
   * Every 15 minutes (wrangler.jsonc `triggers.crons`): collapse the pet's day
   * when it is due (the 00:00 UTC tick; GET /api/pet repeats it if a tick is
   * missed), then move the weekly IBM hardware run one step, then resolve any
   * finished arena tournament day. All three are idempotent no-ops otherwise.
   */
  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(collapsePet(env).then(() => pollQpu(env)));
    ctx.waitUntil(resolveTournaments(env));
  },
} satisfies ExportedHandler<Env>;

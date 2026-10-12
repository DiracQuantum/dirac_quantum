/**
 * Quantum pet, signed gates and badges: the message a wallet signs for one
 * gate, the nonce rules, the Ed25519 check the Worker runs, and the browser
 * client for the signed form of `POST /api/pet/act`, `GET /api/pet?wallet=`
 * and `GET /api/pet/badges?wallet=`.
 *
 * Same rules as ./pet and ./inbox: package imports only, no `@/` alias and no
 * relative runtime import, so the file runs unchanged in the browser, in the
 * Worker (`../src/lib/petGate`) and under `node` type stripping
 * (scripts/pet-signed-e2e.ts). The types come from ./pet as type-only imports.
 *
 * A signed gate is one Ed25519 signature by the connected wallet over
 *   dirac:pet:gate:v1:<day>:<gate>:<q>:<t or ->:<nonce>
 * with a fresh 16-byte nonce. The day pins it to the current register, the
 * nonce makes it single-use, and the Worker counts signed gates per wallet
 * (3 per minute) instead of per IP (1 per minute). A bag of throwaway keys
 * is still one visitor: signed gates are also capped per IP across wallets
 * (SIGNED_IP_LIMIT per minute), one IP may sign with WALLETS_PER_IP_PER_DAY
 * wallets a day, and the wallet must have an account on Solana. Nothing is
 * sent on chain; the signature is checked by the Worker and the wallet is
 * written next to the gate.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import type { ActResult, Gate, PetBadge, PetState, SignedGate } from "./pet";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Signed gates per fixed one-minute window per wallet (bucket "petw"). */
export const SIGNED_PET_LIMIT = 3;
/** Anonymous gates per fixed one-minute window per client IP (bucket "pet"). */
export const ANON_PET_LIMIT = 1;
/** Signed gates per fixed one-minute window per client IP across every wallet it signs with (bucket "petip"). */
export const SIGNED_IP_LIMIT = 6;
/** Distinct wallets that may sign gates from one client IP in one UTC day (pet_wallet_ips). */
export const WALLETS_PER_IP_PER_DAY = 3;
/** The fixed window both limits count in. */
export const PET_WINDOW_MS = 60_000;
/** Random bytes in a nonce; it travels as 32 lowercase hex characters. */
export const GATE_NONCE_BYTES = 16;

const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const ED25519_PK_LEN = 32;
const ED25519_SIG_LEN = 64;

/* ------------------------------------------------------------------ */
/* Message and nonce                                                   */
/* ------------------------------------------------------------------ */

/** The exact UTF-8 text a wallet signs for one gate. `t` is "-" for every gate but CNOT. */
export const GATE_MESSAGE = (day: number, gate: Gate, q: number, t: number | null | undefined, nonce: string): string =>
  `dirac:pet:gate:v1:${day}:${gate}:${q}:${t === null || t === undefined ? "-" : t}:${nonce}`;

/** 16 random bytes as 32 hex characters. */
export function newGateNonce(): string {
  return bytesToHex(randomBytes(GATE_NONCE_BYTES));
}

export const isGateNonce = (value: unknown): value is string => typeof value === "string" && NONCE_PATTERN.test(value);

/** The fixed one-minute window a timestamp falls in (same arithmetic as the Worker's counter). */
export const windowOf = (now: number): number => Math.floor(now / PET_WINDOW_MS);

/* ------------------------------------------------------------------ */
/* Encoding and verification                                           */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

function tryB64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return base64.decode(s);
  } catch {
    return null;
  }
}

function tryB58(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return base58.decode(s);
  } catch {
    return null;
  }
}

/** True for a base58 string that decodes to a 32-byte Ed25519 public key. */
export function isWalletAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  const pk = tryB58(value);
  return pk !== null && pk.length === ED25519_PK_LEN;
}

/** A base64 (or base58, which Solana tooling also emits) Ed25519 signature as bytes, or null. */
function signatureBytes(sig: unknown): Uint8Array | null {
  if (typeof sig !== "string" || sig.length === 0 || sig.length > 128) return null;
  let bytes = tryB64(sig);
  if (!bytes || bytes.length !== ED25519_SIG_LEN) bytes = tryB58(sig);
  return bytes && bytes.length === ED25519_SIG_LEN ? bytes : null;
}

/** Ed25519 check of `sig` over the UTF-8 `message` with the wallet's public key. Never throws. */
export function verifyGateSig(wallet: string, message: string, sig: string): boolean {
  try {
    const pk = tryB58(wallet);
    if (!pk || pk.length !== ED25519_PK_LEN) return false;
    const bytes = signatureBytes(sig);
    if (!bytes) return false;
    return ed25519.verify(bytes, encoder.encode(message), pk);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Signing (browser)                                                   */
/* ------------------------------------------------------------------ */

/** The part of a connected wallet the signing needs (`ConnectedWallet` from lib/solana/wallet fits). */
export interface GateSigner {
  address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Builds the signed form of a gate: a fresh nonce, the message for `day`, one
 * wallet signature. Throws whatever the wallet throws (a refusal included),
 * so the caller can fall back to an anonymous gate.
 */
export async function signGate(day: number, gate: Gate, q: number, t: number | null, wallet: GateSigner): Promise<SignedGate> {
  const nonce = newGateNonce();
  const sig = await wallet.signMessage(encoder.encode(GATE_MESSAGE(day, gate, q, t, nonce)));
  if (!(sig instanceof Uint8Array) || sig.length !== ED25519_SIG_LEN) {
    throw new Error("The wallet returned something that is not an Ed25519 signature.");
  }
  return { day, wallet: wallet.address, nonce, sig: base64.encode(sig) };
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/** Same rule as `API_BASE` in ./api: empty in production (same origin), the deployed Worker for local dev. */
const API_BASE: string = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

/** Thrown on any non-2xx response. A 429 carries `retryAt` (unix ms) and a message that names the wait. */
export class PetGateError extends Error {
  readonly status: number;
  readonly retryAt: number | null;

  constructor(status: number, message: string, retryAt: number | null = null) {
    super(message);
    this.name = "PetGateError";
    this.status = status;
    this.retryAt = retryAt;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const serverMessage = isRecord(data) && typeof data.error === "string" ? data.error : null;
    if (res.status === 429) {
      const retryAt = isRecord(data) && typeof data.retryAt === "number" ? data.retryAt : null;
      const wait = retryAt === null ? null : Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
      const message =
        wait === null ? (serverMessage ?? "rate limited") : `${serverMessage ?? "rate limited"}, next gate in ${wait} s`;
      throw new PetGateError(429, message, retryAt);
    }
    throw new PetGateError(res.status, serverMessage ?? `request failed with status ${res.status}`);
  }
  return data as T;
}

/** `GET /api/pet`, with `myGates` and `leader` for `wallet` when one is given. */
export async function fetchPetState(wallet?: string | null): Promise<PetState> {
  const query = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
  return request<PetState>(`/api/pet${query}`);
}

/**
 * `POST /api/pet/act`: anonymous when `signed` is null, counted per wallet
 * and written with it otherwise. The returned state carries `myGates` for the
 * signing wallet.
 */
export async function applyGate(gate: Gate, q: number, t?: number, signed: SignedGate | null = null): Promise<ActResult> {
  const body: Record<string, unknown> = { gate, q };
  if (t !== undefined) body.t = t;
  if (signed) {
    body.day = signed.day;
    body.wallet = signed.wallet;
    body.nonce = signed.nonce;
    body.sig = signed.sig;
  }
  return request<ActResult>("/api/pet/act", { method: "POST", body: JSON.stringify(body) });
}

/** `GET /api/pet/badges?wallet=`: the wallet's badges, newest day first. */
export async function fetchPetBadges(wallet: string): Promise<PetBadge[]> {
  return request<PetBadge[]>(`/api/pet/badges?wallet=${encodeURIComponent(wallet)}`);
}

/**
 * Dirac inbox: envelopes, the messages wallets sign, and the client for the
 * Worker routes under /api/inbox and /api/invites.
 *
 * Pure module, same rules as `pq.ts`: no React, no DOM apart from
 * `TextEncoder`, and only package imports, so it runs unchanged in the
 * browser, in the Worker (`../src/lib/inbox`) and under `node` type stripping
 * (`scripts/inbox-selftest.ts`). The encoding helpers are repeated from
 * `pq.ts` in a few lines for that reason: a relative import without an
 * extension does not resolve under node, and one with it does not compile
 * here.
 *
 * A letter is encrypted in the sender's browser: ML-KEM-768 encapsulation to
 * the recipient's passport key gives a shared secret, HKDF-SHA256 turns it
 * into one XChaCha20-Poly1305 key, and the ciphertext travels as base64 JSON.
 * The server stores the envelope and the sender's Ed25519 signature over its
 * hash; it can read who wrote to whom, never what.
 */

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface Envelope {
  v: 1;
  alg: "ML-KEM-768+XChaCha20-Poly1305";
  /** base64 ML-KEM-768 ciphertext (1088 bytes) */
  kem_ct: string;
  /** base64, 24 bytes */
  nonce: string;
  /** base64 XChaCha20-Poly1305 ciphertext of the letter JSON (at most 16 KB) */
  ct: string;
}

/** The plaintext inside an envelope. */
export interface Letter {
  v: 1;
  text: string;
  /** The sender's wallet as written inside the sealed text, or null for an unsigned note. */
  from: string | null;
  /** unix ms, set by the sender */
  sent_at: number;
}

/**
 * A USDC payment attached to a letter: "verified" once the Worker found the
 * transfer on chain and it matches; "pending" while the transaction is not
 * visible yet (checked again when the inbox is read); "invalid" when it
 * failed the check or never appeared.
 */
export type PaymentStatus = "verified" | "pending" | "invalid";

/** What the sender claims when posting a letter: the transaction and its amount in USDC base units. */
export interface PaymentClaim {
  /** base58 transaction signature */
  signature: string;
  /** USDC base units (6 decimals) */
  amount: number;
}

/** A payment as the Worker reports it, on the inbox list and in the send response. */
export interface LetterPayment extends PaymentClaim {
  status: PaymentStatus;
  /** why the payment is invalid; null otherwise */
  reason: string | null;
}

/** One stored message, as `GET /api/inbox/:wallet` returns it. */
export interface InboxMessage {
  id: number;
  /** base58 wallet that signed the envelope */
  from: string;
  envelope: Envelope;
  /** unix ms, set by the server */
  created_at: number;
  /** the attached USDC payment; absent or null for a letter without one */
  payment?: LetterPayment | null;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const ENVELOPE_ALG = "ML-KEM-768+XChaCha20-Poly1305";
export const KEM_CT_LEN = 1088;
export const KEM_PK_LEN = 1184;
export const NONCE_LEN = 24;
export const KEY_LEN = 32;
/** Poly1305 tag appended to every ciphertext. */
export const TAG_LEN = 16;
/** Longest encrypted letter the server stores. */
export const MAX_CT_BYTES = 16 * 1024;
/** Longest text the compose page accepts; 4000 characters of 4-byte UTF-8 still fit MAX_CT_BYTES. */
export const MAX_TEXT_CHARS = 4000;
/** A read signature is accepted this many one-minute buckets away from the server clock. */
export const READ_BUCKET_TOLERANCE = 2;
/** Messages returned per inbox read, newest first. */
export const INBOX_PAGE = 50;
/** Inviting wallets listed per `GET /api/invites/:to`. */
export const INVITES_PAGE = 20;

const HKDF_SALT = "dirac-inbox-v1";
const HKDF_INFO = "message";
const ED25519_PK_LEN = 32;
const ED25519_SIG_LEN = 64;
const ENVELOPE_FIELDS = ["v", "alg", "kem_ct", "nonce", "ct"] as const;

/* ------------------------------------------------------------------ */
/* Encoding helpers                                                    */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export const b64 = {
  encode: (b: Uint8Array): string => base64.encode(b),
  decode: (s: string): Uint8Array => base64.decode(s),
};

/** Decode a base64 string; null instead of throwing on malformed input. */
function tryB64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return base64.decode(s);
  } catch {
    return null;
  }
}

/** Decode a base58 string; null instead of throwing on malformed input. */
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

/** True for a base58 string that decodes to a 64-byte Solana transaction signature. */
export function isTxSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 64 || value.length > 128) return false;
  const sig = tryB58(value);
  return sig !== null && sig.length === ED25519_SIG_LEN;
}

/**
 * Canonical JSON of a flat object: keys sorted, no whitespace. Enough for an
 * envelope, whose members are all strings and numbers, and byte-identical in
 * the browser, the Worker and node.
 */
function canonicalJson(value: Record<string, string | number>): string {
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`).join(",")}}`;
}

/* ------------------------------------------------------------------ */
/* Envelope shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * Rebuilds an Envelope from untrusted JSON with every field checked, or
 * returns the reason it is not one. Extra fields are rejected: they would
 * change the canonical bytes the sender signed.
 */
export function parseEnvelope(input: unknown): { ok: true; value: Envelope } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "envelope must be an object" };
  }
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(ENVELOPE_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, error: `envelope has an unknown field: ${key}` };
    }
  }
  const { v, alg, kem_ct, nonce, ct } = obj;
  if (v !== 1) return { ok: false, error: "envelope.v must be 1" };
  if (alg !== ENVELOPE_ALG) return { ok: false, error: `envelope.alg must be "${ENVELOPE_ALG}"` };
  if (typeof kem_ct !== "string" || typeof nonce !== "string" || typeof ct !== "string") {
    return { ok: false, error: "envelope.kem_ct, nonce and ct must be base64 strings" };
  }
  // base64 grows bytes by 4/3; anything far beyond that is not worth decoding.
  const kemCt = kem_ct.length <= KEM_CT_LEN * 2 ? tryB64(kem_ct) : null;
  if (!kemCt || kemCt.length !== KEM_CT_LEN) {
    return { ok: false, error: `envelope.kem_ct must be a ${KEM_CT_LEN}-byte ML-KEM-768 ciphertext` };
  }
  const nonceBytes = nonce.length <= NONCE_LEN * 2 ? tryB64(nonce) : null;
  if (!nonceBytes || nonceBytes.length !== NONCE_LEN) {
    return { ok: false, error: `envelope.nonce must be ${NONCE_LEN} bytes` };
  }
  const ctBytes = ct.length <= MAX_CT_BYTES * 2 ? tryB64(ct) : null;
  if (!ctBytes || ctBytes.length <= TAG_LEN) return { ok: false, error: "envelope.ct is empty or malformed" };
  if (ctBytes.length > MAX_CT_BYTES) {
    return { ok: false, error: `envelope.ct exceeds ${MAX_CT_BYTES} bytes` };
  }
  return { ok: true, value: { v: 1, alg: ENVELOPE_ALG, kem_ct, nonce, ct } };
}

/**
 * The optional `payment` of a send request: absent or null is no payment;
 * otherwise `{ signature, amount }` with a 64-byte base58 signature and a
 * positive safe-integer amount in USDC base units (a string of digits is
 * accepted too). Extra fields are rejected.
 */
export function parsePaymentClaim(input: unknown): { ok: true; value: PaymentClaim | null } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "payment must be an object" };
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "signature" && key !== "amount") return { ok: false, error: `payment has an unknown field: ${key}` };
  }
  if (!isTxSignature(obj.signature)) return { ok: false, error: "payment.signature must be a base58 transaction signature" };
  const raw = obj.amount;
  const amount = typeof raw === "string" && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, error: "payment.amount must be a positive whole number of USDC base units" };
  }
  return { ok: true, value: { signature: obj.signature, amount } };
}

/* ------------------------------------------------------------------ */
/* Encrypt / decrypt                                                   */
/* ------------------------------------------------------------------ */

function messageKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, utf8(HKDF_SALT), utf8(HKDF_INFO), KEY_LEN);
}

function isLetter(value: unknown): value is Letter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const l = value as Record<string, unknown>;
  return (
    l.v === 1 &&
    typeof l.text === "string" &&
    (l.from === null || typeof l.from === "string") &&
    typeof l.sent_at === "number" &&
    Number.isFinite(l.sent_at)
  );
}

/**
 * Seals a letter for the holder of `recipientKemPk` (the passport's
 * ML-KEM-768 public key, 1184 bytes). A fresh encapsulation and nonce every
 * call; the one-time key is wiped afterwards.
 */
export function encryptLetter(letter: Letter, recipientKemPk: Uint8Array): Envelope {
  if (!isLetter(letter)) throw new TypeError("letter must be { v: 1, text, from, sent_at }");
  if (letter.text.length > MAX_TEXT_CHARS) {
    throw new RangeError(`letter text must be at most ${MAX_TEXT_CHARS} characters`);
  }
  if (!(recipientKemPk instanceof Uint8Array) || recipientKemPk.length !== KEM_PK_LEN) {
    throw new RangeError(`recipient key must be ${KEM_PK_LEN} bytes`);
  }
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipientKemPk);
  const key = messageKey(sharedSecret);
  sharedSecret.fill(0);
  const nonce = randomBytes(NONCE_LEN);
  const plain: Letter = { v: 1, text: letter.text, from: letter.from, sent_at: letter.sent_at };
  let ct: Uint8Array;
  try {
    ct = xchacha20poly1305(key, nonce).encrypt(utf8(JSON.stringify(plain)));
  } finally {
    key.fill(0);
  }
  if (ct.length > MAX_CT_BYTES) throw new RangeError(`encrypted letter exceeds ${MAX_CT_BYTES} bytes`);
  return {
    v: 1,
    alg: ENVELOPE_ALG,
    kem_ct: b64.encode(cipherText),
    nonce: b64.encode(nonce),
    ct: b64.encode(ct),
  };
}

/**
 * Opens an envelope with the recipient's ML-KEM-768 secret key. Throws on a
 * malformed envelope, a wrong key or any modification of the ciphertext.
 */
export function decryptLetter(env: Envelope, kemSk: Uint8Array): Letter {
  const parsed = parseEnvelope(env);
  if (!parsed.ok) throw new Error(parsed.error);
  if (!(kemSk instanceof Uint8Array) || kemSk.length === 0) throw new TypeError("kemSk must be a Uint8Array");
  const kemCt = b64.decode(parsed.value.kem_ct);
  const nonce = b64.decode(parsed.value.nonce);
  const ct = b64.decode(parsed.value.ct);
  // ML-KEM decapsulation never fails loudly: a wrong key yields a different
  // secret, and the Poly1305 tag check below is what rejects it.
  const sharedSecret = ml_kem768.decapsulate(kemCt, kemSk);
  const key = messageKey(sharedSecret);
  sharedSecret.fill(0);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, nonce).decrypt(ct);
  } catch {
    throw new Error("This letter was not written to your key, or it was modified.");
  } finally {
    key.fill(0);
  }
  let letter: unknown;
  try {
    letter = JSON.parse(decoder.decode(plain));
  } catch {
    throw new Error("The letter decrypted to something that is not a Dirac letter.");
  }
  if (!isLetter(letter)) throw new Error("The letter decrypted to something that is not a Dirac letter.");
  return { v: 1, text: letter.text, from: letter.from, sent_at: letter.sent_at };
}

/** hex sha256 of the canonical envelope JSON (sorted keys, no whitespace). */
export function envelopeHash(env: Envelope): string {
  const canonical: Record<string, string | number> = {
    v: env.v,
    alg: env.alg,
    kem_ct: env.kem_ct,
    nonce: env.nonce,
    ct: env.ct,
  };
  return bytesToHex(sha256(utf8(canonicalJson(canonical))));
}

/* ------------------------------------------------------------------ */
/* Messages wallets sign                                               */
/* ------------------------------------------------------------------ */

/** The sender's wallet signs this over the envelope hash; the server stores the signature. */
export const SEND_MESSAGE = (to: string, hash: string) => `dirac:inbox:send:v1:${to}:${hash}`;

/** The owner's wallet signs this to read or delete; `bucket` is the current minute. */
export const READ_MESSAGE = (wallet: string, bucket: number) => `dirac:inbox:read:v1:${wallet}:${bucket}`;

/** The minute bucket a read signature is bound to. */
export const readBucket = (now = Date.now()) => Math.floor(now / 60_000);

/** A base64 (or base58) Ed25519 signature as bytes, or null. */
function signatureBytes(sig: string): Uint8Array | null {
  let bytes = tryB64(sig);
  if (!bytes || bytes.length !== ED25519_SIG_LEN) bytes = tryB58(sig);
  return bytes && bytes.length === ED25519_SIG_LEN ? bytes : null;
}

/** Ed25519 check of `sig` over `message` with the wallet's public key. Never throws. */
export function verifyWalletMessage(wallet: string, message: string, sig: string): boolean {
  try {
    const pk = tryB58(wallet);
    if (!pk || pk.length !== ED25519_PK_LEN) return false;
    const bytes = signatureBytes(sig);
    if (!bytes) return false;
    return ed25519.verify(bytes, utf8(message), pk);
  } catch {
    return false;
  }
}

/** Does `senderSig` bind `envelope` to `to` under the sender's wallet key? */
export function verifySendSig(to: string, envelope: Envelope, sender: string, senderSig: string): boolean {
  return verifyWalletMessage(sender, SEND_MESSAGE(to, envelopeHash(envelope)), senderSig);
}

/**
 * Is `sig` a valid read signature for `wallet` in `bucket`, and is that bucket
 * within READ_BUCKET_TOLERANCE minutes of `now`?
 */
export function verifyReadSig(wallet: string, bucket: number, sig: string, now = Date.now()): boolean {
  if (!Number.isSafeInteger(bucket) || bucket <= 0) return false;
  if (Math.abs(bucket - readBucket(now)) > READ_BUCKET_TOLERANCE) return false;
  return verifyWalletMessage(wallet, READ_MESSAGE(wallet, bucket), sig);
}

/** Value of the `Authorization` header for inbox reads and deletes. */
export const authHeader = (wallet: string, bucket: number, sig: string) => `Dirac ${wallet}:${bucket}:${sig}`;

/** Splits an `Authorization: Dirac <wallet>:<bucket>:<sig>` header, or null. */
export function parseAuthHeader(header: string | null): { wallet: string; bucket: number; sig: string } | null {
  if (!header) return null;
  const m = header.match(/^Dirac\s+([1-9A-HJ-NP-Za-km-z]{32,44}):(\d{1,12}):([A-Za-z0-9+/=_-]{64,128})$/);
  if (!m) return null;
  const bucket = Number(m[2]);
  if (!Number.isSafeInteger(bucket)) return null;
  return { wallet: m[1], bucket, sig: m[3] };
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/** Same rule as `API_BASE` in ./api: empty in production (same origin), the deployed Worker for local dev. */
const API_BASE: string = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

export class InboxApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "InboxApiError";
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
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
    const error =
      typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `request failed with status ${res.status}`;
    throw new InboxApiError(res.status, error);
  }
  return data as T;
}

/**
 * `POST /api/inbox/:to`: stores a sealed letter for `to`, signed by `sender`.
 * With `payment`, the Worker checks the USDC transfer on chain and answers
 * with its status; the same letter and payment posted again return the same id.
 */
export async function sendLetter(
  to: string,
  envelope: Envelope,
  sender: string,
  senderSig: string,
  payment?: PaymentClaim,
): Promise<{ ok: true; id: number; payment?: LetterPayment | null }> {
  return call(`/api/inbox/${encodeURIComponent(to)}`, {
    method: "POST",
    body: JSON.stringify(
      payment ? { envelope, sender, sender_sig: senderSig, payment } : { envelope, sender, sender_sig: senderSig },
    ),
  });
}

/** `GET /api/inbox/:wallet`: the newest INBOX_PAGE envelopes for the wallet that signed `sig` in `bucket`. */
export async function fetchInbox(wallet: string, sig: string, bucket: number): Promise<InboxMessage[]> {
  const res = await call<{ messages: InboxMessage[] }>(`/api/inbox/${encodeURIComponent(wallet)}`, {
    headers: { Authorization: authHeader(wallet, bucket, sig) },
  });
  return Array.isArray(res?.messages) ? res.messages : [];
}

/** `DELETE /api/inbox/:wallet/:id`, same authorization as a read. */
export async function deleteLetter(wallet: string, id: number, sig: string, bucket: number): Promise<void> {
  await call(`/api/inbox/${encodeURIComponent(wallet)}/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
    headers: { Authorization: authHeader(wallet, bucket, sig) },
  });
}

/** `GET /api/invites/:to`: how many wallets invited `to`, and the newest INVITES_PAGE of them. */
export async function fetchInvites(to: string): Promise<{ count: number; from: string[] }> {
  const res = await call<{ count: number; from: string[] }>(`/api/invites/${encodeURIComponent(to)}`);
  return { count: typeof res?.count === "number" ? res.count : 0, from: Array.isArray(res?.from) ? res.from : [] };
}

/** `POST /api/invites`: records that `from` sent the invite transaction `tx` to `to`. */
export async function registerInvite(from: string, to: string, tx: string): Promise<{ ok: true }> {
  return call("/api/invites", { method: "POST", body: JSON.stringify({ from, to, tx }) });
}

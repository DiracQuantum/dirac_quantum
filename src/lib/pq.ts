/**
 * Dirac post-quantum passport primitives.
 *
 * Pure module: no React, no DOM apart from `TextEncoder`. Runs unchanged in the
 * browser, in the Cloudflare Worker and under `node` (type stripping), so it
 * avoids TS-only runtime syntax (no enums, parameter properties or namespaces).
 *
 * Passport = two post-quantum keys (ML-KEM-768 for encryption, ML-DSA-65 for
 * signatures) bound to a Solana wallet. The wallet signs the passport with
 * Ed25519, the passport signs itself with ML-DSA, and one memo transaction
 * anchors the passport hash on chain. A registered passport is replaced only
 * with a rotation signature from its own ML-DSA key (ROTATE_MESSAGE).
 */

import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { bytesToHex, concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { base58, base64 } from "@scure/base";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PassportMode = "simple" | "hardened";

export interface Passport {
  v: 1;
  /** base58 Solana address (Ed25519 public key) */
  wallet: string;
  /** base64 ML-KEM-768 public key (1184 bytes) */
  kem_pk: string;
  /** base64 ML-DSA-65 public key (1952 bytes) */
  dsa_pk: string;
  mode: PassportMode;
  /** unix ms */
  created_at: number;
}

export interface PassportKeys {
  kemPk: Uint8Array;
  kemSk: Uint8Array;
  dsaPk: Uint8Array;
  dsaSk: Uint8Array;
}

export interface Seeds {
  /** 64 bytes, ML-KEM-768 keygen seed */
  kemSeed: Uint8Array;
  /** 32 bytes, ML-DSA-65 keygen seed */
  dsaSeed: Uint8Array;
}

export interface QSeal {
  v: 1;
  hash_alg: "sha256";
  /** hex sha256 of the document */
  doc_hash: string;
  /** wallet address of the signing passport */
  passport: string;
  /** base64 ML-DSA-65 public key */
  dsa_pk: string;
  sig_alg: "ML-DSA-65";
  /** base64 ML-DSA-65 signature over utf8(SEAL_MESSAGE(doc_hash, signed_at)) */
  signature: string;
  /** unix seconds */
  signed_at: number;
  name?: string;
  anchor_tx?: string;
}

export interface RecoveryFile {
  v: 1;
  kdf: "argon2id";
  t: number;
  m: number;
  p: number;
  /** base64, 16 bytes */
  salt: string;
  /** base64, 24 bytes */
  nonce: string;
  /** base64, 32-byte entropy + 16-byte Poly1305 tag */
  ct: string;
  wallet: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Byte lengths of the fixed-size values used throughout the app. */
export const KEM_PK_LEN = 1184;
export const KEM_SEED_LEN = 64;
export const DSA_PK_LEN = 1952;
export const DSA_SIG_LEN = 3309;
export const DSA_SEED_LEN = 32;
export const ENTROPY_LEN = 32;
export const ED25519_PK_LEN = 32;
export const ED25519_SIG_LEN = 64;

const HKDF_SALT = "dirac-passport-v1";
const HKDF_INFO_KEM = "ml-kem-768";
const HKDF_INFO_DSA = "ml-dsa-65";

const RECOVERY_T = 3;
const RECOVERY_M = 65536;
const RECOVERY_P = 1;
const RECOVERY_DK_LEN = 32;
const RECOVERY_SALT_LEN = 16;
const RECOVERY_NONCE_LEN = 24;

const HEX_64 = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* Encoding helpers                                                    */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export const b64 = {
  encode: (b: Uint8Array): string => base64.encode(b),
  decode: (s: string): Uint8Array => base64.decode(s),
};

function assertBytes(value: Uint8Array, length: number, what: string): void {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${what} must be a Uint8Array`);
  if (value.length !== length) {
    throw new RangeError(`${what} must be ${length} bytes, got ${value.length}`);
  }
}

/** Decode a base64 string; returns null instead of throwing on malformed input. */
function tryB64(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return base64.decode(s);
  } catch {
    return null;
  }
}

/** Decode a base58 string; returns null instead of throwing on malformed input. */
function tryB58(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return base58.decode(s);
  } catch {
    return null;
  }
}

/**
 * Canonical JSON: object keys sorted alphabetically (recursively), no
 * whitespace, `undefined` members omitted. Deterministic across engines so
 * that hashes and signatures computed in the browser, the Worker and Node
 * agree byte for byte.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical JSON: non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonical JSON: unsupported value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/* ------------------------------------------------------------------ */
/* Seeds and keys                                                      */
/* ------------------------------------------------------------------ */

export const KEY_DERIVATION_MESSAGE = (wallet: string) =>
  `Dirac keys v1\nwallet: ${wallet}\nThis signature derives your post-quantum passport keys. Only sign it on dirac.network.`;

function deriveSeeds(ikm: Uint8Array): Seeds {
  const salt = utf8(HKDF_SALT);
  return {
    kemSeed: hkdf(sha256, ikm, salt, utf8(HKDF_INFO_KEM), KEM_SEED_LEN),
    dsaSeed: hkdf(sha256, ikm, salt, utf8(HKDF_INFO_DSA), DSA_SEED_LEN),
  };
}

/**
 * Simple mode: both keygen seeds come from the wallet's Ed25519 signature over
 * `KEY_DERIVATION_MESSAGE(wallet)`. HKDF-SHA256, salt "dirac-passport-v1",
 * info "ml-kem-768" (64 B) / "ml-dsa-65" (32 B).
 *
 * A convenience mode, not post-Q-Day protection: Ed25519 signatures are
 * deterministic, so whoever recovers the wallet's secret key re-derives the
 * same PQ secret keys (and can then sign a rotation). Hardened mode does not
 * have this dependence.
 */
export function seedsFromSignature(sig: Uint8Array): Seeds {
  if (!(sig instanceof Uint8Array) || sig.length === 0) {
    throw new TypeError("signature must be a non-empty Uint8Array");
  }
  return deriveSeeds(sig);
}

/** Hardened mode: the same HKDF over 32 bytes of independent entropy. */
export function seedsFromEntropy(entropy32: Uint8Array): Seeds {
  assertBytes(entropy32, ENTROPY_LEN, "entropy");
  return deriveSeeds(entropy32);
}

/** 32 random bytes from the platform CSPRNG. */
export function newEntropy(): Uint8Array {
  return randomBytes(ENTROPY_LEN);
}

/** 32-byte entropy → 24-word BIP39 English phrase. */
export function entropyToPhrase(entropy32: Uint8Array): string {
  assertBytes(entropy32, ENTROPY_LEN, "entropy");
  return entropyToMnemonic(entropy32, wordlist);
}

/** 24-word BIP39 English phrase → 32-byte entropy. Throws on an invalid phrase. */
export function phraseToEntropy(phrase: string): Uint8Array {
  if (typeof phrase !== "string") throw new TypeError("phrase must be a string");
  const normalized = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (normalized.length === 0) throw new Error("Recovery phrase is empty");
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Invalid recovery phrase: unknown word or bad checksum");
  }
  const entropy = mnemonicToEntropy(normalized, wordlist);
  if (entropy.length !== ENTROPY_LEN) {
    throw new Error(`Recovery phrase must be 24 words, got ${normalized.split(" ").length}`);
  }
  return entropy;
}

/** Deterministic ML-KEM-768 + ML-DSA-65 key pairs from the two seeds. */
export function keysFromSeeds(seeds: Seeds): PassportKeys {
  assertBytes(seeds.kemSeed, KEM_SEED_LEN, "kemSeed");
  assertBytes(seeds.dsaSeed, DSA_SEED_LEN, "dsaSeed");
  const kem = ml_kem768.keygen(seeds.kemSeed);
  const dsa = ml_dsa65.keygen(seeds.dsaSeed);
  return {
    kemPk: kem.publicKey,
    kemSk: kem.secretKey,
    dsaPk: dsa.publicKey,
    dsaSk: dsa.secretKey,
  };
}

/* ------------------------------------------------------------------ */
/* Passport                                                            */
/* ------------------------------------------------------------------ */

function assertWallet(wallet: string): void {
  const pk = tryB58(wallet);
  if (!pk || pk.length !== ED25519_PK_LEN) {
    throw new Error("wallet must be a base58 Solana address (32-byte Ed25519 public key)");
  }
}

export function buildPassport(
  wallet: string,
  keys: PassportKeys,
  mode: PassportMode,
  createdAt?: number,
): Passport {
  assertWallet(wallet);
  assertBytes(keys.kemPk, KEM_PK_LEN, "kemPk");
  assertBytes(keys.dsaPk, DSA_PK_LEN, "dsaPk");
  if (mode !== "simple" && mode !== "hardened") throw new Error(`unknown passport mode: ${mode}`);
  const created_at = createdAt ?? Date.now();
  if (!Number.isInteger(created_at) || created_at <= 0) {
    throw new RangeError("createdAt must be a positive integer (unix ms)");
  }
  return {
    v: 1,
    wallet,
    kem_pk: b64.encode(keys.kemPk),
    dsa_pk: b64.encode(keys.dsaPk),
    mode,
    created_at,
  };
}

/** Canonical JSON of the passport (sorted keys, no whitespace) as UTF-8 bytes. */
export function canonicalBytes(p: Passport): Uint8Array {
  return utf8(canonicalJson(p));
}

/** hex sha256 of `canonicalBytes(p)`. */
export function passportHash(p: Passport): string {
  return bytesToHex(sha256(canonicalBytes(p)));
}

/** Throws unless `dsaSk` is the secret half of the passport's ML-DSA key. */
function assertSecretMatches(p: Passport, dsaSk: Uint8Array): void {
  const expected = tryB64(p.dsa_pk);
  if (!expected || expected.length !== DSA_PK_LEN) {
    throw new Error("passport dsa_pk is not a valid base64 ML-DSA-65 public key");
  }
  const actual = ml_dsa65.getPublicKey(dsaSk);
  if (actual.length !== expected.length) throw new Error("secret key does not match passport");
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  if (diff !== 0) throw new Error("secret key does not match passport");
}

/** base64 ML-DSA-65 signature over `canonicalBytes(p)` (proof of PQ key ownership). */
export function selfSign(p: Passport, dsaSk: Uint8Array): string {
  assertSecretMatches(p, dsaSk);
  return b64.encode(ml_dsa65.sign(canonicalBytes(p), dsaSk));
}

export function verifySelf(p: Passport, selfSig: string): boolean {
  try {
    const sig = tryB64(selfSig);
    const pk = tryB64(p.dsa_pk);
    if (!sig || sig.length !== DSA_SIG_LEN) return false;
    if (!pk || pk.length !== DSA_PK_LEN) return false;
    return ml_dsa65.verify(sig, canonicalBytes(p), pk);
  } catch {
    return false;
  }
}

/** Message the wallet signs (Ed25519) to bind the passport to its address. */
export const WALLET_MESSAGE = (p: Passport) =>
  `Dirac passport v1\nwallet: ${p.wallet}\nhash: ${passportHash(p)}`;

/**
 * Ed25519 verification of the wallet binding. `walletSig` is the base64
 * signature returned by `solana:signMessage` (a base58 encoding is accepted
 * too, since Solana tooling often emits that form).
 */
export function verifyWalletSig(p: Passport, walletSig: string): boolean {
  try {
    const pk = tryB58(p.wallet);
    if (!pk || pk.length !== ED25519_PK_LEN) return false;
    let sig = tryB64(walletSig);
    if (!sig || sig.length !== ED25519_SIG_LEN) sig = tryB58(walletSig);
    if (!sig || sig.length !== ED25519_SIG_LEN) return false;
    return ed25519.verify(sig, utf8(WALLET_MESSAGE(p)), pk);
  } catch {
    return false;
  }
}

/** Memo text of the anchoring transaction. */
export const ANCHOR_MEMO = (p: Passport) => `dirac:passport:v1:${passportHash(p)}`;

/* ------------------------------------------------------------------ */
/* Rotation                                                            */
/* ------------------------------------------------------------------ */

/**
 * Message the CURRENT passport's ML-DSA key signs to let a new passport
 * replace it in the registry. The wallet signature alone is not enough: after
 * Q-Day an Ed25519 signature can be forged, the ML-DSA key cannot.
 */
export const ROTATE_MESSAGE = (wallet: string, oldHash: string, newHash: string) =>
  `dirac:passport:rotate:v1:${wallet}:${oldHash}:${newHash}`;

/**
 * base64 ML-DSA-65 signature by `current`'s key over
 * `ROTATE_MESSAGE(wallet, passportHash(current), passportHash(next))`.
 * Throws unless `currentDsaSk` belongs to `current` and both passports name
 * the same wallet.
 */
export function signRotation(current: Passport, currentDsaSk: Uint8Array, next: Passport): string {
  if (current.wallet !== next.wallet) throw new Error("a rotation stays within one wallet");
  assertSecretMatches(current, currentDsaSk);
  const msg = ROTATE_MESSAGE(current.wallet, passportHash(current), passportHash(next));
  return b64.encode(ml_dsa65.sign(utf8(msg), currentDsaSk));
}

/** True when `rotationSig` is `current`'s ML-DSA-65 signature authorising `next`. */
export function verifyRotation(current: Passport, next: Passport, rotationSig: string): boolean {
  try {
    if (current.wallet !== next.wallet) return false;
    const sig = tryB64(rotationSig);
    const pk = tryB64(current.dsa_pk);
    if (!sig || sig.length !== DSA_SIG_LEN) return false;
    if (!pk || pk.length !== DSA_PK_LEN) return false;
    const msg = ROTATE_MESSAGE(current.wallet, passportHash(current), passportHash(next));
    return ml_dsa65.verify(sig, utf8(msg), pk);
  } catch {
    return false;
  }
}

/**
 * Human-readable key fingerprint: first 8 bytes (hex) of
 * sha256(kem_pk_bytes || dsa_pk_bytes), grouped as "ab12 cd34 ef56 7890".
 */
export function fingerprint(p: Passport): string {
  const kem = b64.decode(p.kem_pk);
  const dsa = b64.decode(p.dsa_pk);
  const hex = bytesToHex(sha256(concatBytes(kem, dsa)).subarray(0, 8));
  return hex.match(/.{4}/g)?.join(" ") ?? hex;
}

/* ------------------------------------------------------------------ */
/* Seals                                                               */
/* ------------------------------------------------------------------ */

/** hex sha256 of arbitrary bytes (document contents). */
export function hashBytes(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

/** Exact bytes the ML-DSA signature of a seal covers. */
export const SEAL_MESSAGE = (docHash: string, signedAt: number) =>
  `dirac:seal:v1:${docHash}:${signedAt}`;

export function createSeal(
  docHash: string,
  p: Passport,
  dsaSk: Uint8Array,
  opts?: { name?: string; anchorTx?: string; signedAt?: number },
): QSeal {
  const doc_hash = typeof docHash === "string" ? docHash.trim().toLowerCase() : "";
  if (!HEX_64.test(doc_hash)) throw new Error("docHash must be a hex sha256 digest (64 chars)");
  assertSecretMatches(p, dsaSk);
  const signed_at = opts?.signedAt ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(signed_at) || signed_at <= 0) {
    throw new RangeError("signedAt must be a positive integer (unix seconds)");
  }
  const signature = ml_dsa65.sign(utf8(SEAL_MESSAGE(doc_hash, signed_at)), dsaSk);
  const seal: QSeal = {
    v: 1,
    hash_alg: "sha256",
    doc_hash,
    passport: p.wallet,
    dsa_pk: p.dsa_pk,
    sig_alg: "ML-DSA-65",
    signature: b64.encode(signature),
    signed_at,
  };
  if (opts?.name !== undefined && opts.name !== "") seal.name = opts.name;
  if (opts?.anchorTx !== undefined && opts.anchorTx !== "") seal.anchor_tx = opts.anchorTx;
  return seal;
}

/**
 * Structural + cryptographic check of a seal using the public key it carries.
 * Whether that key belongs to a registered passport is a separate lookup.
 */
export function verifySeal(seal: QSeal): { ok: boolean; reason?: string } {
  try {
    if (!seal || typeof seal !== "object") return { ok: false, reason: "seal is not an object" };
    if (seal.v !== 1) return { ok: false, reason: `unsupported seal version: ${String(seal.v)}` };
    if (seal.hash_alg !== "sha256") {
      return { ok: false, reason: `unsupported hash algorithm: ${String(seal.hash_alg)}` };
    }
    if (seal.sig_alg !== "ML-DSA-65") {
      return { ok: false, reason: `unsupported signature algorithm: ${String(seal.sig_alg)}` };
    }
    if (typeof seal.doc_hash !== "string" || !HEX_64.test(seal.doc_hash)) {
      return { ok: false, reason: "doc_hash is not a hex sha256 digest" };
    }
    const wallet = tryB58(seal.passport);
    if (!wallet || wallet.length !== ED25519_PK_LEN) {
      return { ok: false, reason: "passport is not a valid Solana address" };
    }
    const pk = tryB64(seal.dsa_pk);
    if (!pk || pk.length !== DSA_PK_LEN) {
      return { ok: false, reason: "dsa_pk is not a valid ML-DSA-65 public key" };
    }
    const sig = tryB64(seal.signature);
    if (!sig || sig.length !== DSA_SIG_LEN) {
      return { ok: false, reason: "signature is not a valid ML-DSA-65 signature" };
    }
    if (!Number.isInteger(seal.signed_at) || seal.signed_at <= 0) {
      return { ok: false, reason: "signed_at is not a unix timestamp" };
    }
    if (seal.name !== undefined && typeof seal.name !== "string") {
      return { ok: false, reason: "name must be a string" };
    }
    if (seal.anchor_tx !== undefined && typeof seal.anchor_tx !== "string") {
      return { ok: false, reason: "anchor_tx must be a string" };
    }
    const msg = utf8(SEAL_MESSAGE(seal.doc_hash, seal.signed_at));
    if (!ml_dsa65.verify(sig, msg, pk)) {
      return { ok: false, reason: "signature does not verify: document or seal was modified" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "verification failed" };
  }
}

/** hex sha256 of the canonical JSON of the seal (sorted keys, no whitespace). */
export function sealId(seal: QSeal): string {
  return bytesToHex(sha256(utf8(canonicalJson(seal))));
}

/* ------------------------------------------------------------------ */
/* Seal identity (which passport version signed)                       */
/* ------------------------------------------------------------------ */

/** One registered version of a wallet's passport, as the history route lists it. */
export interface KeyVersion {
  version: number;
  /** base64 ML-DSA-65 public key of that version */
  dsa_pk: string;
  /** unix ms */
  registered_at: number;
  /** unix ms; null for the active version */
  superseded_at: number | null;
  /**
   * `passport.created_at` of that version (unix ms). Version 1's window starts here: its keys
   * did not exist before. Without it, version 1's window has no lower bound.
   */
  created_at?: number;
}

/** What a verifier knows about a seal beyond what the seal states. Times are unix ms. */
export interface SealEvidence {
  /** the verifier's clock: a seal cannot have been signed later than now */
  now?: number;
  /**
   * when the registry first received this exact seal (`GET /api/seals/:id` registered_at), or
   * null when it never did. The seal existed by then, whatever its signed_at says.
   */
  publishedAt?: number | null;
}

export type SealIdentity =
  /** the key of the version that was active at signed_at, and that version is still active */
  | { status: "verified"; version: number }
  /**
   * the key of a superseded version whose window contains signed_at. `proven`: the registry
   * received the seal before that version was replaced; otherwise only the signer's own
   * signed_at places it there, which whoever holds the retired key can choose.
   */
  | { status: "earlier"; version: number; rotatedAt: number; proven: boolean }
  /** the wallet has no passport: the seal proves only that someone holding the key signed */
  | { status: "unbound" }
  /** the key is not any version of the wallet's passport */
  | { status: "mismatch"; reason: "unknown-key" }
  /** signed_at is later than the verifier's clock or than the registry's receipt of the seal */
  | { status: "mismatch"; reason: "future"; version: number }
  /** the key is a version of the passport, but signed_at lies outside the time that version was active */
  | {
      status: "mismatch";
      reason: "outside-window";
      version: number;
      registeredAt: number;
      rotatedAt: number | null;
    };

/**
 * Tolerance around a version's window. signed_at comes from the signer's
 * clock, so a seal made just after a rotation on a slow clock still lands on
 * the right version.
 */
export const SEAL_CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * Which version of the wallet's passport, if any, the seal's key belongs to at
 * the seal's stated signing time. Pure: `versions` is the registry history
 * (any order, not mutated). The cryptographic check of the seal itself is
 * `verifySeal`; this only answers the identity question. Version 1's window
 * starts at its `created_at` (unbounded when that is not given); every later
 * one starts at its registration. `evidence` bounds signed_at from above (the
 * verifier's clock, the registry's receipt) and decides whether an earlier
 * key's seal is proven to predate the rotation.
 */
export function sealIdentity(
  seal: Pick<QSeal, "dsa_pk" | "signed_at">,
  versions: readonly KeyVersion[],
  evidence: SealEvidence = {},
): SealIdentity {
  if (versions.length === 0) return { status: "unbound" };
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const t = seal.signed_at * 1000;
  const firstStart = (v: KeyVersion) =>
    typeof v.created_at === "number" ? Math.min(v.created_at, v.registered_at) : -Infinity;
  const matches = sorted
    .map((v) => ({ v, start: v.version === 1 ? firstStart(v) : v.registered_at, end: v.superseded_at ?? Infinity }))
    .filter(({ v }) => v.dsa_pk === seal.dsa_pk);
  if (matches.length === 0) return { status: "mismatch", reason: "unknown-key" };

  const published = typeof evidence.publishedAt === "number" ? evidence.publishedAt : null;
  const bounds = [evidence.now, published].filter((x): x is number => typeof x === "number");
  if (bounds.length > 0 && t > Math.min(...bounds) + SEAL_CLOCK_SKEW_MS) {
    return { status: "mismatch", reason: "future", version: matches[matches.length - 1].v.version };
  }

  const inWindow = matches.filter(({ start, end }) => t >= start - SEAL_CLOCK_SKEW_MS && t < end + SEAL_CLOCK_SKEW_MS);
  const active = inWindow.find(({ v }) => v.superseded_at === null);
  if (active) return { status: "verified", version: active.v.version };
  const newest = inWindow[inWindow.length - 1];
  if (newest && newest.v.superseded_at !== null) {
    const rotatedAt = newest.v.superseded_at;
    return { status: "earlier", version: newest.v.version, rotatedAt, proven: published !== null && published <= rotatedAt };
  }
  const nearest = matches[matches.length - 1].v;
  return {
    status: "mismatch",
    reason: "outside-window",
    version: nearest.version,
    registeredAt: nearest.registered_at,
    rotatedAt: nearest.superseded_at,
  };
}

/* ------------------------------------------------------------------ */
/* Recovery file (hardened mode)                                       */
/* ------------------------------------------------------------------ */

function recoveryKey(password: string, salt: Uint8Array, t: number, m: number, p: number): Uint8Array {
  return argon2id(utf8(password), salt, { t, m, p, dkLen: RECOVERY_DK_LEN });
}

/**
 * Encrypts the 32-byte entropy with a password: Argon2id (t=3, m=65536 KiB,
 * p=1, 32-byte key) + XChaCha20-Poly1305 with a fresh 24-byte nonce.
 * All binary fields are base64.
 */
export function encryptRecovery(entropy32: Uint8Array, password: string, wallet: string): RecoveryFile {
  assertBytes(entropy32, ENTROPY_LEN, "entropy");
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  if (typeof wallet !== "string") throw new TypeError("wallet must be a string");
  const salt = randomBytes(RECOVERY_SALT_LEN);
  const nonce = randomBytes(RECOVERY_NONCE_LEN);
  const key = recoveryKey(password, salt, RECOVERY_T, RECOVERY_M, RECOVERY_P);
  const ct = xchacha20poly1305(key, nonce).encrypt(entropy32);
  key.fill(0);
  return {
    v: 1,
    kdf: "argon2id",
    t: RECOVERY_T,
    m: RECOVERY_M,
    p: RECOVERY_P,
    salt: b64.encode(salt),
    nonce: b64.encode(nonce),
    ct: b64.encode(ct),
    wallet,
  };
}

/** Returns the 32-byte entropy. Throws on a wrong password or a malformed file. */
export function decryptRecovery(file: RecoveryFile, password: string): Uint8Array {
  if (!file || typeof file !== "object") throw new Error("recovery file is not an object");
  if (file.v !== 1) throw new Error(`unsupported recovery file version: ${String(file.v)}`);
  if (file.kdf !== "argon2id") throw new Error(`unsupported KDF: ${String(file.kdf)}`);
  const { t, m, p } = file;
  // Bounds keep a crafted file from pinning the browser or exhausting memory.
  if (!Number.isInteger(t) || t < 1 || t > 16) throw new Error("unsupported KDF parameter t");
  if (!Number.isInteger(m) || m < 8 || m > 1 << 20) throw new Error("unsupported KDF parameter m");
  if (!Number.isInteger(p) || p < 1 || p > 8) throw new Error("unsupported KDF parameter p");
  if (typeof password !== "string") throw new TypeError("password must be a string");
  const salt = tryB64(file.salt);
  const nonce = tryB64(file.nonce);
  const ct = tryB64(file.ct);
  if (!salt || salt.length < 8) throw new Error("recovery file salt is malformed");
  if (!nonce || nonce.length !== RECOVERY_NONCE_LEN) throw new Error("recovery file nonce is malformed");
  if (!ct || ct.length !== ENTROPY_LEN + 16) throw new Error("recovery file ciphertext is malformed");
  const key = recoveryKey(password, salt, t, m, p);
  let entropy: Uint8Array;
  try {
    entropy = xchacha20poly1305(key, nonce).decrypt(ct);
  } catch {
    throw new Error("Wrong password or corrupted recovery file");
  } finally {
    key.fill(0);
  }
  if (entropy.length !== ENTROPY_LEN) throw new Error("recovery file does not contain 32-byte entropy");
  return entropy;
}

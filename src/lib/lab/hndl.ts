/**
 * "Harvest now, decrypt later": two real envelopes around the same text.
 *
 * Classical: X25519 (the Curve25519 behind every Ed25519 wallet key) with an
 * ephemeral key, HKDF-SHA256, XChaCha20-Poly1305. Shor's algorithm recovers
 * the recipient's 32-byte secret from the 32-byte public key, after which the
 * envelope opens like it does for the recipient.
 *
 * Post-quantum: ML-KEM-768 keygen, encapsulate, decapsulate from
 * @noble/post-quantum, then the same HKDF and AEAD. No known quantum shortcut.
 *
 * Both run for real in the browser; the timings and sizes are measured. Pure
 * module (no React, no DOM beyond TextEncoder/performance, no `@/` imports) so
 * the self-test can run it under node.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SALT = encoder.encode("dirac-lab-hndl-v1");
const INFO = encoder.encode("envelope");
const NONCE_LEN = 24;

export type EnvelopeAlg = "X25519+XChaCha20-Poly1305" | "ML-KEM-768+XChaCha20-Poly1305";

export interface SizeLine {
  label: string;
  bytes: number;
}

export interface TimingLine {
  label: string;
  ms: number;
}

export interface Sealed {
  alg: EnvelopeAlg;
  /** what Shor would need: the recipient's public key */
  publicKey: Uint8Array;
  /** the per-message header: ephemeral public key, or the KEM ciphertext */
  header: Uint8Array;
  nonce: Uint8Array;
  /** AEAD ciphertext with its 16-byte tag */
  ciphertext: Uint8Array;
  sizes: SizeLine[];
  timings: TimingLine[];
  /** the text the recipient's own decryption recovered, proving the round trip */
  recovered: string;
}

function aeadKey(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, SALT, INFO, 32);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** X25519 ephemeral-static envelope. */
export function sealClassical(text: string): Sealed {
  const t0 = now();
  const recipient = x25519.keygen();
  const t1 = now();
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, recipient.publicKey);
  const key = aeadKey(shared);
  const nonce = randomBytes(NONCE_LEN);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(encoder.encode(text));
  const t2 = now();
  const shared2 = x25519.getSharedSecret(recipient.secretKey, ephemeral.publicKey);
  const plain = xchacha20poly1305(aeadKey(shared2), nonce).decrypt(ciphertext);
  const t3 = now();
  return {
    alg: "X25519+XChaCha20-Poly1305",
    publicKey: recipient.publicKey,
    header: ephemeral.publicKey,
    nonce,
    ciphertext,
    sizes: [
      { label: "public key", bytes: recipient.publicKey.length },
      { label: "secret key", bytes: recipient.secretKey.length },
      { label: "ephemeral key", bytes: ephemeral.publicKey.length },
      { label: "shared secret", bytes: shared.length },
      { label: "ciphertext + tag", bytes: ciphertext.length },
    ],
    timings: [
      { label: "keygen", ms: t1 - t0 },
      { label: "agree + encrypt", ms: t2 - t1 },
      { label: "agree + decrypt", ms: t3 - t2 },
    ],
    recovered: decoder.decode(plain),
  };
}

/** ML-KEM-768 envelope: keygen, encapsulate, decapsulate, all for real. */
export function sealPostQuantum(text: string): Sealed {
  const t0 = now();
  const recipient = ml_kem768.keygen();
  const t1 = now();
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(recipient.publicKey);
  const key = aeadKey(sharedSecret);
  const nonce = randomBytes(NONCE_LEN);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(encoder.encode(text));
  const t2 = now();
  const shared2 = ml_kem768.decapsulate(cipherText, recipient.secretKey);
  const plain = xchacha20poly1305(aeadKey(shared2), nonce).decrypt(ciphertext);
  const t3 = now();
  return {
    alg: "ML-KEM-768+XChaCha20-Poly1305",
    publicKey: recipient.publicKey,
    header: cipherText,
    nonce,
    ciphertext,
    sizes: [
      { label: "public key", bytes: recipient.publicKey.length },
      { label: "secret key", bytes: recipient.secretKey.length },
      { label: "KEM ciphertext", bytes: cipherText.length },
      { label: "shared secret", bytes: sharedSecret.length },
      { label: "ciphertext + tag", bytes: ciphertext.length },
    ],
    timings: [
      { label: "keygen", ms: t1 - t0 },
      { label: "encapsulate + encrypt", ms: t2 - t1 },
      { label: "decapsulate + decrypt", ms: t3 - t2 },
    ],
    recovered: decoder.decode(plain),
  };
}

/** Hex of the first `max` bytes, grouped in pairs, with an ellipsis when cut. */
export function hexPreview(bytes: Uint8Array, max = 48): string {
  const hex = bytesToHex(bytes.subarray(0, max));
  const grouped = hex.match(/.{1,2}/g)?.join(" ") ?? hex;
  return bytes.length > max ? `${grouped} …` : grouped;
}

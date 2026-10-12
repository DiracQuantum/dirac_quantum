/**
 * Self-test for src/lib/inbox.ts. Run from the project root:
 *   node scripts/inbox-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

import {
  authHeader,
  b64,
  decryptLetter,
  encryptLetter,
  envelopeHash,
  isTxSignature,
  isWalletAddress,
  KEM_CT_LEN,
  MAX_CT_BYTES,
  MAX_TEXT_CHARS,
  NONCE_LEN,
  parseAuthHeader,
  parseEnvelope,
  READ_MESSAGE,
  readBucket,
  SEND_MESSAGE,
  utf8,
  verifyReadSig,
  verifySendSig,
  verifyWalletMessage,
  type Envelope,
  type Letter,
} from "../src/lib/inbox.ts";

let failed = 0;
let passed = 0;

function check(name: string, fn: () => boolean | void): void {
  const started = performance.now();
  try {
    const result = fn();
    const ms = (performance.now() - started).toFixed(0);
    if (result === false) {
      failed++;
      console.log(`FAIL  ${name}  (${ms} ms)`);
    } else {
      passed++;
      console.log(`PASS  ${name}  (${ms} ms)`);
    }
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL  ${name}  threw: ${msg}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const HEX_64 = /^[0-9a-f]{64}$/;

/* Recipient: an ML-KEM-768 pair as a passport would hold. Sender: a throwaway Ed25519 wallet. */
const recipient = ml_kem768.keygen();
const stranger = ml_kem768.keygen();
const senderKeys = ed25519.keygen();
const sender = base58.encode(senderKeys.publicKey);
const recipientWallet = base58.encode(ed25519.keygen().publicKey);

const letter: Letter = {
  v: 1,
  text: "Still selling 12k at 184.20? I can settle within two hours.",
  from: sender,
  sent_at: 1760102520000,
};

/* ------------------------------------------------------------------ */
/* Encrypt / decrypt                                                   */
/* ------------------------------------------------------------------ */

const envelope = encryptLetter(letter, recipient.publicKey);

check("encryptLetter: envelope shape, kem_ct 1088 B, nonce 24 B, ct = json + 16 B tag", () => {
  const ct = b64.decode(envelope.ct);
  const jsonLen = utf8(JSON.stringify(letter)).length;
  return (
    envelope.v === 1 &&
    envelope.alg === "ML-KEM-768+XChaCha20-Poly1305" &&
    b64.decode(envelope.kem_ct).length === KEM_CT_LEN &&
    b64.decode(envelope.nonce).length === NONCE_LEN &&
    ct.length === jsonLen + 16
  );
});

check("decryptLetter: round trip returns the letter", () => {
  const back = decryptLetter(envelope, recipient.secretKey);
  return (
    back.v === 1 && back.text === letter.text && back.from === letter.from && back.sent_at === letter.sent_at
  );
});

check("decryptLetter: wrong key fails", () => {
  return throws(() => decryptLetter(envelope, stranger.secretKey));
});

check("decryptLetter: tampered ct, nonce or kem_ct fails", () => {
  const ct = b64.decode(envelope.ct);
  ct[3] ^= 0x01;
  const nonce = b64.decode(envelope.nonce);
  nonce[0] ^= 0x01;
  const kemCt = b64.decode(envelope.kem_ct);
  kemCt[10] ^= 0x01;
  return (
    throws(() => decryptLetter({ ...envelope, ct: b64.encode(ct) }, recipient.secretKey)) &&
    throws(() => decryptLetter({ ...envelope, nonce: b64.encode(nonce) }, recipient.secretKey)) &&
    throws(() => decryptLetter({ ...envelope, kem_ct: b64.encode(kemCt) }, recipient.secretKey))
  );
});

check("encryptLetter: fresh encapsulation and nonce every call", () => {
  const again = encryptLetter(letter, recipient.publicKey);
  return again.kem_ct !== envelope.kem_ct && again.nonce !== envelope.nonce && again.ct !== envelope.ct;
});

check("encryptLetter: from null, unicode text, JSON round trip (as stored) still opens", () => {
  const unicode: Letter = { v: 1, text: "Привет, |ψ⟩ — 🙂 \"quotes\" \n newline", from: null, sent_at: 1 };
  const env = JSON.parse(JSON.stringify(encryptLetter(unicode, recipient.publicKey))) as Envelope;
  const back = decryptLetter(env, recipient.secretKey);
  return back.text === unicode.text && back.from === null && back.sent_at === 1;
});

check("encryptLetter: 4000 four-byte characters fit MAX_CT_BYTES; 4001 characters are refused", () => {
  const long: Letter = { v: 1, text: "🙂".repeat(MAX_TEXT_CHARS / 2), from: sender, sent_at: 1 };
  const env = encryptLetter(long, recipient.publicKey);
  const tooLong: Letter = { v: 1, text: "a".repeat(MAX_TEXT_CHARS + 1), from: sender, sent_at: 1 };
  return (
    b64.decode(env.ct).length <= MAX_CT_BYTES &&
    decryptLetter(env, recipient.secretKey).text === long.text &&
    throws(() => encryptLetter(tooLong, recipient.publicKey))
  );
});

check("encryptLetter: rejects a wrong-size recipient key and a malformed letter", () => {
  return (
    throws(() => encryptLetter(letter, new Uint8Array(32))) &&
    throws(() => encryptLetter({ ...letter, text: 5 as unknown as string }, recipient.publicKey))
  );
});

/* ------------------------------------------------------------------ */
/* Envelope hash and shape                                             */
/* ------------------------------------------------------------------ */

check("envelopeHash: 64 hex, stable, independent of key order, content-bound", () => {
  const h = envelopeHash(envelope);
  const reordered = { ct: envelope.ct, nonce: envelope.nonce, kem_ct: envelope.kem_ct, alg: envelope.alg, v: envelope.v };
  const parsed = JSON.parse(JSON.stringify(envelope)) as Envelope;
  const other = envelopeHash({ ...envelope, nonce: b64.encode(new Uint8Array(NONCE_LEN)) });
  return (
    HEX_64.test(h) &&
    h === envelopeHash(envelope) &&
    h === envelopeHash(reordered as Envelope) &&
    h === envelopeHash(parsed) &&
    h !== other
  );
});

check("parseEnvelope: accepts a real envelope, rejects extra fields, bad lengths, wrong alg", () => {
  const ok = parseEnvelope(JSON.parse(JSON.stringify(envelope)));
  const extra = parseEnvelope({ ...envelope, note: "hi" });
  const shortCt = parseEnvelope({ ...envelope, kem_ct: b64.encode(new Uint8Array(1087)) });
  const shortNonce = parseEnvelope({ ...envelope, nonce: b64.encode(new Uint8Array(12)) });
  const emptyCt = parseEnvelope({ ...envelope, ct: b64.encode(new Uint8Array(16)) });
  const hugeCt = parseEnvelope({ ...envelope, ct: b64.encode(new Uint8Array(MAX_CT_BYTES + 1)) });
  const badAlg = parseEnvelope({ ...envelope, alg: "RSA" });
  const badVersion = parseEnvelope({ ...envelope, v: 2 });
  const notObject = parseEnvelope("envelope");
  return (
    ok.ok === true &&
    envelopeHash(ok.ok ? ok.value : envelope) === envelopeHash(envelope) &&
    [extra, shortCt, shortNonce, emptyCt, hugeCt, badAlg, badVersion, notObject].every(
      (r) => r.ok === false && typeof r.error === "string" && r.error.length > 0,
    )
  );
});

/* ------------------------------------------------------------------ */
/* Signed messages                                                     */
/* ------------------------------------------------------------------ */

check("SEND_MESSAGE / READ_MESSAGE formats", () => {
  return (
    SEND_MESSAGE("W", "H") === "dirac:inbox:send:v1:W:H" &&
    READ_MESSAGE("W", 42) === "dirac:inbox:read:v1:W:42"
  );
});

check("readBucket: one-minute buckets", () => {
  return readBucket(0) === 0 && readBucket(59_999) === 0 && readBucket(60_000) === 1 && readBucket() > 29_000_000;
});

const sendSig = b64.encode(ed25519.sign(utf8(SEND_MESSAGE(recipientWallet, envelopeHash(envelope))), senderKeys.secretKey));

check("verifySendSig: the sender's signature over SEND_MESSAGE(to, hash) verifies (base64 and base58)", () => {
  const b58 = base58.encode(b64.decode(sendSig));
  return (
    verifySendSig(recipientWallet, envelope, sender, sendSig) === true &&
    verifySendSig(recipientWallet, envelope, sender, b58) === true
  );
});

check("verifySendSig: other recipient, other sender, modified envelope, garbage fail", () => {
  const otherWallet = base58.encode(ed25519.keygen().publicKey);
  const modified: Envelope = { ...envelope, ct: b64.encode(new Uint8Array(40)) };
  return (
    verifySendSig(otherWallet, envelope, sender, sendSig) === false &&
    verifySendSig(recipientWallet, envelope, otherWallet, sendSig) === false &&
    verifySendSig(recipientWallet, modified, sender, sendSig) === false &&
    verifySendSig(recipientWallet, envelope, sender, "zzz") === false &&
    verifySendSig(recipientWallet, envelope, "not-a-wallet", sendSig) === false
  );
});

const ownerKeys = ed25519.keygen();
const owner = base58.encode(ownerKeys.publicKey);
const now = 1760102520000;
const bucket = readBucket(now);
const readSig = b64.encode(ed25519.sign(utf8(READ_MESSAGE(owner, bucket)), ownerKeys.secretKey));

check("verifyReadSig: valid within two minutes either way, stale beyond", () => {
  return (
    verifyReadSig(owner, bucket, readSig, now) === true &&
    verifyReadSig(owner, bucket, readSig, now + 2 * 60_000) === true &&
    verifyReadSig(owner, bucket, readSig, now - 2 * 60_000) === true &&
    verifyReadSig(owner, bucket, readSig, now + 3 * 60_000) === false &&
    verifyReadSig(owner, bucket, readSig, now - 3 * 60_000) === false
  );
});

check("verifyReadSig: wrong wallet, wrong bucket, garbage fail", () => {
  return (
    verifyReadSig(sender, bucket, readSig, now) === false &&
    verifyReadSig(owner, bucket + 1, readSig, now) === false &&
    verifyReadSig(owner, bucket, "AAAA", now) === false &&
    verifyReadSig(owner, -1, readSig, now) === false
  );
});

check("authHeader / parseAuthHeader round trip, malformed headers rejected", () => {
  const header = authHeader(owner, bucket, readSig);
  const parsed = parseAuthHeader(header);
  return (
    header === `Dirac ${owner}:${bucket}:${readSig}` &&
    parsed !== null &&
    parsed.wallet === owner &&
    parsed.bucket === bucket &&
    parsed.sig === readSig &&
    parseAuthHeader(null) === null &&
    parseAuthHeader("Bearer x") === null &&
    parseAuthHeader(`Dirac ${owner}:${bucket}`) === null &&
    parseAuthHeader(`Dirac ${owner}:abc:${readSig}`) === null
  );
});

check("verifyWalletMessage: plain Ed25519 check over a utf8 message", () => {
  const sig = b64.encode(ed25519.sign(utf8("hello"), ownerKeys.secretKey));
  return verifyWalletMessage(owner, "hello", sig) === true && verifyWalletMessage(owner, "hellO", sig) === false;
});

/* ------------------------------------------------------------------ */
/* Address helpers                                                     */
/* ------------------------------------------------------------------ */

check("isWalletAddress / isTxSignature", () => {
  const tx = base58.encode(new Uint8Array(64).fill(7));
  return (
    isWalletAddress(owner) === true &&
    isWalletAddress("0OIl") === false &&
    isWalletAddress(tx) === false &&
    isWalletAddress(42) === false &&
    isTxSignature(tx) === true &&
    isTxSignature(owner) === false &&
    isTxSignature("") === false
  );
});

/* ------------------------------------------------------------------ */
/* End-to-end: what the browser does, what the Worker checks           */
/* ------------------------------------------------------------------ */

check("end-to-end: encrypt → hash → sign → verify (server) → decrypt (recipient)", () => {
  const note: Letter = { v: 1, text: "Draft proposal attached. Please seal it before we post.", from: sender, sent_at: now };
  const env = encryptLetter(note, recipient.publicKey);
  const sig = b64.encode(ed25519.sign(utf8(SEND_MESSAGE(recipientWallet, envelopeHash(env))), senderKeys.secretKey));
  const stored = JSON.parse(JSON.stringify(env)) as Envelope;
  const serverOk = verifySendSig(recipientWallet, stored, sender, sig);
  const opened = decryptLetter(stored, recipient.secretKey);
  return serverOk && opened.text === note.text && throws(() => decryptLetter(stored, stranger.secretKey));
});

/* ------------------------------------------------------------------ */

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Self-test for src/lib/pq.ts. Run from the project root:
 *   node scripts/pq-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { base58 } from "@scure/base";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

import {
  ANCHOR_MEMO,
  b64,
  buildPassport,
  canonicalBytes,
  createSeal,
  decryptRecovery,
  encryptRecovery,
  entropyToPhrase,
  fingerprint,
  hashBytes,
  KEY_DERIVATION_MESSAGE,
  keysFromSeeds,
  newEntropy,
  passportHash,
  phraseToEntropy,
  ROTATE_MESSAGE,
  SEAL_CLOCK_SKEW_MS,
  SEAL_MESSAGE,
  sealId,
  sealIdentity,
  seedsFromEntropy,
  seedsFromSignature,
  selfSign,
  signRotation,
  utf8,
  verifyRotation,
  verifySeal,
  verifySelf,
  verifyWalletSig,
  WALLET_MESSAGE,
  type KeyVersion,
  type Passport,
  type QSeal,
} from "../src/lib/pq.ts";

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

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/* Throwaway Ed25519 wallet standing in for a Solana wallet. */
const walletKeys = ed25519.keygen();
const wallet = base58.encode(walletKeys.publicKey);

/* ------------------------------------------------------------------ */
/* Library parameter sanity                                            */
/* ------------------------------------------------------------------ */

check("library: ML-KEM-768 / ML-DSA-65 parameter lengths match the contract", () => {
  return (
    ml_kem768.lengths.publicKey === 1184 &&
    ml_kem768.lengths.seed === 64 &&
    ml_dsa65.lengths.publicKey === 1952 &&
    ml_dsa65.lengths.seed === 32 &&
    ml_dsa65.lengths.signature === 3309
  );
});

/* ------------------------------------------------------------------ */
/* Seeds                                                               */
/* ------------------------------------------------------------------ */

const derivationSig = ed25519.sign(utf8(KEY_DERIVATION_MESSAGE(wallet)), walletKeys.secretKey);

check("seedsFromSignature: 64-byte KEM seed, 32-byte DSA seed, deterministic", () => {
  const a = seedsFromSignature(derivationSig);
  const b = seedsFromSignature(derivationSig);
  return (
    a.kemSeed.length === 64 &&
    a.dsaSeed.length === 32 &&
    same(a.kemSeed, b.kemSeed) &&
    same(a.dsaSeed, b.dsaSeed) &&
    !same(a.kemSeed.subarray(0, 32), a.dsaSeed)
  );
});

check("seedsFromSignature: different signatures give different seeds", () => {
  const other = ed25519.sign(utf8("something else"), walletKeys.secretKey);
  const a = seedsFromSignature(derivationSig);
  const b = seedsFromSignature(other);
  return !same(a.kemSeed, b.kemSeed) && !same(a.dsaSeed, b.dsaSeed);
});

const entropy = newEntropy();

check("newEntropy: 32 bytes, not all zero, fresh each call", () => {
  const again = newEntropy();
  return entropy.length === 32 && entropy.some((x) => x !== 0) && !same(entropy, again);
});

check("seedsFromEntropy: correct lengths, deterministic, rejects wrong length", () => {
  const a = seedsFromEntropy(entropy);
  const b = seedsFromEntropy(entropy);
  return (
    a.kemSeed.length === 64 &&
    a.dsaSeed.length === 32 &&
    same(a.kemSeed, b.kemSeed) &&
    same(a.dsaSeed, b.dsaSeed) &&
    throws(() => seedsFromEntropy(new Uint8Array(16)))
  );
});

/* ------------------------------------------------------------------ */
/* BIP39 phrase                                                        */
/* ------------------------------------------------------------------ */

check("entropyToPhrase / phraseToEntropy: 24 words, round trip", () => {
  const phrase = entropyToPhrase(entropy);
  const words = phrase.split(" ");
  const back = phraseToEntropy(phrase);
  return words.length === 24 && same(back, entropy);
});

check("phraseToEntropy: tolerates extra whitespace and capitals", () => {
  const phrase = entropyToPhrase(entropy);
  const messy = `  ${phrase.toUpperCase().replace(/ /g, "   ")}\n`;
  return same(phraseToEntropy(messy), entropy);
});

check("phraseToEntropy: rejects bad checksum, unknown word, 12-word phrase", () => {
  const phrase = entropyToPhrase(entropy);
  const words = phrase.split(" ");
  const swapped = [...words];
  swapped[0] = words[0] === "abandon" ? "ability" : "abandon";
  const unknown = [...words];
  unknown[3] = "notaword";
  const twelve = generateMnemonic(wordlist, 128);
  return (
    throws(() => phraseToEntropy(swapped.join(" "))) &&
    throws(() => phraseToEntropy(unknown.join(" "))) &&
    throws(() => phraseToEntropy(twelve)) &&
    throws(() => phraseToEntropy(""))
  );
});

/* ------------------------------------------------------------------ */
/* Keys and passport                                                   */
/* ------------------------------------------------------------------ */

const seeds = seedsFromEntropy(entropy);
const keys = keysFromSeeds(seeds);

check("keysFromSeeds: key lengths (kem pk 1184, dsa pk 1952), deterministic", () => {
  const again = keysFromSeeds(seeds);
  return (
    keys.kemPk.length === 1184 &&
    keys.dsaPk.length === 1952 &&
    keys.kemSk.length > 0 &&
    keys.dsaSk.length > 0 &&
    same(keys.kemPk, again.kemPk) &&
    same(keys.dsaPk, again.dsaPk) &&
    same(keys.kemSk, again.kemSk) &&
    same(keys.dsaSk, again.dsaSk)
  );
});

check("keysFromSeeds: KEM encapsulate / decapsulate round trip", () => {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(keys.kemPk);
  const recovered = ml_kem768.decapsulate(cipherText, keys.kemSk);
  return cipherText.length === 1088 && same(sharedSecret, recovered);
});

const createdAt = 1760102520000;
const passport = buildPassport(wallet, keys, "hardened", createdAt);

check("buildPassport: fields, base64 keys, default created_at", () => {
  const fresh = buildPassport(wallet, keys, "simple");
  return (
    passport.v === 1 &&
    passport.wallet === wallet &&
    passport.mode === "hardened" &&
    passport.created_at === createdAt &&
    same(b64.decode(passport.kem_pk), keys.kemPk) &&
    same(b64.decode(passport.dsa_pk), keys.dsaPk) &&
    fresh.mode === "simple" &&
    Number.isInteger(fresh.created_at) &&
    fresh.created_at > 1_700_000_000_000
  );
});

check("buildPassport: rejects a non-Solana wallet string", () => {
  return throws(() => buildPassport("not-a-wallet-0OIl", keys, "simple"));
});

check("canonicalBytes: sorted keys, no whitespace, stable", () => {
  const text = new TextDecoder().decode(canonicalBytes(passport));
  const parsed = JSON.parse(text) as Passport;
  const expectedPrefix = `{"created_at":${createdAt},"dsa_pk":"`;
  const reordered: Passport = {
    mode: passport.mode,
    created_at: passport.created_at,
    dsa_pk: passport.dsa_pk,
    wallet: passport.wallet,
    v: 1,
    kem_pk: passport.kem_pk,
  };
  return (
    text.startsWith(expectedPrefix) &&
    !/\s/.test(text) &&
    text.endsWith(`"wallet":"${wallet}"}`) &&
    parsed.kem_pk === passport.kem_pk &&
    same(canonicalBytes(reordered), canonicalBytes(passport))
  );
});

check("passportHash: 64 hex chars, deterministic, changes with content", () => {
  const h = passportHash(passport);
  const other = passportHash({ ...passport, mode: "simple" });
  return HEX_64.test(h) && h === passportHash(passport) && h !== other;
});

/* ------------------------------------------------------------------ */
/* Self-signature                                                      */
/* ------------------------------------------------------------------ */

const selfSig = selfSign(passport, keys.dsaSk);

check("selfSign / verifySelf: 3309-byte signature verifies", () => {
  return b64.decode(selfSig).length === 3309 && verifySelf(passport, selfSig) === true;
});

check("verifySelf: tampered passport, garbage or wrong signature fails", () => {
  const tampered: Passport = { ...passport, mode: "simple" };
  const otherKeys = keysFromSeeds(seedsFromEntropy(newEntropy()));
  const otherPassport = buildPassport(wallet, otherKeys, "hardened", createdAt);
  const otherSig = selfSign(otherPassport, otherKeys.dsaSk);
  return (
    verifySelf(tampered, selfSig) === false &&
    verifySelf(passport, "not base64!!") === false &&
    verifySelf(passport, b64.encode(new Uint8Array(3309))) === false &&
    verifySelf(passport, otherSig) === false
  );
});

check("selfSign: refuses a secret key that does not match the passport", () => {
  const otherKeys = keysFromSeeds(seedsFromEntropy(newEntropy()));
  return throws(() => selfSign(passport, otherKeys.dsaSk));
});

/* ------------------------------------------------------------------ */
/* Fingerprint and memo                                                */
/* ------------------------------------------------------------------ */

check('fingerprint: "ab12 cd34 ef56 7890" format, deterministic, key-dependent', () => {
  const fp = fingerprint(passport);
  const otherKeys = keysFromSeeds(seedsFromEntropy(newEntropy()));
  const other = fingerprint(buildPassport(wallet, otherKeys, "hardened", createdAt));
  return /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/.test(fp) && fp === fingerprint(passport) && fp !== other;
});

check("ANCHOR_MEMO: dirac:passport:v1:<hash>", () => {
  return ANCHOR_MEMO(passport) === `dirac:passport:v1:${passportHash(passport)}`;
});

/* ------------------------------------------------------------------ */
/* Wallet binding (Ed25519)                                            */
/* ------------------------------------------------------------------ */

check("WALLET_MESSAGE: contains wallet and passport hash", () => {
  const msg = WALLET_MESSAGE(passport);
  return (
    msg === `Dirac passport v1\nwallet: ${wallet}\nhash: ${passportHash(passport)}`
  );
});

const walletSig = ed25519.sign(utf8(WALLET_MESSAGE(passport)), walletKeys.secretKey);

check("verifyWalletSig: base64 Ed25519 signature over WALLET_MESSAGE verifies", () => {
  return verifyWalletSig(passport, b64.encode(walletSig)) === true;
});

check("verifyWalletSig: base58-encoded signature is accepted too", () => {
  return verifyWalletSig(passport, base58.encode(walletSig)) === true;
});

check("verifyWalletSig: wrong key, tampered passport, garbage fails", () => {
  const stranger = ed25519.keygen();
  const strangerSig = ed25519.sign(utf8(WALLET_MESSAGE(passport)), stranger.secretKey);
  const tampered: Passport = { ...passport, created_at: createdAt + 1 };
  return (
    verifyWalletSig(passport, b64.encode(strangerSig)) === false &&
    verifyWalletSig(tampered, b64.encode(walletSig)) === false &&
    verifyWalletSig(passport, "zzz") === false &&
    verifyWalletSig(passport, "") === false &&
    verifyWalletSig({ ...passport, wallet: "bad" }, b64.encode(walletSig)) === false
  );
});

/* ------------------------------------------------------------------ */
/* Seals                                                               */
/* ------------------------------------------------------------------ */

const document = utf8("The quick brown fox signs a post-quantum seal.");
const docHash = hashBytes(document);

check("hashBytes: hex sha256 (known vector for empty input)", () => {
  return (
    HEX_64.test(docHash) &&
    hashBytes(new Uint8Array(0)) ===
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

const signedAt = 1760102600;
const seal = createSeal(docHash, passport, keys.dsaSk, { name: "fox.txt", signedAt });

check("createSeal: fields and SEAL_MESSAGE", () => {
  return (
    seal.v === 1 &&
    seal.hash_alg === "sha256" &&
    seal.sig_alg === "ML-DSA-65" &&
    seal.doc_hash === docHash &&
    seal.passport === wallet &&
    seal.dsa_pk === passport.dsa_pk &&
    seal.signed_at === signedAt &&
    seal.name === "fox.txt" &&
    seal.anchor_tx === undefined &&
    b64.decode(seal.signature).length === 3309 &&
    SEAL_MESSAGE(docHash, signedAt) === `dirac:seal:v1:${docHash}:${signedAt}`
  );
});

check("createSeal: omits empty optional fields, defaults signed_at to now", () => {
  const s = createSeal(docHash.toUpperCase(), passport, keys.dsaSk);
  const now = Math.floor(Date.now() / 1000);
  return (
    !("name" in s) &&
    !("anchor_tx" in s) &&
    s.doc_hash === docHash &&
    Math.abs(s.signed_at - now) <= 5 &&
    throws(() => createSeal("nothex", passport, keys.dsaSk))
  );
});

check("verifySeal: valid seal verifies", () => {
  const r = verifySeal(seal);
  return r.ok === true && r.reason === undefined;
});

check("verifySeal: tampered doc_hash fails", () => {
  const tampered: QSeal = { ...seal, doc_hash: hashBytes(utf8("different document")) };
  const r = verifySeal(tampered);
  return r.ok === false && typeof r.reason === "string";
});

check("verifySeal: tampered signed_at, dsa_pk, signature fail", () => {
  const otherKeys = keysFromSeeds(seedsFromEntropy(newEntropy()));
  const a = verifySeal({ ...seal, signed_at: signedAt + 1 });
  const b = verifySeal({ ...seal, dsa_pk: b64.encode(otherKeys.dsaPk) });
  const c = verifySeal({ ...seal, signature: b64.encode(new Uint8Array(3309)) });
  return a.ok === false && b.ok === false && c.ok === false;
});

check("verifySeal: structural problems reported with a reason", () => {
  const badAlg = verifySeal({ ...seal, sig_alg: "RSA" as QSeal["sig_alg"] });
  const badHash = verifySeal({ ...seal, hash_alg: "md5" as QSeal["hash_alg"] });
  const badVersion = verifySeal({ ...seal, v: 2 as QSeal["v"] });
  const badWallet = verifySeal({ ...seal, passport: "0OIl" });
  const badPk = verifySeal({ ...seal, dsa_pk: "AAAA" });
  const badTime = verifySeal({ ...seal, signed_at: -1 });
  return [badAlg, badHash, badVersion, badWallet, badPk, badTime].every(
    (r) => r.ok === false && typeof r.reason === "string" && r.reason.length > 0,
  );
});

check("sealId: 64 hex, deterministic, independent of key order, content-bound", () => {
  const id = sealId(seal);
  const reordered = JSON.parse(JSON.stringify(seal, Object.keys(seal).sort().reverse())) as QSeal;
  const renamed: QSeal = { ...seal, name: "other.txt" };
  return (
    HEX_64.test(id) &&
    id === sealId(seal) &&
    id === sealId(reordered) &&
    id !== sealId(renamed)
  );
});

check("seal: JSON round trip (as a .qseal file would be) still verifies", () => {
  const parsed = JSON.parse(JSON.stringify(seal, null, 2)) as QSeal;
  return verifySeal(parsed).ok === true && sealId(parsed) === sealId(seal);
});

/* ------------------------------------------------------------------ */
/* Rotation                                                            */
/* ------------------------------------------------------------------ */

const nextKeys = keysFromSeeds(seedsFromEntropy(newEntropy()));
const nextPassport = buildPassport(wallet, nextKeys, "hardened", createdAt + 60_000);

check("ROTATE_MESSAGE: dirac:passport:rotate:v1:<wallet>:<old>:<new>", () => {
  return (
    ROTATE_MESSAGE(wallet, "aa", "bb") === `dirac:passport:rotate:v1:${wallet}:aa:bb` &&
    ROTATE_MESSAGE(wallet, passportHash(passport), passportHash(nextPassport)).endsWith(
      `:${passportHash(passport)}:${passportHash(nextPassport)}`,
    )
  );
});

const rotationSig = signRotation(passport, keys.dsaSk, nextPassport);

check("signRotation / verifyRotation: the current key authorises the next passport", () => {
  return b64.decode(rotationSig).length === 3309 && verifyRotation(passport, nextPassport, rotationSig) === true;
});

check("verifyRotation: covers exactly (wallet, old hash, new hash)", () => {
  const otherNext = buildPassport(wallet, nextKeys, "hardened", createdAt + 120_000);
  return (
    verifyRotation(passport, otherNext, rotationSig) === false &&
    verifyRotation(nextPassport, passport, rotationSig) === false &&
    verifyRotation({ ...passport, created_at: createdAt + 1 }, nextPassport, rotationSig) === false
  );
});

check("verifyRotation: a signature by any key but the current one fails (the next key, a stranger)", () => {
  // The new passport's own key signing its own rotation is exactly what a wallet-key thief could do.
  const selfAuthorised = b64.encode(
    ml_dsa65.sign(utf8(ROTATE_MESSAGE(wallet, passportHash(passport), passportHash(nextPassport))), nextKeys.dsaSk),
  );
  const stranger = keysFromSeeds(seedsFromEntropy(newEntropy()));
  const strangerSig = b64.encode(
    ml_dsa65.sign(utf8(ROTATE_MESSAGE(wallet, passportHash(passport), passportHash(nextPassport))), stranger.dsaSk),
  );
  return (
    verifyRotation(passport, nextPassport, selfAuthorised) === false &&
    verifyRotation(passport, nextPassport, strangerSig) === false &&
    verifyRotation(passport, nextPassport, "") === false &&
    verifyRotation(passport, nextPassport, b64.encode(new Uint8Array(3309))) === false
  );
});

check("signRotation: refuses a key that is not the current passport's, and a different wallet", () => {
  const otherWallet = base58.encode(ed25519.keygen().publicKey);
  const elsewhere = buildPassport(otherWallet, nextKeys, "hardened", createdAt);
  return (
    throws(() => signRotation(passport, nextKeys.dsaSk, nextPassport)) &&
    throws(() => signRotation(passport, keys.dsaSk, elsewhere)) &&
    verifyRotation(passport, elsewhere, rotationSig) === false
  );
});

/* ------------------------------------------------------------------ */
/* Seal identity (registry history)                                    */
/* ------------------------------------------------------------------ */

{
  const t0 = 1_760_000_000_000; // v1 registered (unix ms)
  const t1 = t0 + 86_400_000; // rotated to v2 a day later
  const v1: KeyVersion = { version: 1, dsa_pk: passport.dsa_pk, registered_at: t0, superseded_at: t1 };
  const v2: KeyVersion = { version: 2, dsa_pk: nextPassport.dsa_pk, registered_at: t1, superseded_at: null };
  const history: readonly KeyVersion[] = [v2, v1]; // newest first, as the route returns it
  const at = (ms: number) => Math.floor(ms / 1000);
  const strangerPk = b64.encode(keysFromSeeds(seedsFromEntropy(newEntropy())).dsaPk);
  const hour = 3_600_000;

  check("sealIdentity: no passport for the wallet is unbound", () => {
    return sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t0) }, []).status === "unbound";
  });

  check("sealIdentity: the active key at signing time is verified", () => {
    const only = sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t0 + hour) }, [{ ...v1, superseded_at: null }]);
    const after = sealIdentity({ dsa_pk: nextPassport.dsa_pk, signed_at: at(t1 + hour) }, history);
    return only.status === "verified" && only.version === 1 && after.status === "verified" && after.version === 2;
  });

  check("sealIdentity: the old key before the rotation is 'earlier', with the rotation time", () => {
    const r = sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t0 + hour) }, history);
    const beforeRegistration = sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t0 - hour) }, history);
    return (
      r.status === "earlier" &&
      r.version === 1 &&
      r.rotatedAt === t1 &&
      // version 1 has no lower bound: a seal made before registering still belongs to it
      beforeRegistration.status === "earlier"
    );
  });

  check("sealIdentity: a key that is no version of the passport is a mismatch", () => {
    const r = sealIdentity({ dsa_pk: strangerPk, signed_at: at(t1 + hour) }, history);
    return r.status === "mismatch" && r.reason === "unknown-key";
  });

  check("sealIdentity: a passport key outside its window is a mismatch, within the clock skew it is not", () => {
    const retired = sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t1 + hour) }, history);
    const early = sealIdentity({ dsa_pk: nextPassport.dsa_pk, signed_at: at(t1 - hour) }, history);
    const skewOld = sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t1 + SEAL_CLOCK_SKEW_MS / 2) }, history);
    const skewNew = sealIdentity({ dsa_pk: nextPassport.dsa_pk, signed_at: at(t1 - SEAL_CLOCK_SKEW_MS / 2) }, history);
    return (
      retired.status === "mismatch" &&
      retired.reason === "outside-window" &&
      retired.version === 1 &&
      retired.rotatedAt === t1 &&
      early.status === "mismatch" &&
      early.reason === "outside-window" &&
      early.version === 2 &&
      skewOld.status === "earlier" &&
      skewNew.status === "verified"
    );
  });

  check("sealIdentity: does not reorder the caller's array", () => {
    const list = [v2, v1];
    sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t0) }, list);
    return list[0] === v2 && list[1] === v1;
  });

  check("sealIdentity: version 1's window starts at its created_at (keys did not exist before)", () => {
    const created = { ...v1, created_at: t0 - 10 * 60_000 };
    const withCreated: readonly KeyVersion[] = [v2, created];
    const before = sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t0 - hour) }, withCreated);
    const year2020 = sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: 1_577_836_800 }, [{ ...created, superseded_at: null }]);
    const justAfter = sealIdentity({ dsa_pk: passport.dsa_pk, signed_at: at(t0 - 5 * 60_000) }, withCreated);
    return (
      before.status === "mismatch" &&
      before.reason === "outside-window" &&
      year2020.status === "mismatch" &&
      year2020.reason === "outside-window" &&
      justAfter.status === "earlier"
    );
  });

  check("sealIdentity: a history without version 1 gives its oldest listed version no open start", () => {
    const v3: KeyVersion = { version: 3, dsa_pk: strangerPk, registered_at: t1 + hour, superseded_at: null };
    const truncated: readonly KeyVersion[] = [v3, { ...v2, superseded_at: t1 + hour }];
    const r = sealIdentity({ dsa_pk: nextPassport.dsa_pk, signed_at: at(t0) }, truncated);
    return r.status === "mismatch" && r.reason === "outside-window" && r.version === 2;
  });

  check("sealIdentity: a signing time after the verifier's clock or the registry's receipt is a mismatch", () => {
    const now = t1 + 2 * hour;
    const future = sealIdentity({ dsa_pk: nextPassport.dsa_pk, signed_at: at(now + hour) }, history, { now });
    const skew = sealIdentity({ dsa_pk: nextPassport.dsa_pk, signed_at: at(now + SEAL_CLOCK_SKEW_MS / 2) }, history, { now });
    const afterReceipt = sealIdentity(
      { dsa_pk: nextPassport.dsa_pk, signed_at: at(t1 + 2 * hour) },
      history,
      { now: t1 + 30 * 24 * hour, publishedAt: t1 + hour },
    );
    const noEvidence = sealIdentity({ dsa_pk: nextPassport.dsa_pk, signed_at: at(now + 365 * 24 * hour) }, history);
    return (
      future.status === "mismatch" &&
      future.reason === "future" &&
      future.version === 2 &&
      skew.status === "verified" &&
      afterReceipt.status === "mismatch" &&
      afterReceipt.reason === "future" &&
      noEvidence.status === "verified"
    );
  });

  check("sealIdentity: an earlier key is proven only when the registry received the seal before the rotation", () => {
    const seal = { dsa_pk: passport.dsa_pk, signed_at: at(t0 + hour) };
    const none = sealIdentity(seal, history, { now: t1 + hour });
    const unpublished = sealIdentity(seal, history, { now: t1 + hour, publishedAt: null });
    const before = sealIdentity(seal, history, { now: t1 + hour, publishedAt: t1 - 1 });
    const after = sealIdentity(seal, history, { now: t1 + hour, publishedAt: t1 + 1 });
    return (
      none.status === "earlier" &&
      !none.proven &&
      unpublished.status === "earlier" &&
      !unpublished.proven &&
      before.status === "earlier" &&
      before.proven &&
      after.status === "earlier" &&
      !after.proven
    );
  });
}

/* ------------------------------------------------------------------ */
/* Recovery file                                                       */
/* ------------------------------------------------------------------ */

const password = "correct horse battery staple";
const recovery = encryptRecovery(entropy, password, wallet);

check("encryptRecovery: argon2id params, base64 salt 16 / nonce 24 / ct 48", () => {
  return (
    recovery.v === 1 &&
    recovery.kdf === "argon2id" &&
    recovery.t === 3 &&
    recovery.m === 65536 &&
    recovery.p === 1 &&
    recovery.wallet === wallet &&
    b64.decode(recovery.salt).length === 16 &&
    b64.decode(recovery.nonce).length === 24 &&
    b64.decode(recovery.ct).length === 48
  );
});

check("decryptRecovery: round trip returns the entropy", () => {
  return same(decryptRecovery(recovery, password), entropy);
});

check("decryptRecovery: wrong password throws", () => {
  return throws(() => decryptRecovery(recovery, "wrong password"));
});

check("decryptRecovery: corrupted ciphertext / bad params throw", () => {
  const ct = b64.decode(recovery.ct);
  ct[0] ^= 0x01;
  const corrupted = { ...recovery, ct: b64.encode(ct) };
  const hugeMem = { ...recovery, m: 1 << 30 };
  const badKdf = { ...recovery, kdf: "scrypt" as typeof recovery.kdf };
  return (
    throws(() => decryptRecovery(corrupted, password)) &&
    throws(() => decryptRecovery(hugeMem, password)) &&
    throws(() => decryptRecovery(badKdf, password))
  );
});

check("encryptRecovery: fresh salt and nonce every time", () => {
  const again = encryptRecovery(entropy, password, wallet);
  return again.salt !== recovery.salt && again.nonce !== recovery.nonce && again.ct !== recovery.ct;
});

/* ------------------------------------------------------------------ */
/* End-to-end: simple mode from a wallet signature                     */
/* ------------------------------------------------------------------ */

check("end-to-end simple mode: signature → seeds → keys → passport → self + wallet sig", () => {
  const s = seedsFromSignature(derivationSig);
  const k = keysFromSeeds(s);
  const p = buildPassport(wallet, k, "simple");
  const self = selfSign(p, k.dsaSk);
  const wsig = ed25519.sign(utf8(WALLET_MESSAGE(p)), walletKeys.secretKey);
  const sealed = createSeal(hashBytes(document), p, k.dsaSk);
  // Re-deriving from the same signature must yield the same fingerprint.
  const again = buildPassport(wallet, keysFromSeeds(seedsFromSignature(derivationSig)), "simple");
  return (
    verifySelf(p, self) &&
    verifyWalletSig(p, b64.encode(wsig)) &&
    verifySeal(sealed).ok &&
    fingerprint(p) === fingerprint(again)
  );
});

/* ------------------------------------------------------------------ */

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

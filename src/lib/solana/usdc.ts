/**
 * USDC with a sealed note (SPEC 3.4 extension): the pure half.
 *
 * One legacy transaction carries three instructions, built by hand (no
 * @solana/spl-token):
 *   1. Associated Token Account program, CreateIdempotent (instruction 1):
 *      the recipient's USDC account, created when missing, rent paid by the sender;
 *   2. SPL Token, TransferChecked (instruction 12): `amount` base units of
 *      USDC from the sender's associated token account to the recipient's;
 *   3. SPL Memo `dirac:pay:v1:<first 32 hex of the envelope hash>`, which
 *      binds the transfer to one sealed letter without revealing it.
 *
 * `checkUsdcPayment` is the server's verdict on a `getTransaction` result
 * (jsonParsed). Pure module: package imports only, so it runs unchanged in
 * the browser, in the Worker (`../src/lib/solana/usdc`) and under node
 * (`scripts/usdc-selftest.ts`). The browser half (balances, blockhash,
 * wallet) lives in `./pay.ts`.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { Buffer } from "buffer";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Circle's USDC on Solana mainnet. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
/** Base units per USDC. */
export const USDC_UNIT = 1_000_000;
/** The compose form takes cents: 2 decimals, so one cent is 10 000 base units. */
export const USDC_INPUT_DECIMALS = 2;

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
/** SPL Memo program v2, the same as ./memo.ts. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** Associated Token Account program: CreateIdempotent. */
export const ATA_CREATE_IDEMPOTENT = 1;
/** SPL Token: TransferChecked. */
export const TOKEN_TRANSFER_CHECKED = 12;

/** Rent-exempt minimum of a 165-byte token account, paid once by whoever creates it. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
/**
 * Rent-exempt minimum of a wallet (a system account with no data). A fee
 * payer may not drop from rent-exempt to a balance between zero and this
 * minimum, so the sender keeps it on top of what the transaction spends.
 */
export const WALLET_RENT_RESERVE_LAMPORTS = 890_880;
/** One signature's base fee; wallets may add a priority fee on top. */
export const BASE_FEE_LAMPORTS = 5_000;
/** Size of an SPL token account. */
export const TOKEN_ACCOUNT_LEN = 165;

export const PAY_MEMO_PREFIX = "dirac:pay:v1:";
/** Hex characters of the envelope hash the memo carries. */
export const PAY_MEMO_HASH_CHARS = 32;

/** Largest amount accepted, in base units: a safe integer, about 9 billion USDC. */
export const MAX_USDC_UNITS = Number.MAX_SAFE_INTEGER;

/* ------------------------------------------------------------------ */
/* Memo                                                                */
/* ------------------------------------------------------------------ */

/** `dirac:pay:v1:<first 32 hex>` for a 64-hex envelope hash (`envelopeHash` in src/lib/inbox.ts). */
export function payMemo(envelopeHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(envelopeHash)) throw new TypeError("envelope hash must be 64 lowercase hex characters");
  return `${PAY_MEMO_PREFIX}${envelopeHash.slice(0, PAY_MEMO_HASH_CHARS)}`;
}

/* ------------------------------------------------------------------ */
/* Amounts                                                             */
/* ------------------------------------------------------------------ */

export type AmountParse = { ok: true; units: number } | { ok: false; error: string };

/**
 * "12.5" → 12 500 000 base units. At most `maxDecimals` decimals, no sign,
 * no exponent, no thousands separators; zero is refused.
 */
export function parseUsdcAmount(input: string, maxDecimals = USDC_INPUT_DECIMALS): AmountParse {
  const s = input.trim();
  if (s.length === 0) return { ok: false, error: "Enter an amount." };
  const m = s.match(/^(\d{1,10})(?:\.(\d*))?$|^\.(\d+)$/);
  if (!m) return { ok: false, error: "Use digits and one dot, like 25 or 25.50." };
  const whole = m[1] ?? "0";
  const frac = m[2] ?? m[3] ?? "";
  if (frac.length > maxDecimals) {
    return { ok: false, error: `At most ${maxDecimals} decimals.` };
  }
  const units = Number(whole) * USDC_UNIT + Number((frac + "000000").slice(0, USDC_DECIMALS));
  if (!Number.isSafeInteger(units) || units > MAX_USDC_UNITS) return { ok: false, error: "That amount is too large." };
  if (units <= 0) return { ok: false, error: "The amount must be above zero." };
  return { ok: true, units };
}

/**
 * Base units as a USDC string with thousands separators, at least two
 * decimals and up to six: 12 500 000 → "12.50", 1 → "0.000001".
 */
export function formatUsdc(units: number | bigint): string {
  const n = typeof units === "bigint" ? units : BigInt(Math.trunc(units));
  const negative = n < BigInt(0);
  const abs = negative ? -n : n;
  const unit = BigInt(USDC_UNIT);
  const whole = (abs / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (abs % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

const toKey = (k: string | PublicKey): PublicKey => (typeof k === "string" ? new PublicKey(k) : k);

/**
 * The associated token account of `owner` for `mint` under the classic SPL
 * Token program: PDA of [owner, token program, mint] under the ATA program.
 */
export function associatedTokenAddress(owner: string | PublicKey, mint: string | PublicKey = USDC_MINT): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [toKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM_ID).toBuffer(), toKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  );
  return address;
}

/* ------------------------------------------------------------------ */
/* Instructions                                                        */
/* ------------------------------------------------------------------ */

/**
 * CreateIdempotent: data [1]; accounts payer (signer, writable), the
 * associated account (writable), its owner, the mint, the System program
 * and the Token program. A no-op when the account already exists.
 */
export function createAtaIdempotentIx(
  payer: string | PublicKey,
  ata: string | PublicKey,
  owner: string | PublicKey,
  mint: string | PublicKey = USDC_MINT,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: toKey(payer), isSigner: true, isWritable: true },
      { pubkey: toKey(ata), isSigner: false, isWritable: true },
      { pubkey: toKey(owner), isSigner: false, isWritable: false },
      { pubkey: toKey(mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([ATA_CREATE_IDEMPOTENT]),
  });
}

/** TransferChecked data: [12, amount u64 little-endian, decimals u8]. */
export function transferCheckedData(amount: number | bigint, decimals: number): Uint8Array {
  const value = typeof amount === "bigint" ? amount : BigInt(amount);
  if (value <= BigInt(0) || value > BigInt("18446744073709551615")) throw new RangeError("amount must fit a u64 and be above zero");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError("decimals must be a u8");
  const data = new Uint8Array(10);
  data[0] = TOKEN_TRANSFER_CHECKED;
  new DataView(data.buffer).setBigUint64(1, value, true);
  data[9] = decimals;
  return data;
}

/**
 * TransferChecked: accounts source (writable), mint, destination (writable),
 * owner (signer). The program checks the mint and its decimals.
 */
export function transferCheckedIx(
  source: string | PublicKey,
  mint: string | PublicKey,
  destination: string | PublicKey,
  owner: string | PublicKey,
  amount: number | bigint,
  decimals: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: toKey(source), isSigner: false, isWritable: true },
      { pubkey: toKey(mint), isSigner: false, isWritable: false },
      { pubkey: toKey(destination), isSigner: false, isWritable: true },
      { pubkey: toKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from(transferCheckedData(amount, decimals)),
  });
}

/** A memo with no signer accounts, the same shape as ./memo.ts. */
export function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [],
    data: Buffer.from(text, "utf8"),
  });
}

export interface PaymentRequest {
  /** base58 sender wallet: fee payer, rent payer and token owner */
  from: string;
  /** base58 recipient wallet (the passport holder) */
  to: string;
  /** base units of USDC */
  amount: number;
  /** 64-hex `envelopeHash` of the sealed letter */
  envelopeHash: string;
}

/** The three instructions of a payment, in order: create the recipient's account, transfer, memo. */
export function usdcPaymentInstructions(req: PaymentRequest): TransactionInstruction[] {
  const from = new PublicKey(req.from);
  const to = new PublicKey(req.to);
  if (from.equals(to)) throw new Error("A payment to your own wallet moves nothing.");
  if (!Number.isSafeInteger(req.amount) || req.amount <= 0) throw new RangeError("amount must be a positive whole number of base units");
  const mint = new PublicKey(USDC_MINT);
  const source = associatedTokenAddress(from, mint);
  const destination = associatedTokenAddress(to, mint);
  return [
    createAtaIdempotentIx(from, destination, to, mint),
    transferCheckedIx(source, mint, destination, from, req.amount, USDC_DECIMALS),
    memoIx(payMemo(req.envelopeHash)),
  ];
}

/* ------------------------------------------------------------------ */
/* Token account data                                                  */
/* ------------------------------------------------------------------ */

export interface TokenAccount {
  mint: string;
  owner: string;
  /** base units */
  amount: bigint;
  /** 0 uninitialized, 1 initialized, 2 frozen */
  state: number;
}

/** Mint, owner, amount and state of a raw SPL token account (165 bytes), or null for anything else. */
export function decodeTokenAccount(data: Uint8Array): TokenAccount | null {
  if (data.length !== TOKEN_ACCOUNT_LEN) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: base58.encode(data.subarray(0, 32)),
    owner: base58.encode(data.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
    state: data[108],
  };
}

/* ------------------------------------------------------------------ */
/* On-chain check (getTransaction, jsonParsed)                         */
/* ------------------------------------------------------------------ */

export interface PaymentExpectation {
  /** the wallet that signed the letter */
  sender: string;
  /** the wallet the letter is addressed to */
  recipient: string;
  /** base units the sender claims */
  amount: number;
  /** 64-hex envelope hash of the letter */
  envelopeHash: string;
}

export type PaymentCheck = { ok: true } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The memo text of a jsonParsed memo instruction, or of a raw one (base58 data). */
function memoText(ix: Record<string, unknown>): string | null {
  if (typeof ix.parsed === "string") return ix.parsed;
  if (typeof ix.data !== "string") return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(base58.decode(ix.data));
  } catch {
    return null;
  }
}

/** accountKeys as base58 strings: jsonParsed gives { pubkey, ... } objects, other encodings plain strings. */
function accountKeyList(message: Record<string, unknown>): string[] {
  const keys = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  return keys.map((k: unknown) => (isRecord(k) && typeof k.pubkey === "string" ? k.pubkey : typeof k === "string" ? k : ""));
}

/** Owner and mint of every token account in the transaction, by address, from pre and post token balances. */
function tokenOwners(meta: Record<string, unknown>, keys: string[]): Map<string, { owner: string; mint: string }> {
  const out = new Map<string, { owner: string; mint: string }>();
  for (const list of [meta.preTokenBalances, meta.postTokenBalances]) {
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      if (!isRecord(b) || typeof b.accountIndex !== "number") continue;
      const address = keys[b.accountIndex];
      if (!address || typeof b.owner !== "string" || typeof b.mint !== "string") continue;
      out.set(address, { owner: b.owner, mint: b.mint });
    }
  }
  return out;
}

interface ParsedTransfer {
  source: string;
  destination: string;
  authority: string;
  amount: string;
  decimals: number;
}

/** A top-level jsonParsed TransferChecked of USDC under the classic Token program, or null. */
function usdcTransfer(ix: Record<string, unknown>): ParsedTransfer | null {
  if (ix.programId !== TOKEN_PROGRAM_ID || !isRecord(ix.parsed) || ix.parsed.type !== "transferChecked") return null;
  const info = ix.parsed.info;
  if (!isRecord(info) || info.mint !== USDC_MINT || !isRecord(info.tokenAmount)) return null;
  const { source, destination, authority } = info;
  const { amount, decimals } = info.tokenAmount;
  if (typeof source !== "string" || typeof destination !== "string" || typeof authority !== "string") return null;
  if (typeof amount !== "string" || typeof decimals !== "number") return null;
  return { source, destination, authority, amount, decimals };
}

/**
 * The server's verdict on a `getTransaction` result (jsonParsed, confirmed):
 * it landed without error; one top-level TransferChecked moves exactly
 * `amount` base units of USDC, signed by the sender, out of a token account
 * the sender owns, into the recipient's associated token account; and a
 * top-level memo reads `dirac:pay:v1:<first 32 hex of the envelope hash>`.
 * Inner (CPI) instructions are not considered: the site builds the transfer
 * at the top level.
 */
export function checkUsdcPayment(tx: unknown, expect: PaymentExpectation): PaymentCheck {
  if (!isRecord(tx) || !isRecord(tx.meta) || !isRecord(tx.transaction) || !isRecord(tx.transaction.message)) {
    return { ok: false, error: "the transaction could not be read" };
  }
  if (tx.meta.err !== null && tx.meta.err !== undefined) return { ok: false, error: "the transaction failed on chain" };

  let memo: string;
  let recipientAta: string;
  try {
    memo = payMemo(expect.envelopeHash);
    recipientAta = associatedTokenAddress(expect.recipient).toBase58();
  } catch {
    return { ok: false, error: "the letter or the recipient is malformed" };
  }

  const message = tx.transaction.message;
  const keys = accountKeyList(message);
  const owners = tokenOwners(tx.meta, keys);
  const instructions = (Array.isArray(message.instructions) ? message.instructions : []).filter(isRecord);

  const transfers = instructions.map(usdcTransfer).filter((t): t is ParsedTransfer => t !== null);
  if (transfers.length === 0) return { ok: false, error: "it carries no USDC TransferChecked instruction" };

  const toRecipient = transfers.filter((t) => t.destination === recipientAta);
  if (toRecipient.length === 0) return { ok: false, error: "no USDC goes to the recipient's associated token account" };

  const fromSender = toRecipient.filter((t) => {
    const source = owners.get(t.source);
    return t.authority === expect.sender && source?.owner === expect.sender && source.mint === USDC_MINT;
  });
  if (fromSender.length === 0) return { ok: false, error: "the USDC did not come from a token account of the sending wallet" };

  const exact = fromSender.find((t) => t.decimals === USDC_DECIMALS && t.amount === String(expect.amount));
  if (!exact) {
    const seen = fromSender[0];
    if (seen.decimals !== USDC_DECIMALS) return { ok: false, error: `the transfer names ${seen.decimals} decimals; USDC has ${USDC_DECIMALS}` };
    const onChain = /^\d{1,20}$/.test(seen.amount) ? `${formatUsdc(BigInt(seen.amount))} USDC` : "another amount";
    return { ok: false, error: `the transfer is ${onChain}, not ${formatUsdc(expect.amount)} USDC` };
  }

  const memoFound = instructions.some((ix) => ix.programId === MEMO_PROGRAM_ID && memoText(ix) === memo);
  if (!memoFound) return { ok: false, error: `it carries no ${PAY_MEMO_PREFIX} memo for this letter` };
  return { ok: true };
}

import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { confirmSignature, getConnection } from "./rpc";
import type { ConnectedWallet } from "./wallet";

/** SPL Memo program v2. */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** The memo program rejects instructions larger than this. */
const MAX_MEMO_BYTES = 566;

/**
 * Legacy transaction with one memo instruction and a fresh blockhash, fee payer = `payer`.
 * Serialized without signatures so a wallet can sign it.
 */
export async function buildMemoTx(payer: string, memo: string): Promise<Uint8Array> {
  const data = Buffer.from(memo, "utf8");
  if (data.length > MAX_MEMO_BYTES) {
    throw new Error(`Memo is ${data.length} bytes; the limit is ${MAX_MEMO_BYTES}.`);
  }
  const feePayer = new PublicKey(payer);
  const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
  tx.add(new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data }));
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/**
 * Builds, signs and sends a memo from the connected wallet, then waits (up to 60 s) for
 * "confirmed" commitment. Returns the base58 transaction signature.
 */
export async function anchorMemo(wallet: ConnectedWallet, memo: string): Promise<string> {
  const tx = await buildMemoTx(wallet.address, memo);
  const signature = await wallet.signAndSend(tx);
  await confirmSignature(signature, { timeoutMs: 60_000, intervalMs: 1_500 });
  return signature;
}

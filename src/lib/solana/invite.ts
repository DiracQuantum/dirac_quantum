import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { MEMO_PROGRAM_ID } from "./memo";
import { confirmSignature, getConnection } from "./rpc";
import type { ConnectedWallet } from "./wallet";

/** What an invite transfers: 0.0001 SOL, enough to be seen, not enough to matter. */
export const INVITE_LAMPORTS = 100_000;

/** The memo attached to the transfer; the link opens /passport with the inviter prefilled. */
export const INVITE_MEMO = (siteUrl: string, from: string) => `dirac:invite:v1 ${siteUrl}/passport?from=${from}`;

/**
 * Legacy transaction with a SystemProgram transfer of INVITE_LAMPORTS to `to`
 * and the invite memo, fee payer = `from`, fresh blockhash. Serialized without
 * signatures so a wallet can sign it.
 */
export async function buildInviteTx(from: string, to: string, siteUrl: string): Promise<Uint8Array> {
  const fromPubkey = new PublicKey(from);
  const toPubkey = new PublicKey(to);
  if (fromPubkey.equals(toPubkey)) throw new Error("A wallet cannot invite itself.");
  const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: fromPubkey, blockhash, lastValidBlockHeight });
  tx.add(SystemProgram.transfer({ fromPubkey, toPubkey, lamports: INVITE_LAMPORTS }));
  tx.add(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(INVITE_MEMO(siteUrl, from), "utf8"),
    }),
  );
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/**
 * Builds, signs and sends the invite from the connected wallet, then waits (up
 * to 60 s) for "confirmed" commitment. Returns the base58 transaction signature.
 */
export async function sendInvite(wallet: ConnectedWallet, to: string, siteUrl: string): Promise<string> {
  const tx = await buildInviteTx(wallet.address, to, siteUrl);
  const signature = await wallet.signAndSend(tx);
  await confirmSignature(signature, { timeoutMs: 60_000, intervalMs: 1_500 });
  return signature;
}

/**
 * USDC with a sealed note: the browser half (./usdc.ts is the pure half).
 * Reads balances through the site's RPC proxy, builds the payment
 * transaction with a fresh blockhash for the wallet to sign and send, and
 * polls for "confirmed".
 */

import { PublicKey, Transaction } from "@solana/web3.js";
import { getConnection } from "./rpc";
import {
  BASE_FEE_LAMPORTS,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WALLET_RENT_RESERVE_LAMPORTS,
  associatedTokenAddress,
  decodeTokenAccount,
  usdcPaymentInstructions,
  type PaymentRequest,
} from "./usdc";

export interface PaymentAccounts {
  /** lamports on the sender wallet */
  sol: number;
  /** USDC base units in the sender's associated token account; null when it does not exist */
  usdc: bigint | null;
  /** the sender's USDC account is frozen by the mint authority */
  frozen: boolean;
  /** the recipient already has a USDC associated token account (no rent to pay) */
  recipientHasAccount: boolean;
  /**
   * lamports the wallet needs on top of the USDC: base fee, rent when the
   * recipient's account is created, and the rent minimum the fee payer keeps
   */
  solNeeded: number;
}

/**
 * One getMultipleAccounts call: the sender wallet, its USDC account and the
 * recipient's USDC account.
 */
export async function readPaymentAccounts(sender: string, recipient: string): Promise<PaymentAccounts> {
  const senderKey = new PublicKey(sender);
  const senderAta = associatedTokenAddress(senderKey);
  const recipientAta = associatedTokenAddress(recipient);
  const [wallet, source, destination] = await getConnection().getMultipleAccountsInfo(
    [senderKey, senderAta, recipientAta],
    "confirmed",
  );

  let usdc: bigint | null = null;
  let frozen = false;
  if (source && source.owner.toBase58() === TOKEN_PROGRAM_ID) {
    const account = decodeTokenAccount(new Uint8Array(source.data));
    if (account && account.mint === USDC_MINT && account.owner === sender) {
      usdc = account.amount;
      frozen = account.state === 2;
    }
  }
  const recipientHasAccount = destination !== null && destination.owner.toBase58() === TOKEN_PROGRAM_ID;
  return {
    sol: wallet?.lamports ?? 0,
    usdc,
    frozen,
    recipientHasAccount,
    solNeeded: BASE_FEE_LAMPORTS + (recipientHasAccount ? 0 : TOKEN_ACCOUNT_RENT_LAMPORTS) + WALLET_RENT_RESERVE_LAMPORTS,
  };
}

/** Legacy transaction with the three payment instructions, fee payer = sender, fresh blockhash; unsigned. */
export async function buildUsdcPaymentTx(req: PaymentRequest): Promise<Uint8Array> {
  const instructions = usdcPaymentInstructions(req);
  const { blockhash, lastValidBlockHeight } = await getConnection().getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: new PublicKey(req.from), blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** What the wallet's transaction came to: landed, failed on chain, or not seen within the wait. */
export type PaymentLanding = "confirmed" | "failed" | "unknown";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls getSignatureStatuses for up to `timeoutMs`. Never throws: an RPC
 * that cannot answer counts as "unknown", the letter is then sent with a
 * pending payment and the registry checks again later.
 */
export async function awaitPayment(signature: string, timeoutMs = 60_000, intervalMs = 1_500): Promise<PaymentLanding> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { value } = await getConnection().getSignatureStatuses([signature], { searchTransactionHistory: false });
      const status = value[0];
      if (status?.err) return "failed";
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        return "confirmed";
      }
    } catch {
      // A failed poll is not an answer; try again until the deadline.
    }
    if (Date.now() + intervalMs > deadline) return "unknown";
    await sleep(intervalMs);
  }
}

import { Connection, type TransactionError } from "@solana/web3.js";
import { API_BASE } from "@/lib/api";

/**
 * Explicit RPC endpoint from the build environment, or empty to use the
 * site's own /api/rpc proxy (the public Solana endpoint rejects browsers).
 */
export const RPC_URL: string = process.env.NEXT_PUBLIC_RPC_URL ?? "";

export function resolveRpcUrl(): string {
  if (RPC_URL) return RPC_URL;
  const base = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
  return base ? `${base}/api/rpc` : "https://solana-rpc.publicnode.com";
}

let connection: Connection | null = null;

/** One shared Connection at "confirmed" commitment. */
export function getConnection(): Connection {
  if (!connection) connection = new Connection(resolveRpcUrl(), { commitment: "confirmed" });
  return connection;
}

export function explorerTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export function explorerAddress(a: string): string {
  return `https://solscan.io/account/${a}`;
}

export interface ConfirmOptions {
  /** Give up after this long. Default 60 s. */
  timeoutMs?: number;
  /** Poll interval. Default 1.5 s. */
  intervalMs?: number;
}

function describeTransactionError(err: TransactionError): string {
  return typeof err === "string" ? err : JSON.stringify(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls getSignatureStatuses until the transaction is confirmed or finalized.
 * Throws with a readable message when the transaction failed on chain or the timeout passed.
 */
export async function confirmSignature(signature: string, opts: ConfirmOptions = {}): Promise<void> {
  const { timeoutMs = 60_000, intervalMs = 1_500 } = opts;
  const conn = getConnection();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed on chain: ${describeTransactionError(status.err)}`);
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `No confirmation after ${Math.round(timeoutMs / 1000)} s. The transaction may still land; check ${explorerTx(signature)}.`,
      );
    }
    await sleep(intervalMs);
  }
}

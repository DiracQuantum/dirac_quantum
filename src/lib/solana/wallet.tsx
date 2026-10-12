"use client";

// Wallet Standard only. Phantom, Solflare, Backpack and friends register themselves in the page
// through @wallet-standard/app and expose their capabilities as named features. No adapter packages.

import { base58 } from "@scure/base";
import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount, WalletWithFeatures } from "@wallet-standard/base";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import { getConnection } from "./rpc";

export interface ConnectedWallet {
  /** Wallet name, e.g. "Phantom". */
  name: string;
  /** Data URL icon supplied by the wallet. */
  icon: string;
  /** Base58 address of the connected account. */
  address: string;
  publicKey: Uint8Array;
  /** Signs raw bytes with the account key (solana:signMessage). Returns the Ed25519 signature. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /**
   * Signs and sends a serialized legacy transaction via solana:signAndSendTransaction on
   * solana:mainnet; falls back to solana:signTransaction + sendRawTransaction. Returns the
   * base58 transaction signature.
   */
  signAndSend(tx: Uint8Array): Promise<string>;
  disconnect(): Promise<void>;
}

export interface WalletOption {
  name: string;
  icon: string;
  connect(): Promise<ConnectedWallet>;
}

export interface WalletState {
  wallet: ConnectedWallet | null;
  options: WalletOption[];
  connect(o: WalletOption): Promise<void>;
  disconnect(): Promise<void>;
  connecting: boolean;
  error: string | null;
}

/* ---------------------------------------------------------------------------------------------- */
/* Wallet Standard plumbing                                                                        */
/* ---------------------------------------------------------------------------------------------- */

const CHAIN = "solana:mainnet";
const STORAGE_KEY = "dirac:wallet";
const StandardConnect = "standard:connect";
const StandardEvents = "standard:events";
const StandardDisconnect = "standard:disconnect";

// Minimal shapes of the generic features we use (the full types live in @wallet-standard/features,
// which is not a direct dependency of this project).
type StandardConnectFeature = {
  readonly [StandardConnect]: {
    readonly version: "1.0.0";
    readonly connect: (input?: {
      readonly silent?: boolean;
    }) => Promise<{ readonly accounts: readonly WalletAccount[] }>;
  };
};
type StandardEventsFeature = {
  readonly [StandardEvents]: {
    readonly version: "1.0.0";
    readonly on: (
      event: "change",
      listener: (properties: { readonly accounts?: readonly WalletAccount[] }) => void,
    ) => () => void;
  };
};
type StandardDisconnectFeature = {
  readonly [StandardDisconnect]: {
    readonly version: "1.0.0";
    readonly disconnect: () => Promise<void>;
  };
};

type SupportedWallet = WalletWithFeatures<
  StandardConnectFeature &
    SolanaSignMessageFeature &
    Partial<
      SolanaSignAndSendTransactionFeature &
        SolanaSignTransactionFeature &
        StandardEventsFeature &
        StandardDisconnectFeature
    >
>;

function isSupported(w: Wallet): w is SupportedWallet {
  const f = w.features;
  const canSend = SolanaSignAndSendTransaction in f || SolanaSignTransaction in f;
  return w.chains.includes(CHAIN) && StandardConnect in f && SolanaSignMessage in f && canSend;
}

function supportedWallets(): SupportedWallet[] {
  if (typeof window === "undefined") return [];
  const seen = new Set<string>();
  const out: SupportedWallet[] = [];
  for (const w of getWallets().get()) {
    if (!isSupported(w) || seen.has(w.name)) continue;
    seen.add(w.name);
    out.push(w);
  }
  return out;
}

function findWallet(name: string): SupportedWallet | undefined {
  return supportedWallets().find((w) => w.name === name);
}

function pickAccount(accounts: readonly WalletAccount[]): WalletAccount | undefined {
  return accounts.find((a) => a.chains.includes(CHAIN)) ?? accounts[0];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Simulation logs a wallet or web3.js attached to an error (SendTransactionError keeps them in `logs`). */
function errorLogs(e: unknown): string[] {
  if (!e || typeof e !== "object") return [];
  const o = e as { logs?: unknown; transactionLogs?: unknown; data?: unknown };
  const data = o.data && typeof o.data === "object" ? (o.data as { logs?: unknown }).logs : undefined;
  for (const logs of [o.logs, o.transactionLogs, data]) {
    if (Array.isArray(logs)) return logs.filter((line): line is string => typeof line === "string");
  }
  return [];
}

/**
 * The runtime's and the programs' own words for a shortfall, checked in this
 * order against the error message and its simulation logs:
 *  - the fee payer cannot pay the fee, or holds no SOL at all;
 *  - the transaction would leave an account under its rent-exempt minimum;
 *  - a System program transfer (the invite, or the rent of a new token account) lacks lamports;
 *  - the Token program's log line "Program log: Error: insufficient funds": the token
 *    balance is short. The only token this site moves is USDC.
 * A bare "insufficient funds" from anywhere else keeps its original message.
 */
const SOL_FOR_FEE = /insufficient funds for fee|no record of a prior credit/i;
const SOL_FOR_RENT = /insufficient funds for rent/i;
const SOL_FOR_TRANSFER = /insufficient lamports/i;
const TOKEN_SHORT = /Program log: Error: insufficient funds(?! for)/i;

/** Turns whatever a wallet threw into one readable sentence. */
export function describeWalletError(e: unknown): string {
  let message = "";
  let code: unknown;
  if (e instanceof Error) {
    message = e.message;
    code = (e as { code?: unknown }).code;
  } else if (typeof e === "string") {
    message = e;
  } else if (e && typeof e === "object") {
    const o = e as { message?: unknown; code?: unknown };
    if (typeof o.message === "string") message = o.message;
    code = o.code;
  }
  if (code === 4001 || /reject|denied|declin|cancel|closed/i.test(message)) {
    return "Request rejected in the wallet.";
  }
  if (/locked/i.test(message)) return "The wallet is locked. Unlock it and try again.";
  const text = [message, ...errorLogs(e)].join("\n");
  if (SOL_FOR_FEE.test(text)) return "Not enough SOL to pay the network fee.";
  if (SOL_FOR_RENT.test(text)) return "Not enough SOL: the wallet would fall below the rent minimum it must keep.";
  if (SOL_FOR_TRANSFER.test(text)) return "Not enough SOL for this transaction and its network fee.";
  if (TOKEN_SHORT.test(text)) return "Not enough USDC in this wallet for the transfer.";
  return message.trim() || "The wallet request failed.";
}

function toReadableError(e: unknown): Error {
  const message = describeWalletError(e);
  if (e instanceof Error && e.message === message) return e;
  return new Error(message, { cause: e });
}

function makeConnected(w: SupportedWallet, account: WalletAccount): ConnectedWallet {
  const features = w.features;
  return {
    name: w.name,
    icon: w.icon,
    address: account.address,
    publicKey: new Uint8Array(account.publicKey),

    async signMessage(message) {
      try {
        const [out] = await features[SolanaSignMessage].signMessage({ account, message });
        if (!out) throw new Error("The wallet returned no signature.");
        if (!bytesEqual(out.signedMessage, message)) {
          throw new Error(
            `${w.name} modified the message before signing, so the signature cannot be verified.`,
          );
        }
        return out.signature;
      } catch (e) {
        throw toReadableError(e);
      }
    },

    async signAndSend(tx) {
      try {
        const sendFeature = features[SolanaSignAndSendTransaction];
        if (sendFeature) {
          const [out] = await sendFeature.signAndSendTransaction({
            account,
            transaction: tx,
            chain: CHAIN,
          });
          if (!out) throw new Error("The wallet returned no transaction signature.");
          return base58.encode(out.signature);
        }
        const signFeature = features[SolanaSignTransaction];
        if (!signFeature) throw new Error(`${w.name} cannot sign transactions.`);
        const [out] = await signFeature.signTransaction({ account, transaction: tx, chain: CHAIN });
        if (!out) throw new Error("The wallet returned no signed transaction.");
        return await getConnection().sendRawTransaction(out.signedTransaction, {
          preflightCommitment: "confirmed",
        });
      } catch (e) {
        throw toReadableError(e);
      }
    },

    async disconnect() {
      try {
        await features[StandardDisconnect]?.disconnect();
      } catch {
        // The wallet may already be disconnected; nothing to clean up on our side.
      }
    },
  };
}

async function connectStandard(w: SupportedWallet, silent = false): Promise<ConnectedWallet> {
  let accounts: readonly WalletAccount[];
  try {
    const out = await w.features[StandardConnect].connect(silent ? { silent: true } : undefined);
    accounts = out.accounts.length > 0 ? out.accounts : w.accounts;
  } catch (e) {
    throw toReadableError(e);
  }
  const account = pickAccount(accounts);
  if (!account) throw new Error(`${w.name} did not return a Solana account.`);
  return makeConnected(w, account);
}

/** Accounts the wallet already authorised for this page, or a silent connect; null when neither works. */
async function reconnectSilently(w: SupportedWallet): Promise<ConnectedWallet | null> {
  const existing = pickAccount(w.accounts);
  if (existing) return makeConnected(w, existing);
  try {
    return await connectStandard(w, true);
  } catch {
    return null;
  }
}

/**
 * Wallets registered in the page that support standard:connect, solana:signMessage,
 * solana:signAndSendTransaction or solana:signTransaction, and the solana:mainnet chain.
 */
export function listWallets(): WalletOption[] {
  return supportedWallets().map((w) => ({
    name: w.name,
    icon: w.icon,
    connect: () => connectStandard(w),
  }));
}

/* ---------------------------------------------------------------------------------------------- */
/* Option list as an external store (late-injected wallets appear through the register event)      */
/* ---------------------------------------------------------------------------------------------- */

const EMPTY: WalletOption[] = [];
const listeners = new Set<() => void>();
let cache: WalletOption[] | null = null;
let watching = false;

function invalidate(): void {
  cache = null;
  for (const listener of listeners) listener();
}

function ensureWatching(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  const wallets = getWallets();
  wallets.on("register", invalidate);
  wallets.on("unregister", invalidate);
}

function getSnapshot(): WalletOption[] {
  ensureWatching();
  if (cache === null) cache = listWallets();
  return cache;
}

function getServerSnapshot(): WalletOption[] {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  ensureWatching();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Persistence                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

function readRemembered(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(name: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Private mode or blocked storage: the session simply will not auto-reconnect.
  }
}

function forget(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Same as above.
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* React context                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

const MISSING_PROVIDER = "WalletProvider is not mounted. Add it to src/components/Providers.tsx.";

const WalletContext = createContext<WalletState>({
  wallet: null,
  options: EMPTY,
  connecting: false,
  error: null,
  connect: () => Promise.reject(new Error(MISSING_PROVIDER)),
  disconnect: () => Promise.resolve(),
});

export function useWallet(): WalletState {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: ReactNode }): JSX.Element {
  const options = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reconnectTried = useRef(false);

  // Silent reconnect, once, as soon as the remembered wallet has registered in the page.
  useEffect(() => {
    if (wallet || reconnectTried.current) return;
    const name = readRemembered();
    if (!name || !options.some((o) => o.name === name)) return;
    const standard = findWallet(name);
    if (!standard) return;
    reconnectTried.current = true;
    void reconnectSilently(standard).then((w) => {
      if (w) setWallet((current) => current ?? w);
    });
  }, [options, wallet]);

  // Follow account switches and wallet-side disconnects.
  useEffect(() => {
    if (!wallet) return;
    const standard = findWallet(wallet.name);
    const events = standard?.features[StandardEvents];
    if (!standard || !events) return;
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      const next = pickAccount(accounts);
      if (!next) {
        setWallet(null);
      } else if (next.address !== wallet.address) {
        setWallet(makeConnected(standard, next));
      }
    });
  }, [wallet]);

  const connect = useCallback(async (o: WalletOption) => {
    setConnecting(true);
    setError(null);
    try {
      const w = await o.connect();
      setWallet(w);
      remember(w.name);
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const current = wallet;
    forget();
    setError(null);
    setWallet(null);
    if (current) await current.disconnect();
  }, [wallet]);

  const value = useMemo<WalletState>(
    () => ({ wallet, options, connect, disconnect, connecting, error }),
    [wallet, options, connect, disconnect, connecting, error],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

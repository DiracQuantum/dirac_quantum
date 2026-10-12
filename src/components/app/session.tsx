"use client";

/**
 * Passport session: the passport the browser is currently working with, its
 * signatures, the anchor transaction and (in memory only) the secret keys.
 *
 * The non-secret parts are persisted in localStorage under
 * `dirac:passport:<wallet>` so a page reload or a second visit can show the
 * document again. Secret keys never leave memory: after a reload the user
 * restores them on /passport (one wallet signature in simple mode, the phrase
 * or the recovery file in hardened mode).
 *
 * Implemented as a small external store read through `useSyncExternalStore`,
 * so loading persisted data on wallet changes is a plain function call from an
 * effect rather than a setState chain.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Passport, PassportKeys } from "@/lib/pq";
import { useWallet } from "@/lib/solana/wallet";

export interface SessionState {
  passport: Passport | null;
  /** Secret and public halves of both PQ keys. Memory only, never persisted. */
  keys: PassportKeys | null;
  /** base64 ML-DSA-65 self-signature of the passport. */
  selfSig: string | null;
  /** base64 Ed25519 wallet signature over WALLET_MESSAGE(passport). */
  walletSig: string | null;
  /** Signature of the memo transaction that anchors the passport, once sent. */
  anchorTx: string | null;
}

/** What is written to localStorage: everything except the keys. */
export interface StoredPassport {
  passport: Passport;
  selfSig: string | null;
  walletSig: string | null;
  anchorTx: string | null;
}

export interface Session extends SessionState {
  setPassport(passport: Passport | null): void;
  setKeys(keys: PassportKeys | null): void;
  setSelfSig(sig: string | null): void;
  setWalletSig(sig: string | null): void;
  setAnchorTx(tx: string | null): void;
  /** Replace several fields in one update (one render, one storage write). */
  update(patch: Partial<SessionState>): void;
  /**
   * Load the persisted parts for `wallet` unless the passport in memory already
   * belongs to that wallet. Keys are never restored from storage. Returns
   * whether a stored passport was found.
   */
  restore(wallet: string): boolean;
  /** Drop everything from memory; with `forget` also the persisted copy. */
  clear(opts?: { forget?: boolean }): void;
}

const EMPTY: SessionState = {
  passport: null,
  keys: null,
  selfSig: null,
  walletSig: null,
  anchorTx: null,
};

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export const storageKey = (wallet: string) => `dirac:passport:${wallet}`;

function isPassport(value: unknown): value is Passport {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.wallet === "string" &&
    typeof p.kem_pk === "string" &&
    typeof p.dsa_pk === "string" &&
    (p.mode === "simple" || p.mode === "hardened") &&
    typeof p.created_at === "number"
  );
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The persisted passport for a wallet, or null when there is none or it is malformed. */
export function readStoredPassport(wallet: string): StoredPassport | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(wallet));
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return null;
    const d = data as Record<string, unknown>;
    if (!isPassport(d.passport) || d.passport.wallet !== wallet) return null;
    return {
      passport: d.passport,
      selfSig: optionalString(d.selfSig),
      walletSig: optionalString(d.walletSig),
      anchorTx: optionalString(d.anchorTx),
    };
  } catch {
    return null;
  }
}

function writeStoredPassport(state: SessionState): void {
  if (typeof window === "undefined" || !state.passport) return;
  const stored: StoredPassport = {
    passport: state.passport,
    selfSig: state.selfSig,
    walletSig: state.walletSig,
    anchorTx: state.anchorTx,
  };
  try {
    window.localStorage.setItem(storageKey(state.passport.wallet), JSON.stringify(stored));
  } catch {
    // Private mode or full storage: the session still works for this tab.
  }
}

export function forgetStoredPassport(wallet: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(wallet));
  } catch {
    // Nothing to do.
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

interface SessionStore {
  get(): SessionState;
  subscribe(listener: () => void): () => void;
  update(patch: Partial<SessionState>): void;
  restore(wallet: string): boolean;
  clear(opts?: { forget?: boolean }): void;
}

function createSessionStore(): SessionStore {
  let state: SessionState = EMPTY;
  const listeners = new Set<() => void>();

  const set = (next: SessionState) => {
    state = next;
    writeStoredPassport(next);
    for (const listener of listeners) listener();
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(patch) {
      set({ ...state, ...patch });
    },
    restore(wallet) {
      if (state.passport && state.passport.wallet === wallet) return true;
      const stored = readStoredPassport(wallet);
      // A passport of another wallet (and its keys) must not survive a wallet switch.
      set(stored ? { ...stored, keys: null } : EMPTY);
      return stored !== null;
    },
    clear(opts) {
      const wallet = state.passport?.wallet;
      if (opts?.forget && wallet) forgetStoredPassport(wallet);
      state = EMPTY;
      for (const listener of listeners) listener();
    },
  };
}

const defaultStore = createSessionStore();
const SessionContext = createContext<SessionStore>(defaultStore);

const getServerSnapshot = () => EMPTY;

/* ------------------------------------------------------------------ */
/* React                                                               */
/* ------------------------------------------------------------------ */

export function SessionProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createSessionStore);
  const { wallet } = useWallet();
  const address = wallet?.address ?? null;

  // When a wallet connects (or the account switches), pick up the persisted
  // passport for it. Keys stay empty until the user restores them.
  useEffect(() => {
    if (address) store.restore(address);
  }, [store, address]);

  return <SessionContext.Provider value={store}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const store = useContext(SessionContext);
  const state = useSyncExternalStore(store.subscribe, store.get, getServerSnapshot);

  const actions = useMemo(
    () => ({
      setPassport: (passport: Passport | null) => store.update({ passport }),
      setKeys: (keys: PassportKeys | null) => store.update({ keys }),
      setSelfSig: (selfSig: string | null) => store.update({ selfSig }),
      setWalletSig: (walletSig: string | null) => store.update({ walletSig }),
      setAnchorTx: (anchorTx: string | null) => store.update({ anchorTx }),
      update: (patch: Partial<SessionState>) => store.update(patch),
      restore: (wallet: string) => store.restore(wallet),
      clear: (opts?: { forget?: boolean }) => store.clear(opts),
    }),
    [store],
  );

  return useMemo(() => ({ ...state, ...actions }), [state, actions]);
}

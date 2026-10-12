"use client";

/**
 * The quantum pet as React state: loads `GET /api/pet` on mount, polls it
 * while the tab is visible, reloads once the day has collapsed and applies
 * gates through `POST /api/pet/act`, anonymously or signed by a wallet
 * (src/lib/petGate.ts). With a `wallet` option the reads carry `?wallet=`,
 * so the state knows the wallet's own signed gates today.
 *
 * Every setState runs inside a promise callback or a timer, never in an
 * effect body, and the clock is only read in handlers and effects: `useNow`
 * hands render a ticking timestamp from state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "@/components/app/ui";
import type { Gate, PetState, SignedGate } from "@/lib/pet";
import { applyGate, fetchPetState, PET_WINDOW_MS, PetGateError, SIGNED_PET_LIMIT, windowOf } from "@/lib/petGate";

export interface Outcome {
  q: number;
  value: number;
  /** increases with every action, so a repeated outcome still re-renders its chip */
  seq: number;
}

export interface LastGate {
  gate: Gate;
  q: number;
  t: number | null;
  seq: number;
}

/** Signed gates spent in one fixed minute window by the wallet that was connected. */
export interface SignedWindow {
  /** `windowOf(Date.now())` when the last signed gate went through */
  start: number;
  used: number;
}

export interface PetUi {
  state: PetState | null;
  /** no state yet and no failure */
  loading: boolean;
  /** why the state could not be loaded */
  error: string | null;
  /** a gate is in flight */
  busy: boolean;
  /** why the last gate was refused (not the rate limit, which is `retryAt`) */
  actError: string | null;
  /** unix ms until the next gate is allowed, after a gate or a 429; resets when the wallet changes */
  retryAt: number | null;
  /** signed gates spent by the connected wallet in the current window, null before the first */
  signedWindow: SignedWindow | null;
  /** the last MEASURE result */
  outcome: Outcome | null;
  /** the last gate that went through */
  lastGate: LastGate | null;
  /** whether the last gate that went through was signed */
  lastSigned: boolean;
  /** applies a gate, signed when `signed` is given; resolves true when it went through */
  act(gate: Gate, q: number, t?: number, signed?: SignedGate | null): Promise<boolean>;
  reload(): void;
}

interface Options {
  /** refresh period while the tab is visible; 0 disables polling */
  pollMs?: number;
  /** the connected wallet: reads carry it, and the gate allowance is tracked per wallet */
  wallet?: string | null;
}

/** After the collapse time the state is fetched again, at most this often while clocks disagree. */
const COLLAPSE_RETRY_MS = 15_000;

export function usePet({ pollMs = 30_000, wallet = null }: Options = {}): PetUi {
  const [state, setState] = useState<PetState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  // The wait and the allowance belong to the wallet that was connected when they were set:
  // another wallet (or none) has its own bucket on the server, so they read as null for it.
  const [retry, setRetry] = useState<{ at: number; wallet: string | null } | null>(null);
  const [signedUse, setSignedUse] = useState<(SignedWindow & { wallet: string }) | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [lastGate, setLastGate] = useState<LastGate | null>(null);
  const [lastSigned, setLastSigned] = useState(false);
  const seq = useRef(0);
  const signedRef = useRef<(SignedWindow & { wallet: string }) | null>(null);
  // Counts the gates that went through. A read (initial load, poll, reload)
  // that was in flight when a gate succeeded is older than the gate's own
  // response and must not overwrite it, so every read remembers the count it
  // started with and applies only if no gate landed meanwhile.
  const acted = useRef(0);

  // Initial load, every reload, and again when the wallet changes (its own gate count).
  useEffect(() => {
    let cancelled = false;
    const since = acted.current;
    fetchPetState(wallet)
      .then((s) => {
        if (cancelled) return;
        if (acted.current === since) setState(s);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, wallet]);

  // Other visitors apply gates too: refresh while the tab is visible.
  useEffect(() => {
    if (pollMs <= 0) return;
    let cancelled = false;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const since = acted.current;
      fetchPetState(wallet)
        .then((s) => {
          if (!cancelled && acted.current === since) setState(s);
        })
        .catch(() => undefined);
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs, wallet]);

  // Once the day is over the Worker collapses it on the next read: fetch again just after.
  const collapseAt = state?.collapseAt ?? null;
  useEffect(() => {
    if (collapseAt === null) return;
    const delay = collapseAt + 2000 - Date.now();
    const id = window.setTimeout(() => setAttempt((n) => n + 1), Math.max(COLLAPSE_RETRY_MS, delay));
    return () => window.clearTimeout(id);
  }, [collapseAt, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const act = useCallback(
    async (gate: Gate, q: number, t?: number, signed: SignedGate | null = null): Promise<boolean> => {
      setBusy(true);
      setActError(null);
      try {
        const result = await applyGate(gate, q, t, signed);
        seq.current += 1;
        acted.current += 1;
        const now = Date.now();
        setState(result.state);
        setLastGate({ gate, q, t: t ?? null, seq: seq.current });
        setLastSigned(signed !== null);
        if (gate === "MEASURE" && typeof result.outcome === "number") {
          setOutcome({ q, value: result.outcome, seq: seq.current });
        }
        const start = windowOf(now);
        if (signed) {
          // Three signed gates per fixed minute window: the wait only starts with the last one.
          const previous = signedRef.current;
          const used = previous && previous.wallet === signed.wallet && previous.start === start ? previous.used + 1 : 1;
          const next = { wallet: signed.wallet, start, used };
          signedRef.current = next;
          setSignedUse(next);
          setRetry(used >= SIGNED_PET_LIMIT ? { at: (start + 1) * PET_WINDOW_MS, wallet } : null);
        } else {
          // One anonymous gate per window: the next window opens at the next whole minute.
          setRetry({ at: (start + 1) * PET_WINDOW_MS, wallet });
        }
        return true;
      } catch (e: unknown) {
        if (e instanceof PetGateError && e.status === 429 && e.retryAt !== null) {
          setRetry({ at: e.retryAt, wallet });
        } else {
          setActError(describeError(e));
        }
        // A refusal means the state here is behind (a protection, a collapse): fetch it again.
        if (e instanceof PetGateError && e.status === 409) setAttempt((n) => n + 1);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [wallet],
  );

  const retryAt = retry !== null && retry.wallet === wallet ? retry.at : null;
  const signedWindow = signedUse !== null && signedUse.wallet === wallet ? { start: signedUse.start, used: signedUse.used } : null;

  return {
    state,
    loading: state === null && error === null,
    error,
    busy,
    actError,
    retryAt,
    signedWindow,
    outcome,
    lastGate,
    lastSigned,
    act,
    reload,
  };
}

/**
 * The current time as state, updated every `intervalMs`. Null on the first
 * render (and on the server), so nothing reads the clock during render.
 */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, intervalMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

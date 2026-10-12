"use client";

/**
 * The arena as React state: the public ladder (`GET /api/arena`), one
 * wallet's standing (`GET /api/arena/me`), and the browser-side store of
 * committed fighters, the favourite opponent and the builder draft.
 *
 * Every setState runs inside a promise callback or a timer, never in an
 * effect body. Storage is read through `useSyncExternalStore` with an empty
 * server snapshot, so the static HTML and the first client render agree.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { describeError } from "@/components/app/ui";
import { emptyCircuit, type ArenaBadge, type ArenaLadder, type ArenaMe, type Circuit, type TournamentView } from "@/lib/arena";
import { fetchArenaBadges, fetchArenaMe, fetchLadder, fetchTournament } from "@/lib/arenaApi";
import {
  EMPTY_ENTRIES,
  EMPTY_FIGHTERS,
  NO_SOLVED,
  draftCircuit,
  favouriteCircuit,
  fightersOf,
  solvedChallenges,
  subscribeArenaStore,
  syncFighters,
  tournamentEntriesOf,
  type SolvedMap,
  type StoredEntry,
  type StoredFighter,
} from "@/lib/arenaStore";

export interface LadderUi {
  ladder: ArenaLadder | null;
  loading: boolean;
  error: string | null;
  reload(): void;
}

export function useLadder(pollMs = 60_000): LadderUi {
  const [ladder, setLadder] = useState<ArenaLadder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchLadder()
      .then((l) => {
        if (cancelled) return;
        setLadder(l);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ladder, loading: ladder === null && error === null, error, reload };
}

export interface MeUi {
  me: ArenaMe | null;
  loading: boolean;
  error: string | null;
  reload(): void;
}

/** One wallet's standing; null state while no wallet is connected. */
export function useArenaMe(wallet: string | null, pollMs = 30_000): MeUi {
  const [me, setMe] = useState<ArenaMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    fetchArenaMe(wallet)
      .then((m) => {
        if (cancelled) return;
        syncFighters(wallet, m);
        setMe(m);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, attempt]);

  useEffect(() => {
    if (!wallet || pollMs <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    }, pollMs);
    return () => window.clearInterval(id);
  }, [wallet, pollMs]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const current = me && me.wallet === wallet ? me : null;
  return { me: current, loading: wallet !== null && current === null && error === null, error, reload };
}

const noFighters = () => EMPTY_FIGHTERS;
const noCircuit = () => null;

/** The fighters this browser committed for `wallet`. */
export function useFighters(wallet: string | null): readonly StoredFighter[] {
  return useSyncExternalStore(subscribeArenaStore, () => fightersOf(wallet), noFighters);
}

export function useFavourite(): Circuit | null {
  return useSyncExternalStore(subscribeArenaStore, favouriteCircuit, noCircuit);
}

const BLANK = emptyCircuit();

/** The circuit on the builder, kept across reloads. */
export function useDraft(): Circuit {
  return useSyncExternalStore(subscribeArenaStore, draftCircuit, noCircuit) ?? BLANK;
}

const noEntries = () => EMPTY_ENTRIES;
const noSolved = () => NO_SOLVED;

/** The tournament entries this browser committed for `wallet`. */
export function useTournamentEntries(wallet: string | null): readonly StoredEntry[] {
  return useSyncExternalStore(subscribeArenaStore, () => tournamentEntriesOf(wallet), noEntries);
}

/** The challenges solved in this browser. */
export function useSolved(): SolvedMap {
  return useSyncExternalStore(subscribeArenaStore, solvedChallenges, noSolved);
}

export interface TournamentUi {
  view: TournamentView | null;
  /** server clock minus this browser's clock at the read, ms: countdowns add it to the local now */
  skew: number;
  loading: boolean;
  error: string | null;
  reload(): void;
}

interface Loaded {
  key: string;
  view: TournamentView;
  skew: number;
}

/** A fixed pause after a phase boundary before the read, so the server is past it too. */
const BOUNDARY_SETTLE_MS = 2_000;

/**
 * One day's tournament (`day` null: the server's today). Polls while the
 * tab is visible and reads again just after the next phase boundary of the
 * day (21:00, 23:59, 00:00 UTC by the server's clock), so the panel turns
 * over without a reload.
 */
export function useTournament(day: string | null, pollMs = 30_000): TournamentUi {
  const key = day ?? "today";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchTournament(day ?? undefined)
      .then((view) => {
        if (cancelled) return;
        setLoaded({ key, view, skew: view.now - Date.now() });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ key, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [day, key, attempt]);

  useEffect(() => {
    if (pollMs <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setAttempt((n) => n + 1);
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);

  const view = loaded && loaded.key === key ? loaded.view : null;
  useEffect(() => {
    if (!view) return;
    const s = view.schedule;
    const next = [s.entryClosesAt, s.revealClosesAt, s.resolvesAt].find((t) => t > view.now);
    if (next === undefined) return;
    // setTimeout takes at most 2^31 - 1 ms; a boundary further away is reached by the poll instead.
    const wait = Math.min(next - view.now + BOUNDARY_SETTLE_MS, 2_147_000_000);
    const id = window.setTimeout(() => setAttempt((n) => n + 1), wait);
    return () => window.clearTimeout(id);
  }, [view]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const error = failure && failure.key === key ? failure.message : null;
  return { view, skew: loaded && loaded.key === key ? loaded.skew : 0, loading: view === null && error === null, error, reload };
}

/** A wallet's tournament badges; `refreshKey` reads them again when it changes (a new resolved day). */
export function useArenaBadges(wallet: string | null, refreshKey = ""): ArenaBadge[] | null {
  const [loaded, setLoaded] = useState<{ wallet: string; badges: ArenaBadge[] } | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    fetchArenaBadges(wallet)
      .then((b) => {
        if (!cancelled) setLoaded({ wallet, badges: b.badges });
      })
      .catch(() => {
        // Badges are a garnish on the tournament panel; a failed read just leaves the line out.
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, refreshKey]);

  return wallet && loaded?.wallet === wallet ? loaded.badges : null;
}

/**
 * What the browser keeps for the arena, in localStorage:
 *
 * - `dirac:arena:fighters:<wallet>`: the ranked fighters this browser
 *   committed for a wallet (circuit, salt, commit, bout id once paired).
 *   The server only ever sees the commit until the reveal, so the circuit
 *   and salt exist nowhere else: a reveal must come from the browser that
 *   committed. A fighter is never dropped on age alone: it stays until the
 *   server reports it neither queued nor in any bout of the wallet
 *   (`syncFighters`), it is withdrawn, or the commit was refused.
 * - `dirac:arena:favourite`: one circuit kept as a practice opponent.
 * - `dirac:arena:draft`: the circuit on the builder, so a reload keeps it.
 * - `dirac:arena:tournament:<wallet>`: the daily tournament entries this
 *   browser committed (day, circuit, salt, commit). Same rule as ranked:
 *   the reveal between 21:00 and 23:59 UTC must come from this browser.
 *   Kept 14 days; by then the day has resolved and its circuits are public.
 * - `dirac:arena:challenges`: the challenges solved in this browser, by id
 *   (`daily:<pet day>:<bits>` or `lesson:<name>`), with the circuit and the
 *   measured value. Per browser, never sent anywhere.
 *
 * A small external store (subscribe/snapshot) with exported mutators, so
 * components read it through `useSyncExternalStore` and never touch the
 * storage or the cached arrays themselves.
 */

import { DAY_MS, circuitFromJson, isCommit, isDay, isSalt, type Circuit } from "@/lib/arena";

export interface StoredFighter {
  commit: string;
  salt: string;
  circuit: Circuit;
  /** set once the server paired this fighter; null while queued */
  boutId: string | null;
  /** unix ms of the commit */
  createdAt: number;
  /** unix ms of a successful reveal, null before */
  revealedAt: number | null;
}

export const EMPTY_FIGHTERS: readonly StoredFighter[] = Object.freeze([]);

const fightersKey = (wallet: string) => `dirac:arena:fighters:${wallet}`;
const FAVOURITE_KEY = "dirac:arena:favourite";
const DRAFT_KEY = "dirac:arena:draft";
/**
 * An unpaired fighter the server does not list is kept this long after its
 * commit before `syncFighters` drops it: the commit reply may still be on
 * its way, or the `GET /me` answer may predate the commit.
 */
const UNKNOWN_GRACE_MS = 10 * 60 * 1000;

const listeners = new Set<() => void>();
const cache = new Map<string, readonly StoredFighter[]>();
let favouriteCache: Circuit | null | undefined;
let draftCache: Circuit | null | undefined;

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeArenaStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode or full storage: the in-memory copy still serves this tab.
  }
}

function isFighter(value: unknown): value is StoredFighter {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    isCommit(f.commit) &&
    isSalt(f.salt) &&
    circuitFromJson(JSON.stringify(f.circuit)) !== null &&
    (f.boutId === null || typeof f.boutId === "string") &&
    typeof f.createdAt === "number" &&
    (f.revealedAt === null || typeof f.revealedAt === "number")
  );
}

function load(wallet: string): readonly StoredFighter[] {
  const raw = readRaw(fightersKey(wallet));
  if (!raw) return EMPTY_FIGHTERS;
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return EMPTY_FIGHTERS;
    const kept = data.filter(isFighter);
    return kept.length === 0 ? EMPTY_FIGHTERS : Object.freeze(kept);
  } catch {
    return EMPTY_FIGHTERS;
  }
}

/** The fighters stored for a wallet; the same array reference until something changes. */
export function fightersOf(wallet: string | null): readonly StoredFighter[] {
  if (!wallet) return EMPTY_FIGHTERS;
  let list = cache.get(wallet);
  if (list === undefined) {
    list = load(wallet);
    cache.set(wallet, list);
  }
  return list;
}

function store(wallet: string, list: readonly StoredFighter[]): void {
  const frozen = list.length === 0 ? EMPTY_FIGHTERS : Object.freeze(list.slice());
  cache.set(wallet, frozen);
  writeRaw(fightersKey(wallet), frozen.length === 0 ? null : JSON.stringify(frozen));
  notify();
}

export function saveFighter(wallet: string, fighter: StoredFighter): void {
  const rest = fightersOf(wallet).filter((f) => f.commit !== fighter.commit);
  store(wallet, [fighter, ...rest]);
}

/** Stores a fresh commit (not yet paired, not revealed), stamped now. */
export function recordCommit(wallet: string, commit: string, salt: string, circuit: Circuit): void {
  saveFighter(wallet, { commit, salt, circuit, boutId: null, createdAt: Date.now(), revealedAt: null });
}

/** Marks a fighter revealed in its bout, stamped now. */
export function markRevealed(wallet: string, commit: string, boutId: string): void {
  updateFighter(wallet, commit, { boutId, revealedAt: Date.now() });
}

export function updateFighter(wallet: string, commit: string, patch: Partial<StoredFighter>): void {
  const list = fightersOf(wallet);
  if (!list.some((f) => f.commit === commit)) return;
  store(
    wallet,
    list.map((f) => (f.commit === commit ? { ...f, ...patch } : f)),
  );
}

export function removeFighter(wallet: string, commit: string): void {
  store(
    wallet,
    fightersOf(wallet).filter((f) => f.commit !== commit),
  );
}

/** The stored fighter with this commit, or null. */
export function fighterByCommit(wallet: string | null, commit: string): StoredFighter | null {
  return fightersOf(wallet).find((f) => f.commit === commit) ?? null;
}

/* --- favourite opponent and the draft ------------------------------- */

export function favouriteCircuit(): Circuit | null {
  if (favouriteCache === undefined) favouriteCache = circuitFromJson(readRaw(FAVOURITE_KEY));
  return favouriteCache;
}

export function saveFavourite(circuit: Circuit | null): void {
  favouriteCache = circuit;
  writeRaw(FAVOURITE_KEY, circuit === null ? null : JSON.stringify(circuit));
  notify();
}

export function draftCircuit(): Circuit | null {
  if (draftCache === undefined) draftCache = circuitFromJson(readRaw(DRAFT_KEY));
  return draftCache;
}

export function saveDraft(circuit: Circuit): void {
  draftCache = circuit;
  writeRaw(DRAFT_KEY, JSON.stringify(circuit));
  notify();
}

/* --- daily tournament entries ---------------------------------------- */

export interface StoredEntry {
  /** UTC day, "YYYY-MM-DD" */
  day: string;
  commit: string;
  salt: string;
  circuit: Circuit;
  /** unix ms of the entry */
  enteredAt: number;
  /** unix ms of a successful reveal, null before */
  revealedAt: number | null;
}

export const EMPTY_ENTRIES: readonly StoredEntry[] = Object.freeze([]);

const entriesKey = (wallet: string) => `dirac:arena:tournament:${wallet}`;
/** By then the day has resolved and the circuit is public anyway. */
const ENTRY_KEEP_MS = 14 * DAY_MS;
const entriesCache = new Map<string, readonly StoredEntry[]>();

function isEntry(value: unknown): value is StoredEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    isDay(e.day) &&
    isCommit(e.commit) &&
    isSalt(e.salt) &&
    circuitFromJson(JSON.stringify(e.circuit)) !== null &&
    typeof e.enteredAt === "number" &&
    (e.revealedAt === null || typeof e.revealedAt === "number")
  );
}

function loadEntries(wallet: string): readonly StoredEntry[] {
  const raw = readRaw(entriesKey(wallet));
  if (!raw) return EMPTY_ENTRIES;
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return EMPTY_ENTRIES;
    const kept = data.filter(isEntry);
    return kept.length === 0 ? EMPTY_ENTRIES : Object.freeze(kept);
  } catch {
    return EMPTY_ENTRIES;
  }
}

/** The tournament entries stored for a wallet, newest first; the same array reference until something changes. */
export function tournamentEntriesOf(wallet: string | null): readonly StoredEntry[] {
  if (!wallet) return EMPTY_ENTRIES;
  let list = entriesCache.get(wallet);
  if (list === undefined) {
    list = loadEntries(wallet);
    entriesCache.set(wallet, list);
  }
  return list;
}

function storeEntries(wallet: string, list: readonly StoredEntry[]): void {
  const frozen = list.length === 0 ? EMPTY_ENTRIES : Object.freeze(list.slice());
  entriesCache.set(wallet, frozen);
  writeRaw(entriesKey(wallet), frozen.length === 0 ? null : JSON.stringify(frozen));
  notify();
}

/** Stores a fresh tournament commit, stamped now, and drops entries older than two weeks. */
export function recordTournamentEntry(wallet: string, day: string, commit: string, salt: string, circuit: Circuit): void {
  const now = Date.now();
  const rest = tournamentEntriesOf(wallet).filter((e) => e.commit !== commit && now - e.enteredAt < ENTRY_KEEP_MS);
  storeEntries(wallet, [{ day, commit, salt, circuit, enteredAt: now, revealedAt: null }, ...rest]);
}

/** Marks an entry revealed, stamped now. */
export function markTournamentRevealed(wallet: string, commit: string): void {
  const list = tournamentEntriesOf(wallet);
  if (!list.some((e) => e.commit === commit)) return;
  const now = Date.now();
  storeEntries(
    wallet,
    list.map((e) => (e.commit === commit ? { ...e, revealedAt: now } : e)),
  );
}

/** Drops an entry the server refused, so it never offers a reveal. */
export function removeTournamentEntry(wallet: string, commit: string): void {
  storeEntries(
    wallet,
    tournamentEntriesOf(wallet).filter((e) => e.commit !== commit),
  );
}

/* --- solved challenges ----------------------------------------------- */

export interface SolvedChallenge {
  /** unix ms of the solve */
  at: number;
  /** the number the goal read at the solve */
  value: number;
  circuit: Circuit;
}

export type SolvedMap = Readonly<Record<string, SolvedChallenge>>;

const SOLVED_KEY = "dirac:arena:challenges";
export const NO_SOLVED: SolvedMap = Object.freeze({});
let solvedCache: SolvedMap | undefined;

function isSolved(value: unknown): value is SolvedChallenge {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s.at === "number" && typeof s.value === "number" && circuitFromJson(JSON.stringify(s.circuit)) !== null;
}

/** Every challenge solved in this browser, by id. */
export function solvedChallenges(): SolvedMap {
  if (solvedCache !== undefined) return solvedCache;
  let loaded: SolvedMap = NO_SOLVED;
  const raw = readRaw(SOLVED_KEY);
  if (raw) {
    try {
      const data: unknown = JSON.parse(raw);
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        const kept: Record<string, SolvedChallenge> = {};
        for (const [id, v] of Object.entries(data)) if (isSolved(v)) kept[id] = v;
        loaded = Object.freeze(kept);
      }
    } catch {
      loaded = NO_SOLVED;
    }
  }
  solvedCache = loaded;
  return loaded;
}

/** Remembers a solve; the first one for an id stays. */
export function recordSolved(id: string, value: number, circuit: Circuit): void {
  const current = solvedChallenges();
  if (current[id]) return;
  const next: SolvedMap = Object.freeze({ ...current, [id]: { at: Date.now(), value, circuit } });
  solvedCache = next;
  writeRaw(SOLVED_KEY, JSON.stringify(next));
  notify();
}

/** The part of a `GET /api/arena/me` answer the store reconciles against. */
export interface ServerStanding {
  queued: { commit: string } | null;
  unresolved: { id: string; aCommit: string; bCommit: string }[];
  recent: { id: string; aCommit: string; bCommit: string }[];
}

/**
 * Reconciles the stored fighters with a fresh `GET /api/arena/me` answer:
 * records the bout ids the server assigned to fighters this browser
 * committed, and drops an unpaired, unrevealed fighter the server knows
 * nothing about (not queued, in no open or recent bout) once it is older
 * than UNKNOWN_GRACE_MS. A fighter the server still lists as queued is kept
 * for as long as it waits, so its circuit and salt are there when it pairs.
 */
export function syncFighters(wallet: string, me: ServerStanding, now = Date.now()): void {
  const list = fightersOf(wallet);
  if (list.length === 0) return;
  const bouts = [...me.unresolved, ...me.recent];
  let changed = false;
  const next: StoredFighter[] = [];
  for (const f of list) {
    if (f.boutId !== null) {
      next.push(f);
      continue;
    }
    const bout = bouts.find((b) => b.aCommit === f.commit || b.bCommit === f.commit);
    if (bout) {
      changed = true;
      next.push({ ...f, boutId: bout.id });
      continue;
    }
    const queued = me.queued !== null && me.queued.commit === f.commit;
    if (!queued && f.revealedAt === null && now - f.createdAt > UNKNOWN_GRACE_MS) {
      changed = true;
      continue;
    }
    next.push(f);
  }
  if (changed) store(wallet, next);
}

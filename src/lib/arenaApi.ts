/**
 * Browser client for the Qubit Arena routes (worker/arena.ts):
 * `GET /api/arena`, `GET /api/arena/me`, `POST /api/arena/spar`,
 * `POST /api/arena/commit`, `DELETE /api/arena/queue`, `POST /api/arena/reveal`,
 * `GET /api/arena/bout/:id`, `GET /api/arena/tournament`,
 * `POST /api/arena/tournament/enter`, `POST /api/arena/tournament/reveal`,
 * `GET /api/arena/badges`.
 *
 * Kept apart from ./arena (the pure physics the Worker imports) because this
 * file reads `process.env`. Same `API_BASE` rule as ./api, repeated here in
 * one line like ./pet does.
 */

import type { QSeal } from "@/lib/pq";
import type {
  ArenaBadges,
  ArenaBout,
  ArenaLadder,
  ArenaMe,
  Circuit,
  CommitResponse,
  SparResult,
  TournamentEnterResponse,
  TournamentRevealResponse,
  TournamentView,
  WithdrawResponse,
} from "@/lib/arena";

const API_BASE: string = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

/** Thrown on any non-2xx response. A 429 carries `retryAt` (unix ms) and a message that names the wait. */
export class ArenaApiError extends Error {
  readonly status: number;
  readonly retryAt: number | null;
  /** the server's extra fields (a 409 names the queued commit or the open count) */
  readonly data: Record<string, unknown> | null;

  constructor(status: number, message: string, retryAt: number | null = null, data: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ArenaApiError";
    this.status = status;
    this.retryAt = retryAt;
    this.data = data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const record = isRecord(data) ? data : null;
    const serverMessage = record && typeof record.error === "string" ? record.error : null;
    if (res.status === 429) {
      const retryAt = record && typeof record.retryAt === "number" ? record.retryAt : null;
      const wait = retryAt === null ? null : Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
      const message = wait === null ? (serverMessage ?? "rate limited") : `${serverMessage ?? "rate limited"}, try again in ${wait} s`;
      throw new ArenaApiError(429, message, retryAt, record);
    }
    throw new ArenaApiError(res.status, serverMessage ?? `request failed with status ${res.status}`, null, record);
  }
  return data as T;
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export function fetchLadder(): Promise<ArenaLadder> {
  return request<ArenaLadder>("/api/arena");
}

export function fetchArenaMe(wallet: string): Promise<ArenaMe> {
  return request<ArenaMe>(`/api/arena/me?wallet=${encodeURIComponent(wallet)}`);
}

export function sparWithHouse(circuit: Circuit): Promise<SparResult> {
  return post<SparResult>("/api/arena/spar", { circuit });
}

export function commitFighter(wallet: string, commit: string, seal: QSeal): Promise<CommitResponse> {
  return post<CommitResponse>("/api/arena/commit", { wallet, commit, seal });
}

/** Takes a queued fighter back; `seal` covers `withdrawDocHash(commit)`. 404 once it has been paired. */
export function withdrawFighter(wallet: string, commit: string, seal: QSeal): Promise<WithdrawResponse> {
  return request<WithdrawResponse>("/api/arena/queue", { method: "DELETE", body: JSON.stringify({ wallet, commit, seal }) });
}

export function revealFighter(wallet: string, boutId: string, circuit: Circuit, salt: string): Promise<ArenaBout> {
  return post<ArenaBout>("/api/arena/reveal", { wallet, boutId, circuit, salt });
}

/** One bout as anyone sees it: circuits only once resolved. */
export function fetchBout(id: string): Promise<ArenaBout> {
  return request<ArenaBout>(`/api/arena/bout/${encodeURIComponent(id)}`);
}

/** The tournament of a UTC day ("YYYY-MM-DD"), today when omitted. Resolves finished days on the way. */
export function fetchTournament(day?: string): Promise<TournamentView> {
  return request<TournamentView>(day ? `/api/arena/tournament?day=${encodeURIComponent(day)}` : "/api/arena/tournament");
}

/** Enters today's tournament; `seal` covers `tournamentDocHash(day, commit)`. 409 after 21:00 UTC, when full or already in. */
export function enterTournament(wallet: string, day: string, commit: string, seal: QSeal): Promise<TournamentEnterResponse> {
  return post<TournamentEnterResponse>("/api/arena/tournament/enter", { wallet, day, commit, seal });
}

/** Reveals the day's entry, 21:00..23:59 UTC; the circuit and salt must hash to the entered commit. */
export function revealTournament(wallet: string, day: string, circuit: Circuit, salt: string): Promise<TournamentRevealResponse> {
  return post<TournamentRevealResponse>("/api/arena/tournament/reveal", { wallet, day, circuit, salt });
}

/** A wallet's tournament podium badges. */
export function fetchArenaBadges(wallet: string): Promise<ArenaBadges> {
  return request<ArenaBadges>(`/api/arena/badges?wallet=${encodeURIComponent(wallet)}`);
}

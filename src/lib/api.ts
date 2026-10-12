/**
 * Typed client for the Dirac registry API (Cloudflare Worker + D1).
 *
 * Plain `fetch`, no state. In production the API lives on the same origin as
 * the static site, so `API_BASE` is empty and paths are relative. For local
 * development `.env.local` points it at the deployed Worker.
 *
 * The `register*` helpers throw `ApiError` on any non-2xx response (the
 * message is the server's `error` field when it sent one). The `fetch*`
 * lookups resolve to `null` on 404 and throw on every other failure.
 */

import type { Passport, PassportMode, QSeal } from "@/lib/pq";

export const API_BASE: string = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

/** The active version of a wallet's passport (`GET /api/passports/:wallet`). */
export interface PassportRecord {
  passport: Passport;
  self_sig: string;
  wallet_sig: string;
  /** the anchor transaction named for this version; only `anchor_verified` makes it an anchor */
  anchor_tx: string | null;
  hash: string;
  /** unix ms, when this version was registered */
  registered_at: number;
  /** 1 for a wallet's first passport, +1 per rotation */
  version: number;
  /** the Worker found anchor_tx on chain: signed by the wallet, memo = ANCHOR_MEMO(passport) */
  anchor_verified: boolean;
  anchor_slot: number | null;
  /** block time of the verified anchor, unix ms */
  anchor_time: number | null;
  /** hash of the version this one replaced, null for version 1 */
  rotated_from: string | null;
}

/** One version in `GET /api/passports/:wallet/history`, with everything needed to re-check it. */
export interface PassportVersion {
  version: number;
  hash: string;
  mode: PassportMode;
  passport: Passport;
  self_sig: string;
  wallet_sig: string;
  /** ML-DSA-65 signature by the previous version's key over ROTATE_MESSAGE; null for version 1 */
  rotation_sig: string | null;
  rotation_signed: boolean;
  /** unix ms */
  registered_at: number;
  /** unix ms when the next version replaced it; null for the active version */
  superseded_at: number | null;
  anchor_tx: string | null;
  anchor_verified: boolean;
  anchor_slot: number | null;
  /** unix ms */
  anchor_time: number | null;
}

export interface PassportHistory {
  wallet: string;
  /** versions newest first; empty when the wallet has no passport */
  versions: PassportVersion[];
  total: number;
  /** more versions exist than were returned (the oldest are left out) */
  truncated: boolean;
}

export interface RegisterPassportBody {
  passport: Passport;
  self_sig: string;
  wallet_sig: string;
  anchor_tx?: string;
  /** required to replace a registered passport: signRotation(current, currentDsaSk, passport) */
  rotation_sig?: string;
}

export interface RegisterPassportResult {
  ok: true;
  hash: string;
  registered_at: number;
  version: number;
  rotated: boolean;
  /** what is stored for the active version: the verified anchor or a claim, see anchor_status */
  anchor_tx: string | null;
  anchor_verified: boolean;
  /**
   * "unseen": the anchor_tx sent with a re-register is not visible on chain yet and nothing was
   * recorded (anyone can re-register, so only an anchor the chain shows is kept); send it again.
   * Otherwise the state of what is stored: none, an unverified claim (pending), or verified.
   */
  anchor_status: "none" | "pending" | "verified" | "unseen";
  /** why an anchor is still unverified, when the server could tell */
  anchor_note?: string;
}

export interface SealRecord {
  seal: QSeal;
  /** unix ms */
  registered_at: number;
}

export interface Stats {
  passports: number;
  seals: number;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
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
    const message =
      isRecord(data) && typeof data.error === "string" ? data.error : `request failed with status ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: "POST", body: JSON.stringify(body) });
}

async function lookup<T>(path: string): Promise<T | null> {
  try {
    return await call<T>(path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Registers a passport. Replacing a registered one needs `rotation_sig`;
 * without it, or with a wrong one, the server answers 409 (ApiError.status).
 * A refused anchor_tx is a 400.
 */
export async function registerPassport(body: RegisterPassportBody): Promise<RegisterPassportResult> {
  return post("/api/passports", body);
}

/** Fills the fields a registry older than the rotation rules does not send. */
function normalizeRecord(r: PassportRecord): PassportRecord {
  return {
    ...r,
    version: typeof r.version === "number" ? r.version : 1,
    anchor_verified: r.anchor_verified === true,
    anchor_slot: typeof r.anchor_slot === "number" ? r.anchor_slot : null,
    anchor_time: typeof r.anchor_time === "number" ? r.anchor_time : null,
    rotated_from: typeof r.rotated_from === "string" ? r.rotated_from : null,
  };
}

export async function fetchPassport(wallet: string): Promise<PassportRecord | null> {
  const record = await lookup<PassportRecord>(`/api/passports/${encodeURIComponent(wallet)}`);
  return record === null ? null : normalizeRecord(record);
}

/**
 * Every version of the wallet's passport, newest first; an empty list when it
 * has none. Throws (ApiError 404) when the registry does not serve history.
 */
export async function fetchPassportHistory(wallet: string): Promise<PassportHistory> {
  return call<PassportHistory>(`/api/passports/${encodeURIComponent(wallet)}/history`);
}

export async function registerSeal(seal: QSeal): Promise<{ ok: true; id: string }> {
  return post("/api/seals", { seal });
}

export async function fetchSeal(id: string): Promise<SealRecord | null> {
  return lookup<SealRecord>(`/api/seals/${encodeURIComponent(id)}`);
}

export async function fetchStats(): Promise<Stats> {
  return call<Stats>("/api/stats");
}

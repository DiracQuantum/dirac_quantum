/**
 * X posting for the quantum pet: one post per collapsed day.
 *
 * `POST https://api.x.com/2/tweets` with OAuth 1.0a user-context signing,
 * done by hand: HMAC-SHA1 through `crypto.subtle`, RFC 3986 percent-encoding,
 * a nonce from `crypto.getRandomValues`, the timestamp in seconds. No SDK.
 *
 * Credentials come from four secrets (`wrangler secret put`): X_API_KEY and
 * X_API_SECRET (the app's consumer key pair), X_ACCESS_TOKEN and
 * X_ACCESS_SECRET (the posting account's user token pair). When any of them
 * is missing `postToX` answers `{ ok: false, error: "no credentials" }` and
 * nothing is sent.
 *
 * The signing helpers are exported for the self-test (scripts/pet-selftest.ts),
 * which checks them against the published OAuth 1.0a example.
 */

import { postTextForDay, type PetDay } from "../src/lib/pet";

export interface Env {
  SITE_URL?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
}

export interface XCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
}

export type PostResult = { ok: boolean; id?: string; error?: string };

export const DEFAULT_SITE_URL = "https://dirac.digital";
export const X_TWEETS_URL = "https://api.x.com/2/tweets";
/** X answers in well under this; a hung call must not hold a collapse open. */
const X_TIMEOUT_MS = 15_000;
const MAX_ERROR_LEN = 200;

/* ------------------------------------------------------------------ */
/* OAuth 1.0a                                                          */
/* ------------------------------------------------------------------ */

/**
 * RFC 3986 percent-encoding as OAuth 1.0a requires it: unreserved characters
 * (A-Z a-z 0-9 - . _ ~) pass, everything else is %XX in upper case.
 * `encodeURIComponent` leaves `!'()*` alone, so those are fixed up.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The signature base string: method, the URL without query, and every
 * parameter (oauth_* plus query and form fields) encoded, sorted and joined.
 */
export function signatureBase(method: string, url: string, params: Record<string, string>): string {
  const pairs = Object.keys(params)
    .map((key) => [percentEncode(key), percentEncode(params[key])] as const)
    .sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(pairs)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** HMAC-SHA1 of `data` under `key`, base64. */
export async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  return bytesToBase64(new Uint8Array(signature));
}

/** The oauth_signature for one request. */
export async function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): Promise<string> {
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return hmacSha1Base64(signingKey, signatureBase(method, url, params));
}

/** 32 random bytes as hex. */
export function oauthNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export interface OAuthOptions {
  /** Query or form parameters that take part in the signature (none for a JSON body). */
  params?: Record<string, string>;
  /** Fixed values for tests; random and "now" otherwise. */
  nonce?: string;
  timestamp?: string;
}

/**
 * The `Authorization: OAuth ...` header value for one request. Only the
 * oauth_* parameters go into the header; `params` are signed but sent by the
 * caller in the query string or form body.
 */
export async function oauthHeader(
  method: string,
  url: string,
  creds: XCredentials,
  options: OAuthOptions = {},
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: options.nonce ?? oauthNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: options.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const signature = await oauthSignature(
    method,
    url,
    { ...options.params, ...oauth },
    creds.consumerSecret,
    creds.accessSecret,
  );
  const fields: Record<string, string> = { ...oauth, oauth_signature: signature };
  const header = Object.keys(fields)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(fields[key])}"`)
    .join(", ");
  return `OAuth ${header}`;
}

/* ------------------------------------------------------------------ */
/* Posting                                                             */
/* ------------------------------------------------------------------ */

/** The four secrets, or null when any is missing or empty. */
export function credentialsOf(env: Env): XCredentials | null {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) return null;
  return {
    consumerKey: X_API_KEY,
    consumerSecret: X_API_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_SECRET,
  };
}

const clip = (text: string): string => (text.length > MAX_ERROR_LEN ? `${text.slice(0, MAX_ERROR_LEN)}…` : text);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short reason out of an X error body: `detail`, `title` or the first `errors[].message`. */
function describeXError(status: number, body: unknown): string {
  if (isRecord(body)) {
    if (typeof body.detail === "string") return `x responded ${status}: ${clip(body.detail)}`;
    if (typeof body.title === "string") return `x responded ${status}: ${clip(body.title)}`;
    if (Array.isArray(body.errors) && isRecord(body.errors[0]) && typeof body.errors[0].message === "string") {
      return `x responded ${status}: ${clip(body.errors[0].message)}`;
    }
  }
  return `x responded ${status}`;
}

/** Posts `text` from the configured account. Never throws. */
export async function postToX(env: Env, text: string): Promise<PostResult> {
  const creds = credentialsOf(env);
  if (!creds) return { ok: false, error: "no credentials" };
  try {
    const authorization = await oauthHeader("POST", X_TWEETS_URL, creds);
    const response = await fetch(X_TWEETS_URL, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(X_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) return { ok: false, error: describeXError(response.status, body) };
    const id = isRecord(body) && isRecord(body.data) && typeof body.data.id === "string" ? body.data.id : undefined;
    return { ok: true, id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `x request failed: ${clip(message)}` };
  }
}

/** The text of a day's post: the builder shared with the pet page (src/lib/pet.ts `postTextForDay`). */
export function dayPostText(day: PetDay, siteUrl: string): string {
  return postTextForDay(day, siteUrl);
}

/** Posts a collapsed day. Silent `{ ok: false, error: "no credentials" }` without secrets. */
export async function postDayToX(env: Env, day: PetDay): Promise<PostResult> {
  return postToX(env, dayPostText(day, env.SITE_URL ?? DEFAULT_SITE_URL));
}

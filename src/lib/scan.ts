/**
 * Scanner types and client for the Worker route `GET /api/scan/:wallet`.
 *
 * Report shape v3 (docs/CONTRACT-SCANNER-V2.md, v3 section): no overall
 * score. Three headline indicators: `exposure` (what this one Ed25519 key can
 * move today), `identity` (post-quantum passport level) and `confidence`
 * (which sources were read). Every upstream call has its own entry in
 * `sources`; a failed read leaves its fields `null`, never zero. v3 adds
 * Squads v4 multisig detection (`multisigs`, source "multisigs", address kind
 * "multisig"); everything else is the v2 shape.
 *
 * The Worker imports the report types from this file and type-checks it with
 * its own tsconfig, which has no `@/` path alias. That is why nothing here is
 * imported from `./api` (it uses the alias): `API_BASE` follows the same rule
 * as there, repeated in one line.
 */

import { base58 } from "@scure/base";

/**
 * What the scanned address is. Only a "wallet" has a private key somebody can
 * sign with. "multisig" is a Squads v4 multisig account: a PDA whose vaults
 * move when `threshold` of its member keys sign.
 */
export type AddressKind =
  | "wallet"
  | "pda"
  | "program"
  | "mint"
  | "token-account"
  | "stake-account"
  | "multisig"
  | "system"
  | "unknown";

/** Outcome of one upstream read. "truncated": read, but capped, so counts are lower bounds. */
export type SourceStatus = "ok" | "failed" | "skipped" | "truncated";

export type SourceName =
  | "address"
  | "balance"
  | "assets"
  | "signatures"
  | "stake"
  | "mintAuthorities"
  | "programAuthorities"
  | "price"
  | "registry"
  | "multisigs";

export interface SourceState {
  status: SourceStatus;
  /** short human message when failed, skipped or truncated */
  error?: string;
}

/** complete: every source ok; unavailable: balance AND assets failed; otherwise partial */
export type Confidence = "complete" | "partial" | "unavailable";

export type IdentityLevel = "none" | "simple" | "hardened";

/** A fungible token held by the wallet, as reported by DAS `getAssetsByOwner`. */
export interface ScanToken {
  mint: string;
  symbol: string;
  name: string;
  /** UI amount: raw balance divided by 10^decimals */
  amount: number;
  decimals: number;
  /** USD value of the whole position, null when the indexer has no price */
  usd: number | null;
}

/** A mint whose mint and/or freeze authority is the scanned wallet. */
export interface ScanAuthorityMint {
  mint: string;
  /** Total supply as a UI amount, null when it could not be read */
  supply: number | null;
  role: "mint" | "freeze" | "both";
}

/** The registry row for the wallet, reduced to what the report needs. */
export interface ScanPassport {
  hash: string;
  mode: "simple" | "hardened";
  anchored: boolean;
  anchorTx: string | null;
}

/** What the address is, from `getAccountInfo` and the Ed25519 on-curve check. */
export interface ScanAddress {
  kind: AddressKind;
  executable: boolean;
  /** owner program of the account, null when the account does not exist (never funded) */
  owner: string | null;
  /** the 32 bytes decode to an Ed25519 point: a private key can exist for this address */
  onCurve: boolean;
  exists: boolean;
  /** one sentence a reader can act on, e.g. "A program: nobody holds a private key for it." */
  note: string;
}

/** One line of the exposure breakdown. `usd` is null when unknown (not zero). */
export interface ScanExposureLine {
  label: string;
  usd: number | null;
  note?: string;
}

/** What this single Ed25519 key can move today. */
export interface ScanExposure {
  /** sol + priced tokens + stake, at the SOL price; null when a core source failed or no price */
  usd: number | null;
  /** SOL + stake in SOL; null when the balance could not be read */
  sol: number | null;
  lines: ScanExposureLine[];
  /** "A Dirac passport does not change this: whoever signs with the Ed25519 key moves these assets." */
  note: string;
}

export interface ScanIdentity {
  level: IdentityLevel;
  anchored: boolean;
  /** what it means, e.g. "Hardened passport, anchored: the record existed before its block time and only its own key can replace it; assets still move with the Ed25519 key." */
  note: string;
}

/** One member of a Squads v4 multisig and its permission bits (initiate 1, vote 2, execute 4). */
export interface ScanMultisigMember {
  key: string;
  /** raw permission mask */
  mask: number;
  initiate: boolean;
  vote: boolean;
  execute: boolean;
}

/** Vault 0 of a multisig and what it holds; every number is null when its read failed or was skipped. */
export interface ScanVault {
  address: string;
  index: number;
  sol: number | null;
  /** priced tokens, first DAS page only; null when the asset read failed or was skipped */
  tokensUsd: number | null;
  tokenCount: number | null;
  /** sol at the SOL price plus priced tokens; null when the balance or the price is unknown */
  usd: number | null;
  /** what is missing from `usd`, e.g. "tokens not checked"; empty when nothing is */
  note: string;
}

/** A Squads v4 multisig account as the report lists it. */
export interface ScanMultisigAccount {
  address: string;
  createKey: string;
  /** null when the multisig governs itself (config authority 111…111); otherwise the key that can change members and threshold */
  configAuthority: string | null;
  threshold: number;
  /** seconds between approval and execution */
  timeLock: number;
  memberCount: number;
  /** the first MAX_REPORT_MEMBERS members; memberCount is the real count */
  members: ScanMultisigMember[];
  transactionIndex: number;
  /** null when the vault was not valued (over the valuation cap) */
  vault: ScanVault | null;
}

/** Squads v4 detection: the address as a multisig, and the multisigs it is a member of. */
export interface ScanMultisigs {
  /** set when the scanned address is itself a Squads v4 multisig account */
  self: ScanMultisigAccount | null;
  /** multisigs that list the address in one of their first 10 member slots, cap 20 */
  memberOf: ScanMultisigAccount[];
  /** the cap was hit or a slot search stopped early: `memberOf` is a lower bound */
  memberOfTruncated: boolean;
  /** vault-0 holdings across the valued `memberOf` entries, reported apart from the key's own exposure; null when nothing was valued */
  coControlledUsd: number | null;
  coControlledSol: number | null;
  /** how many `memberOf` entries carry a vault value */
  valued: number;
  /** one sentence on what was found and what the search covers */
  note: string;
}

export interface ScanAuthorities {
  /** checked across the tokens the wallet holds, cap 20 */
  mints: ScanAuthorityMint[];
  /** ProgramData accounts with this upgrade authority, cap 50 */
  programs: string[];
  /** authorities equal to 111…111 or other off-curve/system values that were ignored */
  burnedIgnored: number;
  status: "ok" | "partial" | "unavailable";
}

export interface ScanReport {
  v: 3;
  wallet: string;
  /** unix ms */
  scannedAt: number;
  address: ScanAddress;
  sources: Record<SourceName, SourceState>;
  confidence: Confidence;
  /** true when no private RPC was configured (DAS and getProgramAccounts skipped) */
  limited: boolean;
  /** SOL balance; null when the read failed (never 0 for a failed read) */
  sol: number | null;
  /** SOL/USD price, null when unknown */
  solUsd: number | null;
  /** top 25 by USD value, then by amount */
  tokens: ScanToken[];
  tokenCount: number | null;
  /** sum over priced tokens (not only the top 25); null when assets failed */
  tokensUsd: number | null;
  nfts: number | null;
  /** DAS pages exhausted at the cap: tokenCount and nfts are lower bounds */
  assetsTruncated: boolean;
  stakeSol: number | null;
  stakeAccounts: number | null;
  /** 1000 means 1000+ */
  txCount: number | null;
  /** unix seconds */
  lastActivity: number | null;
  /** unix seconds, within the last 1000 signatures */
  oldestSeen: number | null;
  authorities: ScanAuthorities;
  /** Squads v4 multisig detection (source "multisigs") */
  multisigs: ScanMultisigs;
  passport: ScanPassport | null;
  exposure: ScanExposure;
  identity: ScanIdentity;
  /** derived facts, at most 5, plain wording */
  recommendations: string[];
}

/** Same rule as `API_BASE` in ./api: empty in production (same origin), the deployed Worker for local dev. */
const API_BASE: string = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/+$/, "");

const ED25519_PK_LEN = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Shape check on the parts every panel reads; the rest is typed by the Worker that produced it. */
function isScanReport(value: unknown): value is ScanReport {
  return (
    isRecord(value) &&
    value.v === 3 &&
    typeof value.wallet === "string" &&
    isRecord(value.address) &&
    isRecord(value.sources) &&
    isRecord(value.exposure) &&
    isRecord(value.identity) &&
    isRecord(value.authorities) &&
    isRecord(value.multisigs) &&
    Array.isArray(value.tokens) &&
    Array.isArray(value.recommendations) &&
    (value.confidence === "complete" || value.confidence === "partial" || value.confidence === "unavailable")
  );
}

/**
 * Fetches the exposure report for a wallet. Throws an `Error` whose message is
 * the server's `error` field on any non-2xx response (a 429 carries
 * "rate limited, try again in a minute").
 */
export async function fetchScan(wallet: string): Promise<ScanReport> {
  const res = await fetch(`${API_BASE}/api/scan/${encodeURIComponent(wallet)}`, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(
      isRecord(data) && typeof data.error === "string" ? data.error : `request failed with status ${res.status}`,
    );
  }
  if (!isScanReport(data)) throw new Error("the scanner returned an unexpected response");
  return data;
}

/** A Solana address: base58 that decodes to exactly 32 bytes (an Ed25519 public key). */
export function isValidWallet(s: string): boolean {
  // 32 bytes encode to 32..44 base58 characters; skip decoding anything else.
  if (s.length < 32 || s.length > 44) return false;
  try {
    return base58.decode(s).length === ED25519_PK_LEN;
  } catch {
    return false;
  }
}

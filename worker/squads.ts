/**
 * Squads Protocol v4 multisig detection for the scanner (scanner v3,
 * docs/CONTRACT-SCANNER-V2.md). Two questions are answered from chain data
 * alone: is this address a Squads v4 multisig account, and which multisigs
 * list this address as a member.
 *
 * Program: SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf (mainnet, verified
 * executable). Multisig account layout, Anchor/Borsh, checked against live
 * accounts on 2026-10-10:
 *
 *   offset  size  field
 *   0       8     discriminator = sha256("account:Multisig")[0..8]
 *   8       32    create_key
 *   40      32    config_authority (111…111 when the multisig governs itself)
 *   72      2     threshold u16
 *   74      4     time_lock u32 (seconds)
 *   78      8     transaction_index u64
 *   86      8     stale_transaction_index u64
 *   94      1     rent_collector Option tag: 0 (None) or 1 (Some)
 *   95      32    rent_collector pubkey, present only when the tag is 1
 *   next    1     bump
 *   next    4     members length u32
 *   next    33×n  Member { key: 32 bytes, permissions.mask: 1 byte }
 *
 * The Option makes the layout variable: members start at 100 (None) or 132
 * (Some). Accounts are allocated with slack (32 bytes for a None collector,
 * more after member changes), so the parser bounds-checks against the
 * declared member count, never against the account size. Both layouts exist
 * on mainnet in comparable numbers, so a member search runs one memcmp per
 * member slot per layout: 20 filtered getProgramAccounts calls for the first
 * MEMBER_SLOTS slots. 99.9 % of multisigs have at most ten members.
 *
 * Vault PDAs: seeds ["multisig", multisig key, "vault", index u8] under the
 * program (@solana/web3.js findProgramAddressSync, the SDK's getVaultPda).
 *
 * Pure functions throw nothing on garbage: `parseMultisig` returns null. The
 * RPC callers are injected (`SquadsRpc`) so the module has no Env of its own
 * and the Node self-test can drive it.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { PublicKey } from "@solana/web3.js";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Anchor account discriminator of `Multisig`: [224, 116, 121, 186, 68, 161, 79, 236]. Computed, not typed, so it cannot be mistyped. */
export const MULTISIG_DISCRIMINATOR: Uint8Array = sha256(new TextEncoder().encode("account:Multisig")).slice(0, 8);
/** The discriminator as a memcmp `bytes` value. */
export const MULTISIG_DISCRIMINATOR_B58: string = base58.encode(MULTISIG_DISCRIMINATOR);

const PUBKEY_LEN = 32;
const CREATE_KEY_OFFSET = 8;
const CONFIG_AUTHORITY_OFFSET = 40;
const THRESHOLD_OFFSET = 72;
const TIME_LOCK_OFFSET = 74;
const TRANSACTION_INDEX_OFFSET = 78;
const STALE_INDEX_OFFSET = 86;
const RENT_COLLECTOR_TAG_OFFSET = 94;
/** bytes of a serialised Member: key + permissions mask */
export const MEMBER_LEN = 33;
/** first member byte when rent_collector is None / Some */
export const MEMBERS_OFFSET_NONE = 100;
export const MEMBERS_OFFSET_SOME = 132;
/** shortest valid account: None collector, one member */
const MIN_LEN = MEMBERS_OFFSET_NONE + MEMBER_LEN;
/** member slots searched per layout */
export const MEMBER_SLOTS = 10;
/** a sanity cap on the declared member count; the program's u16 threshold cannot address more anyway */
const MAX_MEMBERS = 65_535;

/** Permission bits of a member (squads-v4 `Permission`). */
export const PERMISSION_INITIATE = 1;
export const PERMISSION_VOTE = 2;
export const PERMISSION_EXECUTE = 4;

/** pubkeys per getMultipleAccounts call */
const MULTIPLE_ACCOUNTS_MAX = 100;
/** parallel slot searches; the rate gate below bounds the request rate, this only overlaps latency */
const SEARCH_CONCURRENCY = 3;
/**
 * Shortest gap between two indexed calls, across every search in flight on
 * this isolate: eight per second, under the Helius free tier's ten, with
 * room for the scan's other reads. A page answers in about 100 ms, so
 * without the gate three slots in flight would make thirty calls a second,
 * and two scans at once sixteen even with a gate per search.
 */
const INDEXED_MIN_INTERVAL_MS = 125;
/**
 * Attempts per slot on the indexed RPC. A 429 is a burst effect of two or
 * three searches close together, and its window outlasts a sub-second
 * retry, so the backoff is 1 s, 2 s, 4 s with up to a quarter of jitter,
 * and it holds the shared gate so the other slots pause as well.
 */
const INDEXED_ATTEMPTS = 4;
const INDEXED_BACKOFF_MS = 1000;
const INDEXED_BACKOFF_JITTER = 0.25;
/** a node without getProgramAccountsV2 says so; no point retrying there */
const NO_V2_PATTERN = /method (does not exist|not found)|-32601|not available|unsupported|unknown method/i;
/** getProgramAccountsV2 pages per slot before the slot is given up as exhausted; one to two pages when the index is idle, more under load */
const MAX_SEARCH_PAGES = 12;
/** getProgramAccountsV2 `limit`: also sets how many accounts one page scans; 10 000 covers the program in one or a few pages */
const SEARCH_PAGE_LIMIT = 10_000;
/** retries of the public fallback after a transport failure */
const PUBLIC_RETRIES = 1;
const RETRY_DELAY_MS = 400;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface MultisigMember {
  key: string;
  /** raw permission mask */
  mask: number;
  initiate: boolean;
  vote: boolean;
  execute: boolean;
}

export interface ParsedMultisig {
  createKey: string;
  /** base58; equals the System Program (111…111) when the multisig governs itself */
  configAuthority: string;
  /** true when config_authority is 111…111: member and threshold changes go through the multisig's own votes */
  selfGoverned: boolean;
  threshold: number;
  /** seconds between approval and execution */
  timeLock: number;
  transactionIndex: number;
  staleTransactionIndex: number;
  rentCollector: string | null;
  bump: number;
  members: MultisigMember[];
  /** where the member array starts: 100 or 132 */
  membersOffset: number;
}

/** A parsed multisig with its address, as the search returns it. */
export interface MultisigAccount extends ParsedMultisig {
  address: string;
}

export interface MemberSearch {
  multisigs: MultisigAccount[];
  /** the cap was hit and later slots were skipped: the list is a lower bound */
  truncated: boolean;
  /** a slot search ran out of pages before the index was fully scanned: memberships may be missing */
  pagesExhausted: boolean;
  /** memcmp searches that ran (20 when every slot was searched) */
  slotsSearched: number;
}

export type RpcCall = (method: string, params: unknown) => Promise<unknown>;

/**
 * The three ways the search talks to the chain, injected by the Worker.
 * `indexed` is the private RPC (Helius) and serves getProgramAccountsV2 with
 * pagination; a plain getProgramAccounts there is slow and often refused as
 * "overloaded". `public` is a node that serves filtered getProgramAccounts
 * on this program for free, or null when there is none: the one free node
 * that does (api.mainnet.solana.com) answers 403 from workerd, so the Worker
 * passes null and only the self-test exercises the fallback. `any` is the
 * normal rotation, for getMultipleAccounts.
 */
export interface SquadsRpc {
  indexed: RpcCall | null;
  public: RpcCall | null;
  any: RpcCall;
}

/* ------------------------------------------------------------------ */
/* Parsing (pure)                                                      */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** u64 as a JS number; values above 2^53 lose precision, which no transaction index reaches. */
function readU64(view: DataView, offset: number): number {
  return Number(view.getBigUint64(offset, true));
}

function pubkeyAt(data: Uint8Array, offset: number): string {
  return base58.encode(data.subarray(offset, offset + PUBKEY_LEN));
}

function hasDiscriminator(data: Uint8Array): boolean {
  for (let i = 0; i < MULTISIG_DISCRIMINATOR.length; i += 1) {
    if (data[i] !== MULTISIG_DISCRIMINATOR[i]) return false;
  }
  return true;
}

/**
 * Parses a Squads v4 `Multisig` account. Returns null for anything that is
 * not one: wrong discriminator, too short, an Option tag other than 0/1, a
 * member count that does not fit, a threshold of zero or above the member
 * count. Never throws.
 */
export function parseMultisig(data: Uint8Array): ParsedMultisig | null {
  if (!(data instanceof Uint8Array) || data.length < MIN_LEN || !hasDiscriminator(data)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const tag = data[RENT_COLLECTOR_TAG_OFFSET];
  if (tag !== 0 && tag !== 1) return null;
  const rentCollector = tag === 1 ? pubkeyAt(data, RENT_COLLECTOR_TAG_OFFSET + 1) : null;
  const bumpOffset = tag === 1 ? RENT_COLLECTOR_TAG_OFFSET + 1 + PUBKEY_LEN : RENT_COLLECTOR_TAG_OFFSET + 1;
  const lengthOffset = bumpOffset + 1;
  const membersOffset = lengthOffset + 4;
  if (data.length < membersOffset) return null;

  const memberCount = readU32(view, lengthOffset);
  if (memberCount === 0 || memberCount > MAX_MEMBERS) return null;
  if (membersOffset + memberCount * MEMBER_LEN > data.length) return null;

  const threshold = readU16(view, THRESHOLD_OFFSET);
  if (threshold === 0 || threshold > memberCount) return null;

  const members: MultisigMember[] = [];
  for (let i = 0; i < memberCount; i += 1) {
    const at = membersOffset + i * MEMBER_LEN;
    const mask = data[at + PUBKEY_LEN];
    members.push({
      key: pubkeyAt(data, at),
      mask,
      initiate: (mask & PERMISSION_INITIATE) !== 0,
      vote: (mask & PERMISSION_VOTE) !== 0,
      execute: (mask & PERMISSION_EXECUTE) !== 0,
    });
  }

  const configAuthority = pubkeyAt(data, CONFIG_AUTHORITY_OFFSET);
  return {
    createKey: pubkeyAt(data, CREATE_KEY_OFFSET),
    configAuthority,
    selfGoverned: configAuthority === SYSTEM_PROGRAM,
    threshold,
    timeLock: readU32(view, TIME_LOCK_OFFSET),
    transactionIndex: readU64(view, TRANSACTION_INDEX_OFFSET),
    staleTransactionIndex: readU64(view, STALE_INDEX_OFFSET),
    rentCollector,
    bump: data[bumpOffset],
    members,
    membersOffset,
  };
}

/**
 * The bytes of an account's `data` field as the RPC returns it: `[base64,
 * "base64"]` for base64 and jsonParsed-without-a-parser responses. A parsed
 * object (a token account, say) or anything else yields null.
 */
export function decodeAccountData(data: unknown): Uint8Array | null {
  if (!Array.isArray(data) || typeof data[0] !== "string") return null;
  if (data[1] !== undefined && data[1] !== "base64") return null;
  try {
    return base64.decode(data[0]);
  } catch {
    return null;
  }
}

/**
 * The multisig behind a getAccountInfo / getMultipleAccounts value, or null
 * when the account is not owned by the program or does not parse.
 */
export function multisigFromAccount(account: unknown): ParsedMultisig | null {
  if (!isRecord(account) || account.owner !== SQUADS_V4_PROGRAM) return null;
  const bytes = decodeAccountData(account.data);
  return bytes === null ? null : parseMultisig(bytes);
}

/* ------------------------------------------------------------------ */
/* PDAs                                                                */
/* ------------------------------------------------------------------ */

const SEED_PREFIX = new TextEncoder().encode("multisig");
const SEED_VAULT = new TextEncoder().encode("vault");
const PROGRAM_ID = new PublicKey(SQUADS_V4_PROGRAM);

/** Vault PDA `index` of a multisig (the Squads SDK's getVaultPda). Throws only on a malformed key or an index outside 0..255. */
export function vaultPda(multisig: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new RangeError("vault index must be 0..255");
  const [pda] = PublicKey.findProgramAddressSync(
    [SEED_PREFIX, new PublicKey(multisig).toBytes(), SEED_VAULT, Uint8Array.of(index)],
    PROGRAM_ID,
  );
  return pda.toBase58();
}

/** memcmp offsets of member key `slot` under both layouts. */
export function memberOffsets(slot: number): [none: number, some: number] {
  return [MEMBERS_OFFSET_NONE + slot * MEMBER_LEN, MEMBERS_OFFSET_SOME + slot * MEMBER_LEN];
}

/* ------------------------------------------------------------------ */
/* Member search                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Spaces the indexed calls of every search in flight; a hold pauses them all. */
export interface RateGate {
  /** resolves when the caller may start its call */
  wait(): Promise<void>;
  /** no call starts for the next `ms` milliseconds, including the ones already waiting for their turn */
  hold(ms: number): void;
}

/**
 * Serialises call starts so that two of them are at least `minIntervalMs`
 * apart. A caller takes the next place in the queue, then sleeps until it is
 * due; a hold placed meanwhile, or a caller ahead that woke late, pushes the
 * start further, so the gap holds between actual starts and not only
 * between reservations.
 */
export function rateGate(minIntervalMs: number): RateGate {
  let nextAt = 0;
  let lastStart = 0;
  let holdUntil = 0;
  return {
    async wait() {
      const at = Math.max(Date.now(), nextAt, holdUntil);
      nextAt = at + minIntervalMs;
      for (;;) {
        const now = Date.now();
        const due = Math.max(at, holdUntil, lastStart + minIntervalMs);
        if (due <= now) {
          lastStart = now;
          return;
        }
        await sleep(due - now);
      }
    },
    hold(ms) {
      holdUntil = Math.max(holdUntil, Date.now() + ms);
    },
  };
}

/**
 * One gate per isolate, shared by every search in flight: two scans at once
 * still make eight indexed calls a second between them, and a 429 in one
 * pauses the other. Isolates do not share it, so the backoff still matters.
 */
const indexedGate = rateGate(INDEXED_MIN_INTERVAL_MS);

function memberFilters(offset: number, member: string): unknown[] {
  return [
    { memcmp: { offset: 0, bytes: MULTISIG_DISCRIMINATOR_B58 } },
    { memcmp: { offset, bytes: member } },
  ];
}

/** A base58 string of exactly 32 bytes; anything else from an index is dropped rather than passed on to the PDA derivation. */
function isPubkey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    return base58.decode(value).length === PUBKEY_LEN;
  } catch {
    return false;
  }
}

function pubkeysOf(accounts: unknown): string[] {
  if (!Array.isArray(accounts)) return [];
  const keys: string[] = [];
  for (const entry of accounts) {
    if (isRecord(entry) && isPubkey(entry.pubkey)) keys.push(entry.pubkey);
  }
  return keys;
}

interface SlotResult {
  keys: string[];
  /** the slot stopped early: enough matches for the cap, or MAX_SEARCH_PAGES reached */
  truncated: boolean;
  /** MAX_SEARCH_PAGES reached with a pagination key still pending */
  pagesExhausted: boolean;
}

/**
 * One memcmp search on the indexed RPC: getProgramAccountsV2, paginated. A
 * page scans a bounded slice of the program and may return no match while
 * `paginationKey` is set, so the loop runs until the key is null, `limit`
 * matches are in hand, or MAX_SEARCH_PAGES is reached (then truncated).
 */
async function searchSlotIndexed(
  rpc: RpcCall,
  gate: RateGate,
  offset: number,
  member: string,
  limit: number,
): Promise<SlotResult> {
  const keys: string[] = [];
  let paginationKey: string | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    await gate.wait();
    const config: Record<string, unknown> = {
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 },
      filters: memberFilters(offset, member),
      limit: SEARCH_PAGE_LIMIT,
    };
    if (paginationKey !== null) config.paginationKey = paginationKey;
    const result = await rpc("getProgramAccountsV2", [SQUADS_V4_PROGRAM, config]);
    if (Array.isArray(result)) {
      // a node that answered the v2 name with the classic shape: one full page
      keys.push(...pubkeysOf(result));
      return { keys, truncated: false, pagesExhausted: false };
    }
    if (!isRecord(result) || !Array.isArray(result.accounts)) throw new Error("unexpected getProgramAccountsV2 response");
    keys.push(...pubkeysOf(result.accounts));
    paginationKey = typeof result.paginationKey === "string" && result.paginationKey.length > 0 ? result.paginationKey : null;
    if (paginationKey === null) return { keys, truncated: false, pagesExhausted: false };
    if (keys.length >= limit) return { keys, truncated: true, pagesExhausted: false };
  }
  return { keys, truncated: true, pagesExhausted: true };
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One memcmp search as a plain getProgramAccounts on the public node, retried once on failure. */
async function searchSlotPublic(rpc: RpcCall, offset: number, member: string): Promise<SlotResult> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= PUBLIC_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    try {
      const result = await rpc("getProgramAccounts", [
        SQUADS_V4_PROGRAM,
        { encoding: "base64", dataSlice: { offset: 0, length: 0 }, filters: memberFilters(offset, member) },
      ]);
      if (!Array.isArray(result)) throw new Error("unexpected getProgramAccounts response");
      return { keys: pubkeysOf(result), truncated: false, pagesExhausted: false };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(describe(lastError));
}

/** 1 s, 2 s, 4 s … before attempt 2, 3, 4 …, each stretched by up to INDEXED_BACKOFF_JITTER. */
const backoffMs = (attempt: number): number =>
  INDEXED_BACKOFF_MS * 2 ** (attempt - 1) * (1 + Math.random() * INDEXED_BACKOFF_JITTER);

/**
 * One slot: the indexed RPC first, retried with a growing backoff that also
 * holds the shared gate (a burst of scans trips the free tier's per-second
 * limit, and the other slots in flight would keep tripping it); overloaded,
 * rate limited for good or without v2, it hands over to the public node when
 * there is one. When everything fails the error names each attempt, so the
 * report's source entry says what happened.
 */
async function searchSlot(rpc: SquadsRpc, gate: RateGate, offset: number, member: string, limit: number): Promise<SlotResult> {
  let indexedError: string | null = null;
  if (rpc.indexed !== null) {
    for (let attempt = 1; attempt <= INDEXED_ATTEMPTS; attempt += 1) {
      try {
        return await searchSlotIndexed(rpc.indexed, gate, offset, member, limit);
      } catch (error) {
        indexedError = describe(error);
        if (NO_V2_PATTERN.test(indexedError) || attempt === INDEXED_ATTEMPTS) break;
        const pause = backoffMs(attempt);
        gate.hold(pause);
        await sleep(pause);
      }
    }
  }
  if (rpc.public === null) throw new Error(indexedError ?? "no RPC serves the member search");
  try {
    return await searchSlotPublic(rpc.public, offset, member);
  } catch (error) {
    const publicError = describe(error);
    throw new Error(indexedError === null ? publicError : `private: ${indexedError}; public: ${publicError}`);
  }
}

/** Runs `fn` over `items` with at most `concurrency` in flight; the first rejection wins. */
async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

/** getMultipleAccounts (base64) for up to 100 keys per call; accounts that vanished or do not parse are dropped. */
async function fetchMultisigs(rpc: RpcCall, keys: string[]): Promise<MultisigAccount[]> {
  const out: MultisigAccount[] = [];
  for (let start = 0; start < keys.length; start += MULTIPLE_ACCOUNTS_MAX) {
    const batch = keys.slice(start, start + MULTIPLE_ACCOUNTS_MAX);
    const result = await rpc("getMultipleAccounts", [batch, { encoding: "base64" }]);
    const values = isRecord(result) && Array.isArray(result.value) ? result.value : null;
    if (values === null) throw new Error("unexpected getMultipleAccounts response");
    values.forEach((account, i) => {
      const parsed = multisigFromAccount(account);
      if (parsed !== null) out.push({ ...parsed, address: batch[i] });
    });
  }
  return out;
}

/**
 * Multisigs that list `member` in one of the first MEMBER_SLOTS member
 * slots, under either layout: 2 × MEMBER_SLOTS filtered getProgramAccounts
 * calls fetching pubkeys only, then one getMultipleAccounts for the bodies.
 * Deduped, capped at `limit`; once the cap is reached the remaining slots are
 * skipped and the result is marked truncated. Throws when a slot cannot be
 * searched at all (the caller records the source as failed). The indexed
 * calls go through `gate`, by default the isolate-wide one.
 */
export async function findMultisigsForMember(
  rpc: SquadsRpc,
  member: string,
  limit: number,
  gate: RateGate = indexedGate,
): Promise<MemberSearch> {
  const slots: number[] = [];
  for (let slot = 0; slot < MEMBER_SLOTS; slot += 1) slots.push(...memberOffsets(slot));

  const found = new Set<string>();
  let truncated = false;
  let pagesExhausted = false;
  let slotsSearched = 0;
  await mapLimit(slots, SEARCH_CONCURRENCY, async (offset) => {
    if (found.size >= limit) {
      truncated = true;
      return;
    }
    const result = await searchSlot(rpc, gate, offset, member, limit);
    slotsSearched += 1;
    if (result.pagesExhausted) pagesExhausted = true;
    else if (result.truncated) truncated = true;
    for (const key of result.keys) found.add(key);
  });

  const keys = [...found];
  if (keys.length > limit) truncated = true;
  const multisigs = keys.length === 0 ? [] : await fetchMultisigs(rpc.any, keys.slice(0, limit));
  // A member cannot be listed twice in one multisig, but the body is what counts: keep only real memberships.
  return {
    multisigs: multisigs.filter((m) => m.members.some((x) => x.key === member)),
    truncated,
    pagesExhausted,
    slotsSearched,
  };
}

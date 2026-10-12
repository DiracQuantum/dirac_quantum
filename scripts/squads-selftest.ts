/**
 * Self-test for the Squads v4 detection module (worker/squads.ts) and, when
 * a Worker URL is given, the scanner v3 report end to end. Run from the
 * project root:
 *   node scripts/squads-selftest.ts                       pure checks only
 *   node scripts/squads-selftest.ts http://localhost:8794 plus live scans
 * Prints PASS/FAIL per check and exits with code 1 on any failure. With
 * SQUADS_PAUSE_MS=45000 the live scans are spaced out, for a local Worker
 * whose RPC_URL is the production proxy (120 calls per minute per client).
 *
 * The fixtures are three real mainnet multisig accounts fetched on
 * 2026-10-10: one with a rent collector and 297 bytes of slack, one with a
 * rent collector and no slack, one without a rent collector (32 bytes of
 * slack). The live part scans a multisig, one of its members and a plain
 * wallet; it spends three scans of the per-minute allowance.
 */

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        return next(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const squads = await import("../worker/squads.ts");
const { base58, base64 } = await import("@scure/base");

const {
  MEMBERS_OFFSET_NONE,
  MEMBERS_OFFSET_SOME,
  MEMBER_LEN,
  MEMBER_SLOTS,
  MULTISIG_DISCRIMINATOR,
  MULTISIG_DISCRIMINATOR_B58,
  SQUADS_V4_PROGRAM,
  decodeAccountData,
  findMultisigsForMember,
  memberOffsets,
  multisigFromAccount,
  parseMultisig,
  rateGate,
  vaultPda,
} = squads;

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (ok) passed++;
  else failed++;
}

/* --- fixtures ------------------------------------------------------- */

interface Fixture {
  address: string;
  data: string;
  expect: {
    createKey: string;
    threshold: number;
    rentCollector: string | null;
    bump: number;
    members: [string, number][];
    membersOffset: number;
    vault0: string;
  };
}

const FIXTURES: Fixture[] = [
  {
    address: "11B3cVBhBAryMehSmUwKr3ogJ13Dxy6CGPRjSZ6sS6s",
    data: "4HR5ukShT+yVedfNBJOv6i25qry1AfNzyaw21A+uqCsgIM0FzPXSFwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAABwAAAAAAAAAFAAAAAAAAAAGMqUZFX5dJ67bpqd2TTt6yltwxfB5Q9qoRGnuA2aOVKv0DAAAAHTr2O7cJxuvUnuCAbp4QEHmvuDKOeLvaBuOd8bdv45oCTcurBZcY/WgFHkb/qp25ji+vEAog+QMoudZor+euU/IHaGFGh0uPj/Czxkibd9qe8xp+EBE/Eo17tKW6ca1EukMHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expect: {
      createKey: "B4VWKXo1x5uTgRR1saMcJWSz4Bok4P9src6134tN6uPL",
      threshold: 2,
      rentCollector: "AU5nXSAaYyLdRHzF5ZCVeexETa3LJbpQRADJRAvrkRjX",
      bump: 253,
      members: [
        ["2y6yE3CQv3gcDdkdefEdLmUK4rHFNWwEGZMZAc4AXH5K", 2],
        ["6EgX2qUX4y6XdQNDyaxd1mWExqym6u15tarXdpTyy5Pf", 7],
        ["82TS2cbriw925Qp2PD8h6HVYaWYAEyRN5mPGkbvZvep2", 7],
      ],
      membersOffset: MEMBERS_OFFSET_SOME,
      vault0: "CHkCBLAL4vWedF8oCvqMJ5Z7HfBYCyLRFvZT8rcfqXdN",
    },
  },
  {
    address: "11dEG3B6LHrhpwzScKtx4HNY3Nmdp9uCRvJJpCMoTdS",
    data: "4HR5ukShT+wp7XeaP17XuNzkvdDSaIb9b+5+Jf3gmWr1/gu08R6HdwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAFH3IUQgF1Zz+dcEMWYKiON1qlZ3+g8GoUXI4/EnhGKvfoCAAAAfk0ULoyYO0YHthohq13enlaJx07Zaog2S+FciSKhWtsH0j0YmQcR/V7vf3HrgulOQhdlIj2wu10J/mkudRPSZNUC",
    expect: {
      createKey: "3pfjW9LxMx1F5nLTV8woeTbZaeaQehyN1ncxfvHy8T9g",
      threshold: 2,
      rentCollector: "5qWya6UjwWnGVhdSBL3hyZ7B45jbk6Byt1hwd7ohEGXE",
      bump: 250,
      members: [
        ["9W2YFdKA4rKtyR5xPSZB8YKbqrFLENcvDkc9439J3dLW", 7],
        ["F9geiLAzz9SfRafCiHT1Z51k4nbnw2Xwe6NDXuKPs5Sk", 2],
      ],
      membersOffset: MEMBERS_OFFSET_SOME,
      vault0: "DNW7WjE2Cobaihps8V9EdfML8zPYpVavW34ioBfpFeSV",
    },
  },
  {
    address: "12dEW8L9GqAXTkFKkz1wWRzFZCMmiPeYkX7Vg7FqFp2",
    data: "4HR5ukShT+whfdJQ8GbVGQa345x6WP09oIBhOkXh1tCfZNfhrco4+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AQAAABNy4LG510VgR25FteJvQURYuMVXkYR6qEbA00AHSREZBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expect: {
      createKey: "3FjjQtpH93huyRdvyD3vAEV1fg3EaGuHnALBQ5G4GsRR",
      threshold: 1,
      rentCollector: null,
      bump: 255,
      members: [["2JvLzXomThTBMSj2YQY3wE21kiaSpwGyJ17nm9xiLMsE", 7]],
      membersOffset: MEMBERS_OFFSET_NONE,
      vault0: "3G3QtmjuD3A7EoLuszkQtHMPw49HfZwhNj2WkkY4maoz",
    },
  },
];

/* --- pure checks ---------------------------------------------------- */

check(
  "discriminator is sha256('account:Multisig')[0..8]",
  Array.from(MULTISIG_DISCRIMINATOR).join(",") === "224,116,121,186,68,161,79,236" && MULTISIG_DISCRIMINATOR_B58 === "eYVgUYyJkvP",
  MULTISIG_DISCRIMINATOR_B58,
);
check("member offsets", memberOffsets(0).join(",") === "100,132" && memberOffsets(9).join(",") === `${100 + 9 * MEMBER_LEN},${132 + 9 * MEMBER_LEN}`);
check("ten member slots", MEMBER_SLOTS === 10);

for (const f of FIXTURES) {
  const bytes = base64.decode(f.data);
  const parsed = parseMultisig(bytes);
  const tagName = f.expect.rentCollector === null ? "no rent collector" : "with rent collector";
  check(`parse ${f.address.slice(0, 8)} (${tagName}, ${bytes.length} bytes)`, parsed !== null);
  if (parsed === null) continue;
  check("  createKey", parsed.createKey === f.expect.createKey, parsed.createKey);
  check("  config authority is the multisig itself", parsed.selfGoverned && parsed.configAuthority === "11111111111111111111111111111111");
  check("  threshold", parsed.threshold === f.expect.threshold, String(parsed.threshold));
  check("  time lock 0", parsed.timeLock === 0);
  check("  rent collector", parsed.rentCollector === f.expect.rentCollector, String(parsed.rentCollector));
  check("  bump", parsed.bump === f.expect.bump, String(parsed.bump));
  check("  members offset", parsed.membersOffset === f.expect.membersOffset, String(parsed.membersOffset));
  check("  member count", parsed.members.length === f.expect.members.length, String(parsed.members.length));
  f.expect.members.forEach(([key, mask], i) => {
    const m = parsed.members[i];
    check(`  member ${i}`, m !== undefined && m.key === key && m.mask === mask, m ? `${m.key.slice(0, 8)} mask ${m.mask}` : "missing");
    if (m) {
      check(`  member ${i} permission bits`, m.initiate === ((mask & 1) !== 0) && m.vote === ((mask & 2) !== 0) && m.execute === ((mask & 4) !== 0));
    }
  });
  check("  vault 0 PDA", vaultPda(f.address, 0) === f.expect.vault0, vaultPda(f.address, 0));
  check(
    "  multisigFromAccount with a base64 account record",
    multisigFromAccount({ owner: SQUADS_V4_PROGRAM, data: [f.data, "base64"] })?.createKey === f.expect.createKey,
  );
  check("  multisigFromAccount rejects another owner", multisigFromAccount({ owner: "11111111111111111111111111111111", data: [f.data, "base64"] }) === null);

  // Garbage must come back as null, never throw.
  const bad: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["too short", bytes.slice(0, 50)],
    ["cut inside members", bytes.slice(0, f.expect.membersOffset + 10)],
    ["wrong discriminator", (() => { const b = bytes.slice(); b[0] ^= 1; return b; })()],
    ["option tag 2", (() => { const b = bytes.slice(); b[94] = 2; return b; })()],
    ["threshold 0", (() => { const b = bytes.slice(); b[72] = 0; b[73] = 0; return b; })()],
    ["threshold above member count", (() => { const b = bytes.slice(); b[72] = 200; b[73] = 0; return b; })()],
    ["member count 0", (() => { const b = bytes.slice(); const at = f.expect.membersOffset - 4; b[at] = 0; b[at + 1] = 0; b[at + 2] = 0; b[at + 3] = 0; return b; })()],
    ["member count beyond the data", (() => { const b = bytes.slice(); const at = f.expect.membersOffset - 4; b[at] = 255; b[at + 1] = 255; b[at + 2] = 0; b[at + 3] = 0; return b; })()],
    ["random bytes", crypto.getRandomValues(new Uint8Array(300))],
  ];
  for (const [name, data] of bad) {
    let result: unknown = "threw";
    try {
      result = parseMultisig(data);
    } catch {
      result = "threw";
    }
    check(`  garbage: ${name} → null`, result === null);
  }
}

check("decodeAccountData accepts [base64, 'base64']", decodeAccountData([FIXTURES[2].data, "base64"])?.length === 165);
check("decodeAccountData rejects parsed objects", decodeAccountData({ parsed: {} }) === null && decodeAccountData(["abc", "base58"]) === null && decodeAccountData("x") === null);
check("vaultPda rejects index 256", (() => { try { vaultPda(FIXTURES[0].address, 256); return false; } catch { return true; } })());
check("vaultPda index 1 differs from index 0", vaultPda(FIXTURES[0].address, 1) !== vaultPda(FIXTURES[0].address, 0));

// findMultisigsForMember against a fake RPC: slot hits are merged, deduped, capped, bodies parsed, and a non-member body dropped.
{
  const member = FIXTURES[1].expect.members[0][0];
  const calls: string[] = [];
  const fakeIndexed = async (method: string, params: unknown): Promise<unknown> => {
    calls.push(method);
    const [, config] = params as [string, { filters: { memcmp: { offset: number } }[]; paginationKey?: string }];
    const offset = config.filters[1].memcmp.offset;
    if (offset === MEMBERS_OFFSET_SOME) {
      // two pages: an empty one with a key, then the hits (one listed twice to test the dedupe)
      if (!config.paginationKey) return { accounts: [], paginationKey: "next" };
      return { accounts: [{ pubkey: FIXTURES[1].address }, { pubkey: FIXTURES[1].address }, { pubkey: FIXTURES[2].address }], paginationKey: null };
    }
    return { accounts: [], paginationKey: null };
  };
  const fakeAny = async (method: string, params: unknown): Promise<unknown> => {
    calls.push(method);
    const [keys] = params as [string[]];
    return {
      value: keys.map((k) => {
        const f = FIXTURES.find((x) => x.address === k);
        return f ? { owner: SQUADS_V4_PROGRAM, data: [f.data, "base64"] } : null;
      }),
    };
  };
  const result = await findMultisigsForMember(
    { indexed: fakeIndexed, public: async () => { throw new Error("public must not be called"); }, any: fakeAny },
    member,
    20,
  );
  check("fake search: one membership found, the non-member body dropped", result.multisigs.length === 1 && result.multisigs[0].address === FIXTURES[1].address, JSON.stringify(result.multisigs.map((m) => m.address)));
  check("fake search: every slot searched", result.slotsSearched === 2 * MEMBER_SLOTS && !result.truncated, `${result.slotsSearched} slots`);
  check("fake search: 21 v2 calls and one getMultipleAccounts", calls.filter((c) => c === "getProgramAccountsV2").length === 2 * MEMBER_SLOTS + 1 && calls.filter((c) => c === "getMultipleAccounts").length === 1, `${calls.length} calls`);

  // The indexed RPC failing hands the slot to the public node.
  const publicCalls: number[] = [];
  const result2 = await findMultisigsForMember(
    {
      indexed: async () => { throw new Error("account index service overloaded"); },
      public: async (_method, params) => {
        const [, config] = params as [string, { filters: { memcmp: { offset: number } }[] }];
        publicCalls.push(config.filters[1].memcmp.offset);
        return config.filters[1].memcmp.offset === MEMBERS_OFFSET_SOME ? [{ pubkey: FIXTURES[1].address }] : [];
      },
      any: fakeAny,
    },
    member,
    20,
  );
  check("fake search: public fallback after an indexed failure", result2.multisigs.length === 1 && publicCalls.length === 2 * MEMBER_SLOTS);

  // Both failing: the search throws (the scanner records the source as failed).
  let threw = false;
  try {
    await findMultisigsForMember({ indexed: null, public: async () => { throw new Error("429"); }, any: fakeAny }, member, 20);
  } catch {
    threw = true;
  }
  check("fake search: throws when no node answers", threw);

  // No indexed RPC and no public node: the search cannot run at all.
  let threwWithoutNodes = false;
  try {
    await findMultisigsForMember({ indexed: null, public: null, any: fakeAny }, member, 20);
  } catch {
    threwWithoutNodes = true;
  }
  check("fake search: throws without any node", threwWithoutNodes);

  // The cap: 25 hits in one slot, limit 20 → truncated, 20 bodies requested.
  // Keys are real 32-byte values: anything else from an index is dropped.
  const fakeKey = (i: number): string => base58.encode(new Uint8Array(32).fill(i + 1));
  let requested = 0;
  const result3 = await findMultisigsForMember(
    {
      indexed: async (_m, params) => {
        const [, config] = params as [string, { filters: { memcmp: { offset: number } }[] }];
        if (config.filters[1].memcmp.offset !== MEMBERS_OFFSET_NONE) return { accounts: [], paginationKey: null };
        return { accounts: Array.from({ length: 25 }, (_, i) => ({ pubkey: fakeKey(i) })), paginationKey: null };
      },
      public: async () => [],
      any: async (_m, params) => {
        const [keys] = params as [string[]];
        requested = keys.length;
        return { value: keys.map(() => null) };
      },
    },
    member,
    20,
  );
  check("fake search: capped at the limit and marked truncated", result3.truncated && requested === 20 && result3.multisigs.length === 0, `${requested} bodies requested`);

  // An index answering with strings that are not pubkeys: they never reach getMultipleAccounts or the PDA derivation.
  const requestedKeys: string[] = [];
  const result4 = await findMultisigsForMember(
    {
      indexed: async (_m, params) => {
        const [, config] = params as [string, { filters: { memcmp: { offset: number } }[] }];
        if (config.filters[1].memcmp.offset !== MEMBERS_OFFSET_SOME) return { accounts: [], paginationKey: null };
        return { accounts: [{ pubkey: "k0" }, { pubkey: "0OIl" }, { pubkey: "" }, { pubkey: 7 }, { pubkey: FIXTURES[1].address }], paginationKey: null };
      },
      public: null,
      any: async (method, params) => {
        const [keys] = params as [string[]];
        requestedKeys.push(...keys);
        return fakeAny(method, params);
      },
    },
    member,
    20,
  );
  check(
    "fake search: non-key strings from the index are dropped",
    requestedKeys.length === 1 && requestedKeys[0] === FIXTURES[1].address && result4.multisigs.length === 1,
    JSON.stringify(requestedKeys),
  );

  // Two searches at once share one gate: their indexed calls, taken together, keep the gate's spacing.
  {
    const SPACING_MS = 40;
    const gate = rateGate(SPACING_MS);
    const starts: number[] = [];
    const timed = async (): Promise<unknown> => {
      starts.push(Date.now());
      return { accounts: [], paginationKey: null };
    };
    const rpc = { indexed: timed, public: null, any: fakeAny };
    await Promise.all([findMultisigsForMember(rpc, member, 20, gate), findMultisigsForMember(rpc, member, 20, gate)]);
    starts.sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < starts.length; i += 1) minGap = Math.min(minGap, starts[i] - starts[i - 1]);
    check(
      "shared gate: two concurrent searches keep the spacing between them",
      starts.length === 4 * MEMBER_SLOTS && minGap >= SPACING_MS - 5,
      `${starts.length} calls, shortest gap ${minGap} ms`,
    );
  }

  // A 429 on one slot: the slot is retried after a backoff of at least a second, and the gate is held so no other slot calls meanwhile.
  {
    const gate = rateGate(10);
    const starts: number[] = [];
    let refusedAt = -1;
    const result5 = await findMultisigsForMember(
      {
        indexed: async (_m, params) => {
          starts.push(Date.now());
          const [, config] = params as [string, { filters: { memcmp: { offset: number } }[] }];
          if (config.filters[1].memcmp.offset === MEMBERS_OFFSET_SOME && refusedAt < 0) {
            refusedAt = Date.now();
            throw new Error("rpc upstream unavailable: mainnet.helius-rpc.com responded 429");
          }
          return config.filters[1].memcmp.offset === MEMBERS_OFFSET_SOME ? { accounts: [{ pubkey: FIXTURES[1].address }], paginationKey: null } : { accounts: [], paginationKey: null };
        },
        public: null,
        any: fakeAny,
      },
      member,
      20,
      gate,
    );
    const after = starts.filter((t) => t > refusedAt);
    const firstAfter = after.length > 0 ? Math.min(...after) - refusedAt : -1;
    check(
      "429 backoff: the slot is retried and found",
      result5.multisigs.length === 1 && starts.length === 2 * MEMBER_SLOTS + 1,
      `${starts.length} calls`,
    );
    check("429 backoff: the gate is held, no call for at least a second", refusedAt >= 0 && firstAfter >= 995, `${firstAfter} ms`);
  }
}

/* --- live checks ---------------------------------------------------- */

const BASE = (process.argv[2] ?? "").replace(/\/+$/, "");
/** Pause between live scans (ms): a Worker whose RPC_URL is the production proxy spends that proxy's per-minute allowance on every scan. */
const PAUSE_MS = Number(process.env.SQUADS_PAUSE_MS ?? 0);
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

interface Report {
  v: number;
  address: { kind: string };
  sources: Record<string, { status: string; error?: string }>;
  confidence: string;
  multisigs: {
    self: { address: string; threshold: number; memberCount: number; members: { key: string }[]; vault: { address: string; sol: number | null; usd: number | null } | null } | null;
    memberOf: { address: string; threshold: number; memberCount: number; vault: { usd: number | null } | null }[];
    memberOfTruncated: boolean;
    coControlledUsd: number | null;
    valued: number;
    note: string;
  };
  recommendations: string[];
  exposure: { note: string };
}

async function scan(wallet: string): Promise<Report> {
  const res = await fetch(`${BASE}/api/scan/${wallet}`, { headers: { Accept: "application/json" } });
  const body = (await res.json()) as Report & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
  return body;
}

if (BASE) {
  console.log(`\nlive checks against ${BASE}`);
  const multisig = FIXTURES[2];
  const memberWallet = multisig.expect.members[0][0];
  const plainWallet = "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK";

  // 1. the multisig itself
  const r1 = await scan(multisig.address);
  console.log(`  ${multisig.address}: kind ${r1.address.kind}, multisigs ${r1.sources.multisigs?.status}, confidence ${r1.confidence}`);
  check("report v3", r1.v === 3);
  check("multisig address classified as multisig", r1.address.kind === "multisig");
  check("self parsed: threshold and members", r1.multisigs.self?.threshold === 1 && r1.multisigs.self?.memberCount === 1 && r1.multisigs.self?.members[0]?.key === memberWallet);
  check("self vault 0 derived and valued", r1.multisigs.self?.vault?.address === multisig.expect.vault0 && (r1.multisigs.self?.vault?.sol ?? 0) >= 0.001, JSON.stringify(r1.multisigs.self?.vault));
  check("multisig recommendations name the signer keys", r1.recommendations.some((x) => /signer keys/i.test(x)), r1.recommendations.join(" | "));
  check("exposure note points at the vaults", /vault/i.test(r1.exposure.note), r1.exposure.note);
  console.log(`  note: ${r1.multisigs.note}`);

  // 2. its member
  await pause();
  const r2 = await scan(memberWallet);
  console.log(`  ${memberWallet}: kind ${r2.address.kind}, multisigs ${r2.sources.multisigs?.status} ${r2.sources.multisigs?.error ?? ""}, confidence ${r2.confidence}`);
  check("member wallet is a wallet", r2.address.kind === "wallet");
  check("membership source answered", r2.sources.multisigs?.status === "ok" || r2.sources.multisigs?.status === "truncated", r2.sources.multisigs?.error);
  check("member wallet lists the multisig", r2.multisigs.memberOf.some((m) => m.address === multisig.address), `${r2.multisigs.memberOf.length} memberships`);
  check("membership carries threshold and member count", r2.multisigs.memberOf.every((m) => m.threshold >= 1 && m.memberCount >= m.threshold));
  check("co-controlled figure present", r2.multisigs.coControlledUsd !== null && r2.multisigs.valued >= 1, String(r2.multisigs.coControlledUsd));
  check("member recommendations mention thresholds", r2.recommendations.some((x) => /threshold/i.test(x)), r2.recommendations.join(" | "));
  console.log(`  note: ${r2.multisigs.note}`);

  // 3. a plain wallet: v2 fields unchanged, the new source present and empty
  await pause();
  const r3 = await scan(plainWallet);
  console.log(`  ${plainWallet}: kind ${r3.address.kind}, multisigs ${r3.sources.multisigs?.status} ${r3.sources.multisigs?.error ?? ""}, confidence ${r3.confidence}`);
  check("plain wallet is a wallet", r3.address.kind === "wallet");
  check("plain wallet: multisigs source present", r3.sources.multisigs !== undefined, r3.sources.multisigs?.status);
  check("plain wallet: no memberships, null co-controlled figure", r3.multisigs.self === null && r3.multisigs.memberOf.length === 0 && r3.multisigs.coControlledUsd === null);
  check("plain wallet: v2 sources still present", ["address", "balance", "assets", "signatures", "stake", "mintAuthorities", "programAuthorities", "price", "registry"].every((k) => r3.sources[k] !== undefined));
  check("plain wallet: no multisig recommendation", !r3.recommendations.some((x) => /Squads multisig/.test(x)), r3.recommendations.join(" | "));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

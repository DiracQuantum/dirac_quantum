/**
 * Self-test for USDC with a sealed note (src/lib/solana/usdc.ts and the
 * payment claim in src/lib/inbox.ts): instruction encoding, associated token
 * account derivation against known mainnet pairs, the memo format, amount
 * parsing and formatting, token account decoding, and the server's on-chain
 * check against a jsonParsed getTransaction fixture built by hand below (its
 * shape copied from a mainnet USDC TransferChecked), and the re-check of a
 * pending payment on an inbox read (worker/inbox.ts over an in-memory SQLite
 * with every migration, RPC stubbed): 8 empty checks, the 15-minute expiry
 * after 3, an unreachable RPC spending none. Run from the project root:
 *   node scripts/usdc-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure.
 *
 * The site's modules use the "@/" alias and extensionless relative imports;
 * a resolve hook handles both, then the modules are loaded dynamically.
 */

import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      return next(pathToFileURL(`${path.join(ROOT, "src", specifier.slice(2))}.ts`).href, context);
    }
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

const usdc = await import("../src/lib/solana/usdc.ts");
const memoModule = await import("../src/lib/solana/memo.ts");
const inbox = await import("../src/lib/inbox.ts");
const { Keypair, PublicKey, Transaction } = await import("@solana/web3.js");
const { base58 } = await import("@scure/base");
const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");

const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ATA_CREATE_IDEMPOTENT,
  MEMO_PROGRAM_ID,
  PAY_MEMO_PREFIX,
  SYSTEM_PROGRAM_ID,
  TOKEN_ACCOUNT_LEN,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  TOKEN_PROGRAM_ID,
  TOKEN_TRANSFER_CHECKED,
  USDC_DECIMALS,
  USDC_MINT,
  associatedTokenAddress,
  checkUsdcPayment,
  createAtaIdempotentIx,
  decodeTokenAccount,
  formatUsdc,
  memoIx,
  parseUsdcAmount,
  payMemo,
  transferCheckedData,
  transferCheckedIx,
  usdcPaymentInstructions,
} = usdc;

let failed = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (ok) passed++;
  else failed++;
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/* ------------------------------------------------------------------ */
/* Program ids                                                         */
/* ------------------------------------------------------------------ */

for (const [name, id] of [
  ["USDC mint", USDC_MINT],
  ["Token program", TOKEN_PROGRAM_ID],
  ["Associated Token program", ASSOCIATED_TOKEN_PROGRAM_ID],
  ["System program", SYSTEM_PROGRAM_ID],
  ["Memo program", MEMO_PROGRAM_ID],
] as const) {
  check(`${name} id decodes to 32 bytes`, base58.decode(id).length === 32);
}
check("memo program id equals the one memo.ts uses", memoModule.MEMO_PROGRAM_ID.toBase58() === MEMO_PROGRAM_ID);
check("token account rent is the rent-exempt minimum of 165 bytes", TOKEN_ACCOUNT_RENT_LAMPORTS === (TOKEN_ACCOUNT_LEN + 128) * 3480 * 2);
check("wallet reserve is the rent-exempt minimum of 0 bytes", usdc.WALLET_RENT_RESERVE_LAMPORTS === (0 + 128) * 3480 * 2);

/* ------------------------------------------------------------------ */
/* ATA derivation against mainnet                                      */
/* ------------------------------------------------------------------ */

// Wallet → USDC associated token account, read on mainnet (getAccountInfo jsonParsed of the
// address: an initialized USDC token account owned by the wallet; only the ATA program can
// create an account at that address). The third pair has bump 252, not 255.
const KNOWN_ATAS: [string, string][] = [
  ["3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5", "36fxfThaVgasRvyP7p2xYwqabBtpQm5t7qmj9G9k7cEE"],
  ["FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT", "7xrjio4HMDaBCXCHdFoqBUvP3epvh7DKnECpmVBZ5ZW3"],
  ["GMCJvYGf5Ex2ARiMquaBDqU6iKM8uiEQkB8jCnoNfHpC", "7JoQuAFR4dCVwF8QUhFA4ERrkEuC4jxrdy8CGFz3AVEJ"],
];
for (const [owner, ata] of KNOWN_ATAS) {
  const derived = associatedTokenAddress(owner).toBase58();
  check(`USDC ATA of ${owner.slice(0, 4)}… is ${ata.slice(0, 4)}…`, derived === ata, derived === ata ? "" : `got ${derived}`);
}
check("ATA accepts a PublicKey and a string alike", associatedTokenAddress(new PublicKey(KNOWN_ATAS[0][0])).toBase58() === KNOWN_ATAS[0][1]);
check("ATA is off curve", !PublicKey.isOnCurve(associatedTokenAddress(KNOWN_ATAS[0][0]).toBytes()));

/* ------------------------------------------------------------------ */
/* Instruction encoding                                                */
/* ------------------------------------------------------------------ */

const sender = Keypair.fromSeed(new Uint8Array(32).fill(7));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(9));
const S = sender.publicKey.toBase58();
const R = recipient.publicKey.toBase58();
const senderAta = associatedTokenAddress(S).toBase58();
const recipientAta = associatedTokenAddress(R).toBase58();

{
  const ix = createAtaIdempotentIx(S, recipientAta, R);
  const flags = ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"}`);
  check("createIdempotent: ATA program", ix.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID);
  check("createIdempotent: data is [1]", ix.data.length === 1 && ix.data[0] === ATA_CREATE_IDEMPOTENT && ATA_CREATE_IDEMPOTENT === 1);
  check(
    "createIdempotent: payer sw, account w, owner, mint, system, token",
    JSON.stringify(flags) ===
      JSON.stringify([
        `${S}:sw`,
        `${recipientAta}:-w`,
        `${R}:--`,
        `${USDC_MINT}:--`,
        `${SYSTEM_PROGRAM_ID}:--`,
        `${TOKEN_PROGRAM_ID}:--`,
      ]),
    JSON.stringify(flags),
  );
}

{
  check("transferChecked data, 12.50 USDC", hex(transferCheckedData(12_500_000, 6)) === "0c20bcbe000000000006");
  check("transferChecked data, one base unit", hex(transferCheckedData(1, 6)) === "0c010000000000000006");
  check(
    "transferChecked data, u64 max as bigint",
    hex(transferCheckedData(BigInt("18446744073709551615"), 6)) === "0cffffffffffffffff06",
  );
  check("transferChecked refuses zero", throws(() => transferCheckedData(0, 6)));
  check("transferChecked refuses above u64", throws(() => transferCheckedData(BigInt("18446744073709551616"), 6)));
  check("transferChecked refuses decimals 256", throws(() => transferCheckedData(1, 256)));
  const ix = transferCheckedIx(senderAta, USDC_MINT, recipientAta, S, 12_500_000, USDC_DECIMALS);
  const flags = ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"}`);
  check("transferChecked: Token program", ix.programId.toBase58() === TOKEN_PROGRAM_ID);
  check("transferChecked: instruction 12", ix.data[0] === TOKEN_TRANSFER_CHECKED && TOKEN_TRANSFER_CHECKED === 12);
  check(
    "transferChecked: source w, mint, destination w, owner s",
    JSON.stringify(flags) === JSON.stringify([`${senderAta}:-w`, `${USDC_MINT}:--`, `${recipientAta}:-w`, `${S}:s-`]),
    JSON.stringify(flags),
  );
}

/* ------------------------------------------------------------------ */
/* Memo                                                                */
/* ------------------------------------------------------------------ */

const kem = ml_kem768.keygen(new Uint8Array(64).fill(3));
const envelope = inbox.encryptLetter({ v: 1, text: "Invoice 2026-114, net 30.", from: S, sent_at: 1_760_000_000_000 }, kem.publicKey);
const hash = inbox.envelopeHash(envelope);
const memo = payMemo(hash);
check("memo is dirac:pay:v1:<first 32 hex of the envelope hash>", memo === `dirac:pay:v1:${hash.slice(0, 32)}`, memo);
check("memo prefix constant", PAY_MEMO_PREFIX === "dirac:pay:v1:");
check("memo is 45 bytes of ASCII", Buffer.byteLength(memo, "utf8") === 45 && /^dirac:pay:v1:[0-9a-f]{32}$/.test(memo));
check("memo refuses a short hash", throws(() => payMemo(hash.slice(0, 32))));
check("memo refuses upper-case hex", throws(() => payMemo(hash.toUpperCase())));
{
  const ix = memoIx(memo);
  check("memo instruction: memo program, no accounts, utf8 data", ix.programId.toBase58() === MEMO_PROGRAM_ID && ix.keys.length === 0 && ix.data.toString("utf8") === memo);
}

/* ------------------------------------------------------------------ */
/* The whole transaction                                               */
/* ------------------------------------------------------------------ */

{
  const ixs = usdcPaymentInstructions({ from: S, to: R, amount: 12_500_000, envelopeHash: hash });
  check(
    "payment: create, transfer, memo in that order",
    ixs.map((i) => i.programId.toBase58()).join() === [ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID].join(),
  );
  check("payment: transfer from the sender's ATA to the recipient's", ixs[1].keys[0].pubkey.toBase58() === senderAta && ixs[1].keys[2].pubkey.toBase58() === recipientAta);
  check("payment: refuses paying yourself", throws(() => usdcPaymentInstructions({ from: S, to: S, amount: 1, envelopeHash: hash })));
  check("payment: refuses a fractional amount", throws(() => usdcPaymentInstructions({ from: S, to: R, amount: 1.5, envelopeHash: hash })));

  const tx = new Transaction({ feePayer: sender.publicKey, blockhash: base58.encode(new Uint8Array(32).fill(1)), lastValidBlockHeight: 1 });
  tx.add(...ixs);
  tx.sign(sender);
  const wire = tx.serialize();
  const back = Transaction.from(wire);
  check("legacy transaction fits one packet", wire.length <= 1232, `${wire.length} bytes`);
  check("one signature, the sender's", back.signatures.length === 1 && back.signatures[0].publicKey.equals(sender.publicKey) && back.verifySignatures());
  check("round trip keeps the three instructions", back.instructions.length === 3 && hex(back.instructions[1].data) === "0c20bcbe000000000006" && back.instructions[2].data.toString("utf8") === memo);
}

/* ------------------------------------------------------------------ */
/* Amounts                                                             */
/* ------------------------------------------------------------------ */

const amountCases: [string, number | null][] = [
  ["12.5", 12_500_000],
  ["12.50", 12_500_000],
  ["0.01", 10_000],
  [".5", 500_000],
  ["12.", 12_000_000],
  ["  7 ", 7_000_000],
  ["1000000", 1_000_000_000_000],
  ["0", null],
  ["0.00", null],
  ["1.001", null],
  ["-1", null],
  ["1e3", null],
  ["1,000", null],
  ["", null],
  ["9999999999", null],
];
for (const [input, want] of amountCases) {
  const got = parseUsdcAmount(input);
  const ok = want === null ? !got.ok : got.ok && got.units === want;
  check(`parse ${JSON.stringify(input)} → ${want ?? "refused"}`, ok, got.ok ? String(got.units) : got.error);
}
check("parse with 6 decimals allowed", (() => {
  const r = parseUsdcAmount("0.000001", 6);
  return r.ok && r.units === 1;
})());

const formatCases: [number | bigint, string][] = [
  [12_500_000, "12.50"],
  [1, "0.000001"],
  [0, "0.00"],
  [1_000_000, "1.00"],
  [1_500_001, "1.500001"],
  [1_234_567_890_000, "1,234,567.89"],
  [BigInt("61133962851"), "61,133.962851"],
];
for (const [units, want] of formatCases) {
  const got = formatUsdc(units);
  check(`format ${String(units)} → ${want}`, got === want, got);
}

/* ------------------------------------------------------------------ */
/* Token account data                                                  */
/* ------------------------------------------------------------------ */

{
  const data = new Uint8Array(TOKEN_ACCOUNT_LEN);
  data.set(base58.decode(USDC_MINT), 0);
  data.set(sender.publicKey.toBytes(), 32);
  new DataView(data.buffer).setBigUint64(64, BigInt(120_450_000), true);
  data[108] = 1;
  const acc = decodeTokenAccount(data);
  check("token account decodes mint, owner, amount, state", !!acc && acc.mint === USDC_MINT && acc.owner === S && acc.amount === BigInt(120_450_000) && acc.state === 1);
  check("token account of the wrong size is null", decodeTokenAccount(data.subarray(0, 100)) === null);
}

/* ------------------------------------------------------------------ */
/* Server check against a jsonParsed fixture                           */
/* ------------------------------------------------------------------ */

const AMOUNT = 12_500_000;
const SIG = base58.encode(new Uint8Array(64).fill(5));

function tokenBalance(accountIndex: number, owner: string, amount: string, mint = USDC_MINT) {
  return {
    accountIndex,
    mint,
    owner,
    programId: TOKEN_PROGRAM_ID,
    uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: String(Number(amount) / 1e6) },
  };
}

/** A confirmed legacy transaction as getTransaction (jsonParsed) returns it for the site's payment. */
function fixture() {
  const key = (pubkey: string, signer: boolean, writable: boolean) => ({ pubkey, signer, source: "transaction", writable });
  return {
    blockTime: 1_760_000_100,
    slot: 455_688_153,
    version: "legacy",
    meta: {
      err: null,
      fee: 5000,
      status: { Ok: null },
      innerInstructions: [],
      logMessages: [],
      preBalances: [50_000_000, 2_039_280, 0, 0, 1, 1, 1, 1, 1],
      postBalances: [47_955_720, 2_039_280, 2_039_280, 0, 1, 1, 1, 1, 1],
      preTokenBalances: [tokenBalance(1, S, "120450000")],
      postTokenBalances: [tokenBalance(1, S, "107950000"), tokenBalance(2, R, "12500000")],
    },
    transaction: {
      signatures: [SIG],
      message: {
        accountKeys: [
          key(S, true, true),
          key(senderAta, false, true),
          key(recipientAta, false, true),
          key(R, false, false),
          key(USDC_MINT, false, false),
          key(SYSTEM_PROGRAM_ID, false, false),
          key(TOKEN_PROGRAM_ID, false, false),
          key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
          key(MEMO_PROGRAM_ID, false, false),
        ],
        recentBlockhash: base58.encode(new Uint8Array(32).fill(1)),
        instructions: [
          {
            parsed: {
              info: {
                account: recipientAta,
                mint: USDC_MINT,
                source: S,
                systemProgram: SYSTEM_PROGRAM_ID,
                tokenProgram: TOKEN_PROGRAM_ID,
                wallet: R,
              },
              type: "createIdempotent",
            },
            program: "spl-associated-token-account",
            programId: ASSOCIATED_TOKEN_PROGRAM_ID,
            stackHeight: 1,
          },
          {
            parsed: {
              info: {
                authority: S,
                destination: recipientAta,
                mint: USDC_MINT,
                source: senderAta,
                tokenAmount: { amount: String(AMOUNT), decimals: 6, uiAmount: 12.5, uiAmountString: "12.5" },
              },
              type: "transferChecked",
            },
            program: "spl-token",
            programId: TOKEN_PROGRAM_ID,
            stackHeight: 1,
          },
          { parsed: memo, program: "spl-memo", programId: MEMO_PROGRAM_ID, stackHeight: 1 },
        ],
      },
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
const expectation = { sender: S, recipient: R, amount: AMOUNT, envelopeHash: hash };

function verdict(mutate: (tx: Fixture) => unknown, expect = expectation) {
  const tx = fixture();
  const replaced = mutate(tx);
  return checkUsdcPayment(replaced === undefined ? tx : replaced, expect);
}

function expectFail(name: string, mutate: (tx: Fixture) => unknown, pattern: RegExp, expect = expectation): void {
  const r = verdict(mutate, expect);
  check(name, !r.ok && pattern.test(r.error), r.ok ? "accepted" : r.error);
}

{
  const r = verdict(() => undefined);
  check("fixture verifies", r.ok, r.ok ? "" : r.error);
}
{
  const raw = verdict((tx) => {
    tx.transaction.message.instructions[2] = {
      programId: MEMO_PROGRAM_ID,
      accounts: [],
      data: base58.encode(new TextEncoder().encode(memo)),
      stackHeight: 1,
    } as never;
  });
  check("raw (unparsed) memo instruction verifies", raw.ok, raw.ok ? "" : raw.error);
}
{
  const v0 = verdict((tx) => {
    (tx as { version: unknown }).version = 0;
    tx.transaction.message.accountKeys[8].source = "lookupTable";
  });
  check("v0 transaction with a looked-up key verifies", v0.ok, v0.ok ? "" : v0.error);
}
{
  const extra = verdict((tx) => {
    tx.transaction.message.instructions.unshift({
      parsed: { info: { microLamports: 10_000 }, type: "setComputeUnitPrice" },
      program: "compute-budget",
      programId: "ComputeBudget111111111111111111111111111111",
      stackHeight: 1,
    } as never);
  });
  check("a priority-fee instruction added by the wallet still verifies", extra.ok, extra.ok ? "" : extra.error);
}

expectFail("failed transaction", (tx) => {
  (tx.meta as { err: unknown }).err = { InstructionError: [1, { Custom: 1 }] };
}, /failed on chain/);
expectFail("not a transaction", () => ({ hello: "world" }), /could not be read/);
expectFail("null", () => null, /could not be read/);
expectFail("amount one base unit short", (tx) => {
  tx.transaction.message.instructions[1].parsed.info.tokenAmount.amount = String(AMOUNT - 1);
}, /is 12\.499999 USDC, not 12\.50 USDC/);
expectFail("claimed amount larger than sent", () => undefined, /not 13\.00 USDC/, { ...expectation, amount: 13_000_000 });
expectFail("wrong decimals", (tx) => {
  tx.transaction.message.instructions[1].parsed.info.tokenAmount.decimals = 9;
}, /names 9 decimals; USDC has 6/);
expectFail("another recipient's account", (tx) => {
  tx.transaction.message.instructions[1].parsed.info.destination = senderAta;
}, /recipient's associated token account/);
expectFail("letter addressed to someone else", () => undefined, /recipient's associated token account/, {
  ...expectation,
  recipient: KNOWN_ATAS[0][0],
});
expectFail("signed by another authority", (tx) => {
  tx.transaction.message.instructions[1].parsed.info.authority = R;
}, /sending wallet/);
expectFail("source account owned by someone else", (tx) => {
  tx.meta.preTokenBalances[0].owner = R;
  tx.meta.postTokenBalances[0].owner = R;
}, /sending wallet/);
expectFail("source account missing from the token balances", (tx) => {
  tx.meta.preTokenBalances = [];
  tx.meta.postTokenBalances = [tx.meta.postTokenBalances[1]];
}, /sending wallet/);
expectFail("letter claimed by another sender", () => undefined, /sending wallet/, { ...expectation, sender: KNOWN_ATAS[1][0] });
expectFail("another mint (not USDC)", (tx) => {
  tx.transaction.message.instructions[1].parsed.info.mint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
}, /no USDC TransferChecked/);
expectFail("unchecked Transfer instead of TransferChecked", (tx) => {
  tx.transaction.message.instructions[1].parsed.type = "transfer";
}, /no USDC TransferChecked/);
expectFail("Token-2022 program id", (tx) => {
  tx.transaction.message.instructions[1].programId = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
}, /no USDC TransferChecked/);
expectFail("transfer only as an inner instruction", (tx) => {
  const [transfer] = tx.transaction.message.instructions.splice(1, 1);
  (tx.meta as { innerInstructions: unknown[] }).innerInstructions = [{ index: 0, instructions: [{ ...transfer, stackHeight: 2 }] }];
}, /no USDC TransferChecked/);
expectFail("memo missing", (tx) => {
  tx.transaction.message.instructions.pop();
}, /dirac:pay:v1: memo/);
expectFail("memo of another letter", (tx) => {
  tx.transaction.message.instructions[2].parsed = payMemo("ab".repeat(32));
}, /dirac:pay:v1: memo/);
expectFail("memo with a different prefix", (tx) => {
  tx.transaction.message.instructions[2].parsed = memo.replace("v1", "v2");
}, /dirac:pay:v1: memo/);
expectFail("memo text under another program", (tx) => {
  tx.transaction.message.instructions[2].programId = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
}, /dirac:pay:v1: memo/);
{
  const r = checkUsdcPayment(fixture(), { ...expectation, envelopeHash: "not-a-hash" });
  check("malformed expectation is refused, not thrown", !r.ok && /malformed/.test(r.error), r.ok ? "accepted" : r.error);
}

/* ------------------------------------------------------------------ */
/* The payment claim of a send request                                 */
/* ------------------------------------------------------------------ */

{
  const { parsePaymentClaim } = inbox;
  const none = parsePaymentClaim(undefined);
  check("claim: absent is no payment", none.ok && none.value === null);
  const nul = parsePaymentClaim(null);
  check("claim: null is no payment", nul.ok && nul.value === null);
  const good = parsePaymentClaim({ signature: SIG, amount: AMOUNT });
  check("claim: signature and amount", good.ok && good.value?.signature === SIG && good.value.amount === AMOUNT);
  const digits = parsePaymentClaim({ signature: SIG, amount: "12500000" });
  check("claim: amount as a string of digits", digits.ok && digits.value?.amount === AMOUNT);
  for (const [name, input] of [
    ["array", []],
    ["string", "pay"],
    ["bad signature", { signature: "abc", amount: 1 }],
    ["32-byte signature", { signature: base58.encode(new Uint8Array(32).fill(1)), amount: 1 }],
    ["zero", { signature: SIG, amount: 0 }],
    ["negative", { signature: SIG, amount: -5 }],
    ["fraction", { signature: SIG, amount: 1.5 }],
    ["unsafe integer", { signature: SIG, amount: 2 ** 60 }],
    ["decimal string", { signature: SIG, amount: "12.5" }],
    ["extra field", { signature: SIG, amount: 1, memo: "x" }],
  ] as const) {
    const r = parsePaymentClaim(input);
    check(`claim refused: ${name}`, !r.ok, r.ok ? "accepted" : r.error);
  }
}

/* ------------------------------------------------------------------ */
/* Pending payments on read: checks and the 15-minute expiry           */
/* ------------------------------------------------------------------ */

// GET /api/inbox/:wallet through worker/inbox.ts on an in-memory SQLite with every migration applied
// (a small D1 shim over node:sqlite) and a stubbed fetch standing in for the Solana RPC.
{
  const { handleInbox } = await import("../worker/inbox.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { ed25519 } = await import("@noble/curves/ed25519.js");

  type InboxEnv = Parameters<typeof handleInbox>[1];
  type InboxCtx = Parameters<typeof handleInbox>[2];
  type SqlRow = Record<string, unknown>;

  /** The D1 calls the Worker makes (prepare, bind, first, all, run, batch) over an in-memory SQLite. */
  const memoryD1 = () => {
    const db = new DatabaseSync(":memory:");
    const dir = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
    const exec = (sql: string, args: unknown[]) => {
      const rows = db.prepare(sql).all(...(args.map((v) => (v === undefined ? null : v)) as (string | number | null)[])) as SqlRow[];
      return { results: rows.map((r) => ({ ...r })), success: true, meta: {} };
    };
    class Statement {
      readonly sql: string;
      readonly args: unknown[];
      constructor(sql: string, args: unknown[] = []) {
        this.sql = sql;
        this.args = args;
      }
      bind(...args: unknown[]) {
        return new Statement(this.sql, args);
      }
      async first() {
        return exec(this.sql, this.args).results[0] ?? null;
      }
      async all() {
        return exec(this.sql, this.args);
      }
      async run() {
        return exec(this.sql, this.args);
      }
    }
    const d1 = {
      prepare: (sql: string) => new Statement(sql),
      batch: async (statements: Statement[]) => statements.map((s) => exec(s.sql, s.args)),
    };
    return { db, env: { DB: d1 as unknown as InboxEnv["DB"], RPC_URL: "https://rpc.test/" } as InboxEnv };
  };

  const MINUTE = 60_000;
  const recipientSeed = new Uint8Array(32).fill(9);
  const envelopeJson = JSON.stringify(envelope);
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as InboxCtx;

  /** What the stubbed RPC does with every call, and how many calls it saw. */
  let rpcMode: "absent" | "down" = "absent";
  let rpcCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    rpcCalls++;
    if (rpcMode === "down") throw new TypeError("fetch failed: stub upstream down");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const realWarn = console.warn;
  console.warn = () => undefined;

  /**
   * One pending letter `ageMin` minutes old that has `checks` "not visible"
   * answers behind it, then one signed read of the inbox. Returns the payment
   * the API reports and the row as stored afterwards.
   */
  const readOnce = async (ageMin: number, checks: number, mode: "absent" | "down" = "absent") => {
    const { db, env } = memoryD1();
    const now = Date.now();
    db.prepare(
      `INSERT INTO inbox (to_wallet, from_wallet, envelope, sender_sig, created_at,
                          payment_sig, payment_amount, payment_status, payment_reason, payment_checks, payment_checked_at)
       VALUES (?, ?, ?, 'sig', ?, ?, ?, 'pending', NULL, ?, NULL)`,
    ).run(R, S, envelopeJson, now - ageMin * MINUTE, SIG, AMOUNT, checks);
    rpcMode = mode;
    rpcCalls = 0;
    const bucket = inbox.readBucket(now);
    const sig = Buffer.from(ed25519.sign(new TextEncoder().encode(inbox.READ_MESSAGE(R, bucket)), recipientSeed)).toString("base64");
    const url = new URL(`https://dirac.test/api/inbox/${R}`);
    const res = await handleInbox(
      new Request(url, { headers: { Authorization: inbox.authHeader(R, bucket, sig) } }),
      env,
      ctx,
      url.pathname.split("/").filter(Boolean),
      url,
    );
    const body = res ? ((await res.json()) as { messages?: { payment?: { status: string; reason: string | null } | null }[] }) : {};
    const row = db.prepare("SELECT payment_status, payment_reason, payment_checks, payment_checked_at FROM inbox").get() as SqlRow;
    return { status: res?.status, payment: body.messages?.[0]?.payment ?? null, row, calls: rpcCalls };
  };

  try {
    const fresh = await readOnce(1, 2);
    check(
      "pending, 1 min old, third empty check: still pending",
      fresh.status === 200 && fresh.payment?.status === "pending" && fresh.row.payment_checks === 3 && fresh.calls === 1,
      JSON.stringify({ ...fresh.row, calls: fresh.calls }),
    );

    const expired = await readOnce(16, 2);
    check(
      "pending, 16 min old, third empty check: invalid, not found within 15 minutes",
      expired.payment?.status === "invalid" &&
        expired.payment.reason === "the transaction was not found on chain within 15 minutes" &&
        expired.row.payment_status === "invalid" &&
        expired.row.payment_checks === 3,
      JSON.stringify(expired.payment),
    );

    const edge = await readOnce(15, 2);
    check("pending, exactly 15 min old, third empty check: invalid", edge.payment?.status === "invalid", JSON.stringify(edge.payment));

    const young = await readOnce(14, 2);
    check("pending, 14 min old, third empty check: still pending", young.payment?.status === "pending" && young.row.payment_checks === 3);

    const fewChecks = await readOnce(60, 1);
    check(
      "pending, an hour old, second empty check: still pending (three needed)",
      fewChecks.payment?.status === "pending" && fewChecks.row.payment_checks === 2 && fewChecks.row.payment_reason === null,
      JSON.stringify(fewChecks.row),
    );

    const unreachable = await readOnce(60, 2, "down");
    check(
      "pending, an hour old, RPC unreachable: no check spent, still pending",
      unreachable.payment?.status === "pending" &&
        unreachable.row.payment_checks === 2 &&
        typeof unreachable.row.payment_checked_at === "number" &&
        unreachable.calls >= 1,
      JSON.stringify({ ...unreachable.row, calls: unreachable.calls }),
    );

    const counted = await readOnce(1, 7);
    check(
      "pending, 1 min old, eighth empty check: invalid after 8 checks",
      counted.payment?.status === "invalid" && counted.payment.reason === "the transaction was not found on chain after 8 checks",
      JSON.stringify(counted.payment),
    );

    const both = await readOnce(30, 7);
    check("pending, 30 min old, eighth empty check: invalid", both.payment?.status === "invalid" && both.row.payment_checks === 8);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

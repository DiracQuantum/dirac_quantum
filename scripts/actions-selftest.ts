/**
 * Self-test for the Solana Actions module (worker/actions.ts): the memo
 * format against the site's own builder, the wallet validation, the
 * transaction assembly, the on-chain check and the routing with a stubbed
 * D1 and RPC. Run from the project root:
 *   node scripts/actions-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure.
 *
 * Worker sources import their siblings without an extension and the site's
 * modules use the "@/" alias; a resolve hook handles both, then the modules
 * are loaded dynamically so the hook is in place first.
 */

import { readFileSync } from "node:fs";
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

const actions = await import("../worker/actions.ts");
const invite = await import("../src/lib/solana/invite.ts");
const memo = await import("../src/lib/solana/memo.ts");
const { Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } = await import("@solana/web3.js");
const { base58, base64 } = await import("@scure/base");

const {
  ACTIONS_HEADERS,
  ACTIONS_JSON,
  ACTION_VERSION,
  BLOCKCHAIN_ID,
  INVITE_LAMPORTS,
  INVITE_MEMO_PREFIX,
  MEMO_PROGRAM_ID,
  buildInviteTransaction,
  checkInviteTransaction,
  checkWallet,
  handleActions,
  inviteMemo,
  isTxSignature,
  truncate,
} = actions;

type Env = Parameters<typeof handleActions>[1];
type Ctx = Parameters<typeof handleActions>[2];

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

const SITE = "https://dirac.deeper-cf.workers.dev";
const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();
const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const signature = base58.encode(randomBytes(64));

/* --- memo and constants --------------------------------------------- */

check("memo equals the site's INVITE_MEMO", inviteMemo(SITE, alice) === invite.INVITE_MEMO(SITE, alice), inviteMemo(SITE, alice));
check("memo starts with the prefix", inviteMemo(SITE, alice).startsWith(`${INVITE_MEMO_PREFIX} `));
check("lamports equal the site's", INVITE_LAMPORTS === invite.INVITE_LAMPORTS && INVITE_LAMPORTS === 100_000);
check("memo program id equals the site's", MEMO_PROGRAM_ID === memo.MEMO_PROGRAM_ID.toBase58());

const published: unknown = JSON.parse(readFileSync(path.join(ROOT, "public", "actions.json"), "utf8"));
check("public/actions.json equals ACTIONS_JSON", JSON.stringify(published) === JSON.stringify(ACTIONS_JSON));
check(
  "rules map /invite/* and /api/actions/**",
  ACTIONS_JSON.rules[0].pathPattern === "/invite/*" &&
    ACTIONS_JSON.rules[0].apiPath === "/api/actions/invite/*" &&
    ACTIONS_JSON.rules[1].pathPattern === "/api/actions/**" &&
    ACTIONS_JSON.rules[1].apiPath === "/api/actions/**",
);

check("X-Action-Version 2.4", ACTION_VERSION === "2.4" && ACTIONS_HEADERS["X-Action-Version"] === "2.4");
check(
  "X-Blockchain-Ids mainnet",
  BLOCKCHAIN_ID === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" && ACTIONS_HEADERS["X-Blockchain-Ids"] === BLOCKCHAIN_ID,
);
check(
  "CORS headers per the Actions spec",
  ACTIONS_HEADERS["Access-Control-Allow-Origin"] === "*" &&
    ACTIONS_HEADERS["Access-Control-Allow-Methods"] === "GET,POST,PUT,OPTIONS" &&
    ACTIONS_HEADERS["Access-Control-Allow-Headers"].includes("X-Accept-Action-Version") &&
    ACTIONS_HEADERS["Access-Control-Allow-Headers"].includes("X-Accept-Blockchain-Ids") &&
    ACTIONS_HEADERS["Access-Control-Expose-Headers"] === "X-Action-Version, X-Blockchain-Ids",
);

/* --- wallet validation ---------------------------------------------- */

const pda = PublicKey.findProgramAddressSync([new TextEncoder().encode("dirac")], SystemProgram.programId)[0].toBase58();
check("valid wallet accepted", checkWallet(alice).ok);
check("short string rejected", !checkWallet("abc").ok);
check("non-string rejected", !checkWallet(42).ok && !checkWallet(null).ok);
check("non-base58 characters rejected", !checkWallet(`${alice.slice(0, -1)}0`).ok);
check("31-byte key rejected", !checkWallet(base58.encode(randomBytes(31))).ok);
check("33-byte key rejected", !checkWallet(base58.encode(randomBytes(33))).ok);
const offCurve = checkWallet(pda);
check("program-derived address rejected (off curve)", !offCurve.ok && /program-derived/.test(offCurve.error), pda);
check("isTxSignature", isTxSignature(signature) && !isTxSignature(alice) && !isTxSignature("x") && !isTxSignature(7));
check("truncate", truncate(alice) === `${alice.slice(0, 4)}…${alice.slice(-4)}` && truncate("short") === "short");

/* --- transaction assembly ------------------------------------------- */

const recent = { blockhash: base58.encode(randomBytes(32)), lastValidBlockHeight: 123_456 };
const encoded = buildInviteTransaction(alice, bob, SITE, recent);
const tx = Transaction.from(base64.decode(encoded));
check("fee payer is the inviter", tx.feePayer?.toBase58() === alice);
check("recent blockhash set", tx.recentBlockhash === recent.blockhash);
check("exactly two instructions", tx.instructions.length === 2);
const [transfer, memoIx] = tx.instructions;
check("first instruction is a system transfer", transfer.programId.equals(SystemProgram.programId));
const decoded = SystemInstruction.decodeTransfer(transfer);
check(
  "transfer from inviter to invitee of 100000 lamports",
  decoded.fromPubkey.toBase58() === alice && decoded.toPubkey.toBase58() === bob && Number(decoded.lamports) === INVITE_LAMPORTS,
);
check("second instruction is the memo program with no accounts", memoIx.programId.toBase58() === MEMO_PROGRAM_ID && memoIx.keys.length === 0);
check("memo bytes equal the site's memo", new TextDecoder().decode(memoIx.data) === invite.INVITE_MEMO(SITE, alice));
check("one signature slot, unsigned", tx.signatures.length === 1 && tx.signatures[0].signature === null);
check("self invite throws", throws(() => buildInviteTransaction(alice, alice, SITE, recent)));

/* --- on-chain check ------------------------------------------------- */

interface ParsedTxOptions {
  err?: unknown;
  payer?: string;
  lamports?: number;
  destination?: string;
  memoText?: string | null;
  rawMemo?: boolean;
}

function parsedTx(opts: ParsedTxOptions = {}): unknown {
  const text = opts.memoText === undefined ? inviteMemo(SITE, alice) : opts.memoText;
  const instructions: unknown[] = [
    {
      program: "system",
      programId: SystemProgram.programId.toBase58(),
      parsed: { type: "transfer", info: { source: alice, destination: opts.destination ?? bob, lamports: opts.lamports ?? INVITE_LAMPORTS } },
    },
  ];
  if (text !== null) {
    instructions.push(
      opts.rawMemo
        ? { programId: MEMO_PROGRAM_ID, accounts: [], data: base58.encode(new TextEncoder().encode(text)) }
        : { program: "spl-memo", programId: MEMO_PROGRAM_ID, parsed: text },
    );
  }
  return {
    meta: { err: opts.err ?? null },
    transaction: { message: { accountKeys: [{ pubkey: opts.payer ?? alice, signer: true }, { pubkey: bob }], instructions } },
  };
}

check("parsed invite accepted", checkInviteTransaction(parsedTx(), alice, bob).ok);
check("raw memo instruction accepted", checkInviteTransaction(parsedTx({ rawMemo: true }), alice, bob).ok);
check("failed transaction rejected", !checkInviteTransaction(parsedTx({ err: { InstructionError: [0, "Custom"] } }), alice, bob).ok);
check("other fee payer rejected", !checkInviteTransaction(parsedTx({ payer: bob }), alice, bob).ok);
check("too few lamports rejected", !checkInviteTransaction(parsedTx({ lamports: INVITE_LAMPORTS - 1 }), alice, bob).ok);
check("other destination rejected", !checkInviteTransaction(parsedTx({ destination: alice }), alice, bob).ok);
check("missing memo rejected", !checkInviteTransaction(parsedTx({ memoText: null }), alice, bob).ok);
check("foreign memo rejected", !checkInviteTransaction(parsedTx({ memoText: "gm" }), alice, bob).ok);
check("null transaction rejected", !checkInviteTransaction(null, alice, bob).ok);

/* --- routing with a stubbed D1 and RPC ------------------------------ */

function stubDb(count: number): { db: Env["DB"]; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return { count };
            },
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO invites")) inserts.push(args);
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Env["DB"], inserts };
}

const ctx: Ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as Ctx;

const realFetch = globalThis.fetch;
const rpcCalls: string[] = [];
/** Replaces fetch: every JSON-RPC call is answered by `answer(method)` (or fails when it throws); records the methods. */
function stubRpcRaw(answer: (method: string) => Response): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string };
    rpcCalls.push(body.method);
    return answer(body.method);
  }) as typeof fetch;
}
const rpcResponse = (payload: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...payload }), { headers: { "Content-Type": "application/json" } });
/** Answers every JSON-RPC call with `responder(method)` as the result. */
function stubRpc(responder: (method: string) => unknown): void {
  stubRpcRaw((method) => rpcResponse({ result: responder(method) }));
}

async function call(
  env: Env,
  method: string,
  pathname: string,
  body?: unknown,
  base = "https://dirac.test",
): Promise<Response | null> {
  const url = new URL(pathname, base);
  const request = new Request(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleActions(request, env, ctx, url.pathname.split("/").filter(Boolean), url);
}

async function bodyOf(response: Response | null): Promise<Record<string, unknown>> {
  if (!response) return {};
  return (await response.json()) as Record<string, unknown>;
}

const hasActionHeaders = (response: Response | null): boolean =>
  response !== null &&
  response.headers.get("X-Action-Version") === "2.4" &&
  response.headers.get("X-Blockchain-Ids") === BLOCKCHAIN_ID &&
  response.headers.get("Access-Control-Allow-Origin") === "*";

const env: Env = { DB: stubDb(1).db };

check("other paths answer null", (await call(env, "GET", "/api/pet")) === null && (await call(env, "GET", "/")) === null);
check("/api/actions/invite/:wallet/other answers null-free 404", (await call(env, "GET", `/api/actions/invite/${bob}/other`))?.status === 404);

const options = await call(env, "OPTIONS", `/api/actions/invite/${bob}`);
check(
  "OPTIONS preflight carries the Actions headers",
  options?.status === 200 &&
    hasActionHeaders(options) &&
    options.headers.get("Access-Control-Allow-Methods") === "GET,POST,PUT,OPTIONS" &&
    (options.headers.get("Access-Control-Allow-Headers") ?? "").includes("X-Accept-Action-Version") &&
    options.headers.get("Access-Control-Expose-Headers") === "X-Action-Version, X-Blockchain-Ids",
);

const rules = await call(env, "GET", "/actions.json");
check(
  "GET /actions.json serves the rules with the Actions headers",
  rules?.status === 200 && hasActionHeaders(rules) && JSON.stringify(await bodyOf(rules)) === JSON.stringify(ACTIONS_JSON),
);
check("OPTIONS /actions.json answers the preflight", (await call(env, "OPTIONS", "/actions.json"))?.status === 200);

const redirect = await call(env, "GET", `/invite/${bob}`);
check(
  "GET /invite/:wallet redirects to the site's invite flow",
  redirect?.status === 302 && redirect.headers.get("Location") === `https://dirac.test/write?to=${bob}`,
);
check("GET /invite/<not a wallet> falls through to the site", (await call(env, "GET", "/invite/not-a-wallet")) === null);

const get = await call(env, "GET", `/api/actions/invite/${bob}`);
const getBody = await bodyOf(get);
const linked = ((getBody.links as { actions?: Record<string, unknown>[] } | undefined)?.actions ?? [])[0];
check(
  "GET action: title, label, icon and one linked action",
  get?.status === 200 &&
    hasActionHeaders(get) &&
    getBody.type === "action" &&
    getBody.title === `Invite ${truncate(bob)} to Dirac` &&
    getBody.label === "Send invite" &&
    getBody.icon === "https://dirac.test/opengraph-image" &&
    getBody.disabled === undefined &&
    linked?.type === "transaction" &&
    linked?.href === `https://dirac.test/api/actions/invite/${bob}` &&
    linked?.label === "Send invite",
);
check(
  "GET action: description names the amount, the memo and the passport page",
  typeof getBody.description === "string" &&
    getBody.description.includes("0.0001 SOL") &&
    getBody.description.includes(INVITE_MEMO_PREFIX) &&
    getBody.description.includes(`/p?a=${bob}`),
);
const siteEnv: Env = { DB: env.DB, SITE_URL: "https://dirac.example/" };
const getSite = await bodyOf(await call(siteEnv, "GET", `/api/actions/invite/${bob}`));
check(
  "SITE_URL overrides the request origin in hrefs",
  getSite.icon === "https://dirac.example/opengraph-image" &&
    ((getSite.links as { actions: { href: string }[] }).actions[0].href === `https://dirac.example/api/actions/invite/${bob}`),
);

const badGet = await bodyOf(await call(env, "GET", "/api/actions/invite/not-a-wallet"));
check(
  "GET action for a bad wallet is disabled with an error",
  badGet.disabled === true && typeof (badGet.error as { message?: unknown } | undefined)?.message === "string",
);
check("GET action for a PDA is disabled", (await bodyOf(await call(env, "GET", `/api/actions/invite/${pda}`))).disabled === true);

check("PUT is 405", (await call(env, "PUT", `/api/actions/invite/${bob}`))?.status === 405);
check("POST without a body is 400", (await call(env, "POST", `/api/actions/invite/${bob}`))?.status === 400);
check("POST with a bad account is 400", (await call(env, "POST", `/api/actions/invite/${bob}`, { account: "nope" }))?.status === 400);
const self = await call(env, "POST", `/api/actions/invite/${bob}`, { account: bob });
check("self invite refused", self?.status === 400 && /itself/.test(String((await bodyOf(self)).message)));
check("POST to a bad wallet is 400", (await call(env, "POST", "/api/actions/invite/not-a-wallet", { account: alice }))?.status === 400);

const limitedEnv: Env = { DB: stubDb(11).db };
const limited = await call(limitedEnv, "POST", `/api/actions/invite/${bob}`, { account: alice });
check("11th POST in a minute is 429 with Retry-After", limited?.status === 429 && limited.headers.get("Retry-After") !== null && hasActionHeaders(limited));

try {
  stubRpc((method) => (method === "getLatestBlockhash" ? { context: { slot: 1 }, value: recent } : null));
  const post = await call(env, "POST", `/api/actions/invite/${bob}`, { account: alice });
  const postBody = await bodyOf(post);
  const built = typeof postBody.transaction === "string" ? Transaction.from(base64.decode(postBody.transaction)) : null;
  const next = (postBody.links as { next?: { type?: string; href?: string } } | undefined)?.next;
  check(
    "POST returns a transaction with the blockhash from the RPC",
    post?.status === 200 &&
      hasActionHeaders(post) &&
      postBody.type === "transaction" &&
      built !== null &&
      built.feePayer?.toBase58() === alice &&
      built.recentBlockhash === recent.blockhash &&
      built.instructions.length === 2 &&
      rpcCalls.includes("getLatestBlockhash"),
  );
  check(
    "POST chains to /confirm through links.next",
    next?.type === "post" && next?.href === `https://dirac.test/api/actions/invite/${bob}/confirm` && typeof postBody.message === "string",
  );
  check(
    "POST transaction memo equals the site's memo for the request origin",
    built !== null && new TextDecoder().decode(built.instructions[1].data) === invite.INVITE_MEMO("https://dirac.test", alice),
  );

  check(
    "confirm without a signature is 400",
    (await call(env, "POST", `/api/actions/invite/${bob}/confirm`, { account: alice }))?.status === 400,
  );
  check("GET /confirm is 405", (await call(env, "GET", `/api/actions/invite/${bob}/confirm`))?.status === 405);

  const recorder = stubDb(1);
  const okEnv: Env = { DB: recorder.db };
  stubRpc((method) => (method === "getTransaction" ? parsedTx() : null));
  const confirmed = await call(okEnv, "POST", `/api/actions/invite/${bob}/confirm`, { account: alice, signature });
  const confirmedBody = await bodyOf(confirmed);
  check(
    "confirm records the verified invite and completes",
    confirmed?.status === 200 &&
      hasActionHeaders(confirmed) &&
      confirmedBody.type === "completed" &&
      confirmedBody.title === `Invite sent to ${truncate(bob)}` &&
      recorder.inserts.length === 1 &&
      recorder.inserts[0][0] === alice &&
      recorder.inserts[0][1] === bob &&
      recorder.inserts[0][2] === signature,
  );

  const wrong = stubDb(1);
  stubRpc((method) => (method === "getTransaction" ? parsedTx({ destination: alice }) : null));
  const rejected = await call({ DB: wrong.db }, "POST", `/api/actions/invite/${bob}/confirm`, { account: alice, signature });
  check("confirm refuses a transaction that is not an invite to the wallet", rejected?.status === 400 && wrong.inserts.length === 0);

  const versioned = stubDb(1);
  stubRpcRaw(() =>
    rpcResponse({ error: { code: actions.RPC_UNSUPPORTED_VERSION, message: "Transaction version (1) is not supported by the requesting client." } }),
  );
  const notLegacy = await call({ DB: versioned.db }, "POST", `/api/actions/invite/${bob}/confirm`, { account: alice, signature });
  check(
    "confirm refuses a versioned transaction (RPC -32015) with 400, not 500",
    notLegacy?.status === 400 && /versioned/.test(String((await bodyOf(notLegacy)).message)) && versioned.inserts.length === 0,
  );

  const unreachable = stubDb(1);
  stubRpcRaw(() => {
    throw new Error("connection refused");
  });
  const deferred = await call({ DB: unreachable.db }, "POST", `/api/actions/invite/${bob}/confirm`, { account: alice, signature });
  check(
    "confirm with the RPC unreachable answers completed (still confirming) and records nothing yet",
    deferred?.status === 200 && (await bodyOf(deferred)).type === "completed" && unreachable.inserts.length === 0,
  );
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

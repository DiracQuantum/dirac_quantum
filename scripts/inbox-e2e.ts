// End-to-end check of the deployed inbox: two throwaway wallets with passports,
// a letter from A to B, B reads and decrypts it, then deletes it. Also invites.
// Run: node scripts/inbox-e2e.ts [https://dirac.deeper-cf.workers.dev]
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import {
  WALLET_MESSAGE,
  b64,
  buildPassport,
  keysFromSeeds,
  seedsFromSignature,
  selfSign,
  utf8,
} from "../src/lib/pq.ts";
import {
  READ_MESSAGE,
  SEND_MESSAGE,
  decryptLetter,
  encryptLetter,
  envelopeHash,
  readBucket,
} from "../src/lib/inbox.ts";

const BASE = process.argv[2] ?? "https://dirac.deeper-cf.workers.dev";
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Record<string, unknown> | null = null;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {}
  return { status: res.status, data };
}

function makeIdentity() {
  const sk = randomBytes(32);
  const wallet = base58.encode(ed25519.getPublicKey(sk));
  const keys = keysFromSeeds(seedsFromSignature(ed25519.sign(utf8("derive"), sk)));
  const passport = buildPassport(wallet, keys, "simple");
  return { sk, wallet, keys, passport };
}

const A = makeIdentity();
const B = makeIdentity();
for (const who of [A, B]) {
  const reg = await call("POST", "/api/passports", {
    passport: who.passport,
    self_sig: selfSign(who.passport, who.keys.dsaSk),
    wallet_sig: b64.encode(ed25519.sign(utf8(WALLET_MESSAGE(who.passport)), who.sk)),
  });
  check(`register passport ${who.wallet.slice(0, 4)}`, reg.status === 200, `status ${reg.status} ${JSON.stringify(reg.data)}`);
}

// A writes to B
const text = "OTC: 12k USDC at 184.20, settle by 18:00 UTC. Only you can read this.";
const envelope = encryptLetter({ v: 1, text, from: A.wallet, sent_at: Math.floor(Date.now() / 1000) }, B.keys.kemPk);
const senderSig = b64.encode(ed25519.sign(utf8(SEND_MESSAGE(B.wallet, envelopeHash(envelope))), A.sk));
const sent = await call("POST", `/api/inbox/${B.wallet}`, { envelope, sender: A.wallet, sender_sig: senderSig });
check("send letter", sent.status === 200 && sent.data?.ok === true, `status ${sent.status} ${JSON.stringify(sent.data)}`);
const letterId = sent.data?.id as number;

// forged sender signature is rejected
const forged = await call("POST", `/api/inbox/${B.wallet}`, { envelope, sender: A.wallet, sender_sig: b64.encode(randomBytes(64)) });
check("forged sender signature rejected", forged.status >= 400, `status ${forged.status}`);

// recipient without passport → 404
const nobody = base58.encode(ed25519.getPublicKey(randomBytes(32)));
const noPassSig = b64.encode(ed25519.sign(utf8(SEND_MESSAGE(nobody, envelopeHash(envelope))), A.sk));
const noPass = await call("POST", `/api/inbox/${nobody}`, { envelope, sender: A.wallet, sender_sig: noPassSig });
check("no passport → 404", noPass.status === 404, `status ${noPass.status}`);

// B reads with a signed challenge
const bucket = readBucket();
const readSig = b64.encode(ed25519.sign(utf8(READ_MESSAGE(B.wallet, bucket)), B.sk));
const auth = { Authorization: `Dirac ${B.wallet}:${bucket}:${readSig}` };
const inbox = await call("GET", `/api/inbox/${B.wallet}`, undefined, auth);
const messages = (inbox.data?.messages as { id: number; from: string; envelope: typeof envelope }[] | undefined) ?? [];
check("read inbox", inbox.status === 200 && messages.length >= 1, `status ${inbox.status} count ${messages.length}`);
const mine = messages.find((m) => m.id === letterId);
check("letter present", !!mine && mine.from === A.wallet);
if (mine) {
  const letter = decryptLetter(mine.envelope, B.keys.kemSk);
  check("decrypts to the original text", letter.text === text && letter.from === A.wallet);
  let wrongKeyFailed = false;
  try {
    decryptLetter(mine.envelope, A.keys.kemSk);
  } catch {
    wrongKeyFailed = true;
  }
  check("A cannot decrypt B's letter", wrongKeyFailed);
}

// A cannot read B's inbox
const aSig = b64.encode(ed25519.sign(utf8(READ_MESSAGE(B.wallet, bucket)), A.sk));
const stolen = await call("GET", `/api/inbox/${B.wallet}`, undefined, { Authorization: `Dirac ${B.wallet}:${bucket}:${aSig}` });
check("wrong signer cannot read", stolen.status === 401 || stolen.status === 403, `status ${stolen.status}`);

// delete
const del = await call("DELETE", `/api/inbox/${B.wallet}/${letterId}`, undefined, auth);
check("delete letter", del.status === 200, `status ${del.status}`);

// invites
const tx = base58.encode(randomBytes(64));
const inv = await call("POST", "/api/invites", { from: A.wallet, to: nobody, tx });
check("register invite", inv.status === 200, `status ${inv.status} ${JSON.stringify(inv.data)}`);
const invs = await call("GET", `/api/invites/${nobody}`);
check("invites listed", invs.status === 200 && invs.data?.count === 1, `status ${invs.status} ${JSON.stringify(invs.data)}`);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
console.log("cleanup: throwaway wallets", A.wallet, B.wallet);
process.exit(failed ? 1 : 0);

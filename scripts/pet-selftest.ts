/**
 * Self-test for the quantum pet physics (worker/pet.ts) and the X signing
 * helpers (worker/x.ts). Run from the project root:
 *   node scripts/pet-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure.
 *
 * Worker sources import their siblings without an extension (bundler
 * resolution); Node's ESM loader wants the ".ts". A resolve hook retries once
 * with it appended, then the modules are loaded dynamically so the hook is in
 * place first.
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

const pet = await import("../worker/pet.ts");
const x = await import("../worker/x.ts");
const gate = await import("../src/lib/petGate.ts");
const { ed25519 } = await import("@noble/curves/ed25519.js");
const { base58, base64 } = await import("@scure/base");

const {
  CNOT,
  DIM,
  H,
  N_QUBITS,
  RY,
  TRAITS,
  X,
  bitsOf,
  collapseAtFor,
  dayStartState,
  deserialise,
  formProbabilities,
  indexOf,
  measure,
  measureAll,
  normSquared,
  probabilities,
  probabilityOf,
  qubitP1,
  randomUnit,
  serialise,
  topOutcomes,
  traitsFromBits,
  zeroState,
} = pet;

let failed = 0;
let passed = 0;

function check(name: string, fn: () => boolean | void | Promise<boolean | void>): Promise<void> {
  const started = performance.now();
  return Promise.resolve()
    .then(fn)
    .then((result) => {
      const ms = (performance.now() - started).toFixed(0);
      if (result === false) {
        failed++;
        console.log(`FAIL  ${name}  (${ms} ms)`);
      } else {
        passed++;
        console.log(`PASS  ${name}  (${ms} ms)`);
      }
    })
    .catch((e: unknown) => {
      failed++;
      const message = e instanceof Error ? e.message : String(e);
      console.log(`FAIL  ${name}  threw: ${message}`);
    });
}

const EPS = 1e-9;
const near = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps;
const sum = (xs: ArrayLike<number>) => Array.from(xs).reduce((a, b) => a + b, 0);
const always = (v: number) => () => v;

/* --- states and gates ------------------------------------------------- */

await check("zero state is |0…0⟩ with norm 1", () => {
  const s = zeroState();
  return s.re.length === DIM && s.im.length === DIM && s.re[0] === 1 && near(normSquared(s), 1) && N_QUBITS === 10;
});

await check("H on all qubits: every outcome 1/1024, every qubit P(1) = 0.5, forms 1/8 each", () => {
  const s = dayStartState();
  const p = probabilities(s);
  const uniform = Array.from(p).every((v) => near(v, 1 / DIM));
  const halves = qubitP1(s).every((v) => near(v, 0.5));
  const forms = formProbabilities(s);
  const eighths = TRAITS.form.every((f) => near(forms[f], 1 / 8));
  return uniform && halves && eighths && near(sum(p), 1);
});

await check("H is exact: |0⟩ → (|0⟩+|1⟩)/√2, |1⟩ → (|0⟩−|1⟩)/√2", () => {
  const plus = H(zeroState(), 0);
  const minus = H(X(zeroState(), 0), 0);
  return (
    near(plus.re[0], Math.SQRT1_2) &&
    near(plus.re[1], Math.SQRT1_2) &&
    near(minus.re[0], Math.SQRT1_2) &&
    near(minus.re[1], -Math.SQRT1_2) &&
    plus.im.every((v) => v === 0)
  );
});

await check("H twice is the identity", () => {
  let s = dayStartState();
  s = RY(s, 4, 0.7);
  const back = H(H(s, 2), 2);
  return Array.from(back.re).every((v, i) => near(v, s.re[i])) && Array.from(back.im).every((v, i) => near(v, s.im[i]));
});

await check("X flips qubit q: |0…0⟩ → |…1 at q…⟩", () => {
  for (let q = 0; q < N_QUBITS; q++) {
    const s = X(zeroState(), q);
    if (!(near(s.re[1 << q], 1) && near(normSquared(s), 1))) return false;
    const p1 = qubitP1(s);
    if (!p1.every((v, i) => near(v, i === q ? 1 : 0))) return false;
  }
  return true;
});

await check("gates do not mutate their input", () => {
  const s = zeroState();
  H(s, 0);
  X(s, 1);
  RY(s, 2, 1);
  CNOT(s, 0, 1);
  measure(s, 0);
  return s.re[0] === 1 && near(sum(s.re), 1) && s.im.every((v) => v === 0);
});

await check("CNOT on |10⟩ (qubit 0 set) → |11⟩; on |01⟩ nothing changes", () => {
  const ten = X(zeroState(), 0);
  const after = CNOT(ten, 0, 1);
  const one = X(zeroState(), 1);
  const same = CNOT(one, 0, 1);
  return (
    near(after.re[indexOf("1100000000")], 1) &&
    near(normSquared(after), 1) &&
    near(same.re[indexOf("0100000000")], 1)
  );
});

await check("CNOT is exact on the matrix: flips the target in every basis state where the control is 1", () => {
  const s = dayStartState();
  const r = RY(s, 3, 1.1);
  const out = CNOT(r, 3, 7);
  for (let i = 0; i < DIM; i++) {
    const j = (i & (1 << 3)) !== 0 ? i ^ (1 << 7) : i;
    if (!near(out.re[i], r.re[j]) || !near(out.im[i], r.im[j])) return false;
  }
  return true;
});

await check("RY(θ): P(1) = sin²(θ/2); RY(π) on |0⟩ is |1⟩; RY(−π/2) matches the matrix", () => {
  const thetas = [0, 0.3, 1, Math.PI / 2, Math.PI, -Math.PI / 2];
  for (const theta of thetas) {
    const s = RY(zeroState(), 5, theta);
    if (!near(qubitP1(s)[5], Math.sin(theta / 2) ** 2)) return false;
    if (!near(s.re[0], Math.cos(theta / 2)) || !near(s.re[1 << 5], Math.sin(theta / 2))) return false;
  }
  const flipped = RY(zeroState(), 5, Math.PI);
  return near(flipped.re[1 << 5], 1) && near(flipped.re[0], 0);
});

await check("probabilities sum to 1 after a random circuit", () => {
  let s = dayStartState();
  for (let k = 0; k < 40; k++) {
    const q = Math.floor(randomUnit() * N_QUBITS);
    const t = (q + 1 + Math.floor(randomUnit() * (N_QUBITS - 1))) % N_QUBITS;
    const pick = k % 4;
    s = pick === 0 ? H(s, q) : pick === 1 ? X(s, q) : pick === 2 ? RY(s, q, (randomUnit() - 0.5) * Math.PI) : CNOT(s, q, t);
  }
  const p = probabilities(s);
  const forms = formProbabilities(s);
  return near(sum(p), 1) && near(sum(Object.values(forms)), 1) && near(normSquared(s), 1);
});

/* --- measurement ---------------------------------------------------- */

await check("measure collapses: after H, outcome ∈ {0,1}, P(1) becomes the outcome, norm 1", () => {
  for (let k = 0; k < 20; k++) {
    const q = k % N_QUBITS;
    const { outcome, state } = measure(H(zeroState(), q), q);
    if (outcome !== 0 && outcome !== 1) return false;
    if (!near(qubitP1(state)[q], outcome) || !near(normSquared(state), 1)) return false;
  }
  return true;
});

await check("measure draws with the injected uniform: r < p1 → 1, r ≥ p1 → 0", () => {
  const s = RY(zeroState(), 0, 1.2); // P(1) = sin²(0.6) ≈ 0.319
  const p1 = qubitP1(s)[0];
  return (
    measure(s, 0, always(p1 - 1e-6)).outcome === 1 &&
    measure(s, 0, always(p1 + 1e-6)).outcome === 0 &&
    measure(s, 0, always(0)).outcome === 1 &&
    measure(s, 0, always(0.999999)).outcome === 0
  );
});

await check("measure on a certain qubit never flips it, even with an extreme draw", () => {
  const one = X(zeroState(), 2);
  return (
    measure(one, 2, always(0.9999999999)).outcome === 1 &&
    measure(zeroState(), 2, always(0)).outcome === 0 &&
    near(normSquared(measure(one, 2).state), 1)
  );
});

await check("Bell pair: H(0) then CNOT(0,1) → P(00)=P(11)=0.5; measuring qubit 0 fixes qubit 1", () => {
  const bell = CNOT(H(zeroState(), 0), 0, 1);
  const p = probabilities(bell);
  if (!near(p[0], 0.5) || !near(p[3], 0.5) || !near(p[1], 0) || !near(p[2], 0)) return false;
  for (let k = 0; k < 10; k++) {
    const { outcome, state } = measure(bell, 0);
    if (!near(qubitP1(state)[1], outcome)) return false;
  }
  return true;
});

await check("measure outcome frequency follows P(1) (RY, 4000 draws)", () => {
  const s = RY(zeroState(), 1, 1.2);
  const p1 = qubitP1(s)[1];
  let ones = 0;
  const n = 4000;
  for (let k = 0; k < n; k++) ones += measure(s, 1).outcome;
  // 5 sigma on a binomial with p ≈ 0.32: ±0.037
  return Math.abs(ones / n - p1) < 0.04;
});

await check("measureAll on a basis state returns exactly that string, bit 0 first", () => {
  let s = zeroState();
  s = X(s, 0);
  s = X(s, 3);
  s = X(s, 9);
  const bits = measureAll(s);
  return bits === "1001000001" && indexOf(bits) === (1 | 8 | 512) && bitsOf(indexOf(bits)) === bits;
});

await check("measureAll with injected draws walks the cumulative distribution", () => {
  const plus = H(zeroState(), 0); // 0.5 on index 0 and 1
  return (
    measureAll(plus, always(0)) === "0000000000" &&
    measureAll(plus, always(0.49)) === "0000000000" &&
    measureAll(plus, always(0.5)) === "1000000000" &&
    measureAll(plus, always(0.999999)) === "1000000000" &&
    measureAll(plus, always(1)) === "1000000000"
  );
});

await check("measureAll on the uniform state spreads over all 1024 outcomes (20480 draws)", () => {
  const s = dayStartState();
  const counts = new Map<string, number>();
  const n = 20 * DIM;
  for (let k = 0; k < n; k++) {
    const bits = measureAll(s);
    counts.set(bits, (counts.get(bits) ?? 0) + 1);
  }
  const values = Array.from(counts.values());
  // expected 20 per outcome; every outcome seen, none wildly off
  return counts.size === DIM && Math.min(...values) >= 2 && Math.max(...values) <= 60;
});

await check("randomUnit is in [0, 1) and not constant", () => {
  const draws = Array.from({ length: 2000 }, randomUnit);
  return draws.every((r) => r >= 0 && r < 1) && new Set(draws).size > 1900;
});

/* --- odds, traits, serialisation -------------------------------------- */

await check("topOutcomes is sorted, correct and sized", () => {
  const s = RY(RY(dayStartState(), 0, 2.4), 1, -2.0);
  const top = topOutcomes(s, 8);
  const p = probabilities(s);
  const best = Math.max(...Array.from(p));
  const sorted = top.every((o, i) => i === 0 || top[i - 1].p >= o.p);
  const exact = top.every((o) => near(o.p, p[indexOf(o.bits)]) && near(probabilityOf(s, o.bits), o.p));
  return top.length === 8 && sorted && exact && near(top[0].p, best) && topOutcomes(s, 1024).length === DIM;
});

await check("traitsFromBits reads the four fields little-endian", () => {
  const a = traitsFromBits("0000000000");
  const b = traitsFromBits("1110000000");
  const c = traitsFromBits("0001100000");
  const d = traitsFromBits("0000011100");
  const e = traitsFromBits("0000000011");
  const f = traitsFromBits("1000100001");
  return (
    a.form === "cat" && a.character === "curious" && a.ability === "phase shift" && a.palette === "ice" &&
    b.form === "fox" &&
    c.character === "stoic" &&
    d.ability === "measurement" &&
    e.palette === "mint" &&
    f.form === "virus" && f.character === "chaotic" && f.ability === "phase shift" && f.palette === "violet"
  );
});

await check("formProbabilities agrees with traitsFromBits on every basis state", () => {
  const s = RY(RY(dayStartState(), 2, 1.9), 0, -0.4);
  const p = probabilities(s);
  const byForm: Record<string, number> = {};
  for (const f of TRAITS.form) byForm[f] = 0;
  for (let i = 0; i < DIM; i++) byForm[traitsFromBits(bitsOf(i)).form] += p[i];
  const got = formProbabilities(s);
  return TRAITS.form.every((f) => near(got[f], byForm[f]));
});

await check("serialise rounds to 1e-12 and round-trips through JSON", () => {
  const s = RY(CNOT(H(dayStartState(), 3), 3, 8), 1, 0.37);
  const text = JSON.stringify(serialise(s));
  const data = JSON.parse(text);
  const back = deserialise(data);
  const same = Array.from(back.re).every((v, i) => near(v, s.re[i], 1e-11)) && Array.from(back.im).every((v, i) => near(v, s.im[i], 1e-11));
  const rounded = data.re.every((v: number) => near(v * 1e12, Math.round(v * 1e12), 1e-3)) && !text.includes("-0,");
  return same && rounded && data.re.length === DIM && data.im.length === DIM && near(normSquared(back), 1, 1e-9);
});

await check("deserialise rejects bad shapes", () => {
  const bad = [null, {}, { re: [], im: [] }, { re: new Array(DIM).fill("x"), im: new Array(DIM).fill(0) }, { re: new Array(DIM).fill(0), im: new Array(DIM - 1).fill(0) }];
  return bad.every((b) => {
    try {
      deserialise(b);
      return false;
    } catch {
      return true;
    }
  });
});

await check("collapseAt is the next 00:00 UTC after the day start", () => {
  const midday = Date.UTC(2026, 9, 10, 13, 0, 0);
  const midnight = Date.UTC(2026, 9, 10, 0, 0, 0);
  const justAfter = Date.UTC(2026, 9, 10, 0, 0, 0, 123);
  return (
    collapseAtFor(midday) === Date.UTC(2026, 9, 11) &&
    collapseAtFor(midnight) === Date.UTC(2026, 9, 11) &&
    collapseAtFor(justAfter) === Date.UTC(2026, 9, 11)
  );
});

/* --- X signing -------------------------------------------------------- */

await check("percentEncode follows RFC 3986 (reserved !'()* encoded, unreserved kept)", () => {
  return (
    x.percentEncode("Ladies + Gentlemen") === "Ladies%20%2B%20Gentlemen" &&
    x.percentEncode("An encoded string!") === "An%20encoded%20string%21" &&
    x.percentEncode("Dogs, Cats & Mice") === "Dogs%2C%20Cats%20%26%20Mice" &&
    x.percentEncode("☃") === "%E2%98%83" &&
    x.percentEncode("a-z._~*'()") === "a-z._~%2A%27%28%29"
  );
});

// The published OAuth 1.0a example (api.twitter.com statuses/update): base string and signature.
const EXAMPLE = {
  method: "POST",
  url: "https://api.twitter.com/1.1/statuses/update.json",
  params: {
    status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    include_entities: "true",
    oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
    oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "1318622958",
    oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    oauth_version: "1.0",
  },
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  base:
    "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
  signature: "hCtSmYh+iHYCEqBWrE7C7hYmtUk=",
};

await check("OAuth 1.0a signature base string matches the published example", () => {
  return x.signatureBase(EXAMPLE.method, EXAMPLE.url, EXAMPLE.params) === EXAMPLE.base;
});

await check("OAuth 1.0a HMAC-SHA1 signature matches the published example", async () => {
  const sig = await x.oauthSignature(EXAMPLE.method, EXAMPLE.url, EXAMPLE.params, EXAMPLE.consumerSecret, EXAMPLE.tokenSecret);
  return sig === EXAMPLE.signature;
});

await check("oauthHeader carries the same signature and only oauth_* fields", async () => {
  const header = await x.oauthHeader(EXAMPLE.method, EXAMPLE.url, {
    consumerKey: EXAMPLE.params.oauth_consumer_key,
    consumerSecret: EXAMPLE.consumerSecret,
    accessToken: EXAMPLE.params.oauth_token,
    accessSecret: EXAMPLE.tokenSecret,
  }, {
    params: { status: EXAMPLE.params.status, include_entities: "true" },
    nonce: EXAMPLE.params.oauth_nonce,
    timestamp: EXAMPLE.params.oauth_timestamp,
  });
  return (
    header.startsWith("OAuth ") &&
    header.includes(`oauth_signature="${x.percentEncode(EXAMPLE.signature)}"`) &&
    header.includes('oauth_signature_method="HMAC-SHA1"') &&
    header.includes('oauth_version="1.0"') &&
    !header.includes("status=") &&
    !header.includes("include_entities")
  );
});

await check("oauthNonce is 64 hex characters and fresh each time", () => {
  const a = x.oauthNonce();
  const b = x.oauthNonce();
  return /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b) && a !== b;
});

await check("postToX without credentials answers { ok: false, error: 'no credentials' } and sends nothing", async () => {
  const result = await x.postToX({}, "hello");
  const partial = await x.postToX({ X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t" }, "hello");
  return result.ok === false && result.error === "no credentials" && partial.ok === false && partial.error === "no credentials";
});

await check("dayPostText has the agreed shape", () => {
  const text = x.dayPostText(
    { day: 12, bits: "1000100001", form: "virus", character: "sleepy", ability: "phase shift", palette: "ember", actions: 37, pTop: 0.02, measuredAt: 0 },
    "https://dirac.deeper-cf.workers.dev/",
  );
  return (
    text ===
      "Day 12: the quantum pet collapsed into a virus. Sleepy, with phase shift. 37 gates applied by visitors. A new superposition starts now. https://dirac.deeper-cf.workers.dev/pet" &&
    text.length <= 280
  );
});

/* --- the post of a day measured on IBM hardware ------------------------ */

const postDay = {
  day: 12,
  bits: "1000100001",
  form: "virus",
  character: "sleepy",
  ability: "phase shift",
  palette: "ember",
  actions: 37,
  pTop: 0.02,
  measuredAt: 0,
} as const;
const SITE = "https://dirac.deeper-cf.workers.dev";

await check("dayPostText of a simulator day with the hardware fields set is the simulator text", () => {
  const plain = x.dayPostText(postDay, SITE);
  const simulator = x.dayPostText({ ...postDay, source: "simulator", qpuBackend: null, qpuJob: null, qpuNote: "the hardware run did not finish" }, SITE);
  return simulator === plain && !/ibm|measured on/i.test(simulator);
});

await check("dayPostText of a hardware day names the backend and the job", () => {
  const text = x.dayPostText({ ...postDay, source: "qpu", qpuBackend: "ibm_fez", qpuJob: "d3m4k7q1bq9s73fgn2tg" }, SITE);
  return (
    text ===
      "Day 12: the quantum pet collapsed into a virus. Sleepy, with phase shift. 37 gates applied by visitors. Measured on IBM quantum hardware: ibm_fez · job d3m4k7q1bq9s73fgn2tg. A new superposition starts now. https://dirac.deeper-cf.workers.dev/pet" &&
    text.length <= 280
  );
});

await check("dayPostText of a hardware day without a job id, or with a hostile one, leaves the job out", () => {
  const noJob = x.dayPostText({ ...postDay, source: "qpu", qpuBackend: "ibm_fez", qpuJob: null }, SITE);
  const hostile = x.dayPostText({ ...postDay, source: "qpu", qpuBackend: "ibm_fez https://evil.test", qpuJob: "x y @someone" }, SITE);
  return (
    noJob.includes(" Measured on IBM quantum hardware: ibm_fez. A new superposition") &&
    hostile.includes(" Measured on IBM quantum hardware. A new superposition") &&
    !/evil|@someone/.test(hostile)
  );
});

await check("dayPostText stays within 280 characters for every trait with a long backend and job id", () => {
  let longest = 0;
  for (const form of TRAITS.form) {
    for (const character of TRAITS.character) {
      for (const ability of TRAITS.ability) {
        const day = { ...postDay, day: 99_999, actions: 99_999, form, character, ability, source: "qpu" as const, qpuBackend: "ibm_marrakesh", qpuJob: "d".repeat(24) };
        longest = Math.max(longest, x.dayPostText(day, SITE).length);
      }
    }
  }
  const tooLong = x.dayPostText({ ...postDay, source: "qpu", qpuBackend: "ibm_fez", qpuJob: "j".repeat(64) }, `https://${"a".repeat(80)}.test`);
  return longest <= 280 && tooLong.length <= 280 && !tooLong.includes("job") && tooLong.includes("ibm_fez");
});

/* --- signed gates (src/lib/petGate.ts, worker parseActExtras) ---------- */

const sk = new Uint8Array(32);
crypto.getRandomValues(sk);
const walletA = base58.encode(ed25519.getPublicKey(sk));
const signOver = (message: string) => base64.encode(ed25519.sign(new TextEncoder().encode(message), sk));

await check("GATE_MESSAGE has the agreed shape, with '-' for a missing target", () => {
  return (
    gate.GATE_MESSAGE(12, "H", 3, null, "ab".repeat(16)) === `dirac:pet:gate:v1:12:H:3:-:${"ab".repeat(16)}` &&
    gate.GATE_MESSAGE(12, "CNOT", 3, 4, "00".repeat(16)) === `dirac:pet:gate:v1:12:CNOT:3:4:${"00".repeat(16)}` &&
    gate.GATE_MESSAGE(1, "X", 0, undefined, "ff".repeat(16)) === `dirac:pet:gate:v1:1:X:0:-:${"ff".repeat(16)}`
  );
});

await check("newGateNonce is 32 lowercase hex, fresh each time, and isGateNonce agrees", () => {
  const a = gate.newGateNonce();
  const b = gate.newGateNonce();
  return (
    gate.isGateNonce(a) && gate.isGateNonce(b) && a !== b && a.length === 32 &&
    !gate.isGateNonce(a.toUpperCase()) && !gate.isGateNonce(a.slice(1)) && !gate.isGateNonce(`${a}0`) && !gate.isGateNonce(12)
  );
});

await check("isWalletAddress accepts a 32-byte base58 key and nothing else", () => {
  // Not `walletA.slice(1)`: dropping one base58 digit usually still decodes to 32 bytes (a leading
  // digit is just a smaller number), so the function rightly accepted it on most runs.
  const bytes = (n: number) => base58.encode(crypto.getRandomValues(new Uint8Array(n)));
  return (
    gate.isWalletAddress(walletA) &&
    !gate.isWalletAddress(bytes(31)) &&
    !gate.isWalletAddress(bytes(33)) &&
    !gate.isWalletAddress("0OIl") &&
    !gate.isWalletAddress("") &&
    !gate.isWalletAddress(null)
  );
});

await check("verifyGateSig accepts the wallet's signature over the exact message, base64 or base58", () => {
  const nonce = gate.newGateNonce();
  const message = gate.GATE_MESSAGE(7, "CNOT", 2, 3, nonce);
  const sigBytes = ed25519.sign(new TextEncoder().encode(message), sk);
  return (
    gate.verifyGateSig(walletA, message, base64.encode(sigBytes)) &&
    gate.verifyGateSig(walletA, message, base58.encode(sigBytes))
  );
});

await check("verifyGateSig refuses another day, gate, qubit, target, nonce, wallet or a malformed signature", () => {
  const nonce = gate.newGateNonce();
  const message = gate.GATE_MESSAGE(7, "CNOT", 2, 3, nonce);
  const sig = signOver(message);
  const otherSk = new Uint8Array(32);
  crypto.getRandomValues(otherSk);
  const walletB = base58.encode(ed25519.getPublicKey(otherSk));
  return (
    !gate.verifyGateSig(walletA, gate.GATE_MESSAGE(8, "CNOT", 2, 3, nonce), sig) &&
    !gate.verifyGateSig(walletA, gate.GATE_MESSAGE(7, "H", 2, 3, nonce), sig) &&
    !gate.verifyGateSig(walletA, gate.GATE_MESSAGE(7, "CNOT", 1, 3, nonce), sig) &&
    !gate.verifyGateSig(walletA, gate.GATE_MESSAGE(7, "CNOT", 2, 4, nonce), sig) &&
    !gate.verifyGateSig(walletA, gate.GATE_MESSAGE(7, "CNOT", 2, 3, gate.newGateNonce()), sig) &&
    !gate.verifyGateSig(walletB, message, sig) &&
    !gate.verifyGateSig(walletA, message, "not base64!!") &&
    !gate.verifyGateSig(walletA, message, base64.encode(new Uint8Array(63))) &&
    !gate.verifyGateSig("nope", message, sig)
  );
});

await check("signGate builds a SignedGate the Worker's check accepts", async () => {
  const signer = {
    address: walletA,
    signMessage: async (m: Uint8Array) => ed25519.sign(m, sk),
  };
  const signed = await gate.signGate(5, "MEASURE", 9, null, signer);
  return (
    signed.day === 5 &&
    signed.wallet === walletA &&
    gate.isGateNonce(signed.nonce) &&
    gate.verifyGateSig(walletA, gate.GATE_MESSAGE(5, "MEASURE", 9, null, signed.nonce), signed.sig)
  );
});

await check("windowOf matches the Worker's fixed one-minute window", () => {
  return gate.windowOf(0) === 0 && gate.windowOf(59_999) === 0 && gate.windowOf(60_000) === 1 && gate.PET_WINDOW_MS === 60_000 && gate.SIGNED_PET_LIMIT === 3 && gate.ANON_PET_LIMIT === 1;
});

await check("parseActExtras: anonymous, day only, the full signed form", () => {
  const nonce = gate.newGateNonce();
  const anon = pet.parseActExtras({ gate: "H", q: 1 });
  const dayOnly = pet.parseActExtras({ gate: "H", q: 1, day: 4 });
  const signed = pet.parseActExtras({ gate: "H", q: 1, day: 4, wallet: walletA, nonce, sig: "c2ln" });
  return (
    anon.ok && anon.value.signed === null && anon.value.day === null &&
    dayOnly.ok && dayOnly.value.signed === null && dayOnly.value.day === 4 &&
    signed.ok && signed.value.day === 4 && signed.value.signed?.wallet === walletA && signed.value.signed.nonce === nonce && signed.value.signed.sig === "c2ln"
  );
});

await check("parseActExtras refuses partial, malformed or day-less signed bodies", () => {
  const nonce = gate.newGateNonce();
  const bad = [
    { wallet: walletA, nonce },
    { wallet: walletA, sig: "c2ln" },
    { wallet: walletA, nonce, sig: "c2ln" },
    { day: 4, wallet: "nope", nonce, sig: "c2ln" },
    { day: 4, wallet: walletA, nonce: "zz", sig: "c2ln" },
    { day: 4, wallet: walletA, nonce, sig: "" },
    { day: 4, wallet: walletA, nonce, sig: "x".repeat(129) },
    { day: 0, wallet: walletA, nonce, sig: "c2ln" },
    { day: "4", wallet: walletA, nonce, sig: "c2ln" },
    { day: 1.5 },
  ];
  return bad.every((b) => !pet.parseActExtras(b).ok) && !pet.parseActExtras("x").ok;
});

await check("parseAct still accepts the plain body and ignores the signed fields", () => {
  const plain = pet.parseAct({ gate: "CNOT", q: 1, t: 2, day: 3, wallet: walletA, nonce: gate.newGateNonce(), sig: "c2ln" });
  return plain.ok && plain.value.gate === "CNOT" && plain.value.q === 1 && plain.value.t === 2;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

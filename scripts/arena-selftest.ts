/**
 * Self-test for the Qubit Arena physics and rules (src/lib/arena.ts): the
 * simulator, commit-reveal, ratings, sampling, the house fighter, the daily
 * tournament (calendar, double round robin, tie-breaks) and the challenges
 * (search family, checkers, daily generator determinism and solvability).
 * Run from the project root:
 *   node scripts/arena-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure.
 */

import {
  ANGLE_STEP,
  CHALLENGE_KINDS,
  DAY_MS,
  DEFAULT_DAY_BITS,
  ELO_K,
  ELO_START,
  GATE_NAMES,
  LAYER_RY_DEG,
  LESSONS,
  MAX_POST,
  MAX_PRE,
  SPAR_SHOTS,
  TOURNAMENT_MAX_ENTRIES,
  applyCNOT,
  applyH,
  applyRY,
  applyX,
  applyZ,
  canonicalCircuit,
  challengeGoal,
  checkChallenge,
  circuitFromJson,
  circuitLabel,
  commitDocHash,
  commitHash,
  compareStandings,
  dailyChallenge,
  dayOf,
  dayStart,
  eloAfter,
  emptyCircuit,
  expectedScore,
  fighterStyle,
  houseFighter,
  isDay,
  isSalt,
  mulberry32,
  newBoutId,
  newSalt,
  parseCircuit,
  probabilitiesOf,
  rivalFighter,
  roundRobin,
  runBout,
  sampleShots,
  scoreA,
  searchFamily,
  seedToUint32,
  sha256Hex,
  shiftDay,
  singleGateFamily,
  solveChallenge,
  sparSeed,
  sparTally,
  tournamentDocHash,
  tournamentPhase,
  tournamentSchedule,
  verdictOf,
  zero2,
  type ArenaGate,
  type Challenge,
  type Circuit,
  type TournamentFighter,
} from "../src/lib/arena.ts";

let failed = 0;
let passed = 0;

function check(name: string, fn: () => boolean): void {
  try {
    if (fn()) {
      passed++;
      console.log(`PASS  ${name}`);
    } else {
      failed++;
      console.log(`FAIL  ${name}`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}  threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const EPS = 1e-9;
const near = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps;
const circuit = (pre: Circuit["pre"], post: Circuit["post"] = []): Circuit => ({ v: 1, pre, post });
const sum = (p: ReturnType<typeof probabilitiesOf>) => p.p00 + p.p01 + p.p10 + p.p11;

/* --- gates --------------------------------------------------------- */

check("|00> has norm 1", () => {
  const p = probabilitiesOf(zero2());
  return p.p00 === 1 && near(sum(p), 1);
});

check("H on q0: |00> -> (|00>+|10>)/sqrt2", () => {
  const s = applyH(zero2(), 0);
  return near(s.re[0], Math.SQRT1_2) && near(s.re[1], Math.SQRT1_2) && s.re[2] === 0 && s.re[3] === 0;
});

check("H twice is the identity, X twice is the identity, Z twice is the identity", () => {
  const s = applyRY(applyH(zero2(), 1), 0, 37);
  const hh = applyH(applyH(s, 0), 0);
  const xx = applyX(applyX(s, 1), 1);
  const zz = applyZ(applyZ(s, 0), 0);
  return [hh, xx, zz].every((t) => t.re.every((v, i) => near(v, s.re[i])) && t.im.every((v, i) => near(v, s.im[i])));
});

check("X flips: X q0 -> |10>, X q1 -> |01> (labels |q0 q1>)", () => {
  const a = probabilitiesOf(applyX(zero2(), 0));
  const b = probabilitiesOf(applyX(zero2(), 1));
  return a.p10 === 1 && b.p01 === 1;
});

check("Z flips the sign of the |1> amplitude only", () => {
  const s = applyZ(applyH(zero2(), 0), 0);
  return near(s.re[0], Math.SQRT1_2) && near(s.re[1], -Math.SQRT1_2);
});

check("RY(theta): P(1) = sin^2(theta/2); RY(180) on |0> is |1>; RY(-90) matches the matrix", () => {
  for (const deg of [0, 30, 90, 120, 180, -90, -180]) {
    const s = applyRY(zero2(), 1, deg);
    const half = (deg * Math.PI) / 360;
    if (!near(probabilitiesOf(s).p01, Math.sin(half) ** 2)) return false;
    if (!near(s.re[0], Math.cos(half)) || !near(s.re[2], Math.sin(half))) return false;
  }
  return near(probabilitiesOf(applyRY(zero2(), 0, 180)).p10, 1);
});

check("CNOT: |10> -> |11>, |01> unchanged, Bell pair from H + CNOT", () => {
  const ten = applyCNOT(applyX(zero2(), 0), 0, 1);
  const one = applyCNOT(applyX(zero2(), 1), 0, 1);
  const bell = probabilitiesOf(applyCNOT(applyH(zero2(), 0), 0, 1));
  return probabilitiesOf(ten).p11 === 1 && probabilitiesOf(one).p01 === 1 && near(bell.p00, 0.5) && near(bell.p11, 0.5);
});

check("gates do not mutate their input", () => {
  const s = zero2();
  applyH(s, 0);
  applyX(s, 1);
  applyZ(s, 0);
  applyRY(s, 1, 45);
  applyCNOT(s, 0, 1);
  return s.re[0] === 1 && s.re[1] === 0 && s.re[2] === 0 && s.re[3] === 0 && s.im.every((v) => v === 0);
});

/* --- the bout ------------------------------------------------------ */

check(`H on q0 alone with the fixed layer: pA = cos^2(${LAYER_RY_DEG / 2}) = 0.75 (p00 0.75, p01 0.25)`, () => {
  const p = runBout(circuit([{ g: "H" }]), emptyCircuit());
  return near(p.pA, 0.75) && near(p.p00, 0.75) && near(p.p01, 0.25) && near(p.p10, 0) && near(p.p11, 0) && near(sum(p), 1);
});

check("two empty circuits: the layer alone gives A 0.75 (c^2 on a Bell pair)", () => {
  const p = runBout(emptyCircuit(), emptyCircuit());
  return near(p.pA, 0.75) && near(p.p00, 0.375) && near(p.p11, 0.375) && near(p.p01, 0.125) && near(p.p10, 0.125);
});

check("B post RY(-60) cancels the layer rotation: pure Bell pair, pA = 1", () => {
  const p = runBout(emptyCircuit(), circuit([], [{ g: "RY", t: -60 }]));
  return near(p.pA, 1) && near(p.p00, 0.5) && near(p.p11, 0.5);
});

check("B post RY(120) flips parity: pA = 0, verdict b", () => {
  const p = runBout(emptyCircuit(), circuit([], [{ g: "RY", t: 120 }]));
  return near(p.pA, 0) && verdictOf(p.pA) === "b";
});

check("A pre X then layer: pA still 0.75 (sign flip does not change parity odds)", () => {
  const p = runBout(circuit([{ g: "X" }]), emptyCircuit());
  return near(p.pA, 0.75);
});

check("probabilities sum to 1 for full circuits", () => {
  const a = circuit([{ g: "RY", t: 35 }, { g: "H" }, { g: "Z" }], [{ g: "RY", t: -120 }, { g: "X" }]);
  const b = circuit([{ g: "X" }, { g: "RY", t: 175 }, { g: "H" }], [{ g: "H" }, { g: "Z" }]);
  const p = runBout(a, b);
  return near(sum(p), 1) && p.pA >= 0 && p.pA <= 1;
});

check("verdict: exact rule with the 1e-9 band", () => {
  return (
    verdictOf(0.5) === "draw" &&
    verdictOf(0.5 + 5e-10) === "draw" &&
    verdictOf(0.5 - 5e-10) === "draw" &&
    verdictOf(0.5 + 2e-9) === "a" &&
    verdictOf(0.5 - 2e-9) === "b" &&
    verdictOf(0.75) === "a" &&
    verdictOf(0) === "b"
  );
});

/* --- canonical form, commit, reveal ---------------------------------- */

check("canonical JSON has the fixed key order and no whitespace", () => {
  const c = circuit([{ g: "H" }, { g: "RY", t: -45 }], [{ g: "X" }]);
  const mixedOrder = { post: [{ g: "X" }], pre: [{ g: "H" }, { t: -45, g: "RY" }], v: 1 } as unknown as Circuit;
  const text = canonicalCircuit(c);
  return text === '{"v":1,"pre":[{"g":"H"},{"g":"RY","t":-45}],"post":[{"g":"X"}]}' && canonicalCircuit(mixedOrder) === text;
});

check("commit = sha256(canonical + ':' + salt), stable, and reveal round-trips through JSON", () => {
  const c = circuit([{ g: "RY", t: 90 }, { g: "Z" }], [{ g: "H" }]);
  const salt = "00112233445566778899aabbccddeeff";
  const commit = commitHash(c, salt);
  const expected = sha256Hex(`${canonicalCircuit(c)}:${salt}`);
  const back = circuitFromJson(JSON.stringify(JSON.parse(canonicalCircuit(c))));
  return (
    commit === expected &&
    /^[0-9a-f]{64}$/.test(commit) &&
    back !== null &&
    commitHash(back, salt) === commit &&
    commitHash(c, "ffffffffffffffffffffffffffffffff") !== commit &&
    commitHash(circuit([{ g: "RY", t: 95 }, { g: "Z" }], [{ g: "H" }]), salt) !== commit
  );
});

check("commitDocHash is sha256 of the commit message", () => {
  const commit = "a".repeat(64);
  return commitDocHash(commit) === sha256Hex(`dirac:arena:commit:v1:${commit}`);
});

check("newSalt is 32 hex and fresh; newBoutId is 16 hex", () => {
  const a = newSalt();
  const b = newSalt();
  return isSalt(a) && isSalt(b) && a !== b && /^[0-9a-f]{16}$/.test(newBoutId());
});

/* --- validation ------------------------------------------------------ */

check("validation accepts the full grammar", () => {
  const ok = [
    { v: 1, pre: [], post: [] },
    { v: 1, pre: [{ g: "H" }, { g: "X" }, { g: "Z" }], post: [{ g: "RY", t: -180 }, { g: "RY", t: 180 }] },
    { v: 1, pre: [{ g: "RY", t: 0 }], post: [] },
    { v: 1, pre: [{ g: "RY", t: 5 }], post: [{ g: "RY", t: -5 }] },
  ];
  return ok.every((c) => parseCircuit(c).ok);
});

check("validation rejects bad circuits", () => {
  const bad: unknown[] = [
    null,
    "H",
    [],
    { v: 2, pre: [], post: [] },
    { v: 1, pre: [], post: [], extra: 1 },
    { v: 1, pre: [{ g: "H" }, { g: "H" }, { g: "H" }, { g: "H" }], post: [] },
    { v: 1, pre: [], post: [{ g: "X" }, { g: "X" }, { g: "X" }] },
    { v: 1, pre: [{ g: "CNOT" }], post: [] },
    { v: 1, pre: [{ g: "T" }], post: [] },
    { v: 1, pre: [{ g: "RY" }], post: [] },
    { v: 1, pre: [{ g: "RY", t: 7 }], post: [] },
    { v: 1, pre: [{ g: "RY", t: 185 }], post: [] },
    { v: 1, pre: [{ g: "RY", t: -185 }], post: [] },
    { v: 1, pre: [{ g: "RY", t: "45" }], post: [] },
    { v: 1, pre: [{ g: "RY", t: 45.5 }], post: [] },
    { v: 1, pre: [{ g: "H", t: 45 }], post: [] },
    { v: 1, pre: [{ g: "H", x: 1 }], post: [] },
    { v: 1, pre: "H", post: [] },
    { v: 1, pre: [] },
  ];
  return bad.every((c) => !parseCircuit(c).ok) && MAX_PRE === 3 && MAX_POST === 2 && ANGLE_STEP === 5;
});

check("labels and styles", () => {
  const h = circuit([{ g: "H" }, { g: "RY", t: 45 }], [{ g: "X" }]);
  const p = circuit([{ g: "X" }, { g: "Z" }], [{ g: "H" }]);
  return (
    circuitLabel(h) === "H · RY 45 | X" &&
    circuitLabel(emptyCircuit()) === "identity" &&
    fighterStyle(h) === "hadamard" &&
    fighterStyle(p) === "pauli" &&
    fighterStyle(emptyCircuit()) === "hadamard"
  );
});

/* --- rating ----------------------------------------------------------- */

check("ELO: equal ratings, A wins -> +16/-16; draw -> no change; K = 32, start 1200", () => {
  const win = eloAfter(1200, 1200, 1);
  const draw = eloAfter(1200, 1200, 0.5);
  return near(win.a, 1216) && near(win.b, 1184) && near(draw.a, 1200) && near(draw.b, 1200) && ELO_K === 32 && ELO_START === 1200;
});

check("ELO: expected score and the underdog gain", () => {
  const e = expectedScore(1400, 1200);
  const upset = eloAfter(1400, 1200, 0);
  return near(e, 1 / (1 + 10 ** -0.5)) && near(upset.a, 1400 - 32 * e) && near(upset.b, 1200 + 32 * e) && near(upset.a + upset.b, 2600);
});

check("scoreA maps results (forfeit of B is a win for A)", () => {
  return scoreA("a") === 1 && scoreA("b") === 0 && scoreA("draw") === 0.5 && scoreA("b_forfeit") === 1 && scoreA("a_forfeit") === 0;
});

/* --- PRNG and sampling -------------------------------------------------- */

check("mulberry32 is deterministic, in [0,1), and differs by seed", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const c = mulberry32(12346);
  const xs = Array.from({ length: 1000 }, a);
  const ys = Array.from({ length: 1000 }, b);
  const zs = Array.from({ length: 1000 }, c);
  return xs.every((x, i) => x === ys[i] && x >= 0 && x < 1) && xs.some((x, i) => x !== zs[i]) && new Set(xs).size > 990;
});

check("seedToUint32 reads the first 4 bytes big-endian", () => {
  return seedToUint32("deadbeef00") === 0xdeadbeef && seedToUint32("00000001ff") === 1;
});

check("sparSeed = sha256(dayBits + boutId) and the tally is reproducible", () => {
  const p = runBout(circuit([{ g: "RY", t: 50 }]), circuit([{ g: "H" }], [{ g: "RY", t: 30 }]));
  const id = "0123456789abcdef";
  const seed = sparSeed(DEFAULT_DAY_BITS, id);
  const t1 = sparTally(p, DEFAULT_DAY_BITS, id);
  const t2 = sampleShots(p, SPAR_SHOTS, mulberry32(seedToUint32(seed)));
  const t3 = sparTally(p, "1010101010", id);
  return (
    seed === sha256Hex(`${DEFAULT_DAY_BITS}${id}`) &&
    t1.sequence === t2.sequence &&
    t1.a === t2.a &&
    t1.n === 100 &&
    t1.a + t1.b === 100 &&
    t1.sequence.length === 100 &&
    t1.counts["00"] + t1.counts["01"] + t1.counts["10"] + t1.counts["11"] === 100 &&
    t1.a === t1.counts["00"] + t1.counts["11"] &&
    t3.sequence !== t1.sequence
  );
});

check("sampling frequencies follow the distribution (20000 shots)", () => {
  const p = runBout(circuit([{ g: "RY", t: 70 }]), circuit([{ g: "X" }], [{ g: "RY", t: -40 }]));
  const t = sampleShots(p, 20000, mulberry32(7));
  const fA = t.a / 20000;
  const f00 = t.counts["00"] / 20000;
  return Math.abs(fA - p.pA) < 0.02 && Math.abs(f00 - p.p00) < 0.02;
});

check("a certain outcome samples only itself", () => {
  const p = runBout(emptyCircuit(), circuit([], [{ g: "RY", t: -60 }]));
  const t = sampleShots(p, 500, mulberry32(99));
  return t.a === 500 && t.counts["01"] === 0 && t.counts["10"] === 0;
});

/* --- house fighter --------------------------------------------------------- */

check("house fighter is deterministic per day bits, valid, and changes with the bits", () => {
  const a = houseFighter(DEFAULT_DAY_BITS);
  const b = houseFighter(DEFAULT_DAY_BITS);
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const bits = i.toString(2).padStart(10, "0");
    const c = houseFighter(bits);
    if (!parseCircuit(c).ok || c.pre.length < 1 || c.pre.length > 3 || c.post.length > 2) return false;
    seen.add(canonicalCircuit(c));
  }
  return canonicalCircuit(a) === canonicalCircuit(b) && seen.size > 40 && canonicalCircuit(houseFighter("not bits")) === canonicalCircuit(a);
});

check("rival fighter: deterministic, valid, not the house fighter", () => {
  let differs = 0;
  for (let i = 0; i < 64; i++) {
    const bits = i.toString(2).padStart(10, "0");
    const r = rivalFighter(bits);
    if (!parseCircuit(r).ok || canonicalCircuit(r) !== canonicalCircuit(rivalFighter(bits))) return false;
    if (canonicalCircuit(r) !== canonicalCircuit(houseFighter(bits))) differs++;
  }
  return differs > 56;
});

/* --- tournament calendar ---------------------------------------------------- */

check("days: dayOf, isDay, dayStart, shiftDay", () => {
  return (
    dayOf(Date.UTC(2026, 9, 11, 23, 59, 59, 999)) === "2026-10-11" &&
    dayOf(Date.UTC(2026, 9, 12)) === "2026-10-12" &&
    isDay("2026-10-11") &&
    isDay("2028-02-29") &&
    !isDay("2026-02-29") &&
    !isDay("2026-13-01") &&
    !isDay("2026-1-01") &&
    !isDay("1969-12-31") &&
    !isDay(" 2026-10-11") &&
    !isDay(20261011) &&
    dayStart("2026-10-11") === Date.UTC(2026, 9, 11) &&
    shiftDay("2026-12-31", 1) === "2027-01-01" &&
    shiftDay("2026-03-01", -1) === "2026-02-28"
  );
});

check("schedule: entries 00:00-21:00, reveals 21:00-23:59, resolution from 00:00 of the next day", () => {
  const d = "2026-10-11";
  const s = tournamentSchedule(d);
  const at = (h: number, m: number, sec = 0) => Date.UTC(2026, 9, 11, h, m, sec);
  return (
    s.opensAt === at(0, 0) &&
    s.entryClosesAt === at(21, 0) &&
    s.revealClosesAt === at(23, 59) &&
    s.resolvesAt === at(0, 0) + DAY_MS &&
    tournamentPhase(d, at(0, 0) - 1) === "upcoming" &&
    tournamentPhase(d, at(0, 0)) === "entry" &&
    tournamentPhase(d, at(20, 59, 59)) === "entry" &&
    tournamentPhase(d, at(21, 0)) === "reveal" &&
    tournamentPhase(d, at(23, 58, 59)) === "reveal" &&
    tournamentPhase(d, at(23, 59)) === "closing" &&
    tournamentPhase(d, s.resolvesAt) === "resolved"
  );
});

check("tournament seal message: sha256('dirac:arena:tournament:v1:' + day + ':' + commit)", () => {
  const commit = "b".repeat(64);
  return (
    tournamentDocHash("2026-10-11", commit) === sha256Hex(`dirac:arena:tournament:v1:2026-10-11:${commit}`) &&
    tournamentDocHash("2026-10-12", commit) !== tournamentDocHash("2026-10-11", commit) &&
    tournamentDocHash("2026-10-11", commit) !== commitDocHash(commit) &&
    TOURNAMENT_MAX_ENTRIES === 64
  );
});

/* --- round robin ---------------------------------------------------------------- */

const fighter = (wallet: string, c: Circuit, enteredAt: number): TournamentFighter => ({
  wallet,
  commit: sha256Hex(wallet).padEnd(64, "0").slice(0, 64),
  enteredAt,
  circuit: c,
});

check("round robin, two identities: 0.75 both ways, 1 point each, margin 0, the earlier entry first", () => {
  const rr = roundRobin([fighter("w-late", emptyCircuit(), 2000), fighter("w-early", emptyCircuit(), 1000)]);
  const [first, second] = rr.standings;
  return (
    first.wallet === "w-early" &&
    second.wallet === "w-late" &&
    first.place === 1 &&
    second.place === 2 &&
    first.points === 1 &&
    second.points === 1 &&
    near(first.margin, 0) &&
    near(second.margin, 0) &&
    first.wins === 1 &&
    first.losses === 1 &&
    first.games === 2 &&
    rr.matrix[0][0] === null &&
    rr.matrix[1][1] === null &&
    near(rr.matrix[0][1]!, 0.75) &&
    near(rr.matrix[1][0]!, 0.75)
  );
});

check("round robin: same entry time falls back to the wallet, so the order is total", () => {
  const rr = roundRobin([fighter("wb", emptyCircuit(), 5), fighter("wa", emptyCircuit(), 5)]);
  return rr.standings[0].wallet === "wa" && rr.standings[1].wallet === "wb";
});

check("round robin: an exact draw scores 0.5 each and counts as a draw", () => {
  const drawer = circuit([], [{ g: "RY", t: -30 }]);
  const p1 = runBout(drawer, emptyCircuit()).pA;
  const p2 = runBout(emptyCircuit(), drawer).pA;
  const rr = roundRobin([fighter("d", drawer, 1), fighter("e", emptyCircuit(), 2)]);
  const d = rr.standings.find((s) => s.wallet === "d")!;
  const e = rr.standings.find((s) => s.wallet === "e")!;
  const expectD = (verdictOf(p1) === "draw" ? 0.5 : verdictOf(p1) === "a" ? 1 : 0) + (verdictOf(p2) === "draw" ? 0.5 : verdictOf(p2) === "b" ? 1 : 0);
  return verdictOf(p1) === "draw" && d.draws >= 1 && e.draws >= 1 && d.points === expectD && d.points + e.points === 2;
});

check("round robin: a stronger margin breaks a tie on points", () => {
  // Synthetic rows through the comparator: equal points, margins 0.3 and 0.2.
  const base = { points: 2, enteredAt: 1, wallet: "x" };
  const hi = { ...base, margin: 0.3, wallet: "late", enteredAt: 9 };
  const lo = { ...base, margin: 0.2, wallet: "early", enteredAt: 1 };
  const sameish = { ...base, margin: 0.3 + 1e-13, wallet: "early", enteredAt: 1 };
  return compareStandings(hi, lo) < 0 && compareStandings(lo, hi) > 0 && compareStandings(sameish, hi) < 0 && compareStandings({ ...base, points: 3, margin: -1 }, hi) < 0;
});

check("round robin on 8 random fighters: matrix, points, margins and order all agree with an independent count", () => {
  const rng = mulberry32(2026);
  const gate = (): ArenaGate => {
    const g = GATE_NAMES[Math.floor(rng() * 4)];
    return g === "RY" ? { g, t: -180 + 5 * Math.floor(rng() * 73) } : { g };
  };
  const make = (): Circuit => circuit(Array.from({ length: 1 + Math.floor(rng() * 3) }, gate), Array.from({ length: Math.floor(rng() * 3) }, gate));
  const fs = Array.from({ length: 8 }, (_, i) => fighter(`w${i}`, make(), 1000 + i));
  fs.push(fighter("w8", fs[2].circuit, 900)); // an exact twin of w2, entered earlier: same points and margin, so it ranks first
  const rr = roundRobin(fs);
  const n = fs.length;
  const pts = new Map<string, number>();
  const mar = new Map<string, number>();
  for (const a of fs) {
    for (const b of fs) {
      if (a === b) continue;
      const p = runBout(a.circuit, b.circuit).pA;
      const v = verdictOf(p);
      pts.set(a.wallet, (pts.get(a.wallet) ?? 0) + (v === "a" ? 1 : v === "draw" ? 0.5 : 0));
      pts.set(b.wallet, (pts.get(b.wallet) ?? 0) + (v === "b" ? 1 : v === "draw" ? 0.5 : 0));
      mar.set(a.wallet, (mar.get(a.wallet) ?? 0) + (p - 0.5));
      mar.set(b.wallet, (mar.get(b.wallet) ?? 0) + (0.5 - p));
    }
  }
  const s = rr.standings;
  const matrixOk = rr.matrix.every((row, i) =>
    row.every((p, j) => (i === j ? p === null : p !== null && near(p, runBout(s[i].circuit, s[j].circuit).pA, 0))),
  );
  const totalsOk = near(s.reduce((x, r) => x + r.points, 0), n * (n - 1)) && near(s.reduce((x, r) => x + r.margin, 0), 0, 1e-9);
  const rowsOk = s.every((r, i) => r.place === i + 1 && r.games === 2 * (n - 1) && r.wins + r.draws + r.losses === r.games && r.points === pts.get(r.wallet) && near(r.margin, mar.get(r.wallet)!, 1e-9));
  const orderOk = s.every((r, i) => i === 0 || compareStandings(s[i - 1], r) < 0);
  const twins = s.findIndex((r) => r.wallet === "w8") < s.findIndex((r) => r.wallet === "w2");
  const tiedPoints = s.some((r, i) => i > 0 && r.points === s[i - 1].points);
  return matrixOk && totalsOk && rowsOk && orderOk && twins && tiedPoints;
});

check("round robin games are bitwise runBout: 48 random full circuits, every ordered pair (2,256 games)", () => {
  const rng = mulberry32(4242);
  const angles = [-180, -175, -90, -5, 0, 5, 60, 90, 175, 180];
  const gate = (): ArenaGate => {
    const g = GATE_NAMES[Math.floor(rng() * 4)];
    if (g !== "RY") return { g };
    // Half the RY gates on the edge angles, half anywhere on the grid.
    return { g, t: rng() < 0.5 ? angles[Math.floor(rng() * angles.length)] : -180 + 5 * Math.floor(rng() * 73) };
  };
  const make = (): Circuit => circuit(Array.from({ length: Math.floor(rng() * (MAX_PRE + 1)) }, gate), Array.from({ length: Math.floor(rng() * (MAX_POST + 1)) }, gate));
  const fs = Array.from({ length: 48 }, (_, i) => fighter(`b${i}`, i === 0 ? emptyCircuit() : make(), i));
  const rr = roundRobin(fs);
  const s = rr.standings;
  return rr.matrix.every((row, i) => row.every((p, j) => (i === j ? p === null : p === runBout(s[i].circuit, s[j].circuit).pA)));
});

check("round robin edge cases: nobody and one fighter", () => {
  const none = roundRobin([]);
  const one = roundRobin([fighter("solo", emptyCircuit(), 1)]);
  return none.standings.length === 0 && none.matrix.length === 0 && one.standings[0].points === 0 && one.standings[0].games === 0 && one.matrix[0][0] === null;
});

/* --- challenges: search family and checkers --------------------------------------- */

check("search family: 10,368 circuits, single-gate family: 151, all valid", () => {
  const fam = searchFamily();
  const single = singleGateFamily();
  return fam.length === 72 * 144 && single.length === 1 + 2 * 75 && [...fam, ...single].every((c) => parseCircuit(c).ok) && single.every((c) => c.pre.length + c.post.length <= 1);
});

check("search family reaches the distribution of random full circuits (24 samples, as A and as B)", () => {
  const rng = mulberry32(77);
  const gate = (): ArenaGate => {
    const g = GATE_NAMES[Math.floor(rng() * 4)];
    return g === "RY" ? { g, t: -180 + 5 * Math.floor(rng() * 73) } : { g };
  };
  const fam = searchFamily();
  for (let k = 0; k < 24; k++) {
    const mine = circuit([gate(), gate(), gate()], [gate(), gate()]);
    const opp = circuit([gate()], [gate()]);
    const asA = k % 2 === 0;
    const target = asA ? runBout(mine, opp) : runBout(opp, mine);
    const hit = fam.some((c) => {
      const p = asA ? runBout(c, opp) : runBout(opp, c);
      return near(p.p00, target.p00) && near(p.p01, target.p01) && near(p.p10, target.p10) && near(p.p11, target.p11);
    });
    if (!hit) return false;
  }
  return true;
});

const challenge = (patch: Partial<Challenge>): Challenge => ({
  id: "test",
  kind: "floor",
  title: "t",
  task: "t",
  hint: null,
  role: "a",
  opponent: emptyCircuit(),
  opponentName: "empty opponent",
  outcome: null,
  min: null,
  max: null,
  target: null,
  maxGates: null,
  ...patch,
});
const H_PRE = circuit([{ g: "H" }]); // vs empty: p00 0.75, p01 0.25, pA 0.75
const ALIGN = circuit([], [{ g: "RY", t: 60 }]); // vs empty: pA 1, p00 = p11 = 0.5

check("checker floor: at least x on an outcome, x itself passes (1e-9 tolerance)", () => {
  return (
    checkChallenge(challenge({ kind: "floor", outcome: "00", min: 0.75 }), H_PRE).solved &&
    !checkChallenge(challenge({ kind: "floor", outcome: "00", min: 0.76 }), H_PRE).solved &&
    near(checkChallenge(challenge({ kind: "floor", outcome: "01", min: 0.2 }), H_PRE).value, 0.25)
  );
});

check("checker window: pA inside [min, max]", () => {
  return (
    checkChallenge(challenge({ kind: "window", min: 0.7, max: 0.8 }), emptyCircuit()).solved &&
    !checkChallenge(challenge({ kind: "window", min: 0.8, max: 0.9 }), emptyCircuit()).solved
  );
});

check("checker exact: within 1e-9 only", () => {
  const drawer = circuit([], [{ g: "RY", t: -30 }]);
  const near05 = circuit([], [{ g: "RY", t: -25 }]);
  return (
    checkChallenge(challenge({ kind: "exact", target: 0.5 }), drawer).solved &&
    !checkChallenge(challenge({ kind: "exact", target: 0.5 }), near05).solved &&
    checkChallenge(challenge({ kind: "exact", target: 1 }), ALIGN).solved
  );
});

check("checker beat and hold (hold plays B)", () => {
  const flip = circuit([], [{ g: "RY", t: 120 }]);
  return (
    checkChallenge(challenge({ kind: "beat", min: 0.95 }), ALIGN).solved &&
    !checkChallenge(challenge({ kind: "beat", min: 0.95 }), emptyCircuit()).solved &&
    checkChallenge(challenge({ kind: "hold", role: "b", max: 0.05 }), flip).solved &&
    !checkChallenge(challenge({ kind: "hold", role: "b", max: 0.05 }), emptyCircuit()).solved &&
    near(checkChallenge(challenge({ kind: "hold", role: "b", max: 0.05 }), flip).value, 0)
  );
});

check("checker forbid: the outcome under 1e-9, and the pA floor reported when it fails", () => {
  const ok = checkChallenge(challenge({ kind: "forbid", outcome: "11", min: 0.7 }), H_PRE);
  const low = checkChallenge(challenge({ kind: "forbid", outcome: "11", min: 0.8 }), H_PRE);
  const no = checkChallenge(challenge({ kind: "forbid", outcome: "11", min: null }), emptyCircuit());
  return ok.solved && !low.solved && low.unmet !== null && !no.solved && no.unmet === null;
});

check("checker single: the gate budget is part of the goal", () => {
  const two = circuit([{ g: "Z" }], [{ g: "RY", t: 60 }]);
  const r = checkChallenge(challenge({ kind: "single", min: 0.95, maxGates: 1 }), two);
  return checkChallenge(challenge({ kind: "single", min: 0.95, maxGates: 1 }), ALIGN).solved && !r.solved && /budget/.test(r.unmet ?? "");
});

check("checker split: both |00> and |11> at least x", () => {
  return (
    checkChallenge(challenge({ kind: "split", min: 0.45 }), ALIGN).solved &&
    !checkChallenge(challenge({ kind: "split", min: 0.45 }), H_PRE).solved &&
    near(checkChallenge(challenge({ kind: "split", min: 0.45 }), ALIGN).value, 0.5)
  );
});

check("lessons: the documented solutions solve them, the empty circuit does not", () => {
  const sol: Record<string, Circuit> = {
    "lesson:certain": circuit([], [{ g: "RY", t: 60 }]),
    "lesson:zero": circuit([], [{ g: "RY", t: -120 }]),
    "lesson:draw": circuit([], [{ g: "RY", t: -30 }]),
  };
  return LESSONS.length === 3 && LESSONS.every((l) => checkChallenge(l, sol[l.id]).solved && !checkChallenge(l, emptyCircuit()).solved && solveChallenge(l) !== null);
});

/* --- challenges: the daily generator ----------------------------------------------- */

const bitsOf = (i: number) => i.toString(2).padStart(10, "0");

check("daily challenge is deterministic per bits and keyed by day and bits", () => {
  for (const i of [0, 1, 37, 512, 1023]) {
    const a = dailyChallenge(bitsOf(i), 12);
    const b = dailyChallenge(bitsOf(i), 12);
    if (JSON.stringify(a) !== JSON.stringify(b) || a.id !== `daily:12:${bitsOf(i)}`) return false;
  }
  return (
    JSON.stringify(dailyChallenge("not bits", null)) === JSON.stringify({ ...dailyChallenge(DEFAULT_DAY_BITS, null) }) &&
    dailyChallenge(DEFAULT_DAY_BITS, null).id === `daily:-:${DEFAULT_DAY_BITS}`
  );
});

check("daily challenges over 256 days: every kind and every opponent appears, thresholds on the 0.05 grid", () => {
  const kinds = new Set<string>();
  const opponents = new Set<string>();
  for (let i = 0; i < 1024; i += 4) {
    const ch = dailyChallenge(bitsOf(i), i);
    kinds.add(ch.kind);
    opponents.add(ch.opponentName);
    for (const x of [ch.min, ch.max]) {
      if (x !== null && (x < 0 || x > 1 || Math.abs(x * 20 - Math.round(x * 20)) > 1e-9)) return false;
    }
    if (!ch.task || !challengeGoal(ch) || ch.title === "Certain win") return false;
  }
  return CHALLENGE_KINDS.every((k) => kinds.has(k)) && opponents.size === 3;
});

check("daily challenges are solvable and not solved by the empty circuit (64 days)", () => {
  for (let i = 3; i < 1024; i += 16) {
    const ch = dailyChallenge(bitsOf(i), i);
    const sol = solveChallenge(ch);
    if (!sol || !checkChallenge(ch, sol).solved || checkChallenge(ch, emptyCircuit()).solved) {
      console.log("      unsolvable or trivial:", bitsOf(i), ch.kind, ch.task);
      return false;
    }
  }
  return true;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

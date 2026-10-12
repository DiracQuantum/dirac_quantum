/**
 * Self-test for the pet's weekly hardware collapse (worker/qpu.ts and the
 * replay helpers in worker/pet.ts), without an IBM key. Run from the project
 * root:
 *   node scripts/qpu-selftest.ts
 * Prints PASS/FAIL per check and exits with code 1 on any failure.
 *
 * What it proves:
 * - the native decompositions (H, RY, CNOT over CZ, SWAP routing on a line,
 *   mid-circuit measurements) give the simulator's state up to a global
 *   phase, on random day logs, both from the native program and from the
 *   emitted OpenQASM 3 read back by a small interpreter;
 * - chain finding on a real Heron coupling map (ibm_fez, 156 qubits, as
 *   published in qiskit-ibm-runtime's fake provider, conf_fez.json), with and
 *   without calibration data;
 * - the QASM text for a fixed log (snapshot), the result parser on a result
 *   in the documented REST shape (results[i].data.<register>.samples as hex),
 *   with post-selection on the site's mid-circuit outcomes (the chip draws
 *   its own, so only shots that repeat the site's are draws of its register),
 *   the schedule, the 6 h deadline, the quota guard, instance discovery and
 *   the REST client's headers and request bodies against a mock fetch.
 * The result fixture follows the format in the IBM docs; it is not a
 * recording of a real job (that needs the key).
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
const qpu = await import("../worker/qpu.ts");

type QState = { re: Float64Array; im: Float64Array };
type LogGate = import("../worker/qpu.ts").LogGate;
type NativeOp = import("../worker/qpu.ts").NativeOp;

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

/** Seeded uniform [0, 1): every run tests the same circuits. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = pet.DIM;
const N = pet.N_QUBITS;

/* ------------------------------------------------------------------ */
/* An independent simulator of the native instruction set              */
/* ------------------------------------------------------------------ */

const clone = (s: QState): QState => ({ re: Float64Array.from(s.re), im: Float64Array.from(s.im) });

/** A 2×2 complex matrix [[a, b], [c, d]] on bit p; entries as [re, im]. */
function apply1(s: QState, p: number, m: [number, number][]): QState {
  const out = clone(s);
  const mask = 1 << p;
  const [a, b, c, d] = m;
  for (let i = 0; i < DIM; i++) {
    if ((i & mask) !== 0) continue;
    const j = i | mask;
    const r0 = s.re[i];
    const i0 = s.im[i];
    const r1 = s.re[j];
    const i1 = s.im[j];
    out.re[i] = a[0] * r0 - a[1] * i0 + b[0] * r1 - b[1] * i1;
    out.im[i] = a[0] * i0 + a[1] * r0 + b[0] * i1 + b[1] * r1;
    out.re[j] = c[0] * r0 - c[1] * i0 + d[0] * r1 - d[1] * i1;
    out.im[j] = c[0] * i0 + c[1] * r0 + d[0] * i1 + d[1] * r1;
  }
  return out;
}

/** IBM's definitions: RZ(λ) = diag(e^{−iλ/2}, e^{iλ/2}), SX = ½[[1+i, 1−i], [1−i, 1+i]], X, CZ = diag(1, 1, 1, −1). */
const RZm = (l: number): [number, number][] => [
  [Math.cos(-l / 2), Math.sin(-l / 2)],
  [0, 0],
  [0, 0],
  [Math.cos(l / 2), Math.sin(l / 2)],
];
const SXm: [number, number][] = [
  [0.5, 0.5],
  [0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
];
const Xm: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 0],
  [0, 0],
];

function cz(s: QState, a: number, b: number): QState {
  const out = clone(s);
  const m = (1 << a) | (1 << b);
  for (let i = 0; i < DIM; i++) {
    if ((i & m) === m) {
      out.re[i] = -s.re[i];
      out.im[i] = -s.im[i];
    }
  }
  return out;
}

function project(s: QState, p: number, outcome: number): QState | null {
  const r = pet.projectOnto(s, p, outcome === 1 ? 1 : 0);
  return r;
}

/** Runs the native program on positions; mid-circuit measurements forced to the site's outcomes, final ones skipped. */
function runNative(ops: NativeOp[], mids: (0 | 1)[]): QState | null {
  let s: QState | null = pet.zeroState();
  for (const o of ops) {
    if (!s) return null;
    switch (o.op) {
      case "rz":
        s = apply1(s, o.p, RZm(o.angle));
        break;
      case "sx":
        s = apply1(s, o.p, SXm);
        break;
      case "x":
        s = apply1(s, o.p, Xm);
        break;
      case "cz":
        s = cz(s, o.a, o.b);
        break;
      case "measure":
        if (o.reg === "m") s = project(s, o.p, mids[o.bit]);
        break;
    }
  }
  return s;
}

/** Reads emitted QASM back into native ops on positions (position = index of the physical qubit in `chain`). */
function parseQasm(text: string, chain: number[]): NativeOp[] {
  const ops: NativeOp[] = [];
  const pos = (phys: string): number => {
    const p = chain.indexOf(Number(phys));
    if (p < 0) throw new Error(`qubit $${phys} is not on the chain`);
    return p;
  };
  for (const line of text.split("\n")) {
    if (line === "" || line === "OPENQASM 3.0;" || line === 'include "stdgates.inc";' || /^bit\[\d+\] [cm];$/.test(line)) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^rz\((-?\d+(?:\.\d+)?)\) \$(\d+);$/))) ops.push({ op: "rz", p: pos(m[2]), angle: Number(m[1]) });
    else if ((m = line.match(/^(sx|x) \$(\d+);$/))) ops.push({ op: m[1] as "sx" | "x", p: pos(m[2]) });
    else if ((m = line.match(/^cz \$(\d+), \$(\d+);$/))) ops.push({ op: "cz", a: pos(m[1]), b: pos(m[2]) });
    else if ((m = line.match(/^([cm])\[(\d+)\] = measure \$(\d+);$/))) ops.push({ op: "measure", reg: m[1] as "c" | "m", bit: Number(m[2]), p: pos(m[3]) });
    else throw new Error(`unexpected QASM line: ${line}`);
  }
  return ops;
}

/** The position-ordered state seen with logical qubit q at bit q (layout[q] = its position). */
function toLogical(s: QState, layout: number[]): QState {
  const out = { re: new Float64Array(DIM), im: new Float64Array(DIM) };
  for (let i = 0; i < DIM; i++) {
    let j = 0;
    for (let q = 0; q < N; q++) if ((i >> q) & 1) j |= 1 << layout[q];
    out.re[i] = s.re[j];
    out.im[i] = s.im[j];
  }
  return out;
}

/** A random day: gates applied by the site's own simulator, so every MEASURE outcome is one it could draw. */
function randomDay(rand: () => number, length: number): LogGate[] {
  const gates: LogGate[] = [];
  let s = pet.dayStartState();
  for (let k = 0; k < length; k++) {
    const q = Math.floor(rand() * N);
    const r = rand();
    if (r < 0.2) {
      gates.push({ gate: "H", q });
      s = pet.H(s, q);
    } else if (r < 0.35) {
      gates.push({ gate: "X", q });
      s = pet.X(s, q);
    } else if (r < 0.65) {
      // half the CNOTs on the page's pattern (q → q+1 mod 10, so 9 → 0 wraps), half on any pair
      const t = rand() < 0.5 ? (q + 1) % N : (q + 1 + Math.floor(rand() * (N - 1))) % N;
      gates.push({ gate: "CNOT", q, t });
      s = pet.CNOT(s, q, t);
    } else if (r < 0.82) {
      const theta = (rand() - 0.5) * Math.PI;
      gates.push({ gate: "MUTATE", q, theta });
      s = pet.RY(s, q, theta);
    } else if (r < 0.92) {
      const m = pet.measure(s, q, rand);
      gates.push({ gate: "MEASURE", q, outcome: m.outcome });
      s = m.state;
    } else {
      gates.push({ gate: "PROTECT", q });
    }
  }
  return gates;
}

const FIDELITY_OK = 1 - 1e-9;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * ibm_fez (Heron r2, 156 qubits): the undirected coupling map of
 * qiskit-ibm-runtime/fake_provider/backends/fez/conf_fez.json (backend
 * version 1.2.8), 176 couplers; the backend lists each in both directions.
 */
const FEZ_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [3, 16], [4, 5], [5, 6], [6, 7], [7, 8], [7, 17], [8, 9], [9, 10], [10, 11], [11, 12],
  [11, 18], [12, 13], [13, 14], [14, 15], [15, 19], [16, 23], [17, 27], [18, 31], [19, 35], [20, 21], [21, 22], [21, 36],
  [22, 23], [23, 24], [24, 25], [25, 26], [25, 37], [26, 27], [27, 28], [28, 29], [29, 30], [29, 38], [30, 31], [31, 32],
  [32, 33], [33, 34], [33, 39], [34, 35], [36, 41], [37, 45], [38, 49], [39, 53], [40, 41], [41, 42], [42, 43], [43, 44],
  [43, 56], [44, 45], [45, 46], [46, 47], [47, 48], [47, 57], [48, 49], [49, 50], [50, 51], [51, 52], [51, 58], [52, 53],
  [53, 54], [54, 55], [55, 59], [56, 63], [57, 67], [58, 71], [59, 75], [60, 61], [61, 62], [61, 76], [62, 63], [63, 64],
  [64, 65], [65, 66], [65, 77], [66, 67], [67, 68], [68, 69], [69, 70], [69, 78], [70, 71], [71, 72], [72, 73], [73, 74],
  [73, 79], [74, 75], [76, 81], [77, 85], [78, 89], [79, 93], [80, 81], [81, 82], [82, 83], [83, 84], [83, 96], [84, 85],
  [85, 86], [86, 87], [87, 88], [87, 97], [88, 89], [89, 90], [90, 91], [91, 92], [91, 98], [92, 93], [93, 94], [94, 95],
  [95, 99], [96, 103], [97, 107], [98, 111], [99, 115], [100, 101], [101, 102], [101, 116], [102, 103], [103, 104],
  [104, 105], [105, 106], [105, 117], [106, 107], [107, 108], [108, 109], [109, 110], [109, 118], [110, 111], [111, 112],
  [112, 113], [113, 114], [113, 119], [114, 115], [116, 121], [117, 125], [118, 129], [119, 133], [120, 121], [121, 122],
  [122, 123], [123, 124], [123, 136], [124, 125], [125, 126], [126, 127], [127, 128], [127, 137], [128, 129], [129, 130],
  [130, 131], [131, 132], [131, 138], [132, 133], [133, 134], [134, 135], [135, 139], [136, 143], [137, 147], [138, 151],
  [139, 155], [140, 141], [141, 142], [142, 143], [143, 144], [144, 145], [145, 146], [146, 147], [147, 148], [148, 149],
  [149, 150], [150, 151], [151, 152], [152, 153], [153, 154], [154, 155],
];
const FEZ_DIRECTED: [number, number][] = FEZ_EDGES.flatMap(([a, b]) => [
  [a, b],
  [b, a],
]) as [number, number][];

/** The configuration GET /backends/ibm_fez/configuration answers, reduced to the fields read. */
const FEZ_CONFIG = {
  backend_name: "ibm_fez",
  backend_version: "1.2.8",
  n_qubits: 156,
  basis_gates: ["cz", "id", "rz", "sx", "x"],
  supported_instructions: ["cz", "id", "delay", "measure", "reset", "rz", "sx", "x", "if_else", "for_loop", "switch_case"],
  coupling_map: FEZ_DIRECTED,
};

const isEdge = (a: number, b: number): boolean => FEZ_EDGES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const validChain = (chain: number[] | null): chain is number[] =>
  chain !== null && chain.length === 10 && new Set(chain).size === 10 && chain.every((q, i) => i === 0 || isEdge(chain[i - 1], q));

/* ------------------------------------------------------------------ */
/* Decompositions                                                      */
/* ------------------------------------------------------------------ */

await check("H = RZ(π/2) SX RZ(π/2) and RY(θ) = SX RZ(θ+π) SX RZ(π), up to a global phase, on every qubit", () => {
  const rand = mulberry32(7);
  for (let k = 0; k < 40; k++) {
    const q = Math.floor(rand() * N);
    const theta = (rand() - 0.5) * 4 * Math.PI;
    const start = randomDay(rand, 12);
    const base = pet.replayLog(start);
    if (!base) return false;
    const viaNative = (ops: NativeOp[]) => ops.reduce<QState>((s, o) => (o.op === "rz" ? apply1(s, o.p, RZm(o.angle)) : apply1(s, o.p, SXm)), base);
    const h = viaNative([
      { op: "rz", p: q, angle: Math.PI / 2 },
      { op: "sx", p: q },
      { op: "rz", p: q, angle: Math.PI / 2 },
    ]);
    const ry = viaNative([
      { op: "sx", p: q },
      { op: "rz", p: q, angle: theta + Math.PI },
      { op: "sx", p: q },
      { op: "rz", p: q, angle: Math.PI },
    ]);
    if (pet.stateFidelity(h, pet.H(base, q)) < FIDELITY_OK) return false;
    if (pet.stateFidelity(ry, pet.RY(base, q, theta)) < FIDELITY_OK) return false;
  }
  return true;
});

await check("random days: native program == simulator up to a global phase (300 days, 1..60 gates, wrap-around CNOTs, mid-circuit measures)", () => {
  const rand = mulberry32(2026);
  for (let k = 0; k < 300; k++) {
    const gates = randomDay(rand, 1 + Math.floor(rand() * 60));
    const expected = pet.replayLog(gates);
    const circuit = qpu.buildCircuit(gates);
    const got = runNative(circuit.native, circuit.line.mids);
    if (!expected || !got) return false;
    const f = pet.stateFidelity(expected, toLogical(got, circuit.line.layout));
    if (f < FIDELITY_OK) {
      console.log(`      day ${k}: fidelity ${f}`);
      return false;
    }
  }
  return true;
});

await check("random days: emitted QASM on a Heron chain, read back, == simulator (100 days)", () => {
  const rand = mulberry32(99);
  const chain = qpu.findChain(FEZ_DIRECTED);
  if (!validChain(chain)) return false;
  const directed = new Set(FEZ_DIRECTED.map(([a, b]) => `${a}>${b}`));
  for (let k = 0; k < 100; k++) {
    const gates = randomDay(rand, 1 + Math.floor(rand() * 40));
    const expected = pet.replayLog(gates);
    const circuit = qpu.buildCircuit(gates);
    const text = qpu.emitQasm(circuit.native, circuit.line.mids.length, chain, (a, b) => directed.has(`${a}>${b}`));
    const ops = parseQasm(text, chain);
    for (const o of ops) if (o.op === "cz" && !isEdge(chain[o.a], chain[o.b])) return false;
    const got = runNative(ops, circuit.line.mids);
    if (!expected || !got) return false;
    if (pet.stateFidelity(expected, toLogical(got, circuit.line.layout)) < 1 - 1e-8) return false;
    // every logical qubit is measured once into c[q], from the position it ends on
    const finals = ops.filter((o) => o.op === "measure" && o.reg === "c");
    if (finals.length !== 10 || !finals.every((o) => o.op === "measure" && o.p === circuit.line.layout[o.bit])) return false;
  }
  return true;
});

await check("optimiseLog keeps the state exactly and only shortens (H·H, X·X, CNOT·CNOT cancel, RY merge, PROTECT dropped)", () => {
  const rand = mulberry32(5);
  for (let k = 0; k < 100; k++) {
    const gates = randomDay(rand, 30);
    const a = pet.replayLog(gates);
    const opt = qpu.optimiseLog(gates);
    const b = pet.replayLog(opt);
    if (!a || !b || pet.stateFidelity(a, b) < FIDELITY_OK || opt.length > gates.length) return false;
    if (opt.some((g) => g.gate === "PROTECT")) return false;
    if (opt.filter((g) => g.gate === "MEASURE").length !== gates.filter((g) => g.gate === "MEASURE").length) return false;
  }
  const fixed: LogGate[] = [
    { gate: "H", q: 2 },
    { gate: "PROTECT", q: 2 },
    { gate: "H", q: 2 },
    { gate: "CNOT", q: 3, t: 4 },
    { gate: "CNOT", q: 3, t: 4 },
    { gate: "MUTATE", q: 5, theta: 0.25 },
    { gate: "MUTATE", q: 5, theta: 0.5 },
    { gate: "X", q: 6 },
    { gate: "MEASURE", q: 6, outcome: 1 },
    { gate: "X", q: 6 },
  ];
  const opt = qpu.optimiseLog(fixed);
  return (
    opt.length === 4 &&
    opt[0].gate === "MUTATE" &&
    "theta" in opt[0] &&
    opt[0].theta === 0.75 &&
    opt[1].gate === "X" &&
    opt[2].gate === "MEASURE" &&
    opt[3].gate === "X"
  );
});

await check("routing: CNOT 9 → 0 takes 8 SWAPs then one CZ; CNOT q → q+1 takes none", () => {
  const wrap = qpu.routeOnLine([{ gate: "CNOT", q: 9, t: 0 }]);
  const near = qpu.routeOnLine([{ gate: "CNOT", q: 3, t: 4 }]);
  const cx = wrap.ops.filter((o) => o.op === "cx");
  return (
    wrap.swaps === 8 &&
    cx.length === 1 &&
    cx[0].op === "cx" &&
    Math.abs(cx[0].c - cx[0].t) === 1 &&
    wrap.layout[9] === 1 &&
    wrap.layout[0] === 0 &&
    near.swaps === 0 &&
    qpu.buildCircuit([{ gate: "CNOT", q: 3, t: 4 }]).twoQubit === 1 &&
    qpu.buildCircuit([{ gate: "CNOT", q: 9, t: 0 }]).twoQubit === 25
  );
});

await check("an empty day is H on every qubit then the measurement: 10 SX, no CZ, 10 final measures", () => {
  const c = qpu.buildCircuit([]);
  const sx = c.native.filter((o) => o.op === "sx").length;
  const finals = c.native.filter((o) => o.op === "measure").length;
  return sx === 10 && c.twoQubit === 0 && finals === 10 && c.line.mids.length === 0;
});

/* ------------------------------------------------------------------ */
/* QASM snapshot                                                       */
/* ------------------------------------------------------------------ */

const SNAPSHOT_LOG: LogGate[] = [
  { gate: "H", q: 0 },
  { gate: "CNOT", q: 0, t: 1 },
  { gate: "MUTATE", q: 2, theta: 0.5 },
  { gate: "MEASURE", q: 3, outcome: 1 },
  { gate: "PROTECT", q: 4 },
  { gate: "X", q: 5 },
];
const SNAPSHOT_CHAIN = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const SNAPSHOT = `OPENQASM 3.0;
include "stdgates.inc";
bit[10] c;
bit[1] m;
rz(1.570796326794897) $5;
sx $5;
rz(1.570796326794897) $6;
sx $6;
rz(1.570796326794897) $7;
sx $7;
rz(1.570796326794897) $8;
sx $8;
rz(1.570796326794897) $9;
sx $9;
rz(1.570796326794897) $10;
sx $10;
rz(1.570796326794897) $11;
sx $11;
rz(1.570796326794897) $12;
sx $12;
cz $3, $4;
rz(1.570796326794897) $4;
sx $4;
rz(1.570796326794897) $5;
sx $5;
rz(-2.641592653589793) $5;
sx $5;
rz(1.570796326794897) $6;
m[0] = measure $6;
rz(1.570796326794897) $8;
x $8;
c[0] = measure $3;
rz(1.570796326794897) $4;
c[1] = measure $4;
rz(3.141592653589793) $5;
c[2] = measure $5;
c[3] = measure $6;
rz(1.570796326794897) $7;
c[4] = measure $7;
c[5] = measure $8;
rz(1.570796326794897) $9;
c[6] = measure $9;
rz(1.570796326794897) $10;
c[7] = measure $10;
rz(1.570796326794897) $11;
c[8] = measure $11;
rz(1.570796326794897) $12;
c[9] = measure $12;
`;

await check("QASM snapshot: header, registers, ISA gates on physical qubits, mid and final measures", () => {
  const c = qpu.buildCircuit(SNAPSHOT_LOG);
  const text = qpu.emitQasm(c.native, c.line.mids.length, SNAPSHOT_CHAIN);
  if (text !== SNAPSHOT) {
    console.log(text);
    return false;
  }
  return true;
});

await check("formatAngle never writes an exponent; wrapAngle lands in (−π, π]", () => {
  const cases = [1e-13, -3e-9, 1.5707963267948966, -Math.PI, 7 * Math.PI];
  const plain = cases.every((a) => /^-?\d+(\.\d+)?$/.test(qpu.formatAngle(a)));
  const wrapped = [-Math.PI, Math.PI, 3 * Math.PI, -3.5 * Math.PI, 0.1].map(qpu.wrapAngle);
  return plain && qpu.formatAngle(-1e-17) === "0" && wrapped.every((a) => a > -Math.PI - 1e-12 && a <= Math.PI + 1e-12);
});

/* ------------------------------------------------------------------ */
/* Chains on a real coupling map                                       */
/* ------------------------------------------------------------------ */

await check("ibm_fez configuration is a CZ target and has a line of 10 coupled qubits", () => {
  const target = qpu.czTargetFrom(FEZ_CONFIG);
  if (!target.ok) return false;
  const chain = qpu.findChain(target.value.coupling);
  return target.value.nQubits === 156 && target.value.coupling.length === 352 && validChain(chain);
});

await check("an ECR-only or small configuration is refused", () => {
  const ecr = qpu.czTargetFrom({ ...FEZ_CONFIG, basis_gates: ["ecr", "id", "rz", "sx", "x"] });
  const small = qpu.czTargetFrom({ ...FEZ_CONFIG, n_qubits: 5 });
  const noMeasure = qpu.czTargetFrom({ ...FEZ_CONFIG, supported_instructions: ["cz", "rz", "sx", "x"] });
  return !ecr.ok && !small.ok && !noMeasure.ok && !qpu.czTargetFrom(null).ok;
});

await check("calibration data: broken couplers and noisy qubits are avoided, the chosen line scores no worse", () => {
  // The shape of GET /backends/ibm_fez/properties: per-qubit parameter lists, per-pair cz gate_error (1 = broken).
  const rand = mulberry32(11);
  const qubits = Array.from({ length: 156 }, (_, q) => [
    { name: "T1", unit: "us", value: 100, date: "2026-10-11T00:00:00Z" },
    { name: "readout_error", unit: "", value: q < 12 ? 0.3 : 0.005 + rand() * 0.03, date: "2026-10-11T00:00:00Z" },
  ]);
  const gates = FEZ_DIRECTED.map(([a, b]) => ({
    gate: "cz",
    qubits: [a, b],
    name: `cz${a}_${b}`,
    parameters: [{ name: "gate_error", unit: "", value: a === 61 || b === 61 ? 1 : 0.002 + ((a * 7 + b * 13) % 10) / 1000, date: "x" }],
  }));
  const quality = qpu.chainQualityFrom({ backend_name: "ibm_fez", qubits, gates });
  if (!quality) return false;
  const plain = qpu.findChain(FEZ_DIRECTED);
  const scored = qpu.findChain(FEZ_DIRECTED, 10, quality);
  if (!validChain(plain) || !validChain(scored)) return false;
  const score = (p: number[]) =>
    p.reduce((s, q, i) => s + (quality.qubitError.get(q) ?? 0) + (i > 0 ? (quality.edgeError.get(qpu.edgeKey(p[i - 1], q)) ?? 0) : 0), 0);
  return quality.badEdges.has("60-61") && !scored.includes(61) && scored.every((q) => q >= 12) && score(scored) <= score(plain);
});

await check("no chain on a graph without a 10-qubit path (a star and a short line)", () => {
  const star: [number, number][] = Array.from({ length: 20 }, (_, i) => [0, i + 1]);
  const line: [number, number][] = Array.from({ length: 8 }, (_, i) => [i, i + 1]);
  return qpu.findChain(star) === null && qpu.findChain(line) === null;
});

await check("rankBackends: online only, least busy first, too small skipped", () => {
  const ranked = qpu.rankBackends({
    devices: [
      { name: "ibm_torino", status: { name: "online" }, queue_length: 40, qubits: 133 },
      { name: "ibm_fez", status: { name: "online" }, queue_length: 3, qubits: 156 },
      { name: "ibm_marrakesh", status: { name: "paused", reason: "maintenance" }, queue_length: 0, qubits: 156 },
      { name: "ibm_kingston", status: { name: "online" }, queue_length: 3, qubits: 156 },
      { name: "tiny", status: { name: "online" }, queue_length: 0, qubits: 5 },
    ],
  });
  return ranked.join(",") === "ibm_fez,ibm_kingston,ibm_torino" && qpu.rankBackends(null).length === 0;
});

/* ------------------------------------------------------------------ */
/* Log, results, schedule, quota                                       */
/* ------------------------------------------------------------------ */

await check("logFromRows: complete log accepted; count mismatch, mutate without angle, measure without outcome refused", () => {
  const rows = [
    { gate: "H", q: 1, t: null, theta: null, outcome: null },
    { gate: "CNOT", q: 9, t: 0, theta: null, outcome: null },
    { gate: "MUTATE", q: 2, t: null, theta: -0.7, outcome: null },
    { gate: "MEASURE", q: 2, t: null, theta: null, outcome: 1 },
    { gate: "PROTECT", q: 3, t: null, theta: null, outcome: null },
  ];
  const ok = qpu.logFromRows(rows, 5);
  const count = qpu.logFromRows(rows, 6);
  const angle = qpu.logFromRows([{ gate: "MUTATE", q: 2, t: null, theta: null, outcome: null }], 1);
  const outcome = qpu.logFromRows([{ gate: "MEASURE", q: 2, t: null, theta: null, outcome: null }], 1);
  return (
    ok.ok &&
    ok.value.length === 5 &&
    !count.ok &&
    !angle.ok &&
    angle.reason.includes("angle") &&
    !outcome.ok &&
    !qpu.logFromRows([{ gate: "CNOT", q: 1, t: 1, theta: null, outcome: null }], 1).ok
  );
});

await check("replay: the site's stored state is rebuilt from its log; a lost gate is detected", () => {
  const rand = mulberry32(3);
  const gates = randomDay(rand, 25);
  // the stored state is serialised after every gate (rounded to 1e-12): replay must still match
  let stored = pet.dayStartState();
  for (const g of gates) {
    switch (g.gate) {
      case "H":
        stored = pet.H(stored, g.q);
        break;
      case "X":
        stored = pet.X(stored, g.q);
        break;
      case "CNOT":
        stored = pet.CNOT(stored, g.q, g.t);
        break;
      case "MUTATE":
        stored = pet.RY(stored, g.q, g.theta);
        break;
      case "MEASURE":
        stored = pet.projectOnto(stored, g.q, g.outcome) ?? stored;
        break;
      default:
        break;
    }
    stored = pet.deserialise(JSON.parse(JSON.stringify(pet.serialise(stored))));
  }
  const replayed = pet.replayLog(gates);
  // a gate in the log that the stored state never saw (two writes raced): RY on a real state always moves it
  const raced = pet.replayLog([...gates, { gate: "MUTATE", q: 4, theta: 0.9 }]);
  const f = replayed ? pet.stateFidelity(replayed, stored) : 0;
  const g = raced ? pet.stateFidelity(raced, stored) : 1;
  if (!(f >= pet.REPLAY_FIDELITY && g < pet.REPLAY_FIDELITY)) console.log(`      replay ${f}, raced ${g}`);
  return f >= pet.REPLAY_FIDELITY && g < pet.REPLAY_FIDELITY;
});

/** A result in the documented REST shape: two pubs, registers c (10 bits) and m (2 bits), samples as hex. */
function resultFixture(): unknown {
  const dist: string[] = [];
  const mids: string[] = [];
  for (let i = 0; i < 1000; i++) {
    // 600 shots of 1000000101 (bits 0 first) with mids 01, 400 of 0000000000 with mids 11
    dist.push(i < 600 ? "0x205" : "0x0");
    mids.push(i < 600 ? "0x2" : "0x3");
  }
  return {
    results: [
      { data: { c: { samples: ["0x205"], num_bits: 10 }, m: { samples: ["0x3"], num_bits: 2 } }, metadata: { circuit_metadata: {} } },
      { data: { c: { samples: dist, num_bits: 10 }, m: { samples: mids, num_bits: 2 } }, metadata: { circuit_metadata: {} } },
    ],
    metadata: { version: 2 },
  };
}

await check("result parser: post-selection on the site's mid-circuit outcomes (clbit k = bit k), histogram of matching shots", () => {
  // site mids [0, 1] = m value 0x2; the collapse shot read 0x3, so the collapse is the first matching distribution shot
  const parsed = qpu.parseSamplerResult(resultFixture(), [0, 1]);
  if (!parsed.ok) return false;
  const v = parsed.value;
  const postSelected =
    v.bits === "1010000001" &&
    v.midsHardware.join("") === "11" &&
    v.shots === 1000 &&
    v.counts["1010000001"] === 600 &&
    v.counts["0000000000"] === undefined &&
    v.matched === 600 &&
    qpu.bitsFromInt(0x205) === "1010000001";
  // the collapse shot repeated the site (site 11 = 0x3): its own bits are the collapse
  const own = qpu.parseSamplerResult(resultFixture(), [1, 1]);
  const ownOk = own.ok && own.value.bits === "1010000001" && own.value.matched === 400 && own.value.counts["0000000000"] === 400;
  // nobody repeated the site (00): no collapse, nothing compared
  const none = qpu.parseSamplerResult(resultFixture(), [0, 0]);
  const noneOk = none.ok && none.value.bits === null && none.value.matched === 0 && Object.keys(none.value.counts).length === 0;
  // no partial measurements: the collapse shot and every distribution shot count
  const plain = JSON.parse(JSON.stringify(resultFixture()));
  delete plain.results[0].data.m;
  delete plain.results[1].data.m;
  const all = qpu.parseSamplerResult(plain, []);
  const allOk = all.ok && all.value.bits === "1010000001" && all.value.matched === null && all.value.counts["0000000000"] === 400;
  // 60 partial measurements: wider than a double holds exactly, still compared exactly
  const site60 = Array.from({ length: 60 }, (_, i) => ((i * 7) % 3 === 0 ? 1 : 0) as 0 | 1);
  const hex60 = `0x${site60.reduce((acc, b, i) => acc + (BigInt(b) << BigInt(i)), BigInt(0)).toString(16)}`;
  const near60 = `0x${(BigInt(hex60) ^ BigInt(1)).toString(16)}`;
  const wideM = JSON.parse(JSON.stringify(resultFixture()));
  wideM.results[0].data.m = { samples: [near60], num_bits: 60 };
  wideM.results[1].data.m = { samples: wideM.results[1].data.m.samples.map((_: string, i: number) => (i % 4 === 3 ? hex60 : near60)), num_bits: 60 };
  const w = qpu.parseSamplerResult(wideM, site60);
  const wideOk = w.ok && w.value.matched === 250 && w.value.bits === "1010000001" && w.value.midsHardware.length === 60;
  if (!(postSelected && ownOk && noneOk && allOk && wideOk)) console.log(`      ${postSelected} ${ownOk} ${noneOk} ${allOk} ${wideOk}`);
  return postSelected && ownOk && noneOk && allOk && wideOk;
});

await check("publicReason masks instance CRNs and caps the length", () => {
  const masked = qpu.publicReason("POST /v1/jobs answered 403: crn:v1:bluemix:public:quantum-computing:us-east:a/abc123:def:: has no access");
  const long = qpu.publicReason("x".repeat(1000));
  return !masked.includes("abc123") && masked.includes("the instance") && long.length === 300;
});

await check("replayWithOdds: the probability of the site's partial outcomes", () => {
  // day start is uniform: MEASURE q0 -> 1 has p 1/2, measuring q0 again -> 1 is certain, then H q1 and MEASURE q1 -> 0 is 1/2
  const r = pet.replayWithOdds([
    { gate: "MEASURE", q: 0, outcome: 1 },
    { gate: "MEASURE", q: 0, outcome: 1 },
    { gate: "MEASURE", q: 1, outcome: 0 },
  ]);
  const impossible = pet.replayWithOdds([
    { gate: "MEASURE", q: 0, outcome: 1 },
    { gate: "MEASURE", q: 0, outcome: 0 },
  ]);
  return r !== null && Math.abs(r.pMids - 0.25) < 1e-12 && impossible === null && pet.replayLog([]) !== null;
});

await check("result parser refuses malformed results", () => {
  const good = resultFixture() as { results: { data: Record<string, { samples: string[]; num_bits: number }> }[] };
  const oneP = { results: [good.results[0]] };
  const badHex = JSON.parse(JSON.stringify(good));
  badHex.results[1].data.c.samples[5] = "zz";
  const wide = JSON.parse(JSON.stringify(good));
  wide.results[1].data.c.samples[0] = "0x400";
  const width = JSON.parse(JSON.stringify(good));
  width.results[0].data.c.num_bits = 12;
  const noM = JSON.parse(JSON.stringify(good));
  delete noM.results[0].data.m;
  return (
    !qpu.parseSamplerResult(oneP, []).ok &&
    !qpu.parseSamplerResult(badHex, [0, 1]).ok &&
    !qpu.parseSamplerResult(wide, [0, 1]).ok &&
    !qpu.parseSamplerResult(width, [0, 1]).ok &&
    !qpu.parseSamplerResult(noM, [0, 1]).ok &&
    qpu.parseSamplerResult(noM, []).ok &&
    !qpu.parseSamplerResult(null, []).ok
  );
});

await check("hardware vs simulator: identical distributions have fidelity 1, forms add up", () => {
  const sim = new Float64Array(DIM);
  sim[0] = 0.4;
  sim[0x205] = 0.6;
  const cmp = qpu.compareDistributions({ "0000000000": 400, "1010000001": 600 }, sim, pet.TRAITS.form);
  const formSum = cmp.forms.reduce((s, f) => s + f.hardware, 0);
  const off = qpu.compareDistributions({ "1111111111": 1000 }, sim, pet.TRAITS.form);
  // post-selected: 37 matching shots of 1000 are compared, the total is kept
  const post = qpu.compareDistributions({ "1010000001": 37 }, sim, pet.TRAITS.form, 1000);
  return (
    Math.abs(cmp.fidelity - 1) < 1e-12 &&
    Math.abs(formSum - 1) < 1e-12 &&
    cmp.top[0].bits === "1010000001" &&
    off.fidelity === 0 &&
    cmp.totalShots === 1000 &&
    post.shots === 37 &&
    post.totalShots === 1000
  );
});

await check("job status: every documented status maps to a phase", () => {
  const phase = (status: string, reason = "") => qpu.jobPhaseFrom({ id: "x", state: { status, reason }, status })?.phase;
  return (
    phase("Queued") === "queued" &&
    phase("Running") === "running" &&
    phase("Completed") === "completed" &&
    phase("Failed") === "failed" &&
    phase("Cancelled") === "cancelled" &&
    phase("Cancelled - Ran too long") === "cancelled" &&
    qpu.jobPhaseFrom({ status: "Completed" })?.phase === "completed" &&
    qpu.jobPhaseFrom({ id: "x" }) === null
  );
});

await check("usage seconds and finish time from the documented metrics example", () => {
  const metrics = {
    timestamps: { created: "2026-03-06T14:02:11Z", running: "2026-03-06T14:02:18Z", finished: "2026-03-06T14:05:47Z" },
    usage: { qpu_charge_time_seconds: 20, value: 0.3333, unit: "resource_units", status: "complete" },
    circuits_execution_time_ns: 20000000,
  };
  return (
    qpu.usageSecondsFrom(metrics) === 20 &&
    qpu.usageSecondsFrom({ usage: { quantum_seconds: 4 } }) === 4 &&
    qpu.usageSecondsFrom({}) === null &&
    qpu.finishedAtFrom(metrics) === Date.parse("2026-03-06T14:05:47Z")
  );
});

await check("schedule: only the Sunday 00:00 UTC collapse is a hardware collapse; next one counted in days", () => {
  const sunday = Date.UTC(2026, 9, 18); // Sunday 18 Oct 2026, 00:00 UTC
  const wednesday = Date.UTC(2026, 9, 14);
  const next = qpu.nextQpuCollapse(40, wednesday);
  const same = qpu.nextQpuCollapse(44, sunday);
  return (
    qpu.isQpuCollapse(sunday) &&
    !qpu.isQpuCollapse(wednesday) &&
    !qpu.isQpuCollapse(sunday + 86_400_000) &&
    next.day === 44 &&
    next.at === sunday &&
    same.day === 44 &&
    same.at === sunday &&
    qpu.monthStart(Date.UTC(2026, 9, 18, 13)) === Date.UTC(2026, 9, 1)
  );
});

await check("6 h deadline: a run is open until six hours after the collapse, then falls back", () => {
  const t = Date.UTC(2026, 9, 18);
  return (
    !qpu.deadlinePassed(t, t + 6 * 3_600_000 - 1) &&
    qpu.deadlinePassed(t, t + 6 * 3_600_000) &&
    qpu.deadlineOf(t) === t + 21_600_000
  );
});

await check("quota guard: one pending job at most, 8 minutes a month, IBM's own instance limit", () => {
  return (
    qpu.quotaVerdict({ pending: true, monthSeconds: 0 }) !== null &&
    qpu.quotaVerdict({ pending: false, monthSeconds: 479 }) === null &&
    qpu.quotaVerdict({ pending: false, monthSeconds: 480 }) !== null &&
    qpu.instanceQuotaVerdict({ usage_limit_reached: true }) !== null &&
    qpu.instanceQuotaVerdict({ usage_consumed_seconds: 560, usage_limit_seconds: 600 }) !== null &&
    qpu.instanceQuotaVerdict({ usage_consumed_seconds: 100, usage_limit_seconds: 600, usage_limit_reached: false }) === null &&
    qpu.instanceQuotaVerdict(null) === null
  );
});

await check("instance discovery: active Open-plan instance preferred; region decides the API host", () => {
  const listing = {
    rows_count: 3,
    resources: [
      { crn: "crn:v1:bluemix:public:quantum-computing:us-east:a/acct:old::", state: "removed", resource_plan_id: qpu.OPEN_PLAN_ID },
      { crn: "crn:v1:bluemix:public:quantum-computing:us-east:a/acct:payg::", state: "active", resource_plan_id: "5304b575-3cff-4455-90dc-ae4367762093" },
      { crn: "crn:v1:bluemix:public:quantum-computing:eu-de:a/acct:open::", state: "active", resource_plan_id: qpu.OPEN_PLAN_ID },
    ],
  };
  return (
    qpu.pickInstance(listing) === "crn:v1:bluemix:public:quantum-computing:eu-de:a/acct:open::" &&
    qpu.pickInstance({ resources: [] }) === null &&
    qpu.apiBaseForCrn("crn:v1:bluemix:public:quantum-computing:us-east:a/acct:x::") === "https://quantum.cloud.ibm.com/api" &&
    qpu.apiBaseForCrn("crn:v1:bluemix:public:quantum-computing:eu-de:a/acct:x::") === "https://eu-de.quantum.cloud.ibm.com/api"
  );
});

/* ------------------------------------------------------------------ */
/* REST client against a mock IBM                                      */
/* ------------------------------------------------------------------ */

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

function mockIbm(options: { tagged?: boolean; lookupFails?: boolean } = {}) {
  const seen: Seen[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const method = init.method ?? "GET";
    seen.push({ method, url: input, headers, body: typeof init.body === "string" ? init.body : null });
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    const url = new URL(input);
    if (url.hostname === "iam.cloud.ibm.com") return ok({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 });
    if (url.hostname === "resource-controller.cloud.ibm.com") {
      return ok({ resources: [{ crn: "crn:v1:bluemix:public:quantum-computing:us-east:a/acct:inst::", state: "active", resource_plan_id: qpu.OPEN_PLAN_ID }] });
    }
    const path = url.pathname;
    if (path === "/api/v1/instances/usage") return ok({ instance_id: "i", plan_id: "p", usage_consumed_seconds: 30, usage_consumed_ru: 0, usage_limit_seconds: 600 });
    if (path === "/api/v1/backends") {
      return ok({ devices: [{ name: "ibm_fez", status: { name: "online" }, queue_length: 2, qubits: 156 }, { name: "ibm_old", status: { name: "online" }, queue_length: 9, qubits: 127 }] });
    }
    if (path === "/api/v1/backends/ibm_fez/configuration") return ok(FEZ_CONFIG);
    if (path === "/api/v1/backends/ibm_fez/properties") return new Response(JSON.stringify({ errors: [{ message: "not found" }] }), { status: 404 });
    if (path === "/api/v1/jobs" && method === "GET") {
      if (options.lookupFails) return new Response(JSON.stringify({ errors: [{ message: "service unavailable" }] }), { status: 503 });
      return ok({ jobs: options.tagged ? [{ id: "job-old", backend: "ibm_fez" }] : [], count: 0 });
    }
    if (path === "/api/v1/jobs" && method === "POST") return ok({ id: "job-new", backend: "ibm_fez" });
    return new Response(JSON.stringify({ errors: [{ message: `no mock for ${method} ${path}` }] }), { status: 404 });
  };
  return { seen, fetchImpl };
}

await check("REST client: one IAM exchange for two connects, discovered CRN, every API call carries Bearer, Service-CRN and IBM-API-Version", async () => {
  qpu.forgetToken();
  const ibm = mockIbm();
  const env = { IBM_QUANTUM_API_KEY: "test-key" };
  const a = await qpu.connect(env, null, ibm.fetchImpl);
  const b = await qpu.connect(env, a.crn, ibm.fetchImpl);
  await a.instanceUsage();
  await b.backends();
  const iam = ibm.seen.filter((s) => s.url.startsWith("https://iam.cloud.ibm.com/"));
  const api = ibm.seen.filter((s) => s.url.startsWith("https://quantum.cloud.ibm.com/api/"));
  return (
    iam.length === 1 &&
    iam[0].method === "POST" &&
    iam[0].body === "grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=test-key" &&
    iam[0].headers["content-type"] === "application/x-www-form-urlencoded" &&
    a.crn === "crn:v1:bluemix:public:quantum-computing:us-east:a/acct:inst::" &&
    api.length === 2 &&
    api.every(
      (s) => s.headers.authorization === "Bearer tok-1" && s.headers["service-crn"] === a.crn && s.headers["ibm-api-version"] === qpu.IBM_API_VERSION,
    )
  );
});

await check("REST client: IBM_QUANTUM_CRN skips discovery; a malformed one is refused", async () => {
  qpu.forgetToken();
  const ibm = mockIbm();
  const crn = "crn:v1:bluemix:public:quantum-computing:us-east:a/acct:given::";
  const client = await qpu.connect({ IBM_QUANTUM_API_KEY: "k", IBM_QUANTUM_CRN: crn }, null, ibm.fetchImpl);
  const refused = await qpu.connect({ IBM_QUANTUM_API_KEY: "k", IBM_QUANTUM_CRN: "not-a-crn" }, null, ibm.fetchImpl).then(
    () => false,
    () => true,
  );
  return client.crn === crn && !ibm.seen.some((s) => s.url.includes("resource-controller")) && refused;
});

await check("submitDay: least busy CZ backend, a coupled line, the Sampler V2 body with both pubs and the day tag", async () => {
  qpu.forgetToken();
  const ibm = mockIbm();
  const client = await qpu.connect({ IBM_QUANTUM_API_KEY: "k" }, null, ibm.fetchImpl);
  const gates = randomDay(mulberry32(42), 30);
  const circuit = qpu.buildCircuit(gates);
  const sent = await qpu.submitDay(client, 12, circuit, false);
  const post = ibm.seen.find((s) => s.method === "POST" && s.url.endsWith("/api/v1/jobs"));
  if (!post || !post.body) return false;
  const body = JSON.parse(post.body);
  const pubs = body.params.pubs;
  // the QASM that was sent simulates to the day's state
  const got = runNative(parseQasm(pubs[0][0], sent.chain), circuit.line.mids);
  const expected = pet.replayLog(gates);
  return (
    sent.jobId === "job-new" &&
    sent.backend === "ibm_fez" &&
    validChain(sent.chain) &&
    body.program_id === "sampler" &&
    body.backend === "ibm_fez" &&
    body.tags[0] === "dirac-pet-day-12" &&
    body.params.version === 2 &&
    body.params.support_qiskit === false &&
    pubs.length === 2 &&
    pubs[0][1] === null &&
    pubs[0][2] === 1 &&
    pubs[1][2] === 1000 &&
    pubs[0][0] === pubs[1][0] &&
    pubs[0][0] === sent.qasm &&
    post.headers["content-type"] === "application/json" &&
    got !== null &&
    expected !== null &&
    pet.stateFidelity(expected, toLogical(got, circuit.line.layout)) > 1 - 1e-8
  );
});

await check("submitDay retry: a job already tagged for the day is adopted, nothing is sent twice", async () => {
  qpu.forgetToken();
  const ibm = mockIbm({ tagged: true });
  const client = await qpu.connect({ IBM_QUANTUM_API_KEY: "k" }, null, ibm.fetchImpl);
  const sent = await qpu.submitDay(client, 12, qpu.buildCircuit([]), true);
  const tagQuery = ibm.seen.find((s) => s.method === "GET" && s.url.includes("/api/v1/jobs?tags=dirac-pet-day-12"));
  // a retry whose lookup fails sends nothing: the attempt fails instead of risking a second job for the day
  qpu.forgetToken();
  const broken = mockIbm({ lookupFails: true });
  const client2 = await qpu.connect({ IBM_QUANTUM_API_KEY: "k" }, null, broken.fetchImpl);
  const refused = await qpu.submitDay(client2, 12, qpu.buildCircuit([]), true).then(
    () => false,
    () => true,
  );
  return (
    sent.jobId === "job-old" &&
    tagQuery !== undefined &&
    !ibm.seen.some((s) => s.method === "POST" && s.url.endsWith("/api/v1/jobs")) &&
    refused &&
    !broken.seen.some((s) => s.method === "POST" && s.url.endsWith("/api/v1/jobs"))
  );
});

await check("IAM failure surfaces IBM's message without the key", async () => {
  qpu.forgetToken();
  const fetchImpl = async () => new Response(JSON.stringify({ errorCode: "BXNIM0415E", errorMessage: "Provided API key could not be found." }), { status: 400 });
  try {
    await qpu.iamToken("secret-key-value", fetchImpl);
    return false;
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    return message.includes("could not be found") && !message.includes("secret-key-value");
  }
});

/* ------------------------------------------------------------------ */
/* Verification before a Sunday: Bell pair, guards, check, smoke       */
/* ------------------------------------------------------------------ */

/** The calibration of the chain test above (GET /backends/ibm_fez/properties shape): qubits 0..11 noisy, couplers of 61 broken. */
function fezProperties(): unknown {
  const rand = mulberry32(11);
  const qubits = Array.from({ length: 156 }, (_, q) => [
    { name: "T1", unit: "us", value: 100, date: "2026-10-11T00:00:00Z" },
    { name: "readout_error", unit: "", value: q < 12 ? 0.3 : 0.005 + rand() * 0.03, date: "2026-10-11T00:00:00Z" },
  ]);
  const gates = FEZ_DIRECTED.map(([a, b]) => ({
    gate: "cz",
    qubits: [a, b],
    name: `cz${a}_${b}`,
    parameters: [{ name: "gate_error", unit: "", value: a === 61 || b === 61 ? 1 : 0.002 + ((a * 7 + b * 13) % 10) / 1000, date: "x" }],
  }));
  return { backend_name: "ibm_fez", qubits, gates };
}

const FEZ_HAS_EDGE = (() => {
  const directed = new Set(FEZ_DIRECTED.map(([a, b]) => `${a}>${b}`));
  return (a: number, b: number) => directed.has(`${a}>${b}`);
})();

const BELL_SNAPSHOT = `OPENQASM 3.0;
include "stdgates.inc";
bit[2] c;
rz(1.570796326794897) $3;
sx $3;
rz(1.570796326794897) $16;
sx $16;
rz(1.570796326794897) $3;
rz(1.570796326794897) $16;
cz $3, $16;
rz(1.570796326794897) $16;
sx $16;
c[0] = measure $3;
rz(1.570796326794897) $16;
c[1] = measure $16;
`;

await check("Bell pair through the Sunday's ISA path: (|00⟩ + |11⟩)/√2, QASM snapshot, read back on its two physical qubits", () => {
  const text = qpu.bellQasm([3, 16], FEZ_HAS_EDGE);
  if (text !== BELL_SNAPSHOT) {
    console.log(text);
    return false;
  }
  const native = qpu.bellNative();
  const bell = pet.CNOT(pet.H(pet.zeroState(), 0), 0, 1);
  const direct = runNative(native, []);
  const readBack = runNative(parseQasm(text, [3, 16]), []);
  // the emitter refuses a position outside its qubits; the Sunday's emitter still wants exactly 10
  const outside = (() => {
    try {
      qpu.emitIsaQasm(native, 0, [5]);
      return false;
    } catch {
      return true;
    }
  })();
  const sundayStrict = (() => {
    try {
      qpu.emitQasm(native, 0, [3, 16]);
      return false;
    } catch {
      return true;
    }
  })();
  return (
    direct !== null &&
    readBack !== null &&
    pet.stateFidelity(direct, bell) > FIDELITY_OK &&
    pet.stateFidelity(readBack, bell) > FIDELITY_OK &&
    native.filter((o) => o.op === "cz").length === 1 &&
    native.filter((o) => o.op === "measure").length === 2 &&
    outside &&
    sundayStrict
  );
});

await check("Bell pair choice on the ibm_fez fixture: neighbours on the Sunday's line, the lowest summed error, never a broken coupler", () => {
  const quality = qpu.chainQualityFrom(fezProperties());
  if (!quality) return false;
  const chain = qpu.findChain(FEZ_DIRECTED, 10, quality);
  const plainChain = qpu.findChain(FEZ_DIRECTED);
  if (!validChain(chain) || !validChain(plainChain)) return false;
  const pair = qpu.pickPair(chain, quality);
  const plain = qpu.pickPair(plainChain, null);
  const score = (a: number, b: number) =>
    (quality.qubitError.get(a) ?? 0.05) + (quality.qubitError.get(b) ?? 0.05) + (quality.edgeError.get(qpu.edgeKey(a, b)) ?? 0.05);
  const at = chain.indexOf(pair[0]);
  const best = Math.min(...chain.slice(1).map((q, i) => score(chain[i], q)));
  return (
    at >= 0 &&
    chain[at + 1] === pair[1] &&
    isEdge(pair[0], pair[1]) &&
    !quality.badEdges.has(qpu.edgeKey(pair[0], pair[1])) &&
    pair.every((q) => q >= 12) &&
    Math.abs(score(pair[0], pair[1]) - best) < 1e-15 &&
    plain[0] === plainChain[0] &&
    plain[1] === plainChain[1]
  );
});

await check("smoke job body: the Sunday's Sampler V2 body with a 1-shot pub, a 200-shot pub and the smoke tag", () => {
  const qasm = qpu.bellQasm([3, 16]);
  const tag = qpu.smokeTag(7, 1760000000000);
  const body = qpu.smokeJobBody("ibm_fez", qasm, tag) as { program_id: string; backend: string; tags: string[]; params: { pubs: unknown[][]; version: number; support_qiskit: boolean } };
  const sunday = qpu.samplerJobBody("ibm_fez", qasm, 3) as { params: { pubs: unknown[][] } };
  return (
    tag === "dirac-qpu-smoke-7-1760000000000" &&
    body.program_id === "sampler" &&
    body.backend === "ibm_fez" &&
    body.tags[0] === tag &&
    body.params.version === 2 &&
    body.params.support_qiskit === false &&
    JSON.stringify(body.params.pubs) === JSON.stringify([[qasm, null, 1], [qasm, null, 200]]) &&
    sunday.params.pubs[1][2] === 1000
  );
});

/** A Bell result in the documented REST shape: the 1-shot pub, then 200 shots (96 × 00, 94 × 11, 6 × c0=1 only, 4 × c1=1 only). */
function bellResultFixture(): unknown {
  const samples: string[] = [];
  for (let i = 0; i < 200; i++) samples.push(i < 96 ? "0x0" : i < 190 ? "0x3" : i < 196 ? "0x1" : "0x2");
  return {
    results: [
      { data: { c: { samples: ["0x3"], num_bits: 2 } }, metadata: { circuit_metadata: {} } },
      { data: { c: { samples, num_bits: 2 } }, metadata: { circuit_metadata: {} } },
    ],
    metadata: { execution: { execution_spans: [] }, version: 2 },
  };
}

await check("smoke result: read by the Sunday's parser (width 2), histogram c[0] first, keys-only shape without values", () => {
  const ok = qpu.readSmokeResult(bellResultFixture());
  const bell = ok.counts ? qpu.bellSummary(ok.counts) : null;
  // a payload the parser does not know (samples as integer arrays): refused, with the shape kept for debugging
  const odd = qpu.readSmokeResult({ results: [{ data: { meas: { samples: [[1, 1]] } } }, { data: { meas: { samples: [[0, 0]] } } }] });
  return (
    ok.parsed &&
    ok.reason === null &&
    ok.collapse === "11" &&
    ok.counts?.["00"] === 96 &&
    ok.counts?.["11"] === 94 &&
    ok.counts?.["10"] === 6 &&
    ok.counts?.["01"] === 4 &&
    bell !== null &&
    bell.shots === 200 &&
    Math.abs(bell.correlated - 0.95) < 1e-12 &&
    ok.shape.includes("samples:[hex×1]") &&
    ok.shape.includes("samples:[hex×200]") &&
    !ok.shape.includes("0x") &&
    !odd.parsed &&
    odd.reason !== null &&
    odd.shape.includes("meas:{samples:[[num×2]×1]}")
  );
});

await check("smoke guard: one pending, never beside an open Sunday run, one that ran per 6 days, 10 minutes after an attempt, the monthly budget", () => {
  const now = Date.UTC(2026, 9, 12, 12);
  const day = 86_400_000;
  const base = { now, smokePending: false, sundayOpen: false, lastRanAt: null, lastAttemptAt: null, monthSeconds: 0 };
  const recent = qpu.smokeVerdict({ ...base, lastRanAt: now - 5 * day, lastAttemptAt: now - 5 * day });
  return (
    qpu.smokeVerdict(base) === null &&
    qpu.smokeVerdict({ ...base, smokePending: true })?.reason.includes("pending") === true &&
    qpu.smokeVerdict({ ...base, sundayOpen: true }) !== null &&
    recent !== null &&
    recent.retryAt === now + day &&
    qpu.smokeVerdict({ ...base, lastRanAt: now - 6 * day, lastAttemptAt: now - 6 * day }) === null &&
    qpu.smokeVerdict({ ...base, lastAttemptAt: now - 5 * 60_000 })?.retryAt === now + 5 * 60_000 &&
    qpu.smokeVerdict({ ...base, lastAttemptAt: now - 11 * 60_000 }) === null &&
    qpu.smokeVerdict({ ...base, monthSeconds: 480 })?.reason.includes("allowance") === true &&
    qpu.smokeVerdict({ ...base, monthSeconds: 479 }) === null
  );
});

const TEST_KEY = "TEST-key_0123456789abcdefghijklmnopqrstuvwxyz";
const TEST_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJpYW1faWQiOiJJQk1pZC0xMjMifQ.c2lnbmF0dXJlLXRlc3Q";
const TEST_ACCOUNT = "0123456789abcdef0123456789abcdef";
const TEST_CRN = `crn:v1:bluemix:public:quantum-computing:us-east:a/${TEST_ACCOUNT}:1b2c3d4e-0000-4000-8000-123456789abc::`;
/** Nothing that names the account or grants access may appear in a response. */
const leaks = (text: string): string[] => [TEST_KEY, TEST_TOKEN, TEST_CRN, TEST_ACCOUNT, "1b2c3d4e-0000", "crn:v1"].filter((s) => text.includes(s));

await check("publicReason scrubs CRNs (plain and URL-encoded), tokens, keys, account ids and GUIDs; ordinary text survives", () => {
  const dirty = [
    `403 for ${TEST_CRN} (${encodeURIComponent(TEST_CRN)})`,
    `Authorization: Bearer ${TEST_TOKEN}`,
    `{"access_token":"${TEST_TOKEN}","refresh_token":"not-a-jwt-but-secret"}`,
    `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${TEST_KEY}`,
    `the key ${TEST_KEY} is unknown`,
    `account ${TEST_ACCOUNT} and instance 1b2c3d4e-0000-4000-8000-123456789abc`,
    "the literal hunter2hunter2 secret",
  ].join(" | ");
  const masked = qpu.publicReason(dirty, ["hunter2hunter2"]);
  const scrubbed = qpu.scrubSecrets(dirty, ["hunter2hunter2"]);
  const plain = "IAM token exchange failed (400: Provided API key could not be found.) on ibm_fez, job d1abc2def3ghi4jkl5mn queued";
  return (
    leaks(scrubbed).length === 0 &&
    !scrubbed.includes("not-a-jwt-but-secret") &&
    !scrubbed.includes("hunter2hunter2") &&
    scrubbed.includes("Bearer [token]") &&
    scrubbed.includes("the instance") &&
    leaks(masked).length === 0 &&
    masked.length <= 300 &&
    qpu.publicReason(plain) === plain &&
    qpu.publicReason("x".repeat(1000)).length === 300
  );
});

/* --- a mock of the whole IBM service, for the check, the smoke job and the routes --- */

interface ServiceOptions {
  iamError?: boolean;
  usage?: unknown;
  usageFails?: boolean;
  jobState?: string;
  submitError?: boolean;
  tagged?: string | null;
  metrics?: unknown;
}

function mockService(options: ServiceOptions = {}) {
  const seen: Seen[] = [];
  const state = { ...options, jobState: options.jobState ?? "Queued" };
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const method = init.method ?? "GET";
    seen.push({ method, url: href, headers, body: typeof init.body === "string" ? init.body : null });
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    const url = new URL(href);
    if (url.hostname === "iam.cloud.ibm.com") {
      // a hostile error text that quotes the key and the instance: it must never come back out
      if (state.iamError) return ok({ errorCode: "BXNIM0415E", errorMessage: `Provided API key ${TEST_KEY} for ${TEST_CRN} could not be found.` }, 400);
      return ok({ access_token: TEST_TOKEN, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.hostname === "resource-controller.cloud.ibm.com") {
      return ok({ resources: [{ crn: TEST_CRN, state: "active", resource_plan_id: qpu.OPEN_PLAN_ID }] });
    }
    if (headers.authorization !== `Bearer ${TEST_TOKEN}` || headers["service-crn"] !== TEST_CRN) return ok({ errors: [{ message: "unauthorized" }] }, 401);
    const path = url.pathname;
    if (path === "/api/v1/instances/usage") {
      if (state.usageFails) return ok({ errors: [{ message: "not found" }] }, 404);
      return ok(state.usage ?? { instance_id: TEST_CRN, usage_consumed_seconds: 35, usage_limit_seconds: 600, usage_limit_reached: false });
    }
    if (path === "/api/v1/backends") {
      return ok({
        devices: [
          { name: "ibm_old", status: { name: "online" }, queue_length: 9, qubits: 127 },
          { name: "ibm_kingston", status: { name: "paused", reason: "calibrating" }, queue_length: 0, qubits: 156 },
          { name: "ibm_fez", status: { name: "online" }, queue_length: 3, qubits: 156 },
          { name: "tiny", status: { name: "online" }, queue_length: 0, qubits: 5 },
        ],
      });
    }
    if (path === "/api/v1/backends/ibm_fez/configuration") return ok(FEZ_CONFIG);
    if (path === "/api/v1/backends/ibm_fez/properties") return ok(fezProperties());
    if (path === "/api/v1/jobs" && method === "GET") return ok({ jobs: state.tagged ? [{ id: state.tagged, backend: "ibm_fez" }] : [], count: 0 });
    if (path === "/api/v1/jobs" && method === "POST") {
      if (state.submitError) return ok({ errors: [{ message: `Job rejected for ${TEST_CRN}; token ${TEST_TOKEN} lacks access`, code: 1234 }] }, 400);
      return ok({ id: "job-smoke-1", backend: "ibm_fez" });
    }
    const job = path.match(/^\/api\/v1\/jobs\/([^/]+)(\/results|\/metrics|\/cancel)?$/);
    if (job) {
      if (job[2] === "/results") return ok(bellResultFixture());
      if (job[2] === "/metrics") return ok(state.metrics ?? { timestamps: { finished: "2026-10-12T10:00:05Z" }, usage: { qpu_charge_time_seconds: 3.2 } });
      if (job[2] === "/cancel") return new Response(null, { status: 204 });
      return ok({ id: job[1], backend: "ibm_fez", state: { status: state.jobState, reason: state.jobState === "Failed" ? `Error for ${TEST_CRN}` : "" }, status: state.jobState });
    }
    return ok({ errors: [{ message: `no mock for ${method} ${path}` }] }, 404);
  };
  return { seen, state, fetchImpl };
}

const ENV_KEY = { IBM_QUANTUM_API_KEY: TEST_KEY };

await check("runQpuCheck (mock IBM): five steps in order, the Sunday's choice, candidates with status and queue, no key, token or CRN in the answer", async () => {
  const ibm = mockService();
  const result = await qpu.runQpuCheck(ENV_KEY, ibm.fetchImpl);
  const text = JSON.stringify(result);
  const fez = result.candidates.find((c) => c.name === "ibm_fez");
  const kingston = result.candidates.find((c) => c.name === "ibm_kingston");
  const old = result.candidates.find((c) => c.name === "ibm_old");
  const shapeOk =
    result.steps.map((s) => s.step).join(",") === "iam,instance,usage,backends,chain" &&
    result.steps.every((s) => typeof s.ok === "boolean" && typeof s.detail === "string" && typeof s.ms === "number") &&
    typeof result.checkedAt === "number";
  if (!shapeOk || leaks(text).length > 0) console.log(`      ${text.slice(0, 400)} | leaks: ${leaks(text).join(",")}`);
  return (
    shapeOk &&
    result.configured &&
    result.ready &&
    result.steps.every((s) => s.ok) &&
    result.chosen?.backend === "ibm_fez" &&
    result.chosen.calibrated &&
    validChain(result.chosen.chain) &&
    fez?.rank === 1 &&
    fez.evaluated &&
    fez.chain === true &&
    fez.queue === 3 &&
    old?.rank === 2 &&
    !old.evaluated &&
    old.chain === null &&
    kingston?.usable === false &&
    kingston.status === "paused" &&
    kingston.detail === "calibrating" &&
    result.steps[0].detail === "IAM issued an access token valid for 60 min" &&
    result.steps[2].detail.includes("565 s left") &&
    result.steps[1].detail.includes("Open (free) plan") &&
    leaks(text).length === 0 &&
    !ibm.seen.some((s) => s.method === "POST" && s.url.includes("/jobs"))
  );
});

await check("runQpuCheck: not configured, IAM refused (hostile error text scrubbed, later steps not run), usage limit reached, usage unreadable", async () => {
  const none = await qpu.runQpuCheck({});
  const refused = await qpu.runQpuCheck(ENV_KEY, mockService({ iamError: true }).fetchImpl);
  const spent = await qpu.runQpuCheck(ENV_KEY, mockService({ usage: { usage_consumed_seconds: 590, usage_limit_seconds: 600 } }).fetchImpl);
  const unreadable = await qpu.runQpuCheck(ENV_KEY, mockService({ usageFails: true }).fetchImpl);
  const refusedText = JSON.stringify(refused);
  return (
    !none.configured &&
    none.steps.length === 0 &&
    none.chosen === null &&
    !refused.ready &&
    refused.steps.length === 5 &&
    !refused.steps[0].ok &&
    refused.steps[0].detail.includes("could not be found") &&
    refused.steps.slice(1).every((s) => !s.ok && s.detail === "not run: the iam step failed") &&
    leaks(refusedText).length === 0 &&
    !spent.ready &&
    !spent.steps[2].ok &&
    spent.chosen !== null &&
    unreadable.ready &&
    !unreadable.steps[2].ok &&
    unreadable.steps[2].detail.includes("not fatal")
  );
});

/* --- D1 over node:sqlite, every migration applied --- */

const { DatabaseSync } = await import("node:sqlite");
const { readFileSync, readdirSync } = await import("node:fs");

type SqlRow = Record<string, unknown>;

/** The D1 calls the Worker makes (prepare, bind, first, all, run, batch) over an in-memory SQLite. */
function memoryD1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const value = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v) as string | number | null;
  const exec = (sql: string, args: unknown[]) => {
    const rows = db.prepare(sql).all(...args.map(value)) as SqlRow[];
    const changes = /^\s*SELECT/i.test(sql) ? 0 : Number((db.prepare("SELECT changes() AS n").get() as SqlRow).n);
    return { results: rows.map((r) => ({ ...r })), success: true, meta: { changes } };
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
    batch: async (statements: Statement[]) => {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => exec(s.sql, s.args));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, d1 };
}

await check("monthly budget (SQL_QPU_MONTH on the migrated schema): Sunday runs and smoke jobs together, 30 s for unknown usage, sent jobs of this month only", async () => {
  const { db, d1 } = memoryD1();
  const now = Date.UTC(2026, 9, 12, 12);
  const month = qpu.monthStart(now);
  const run = db.prepare("INSERT INTO pet_qpu_runs (day, status, created_at, collapse_at, actions, job_id, submitted_at, usage_seconds) VALUES (?1, 'done', ?2, ?2, 0, ?3, ?2, ?4)");
  run.run(1, month + 1000, "job-a", 20);
  run.run(2, month + 2000, "job-b", null);
  run.run(3, month - 86_400_000, "job-last-month", 100);
  run.run(4, month + 3000, null, null);
  const smoke = db.prepare("INSERT INTO qpu_smoke (status, created_at, job_id, submitted_at, usage_seconds) VALUES ('done', ?1, ?2, ?1, ?3)");
  smoke.run(month + 4000, "smoke-a", 4);
  smoke.run(month + 5000, "smoke-b", null);
  smoke.run(month + 6000, null, null);
  const row = await d1.prepare(pet.SQL_QPU_MONTH).bind(month, qpu.UNKNOWN_USAGE_SECONDS).first();
  const empty = await memoryD1().d1.prepare(pet.SQL_QPU_MONTH).bind(month, qpu.UNKNOWN_USAGE_SECONDS).first();
  return row?.seconds === 20 + 30 + 4 + 30 && empty?.seconds === 0;
});

/** A request through the Worker's pet module, as worker/index.ts hands it over. */
async function call(env: Record<string, unknown>, method: string, path: string, ip: string, waits: Promise<unknown>[] = []) {
  const url = new URL(`https://dirac.test${path}`);
  const request = new Request(url, { method, headers: { "cf-connecting-ip": ip } });
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => undefined, props: {} };
  const parts = url.pathname.split("/").filter(Boolean);
  const res = await pet.handlePet(request, env as never, ctx as never, parts, url);
  if (!res) return { status: 404, text: "", body: null as unknown as Record<string, unknown> };
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

/** Waits out the end of a rate-limit minute, so a sequence of counted requests stays in one window. */
async function freshMinute(): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 8_000) await new Promise((r) => setTimeout(r, left + 100));
}

const realFetch = globalThis.fetch;

await check("GET /api/pet/qpu/check: the shape, a 5-minute cache shared by every caller, 2 a minute per IP, nothing secret in the answer", async () => {
  const { d1 } = memoryD1();
  const ibm = mockService();
  globalThis.fetch = ibm.fetchImpl as typeof fetch;
  try {
    qpu.forgetToken();
    await freshMinute();
    const env = { DB: d1, ...ENV_KEY };
    const first = await call(env, "GET", "/api/pet/qpu/check", "1.1.1.1");
    const ibmCalls = ibm.seen.length;
    const second = await call(env, "GET", "/api/pet/qpu/check", "1.1.1.1");
    const third = await call(env, "GET", "/api/pet/qpu/check", "1.1.1.1");
    const other = await call(env, "GET", "/api/pet/qpu/check", "2.2.2.2");
    const off = await call({ DB: memoryD1().d1 }, "GET", "/api/pet/qpu/check", "3.3.3.3");
    const b = first.body;
    const budget = b.budget as { monthSeconds: number; monthBudgetSeconds: number };
    const steps = b.steps as { step: string; ok: boolean }[];
    const ok =
      first.status === 200 &&
      b.configured === true &&
      b.ready === true &&
      b.cached === false &&
      steps.length === 5 &&
      (b.chosen as { backend: string }).backend === "ibm_fez" &&
      budget.monthSeconds === 0 &&
      budget.monthBudgetSeconds === 480 &&
      second.status === 200 &&
      second.body.cached === true &&
      second.body.checkedAt === b.checkedAt &&
      ibm.seen.length === ibmCalls &&
      third.status === 429 &&
      other.status === 200 &&
      other.body.cached === true &&
      off.status === 200 &&
      off.body.configured === false &&
      leaks(first.text + second.text + other.text).length === 0;
    if (!ok) console.log(`      ${first.status} ${second.status} ${third.status} ${other.status} ${first.text.slice(0, 300)}`);
    return ok;
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("smoke job end to end: POST sends one Bell job (202), a second is refused while pending, GET polls once per 30 s, settles with the parsed histogram, usage joins the budget, the 6-day rule", async () => {
  const { db, d1 } = memoryD1();
  const ibm = mockService({ jobState: "Queued" });
  globalThis.fetch = ibm.fetchImpl as typeof fetch;
  try {
    qpu.forgetToken();
    await freshMinute();
    const env = { DB: d1, ...ENV_KEY };
    const posted = await call(env, "POST", "/api/pet/qpu/smoke", "1.1.1.1");
    const smoke = posted.body.smoke as Record<string, unknown>;
    const sent = ibm.seen.find((s) => s.method === "POST" && s.url.endsWith("/api/v1/jobs"));
    const sentBody = sent?.body ? JSON.parse(sent.body) : null;
    const pair = smoke.pair as [number, number];
    const again = await call(env, "POST", "/api/pet/qpu/smoke", "2.2.2.2");
    // GET right after the POST: the submission set the poll claim, so IBM is not asked again yet
    const early = await call(env, "GET", "/api/pet/qpu/smoke", "1.1.1.1");
    db.prepare("UPDATE qpu_smoke SET polled_at = polled_at - 31000").run();
    const queued = await call(env, "GET", "/api/pet/qpu/smoke", "1.1.1.1");
    const queuedAgain = await call(env, "GET", "/api/pet/qpu/smoke", "1.1.1.1");
    ibm.state.jobState = "Completed";
    db.prepare("UPDATE qpu_smoke SET polled_at = polled_at - 31000").run();
    const done = await call(env, "GET", "/api/pet/qpu/smoke", "1.1.1.1");
    const d = done.body.smoke as Record<string, unknown>;
    const month = (await d1.prepare(pet.SQL_QPU_MONTH).bind(qpu.monthStart(Date.now()), qpu.UNKNOWN_USAGE_SECONDS).first())?.seconds;
    const blocked = await call(env, "POST", "/api/pet/qpu/smoke", "3.3.3.3");
    const ok =
      posted.status === 202 &&
      smoke.status === "queued" &&
      smoke.jobId === "job-smoke-1" &&
      smoke.backend === "ibm_fez" &&
      isEdge(pair[0], pair[1]) &&
      smoke.qasm === qpu.bellQasm(pair, FEZ_HAS_EDGE) &&
      sentBody?.params.pubs[0][2] === 1 &&
      sentBody?.params.pubs[1][2] === 200 &&
      sentBody?.tags[0] === smoke.tag &&
      again.status === 409 &&
      String(again.body.error).includes("pending") &&
      early.body.polled === false &&
      queued.body.polled === true &&
      (queued.body.smoke as Record<string, unknown>).status === "queued" &&
      queuedAgain.body.polled === false &&
      done.body.polled === true &&
      d.status === "done" &&
      (d.parser as { ok: boolean }).ok === true &&
      (d.counts as Record<string, number>)["00"] === 96 &&
      (d.bell as { correlated: number }).correlated > 0.94 &&
      d.collapse === "11" &&
      d.usageSeconds === 3.2 &&
      String(d.shape).includes("samples:[hex×200]") &&
      d.finishedAt === Date.parse("2026-10-12T10:00:05Z") &&
      month === 3.2 &&
      blocked.status === 409 &&
      typeof blocked.body.retryAt === "number" &&
      Math.abs((blocked.body.retryAt as number) - ((d.submittedAt as number) + qpu.SMOKE_EVERY_MS)) < 1 &&
      (done.body.next as { allowed: boolean }).allowed === false &&
      leaks(posted.text + done.text + blocked.text).length === 0;
    if (!ok) console.log(`      ${posted.status} ${again.status} ${early.body.polled} ${queued.body.polled} ${queuedAgain.body.polled} ${done.text.slice(0, 500)} ${blocked.text.slice(0, 200)} month=${month}`);
    return ok;
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("smoke job: the cron's pollQpu settles a failed job (reason scrubbed, no 6-day wait), 10-minute gap, budget refusal, refused submission scrubbed, cut-off submission adopted by tag", async () => {
  const { db, d1 } = memoryD1();
  const ibm = mockService({ jobState: "Running", metrics: {} });
  globalThis.fetch = ibm.fetchImpl as typeof fetch;
  try {
    qpu.forgetToken();
    await freshMinute();
    const env = { DB: d1, ...ENV_KEY };
    const posted = await call(env, "POST", "/api/pet/qpu/smoke", "1.1.1.1");
    ibm.state.jobState = "Failed";
    db.prepare("UPDATE qpu_smoke SET polled_at = polled_at - 31000").run();
    await pet.pollQpu(env as never);
    const failedRow = db.prepare("SELECT status, reason, usage_seconds FROM qpu_smoke WHERE id = 1").get() as SqlRow;
    // a failed job with no charged time does not start the 6-day wait, only the 10-minute gap
    const gap = await call(env, "POST", "/api/pet/qpu/smoke", "2.2.2.2");
    db.prepare("UPDATE qpu_smoke SET created_at = created_at - 11 * 60000").run();
    // the month is used up (the failed job counts 30 s, a Sunday run 460 s): refused
    db.prepare("INSERT INTO pet_qpu_runs (day, status, created_at, collapse_at, actions, job_id, submitted_at, usage_seconds) VALUES (9, 'done', ?1, ?1, 0, 'job-sun', ?1, 460)").run(Date.now());
    const broke = await call(env, "POST", "/api/pet/qpu/smoke", "3.3.3.3");
    db.prepare("DELETE FROM pet_qpu_runs").run();
    // IBM refuses the submission with a hostile error text: 502, scrubbed, no job id, only the 10-minute gap
    ibm.state.submitError = true;
    const refused = await call(env, "POST", "/api/pet/qpu/smoke", "4.4.4.4");
    const refusedRow = db.prepare("SELECT status, job_id FROM qpu_smoke ORDER BY id DESC LIMIT 1").get() as SqlRow;
    // a submission cut off before it recorded anything: after the lease, the poller finds the job by its tag
    ibm.state.submitError = false;
    ibm.state.tagged = "job-adopted";
    ibm.state.jobState = "Queued";
    db.prepare("INSERT INTO qpu_smoke (status, created_at) VALUES ('submitting', ?1)").run(Date.now() - 6 * 60_000);
    await pet.pollSmoke(env as never);
    const adopted = db.prepare("SELECT status, job_id FROM qpu_smoke ORDER BY id DESC LIMIT 1").get() as SqlRow;
    const tagQuery = ibm.seen.some((s) => s.method === "GET" && s.url.includes("/api/v1/jobs?tags=dirac-qpu-smoke-"));
    // IBM unreadable: the job stays open with the reason, until 24 hours after it was sent
    globalThis.fetch = (async () => new Response(JSON.stringify({ errors: [{ message: `down for ${TEST_CRN}` }] }), { status: 503 })) as typeof fetch;
    qpu.forgetToken();
    db.prepare("UPDATE qpu_smoke SET polled_at = NULL WHERE status = 'queued'").run();
    await pet.pollSmoke(env as never);
    const stillOpen = db.prepare("SELECT status, reason FROM qpu_smoke ORDER BY id DESC LIMIT 1").get() as SqlRow;
    db.prepare("UPDATE qpu_smoke SET polled_at = NULL, submitted_at = submitted_at - 86400000 WHERE status = 'queued'").run();
    await pet.pollSmoke(env as never);
    const gaveUp = db.prepare("SELECT status, reason FROM qpu_smoke ORDER BY id DESC LIMIT 1").get() as SqlRow;
    const ok =
      posted.status === 202 &&
      failedRow.status === "failed" &&
      String(failedRow.reason).includes("IBM reported the job failed") &&
      leaks(String(failedRow.reason)).length === 0 &&
      failedRow.usage_seconds === null &&
      gap.status === 409 &&
      String(gap.body.error).includes("attempt") &&
      broke.status === 409 &&
      String(broke.body.error).includes("allowance") &&
      refused.status === 502 &&
      leaks(refused.text).length === 0 &&
      String(refused.body.error).includes("could not be sent") &&
      refusedRow.status === "failed" &&
      refusedRow.job_id === null &&
      adopted.status === "queued" &&
      adopted.job_id === "job-adopted" &&
      tagQuery &&
      stillOpen.status === "queued" &&
      String(stillOpen.reason).startsWith("the last poll could not read IBM") &&
      gaveUp.status === "failed" &&
      String(gaveUp.reason).includes("24 hours") &&
      leaks(String(stillOpen.reason) + String(gaveUp.reason)).length === 0;
    if (!ok) console.log(`      ${posted.status} ${JSON.stringify(failedRow)} ${gap.status} ${broke.text.slice(0, 160)} ${refused.text.slice(0, 200)} ${JSON.stringify(refusedRow)} ${JSON.stringify(adopted)} ${JSON.stringify(stillOpen)} ${JSON.stringify(gaveUp)}`);
    return ok;
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("smoke routes: refused without a key (503), refused beside an open Sunday run, other 4-segment pet paths are not served", async () => {
  const { db, d1 } = memoryD1();
  await freshMinute();
  const off = await call({ DB: d1 }, "POST", "/api/pet/qpu/smoke", "1.1.1.1");
  const env = { DB: d1, ...ENV_KEY };
  db.prepare("INSERT INTO pet_qpu_runs (day, status, created_at, collapse_at, actions) VALUES (5, 'submitting', ?1, ?1, 0)").run(Date.now());
  const sunday = await call(env, "POST", "/api/pet/qpu/smoke", "2.2.2.2");
  const nothing = await call(env, "GET", "/api/pet/qpu/smoke", "2.2.2.2");
  const unknown = await call(env, "GET", "/api/pet/qpu/other", "2.2.2.2");
  const deep = await call(env, "GET", "/api/pet/qpu/smoke/1", "2.2.2.2");
  return (
    off.status === 503 &&
    sunday.status === 409 &&
    String(sunday.body.error).includes("Sunday") &&
    nothing.status === 200 &&
    nothing.body.smoke === null &&
    (nothing.body.next as { allowed: boolean }).allowed === false &&
    unknown.status === 404 &&
    deep.status === 404
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

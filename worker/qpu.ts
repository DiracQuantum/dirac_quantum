/**
 * The quantum pet's weekly collapse on a real IBM quantum computer (SPEC 3.6).
 *
 * Every Sunday 00:00 UTC collapse (while the free IBM Quantum allowance
 * lasts) the day's gate log is rebuilt as a circuit and measured on IBM
 * hardware through the IBM Quantum Platform REST API; every other day is
 * drawn on the simulator in worker/pet.ts. This module holds everything that
 * does not touch D1: the schedule, the transpiler from the gate log to an ISA
 * circuit (native gates on physically connected qubits; the service does not
 * transpile), the OpenQASM 3 emitter, the result parser, the quota rules and
 * a small REST client. worker/pet.ts owns the tables and the state machine
 * (`pollQpu`). Everything is a pure function or takes its `fetch` as an
 * argument, so scripts/qpu-selftest.ts can test it without a key.
 *
 * REST facts this follows (checked 2026-10-11):
 * - IAM: POST https://iam.cloud.ibm.com/identity/token, form body
 *   grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=<key>; the
 *   bearer token lives `expires_in` (3600) seconds.
 *   https://quantum.cloud.ibm.com/docs/en/guides/cloud-setup-rest-api
 * - Every API call carries Authorization: Bearer, Service-CRN and
 *   IBM-API-Version (2026-04-15 is the live version per GET /api/v1/versions).
 *   https://quantum.cloud.ibm.com/docs/en/api/qiskit-runtime-rest
 * - The instance CRN, when not given, comes from the IBM Cloud Resource
 *   Controller: GET /v2/resource_instances?resource_id=b6049020-80f4-11eb-a0f7-e35ec9b4054f.
 *   https://quantum.cloud.ibm.com/docs/en/guides/access-instances-platform-apis
 * - Sampler V2 job: POST /api/v1/jobs { program_id: "sampler", backend,
 *   params: { pubs: [[qasm, null, shots], ...], version: 2 } }; GET
 *   /api/v1/jobs/{id} (state.status Queued | Running | Completed | Cancelled
 *   | Failed); GET /api/v1/jobs/{id}/results → results[i].data.<register>.samples
 *   as hex strings (bit k of the value = clbit k); GET /api/v1/jobs/{id}/metrics
 *   → usage.qpu_charge_time_seconds. 5 jobs per minute per user.
 *   https://quantum.cloud.ibm.com/docs/en/guides/sampler-rest-api and
 *   https://quantum.cloud.ibm.com/api/openapi.json
 * - Heron backends (ibm_torino, ibm_fez, ibm_marrakesh, ibm_kingston) take
 *   cz, rz, sx, x, measure; GET /api/v1/backends/{name}/configuration gives
 *   basis_gates and coupling_map, /properties the error rates.
 *
 * The circuit: |0…0⟩, H on every qubit (the day-start state), then the day's
 * gates in the order they were applied. Logical qubit q starts on position q
 * of a line of 10 physical qubits that the coupling map connects in a row
 * (heavy-hex has no 10-cycle, its smallest ring is 12), so CNOT q → q+1 is
 * one CZ; any other pair, including the wrap-around 9 → 0, is brought next
 * to each other by SWAPs along the line and the layout is tracked (no swap
 * back). MEASURE becomes a mid-circuit measurement into register `m`, the
 * final measurement of all ten logical qubits goes to register `c` (c[q] is
 * logical qubit q). The chip draws its own mid-circuit outcomes, so only
 * shots whose `m` equals the site's logged outcomes are samples of the
 * site's register (post-selection): the collapse is the first such shot and
 * the published distribution counts only those. PROTECT is not a gate. Decompositions, all up to a global
 * phase and checked against the simulator by the self-test:
 *   H     = RZ(π/2) · SX · RZ(π/2)
 *   RY(θ) = SX, RZ(θ+π), SX, RZ(π)            (time order)
 *   CNOT  = H(t) · CZ · H(t)
 *   SWAP  = CNOT(a,b) · CNOT(b,a) · CNOT(a,b)
 * Two pubs in one job: the collapse (1 shot) and the distribution (1000).
 * With mid-circuit measurements the collapse falls through to the first
 * distribution shot that repeats the site's outcomes when the collapse shot
 * does not (shots are independent, so that is a fair draw of the same
 * conditional distribution).
 *
 * Verification before a Sunday (GET /api/pet/qpu/check, POST|GET
 * /api/pet/qpu/smoke in worker/pet.ts): `runQpuCheck` runs the Sunday's own
 * steps up to the backend and chain choice without sending anything, and
 * `submitSmoke` sends a Bell pair (H, CNOT, both measured) through the same
 * backend choice, ISA path (`toNative`), QASM emitter and Sampler V2 body as
 * the Sunday, with a 1-shot pub and a 200-shot pub, read back by the same
 * `parseSamplerResult`. Every text that leaves the Worker goes through
 * `publicReason`, which masks CRNs, tokens, keys and account ids.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const QPU_QUBITS = 10;
export const IBM_API_VERSION = "2026-04-15";
/**
 * Sent with every IBM request. Workers send no User-Agent by default, and the
 * front door of quantum.cloud.ibm.com answers such requests with a 403 HTML
 * page instead of the API (seen in production on 2026-10-11).
 */
export const IBM_USER_AGENT = "dirac-pet/1.0 (+https://dirac.digital/pet)";
export const IBM_IAM_URL = "https://iam.cloud.ibm.com/identity/token";
export const IBM_RESOURCE_INSTANCES_URL = "https://resource-controller.cloud.ibm.com/v2/resource_instances";
/** The quantum-computing service in the IBM Cloud catalog. */
export const QUANTUM_RESOURCE_ID = "b6049020-80f4-11eb-a0f7-e35ec9b4054f";
/** The Open (free) plan, preferred when the account has several instances. */
export const OPEN_PLAN_ID = "850b21a7-71de-4e53-9441-1abdd202f35d";

/** The collapse is one draw. */
export const COLLAPSE_SHOTS = 1;
/** The published distribution next to the simulator's. */
export const DISTRIBUTION_SHOTS = 1000;
/** A job not finished this long after the collapse falls back to the simulator. */
export const QPU_DEADLINE_MS = 6 * 60 * 60 * 1000;
/** Lazy polls from GET /api/pet happen at most this often. */
export const QPU_POLL_GAP_MS = 60 * 1000;
/** Hardware time this site allows itself per UTC month (the Open plan grants 10 minutes per 28 days). */
export const MONTH_BUDGET_SECONDS = 8 * 60;
/** Counted for a job whose usage IBM did not report, so the guard errs on the safe side. */
export const UNKNOWN_USAGE_SECONDS = 30;
/** IBM must report at least this much allowance left before a job is sent. */
export const MIN_INSTANCE_SECONDS = 60;
/** Beyond this many CZ the result is noise; such a day is drawn on the simulator. */
export const MAX_TWO_QUBIT_GATES = 600;
/** Submission attempts before the day falls back. */
export const MAX_SUBMIT_ATTEMPTS = 3;
/** A failed submission is retried no sooner than this, so a short IBM outage does not use up the attempts. */
export const SUBMIT_RETRY_GAP_MS = 20 * 60 * 1000;
/**
 * A submission holds the run this long: it makes up to a dozen IBM calls of
 * up to 20 s each, so the one-minute poll claim would let a second poller
 * send a second job while the first is still on its way.
 */
export const SUBMIT_LEASE_MS = 5 * 60 * 1000;
/**
 * Shots of the 1001 that must be expected to repeat the site's mid-circuit
 * outcomes (the product of their probabilities); a day below this is drawn on
 * the simulator instead of spending QPU time on a run that cannot be read.
 */
export const MIN_EXPECTED_MATCHES = 20;
/** Backends tried in queue order per submission. */
export const MAX_BACKENDS_TRIED = 4;

/** The smoke test's distribution pub (a 1-shot pub goes first, as on a Sunday). */
export const SMOKE_SHOTS = 200;
/** The Bell pair: two physical qubits, two classical bits. */
export const SMOKE_QUBITS = 2;
/** At most one smoke job that ran (completed, or charged QPU time) per this many ms. */
export const SMOKE_EVERY_MS = 6 * 24 * 60 * 60 * 1000;
/** A smoke submission that never reached IBM blocks the next attempt this long. */
export const SMOKE_RETRY_GAP_MS = 10 * 60 * 1000;
/** A pending smoke job is asked about at most this often (shared across isolates). */
export const SMOKE_POLL_GAP_MS = 30 * 1000;
/** A smoke job still open this long after it was sent is cancelled. */
export const SMOKE_DEADLINE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
/** A token is renewed this long before IAM says it expires. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Schedule                                                            */
/* ------------------------------------------------------------------ */

/** Whether the collapse scheduled at `collapseAt` (a 00:00 UTC instant) is a hardware collapse: Sundays. */
export const isQpuCollapse = (collapseAt: number): boolean => new Date(collapseAt).getUTCDay() === 0;

/**
 * The next hardware collapse at or after today's collapse (`collapseAt`, the
 * end of `day`): the day it ends and when. Days collapse once a midnight, so
 * the day number advances by the days in between.
 */
export function nextQpuCollapse(day: number, collapseAt: number): { day: number; at: number } {
  const ahead = (7 - new Date(collapseAt).getUTCDay()) % 7;
  return { day: day + ahead, at: collapseAt + ahead * DAY_MS };
}

/** 00:00 UTC on the first of the month that contains `now`. */
export function monthStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export const deadlineOf = (collapsedAt: number): number => collapsedAt + QPU_DEADLINE_MS;
export const deadlinePassed = (collapsedAt: number, now: number): boolean => now >= deadlineOf(collapsedAt);

/* ------------------------------------------------------------------ */
/* Gate log                                                            */
/* ------------------------------------------------------------------ */

/** One logged gate, replayable: MUTATE carries its angle, MEASURE the outcome the site drew. */
export type LogGate =
  | { gate: "H" | "X" | "PROTECT"; q: number }
  | { gate: "CNOT"; q: number; t: number }
  | { gate: "MUTATE"; q: number; theta: number }
  | { gate: "MEASURE"; q: number; outcome: 0 | 1 };

/** A pet_actions row as the log query reads it. */
export interface ActionLogRow {
  gate: string;
  q: number;
  t: number | null;
  theta: number | null;
  outcome: number | null;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

const isQ = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < QPU_QUBITS;

/**
 * The day's log as gates, in application order, or why it cannot be
 * replayed: a row count that differs from the register's own count, a mutate
 * logged before angles were kept, a measure without its outcome.
 */
export function logFromRows(rows: ActionLogRow[], expected: number): Checked<LogGate[]> {
  if (rows.length !== expected) {
    return { ok: false, reason: `the log holds ${rows.length} gates but the register counted ${expected}` };
  }
  const gates: LogGate[] = [];
  for (const row of rows) {
    if (!isQ(row.q)) return { ok: false, reason: "a logged gate names a qubit outside 0..9" };
    switch (row.gate) {
      case "H":
      case "X":
      case "PROTECT":
        gates.push({ gate: row.gate, q: row.q });
        break;
      case "CNOT":
        if (!isQ(row.t) || row.t === row.q) return { ok: false, reason: "a logged CNOT has no valid target" };
        gates.push({ gate: "CNOT", q: row.q, t: row.t });
        break;
      case "MUTATE":
        if (typeof row.theta !== "number" || !Number.isFinite(row.theta)) {
          return { ok: false, reason: `a mutate on q${row.q} has no recorded angle (logged before angles were kept)` };
        }
        gates.push({ gate: "MUTATE", q: row.q, theta: row.theta });
        break;
      case "MEASURE":
        if (row.outcome !== 0 && row.outcome !== 1) return { ok: false, reason: `a measure on q${row.q} has no recorded outcome` };
        gates.push({ gate: "MEASURE", q: row.q, outcome: row.outcome });
        break;
      default:
        return { ok: false, reason: `unknown gate ${String(row.gate)} in the log` };
    }
  }
  return { ok: true, value: gates };
}

const touchedBy = (g: LogGate): number[] => (g.gate === "CNOT" ? [g.q, g.t] : [g.q]);

/**
 * Exact simplifications that keep the unitary: PROTECT dropped, H·H, X·X and
 * CNOT·CNOT (same control and target) with nothing in between on their
 * qubits cancel, RY(a)·RY(b) on one qubit merge. Measurements are never
 * moved or removed, and nothing cancels across one.
 */
export function optimiseLog(gates: LogGate[]): LogGate[] {
  const out: (LogGate | null)[] = [];
  const stacks: number[][] = Array.from({ length: QPU_QUBITS }, () => []);
  const top = (q: number): number | undefined => stacks[q][stacks[q].length - 1];

  for (const g of gates) {
    if (g.gate === "PROTECT") continue;
    const qs = touchedBy(g);
    const last = top(qs[0]);
    const prev = last === undefined ? null : out[last];
    if (prev && last !== undefined && qs.every((q) => top(q) === last) && touchedBy(prev).length === qs.length) {
      const cancels =
        ((g.gate === "H" || g.gate === "X") && prev.gate === g.gate) ||
        (g.gate === "CNOT" && prev.gate === "CNOT" && prev.q === g.q && prev.t === g.t);
      if (cancels) {
        out[last] = null;
        for (const q of qs) stacks[q].pop();
        continue;
      }
      if (g.gate === "MUTATE" && prev.gate === "MUTATE") {
        out[last] = { gate: "MUTATE", q: g.q, theta: prev.theta + g.theta };
        continue;
      }
    }
    out.push(g);
    for (const q of qs) stacks[q].push(out.length - 1);
  }
  return out.filter((g): g is LogGate => g !== null);
}

/* ------------------------------------------------------------------ */
/* Routing on a line of physical qubits                                */
/* ------------------------------------------------------------------ */

/** A gate on positions 0..9 of the line (position p sits on physical qubit chain[p]). */
export type LineOp =
  | { op: "h" | "x"; p: number }
  | { op: "ry"; p: number; theta: number }
  | { op: "cx"; c: number; t: number }
  | { op: "swap"; a: number; b: number }
  | { op: "measure"; p: number; reg: "m" | "c"; bit: number };

export interface LineCircuit {
  ops: LineOp[];
  /** layout[q] = the position logical qubit q ends on */
  layout: number[];
  /** the site's outcomes of the mid-circuit measurements, in register `m` order */
  mids: (0 | 1)[];
  swaps: number;
}

/**
 * Places logical qubit q on position q, applies the day-start H layer and
 * the gates, and routes every CNOT whose qubits are not neighbours by moving
 * the control along the line with SWAPs until it is (the layout follows, no
 * swap back). Ends with the measurement of every logical qubit into c[q].
 */
export function routeOnLine(gates: LogGate[]): LineCircuit {
  const n = QPU_QUBITS;
  const pos = Array.from({ length: n }, (_, i) => i);
  const at = Array.from({ length: n }, (_, i) => i);
  const ops: LineOp[] = [];
  const mids: (0 | 1)[] = [];
  let swaps = 0;

  for (let p = 0; p < n; p++) ops.push({ op: "h", p });
  for (const g of gates) {
    switch (g.gate) {
      case "PROTECT":
        break;
      case "H":
        ops.push({ op: "h", p: pos[g.q] });
        break;
      case "X":
        ops.push({ op: "x", p: pos[g.q] });
        break;
      case "MUTATE":
        ops.push({ op: "ry", p: pos[g.q], theta: g.theta });
        break;
      case "MEASURE":
        ops.push({ op: "measure", p: pos[g.q], reg: "m", bit: mids.length });
        mids.push(g.outcome);
        break;
      case "CNOT": {
        while (Math.abs(pos[g.q] - pos[g.t]) > 1) {
          const a = pos[g.q];
          const b = a + Math.sign(pos[g.t] - a);
          const other = at[b];
          at[a] = other;
          at[b] = g.q;
          pos[other] = a;
          pos[g.q] = b;
          ops.push({ op: "swap", a, b });
          swaps += 1;
        }
        ops.push({ op: "cx", c: pos[g.q], t: pos[g.t] });
        break;
      }
    }
  }
  for (let q = 0; q < n; q++) ops.push({ op: "measure", p: pos[q], reg: "c", bit: q });
  return { ops, layout: pos, mids, swaps };
}

/* ------------------------------------------------------------------ */
/* Native gates                                                        */
/* ------------------------------------------------------------------ */

/** The ISA instructions of a CZ backend, on line positions. */
export type NativeOp =
  | { op: "rz"; p: number; angle: number }
  | { op: "sx" | "x"; p: number }
  | { op: "cz"; a: number; b: number }
  | { op: "measure"; p: number; reg: "m" | "c"; bit: number };

type CzOp =
  | { op: "h" | "x"; p: number }
  | { op: "ry"; p: number; theta: number }
  | { op: "cz"; a: number; b: number }
  | { op: "measure"; p: number; reg: "m" | "c"; bit: number };

const czTouches = (o: CzOp): number[] => (o.op === "cz" ? [o.a, o.b] : [o.p]);

/** CNOT and SWAP as H and CZ, then adjacent H·H on a position cancelled. */
function toCzLevel(ops: LineOp[]): CzOp[] {
  const raw: CzOp[] = [];
  const cx = (c: number, t: number) => raw.push({ op: "h", p: t }, { op: "cz", a: c, b: t }, { op: "h", p: t });
  for (const o of ops) {
    if (o.op === "cx") cx(o.c, o.t);
    else if (o.op === "swap") {
      cx(o.a, o.b);
      cx(o.b, o.a);
      cx(o.a, o.b);
    } else raw.push(o);
  }
  const out: (CzOp | null)[] = [];
  const last: (number | undefined)[] = new Array(QPU_QUBITS).fill(undefined);
  for (const o of raw) {
    if (o.op === "h") {
      const i = last[o.p];
      const prev = i === undefined ? null : out[i];
      if (prev && prev.op === "h") {
        out[i as number] = null;
        // the op before the cancelled H on this position, if any, is found by scanning back
        let j = (i as number) - 1;
        while (j >= 0 && !(out[j] && czTouches(out[j] as CzOp).includes(o.p))) j -= 1;
        last[o.p] = j >= 0 ? j : undefined;
        continue;
      }
    }
    out.push(o);
    for (const p of czTouches(o)) last[p] = out.length - 1;
  }
  return out.filter((o): o is CzOp => o !== null);
}

/** An angle in (−π, π]; RZ(a + 2π) = −RZ(a), a global phase. */
export function wrapAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  let r = a % twoPi;
  if (r <= -Math.PI) r += twoPi;
  if (r > Math.PI) r -= twoPi;
  return r;
}

/** RZ angles this close to 0 (mod 2π) are dropped. */
const ANGLE_EPS = 1e-12;

/**
 * The CZ-level program as native instructions (H = RZ(π/2) SX RZ(π/2),
 * RY(θ) = SX RZ(θ+π) SX RZ(π)), with consecutive RZ on a position merged.
 */
export function toNative(ops: LineOp[]): NativeOp[] {
  const out: NativeOp[] = [];
  const pending: number[] = new Array(QPU_QUBITS).fill(0);
  const flush = (p: number) => {
    const a = wrapAngle(pending[p]);
    pending[p] = 0;
    if (Math.abs(a) > ANGLE_EPS) out.push({ op: "rz", p, angle: a });
  };
  const rz = (p: number, a: number) => {
    pending[p] += a;
  };
  const sx = (p: number) => {
    flush(p);
    out.push({ op: "sx", p });
  };
  for (const o of toCzLevel(ops)) {
    switch (o.op) {
      case "h":
        rz(o.p, Math.PI / 2);
        sx(o.p);
        rz(o.p, Math.PI / 2);
        break;
      case "x":
        flush(o.p);
        out.push({ op: "x", p: o.p });
        break;
      case "ry":
        sx(o.p);
        rz(o.p, o.theta + Math.PI);
        sx(o.p);
        rz(o.p, Math.PI);
        break;
      case "cz":
        flush(o.a);
        flush(o.b);
        out.push({ op: "cz", a: o.a, b: o.b });
        break;
      case "measure":
        flush(o.p);
        out.push(o);
        break;
    }
  }
  for (let p = 0; p < QPU_QUBITS; p++) flush(p);
  return out;
}

export interface DayCircuit {
  line: LineCircuit;
  native: NativeOp[];
  twoQubit: number;
}

/** The day's gates as a native program on line positions, independent of the backend. */
export function buildCircuit(gates: LogGate[]): DayCircuit {
  const line = routeOnLine(optimiseLog(gates));
  const native = toNative(line.ops);
  return { line, native, twoQubit: native.filter((o) => o.op === "cz").length };
}

/* ------------------------------------------------------------------ */
/* OpenQASM 3                                                          */
/* ------------------------------------------------------------------ */

/** Plain decimal with 15 places, trailing zeros trimmed: never an exponent. */
export function formatAngle(a: number): string {
  const s = a.toFixed(15).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/**
 * The ISA circuit as OpenQASM 3 on physical qubits: position p is
 * `$chain[p]`. `hasEdge(a, b)` says whether the coupling map lists the
 * directed pair; a CZ is written in a listed direction (CZ is symmetric, the
 * backend lists both on Heron).
 */
export function emitQasm(native: NativeOp[], mids: number, chain: number[], hasEdge: (a: number, b: number) => boolean = () => true): string {
  if (chain.length !== QPU_QUBITS || new Set(chain).size !== QPU_QUBITS) throw new RangeError("chain must be 10 distinct qubits");
  return emitIsaQasm(native, mids, chain, hasEdge);
}

/**
 * The emitter itself, for any width up to 10: position p is `$qubits[p]`,
 * register `c` has one bit per position. `emitQasm` is this with the
 * Sunday's line of 10; the smoke test's Bell pair uses it with two qubits.
 */
export function emitIsaQasm(native: NativeOp[], mids: number, qubits: number[], hasEdge: (a: number, b: number) => boolean = () => true): string {
  const width = qubits.length;
  if (width < 1 || width > QPU_QUBITS || new Set(qubits).size !== width || !qubits.every((q) => Number.isInteger(q) && q >= 0)) {
    throw new RangeError(`qubits must be 1..${QPU_QUBITS} distinct physical qubits`);
  }
  const lines = ["OPENQASM 3.0;", 'include "stdgates.inc";', `bit[${width}] c;`];
  if (mids > 0) lines.push(`bit[${mids}] m;`);
  const $ = (p: number) => {
    if (!Number.isInteger(p) || p < 0 || p >= width) throw new RangeError(`position ${p} is outside the ${width} qubits`);
    return `$${qubits[p]}`;
  };
  for (const o of native) {
    switch (o.op) {
      case "rz":
        lines.push(`rz(${formatAngle(o.angle)}) ${$(o.p)};`);
        break;
      case "sx":
      case "x":
        lines.push(`${o.op} ${$(o.p)};`);
        break;
      case "cz": {
        const [a, b] = hasEdge(qubits[o.a], qubits[o.b]) ? [o.a, o.b] : [o.b, o.a];
        lines.push(`cz ${$(a)}, ${$(b)};`);
        break;
      }
      case "measure":
        lines.push(`${o.reg}[${o.bit}] = measure ${$(o.p)};`);
        break;
    }
  }
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* The smoke test's Bell pair                                          */
/* ------------------------------------------------------------------ */

/** H on position 0, CNOT 0 → 1, both measured into c[0] and c[1]: (|00⟩ + |11⟩)/√2. */
export function bellLineOps(): LineOp[] {
  return [
    { op: "h", p: 0 },
    { op: "cx", c: 0, t: 1 },
    { op: "measure", p: 0, reg: "c", bit: 0 },
    { op: "measure", p: 1, reg: "c", bit: 1 },
  ];
}

/** The Bell pair as native instructions, through the Sunday's own `toNative`. */
export const bellNative = (): NativeOp[] => toNative(bellLineOps());

/** The Bell pair as OpenQASM 3 on two coupled physical qubits (`pair[0]` gets the H). */
export function bellQasm(pair: [number, number], hasEdge: (a: number, b: number) => boolean = () => true): string {
  return emitIsaQasm(bellNative(), 0, pair, hasEdge);
}

/**
 * The pair for the Bell test: two neighbours on the chosen line (so the
 * coupler is in the coupling map and passed the same health filter), the one
 * with the lowest summed readout and CZ error; the first pair without
 * calibration data.
 */
export function pickPair(chain: number[], quality: ChainQuality | null): [number, number] {
  if (chain.length < 2) throw new RangeError("a pair needs a chain of at least two qubits");
  let best: [number, number] = [chain[0], chain[1]];
  if (!quality) return best;
  let bestScore = Infinity;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1];
    const b = chain[i];
    const s =
      (quality.qubitError.get(a) ?? UNKNOWN_ERROR) + (quality.qubitError.get(b) ?? UNKNOWN_ERROR) + (quality.edgeError.get(edgeKey(a, b)) ?? UNKNOWN_ERROR);
    if (s < bestScore) {
      bestScore = s;
      best = [a, b];
    }
  }
  return best;
}

/** The share of shots in which the two qubits agreed (00 or 11): about 1 on a good pair, 0.5 for noise. */
export function bellSummary(counts: Record<string, number>): { shots: number; p00: number; p11: number; correlated: number } {
  let shots = 0;
  for (const n of Object.values(counts)) shots += n;
  const p = (bits: string) => (shots > 0 ? (counts[bits] ?? 0) / shots : 0);
  return { shots, p00: p("00"), p11: p("11"), correlated: p("00") + p("11") };
}

/* ------------------------------------------------------------------ */
/* Backend: target check and a line of 10 connected qubits             */
/* ------------------------------------------------------------------ */

export const edgeKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const asInt = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};

export interface CzTarget {
  name: string;
  nQubits: number;
  /** directed pairs as listed */
  coupling: [number, number][];
}

/** Whether a backend configuration is a CZ target this transpiler can serve, and its coupling map. */
export function czTargetFrom(config: unknown): Checked<CzTarget> {
  if (!isRecord(config)) return { ok: false, reason: "configuration is not an object" };
  const name = typeof config.backend_name === "string" ? config.backend_name : "backend";
  const basis = Array.isArray(config.basis_gates) ? config.basis_gates.filter((g): g is string => typeof g === "string") : [];
  for (const g of ["cz", "rz", "sx", "x"]) {
    if (!basis.includes(g)) return { ok: false, reason: `${name} has no ${g} in its basis` };
  }
  if (Array.isArray(config.supported_instructions) && !config.supported_instructions.includes("measure")) {
    return { ok: false, reason: `${name} does not list measure` };
  }
  const nQubits = asInt(config.n_qubits);
  if (nQubits === null || nQubits < QPU_QUBITS) return { ok: false, reason: `${name} has fewer than ${QPU_QUBITS} qubits` };
  if (!Array.isArray(config.coupling_map)) return { ok: false, reason: `${name} has no coupling map` };
  const coupling: [number, number][] = [];
  for (const pair of config.coupling_map) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const a = asInt(pair[0]);
    const b = asInt(pair[1]);
    if (a !== null && b !== null && a !== b && a < nQubits && b < nQubits) coupling.push([a, b]);
  }
  if (coupling.length === 0) return { ok: false, reason: `${name} has an empty coupling map` };
  return { ok: true, value: { name, nQubits, coupling } };
}

/** What the calibration says about qubits and CZ pairs; lower error is better. */
export interface ChainQuality {
  badQubits: Set<number>;
  badEdges: Set<string>;
  qubitError: Map<number, number>;
  edgeError: Map<string, number>;
}

const paramValue = (params: unknown, name: string): number | null => {
  if (!Array.isArray(params)) return null;
  for (const p of params) {
    if (isRecord(p) && p.name === name && typeof p.value === "number" && Number.isFinite(p.value)) return p.value;
  }
  return null;
};

/**
 * Readout and CZ errors from GET /backends/{name}/properties. A qubit or a
 * pair reported non-operational, or with an error of 0.5 and above (IBM
 * marks broken couplers with 1), is excluded. Null when nothing is usable.
 */
export function chainQualityFrom(props: unknown): ChainQuality | null {
  if (!isRecord(props)) return null;
  const quality: ChainQuality = { badQubits: new Set(), badEdges: new Set(), qubitError: new Map(), edgeError: new Map() };
  if (Array.isArray(props.qubits)) {
    props.qubits.forEach((params, q) => {
      if (paramValue(params, "operational") === 0) quality.badQubits.add(q);
      const readout = paramValue(params, "readout_error");
      if (readout !== null) {
        quality.qubitError.set(q, readout);
        if (readout >= 0.5) quality.badQubits.add(q);
      }
    });
  }
  if (Array.isArray(props.gates)) {
    for (const g of props.gates) {
      if (!isRecord(g) || g.gate !== "cz" || !Array.isArray(g.qubits) || g.qubits.length !== 2) continue;
      const a = asInt(g.qubits[0]);
      const b = asInt(g.qubits[1]);
      if (a === null || b === null) continue;
      const key = edgeKey(a, b);
      if (paramValue(g.parameters, "operational") === 0) quality.badEdges.add(key);
      const err = paramValue(g.parameters, "gate_error");
      if (err !== null) {
        quality.edgeError.set(key, Math.max(err, quality.edgeError.get(key) ?? 0));
        if (err >= 0.5) quality.badEdges.add(key);
      }
    }
  }
  return quality.qubitError.size > 0 || quality.edgeError.size > 0 || quality.badQubits.size > 0 ? quality : null;
}

/** Error charged for a qubit or pair the calibration does not mention. */
const UNKNOWN_ERROR = 0.05;
/** Paths kept per start qubit while searching; enough variety across a 156-qubit chip. */
const PATHS_PER_START = 6;
const SEARCH_STEPS = 200_000;

/**
 * A simple path of `length` physical qubits, consecutive ones coupled: the
 * first found without calibration data, else the one with the lowest summed
 * readout and CZ error among the candidates (bad qubits and pairs skipped).
 */
export function findChain(coupling: [number, number][], length = QPU_QUBITS, quality: ChainQuality | null = null): number[] | null {
  const adj = new Map<number, number[]>();
  for (const [a, b] of coupling) {
    if (quality && (quality.badQubits.has(a) || quality.badQubits.has(b) || quality.badEdges.has(edgeKey(a, b)))) continue;
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const list = adj.get(x) ?? [];
      if (!list.includes(y)) list.push(y);
      adj.set(x, list);
    }
  }
  for (const list of adj.values()) list.sort((x, y) => x - y);
  const nodes = [...adj.keys()].sort((x, y) => x - y);

  const score = (path: number[]): number => {
    if (!quality) return 0;
    let s = 0;
    for (let i = 0; i < path.length; i++) {
      s += quality.qubitError.get(path[i]) ?? UNKNOWN_ERROR;
      if (i > 0) s += quality.edgeError.get(edgeKey(path[i - 1], path[i])) ?? UNKNOWN_ERROR;
    }
    return s;
  };

  const search = { best: null as number[] | null, bestScore: Infinity, steps: 0 };
  for (const start of nodes) {
    let found = 0;
    const path = [start];
    const onPath = new Set([start]);
    const walk = (): boolean => {
      if (search.steps++ > SEARCH_STEPS) return true;
      if (path.length === length) {
        const s = score(path);
        if (s < search.bestScore) {
          search.bestScore = s;
          search.best = [...path];
        }
        found += 1;
        return !quality || found >= PATHS_PER_START;
      }
      for (const next of adj.get(path[path.length - 1]) ?? []) {
        if (onPath.has(next)) continue;
        path.push(next);
        onPath.add(next);
        const stop = walk();
        path.pop();
        onPath.delete(next);
        if (stop) return true;
      }
      return false;
    };
    walk();
    if (search.best && !quality) return search.best;
    if (search.steps > SEARCH_STEPS) break;
  }
  return search.best;
}

/** One device of GET /backends as listed: its status, pending jobs and size, and whether a run may use it. */
export interface BackendEntry {
  name: string;
  /** `status.name` (or a plain `status` string); "unknown" when absent */
  status: string;
  /** `status.reason`, when IBM gives one */
  reason: string | null;
  /** `queue_length`: jobs waiting on the device */
  queue: number | null;
  qubits: number | null;
  /** online with at least 10 qubits (a device that does not say its size is tried) */
  usable: boolean;
}

/** Every named device of a GET /backends listing, in listing order. */
export function listBackends(listing: unknown): BackendEntry[] {
  const devices = isRecord(listing) && Array.isArray(listing.devices) ? listing.devices : [];
  const out: BackendEntry[] = [];
  for (const d of devices) {
    if (!isRecord(d) || typeof d.name !== "string") continue;
    const rawStatus = isRecord(d.status) ? d.status.name : d.status;
    const status = typeof rawStatus === "string" ? rawStatus : "unknown";
    const reason = isRecord(d.status) && typeof d.status.reason === "string" ? d.status.reason : null;
    const qubits = asInt(d.qubits);
    out.push({ name: d.name, status, reason, queue: asInt(d.queue_length), qubits, usable: status === "online" && (qubits === null || qubits >= QPU_QUBITS) });
  }
  return out;
}

/** Online backends with at least 10 qubits, least busy first (ties by name). */
export function rankBackends(listing: unknown): string[] {
  return listBackends(listing)
    .filter((d) => d.usable)
    .map((d) => ({ name: d.name, queue: d.queue ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.queue - b.queue || a.name.localeCompare(b.name))
    .map((d) => d.name);
}

/* ------------------------------------------------------------------ */
/* Jobs and results                                                    */
/* ------------------------------------------------------------------ */

/** The tag every job of a day carries, so a submission that lost its answer is found again. */
export const jobTag = (day: number): string => `dirac-pet-day-${day}`;

/**
 * The tag of a smoke job: its row id and creation time, so a row id reused
 * after the table was emptied never adopts an older job.
 */
export const smokeTag = (id: number, createdAt: number): string => `dirac-qpu-smoke-${id}-${createdAt}`;

/** A Sampler V2 request: a 1-shot pub, then a pub of `shots`, of the same circuit. */
function samplerBody(backend: string, qasm: string, tag: string, shots: number): Record<string, unknown> {
  return {
    program_id: "sampler",
    backend,
    tags: [tag],
    params: {
      pubs: [
        [qasm, null, COLLAPSE_SHOTS],
        [qasm, null, shots],
      ],
      version: 2,
      // plain JSON results (results[i].data.<register>.samples as hex), the shape parseSamplerResult reads
      support_qiskit: false,
    },
  };
}

/** The Sampler V2 request: the collapse pub (1 shot), then the distribution pub. */
export function samplerJobBody(backend: string, qasm: string, day: number): Record<string, unknown> {
  return samplerBody(backend, qasm, jobTag(day), DISTRIBUTION_SHOTS);
}

/** The smoke test's request: the Sunday's body with the Bell pair, a 1-shot pub and SMOKE_SHOTS. */
export function smokeJobBody(backend: string, qasm: string, tag: string): Record<string, unknown> {
  return samplerBody(backend, qasm, tag, SMOKE_SHOTS);
}

export type JobPhase = "queued" | "running" | "completed" | "failed" | "cancelled";

/** The phase of GET /jobs/{id}, from `state.status` (or the older top-level `status`). */
export function jobPhaseFrom(job: unknown): { phase: JobPhase; reason: string | null } | null {
  if (!isRecord(job)) return null;
  const state = isRecord(job.state) ? job.state : null;
  const raw = typeof state?.status === "string" ? state.status : typeof job.status === "string" ? job.status : null;
  if (raw === null) return null;
  const s = raw.toLowerCase();
  const reason = typeof state?.reason === "string" && state.reason.trim() !== "" ? state.reason.trim() : null;
  if (s.startsWith("completed")) return { phase: "completed", reason };
  if (s.startsWith("failed") || s === "error") return { phase: "failed", reason };
  if (s.startsWith("cancelled")) return { phase: "cancelled", reason: reason ?? (s.includes("too long") ? "ran too long" : null) };
  if (s.startsWith("running")) return { phase: "running", reason };
  if (s.startsWith("queued") || s === "initializing" || s === "validating") return { phase: "queued", reason };
  return null;
}

/** QPU seconds charged, from GET /jobs/{id}/metrics (newer and older field names). */
export function usageSecondsFrom(metrics: unknown): number | null {
  const usage = isRecord(metrics) && isRecord(metrics.usage) ? metrics.usage : null;
  if (!usage) return null;
  for (const key of ["qpu_charge_time_seconds", "quantum_seconds", "seconds"]) {
    const v = usage[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

/** When IBM says the job finished (metrics timestamps), unix ms. */
export function finishedAtFrom(metrics: unknown): number | null {
  const ts = isRecord(metrics) && isRecord(metrics.timestamps) ? metrics.timestamps.finished : null;
  if (typeof ts !== "string") return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** The bits of a register value, bit 0 (clbit 0, logical qubit 0) first. */
export function bitsFromInt(value: number, width = QPU_QUBITS): string {
  let bits = "";
  for (let k = 0; k < width; k++) bits += Math.floor(value / 2 ** k) % 2;
  return bits;
}

const HEX = /^0x[0-9a-f]+$/i;

/** A register's samples as integers (BigInt: a day can hold more than 53 mid-circuit measurements). */
function registerSamples(pub: unknown, reg: string, width: number): Checked<bigint[]> {
  const data = isRecord(pub) && isRecord(pub.data) ? pub.data : null;
  const r = data && isRecord(data[reg]) ? (data[reg] as Record<string, unknown>) : null;
  if (!r || !Array.isArray(r.samples)) return { ok: false, reason: `the result has no samples for register ${reg}` };
  if (typeof r.num_bits === "number" && r.num_bits !== width) {
    return { ok: false, reason: `register ${reg} has ${r.num_bits} bits, expected ${width}` };
  }
  const limit = BigInt(1) << BigInt(width);
  const out: bigint[] = [];
  for (const s of r.samples) {
    if (typeof s !== "string" || !HEX.test(s)) return { ok: false, reason: `register ${reg} has a sample that is not hex` };
    const v = BigInt(`0x${s.slice(2)}`);
    if (v >= limit) return { ok: false, reason: `register ${reg} has a sample wider than ${width} bits` };
    out.push(v);
  }
  return { ok: true, value: out };
}

/** The bits of a register value, bit 0 (clbit 0) first. */
function bitsFromBig(value: bigint, width: number): (0 | 1)[] {
  const out: (0 | 1)[] = [];
  for (let k = 0; k < width; k++) out.push(((value >> BigInt(k)) & BigInt(1)) === BigInt(1) ? 1 : 0);
  return out;
}

export interface SamplerOutcome {
  /**
   * The collapse: ten logical qubits from the first shot, the collapse pub's
   * first, whose mid-circuit outcomes equal the site's (every shot qualifies
   * without mid-circuit measurements). Null when no shot repeated them.
   */
  bits: string | null;
  /** the collapse pub's own mid-circuit outcomes, register `m` order */
  midsHardware: (0 | 1)[];
  /** the distribution shots that repeated the site's mid-circuit outcomes (all of them without any): bits → shots */
  counts: Record<string, number>;
  /** every distribution shot, matched or not */
  shots: number;
  /** distribution shots whose mid-circuit outcomes equal the site's; null without mid-circuit measurements */
  matched: number | null;
}

/**
 * Reads GET /jobs/{id}/results of the two-pub job: results[0] is the
 * collapse, results[1] the distribution; `c` holds the ten logical qubits,
 * `m` the mid-circuit measurements (only when `siteMids` is not empty).
 * The chip draws its own mid-circuit outcomes, so a shot is a sample of the
 * site's register only when they equal the site's (post-selection).
 * `width` is the size of `c`: 10 on a Sunday, 2 for the smoke test's Bell pair.
 */
export function parseSamplerResult(json: unknown, siteMids: (0 | 1)[], width = QPU_QUBITS): Checked<SamplerOutcome> {
  const results = isRecord(json) && Array.isArray(json.results) ? json.results : null;
  if (!results || results.length < 2) return { ok: false, reason: "the result does not hold the two pubs" };
  const k = siteMids.length;
  const collapse = registerSamples(results[0], "c", width);
  if (!collapse.ok) return collapse;
  if (collapse.value.length !== COLLAPSE_SHOTS) return { ok: false, reason: `the collapse pub has ${collapse.value.length} shots` };
  const dist = registerSamples(results[1], "c", width);
  if (!dist.ok) return dist;
  if (dist.value.length === 0) return { ok: false, reason: "the distribution pub has no shots" };

  // keep[i]: distribution shot i repeated the site's mid-circuit outcomes
  let keep: boolean[] = dist.value.map(() => true);
  let collapseKept = true;
  let midsHardware: (0 | 1)[] = [];
  let matched: number | null = null;
  if (k > 0) {
    const m0 = registerSamples(results[0], "m", k);
    if (!m0.ok) return m0;
    if (m0.value.length !== collapse.value.length) return { ok: false, reason: "registers c and m differ in shots" };
    const m1 = registerSamples(results[1], "m", k);
    if (!m1.ok) return m1;
    if (m1.value.length !== dist.value.length) return { ok: false, reason: "registers c and m differ in shots" };
    midsHardware = bitsFromBig(m0.value[0], k);
    let site = BigInt(0);
    siteMids.forEach((b, i) => {
      if (b === 1) site |= BigInt(1) << BigInt(i);
    });
    collapseKept = m0.value[0] === site;
    keep = m1.value.map((v) => v === site);
    matched = keep.filter(Boolean).length;
  }

  const counts: Record<string, number> = {};
  let first: bigint | null = collapseKept ? collapse.value[0] : null;
  for (let i = 0; i < dist.value.length; i++) {
    if (!keep[i]) continue;
    const v = dist.value[i];
    if (first === null) first = v;
    const bits = bitsFromInt(Number(v), width);
    counts[bits] = (counts[bits] ?? 0) + 1;
  }
  return {
    ok: true,
    value: { bits: first === null ? null : bitsFromInt(Number(first), width), midsHardware, counts, shots: dist.value.length, matched },
  };
}

/**
 * A keys-only skeleton of a JSON payload, for debugging a format the parser
 * refused without storing any value: `{results:[{data:{c:{samples:[hex×200],num_bits:num}}}×2]}`.
 * Arrays show the shape of their first elements and their length; strings
 * are `str` (or `hex` for 0x… values); at most 12 keys per object, 7 levels,
 * `maxChars` characters, masked like any public text.
 */
export function shapeOf(value: unknown, maxChars = 600): string {
  const leaf = (v: unknown): string => {
    if (v === null) return "null";
    if (typeof v === "string") return HEX.test(v) ? "hex" : "str";
    if (typeof v === "number") return "num";
    if (typeof v === "boolean") return "bool";
    return typeof v;
  };
  const walk = (v: unknown, depth: number): string => {
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (depth >= 7) return `[…×${v.length}]`;
      const shapes = [...new Set(v.slice(0, 3).map((x) => walk(x, depth + 1)))];
      return `[${shapes.join("|")}×${v.length}]`;
    }
    if (typeof v === "object" && v !== null) {
      if (depth >= 7) return "{…}";
      const keys = Object.keys(v);
      const shown = keys.slice(0, 12).map((k) => `${k.slice(0, 40)}:${walk((v as Record<string, unknown>)[k], depth + 1)}`);
      return `{${shown.join(",")}${keys.length > 12 ? ",…" : ""}}`;
    }
    return leaf(v);
  };
  const text = scrubSecrets(walk(value, 0));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** What the smoke test learnt from IBM's result payload. */
export interface SmokeReading {
  /** parseSamplerResult understood the payload (two pubs, register c of 2 bits, hex samples, a 1-shot pub) */
  parsed: boolean;
  /** why it did not, when it did not */
  reason: string | null;
  /** the 200-shot pub's histogram, c[0] first ("00", "01", "10", "11") */
  counts: Record<string, number> | null;
  /** the 1-shot pub's outcome */
  collapse: string | null;
  /** keys-only skeleton of the raw payload */
  shape: string;
}

/** Reads a smoke job's GET /jobs/{id}/results with the Sunday's own parser. */
export function readSmokeResult(json: unknown): SmokeReading {
  const parsed = parseSamplerResult(json, [], SMOKE_QUBITS);
  const shape = shapeOf(json);
  if (!parsed.ok) return { parsed: false, reason: publicReason(parsed.reason), counts: null, collapse: null, shape };
  return { parsed: true, reason: null, counts: parsed.value.counts, collapse: parsed.value.bits, shape };
}

export interface QpuCompare {
  /** the hardware shots compared: those that repeated the site's mid-circuit outcomes */
  shots: number;
  /** every distribution shot, compared or not */
  totalShots: number;
  /** per form (index = low three bits): hardware frequency and simulator probability */
  forms: { form: string; hardware: number; simulator: number }[];
  /** the most frequent hardware outcomes, up to 8 */
  top: { bits: string; hardware: number; simulator: number }[];
  /** Hellinger fidelity of the two distributions, (Σ √(p·q))² */
  fidelity: number;
}

/**
 * The hardware's distribution next to the simulator's: `simulator[i]` is
 * the probability of basis index i (bit q = qubit q), `forms[i & 7]` the form
 * of index i. `totalShots` is the distribution's size before post-selection.
 */
export function compareDistributions(
  counts: Record<string, number>,
  simulator: ArrayLike<number>,
  forms: readonly string[],
  totalShots?: number,
): QpuCompare {
  let shots = 0;
  for (const n of Object.values(counts)) shots += n;
  const indexOfBits = (bits: string): number => {
    let i = 0;
    for (let q = 0; q < bits.length; q++) if (bits[q] === "1") i += 2 ** q;
    return i;
  };
  const formHw = new Array<number>(8).fill(0);
  const formSim = new Array<number>(8).fill(0);
  for (let i = 0; i < simulator.length; i++) formSim[i & 7] += simulator[i];
  let overlap = 0;
  const top: { bits: string; hardware: number; simulator: number }[] = [];
  for (const [bits, n] of Object.entries(counts)) {
    const i = indexOfBits(bits);
    const hw = shots > 0 ? n / shots : 0;
    const sim = simulator[i] ?? 0;
    formHw[i & 7] += hw;
    overlap += Math.sqrt(hw * Math.max(0, sim));
    top.push({ bits, hardware: hw, simulator: sim });
  }
  top.sort((a, b) => b.hardware - a.hardware || b.simulator - a.simulator || a.bits.localeCompare(b.bits));
  return {
    shots,
    totalShots: totalShots ?? shots,
    forms: forms.slice(0, 8).map((form, i) => ({ form, hardware: formHw[i], simulator: formSim[i] })),
    top: top.slice(0, 8),
    fidelity: Math.min(1, overlap * overlap),
  };
}

/* ------------------------------------------------------------------ */
/* Quota                                                               */
/* ------------------------------------------------------------------ */

/** Why a hardware run must not start (null when it may): one pending job at most, 8 minutes a month. */
export function quotaVerdict(input: { pending: boolean; monthSeconds: number }): string | null {
  if (input.pending) return "a previous hardware job is still pending";
  if (input.monthSeconds >= MONTH_BUDGET_SECONDS) {
    return `this month's hardware allowance is used up (${Math.round(input.monthSeconds)} s of ${MONTH_BUDGET_SECONDS} s)`;
  }
  return null;
}

export interface SmokeGuardInput {
  now: number;
  /** a smoke job is submitting, queued or running */
  smokePending: boolean;
  /** a Sunday run is open (submitting, queued or running) */
  sundayOpen: boolean;
  /** when the latest smoke job that ran (completed, or was charged QPU time) was sent; null for none */
  lastRanAt: number | null;
  /** when the latest smoke attempt of any outcome started; null for none */
  lastAttemptAt: number | null;
  /** QPU seconds this UTC month, Sunday runs and smoke jobs together (the Sunday guard's own figure) */
  monthSeconds: number;
}

/**
 * Why a smoke job must not be sent now (null when it may): one pending at a
 * time, never beside an open Sunday run, one that ran per 6 days, 10 minutes
 * after an attempt that never reached IBM, and the monthly budget the Sunday
 * guard reads. `retryAt` is when asking again can succeed, when known.
 */
export function smokeVerdict(input: SmokeGuardInput): { reason: string; retryAt: number | null } | null {
  if (input.smokePending) return { reason: "a smoke job is already pending; GET /api/pet/qpu/smoke follows it", retryAt: null };
  if (input.sundayOpen) return { reason: "the Sunday hardware run is in progress; the smoke test waits until it settles", retryAt: null };
  if (input.lastRanAt !== null && input.now - input.lastRanAt < SMOKE_EVERY_MS) {
    const retryAt = input.lastRanAt + SMOKE_EVERY_MS;
    return { reason: `a smoke job ran at ${new Date(input.lastRanAt).toISOString()}; the next one is allowed from ${new Date(retryAt).toISOString()}`, retryAt };
  }
  if (input.lastAttemptAt !== null && input.now - input.lastAttemptAt < SMOKE_RETRY_GAP_MS) {
    const retryAt = input.lastAttemptAt + SMOKE_RETRY_GAP_MS;
    return { reason: `a smoke attempt started at ${new Date(input.lastAttemptAt).toISOString()}; try again from ${new Date(retryAt).toISOString()}`, retryAt };
  }
  const budget = quotaVerdict({ pending: false, monthSeconds: input.monthSeconds });
  if (budget) return { reason: budget, retryAt: null };
  return null;
}

/** IBM's own account of the instance allowance (GET /instances/usage): a reason to stop, or null. */
export function instanceQuotaVerdict(usage: unknown): string | null {
  if (!isRecord(usage)) return null;
  if (usage.usage_limit_reached === true) return "IBM reports the instance's free allowance is used up";
  const limit = typeof usage.usage_limit_seconds === "number" ? usage.usage_limit_seconds : null;
  const used = typeof usage.usage_consumed_seconds === "number" ? usage.usage_consumed_seconds : null;
  if (limit !== null && used !== null && limit - used < MIN_INSTANCE_SECONDS) {
    return `IBM reports ${Math.max(0, Math.round(limit - used))} s left on the instance`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* REST client                                                         */
/* ------------------------------------------------------------------ */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The global fetch, looked up at call time and never called as a method:
 * the Workers runtime throws "Illegal invocation" when fetch runs with
 * another `this` (as `this.fetchImpl(...)` would).
 */
const globalFetch: FetchLike = (input, init) => fetch(input, init);

/** An IBM call that failed; the message never contains the key or the token. */
export class IbmError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "IbmError";
    this.status = status;
  }
}

/** Longest failure text kept on a run or a day. */
const MAX_REASON_CHARS = 300;

/**
 * What may name the account or grant access, masked in every text the API
 * returns: instance CRNs (plain or URL-encoded), IAM tokens (JWTs), quoted
 * Authorization headers, credential key/value pairs, GUIDs, 32-hex account
 * ids, and long opaque strings that mix letters and digits (API keys).
 */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/crn:v1:[^\s"'`,;)]*/g, "the instance"],
  [/crn%3Av1%3A[^\s"'`,;)&]*/gi, "the instance"],
  [/eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){1,2}/g, "[token]"],
  [/\b(Bearer|Basic)\s+[^\s"'`,;)]+/gi, "$1 [token]"],
  [/\b(api_?key|access_token|refresh_token|token|password|secret)(["']?\s*[:=]\s*["']?)[^\s"'`&,;)]+/gi, "$1$2[redacted]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/\b[0-9a-f]{32}\b/gi, "[account]"],
  [/(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}/g, "[redacted]"],
];

/**
 * `text` with every secret masked: first the literal `secrets` given (the
 * key, the token, the CRN in use; plain and URL-encoded), then the patterns.
 * No length cap (see `publicReason`).
 */
export function scrubSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    const mask = secret.startsWith("crn:") ? "the instance" : "[redacted]";
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join(mask);
  }
  for (const [pattern, mask] of SECRET_PATTERNS) out = out.replace(pattern, mask);
  return out;
}

/**
 * A failure as the public page may show it: IBM's error text can quote the
 * instance CRN, which names the account, or (in principle) a token or key,
 * so those are masked (`scrubSecrets`); whitespace is collapsed and the
 * length capped.
 */
export function publicReason(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  const masked = scrubSecrets(text, secrets).replace(/\s+/g, " ").trim();
  return masked.length > MAX_REASON_CHARS ? `${masked.slice(0, MAX_REASON_CHARS - 1)}…` : masked;
}

/** The API origin for an instance: us-east is quantum.cloud.ibm.com, other regions get a prefix (eu-de). */
export function apiBaseForCrn(crn: string): string {
  const region = crn.split(":")[5] ?? "";
  if (region === "" || region === "us-east" || region === "global") return "https://quantum.cloud.ibm.com/api";
  if (!/^[a-z]{2}-[a-z]+$/.test(region)) throw new IbmError(`unexpected region in the instance CRN: ${region}`);
  return `https://${region}.quantum.cloud.ibm.com/api`;
}

export const isCrn = (v: unknown): v is string => typeof v === "string" && /^crn:v1:[^:]*:[^:]*:quantum-computing:[^:]*:/.test(v);

/**
 * The instance to use from a Resource Controller listing: active ones only,
 * the Open plan first, then the first listed. Null when there is none.
 */
export function pickInstance(listing: unknown): string | null {
  return chooseInstance(listing)?.crn ?? null;
}

/** The instance `pickInstance` takes, with what may be said about it publicly (never the CRN). */
export interface InstanceChoice {
  crn: string;
  /** the Open (free) plan, or another plan */
  plan: "open" | "other";
  /** active quantum-computing instances in the listing */
  active: number;
}

export function chooseInstance(listing: unknown): InstanceChoice | null {
  const resources = isRecord(listing) && Array.isArray(listing.resources) ? listing.resources : [];
  const active = resources.filter(
    (r): r is Record<string, unknown> => isRecord(r) && isCrn(r.crn) && (r.state === undefined || r.state === "active"),
  );
  const open = active.find((r) => r.resource_plan_id === OPEN_PLAN_ID);
  const chosen = open ?? active[0];
  return chosen ? { crn: chosen.crn as string, plan: open ? "open" : "other", active: active.length } : null;
}

/** The region named by an instance CRN (us-east, eu-de, …); "" when it names none. */
export const crnRegion = (crn: string): string => crn.split(":")[5] ?? "";

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 200);
  }
}

/** The first message of an IBM error body ({ errors: [{ message }] } or IAM's { errorMessage }). */
function ibmMessage(body: unknown): string | null {
  if (isRecord(body)) {
    if (Array.isArray(body.errors) && isRecord(body.errors[0]) && typeof body.errors[0].message === "string") return body.errors[0].message;
    if (typeof body.errorMessage === "string") return body.errorMessage;
    if (typeof body.message === "string") return body.message;
  }
  return typeof body === "string" && body.length > 0 ? body : null;
}

let tokenCache: { key: string; token: string; expiresAt: number } | null = null;

/** Drops the cached IAM token (tests; a 401 from the API). */
export function forgetToken(): void {
  tokenCache = null;
}

/**
 * An IAM bearer token for the API key, cached in the isolate until five
 * minutes before IAM's expiry (tokens live an hour).
 */
export async function iamToken(apiKey: string, fetchImpl: FetchLike = globalFetch, now = Date.now()): Promise<string> {
  if (tokenCache && tokenCache.key === apiKey && tokenCache.expiresAt - TOKEN_MARGIN_MS > now) return tokenCache.token;
  const issued = await exchangeApiKey(apiKey, fetchImpl, now);
  tokenCache = { key: apiKey, token: issued.token, expiresAt: issued.expiresAt };
  return issued.token;
}

/** One IAM exchange, never cached (the check route proves the exchange itself works). */
export async function exchangeApiKey(apiKey: string, fetchImpl: FetchLike = globalFetch, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  const body = new URLSearchParams({ grant_type: "urn:ibm:params:oauth:grant-type:apikey", apikey: apiKey }).toString();
  const res = await fetchImpl(IBM_IAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": IBM_USER_AGENT },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readBody(res);
  if (!res.ok || !isRecord(data) || typeof data.access_token !== "string") {
    throw new IbmError(`IAM token exchange failed (${res.status}${ibmMessage(data) ? `: ${ibmMessage(data)}` : ""})`, res.status);
  }
  const ttl = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in * 1000 : 3_600_000;
  return { token: data.access_token, expiresAt: now + ttl };
}

/** The instance CRN of the key's account from the Resource Controller (the Open plan preferred). */
export async function discoverCrn(token: string, fetchImpl: FetchLike = globalFetch): Promise<string> {
  return (await discoverInstance(token, fetchImpl)).crn;
}

/** `discoverCrn` with the plan and the number of active instances. */
export async function discoverInstance(token: string, fetchImpl: FetchLike = globalFetch): Promise<InstanceChoice> {
  const res = await fetchImpl(`${IBM_RESOURCE_INSTANCES_URL}?resource_id=${QUANTUM_RESOURCE_ID}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": IBM_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readBody(res);
  if (!res.ok) {
    throw new IbmError(`listing IBM Quantum instances failed (${res.status}${ibmMessage(data) ? `: ${ibmMessage(data)}` : ""}); set IBM_QUANTUM_CRN`, res.status);
  }
  const chosen = chooseInstance(data);
  if (chosen) return chosen;

  // Nothing under the catalog id: list every resource instance the key can see
  // (a few pages at most) and keep the quantum-computing ones by their CRN, so
  // a catalog id that differs for this account cannot hide an instance. The
  // count separates "no instance" from "this key may not list resources".
  const all: unknown[] = [];
  let next: string | null = `${IBM_RESOURCE_INSTANCES_URL}?limit=100`;
  for (let page = 0; next !== null && page < 5; page++) {
    const r = await fetchImpl(next, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": IBM_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const d = await readBody(r);
    if (!r.ok) break;
    if (isRecord(d) && Array.isArray(d.resources)) all.push(...d.resources);
    next = isRecord(d) && typeof d.next_url === "string" && d.next_url.length > 0 ? new URL(d.next_url, IBM_RESOURCE_INSTANCES_URL).toString() : null;
  }
  const any = chooseInstance({ resources: all });
  if (any) return any;
  throw new IbmError(
    `the API key's account has no active IBM Quantum instance (the key can see ${all.length} resource instance${all.length === 1 ? "" : "s"} in all); create one at quantum.cloud.ibm.com or set IBM_QUANTUM_CRN`,
  );
}

/** The Qiskit Runtime REST API for one instance. */
export class IbmQuantum {
  readonly base: string;
  readonly crn: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(token: string, crn: string, fetchImpl: FetchLike = globalFetch) {
    this.token = token;
    this.crn = crn;
    this.base = apiBaseForCrn(crn);
    this.fetchImpl = fetchImpl;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
      "Service-CRN": this.crn,
      "IBM-API-Version": IBM_API_VERSION,
      "User-Agent": IBM_USER_AGENT,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await readBody(res);
    if (!res.ok) {
      const message = ibmMessage(data);
      throw new IbmError(`${method} ${path.split("?")[0]} answered ${res.status}${message ? `: ${message}` : ""}`, res.status);
    }
    return data;
  }

  backends(): Promise<unknown> {
    return this.call("GET", "/v1/backends");
  }
  configuration(name: string): Promise<unknown> {
    return this.call("GET", `/v1/backends/${encodeURIComponent(name)}/configuration`);
  }
  properties(name: string): Promise<unknown> {
    return this.call("GET", `/v1/backends/${encodeURIComponent(name)}/properties`);
  }
  instanceUsage(): Promise<unknown> {
    return this.call("GET", "/v1/instances/usage");
  }
  async submit(body: Record<string, unknown>): Promise<{ id: string; backend: string | null }> {
    const data = await this.call("POST", "/v1/jobs", body);
    if (!isRecord(data) || typeof data.id !== "string") throw new IbmError("the job was accepted without an id");
    return { id: data.id, backend: typeof data.backend === "string" ? data.backend : null };
  }
  /** The newest job carrying `tag`, if any (a submission whose answer was lost). */
  async jobByTag(tag: string): Promise<{ id: string; backend: string | null } | null> {
    const data = await this.call("GET", `/v1/jobs?tags=${encodeURIComponent(tag)}&limit=1&exclude_params=true`);
    const jobs = isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
    const job = jobs.find((j): j is Record<string, unknown> => isRecord(j) && typeof j.id === "string");
    return job ? { id: job.id as string, backend: typeof job.backend === "string" ? job.backend : null } : null;
  }
  job(id: string): Promise<unknown> {
    return this.call("GET", `/v1/jobs/${encodeURIComponent(id)}?exclude_params=true`);
  }
  results(id: string): Promise<unknown> {
    return this.call("GET", `/v1/jobs/${encodeURIComponent(id)}/results`);
  }
  metrics(id: string): Promise<unknown> {
    return this.call("GET", `/v1/jobs/${encodeURIComponent(id)}/metrics`);
  }
  async cancel(id: string): Promise<void> {
    await this.call("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`);
  }
}

/** The bearer token and the instance for a key: IBM_QUANTUM_CRN when set, else discovered. */
export async function connect(env: { IBM_QUANTUM_API_KEY?: string; IBM_QUANTUM_CRN?: string }, crn: string | null, fetchImpl: FetchLike = globalFetch): Promise<IbmQuantum> {
  const key = env.IBM_QUANTUM_API_KEY;
  if (!key) throw new IbmError("no IBM Quantum API key");
  const configured = env.IBM_QUANTUM_CRN?.trim() || null;
  if (configured && !isCrn(configured)) throw new IbmError("IBM_QUANTUM_CRN is not a quantum-computing instance CRN");
  const token = await iamToken(key, fetchImpl);
  const instance = crn ?? configured ?? (await discoverCrn(token, fetchImpl));
  return new IbmQuantum(token, instance, fetchImpl);
}

export interface Submitted {
  jobId: string;
  backend: string;
  chain: number[];
  qasm: string;
}

/**
 * Sends the day's circuit: the least busy online CZ backend with a line of
 * 10 healthy connected qubits gets it as OpenQASM 3. With `retry` a job
 * already tagged for the day (an earlier attempt whose answer was lost) is
 * adopted instead of sending a second one. Throws IbmError with the reason.
 */
export async function submitDay(client: IbmQuantum, day: number, circuit: DayCircuit, retry: boolean): Promise<Submitted> {
  if (retry) {
    // A lookup that fails is an attempt that fails: sending blind could run the day twice.
    const existing = await client.jobByTag(jobTag(day));
    if (existing) return { jobId: existing.id, backend: existing.backend ?? "unknown", chain: [], qasm: "" };
  }
  const chosen = await requireTarget(client);
  const qasm = emitQasm(circuit.native, circuit.line.mids.length, chosen.chain, edgeTest(chosen.target));
  const job = await client.submit(samplerJobBody(chosen.name, qasm, day));
  return { jobId: job.id, backend: job.backend ?? chosen.name, chain: chosen.chain, qasm };
}

/** One backend looked at by `chooseTarget`. */
export interface TargetTry {
  name: string;
  /** a CZ target with a line of 10 healthy coupled qubits */
  ok: boolean;
  /** why not, when not */
  reason: string | null;
  /** GET /properties gave calibration data the chain search used */
  calibrated: boolean;
}

/** The backend a run uses: its target, its calibration and its line of 10. */
export interface ChosenTarget {
  name: string;
  target: CzTarget;
  quality: ChainQuality | null;
  chain: number[];
}

/**
 * The Sunday's backend choice, shared by the Sunday, the check and the smoke
 * test: `names` (least busy first) are tried in order, at most
 * MAX_BACKENDS_TRIED; the first CZ target with a line of 10 healthy coupled
 * qubits (calibration from /properties when IBM gives it) is chosen. A
 * configuration IBM does not answer throws, as on a Sunday.
 */
export async function chooseTarget(client: IbmQuantum, names: string[]): Promise<{ chosen: ChosenTarget | null; tried: TargetTry[] }> {
  const tried: TargetTry[] = [];
  for (const name of names.slice(0, MAX_BACKENDS_TRIED)) {
    const target = czTargetFrom(await client.configuration(name));
    if (!target.ok) {
      tried.push({ name, ok: false, reason: target.reason, calibrated: false });
      continue;
    }
    const quality = chainQualityFrom(await client.properties(name).catch(() => null));
    const chain = findChain(target.value.coupling, QPU_QUBITS, quality);
    if (!chain) {
      tried.push({ name, ok: false, reason: `${name} has no line of ${QPU_QUBITS} healthy coupled qubits`, calibrated: quality !== null });
      continue;
    }
    tried.push({ name, ok: true, reason: null, calibrated: quality !== null });
    return { chosen: { name, target: target.value, quality, chain }, tried };
  }
  return { chosen: null, tried };
}

/** The backend list and `chooseTarget`, or IbmError with the reasons. */
async function requireTarget(client: IbmQuantum): Promise<ChosenTarget> {
  const names = rankBackends(await client.backends());
  if (names.length === 0) throw new IbmError("no IBM backend is online for this instance");
  const { chosen, tried } = await chooseTarget(client, names);
  if (!chosen) throw new IbmError(`no usable CZ backend (${tried.map((t) => t.reason).join("; ") || "none tried"})`);
  return chosen;
}

/** Whether the coupling map lists the directed pair, for `emitQasm`'s CZ direction. */
export function edgeTest(target: CzTarget): (a: number, b: number) => boolean {
  const directed = new Set(target.coupling.map(([a, b]) => `${a}>${b}`));
  return (a, b) => directed.has(`${a}>${b}`);
}

export interface SmokeSubmitted {
  jobId: string;
  backend: string;
  pair: [number, number];
  chain: number[];
  qasm: string;
}

/**
 * Sends the smoke test: the backend the Sunday would choose now, the
 * healthiest neighbouring pair on its line of 10, the Bell pair through the
 * Sunday's ISA path and emitter, the Sunday's Sampler V2 body (a 1-shot pub
 * and SMOKE_SHOTS) tagged `tag`. A submission whose answer was lost is found
 * again by its tag before the error is passed on, so it is never sent twice.
 */
export async function submitSmoke(client: IbmQuantum, tag: string): Promise<SmokeSubmitted> {
  const chosen = await requireTarget(client);
  const pair = pickPair(chosen.chain, chosen.quality);
  const qasm = bellQasm(pair, edgeTest(chosen.target));
  try {
    const job = await client.submit(smokeJobBody(chosen.name, qasm, tag));
    return { jobId: job.id, backend: job.backend ?? chosen.name, pair, chain: chosen.chain, qasm };
  } catch (error) {
    const found = await client.jobByTag(tag).catch(() => null);
    if (found) return { jobId: found.id, backend: found.backend ?? chosen.name, pair, chain: chosen.chain, qasm };
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Read-only check of the live service                                 */
/* ------------------------------------------------------------------ */

export type CheckStepName = "iam" | "instance" | "usage" | "backends" | "chain";

export interface CheckStep {
  step: CheckStepName;
  /** this step would not stop a Sunday run */
  ok: boolean;
  /** what happened, masked by publicReason (never the key, a token or the CRN) */
  detail: string;
  /** wall time; in Workers the clock moves only across I/O, so CPU-bound work reads 0 */
  ms: number;
}

/** One listed backend, with what the Sunday's choice made of it. */
export interface CheckCandidate {
  name: string;
  status: string;
  /** jobs waiting on the device (`queue_length`) */
  queue: number | null;
  qubits: number | null;
  /** online with at least 10 qubits */
  usable: boolean;
  /** 1-based place in the Sunday's order (least busy first); null when not usable */
  rank: number | null;
  /** the choice looked at its configuration (it stops at the first usable one, as on a Sunday) */
  evaluated: boolean;
  /** a line of 10 healthy coupled qubits was found; null when not evaluated */
  chain: boolean | null;
  /** why not, or `status.reason` */
  detail: string | null;
}

export interface QpuCheck {
  /** IBM_QUANTUM_API_KEY is set */
  configured: boolean;
  /** every step a Sunday needs passed: a job could be sent now */
  ready: boolean;
  steps: CheckStep[];
  chosen: { backend: string; chain: number[]; calibrated: boolean } | null;
  candidates: CheckCandidate[];
  checkedAt: number;
}

const STEP_ORDER: readonly CheckStepName[] = ["iam", "instance", "usage", "backends", "chain"];

/** GET /instances/usage in words: used, limit, left, period end (numbers only, never the instance id). */
export function describeUsage(usage: unknown): string {
  if (!isRecord(usage)) return "IBM answered without usage figures";
  const num = (key: string): number | null => {
    const v = usage[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const used = num("usage_consumed_seconds");
  const limit = num("usage_limit_seconds") ?? num("usage_allocation_seconds");
  const left = num("usage_remaining_seconds") ?? (limit !== null && used !== null ? limit - used : null);
  const parts: string[] = [];
  if (used !== null) parts.push(`${r1(used)} s used`);
  if (limit !== null) parts.push(`of ${r1(limit)} s`);
  if (left !== null) parts.push(`(${r1(Math.max(0, left))} s left)`);
  if (usage.usage_limit_reached === true) parts.push("and the limit is reached");
  const period = isRecord(usage.usage_period) ? usage.usage_period : null;
  if (period && typeof period.end_time === "string") parts.push(`in the period ending ${period.end_time.slice(0, 40)}`);
  if (parts.length > 0) return `IBM reports ${parts.join(" ")}`;
  return `IBM answered without the known usage fields (keys: ${Object.keys(usage).slice(0, 10).join(", ")})`;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The Sunday's own steps against the live service, without sending a job:
 * a fresh IAM exchange, the instance (IBM_QUANTUM_CRN or the Resource
 * Controller, Open plan first), IBM's usage figures, the backend listing in
 * the Sunday's order and the Sunday's backend and chain choice. Every
 * detail is masked with the key, the token and the CRN as literal secrets on
 * top of the patterns. Never throws.
 */
export async function runQpuCheck(
  env: { IBM_QUANTUM_API_KEY?: string; IBM_QUANTUM_CRN?: string },
  fetchImpl: FetchLike = globalFetch,
  clock: () => number = Date.now,
): Promise<QpuCheck> {
  const checkedAt = clock();
  const key = env.IBM_QUANTUM_API_KEY;
  if (!key) return { configured: false, ready: false, steps: [], chosen: null, candidates: [], checkedAt };

  const secrets: string[] = [key];
  const steps: CheckStep[] = [];
  const record = (step: CheckStepName, ok: boolean, detail: string, started: number) =>
    steps.push({ step, ok, detail: publicReason(detail, secrets), ms: Math.max(0, clock() - started) });

  let token: string | null = null;
  let crn: string | null = null;
  let client: IbmQuantum | null = null;
  let usageBlocks = false;
  let entries: BackendEntry[] = [];
  let names: string[] = [];
  let chosen: ChosenTarget | null = null;
  let tried: TargetTry[] = [];

  // iam
  let t = clock();
  try {
    const issued = await exchangeApiKey(key, fetchImpl, t);
    token = issued.token;
    secrets.push(token);
    record("iam", true, `IAM issued an access token valid for ${Math.round((issued.expiresAt - t) / 60_000)} min`, t);
  } catch (error) {
    record("iam", false, errorText(error), t);
  }

  // instance
  if (token !== null) {
    t = clock();
    try {
      const configured = env.IBM_QUANTUM_CRN?.trim() || null;
      let detail: string;
      if (configured) {
        if (!isCrn(configured)) throw new IbmError("IBM_QUANTUM_CRN is set but is not a quantum-computing instance CRN");
        crn = configured;
        detail = `the IBM_QUANTUM_CRN secret names the instance (region ${crnRegion(crn) || "unnamed"})`;
      } else {
        const found = await discoverInstance(token, fetchImpl);
        crn = found.crn;
        detail = `the Resource Controller lists ${found.active} active IBM Quantum ${found.active === 1 ? "instance" : "instances"}; using ${found.plan === "open" ? "the Open (free) plan one" : "the first one (not on the Open plan)"} in region ${crnRegion(crn) || "unnamed"}`;
      }
      secrets.push(crn);
      client = new IbmQuantum(token, crn, fetchImpl);
      record("instance", true, `${detail}; API ${client.base}`, t);
    } catch (error) {
      record("instance", false, errorText(error), t);
    }
  }

  if (client !== null) {
    // usage: unreadable figures do not stop a Sunday (it goes ahead without them); a used-up allowance does
    t = clock();
    try {
      const usage = await client.instanceUsage();
      const verdict = instanceQuotaVerdict(usage);
      usageBlocks = verdict !== null;
      record("usage", verdict === null, `${describeUsage(usage)}${verdict ? `; a Sunday would fall back: ${verdict}` : ""}`, t);
    } catch (error) {
      record("usage", false, `${errorText(error)}; not fatal: a Sunday goes ahead when the usage cannot be read`, t);
    }

    // backends
    t = clock();
    try {
      const listing = await client.backends();
      entries = listBackends(listing);
      names = rankBackends(listing);
      const order = names
        .slice(0, 6)
        .map((n) => {
          const e = entries.find((x) => x.name === n);
          return `${n} (${e?.queue ?? "?"} pending)`;
        })
        .join(", ");
      const shape = entries.length === 0 ? `; payload shape ${shapeOf(listing, 160)}` : "";
      record(
        "backends",
        names.length > 0,
        `${entries.length} listed, ${names.length} online with at least ${QPU_QUBITS} qubits${order ? `, least busy first: ${order}` : ""}${shape}`,
        t,
      );
    } catch (error) {
      record("backends", false, errorText(error), t);
    }

    // chain
    if (names.length > 0) {
      t = clock();
      try {
        const choice = await chooseTarget(client, names);
        chosen = choice.chosen;
        tried = choice.tried;
        const refused = tried.filter((x) => !x.ok).map((x) => x.reason);
        if (chosen) {
          record(
            "chain",
            true,
            `${chosen.name}: a line of ${QPU_QUBITS} coupled qubits ${chosen.quality ? "chosen by calibration" : "(no calibration data)"}: ${chosen.chain.join("-")}${refused.length ? `; passed over: ${refused.join("; ")}` : ""}`,
            t,
          );
        } else {
          record("chain", false, `no usable CZ backend among the first ${MAX_BACKENDS_TRIED}: ${refused.join("; ") || "none tried"}`, t);
        }
      } catch (error) {
        record("chain", false, errorText(error), t);
      }
    }
  }

  // every step appears once, in order; a step that could not run says why
  const ran = new Set(steps.map((s) => s.step));
  for (const step of STEP_ORDER) {
    if (ran.has(step)) continue;
    const blocker = STEP_ORDER.find((s) => ran.has(s) && !steps.find((x) => x.step === s)?.ok && s !== "usage");
    steps.push({ step, ok: false, detail: `not run: the ${blocker ?? "previous"} step failed`, ms: 0 });
  }
  steps.sort((a, b) => STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step));

  const rankOf = new Map(names.map((n, i) => [n, i + 1]));
  const candidates: CheckCandidate[] = entries.map((e) => {
    const look = tried.find((x) => x.name === e.name);
    return {
      name: e.name,
      status: e.status,
      queue: e.queue,
      qubits: e.qubits,
      usable: e.usable,
      rank: rankOf.get(e.name) ?? null,
      evaluated: look !== undefined,
      chain: look ? look.ok : null,
      detail: look?.reason ? publicReason(look.reason, secrets) : e.reason ? publicReason(e.reason, secrets) : null,
    };
  });
  candidates.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.localeCompare(b.name));

  const passed = (s: CheckStepName) => steps.find((x) => x.step === s)?.ok === true;
  return {
    configured: true,
    ready: passed("iam") && passed("instance") && passed("backends") && passed("chain") && !usageBlocks,
    steps,
    chosen: chosen ? { backend: chosen.name, chain: chosen.chain, calibrated: chosen.quality !== null } : null,
    candidates,
    checkedAt,
  };
}

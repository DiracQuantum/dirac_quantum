"use client";

/**
 * The weekly collapse on real IBM quantum hardware (SPEC 3.6): the run in
 * progress, or when the next one is; the latest run with its job id, the
 * hardware's draw and its 1000-shot distribution next to the simulator's, or
 * why it fell back to the simulator. Everything comes from `state.qpu`
 * (`GET /api/pet`); the circuit sent is served by `GET /api/pet/qpu`.
 */

import { CopyButton, Row, StatusLine } from "@/components/app/ui";
import { API_BASE } from "@/lib/api";
import type { PetQpu, PetQpuRun } from "@/lib/pet";
import {
  QPU_STATUS_LABEL,
  backendLabel,
  dayLabel,
  formatPct,
  formatSpan,
  formatUtcMinute,
  groupBits,
} from "@/components/pet/format";

interface Props {
  qpu: PetQpu;
  now: number | null;
  className?: string;
}

const qasmUrl = (day: number): string => `${API_BASE}/api/pet/qpu?day=${day}&format=qasm`;

/** "on qubits 3 4 5 …": the line on the chip, position 0 (logical qubit 0 at the start) first. */
function chainLabel(chain: number[] | null): string | null {
  if (!chain || chain.length === 0) return null;
  return `on qubits ${chain.join(" ")}`;
}

function JobId({ id }: { id: string }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
      <span className="break-all">{id}</span>
      <CopyButton value={id} label="IBM job id" />
    </span>
  );
}

function Circuit({ run }: { run: PetQpuRun }) {
  const chain = chainLabel(run.chain);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span>{run.twoQubitGates === null ? "—" : `${run.twoQubitGates} CZ`}</span>
      {chain ? <span className="text-mute">· {chain}</span> : null}
      {run.chain ? (
        <a href={qasmUrl(run.day)} target="_blank" rel="noreferrer" className="text-paper underline underline-offset-4 hover:text-signal">
          OpenQASM
        </a>
      ) : null}
    </span>
  );
}

function Partial({ run }: { run: PetQpuRun }) {
  const p = run.partial;
  if (!p) return null;
  const n = p.site.length;
  const total = run.compare ? (run.compare.totalShots ?? null) : null;
  return (
    <Row label="Partial">
      <span className="text-mute">
        {n} {n === 1 ? "measurement" : "measurements"} made on the site during the day, repeated on the chip · site{" "}
        <span className="break-all text-paper">{p.site.join("")}</span>
        {p.hardware ? (
          <>
            , first shot <span className="break-all text-paper">{p.hardware.join("")}</span>
          </>
        ) : null}
        {p.matched !== null ? (
          <>
            {" "}
            · {p.matched}
            {total !== null ? ` of ${total}` : ""} shots repeated the site&apos;s outcomes; the collapse and the
            distribution use those shots only
          </>
        ) : null}
      </span>
    </Row>
  );
}

/** Hardware frequency over simulator probability, one pair of bars per form. */
function Distribution({ run }: { run: PetQpuRun }) {
  const cmp = run.compare;
  if (!cmp) return null;
  const max = cmp.forms.reduce((m, f) => Math.max(m, f.hardware, f.simulator), 0);
  const width = (p: number) => `${max > 0 ? (p / max) * 100 : 0}%`;
  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="eyebrow">By form, hardware vs simulator</span>
        <span className="flex items-center gap-4 font-mono text-[11px] text-mute">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-1.5 w-3 rounded-full bg-paper" />
            {cmp.shots} {cmp.totalShots !== undefined && cmp.totalShots !== cmp.shots ? "matching shots" : "shots"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-1.5 w-3 rounded-full bg-paper/30" />
            simulator
          </span>
        </span>
      </div>
      <ul className="mt-4 space-y-2.5">
        {cmp.forms.map((f) => (
          <li key={f.form} className="grid grid-cols-[88px_minmax(0,1fr)_92px] items-center gap-3">
            <span className="truncate font-mono text-xs text-paper">{f.form}</span>
            <span className="flex flex-col gap-1">
              <span className="relative h-1.5 overflow-hidden rounded-full bg-paper/10">
                <span className="absolute inset-y-0 left-0 rounded-full bg-paper" style={{ width: width(f.hardware) }} />
              </span>
              <span className="relative h-1 overflow-hidden rounded-full bg-paper/5">
                <span className="absolute inset-y-0 left-0 rounded-full bg-paper/30" style={{ width: width(f.simulator) }} />
              </span>
            </span>
            <span className="tnum text-right font-mono text-[11px]">
              <span className="text-paper">{formatPct(f.hardware)}</span>
              <span className="text-mute"> · {formatPct(f.simulator)}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 font-mono text-[11px] leading-relaxed text-mute">
        Hellinger fidelity {cmp.fidelity.toFixed(2)} between the two distributions. 1 would mean the chip matched the
        simulator exactly; gate and readout noise pull it down, and so does a small number of shots.
      </p>
    </div>
  );
}

function LastRun({ run }: { run: PetQpuRun }) {
  const done = run.status === "done";
  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="eyebrow">Last run · {dayLabel(run.day)}</span>
        <span className={`chip !py-1 ${done ? "" : "text-mute"}`}>{done ? backendLabel(run.backend) : "simulator"}</span>
      </div>
      {done ? (
        <>
          <dl className="mt-3">
            <Row label="Collapse">
              <span className="tnum">{run.bits ? groupBits(run.bits) : "—"}</span>
            </Row>
            {run.jobId ? (
              <Row label="IBM job">
                <JobId id={run.jobId} />
              </Row>
            ) : null}
            <Row label="Finished">{run.finishedAt === null ? "—" : formatUtcMinute(run.finishedAt)}</Row>
            <Row label="Circuit">
              <Circuit run={run} />
            </Row>
            <Row label="QPU time">{run.usageSeconds === null ? "not reported" : `${run.usageSeconds.toFixed(run.usageSeconds < 10 ? 1 : 0)} s`}</Row>
            <Partial run={run} />
          </dl>
          <Distribution run={run} />
        </>
      ) : (
        <>
          <p className="mt-3 text-sm leading-relaxed text-mute">
            Drawn on the simulator instead{run.reason ? `: ${run.reason}` : ""}.
          </p>
          {run.jobId ? (
            <dl className="mt-3">
              <Row label="IBM job">
                <JobId id={run.jobId} />
              </Row>
            </dl>
          ) : null}
        </>
      )}
    </div>
  );
}

function Pending({ run, now }: { run: PetQpuRun; now: number | null }) {
  const left = now === null ? null : run.deadlineAt - now;
  return (
    <div className="mt-4">
      <StatusLine>
        Measuring {dayLabel(run.day)} on {backendLabel(run.backend)} · {QPU_STATUS_LABEL[run.status]}
      </StatusLine>
      <dl className="mt-4">
        {run.jobId ? (
          <Row label="IBM job">
            <JobId id={run.jobId} />
          </Row>
        ) : null}
        <Row label="Sent">{run.submittedAt === null ? "not yet" : formatUtcMinute(run.submittedAt)}</Row>
        {run.chain ? (
          <Row label="Circuit">
            <Circuit run={run} />
          </Row>
        ) : null}
        <Row label="Fallback">
          <span className="text-mute">
            the simulator draws the stored state at {formatUtcMinute(run.deadlineAt)}
            {left !== null && left > 0 ? ` (in ${formatSpan(left)})` : ""} if IBM has not finished
          </span>
        </Row>
        {run.reason ? (
          <Row label="Last error">
            <span className="text-mute">{run.reason}</span>
          </Row>
        ) : null}
      </dl>
    </div>
  );
}

export default function QpuPanel({ qpu, now, className = "" }: Props) {
  const nextIn = now === null ? null : qpu.next.at - now;
  return (
    <section id="hardware" className={`panel scroll-mt-28 p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Real quantum hardware</span>
        <span className="eyebrow hidden sm:inline">IBM Quantum · Sundays</span>
      </div>

      {qpu.pending ? (
        <Pending run={qpu.pending} now={now} />
      ) : qpu.enabled ? (
        <p className="mt-4 text-sm leading-relaxed text-mute">
          Next hardware collapse: <span className="text-paper">{dayLabel(qpu.next.day)}</span>, Sunday 00:00 UTC
          {nextIn !== null && nextIn > 0 ? <span className="tnum"> · in {formatSpan(nextIn)}</span> : null}.
        </p>
      ) : (
        <p className="mt-4 text-sm leading-relaxed text-mute">
          Hardware runs are not switched on for this server yet, so Sundays are drawn on the simulator like every other
          day.
        </p>
      )}

      {qpu.last ? <LastRun run={qpu.last} /> : null}

      <p className="mt-6 text-xs leading-relaxed text-mute">
        Every Sunday at 00:00 UTC, while the free IBM Quantum allowance lasts, the collapse runs on an IBM quantum
        computer instead of the simulator. The day&apos;s gates are rebuilt as a circuit, compiled to the chip&apos;s native
        CZ, RZ, SX and X gates on a line of ten connected qubits, and measured once for the draw; 1000 more shots give
        the distribution. Measurements made on the site during the day happen again on the chip, where they can come
        out differently; only shots that repeat the site&apos;s outcomes count, and if none do, the simulator draws
        instead. So does a day whose measurements would repeat too rarely, and a run IBM has not finished six hours
        after the collapse; the day says why.
        IBM job pages are private to the account that ran them; the job id is the public reference.
      </p>
      <p className="tnum mt-3 font-mono text-[11px] text-mute">
        QPU time this month {Math.round(qpu.monthSeconds)} s of {qpu.monthBudgetSeconds} s
      </p>
    </section>
  );
}

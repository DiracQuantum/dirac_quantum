"use client";

/**
 * Exhibit 2: Shor's algorithm factoring 15, one step at a time. The
 * modular-exponentiation row, the QFT spectrum and the gcd step are computed
 * exactly by src/lib/lab/shor.ts on a classical simulator of the registers;
 * the visitor picks the base, steps with Next or lets it auto-play.
 */

import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { Choice, Exhibit, MonoTable } from "@/components/lab/Exhibit";
import { EASE } from "@/lib/anim";
import { CANDIDATES, COUNT_QUBITS, DEFAULT_A, gcd, N, Q, runShor, WORK_QUBITS, type Candidate, type ShorRun } from "@/lib/lab/shor";

const STEPS = [
  "Pick a base",
  "Classical check",
  "Modular exponentiation",
  "Quantum Fourier transform",
  "Read the period",
  "Factor",
] as const;
/** Stepper captions short enough to fit a sixth of the row without an ellipsis; the full name shows above. */
const STEP_SHORT = ["Base", "gcd", "a^x mod N", "QFT", "Period", "Factor"] as const;
const LAST = STEPS.length - 1;
const AUTOPLAY_MS = 2600;
const TICKS = [0, Q / 4, Q / 2, (3 * Q) / 4, Q];

export default function ShorWalkthrough() {
  const [a, setA] = useState<Candidate>(DEFAULT_A);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const run = useMemo(() => runShor(a), [a]);

  // Auto-play: one step per tick, re-armed after every change so a manual
  // Next also resets the clock. Stops by itself on the last step.
  useEffect(() => {
    if (!playing || step >= LAST) return;
    const id = window.setTimeout(() => setStep((s) => Math.min(LAST, s + 1)), AUTOPLAY_MS);
    return () => window.clearTimeout(id);
  }, [playing, step]);

  const pick = (next: Candidate) => {
    setA(next);
    setStep(0);
    setPlaying(false);
  };
  const toggle = () => {
    if (step >= LAST) {
      setStep(0);
      setPlaying(true);
    } else {
      setPlaying((p) => !p);
    }
  };

  return (
    <Exhibit
      id="shor"
      index={2}
      eyebrow="Shor"
      meta={`N = ${N} · ${COUNT_QUBITS} + ${WORK_QUBITS} qubits, simulated exactly`}
      title={
        <>
          Shor,
          <br />
          step by step.
        </>
      }
      lede={
        <>
          The algorithm that breaks RSA and every elliptic curve, on the smallest number it makes sense for.
          The arithmetic is exact and classical: a laptop simulates these twelve qubits in milliseconds. A
          real machine does the same to 256-bit curves; the hard part is building it.
        </>
      }
      takeaway="Ed25519 turns one public key into one period-finding problem. Shor does not guess the key, it reads it off the peaks."
    >
      <Choice label="Base a" options={CANDIDATES} value={a} onChange={pick} format={(v) => `a = ${v}`} />

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setStep((s) => Math.max(0, s - 1));
          }}
          disabled={step === 0}
          className="pill pill-ghost !px-4 !py-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setStep((s) => Math.min(LAST, s + 1));
          }}
          disabled={step >= LAST}
          className="pill !px-4 !py-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
        <button type="button" onClick={toggle} className="pill pill-ghost !px-4 !py-2">
          {step >= LAST ? "Replay" : playing ? "Pause" : "Auto-play"}
        </button>
        <span className="eyebrow tnum ml-auto">
          step {step + 1} / {STEPS.length} · {STEPS[step]}
        </span>
      </div>

      <ol className="mt-5 grid grid-cols-3 gap-1.5 sm:grid-cols-6" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => {
                setPlaying(false);
                setStep(i);
              }}
              aria-current={i === step ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${s}`}
              className="w-full text-left"
            >
              <span
                className={`block h-0.5 rounded-full transition-colors ${i <= step ? "bg-paper" : "bg-paper/15"}`}
              />
              <span className={`mt-1.5 block truncate font-mono text-[10px] uppercase tracking-[0.12em] ${i === step ? "text-paper" : "text-mute"}`}>
                {STEP_SHORT[i]}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/* From sm up every step's text sits in the same grid cell, invisible but for the current one, so
          the box is as tall as the longest step and the sequence and spectrum below never jump while
          stepping or auto-playing. On phones the longest step is twice the shortest; there the box
          follows the text rather than leave a screen of blank space under step 1. */}
      <div className="mt-6 grid">
        {STEPS.map((s, i) => (
          <p
            key={s}
            aria-hidden
            className="invisible col-start-1 row-start-1 hidden max-w-xl text-sm leading-relaxed sm:block"
          >
            {stepText(i, run)}
          </p>
        ))}
        <StepText step={step} run={run} />
      </div>

      <div className="mt-6">
        <div className="flex items-center justify-between gap-4">
          <span className="eyebrow">
            {a}^x mod {N}
          </span>
          <span className="eyebrow tnum hidden sm:inline">x = 0 … {run.sequence.length - 1}</span>
        </div>
        <SequenceRow run={run} visible={step >= 2} />
      </div>

      <div className="mt-6">
        <div className="flex items-center justify-between gap-4">
          <span className="eyebrow">QFT of the counting register · P(y)</span>
          <span className="eyebrow tnum hidden sm:inline">Q = 2^{COUNT_QUBITS} = {Q}</span>
        </div>
        <Spectrum run={run} visible={step >= 3} />
      </div>

      <MonoTable
        className="mt-6"
        rows={[
          ["gcd(a, N)", step >= 1 ? String(run.g) : "·"],
          ["period r", step >= 4 ? `${run.r}  (peaks every Q / r = ${run.r > 0 ? Q / run.r : "—"})` : "·"],
          [
            "a^(r/2) mod N",
            step >= 5 ? (run.half === null ? "r is odd, no square root" : String(run.half)) : "·",
          ],
          [
            "gcd(a^(r/2) ∓ 1, N)",
            step >= 5 && run.factors ? `${run.factors[0]}, ${run.factors[1]}` : "·",
          ],
          ["result", step >= 5 ? resultLine(run) : "·"],
        ]}
      />
    </Exhibit>
  );
}

/** "3 × 5", smaller factor first whichever of a^(r/2) ∓ 1 produced it, so every base reads the same. */
function product(run: ShorRun): string {
  const [p, q] = run.factors ?? [0, 0];
  return `${Math.min(p, q)} × ${Math.max(p, q)}`;
}

function resultLine(run: ShorRun): string {
  switch (run.outcome) {
    case "factored":
      return `${run.n} = ${product(run)}`;
    case "trivial-root":
      return "trivial root, retry with another base";
    case "odd-period":
      return "odd period, retry with another base";
    case "lucky-gcd":
      return `${run.n} = ${product(run)} without the quantum part`;
  }
}

function stepText(step: number, run: ShorRun): string {
  const { a, n, r, half, factors } = run;
  let text: string;
  switch (step) {
    case 0:
      text = `We want the factors of N = ${n}. Pick a base a coprime with ${n}; the quantum part then finds the period of a^x mod ${n}, and the period gives the factors. Not every base works, which is part of the algorithm.`;
      break;
    case 1:
      text = `gcd(${a}, ${n}) = ${run.g}. ${
        run.g === 1
          ? `The base shares no factor with ${n}, so the period trick is needed. A base that shared a factor would have given it away in one gcd, no qubits required.`
          : `Lucky: ${run.g} divides ${n} and the factors are ${factors?.[0]} and ${factors?.[1]}. No qubits required.`
      }`;
      break;
    case 2:
      text = `${a}^x mod ${n} for x = 0, 1, 2, … The values repeat with some period r. A classical computer finds r by computing the values one after another; for a 256-bit number that sequence is longer than the universe is old.`;
      break;
    case 3:
      text = `A quantum computer holds all Q = ${Q} values of x in superposition in the counting register and computes a^x mod ${n} for all of them in one pass. The quantum Fourier transform turns the hidden repetition into peaks spaced Q / r apart.`;
      break;
    case 4: {
      if (r === 0) {
        text = `No peaks to read: gcd(${a}, ${n}) already gave the factors, so the quantum part never ran.`;
        break;
      }
      // The reduced denominator of y / Q is r only for peaks y = k·Q/r with gcd(k, r) = 1;
      // the other peaks (0 included) hand back a proper divisor of r.
      const denominator = (y: number) => Q / gcd(y, Q);
      const pins = run.peaks.filter((y) => denominator(y) === r);
      const misses = run.peaks.filter((y) => denominator(y) !== r);
      const list = (ys: number[]) => ys.map((y) => `y = ${y}`).join(", ");
      text = `Measuring the counting register returns one of the peaks, y = ${run.peaks.join(", ")}, each a multiple k · Q / r. Continued fractions on y / Q return r only when k and r share no factor: ${list(pins)} ${
        pins.length === 1 ? "gives" : "give"
      } r = ${r}; ${list(misses)} ${misses.length === 1 ? "gives" : "give"} only ${
        misses.map((y) => denominator(y)).join(" or ")
      }, a divisor of r that fails the check a^r ≡ 1 mod ${n}, so Shor runs again. The whole spectrum, peaks every Q / r = ${
        Q / r
      }, is what shows r = ${Q} / ${Q / r} = ${r} at a glance.`;
      break;
    }
    default:
      if (run.outcome === "factored") {
        text = `r = ${r} is even, so a^(r/2) = ${half} is a square root of 1 mod ${n} other than ±1. gcd(${half} − 1, ${n}) = ${factors?.[0]} and gcd(${half} + 1, ${n}) = ${factors?.[1]}. ${n} = ${product(run)}.`;
      } else if (run.outcome === "trivial-root") {
        text = `r = ${r} is even, but a^(r/2) = ${half} ≡ −1 mod ${n}: the trivial square root. gcd(${half} − 1, ${n}) = ${factors?.[0]} and gcd(${half} + 1, ${n}) = ${factors?.[1]} say nothing. Shor retries with another base; a random base fails this way with probability at most 1/2.`;
      } else if (run.outcome === "odd-period") {
        text = `r = ${r} is odd, so there is no a^(r/2) to work with. Shor retries with another base.`;
      } else {
        text = `${n} = ${product(run)}, found at the classical check. The quantum part never ran.`;
      }
  }
  return text;
}

function StepText({ step, run }: { step: number; run: ShorRun }) {
  return (
    <motion.p
      key={`${step}-${run.a}`}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
      className="col-start-1 row-start-1 max-w-xl text-sm leading-relaxed text-paper/90"
    >
      {stepText(step, run)}
    </motion.p>
  );
}

function SequenceRow({ run, visible }: { run: ShorRun; visible: boolean }) {
  return (
    <ol className="mt-3 grid grid-cols-8 gap-1.5" aria-label="Modular exponentiation">
      {run.sequence.map((v, x) => {
        const periodMark = visible && v === 1 && x > 0;
        return (
          <motion.li
            key={x}
            initial={false}
            animate={{ opacity: visible ? 1 : 0.18, y: visible ? 0 : 3 }}
            transition={{ duration: 0.35, delay: visible ? x * 0.07 : 0, ease: EASE }}
            className={`rounded-lg border px-1.5 py-1.5 text-center ${
              periodMark ? "border-signal/70" : "border-line"
            }`}
          >
            <span className="block font-mono text-[9px] text-mute">x={x}</span>
            <span className={`tnum block font-mono text-sm ${periodMark ? "text-signal" : "text-paper"}`}>{v}</span>
          </motion.li>
        );
      })}
    </ol>
  );
}

function Spectrum({ run, visible }: { run: ShorRun; visible: boolean }) {
  const max = run.spectrum.reduce((m, p) => Math.max(m, p), 0);
  const peakSet = new Set(run.peaks);
  return (
    <div className="mt-3">
      <svg
        viewBox={`-1 0 ${Q + 2} 100`}
        preserveAspectRatio="none"
        className="h-28 w-full overflow-visible"
        aria-hidden
      >
        <line x1={-1} x2={Q + 1} y1={100} y2={100} stroke="rgba(242,241,236,0.18)" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
        {/* flipped so a bar at y = 0 grows upward from the baseline by height alone; a CSS
            transition rather than a JS tween, so it runs on wall-clock time even in a throttled tab */}
        <g transform="translate(0 100) scale(1 -1)">
          {run.spectrum.map((p, y) => {
            if (p <= 0 || max <= 0) return null;
            const h = visible ? (p / max) * 94 : 0;
            return (
              <rect
                key={y}
                x={y - 0.4}
                y={0}
                width={1.8}
                height={h}
                style={{ transition: `height 0.7s cubic-bezier(0.22, 1, 0.36, 1) ${visible ? (y / Q) * 0.8 : 0}s` }}
                fill={peakSet.has(y) ? "#4d8bff" : "rgba(242,241,236,0.6)"}
              />
            );
          })}
        </g>
      </svg>
      <div className="relative mt-1 h-4 font-mono text-[10px] text-mute">
        {TICKS.map((t) => (
          <span
            key={t}
            className={`tnum absolute -translate-x-1/2 ${visible && peakSet.has(t) ? "text-signal" : ""}`}
            style={{ left: `${(t / Q) * 100}%` }}
          >
            {t}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-mute">
        {visible
          ? `Peaks at y = ${run.peaks.join(", ")}, each with probability 1 / ${run.r}. Everything in between is exactly zero because r divides Q; with a period that does not, the peaks smear and continued fractions still recover r.`
          : "The spectrum appears at step 4."}
      </p>
    </div>
  );
}

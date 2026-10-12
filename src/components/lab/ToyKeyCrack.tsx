"use client";

/**
 * Exhibit 1: brute force a toy discrete-log key in the browser. Every guess
 * derives the public key from a candidate private key (fixed-length
 * square-and-multiply in a prime group just above 2^bits) and compares. The
 * search runs in requestAnimationFrame chunks of about 8 ms so the page
 * stays responsive, and pauses when the component unmounts or the tab is
 * hidden (the browser pauses requestAnimationFrame there); time spent paused
 * is left out of the clock so the measured rate stays honest. That rate is
 * then extrapolated to Ed25519 next to the age of the universe.
 */

import { useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Choice, Exhibit, MonoTable, Stat } from "@/components/lab/Exhibit";
import { humanSeconds, humanUniverses, int, pow2, sci, UNIVERSE_AGE_YEARS, yearsAt } from "@/lib/lab/format";
import { DEFAULT_TOY_BITS, derivePublic, hexKey, MAX_TOY_BITS, TOY_BITS, toyGroup } from "@/lib/lab/toygroup";

interface Progress {
  guesses: number;
  elapsedMs: number;
  /** the public key being attacked, known once the search starts */
  publicKey: number | null;
  /** the private key, once found */
  found: number | null;
}

const IDLE: Progress = { guesses: 0, elapsedMs: 0, publicKey: null, found: null };
/** Work per animation frame before yielding; leaves half a 60 fps frame for the page to paint. */
const FRAME_BUDGET_MS = 8;
/** Guesses between clock reads. */
const BATCH = 2048;
/**
 * A gap between two frames longer than this is the browser pausing or
 * throttling requestAnimationFrame (hidden tab, background throttling), not
 * the search running; it is subtracted from the elapsed time.
 */
const PAUSE_GAP_MS = 200;
/** Curve25519 base point order is ≈ 2^252; a brute force expects to try half. */
const ED25519_KEYS_LOG2 = 252;
/** Pollard rho on a 252-bit group: about √(π·2^252 / 4) ≈ 2^126 group operations. */
const RHO_LOG2 = 126;

export default function ToyKeyCrack() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-15% 0px" });
  const [bits, setBits] = useState<number>(DEFAULT_TOY_BITS);
  const [run, setRun] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [progress, setProgress] = useState<Progress>(IDLE);

  useEffect(() => {
    if (!inView || stopped) return;
    const { p, g } = toyGroup(bits);
    const space = pow2(bits);
    // Math.random in an effect, never in render.
    const secret = Math.floor(Math.random() * space);
    const target = derivePublic(g, secret, p, bits);
    const start = performance.now();
    let x = 0;
    let raf = 0;
    let alive = true;
    /** when the previous frame handed control back; the first frame starts the clock */
    let lastFrameEnd = start;
    /** wall-clock time the browser kept us from running, excluded from elapsed */
    let paused = 0;

    const frame = () => {
      if (!alive) return;
      const frameStart = performance.now();
      const gap = frameStart - lastFrameEnd;
      if (gap > PAUSE_GAP_MS) paused += gap;
      const deadline = frameStart + FRAME_BUDGET_MS;
      let hit = false;
      do {
        const end = Math.min(x + BATCH, space);
        for (; x < end; x++) {
          if (derivePublic(g, x, p, bits) === target) {
            hit = true;
            break;
          }
        }
        if (hit || x >= space) break;
      } while (performance.now() < deadline);
      lastFrameEnd = performance.now();
      const elapsedMs = lastFrameEnd - start - paused;
      if (hit) {
        setProgress({ guesses: x + 1, elapsedMs, publicKey: target, found: x });
        return;
      }
      setProgress({ guesses: x, elapsedMs, publicKey: target, found: null });
      if (x < space) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [inView, run, bits, stopped]);

  const group = toyGroup(bits);
  const space = pow2(bits);
  const done = progress.found !== null;
  const started = progress.publicKey !== null;
  const running = started && !done && !stopped;
  const rate = progress.elapsedMs > 0 ? progress.guesses / (progress.elapsedMs / 1000) : null;
  const pct = Math.min(100, (progress.guesses / space) * 100);

  const restart = () => {
    setStopped(false);
    setProgress(IDLE);
    setRun((r) => r + 1);
  };
  const changeBits = (b: number) => {
    setStopped(false);
    setProgress(IDLE);
    setBits(b);
    setRun((r) => r + 1);
  };

  const bruteYears = rate ? yearsAt(pow2(ED25519_KEYS_LOG2 - 1), rate) : null;
  const rhoYears = rate ? yearsAt(pow2(RHO_LOG2), rate) : null;

  return (
    <div ref={ref}>
      <Exhibit
        id="crack"
        index={1}
        eyebrow="Brute force"
        meta={`p = ${int(group.p)} · g = ${group.g}`}
        title={
          <>
            Crack a key.
            <br />
            Right now.
          </>
        }
        lede={
          <>
            A private key x in a group of 2^{bits} elements, a public key g^x mod p. Your browser tries every x,
            derives the public key and compares. Same shape of problem as a wallet key, on a group small enough
            to finish before you scroll. The rate is measured, the extrapolation is arithmetic.
          </>
        }
        takeaway="Nobody brute-forces Ed25519 and nobody needs to. The numbers above say why the slow way is hopeless; exhibit 02 is the fast way."
      >
        <div className="grid gap-6 sm:grid-cols-3">
          <Stat
            label={done ? "guesses to the key" : "guesses"}
            value={int(progress.guesses)}
            sub={`of ${int(space)} · 2^${bits}`}
          />
          <Stat label="elapsed" value={`${(progress.elapsedMs / 1000).toFixed(2)} s`} sub={running ? "searching" : done ? "found" : stopped ? "stopped" : "waiting"} />
          <Stat label="keys per second" value={rate ? int(rate) : "—"} sub={`${bits} squarings per guess`} />
        </div>

        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-paper/10" aria-hidden>
          <div
            className={`h-full rounded-full transition-[width] duration-75 ${done ? "bg-signal" : "bg-paper"}`}
            style={{ width: `${done ? 100 : pct}%` }}
          />
        </div>

        {/* Two lines reserved on phones, where the found line wraps, so the controls below do not jump. */}
        <div className="tnum mt-3 min-h-[34px] font-mono text-[11px] leading-[17px] text-mute sm:min-h-[17px]" aria-live="polite">
          {progress.publicKey === null
            ? "public key: generating"
            : done
              ? `public key ${hexKey(progress.publicKey, bits)} · private key ${hexKey(progress.found ?? 0, bits)} = ${int(progress.found ?? 0)} · found in ${(progress.elapsedMs / 1000).toFixed(2)} s`
              : `public key ${hexKey(progress.publicKey, bits)} · private key unknown`}
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Choice label="Key size" options={TOY_BITS} value={bits} onChange={changeBits} format={(b) => `${b}-bit`} />
          {/* Stop stays in the row (disabled when idle) so the row never reflows when a search ends. */}
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setStopped(true)}
              disabled={!running}
              className="pill pill-ghost !px-4 !py-2 disabled:pointer-events-none disabled:opacity-40"
            >
              Stop
            </button>
            <button type="button" onClick={restart} className="pill !px-4 !py-2">
              {started ? "Run again" : "Run"}
            </button>
          </div>
        </div>

        <div className="mt-6 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span className="eyebrow">At this speed</span>
            <span className="eyebrow tnum">age of the universe · {sci(UNIVERSE_AGE_YEARS)}{"\u00a0"}years</span>
          </div>
          <MonoTable
            className="mt-3"
            rows={[
              [`this toy, expected half of 2^${bits}`, rate ? humanSeconds(pow2(bits - 1) / rate) : "—"],
              [
                <>
                  Ed25519, brute force, 2^{ED25519_KEYS_LOG2} keys
                </>,
                bruteYears === null ? "—" : `${sci(bruteYears)} years · ${humanUniverses(bruteYears)}`,
              ],
              [
                <>Ed25519, best classical (Pollard rho, 2^{RHO_LOG2} steps)</>,
                rhoYears === null ? "—" : `${sci(rhoYears)} years · ${humanUniverses(rhoYears)}`,
              ],
              ["Ed25519, Shor on a fault-tolerant quantum computer", "hours to days · see 03"],
            ]}
          />
          <p className="mt-3 text-xs leading-relaxed text-mute">
            Every extra bit doubles the work: try {MAX_TOY_BITS}-bit. Ed25519 has {ED25519_KEYS_LOG2 - MAX_TOY_BITS}{" "}
            more. A GPU farm is maybe a million times faster than this tab, which moves the exponent by six.
          </p>
        </div>
      </Exhibit>
    </div>
  );
}

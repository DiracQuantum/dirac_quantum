"use client";

/**
 * Exhibit 3: the same attacker against a curve key and against a lattice
 * key. Left, Shor's resource estimates from the literature. Right, the work
 * factor of the best known attacks on ML-KEM-768 turned into years with an
 * editable operations-per-second assumption.
 */

import { useState } from "react";
import { Choice, Exhibit, MonoTable } from "@/components/lab/Exhibit";
import { humanSeconds, humanUniverses, pow2, sci, UNIVERSE_AGE_YEARS, yearsAt } from "@/lib/lab/format";

interface Work {
  id: string;
  label: string;
  detail: string;
  bits: number;
}

const WORK: readonly Work[] = [
  { id: "cat3", label: "Category 3 floor", detail: "as hard as an AES-192 key search", bits: 192 },
  { id: "classical", label: "Best known classical", detail: "core-SVP sieve, Kyber-768 spec", bits: 182 },
  { id: "quantum", label: "Best known quantum", detail: "core-SVP with quantum sieving", bits: 165 },
  { id: "grover", label: "Grover on 192 bits", detail: "2^96 steps; k machines buy only a factor √k", bits: 96 },
];
const WORK_IDS = WORK.map((w) => w.id);

const LOG_MIN = 9;
const LOG_MAX = 18;
const LOG_DEFAULT = 12;
const TICKS: readonly { log: number; note?: string }[] = [
  { log: 9, note: "a laptop core" },
  { log: 15, note: "a top supercomputer" },
  { log: 18 },
];
/** Where the centre of a native range thumb (16 px) sits at a fraction of the track. */
const thumbAt = (fraction: number) => `calc(8px + (100% - 16px) * ${fraction})`;

/** Roetteler, Naehrig, Svore, Lauter 2017: P-256 discrete log, 2330 logical qubits, 1.26e11 Toffoli gates. */
const TOFFOLI_2017 = 1.26e11;
/** Litinski 2023: 256-bit curve private key with 5e7 Toffoli gates (with more qubits). */
const TOFFOLI_2023 = 5e7;
/** A surface-code logical cycle of about a microsecond: 1e6 logical gates per second. */
const LOGICAL_RATE = 1e6;

export default function WorkFactor() {
  const [log, setLog] = useState(LOG_DEFAULT);
  const [workId, setWorkId] = useState(WORK[0].id);
  const work = WORK.find((w) => w.id === workId) ?? WORK[0];
  const ops = 10 ** log;
  const operations = pow2(work.bits);
  const seconds = operations / ops;
  const years = yearsAt(operations, ops);
  const beyond = years > UNIVERSE_AGE_YEARS;
  // "At any speed on the slider" is a claim about the slider's maximum, not the current value.
  const beyondAtMax = yearsAt(operations, 10 ** LOG_MAX) > UNIVERSE_AGE_YEARS;

  return (
    <Exhibit
      id="work"
      index={3}
      eyebrow="Work factor"
      meta="estimates from the literature, not measurements"
      title={
        <>
          The same attack,
          <br />
          on a post-quantum key.
        </>
      }
      lede={
        <>
          Shor turns a curve key into a period-finding problem and solves it in polynomial time. A lattice key
          offers no period to find: the best known attacks, quantum included, still face an exponential wall.
          The arithmetic for that wall is below, with the speed assumption yours to change.
        </>
      }
      takeaway="A fault-tolerant quantum computer gets your Ed25519 key in hours. It gets your ML-DSA-65 passport key never, as far as anyone knows; that gap is the whole product."
    >
      {/* Stacked at every width: the exhibit column never gets wide enough for two of these tables side by side. */}
      <div className="grid gap-5">
        <div className="rounded-xl border border-line p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="eyebrow">Ed25519 · secp256k1</span>
            <span className="chip border-signal/60 text-signal">breaks</span>
          </div>
          <MonoTable
            className="mt-4"
            rows={[
              ["problem", "discrete log, 256-bit curve"],
              ["quantum algorithm", "Shor, polynomial"],
              ["logical qubits", "≈ 2,330 (Roetteler 2017)"],
              ["Toffoli gates", `${sci(TOFFOLI_2017, 1)} (2017) · ${sci(TOFFOLI_2023, 0)} (Litinski 2023)`],
              [
                `at ${sci(LOGICAL_RATE, 0)} logical gates / s`,
                `${humanSeconds(TOFFOLI_2017 / LOGICAL_RATE)} · ${humanSeconds(TOFFOLI_2023 / LOGICAL_RATE)}`,
              ],
              ["physical machine", "< 1M noisy qubits, < 1 week for RSA-2048 (Gidney 2025)"],
              ["256-bit curves", "fewer resources than RSA-2048"],
              ["exists today", "no; error-corrected demos hold tens of logical qubits"],
            ]}
          />
          <p className="mt-4 text-sm text-paper">Hours to days, once the machine exists.</p>
        </div>

        <div className="rounded-xl border border-line p-4 md:p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="eyebrow">
              <span className="whitespace-nowrap">ML-KEM-768</span> · <span className="whitespace-nowrap">ML-DSA-65</span>
            </span>
            <span className="chip">holds</span>
          </div>
          <MonoTable
            className="mt-4"
            rows={[
              ["problem", "Module-LWE, lattice in 768 dimensions"],
              ["quantum algorithm", "none with an exponential speed-up"],
              ["best known", "lattice sieving; quantum gains at most quadratic"],
              ["security category", "3, like AES-192: 2^192 operations"],
              ["core-SVP, Kyber-768 spec", "2^182 classical · 2^165 quantum"],
              ["Grover on the floor", "2^96 steps; k machines buy only a factor √k"],
            ]}
          />
          <p className="mt-4 text-sm text-paper">
            {beyondAtMax
              ? "Longer than the age of the universe, at any speed on the slider."
              : beyond
                ? "Longer than the age of the universe at this speed."
                : `About ${humanSeconds(seconds)} under this assumption.`}
          </p>
        </div>
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <div className="flex items-center justify-between gap-4">
          <span className="eyebrow">The arithmetic</span>
          <span className="eyebrow tnum hidden sm:inline">years = 2^bits / (ops per second × 3.156e7)</span>
        </div>

        <Choice<string>
          className="mt-4"
          label="Work factor"
          options={WORK_IDS}
          value={workId}
          onChange={(id) => setWorkId(id)}
          format={(id) => {
            const w = WORK.find((x) => x.id === id);
            return w ? `${w.label} · 2^${w.bits}` : id;
          }}
        />
        <p className="mt-2 font-mono text-[11px] text-mute">{work.detail}</p>

        <label className="mt-5 block">
          <span className="flex items-center justify-between gap-4">
            <span className="eyebrow">operations per second, assumed</span>
            <span className="tnum font-mono text-sm text-paper">{sci(ops, 1)}</span>
          </span>
          <input
            type="range"
            min={LOG_MIN}
            max={LOG_MAX}
            step={0.5}
            value={log}
            onChange={(e) => setLog(Number(e.target.value))}
            className="mt-2 w-full accent-paper"
            aria-valuetext={`${sci(ops, 1)} operations per second`}
          />
          {/* Each label sits under its own value on the track (1e15 is two thirds along, not halfway). */}
          <span className="relative mt-1 block h-7 font-mono text-[10px] leading-[14px] text-mute sm:h-4">
            {TICKS.map((t) => (
              <span
                key={t.log}
                className={`absolute top-0 whitespace-nowrap ${
                  t.log === LOG_MIN ? "left-0" : t.log === LOG_MAX ? "right-0 text-right" : "-translate-x-1/2 text-center"
                }`}
                style={t.log === LOG_MIN || t.log === LOG_MAX ? undefined : { left: thumbAt((t.log - LOG_MIN) / (LOG_MAX - LOG_MIN)) }}
              >
                1e{t.log}
                {t.note ? (
                  <>
                    <span className="hidden sm:inline"> · </span>
                    <span className="block sm:inline">{t.note}</span>
                  </>
                ) : null}
              </span>
            ))}
          </span>
        </label>

        <MonoTable
          className="mt-5"
          rows={[
            ["operations", `2^${work.bits} = ${sci(operations)}`],
            ["ops per second", sci(ops, 1)],
            ["seconds", sci(seconds)],
            ["years", sci(years)],
            ["age of the universe", `${sci(UNIVERSE_AGE_YEARS)} years`],
            ["that is", beyond ? `${humanUniverses(years)}` : humanSeconds(seconds)],
          ]}
        />
        <p className="mt-3 text-xs leading-relaxed text-mute">
          No quantum computer runs logical gates anywhere near 1e9 per second; the slider goes past every
          machine on paper to make the point. Grover is the one quantum gain on this side: it halves the exponent
          at best, it parallelises badly (k machines buy only a factor √k, so the exponent does not move), and the
          category 3 target already accounts for it.
        </p>
      </div>
    </Exhibit>
  );
}

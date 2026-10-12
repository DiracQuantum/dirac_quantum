"use client";

/**
 * Sparring: one exhibition bout against the house fighter of the day. No
 * passport, nothing rated. The Worker samples 100 shots with a PRNG seeded
 * by sha256(the pet's last collapsed bits + the bout id) and returns the
 * exact table beside them.
 */

import { useState } from "react";
import { ErrorNote, describeError } from "@/components/app/ui";
import { formatP3, formatPct } from "@/components/arena/format";
import { circuitLabel, type Circuit, type HouseFighter, type SparResult } from "@/lib/arena";
import { sparWithHouse } from "@/lib/arenaApi";

interface Props {
  circuit: Circuit;
  house: HouseFighter | null;
  /** the ladder (which names the house fighter) could not be read */
  houseError?: boolean;
  result: SparResult | null;
  onResult(result: SparResult): void;
  className?: string;
}

export default function SparPanel({ circuit, house, houseError = false, result, onResult, className = "" }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spar = async () => {
    setBusy(true);
    setError(null);
    try {
      onResult(await sparWithHouse(circuit));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Spar</span>
        <span className="eyebrow hidden sm:inline">no passport · not rated</span>
      </div>

      <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
        One exhibition against the house fighter of the day. The Worker samples 100 shots from the exact distribution, seeded by
        the pet&apos;s last collapse{house?.day ? ` (day ${house.day})` : ""}, so anyone can replay the same bout.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void spar()} disabled={busy || house === null} className="pill disabled:pointer-events-none disabled:opacity-50">
          {busy ? "Sampling…" : "Spar with the house"}
        </button>
        <span className="tnum font-mono text-[11px] text-mute">
          {house ? `house · ${circuitLabel(house.circuit)}` : houseError ? "house fighter unavailable" : "house fighter loading"}
        </span>
      </div>

      {error ? <ErrorNote className="mt-4">{error}</ErrorNote> : null}

      {result ? (
        <dl className="mt-5 grid gap-x-6 gap-y-2 border-t border-line pt-4 font-mono text-[11px] sm:grid-cols-2">
          <Line label="shots" value={`you ${result.shots.a} · house ${result.shots.b}`} />
          <Line label="exact pA" value={formatP3(result.pA)} />
          <Line label="|00⟩ |11⟩" value={`${formatPct(result.probs.p00)} · ${formatPct(result.probs.p11)}`} />
          <Line label="|01⟩ |10⟩" value={`${formatPct(result.probs.p01)} · ${formatPct(result.probs.p10)}`} />
          <Line label="bout" value={result.boutId} />
          <Line label="seed" value={result.seed.slice(0, 16)} />
        </dl>
      ) : null}
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-mute">{label}</dt>
      <dd className="tnum truncate text-paper">{value}</dd>
    </div>
  );
}

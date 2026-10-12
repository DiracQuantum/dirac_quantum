"use client";

/**
 * The exact distribution of your circuit against a chosen opponent, computed
 * in the browser with the same simulator the Worker runs: p00 p01 p10 p11,
 * pA, and the verdict the ranked rule would give. Opponents: the house
 * fighter of the day, a stored favourite, or an empty circuit.
 */

import {
  canonicalCircuit,
  circuitLabel,
  runBout,
  verdictOf,
  type Circuit,
  type HouseFighter,
  type Probabilities,
} from "@/lib/arena";
import { formatP3, formatPct } from "@/components/arena/format";

export type OpponentKind = "house" | "favourite" | "empty";

interface Props {
  circuit: Circuit;
  house: HouseFighter | null;
  /** the ladder (which names the house fighter) could not be read */
  houseError?: boolean;
  favourite: Circuit | null;
  opponent: OpponentKind;
  onOpponent(kind: OpponentKind): void;
  onSaveFavourite(): void;
  onClearFavourite(): void;
  className?: string;
}

const EMPTY: Circuit = { v: 1, pre: [], post: [] };

/** The opponent circuit a readout mode resolves to (falls back to the empty circuit). */
export function opponentCircuit(kind: OpponentKind, house: HouseFighter | null, favourite: Circuit | null): Circuit {
  if (kind === "house" && house) return house.circuit;
  if (kind === "favourite" && favourite) return favourite;
  return EMPTY;
}

const ROWS: { key: keyof Omit<Probabilities, "pA">; label: string; side: "A" | "B" }[] = [
  { key: "p00", label: "|00⟩", side: "A" },
  { key: "p01", label: "|01⟩", side: "B" },
  { key: "p10", label: "|10⟩", side: "B" },
  { key: "p11", label: "|11⟩", side: "A" },
];

export default function ProbabilityReadout({
  circuit,
  house,
  houseError = false,
  favourite,
  opponent,
  onOpponent,
  onSaveFavourite,
  onClearFavourite,
  className = "",
}: Props) {
  const against = opponentCircuit(opponent, house, favourite);
  const p = runBout(circuit, against);
  const verdict = verdictOf(p.pA);
  const maxP = Math.max(p.p00, p.p01, p.p10, p.p11, 1e-12);
  const saved = favourite !== null && canonicalCircuit(favourite) === canonicalCircuit(circuit);

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Exact odds</span>
        <span className="eyebrow hidden sm:inline">computed here, no sampling</span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {/* its own line on phones, so the three chips stay on one row */}
        <span className="basis-full font-mono text-[11px] text-mute sm:basis-auto">against</span>
        <OpponentChip active={opponent === "house"} onClick={() => onOpponent("house")} disabled={house === null}>
          house
          {house?.day ? <span className="hidden sm:inline"> · day {house.day}</span> : null}
        </OpponentChip>
        <OpponentChip active={opponent === "favourite"} onClick={() => onOpponent("favourite")} disabled={favourite === null}>
          favourite
        </OpponentChip>
        <OpponentChip active={opponent === "empty"} onClick={() => onOpponent("empty")}>
          identity
        </OpponentChip>
      </div>
      <p className="tnum mt-2 font-mono text-[11px] text-mute">
        {opponent === "house" && !house
          ? houseError
            ? "house fighter unavailable · B = identity"
            : "house fighter loading"
          : `B = ${circuitLabel(against)}`}
      </p>

      {/* Two rows, so the eyebrows share a line and the values share a baseline. */}
      <div className="mt-6 grid grid-cols-[auto_auto] items-baseline justify-between gap-x-6 border-t border-line pt-5">
        <div className="eyebrow">pA = p00 + p11</div>
        <div className="eyebrow text-right">ranked verdict</div>
        <div className="tnum mt-1 font-mono text-4xl text-paper">{formatP3(p.pA)}</div>
        <div className="mt-1 text-right font-serif text-2xl italic text-paper">
          {verdict === "a" ? "you win" : verdict === "b" ? "you lose" : "draw"}
        </div>
      </div>

      <ul className="mt-5 space-y-2">
        {ROWS.map((r) => (
          <li key={r.key} className="grid grid-cols-[52px_30px_minmax(0,1fr)_64px] items-center gap-3">
            <span className="tnum font-mono text-xs text-paper">{r.label}</span>
            <span className={`font-mono text-[10px] uppercase tracking-[0.14em] ${r.side === "A" ? "text-paper" : "text-mute"}`}>
              {r.side}
            </span>
            <span className="relative h-1.5 overflow-hidden rounded-full bg-paper/10">
              <span
                className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${r.side === "A" ? "bg-paper" : "bg-paper/40"}`}
                style={{ width: `${(p[r.key] / maxP) * 100}%` }}
              />
            </span>
            <span className="tnum text-right font-mono text-[11px] text-paper">{formatPct(p[r.key])}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4">
        <button
          type="button"
          onClick={onSaveFavourite}
          disabled={saved}
          className="pill pill-ghost !px-4 !py-2 disabled:pointer-events-none disabled:opacity-60"
        >
          {saved ? "Saved as favourite" : "Save this circuit as favourite"}
        </button>
        {favourite ? (
          <button type="button" onClick={onClearFavourite} className="font-mono text-[11px] text-mute transition-colors hover:text-paper">
            forget favourite
          </button>
        ) : null}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-mute">
        You play A on q0, so |00⟩ and |11⟩ are yours. Ranked bouts compare pA with 0.5 exactly; a difference under 1e-9 is a draw.
      </p>
    </section>
  );
}

function OpponentChip({
  active,
  disabled = false,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`chip transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${active ? "border-paper/60 bg-paper/5 text-paper" : "hover:border-paper/40"}`}
    >
      {children}
    </button>
  );
}

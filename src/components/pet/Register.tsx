"use client";

/**
 * The register: the ten qubits with their P(1). `Register` is the full view
 * (one bar per qubit with the protected markers), `QubitDots` the compact row
 * for the landing card. Clicking a qubit selects it; clicking again clears.
 */

import type { PetQubit } from "@/lib/pet";
import { formatP, isProtected, protectedMinutes } from "@/components/pet/format";

interface RegisterProps {
  qubits: PetQubit[];
  selected: number | null;
  /** the CNOT target of the selected qubit, marked in the list */
  target: number | null;
  onSelect(q: number | null): void;
  now: number | null;
  className?: string;
}

export default function Register({ qubits, selected, target, onSelect, now, className = "" }: RegisterProps) {
  return (
    <div className={`space-y-1 ${className}`} role="listbox" aria-label="Qubits">
      {qubits.map((qb) => {
        const isSelected = selected === qb.i;
        const isTarget = target === qb.i && !isSelected;
        const frozen = isProtected(qb, now);
        // The status column is 64px on a phone, so it carries the short form there.
        const minutes = frozen ? `${protectedMinutes(qb, now)} min` : "";
        const status = frozen
          ? { short: minutes, long: `protected · ${minutes}` }
          : isTarget
            ? { short: "target", long: "cnot target" }
            : isSelected
              ? { short: "selected", long: "selected" }
              : null;
        return (
          <button
            key={qb.i}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect(isSelected ? null : qb.i)}
            title={`qubit ${qb.i}: P(1) ${formatP(qb.p1)}${frozen ? `, protected for ${protectedMinutes(qb, now)} min` : ""}`}
            className={`grid w-full grid-cols-[24px_minmax(0,1fr)_34px_64px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors sm:grid-cols-[30px_minmax(0,1fr)_40px_140px] sm:gap-3 ${
              isSelected ? "border-paper/60 bg-paper/5" : "border-transparent hover:border-line"
            }`}
          >
            <span className={`font-mono text-[11px] ${isSelected ? "text-paper" : "text-mute"}`}>q{qb.i}</span>
            <span className="relative h-1.5 overflow-hidden rounded-full bg-paper/10">
              <span
                className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${
                  frozen ? "bg-signal" : "bg-paper"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, qb.p1 * 100))}%` }}
              />
            </span>
            <span className="tnum text-right font-mono text-[11px] text-paper">{formatP(qb.p1)}</span>
            <span
              className={`truncate font-mono text-[10px] uppercase tracking-[0.14em] ${frozen ? "text-signal" : "text-mute"}`}
            >
              {status ? (
                <>
                  <span className="sm:hidden">{status.short}</span>
                  <span className="hidden sm:inline">{status.long}</span>
                </>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface DotsProps {
  qubits: PetQubit[];
  selected: number | null;
  onSelect(q: number | null): void;
  now: number | null;
  className?: string;
}

/** Ten dots whose fill is P(1); a ring marks the selection, a blue outline a protected qubit. */
export function QubitDots({ qubits, selected, onSelect, now, className = "" }: DotsProps) {
  return (
    <div className={`flex items-center gap-1.5 ${className}`} role="listbox" aria-label="Qubits">
      {qubits.map((qb) => {
        const isSelected = selected === qb.i;
        const frozen = isProtected(qb, now);
        return (
          <button
            key={qb.i}
            type="button"
            role="option"
            aria-selected={isSelected}
            onClick={() => onSelect(isSelected ? null : qb.i)}
            title={`qubit ${qb.i}: P(1) ${formatP(qb.p1)}${frozen ? ", protected" : ""}`}
            className={`relative h-5 w-5 rounded-full border transition-transform hover:scale-110 ${
              frozen ? "border-signal" : "border-paper/50"
            } ${isSelected ? "ring-2 ring-paper ring-offset-2 ring-offset-ink-2" : ""}`}
            style={{ background: `rgba(242, 241, 236, ${Math.min(1, Math.max(0, qb.p1)).toFixed(3)})` }}
          >
            <span className="sr-only">qubit {qb.i}</span>
          </button>
        );
      })}
    </div>
  );
}

"use client";

/**
 * One qubit's circuit: a gate palette (H, X, Z, RY with an angle slider in
 * 5-degree steps), two slots (up to 3 pre gates, up to 2 post gates), click
 * to append, click a placed gate to remove it, and the canonical JSON that
 * the commit hashes.
 */

import { useState } from "react";
import { CopyButton } from "@/components/app/ui";
import {
  ANGLE_MAX,
  ANGLE_MIN,
  ANGLE_STEP,
  GATE_NAMES,
  MAX_POST,
  MAX_PRE,
  canonicalCircuit,
  gateLabel,
  type ArenaGate,
  type Circuit,
  type GateName,
} from "@/lib/arena";

interface Props {
  circuit: Circuit;
  onChange(next: Circuit): void;
  disabled?: boolean;
  className?: string;
}

const GATE_TITLE: Record<GateName, string> = {
  H: "Hadamard: superposition",
  X: "Pauli X: flip",
  Z: "Pauli Z: phase flip",
  RY: "Rotation about Y by the chosen angle",
};

type Slot = "pre" | "post";

export default function CircuitBuilder({ circuit, onChange, disabled = false, className = "" }: Props) {
  const [slot, setSlot] = useState<Slot>("pre");
  const [angle, setAngle] = useState(45);

  const max = slot === "pre" ? MAX_PRE : MAX_POST;
  const full = circuit[slot].length >= max;

  const append = (g: GateName) => {
    if (full || disabled) return;
    const gate: ArenaGate = g === "RY" ? { g, t: angle } : { g };
    const next: Circuit = { v: 1, pre: circuit.pre.slice(), post: circuit.post.slice() };
    next[slot] = [...next[slot], gate];
    onChange(next);
  };

  const remove = (s: Slot, index: number) => {
    if (disabled) return;
    const next: Circuit = { v: 1, pre: circuit.pre.slice(), post: circuit.post.slice() };
    next[s] = next[s].filter((_, i) => i !== index);
    onChange(next);
  };

  const clear = () => {
    if (!disabled) onChange({ v: 1, pre: [], post: [] });
  };

  const canonical = canonicalCircuit(circuit);

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Circuit builder</span>
        {/* the slots below repeat these counts, so phones drop the line rather than wrap it */}
        <span className="eyebrow tnum hidden text-paper sm:inline">
          pre {circuit.pre.length}/{MAX_PRE} · post {circuit.post.length}/{MAX_POST}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <SlotView
          name="pre"
          hint="before the entangling layer"
          gates={circuit.pre}
          max={MAX_PRE}
          active={slot === "pre"}
          onPick={() => setSlot("pre")}
          onRemove={(i) => remove("pre", i)}
          disabled={disabled}
        />
        <SlotView
          name="post"
          hint="after the layer, before measurement"
          gates={circuit.post}
          max={MAX_POST}
          active={slot === "post"}
          onPick={() => setSlot("post")}
          onRemove={(i) => remove("post", i)}
          disabled={disabled}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {GATE_NAMES.map((g) => (
          <button
            key={g}
            type="button"
            title={GATE_TITLE[g]}
            disabled={disabled || full}
            onClick={() => append(g)}
            className="chip transition-all hover:-translate-y-0.5 hover:border-paper/50 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-line"
          >
            {g === "RY" ? `RY ${angle}` : g}
          </button>
        ))}
        <span className="tnum ml-auto font-mono text-[11px] text-mute">
          {full ? `${slot} slot full` : `adds to ${slot}`}
        </span>
      </div>

      <div className="mt-4">
        <label htmlFor="arena-angle" className="flex items-center justify-between font-mono text-[11px] text-mute">
          <span>RY angle · {ANGLE_STEP}-degree steps</span>
          <span className="tnum text-paper">{angle} deg</span>
        </label>
        <input
          id="arena-angle"
          type="range"
          min={ANGLE_MIN}
          max={ANGLE_MAX}
          step={ANGLE_STEP}
          value={angle}
          disabled={disabled}
          onChange={(e) => setAngle(Number(e.target.value))}
          className="mt-2 w-full accent-[var(--color-paper)]"
        />
        <div className="flex justify-between font-mono text-[10px] text-mute">
          <span>{ANGLE_MIN}</span>
          <span>0</span>
          <span>{ANGLE_MAX}</span>
        </div>
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-3">
          <span className="eyebrow">Canonical JSON</span>
          <div className="flex items-center gap-2">
            <CopyButton value={canonical} label="canonical circuit" />
            <button
              type="button"
              onClick={clear}
              disabled={disabled || (circuit.pre.length === 0 && circuit.post.length === 0)}
              className="inline-flex items-center rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-mute transition-colors hover:text-paper disabled:cursor-not-allowed disabled:opacity-40"
            >
              clear
            </button>
          </div>
        </div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-paper">
          {canonical}
        </pre>
        <p className="mt-2 text-xs leading-relaxed text-mute">
          This exact string, a colon and a 16-byte salt are what the ranked commit hashes. Same gates, same order, same bytes.
        </p>
      </div>
    </section>
  );
}

interface SlotProps {
  name: Slot;
  hint: string;
  gates: ArenaGate[];
  max: number;
  active: boolean;
  onPick(): void;
  onRemove(index: number): void;
  disabled: boolean;
}

function SlotView({ name, hint, gates, max, active, onPick, onRemove, disabled }: SlotProps) {
  return (
    <div
      role="radio"
      aria-checked={active}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
      className={`cursor-pointer rounded-xl border p-3.5 transition-colors ${active ? "border-paper/60 bg-paper/5" : "border-line hover:border-paper/30"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`font-mono text-[11px] uppercase tracking-[0.14em] ${active ? "text-paper" : "text-mute"}`}>{name}</span>
        <span className="tnum font-mono text-[10px] text-mute">
          {gates.length}/{max}
        </span>
      </div>
      <div className="mt-2.5 flex min-h-[30px] flex-wrap gap-1.5">
        {gates.length === 0 ? (
          <span className="font-mono text-[11px] text-mute/70">identity</span>
        ) : (
          gates.map((g, i) => (
            <button
              key={`${i}-${gateLabel(g)}`}
              type="button"
              title="remove"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(i);
              }}
              className="chip !py-0.5 transition-colors hover:border-paper/50 hover:line-through disabled:cursor-not-allowed"
            >
              {gateLabel(g)}
            </button>
          ))
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-mute">{hint}</p>
    </div>
  );
}

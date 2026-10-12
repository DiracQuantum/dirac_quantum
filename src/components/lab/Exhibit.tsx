"use client";

/**
 * The frame every exhibit sits in (eyebrow, display heading, lede, the
 * interactive, the one-line takeaway) and the table of contents that links
 * to them. Small atoms the exhibits share live here too.
 */

import type { ReactNode } from "react";

export interface ExhibitMeta {
  id: string;
  index: number;
  eyebrow: string;
  title: string;
}

export const EXHIBITS: readonly ExhibitMeta[] = [
  { id: "crack", index: 1, eyebrow: "Brute force", title: "Crack a key. Right now." },
  { id: "shor", index: 2, eyebrow: "Shor", title: "Shor, step by step." },
  { id: "work", index: 3, eyebrow: "Work factor", title: "The same attack, on a post-quantum key." },
  { id: "lattice", index: 4, eyebrow: "Lattice", title: "Lattice, closest vector." },
  { id: "harvest", index: 5, eyebrow: "Harvest now", title: "Harvest now, decrypt later." },
];

const pad2 = (n: number) => String(n).padStart(2, "0");

interface ExhibitProps {
  id: string;
  index: number;
  eyebrow: string;
  meta?: string;
  title: ReactNode;
  lede: ReactNode;
  takeaway: ReactNode;
  children: ReactNode;
}

export function Exhibit({ id, index, eyebrow, meta, title, lede, takeaway, children }: ExhibitProps) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="panel scroll-mt-28 p-6 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow tnum shrink-0 whitespace-nowrap">
          {pad2(index)} / {eyebrow}
        </span>
        {meta ? <span className="eyebrow hidden min-w-0 text-right sm:inline">{meta}</span> : null}
      </div>
      <h2 id={`${id}-title`} className="display mt-5 text-3xl md:text-[2.4rem]">
        {title}
      </h2>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-mute">{lede}</p>
      <div className="mt-6">{children}</div>
      <div className="mt-6 border-t border-line pt-4">
        <span className="eyebrow">For your wallet</span>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-paper/80">{takeaway}</p>
      </div>
    </section>
  );
}

/** Table of contents with anchors to the five exhibits. */
export function LabContents({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Exhibits" className={className}>
      <span className="eyebrow">Five exhibits</span>
      <ol className="mt-3 divide-y divide-line border-y border-line">
        {EXHIBITS.map((e) => (
          <li key={e.id}>
            <a
              href={`#${e.id}`}
              className="group grid grid-cols-[32px_minmax(0,1fr)] items-baseline gap-3 py-3"
            >
              <span className="tnum font-mono text-[11px] text-mute">{pad2(e.index)}</span>
              <span className="text-sm text-paper/80 transition-colors group-hover:text-paper">{e.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Label over a large mono value. */
export function Stat({
  label,
  value,
  sub,
  className = "",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="eyebrow">{label}</div>
      <div className="tnum mt-1 font-mono text-xl text-paper md:text-2xl">{value}</div>
      {sub ? <div className="tnum mt-0.5 font-mono text-[11px] text-mute">{sub}</div> : null}
    </div>
  );
}

/**
 * Two-column mono table: label on the left, value on the right. From sm up
 * the label column never gets narrower than its longest word (it wraps, it
 * no longer runs under the value); on phones a row that does not fit side by
 * side puts the value on its own line, right-aligned.
 */
export function MonoTable({ rows, className = "" }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={`font-mono text-[12px] ${className}`}>
      {rows.map(([k, v], i) => (
        <div
          key={i}
          className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-line py-2 first:border-t-0 sm:grid sm:grid-cols-[minmax(min-content,1fr)_auto]"
        >
          <dt className="text-mute">{k}</dt>
          <dd className="tnum ml-auto min-w-0 text-right text-paper">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A row of chips where exactly one is pressed. */
export function Choice<T extends string | number>({
  label,
  options,
  value,
  onChange,
  format = (v) => String(v),
  disabled = false,
  className = "",
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange(v: T): void;
  format?(v: T): ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`flex flex-wrap gap-2 ${className}`}>
      {options.map((o) => {
        const on = o === value;
        return (
          <button
            key={String(o)}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(o)}
            className={`chip transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              on ? "border-paper/70 bg-paper/10" : "hover:border-paper/40"
            }`}
          >
            {format(o)}
          </button>
        );
      })}
    </div>
  );
}

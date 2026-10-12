"use client";

/**
 * Today's body: the form's 3D model when it has one, otherwise the form's
 * depth-animated picture, tinted by the palette; then the four traits and the
 * countdown to the collapse. The form, character, ability and palette are
 * what the collapse decided. While yesterday's collapse is still measuring on
 * IBM hardware (`state.qpu.pending`), the body is the one before it and a
 * chip names the backend.
 */

import Creature from "@/components/pet/Creature";
import { useState } from "react";
import { Row } from "@/components/app/ui";
import PetShareCard from "@/components/pet/PetShareCard";
import { paletteOf, type PetState } from "@/lib/pet";
import { backendLabel, dayLabel, formatCountdown } from "@/components/pet/format";

 interface Props {
  state: PetState | null;
  now: number | null;
  className?: string;
}

/**
 * The ?model= value as a path under /models on this origin, or null. The
 * value is resolved as a URL and its origin compared, not prefix-checked: the
 * URL parser reads "/\host/x.glb" as "//host/x.glb", which a startsWith("/")
 * && !startsWith("//") check lets through to a third-party host.
 */
function sameOriginModel(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, window.location.origin);
    return u.origin === window.location.origin && u.pathname.startsWith("/models/") && u.pathname.endsWith(".glb")
      ? u.pathname
      : null;
  } catch {
    return null;
  }
}

export default function PetBody({ state, now, className = "" }: Props) {
  // ?catdebug=1 tints the animated regions of the picture while tuning their positions
  const [catDebug] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("catdebug"),
  );
  // ?form=<name> previews any form's picture and rig (tuning aid)
  const [forcedForm] = useState(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("form") : null,
  );
  // ?model=<path> previews any GLB under public/models in place of the form's model (this origin only)
  const [forcedModel] = useState(() =>
    typeof window !== "undefined" ? sameOriginModel(new URLSearchParams(window.location.search).get("model")) : null,
  );
  const palette = paletteOf(state?.palette ?? "");
  const form = forcedForm ?? state?.form ?? "cat";
  const left = state && now !== null ? formatCountdown(state.collapseAt - now) : "--:--:--";
  // yesterday's collapse still on the chip: today's body is the one before it
  const measuring = state?.qpu?.pending && state.qpu.pending.day === state.day - 1 ? state.qpu.pending : null;

  return (
    <div className={className}>
      <div className="relative mx-auto h-72 w-full max-w-[420px] md:h-96">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full opacity-60 blur-3xl transition-colors duration-1000"
          style={{ background: `radial-gradient(circle at 50% 55%, ${palette.glow}55, transparent 62%)` }}
        />
        <Creature form={form} debug={catDebug} tint={palette.accent} model={forcedModel} />
        <span className="eyebrow pointer-events-none absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px]">
          drag to rotate
        </span>
      </div>

      <div className="mt-12 flex items-end justify-between gap-6 border-t border-line pt-4">
        <div>
          <div className="eyebrow">collapse in</div>
          <div className="tnum mt-1 font-mono text-3xl text-paper">{left}</div>
        </div>
        <div className="text-right">
          <div className="eyebrow">{state ? dayLabel(state.day) : "day —"}</div>
          <div className="mt-1 font-serif text-2xl italic text-paper">{state ? state.form : "…"}</div>
          {measuring ? (
            <span className="chip mt-2 !py-1" title={measuring.jobId ? `IBM job ${measuring.jobId}` : undefined}>
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
              measuring on {backendLabel(measuring.backend)}
            </span>
          ) : null}
        </div>
      </div>

      {state ? <PetShareCard state={state} className="mt-8" /> : null}

      <dl className="mt-6">
        <Row label="Form">{state?.form ?? "—"}</Row>
        <Row label="Character">{state?.character ?? "—"}</Row>
        <Row label="Ability">{state?.ability ?? "—"}</Row>
        <Row label="Palette">
          {state ? (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className="inline-block h-3 w-3 rounded-full" style={{ background: palette.glow }} />
              {state.palette}
            </span>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Gates today">{state ? String(state.actionsToday) : "—"}</Row>
      </dl>

      <p className="mt-6 max-w-md text-xs leading-relaxed text-mute">
        {measuring
          ? `The collapse of ${dayLabel(measuring.day)} is being measured on ${backendLabel(measuring.backend)}, a real quantum computer. Until the result comes back, the body stays the one before; it changes when the job finishes, or when the simulator draws instead six hours after the collapse.`
          : state && state.day === 1
            ? "Day 1 has no previous collapse, so the body is the default: a curious cat with superposition, in ice."
            : "Today's body is yesterday's measurement: the form picks the creature, the palette tints it, the character and ability are the rest of the collapsed bits."}
      </p>
    </div>
  );
}

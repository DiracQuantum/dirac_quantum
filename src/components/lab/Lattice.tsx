"use client";

/**
 * Exhibit 4: closest vector in a 2D lattice. The same points through two
 * bases: short and nearly orthogonal (the private key) or long and skewed
 * (the public key). Babai's rounding in the active basis is drawn with its
 * error; the target can be dragged or randomised.
 */

import { motion } from "framer-motion";
import { useMemo, useRef, useState } from "react";
import { Choice, Exhibit, MonoTable } from "@/components/lab/Exhibit";
import { EASE } from "@/lib/anim";
import {
  add,
  babaiRound,
  BASES,
  closestPoint,
  fmtVec,
  latticePoints,
  length,
  PRIVATE_BASIS,
  PUBLIC_BASIS,
  VIEW_H,
  VIEW_W,
  type BasisKind,
  type Vec,
} from "@/lib/lab/lattice";

const KINDS: readonly BasisKind[] = ["private", "public"];
const KIND_LABEL: Record<BasisKind, string> = {
  private: "private basis · short",
  public: "public basis · long",
};
const SPRING = { duration: 0.55, ease: EASE };
const DEFAULT_TARGET: Vec = [13.5, -6.2];
/** "+ 2.10" or "− 2.10": the second term of a combination, never "+ -2.10". */
const signed = (v: string) => (v.startsWith("-") ? `− ${v.slice(1)}` : `+ ${v}`);

export default function Lattice() {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const [kind, setKind] = useState<BasisKind>("private");
  const [target, setTarget] = useState<Vec>(DEFAULT_TARGET);
  const points = useMemo(() => latticePoints(), []);

  const basis = BASES[kind];
  const priv = babaiRound(PRIVATE_BASIS, target);
  const pub = babaiRound(PUBLIC_BASIS, target);
  const best = closestPoint(target);
  const active = kind === "private" ? priv : pub;
  const activeIsBest = Math.abs(active.error - best.distance) < 1e-9;

  const toLattice = (e: React.PointerEvent<SVGSVGElement>): Vec | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((e.clientX - rect.left) / rect.width) * 2 * VIEW_W - VIEW_W;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 * VIEW_H - VIEW_H);
    return [Math.max(-VIEW_W, Math.min(VIEW_W, x)), Math.max(-VIEW_H, Math.min(VIEW_H, y))];
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toLattice(e);
    if (p) setTarget(p);
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    const p = toLattice(e);
    if (p) setTarget(p);
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const randomise = () => {
    // Math.random in a handler, never in render.
    setTarget([(Math.random() - 0.5) * 2 * (VIEW_W - 4), (Math.random() - 0.5) * 2 * (VIEW_H - 4)]);
  };

  const b1 = basis[0];
  const b2 = basis[1];
  const corner = add(b1, b2);

  return (
    <Exhibit
      id="lattice"
      index={4}
      eyebrow="Lattice"
      meta="2 dimensions here · 768 in ML-KEM-768"
      title={
        <>
          Lattice,
          <br />
          closest vector.
        </>
      }
      lede={
        <>
          Every dot is a point of one lattice. Drop a target anywhere and ask for the nearest dot. With the short,
          nearly orthogonal basis, rounding the coordinates lands on it in one step. With the long, skewed basis
          that describes the very same dots, the same rounding lands far away.
        </>
      }
      takeaway="ML-KEM hides a short basis in a lattice of 768 dimensions and publishes a long one. Decrypting is rounding with the short basis; attacking is rounding without it, and in hundreds of dimensions nobody, quantum or not, knows how."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Choice<BasisKind> label="Basis" options={KINDS} value={kind} onChange={(k) => setKind(k)} format={(k) => KIND_LABEL[k]} />
        <button type="button" onClick={randomise} className="pill pill-ghost ml-auto !px-4 !py-2">
          Random target
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`${-VIEW_W} ${-VIEW_H} ${2 * VIEW_W} ${2 * VIEW_H}`}
        className="mt-4 aspect-[3/2] w-full cursor-crosshair touch-none select-none overflow-hidden rounded-xl border border-line bg-ink"
        role="img"
        aria-label={`Lattice with the target at ${fmtVec(target)}; rounding in the ${kind} basis lands ${active.error.toFixed(1)} units away`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <defs>
          <marker id="lab-arrow" viewBox="0 0 6 6" refX={5} refY={3} markerWidth={5} markerHeight={5} orient="auto-start-reverse">
            <path d="M0,0 L6,3 L0,6 z" fill="#f2f1ec" />
          </marker>
        </defs>
        {/* y grows upward in lattice coordinates */}
        <g transform="scale(1,-1)">
          {points.map((p) => (
            <circle key={`${p[0]},${p[1]}`} cx={p[0]} cy={p[1]} r={0.55} fill="rgba(242,241,236,0.3)" />
          ))}

          <motion.polygon
            initial={false}
            animate={{ points: `0,0 ${b1[0]},${b1[1]} ${corner[0]},${corner[1]} ${b2[0]},${b2[1]}` }}
            transition={SPRING}
            fill="rgba(242,241,236,0.06)"
            stroke="rgba(242,241,236,0.25)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {[b1, b2].map((b, i) => (
            <motion.line
              key={i}
              initial={false}
              animate={{ x2: b[0], y2: b[1] }}
              transition={SPRING}
              x1={0}
              y1={0}
              stroke="#f2f1ec"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              markerEnd="url(#lab-arrow)"
            />
          ))}
          <circle cx={0} cy={0} r={1.1} fill="none" stroke="#f2f1ec" strokeWidth={1} vectorEffect="non-scaling-stroke" />

          {/* the error: target to the rounded point */}
          <motion.line
            initial={false}
            animate={{ x1: target[0], y1: target[1], x2: active.point[0], y2: active.point[1] }}
            transition={SPRING}
            stroke="#4d8bff"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
          {/* the true closest point, when rounding missed it */}
          {!activeIsBest ? (
            <motion.circle
              initial={false}
              animate={{ cx: best.point[0], cy: best.point[1] }}
              transition={SPRING}
              r={1.6}
              fill="none"
              stroke="rgba(242,241,236,0.6)"
              strokeWidth={1}
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {/* the rounded point */}
          <motion.circle
            initial={false}
            animate={{ cx: active.point[0], cy: active.point[1] }}
            transition={SPRING}
            r={1.8}
            fill="none"
            stroke="#f2f1ec"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          {/* the target */}
          <circle cx={target[0]} cy={target[1]} r={1.2} fill="#4d8bff" />
        </g>
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-mute">
        <span>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-signal align-middle" />
          target, drag it
        </span>
        <span>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full border border-paper align-middle" />
          rounded point
        </span>
        <span>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full border border-dashed border-paper/60 align-middle" />
          true closest, when missed
        </span>
        <span>
          <span className="mr-1.5 inline-block h-px w-3 border-t border-dashed border-signal align-middle" />
          error
        </span>
      </div>

      <MonoTable
        className="mt-5"
        rows={[
          ["basis vectors", `b1 = ${fmtVec(b1, 0)} · b2 = ${fmtVec(b2, 0)} · |b1| ${length(b1).toFixed(1)} · |b2| ${length(b2).toFixed(1)}`],
          ["target t", fmtVec(target)],
          ["t in this basis", `${active.coeffs[0].toFixed(2)} b1 ${signed(active.coeffs[1].toFixed(2))} b2`],
          ["rounded", `${active.rounded[0]} b1 ${signed(String(active.rounded[1]))} b2 = ${fmtVec(active.point, 0)}`],
          ["error", `${active.error.toFixed(2)} ${activeIsBest ? "· the closest point" : `· closest is ${best.distance.toFixed(2)} away`}`],
          ["private basis would give", `${priv.error.toFixed(2)}`],
          ["public basis would give", `${pub.error.toFixed(2)}`],
        ]}
      />
      <p className="mt-3 text-xs leading-relaxed text-mute">
        Both bases span the same lattice: the public one is the private one times a unimodular matrix. In two
        dimensions a reduction algorithm recovers the short basis instantly; in 768 the best reductions run out of
        universe, which is the hardness ML-KEM is built on.
      </p>
    </Exhibit>
  );
}

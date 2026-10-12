"use client";

/**
 * A fighter's appearance: one of the two existing renders chosen by the
 * dominant gate (H-heavy wears Hadamard, X/Z-heavy wears Pauli), tinted by
 * its circuit. The blend that drops the render's black background sits on
 * the outermost transformed wrapper; the tint filter sits inside it, so the
 * group still screens onto the panel. `FighterTag` is its caption (name,
 * gates, style), laid out by the stage in a row of its own so long circuits
 * wrap downward instead of climbing over the sprite.
 */

import { motion } from "framer-motion";
import { preload } from "react-dom";
import CharacterSprite from "@/components/ui/CharacterSprite";
import { fighterStyle, gateLabel, type Circuit } from "@/lib/arena";
import { circuitTint } from "@/components/arena/format";

interface Props {
  circuit: Circuit;
  /** left fighters face right; right fighters are mirrored */
  side: "left" | "right";
  attacking?: boolean;
  /** pushed back when the other side lands a blow */
  hit?: boolean;
  /** strength of the current blow, 0..1: a glancing swing is shorter and its target barely moves */
  power?: number;
  className?: string;
}

const SPRITES = {
  hadamard: {
    idle: "/characters/fighter-hadamard.webp",
    attack: "/characters/fighter-hadamard-attack.webp",
    alt: "Arena fighter Hadamard, half matte black, half glowing lattice, holding a mirror blade",
  },
  pauli: {
    idle: "/characters/fighter-pauli.webp",
    attack: "/characters/fighter-pauli-attack.webp",
    alt: "Arena fighter Pauli, heavy stone gauntlets, glowing X seam across the chest",
  },
} as const;

export default function FighterCard({ circuit, side, attacking = false, hit = false,
  power = 1, className = "" }: Props) {
  const style = fighterStyle(circuit);
  const sprite = SPRITES[style];
  // Both poses are fetched up front: the attack pose swaps in mid-swing, and a
  // cold fetch would leave the first blow blank.
  preload(sprite.idle, { as: "image" });
  preload(sprite.attack, { as: "image" });
  const tint = circuitTint(circuit);
  const left = side === "left";
  const dir = left ? 1 : -1;

  return (
    <div className={`relative ${className}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-[10%] bottom-[8%] top-[20%] rounded-full opacity-50 blur-3xl transition-colors duration-700"
        style={{ background: `radial-gradient(circle at 50% 60%, ${tint.glow(0.4)}, transparent 65%)` }}
      />
      <motion.div
        animate={{
          x: attacking ? 44 * dir * power : hit ? -20 * dir * power : 0,
          rotate: attacking ? -3 * dir * power : hit ? 6 * dir * power : 0,
          scale: attacking ? 1 + 0.06 * power : hit ? 1 - 0.04 * power : 1,
        }}
        transition={{ type: "spring", stiffness: 420, damping: 26 }}
        className="absolute inset-0 mix-blend-screen"
      >
        <div className="h-full w-full" style={{ filter: `hue-rotate(${tint.hueShift.toFixed(0)}deg)` }}>
          <CharacterSprite
            src={attacking ? sprite.attack : sprite.idle}
            alt={sprite.alt}
            label={`fighter-${style}.webp`}
            className="h-full w-full"
            flip={!left}
            tilt={6}
          />
        </div>
      </motion.div>

    </div>
  );
}

/** The caption under a fighter: name, its gates (pre | post) and its style. */
export function FighterTag({ circuit, side, name, className = "" }: { circuit: Circuit; side: "left" | "right"; name: string; className?: string }) {
  const tint = circuitTint(circuit);
  const left = side === "left";
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${left ? "items-start" : "items-end"} ${className}`}>
      <span className="eyebrow text-paper">{name}</span>
      <div className={`flex flex-wrap items-center gap-1 ${left ? "" : "justify-end"}`}>
        {circuit.pre.length === 0 && circuit.post.length === 0 ? (
          <span className="chip !py-0.5 text-mute">identity</span>
        ) : (
          <>
            {circuit.pre.map((g, i) => (
              <span key={`pre-${i}`} className="chip !py-0.5" style={{ borderColor: tint.glow(0.5) }}>
                {gateLabel(g)}
              </span>
            ))}
            {circuit.post.length > 0 ? <span className="font-mono text-[10px] text-mute">|</span> : null}
            {circuit.post.map((g, i) => (
              <span key={`post-${i}`} className="chip !py-0.5 text-mute" style={{ borderColor: tint.glow(0.3) }}>
                {gateLabel(g)}
              </span>
            ))}
          </>
        )}
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-mute">{fighterStyle(circuit)}</span>
    </div>
  );
}

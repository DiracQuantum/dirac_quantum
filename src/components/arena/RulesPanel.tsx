"use client";

/** How a bout is decided, in the words the Worker and the browser both compute. */

import { Row } from "@/components/app/ui";
import { LAYER_GATES, MAX_POST, MAX_PRE, REVEAL_WINDOW_MS } from "@/lib/arena";

export default function RulesPanel({ className = "" }: { className?: string }) {
  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Rules · v1</span>
        <span className="eyebrow hidden sm:inline">bell battle</span>
      </div>
      <dl className="mt-4">
        <Row label="Register">|q0 q1⟩. You are A on q0, the opponent is B on q1.</Row>
        <Row label="Fighter">
          up to {MAX_PRE} pre gates and {MAX_POST} post gates from H, X, Z, RY(theta); theta in 5-degree steps, -180..180
        </Row>
        <Row label="Layer">{LAYER_GATES.join(" → ")}, fixed and public, between pre and post</Row>
        <Row label="Measure">both qubits in the computational basis</Row>
        <Row label="Winner">parity 0 (|00⟩, |11⟩) is A&apos;s; parity 1 (|01⟩, |10⟩) is B&apos;s; pA = p00 + p11</Row>
        <Row label="Ranked">exact: A wins if pA &gt; 0.5, B if pA &lt; 0.5, a draw within 1e-9; no sampling, no luck</Row>
        <Row label="Spar">100 shots, PRNG seeded by sha256(pet day bits + bout id), not rated</Row>
        <Row label="Hidden">
          commit = sha256(canonical circuit + &quot;:&quot; + salt), sealed by the passport; reveal = circuit + salt; nobody sees a
          revealed circuit before the bout resolves
        </Row>
        <Row label="Queue">one fighter per wallet, withdrawable until paired; a commit fights once; one open bout per opponent</Row>
        <Row label="Forfeit">
          no reveal within {REVEAL_WINDOW_MS / 3_600_000} h of pairing: the side that revealed wins; neither reveals: void, unrated
        </Row>
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-mute">
        Everything above is simulated exactly: a two-qubit state vector, no quantum hardware. Rank is the only prize; no stakes, no
        pools.
      </p>
    </section>
  );
}

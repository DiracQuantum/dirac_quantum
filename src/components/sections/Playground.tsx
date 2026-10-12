"use client";

import { AnimatePresence, motion, useInView, useScroll, useTransform } from "framer-motion";
import Link from "next/link";
import { preload } from "react-dom";
import { useEffect, useRef, useState } from "react";
import Section, { ChapterHeader } from "@/components/ui/Section";
import Reveal from "@/components/ui/Reveal";
import Creature from "@/components/pet/Creature";
import CharacterSprite from "@/components/ui/CharacterSprite";
import { QubitDots } from "@/components/pet/Register";
import { cnotTarget, dayLabel, formatCountdown, GATE_INFO, pickRandomQubit, waitSeconds } from "@/components/pet/format";
import { useNow, usePet } from "@/components/pet/usePet";
import { EASE } from "@/lib/anim";
import { GATES, paletteOf, type Gate } from "@/lib/pet";
import { triggerBurst } from "@/lib/petStore";

const KEY_BITS = 22;
const KEY_SPACE = 2 ** KEY_BITS;

function ToyKeyCrack() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-20% 0px" });
  const [run, setRun] = useState(0);
  const [guesses, setGuesses] = useState(0);
  const [found, setFound] = useState<null | { ms: number; guesses: number }>(null);

  useEffect(() => {
    if (!inView) return;
    const target = Math.floor(Math.random() * KEY_SPACE);
    const start = performance.now();
    let g = 0;
    let raf = 0;
    const stepFrame = () => {
      const chunkEnd = Math.min(g + 70000, KEY_SPACE);
      let hit = false;
      for (; g < chunkEnd; g++) {
        if (g === target) {
          hit = true;
          g++;
          break;
        }
      }
      setGuesses(g);
      if (hit) {
        setFound({ ms: performance.now() - start, guesses: g });
        return;
      }
      raf = requestAnimationFrame(stepFrame);
    };
    raf = requestAnimationFrame(stepFrame);
    return () => cancelAnimationFrame(raf);
  }, [inView, run]);

  const pct = Math.min(100, (guesses / KEY_SPACE) * 100);

  return (
    <div ref={ref} className="panel flex h-full flex-col p-6 md:p-7">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Attack lab</span>
        <span className="eyebrow tnum">toy key · {KEY_BITS}-bit</span>
      </div>
      <h3 className="display mt-5 text-3xl">Crack a key.<br />Right now.</h3>
      <p className="mt-3 text-sm leading-relaxed text-mute">
        Your browser brute-forces a {KEY_BITS}-bit key while you watch. A quantum
        computer does this to 256-bit curves. This is a toy. The feeling is the point.
      </p>

      {/* the bars sit centred in the space the taller neighbouring cards leave */}
      <div className="flex flex-1 flex-col justify-center space-y-4 pt-6">
        <div>
          <div className="flex justify-between font-mono text-[11px] text-mute">
            <span>Elliptic curve, toy size</span>
            <span className="tnum">
              {found
                ? `cracked in ${(found.ms / 1000).toFixed(2)} s`
                : `${guesses.toLocaleString("en-US")} guesses`}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper/10">
            <div
              className="h-full rounded-full bg-paper transition-[width] duration-75"
              style={{ width: `${found ? 100 : pct}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex justify-between font-mono text-[11px] text-mute">
            <span>ML-KEM-768</span>
            <span>longer than the universe</span>
          </div>
          <div className="shimmer mt-1.5 h-1.5 rounded-full bg-paper/10">
            <div className="h-full w-[0.4%] rounded-full bg-signal" />
          </div>
        </div>
      </div>

      <div className="pt-6">
        <button
          type="button"
          onClick={() => {
            setFound(null);
            setGuesses(0);
            setRun((r) => r + 1);
          }}
          className="pill pill-ghost !px-4 !py-2"
        >
          Run again
        </button>
        <Link
          href="/lab"
          className="ml-4 inline-block text-[13px] font-medium text-paper underline-offset-4 hover:underline"
        >
          Open the lab →
        </Link>
      </div>
    </div>
  );
}

/**
 * The live pet: real state from `GET /api/pet`, gates through `POST /api/pet/act`.
 * A gate goes to the selected qubit, or to a random unprotected one; CNOT
 * targets the next qubit around. The full view is /pet.
 */
function PetCard() {
  const pet = usePet({ pollMs: 60_000 });
  const now = useNow();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [20, -20]);
  const [selected, setSelected] = useState<number | null>(null);
  // ?catdebug=1 tints the animated regions of the picture while tuning their positions
  const [catDebug] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("catdebug"),
  );

  const { state } = pet;
  const palette = paletteOf(state?.palette ?? "");
  const wait = waitSeconds(pet.retryAt, now);
  const ready = state !== null && !pet.busy && wait === 0;
  const left = state && now !== null ? formatCountdown(state.collapseAt - now) : "--:--:--";

  const applyGate = async (gate: Gate) => {
    if (!state) return;
    const q = selected ?? pickRandomQubit(state.qubits, now);
    const ok = await pet.act(gate, q, gate === "CNOT" ? cnotTarget(q) : undefined);
    if (ok) {
      triggerBurst();
      setSelected(q);
    }
  };

  const chip =
    pet.lastGate === null
      ? null
      : pet.outcome && pet.outcome.seq === pet.lastGate.seq
        ? `qubit ${pet.outcome.q} → ${pet.outcome.value}`
        : `${GATE_INFO[pet.lastGate.gate].label} on q${pet.lastGate.q}`;

  const note = pet.busy
    ? "applying…"
    : wait > 0
      ? `one gate per minute · next in ${wait} s`
      : pet.actError
        ? `refused · ${pet.actError}`
        : pet.error
          ? `pet offline · ${pet.error}`
          : selected === null
            ? "click a qubit to aim, or let chance pick one"
            : `aimed at q${selected} · cnot → q${cnotTarget(selected)}`;

  return (
    <div ref={ref} className="panel relative flex h-full flex-col overflow-hidden p-6 md:p-7">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Quantum pet</span>
        <span className="eyebrow text-paper">
          {state ? `${dayLabel(state.day)} · ${state.form}` : pet.error ? "offline" : "loading"}
        </span>
      </div>
      <h3 className="display mt-5 text-3xl">One creature.<br />Everyone&apos;s gates.</h3>
      <p className="mt-3 text-sm leading-relaxed text-mute">
        An exact 10-qubit simulation in superposition, shared by every visitor. Apply a gate,
        change the odds. At 00:00 UTC it collapses into a new form.
      </p>

      <motion.div style={{ y }} className="relative mx-auto mt-2 h-64 w-full min-w-0 max-w-[320px] md:h-72">
        <Creature form={state?.form ?? "cat"} debug={catDebug} tint={palette.accent} />
        <AnimatePresence>
          {chip && pet.lastGate ? (
            <motion.span
              key={pet.lastGate.seq}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: EASE }}
              className="chip absolute right-0 top-0"
            >
              {chip}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </motion.div>
      <span className="eyebrow pointer-events-none mt-3 block text-center text-[10px]">drag to rotate</span>

      <div className="mt-3 flex min-h-[20px] flex-wrap items-center justify-between gap-3 gap-y-2">
        {state ? (
          <QubitDots qubits={state.qubits} selected={selected} onSelect={setSelected} now={now} />
        ) : (
          <div aria-hidden className="flex gap-1.5">
            {Array.from({ length: 10 }).map((_, i) => (
              <span key={i} className="h-5 w-5 rounded-full border border-line" />
            ))}
          </div>
        )}
        {/* one fixed width for "random" and "q3", so selecting a qubit never changes whether
            it wraps under the dots and shifts the card; the CNOT target is in the note below */}
        <span className="eyebrow tnum ml-auto min-w-[3.25rem] whitespace-nowrap text-right text-[10px]">
          {selected === null ? "random" : `q${selected}`}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {GATES.map((gate) => (
          <button
            key={gate}
            type="button"
            title={GATE_INFO[gate].title}
            disabled={!ready}
            onClick={() => void applyGate(gate)}
            className="chip transition-all hover:-translate-y-0.5 hover:border-paper/50 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-line"
          >
            {GATE_INFO[gate].label}
          </button>
        ))}
      </div>

      <div className="tnum mt-2 min-h-[18px] font-mono text-[11px] text-mute">{note}</div>

      <div className="mt-auto flex items-end justify-between gap-4 pt-5">
        <div>
          <div className="eyebrow">collapse in</div>
          <div className="tnum font-mono text-2xl text-paper">{left}</div>
        </div>
        <div className="text-right">
          <span className="tnum block font-mono text-[11px] text-mute">
            P(cat) {state ? state.pCat.toFixed(2) : "—"}
          </span>
          <Link
            href="/pet"
            className="mt-1 inline-block text-[13px] font-medium text-paper underline-offset-4 hover:underline"
          >
            Open the pet →
          </Link>
        </div>
      </div>
    </div>
  );
}

type Turn = "idle" | "left" | "right";

function ArenaCard() {
  // the demo swaps to the attack poses mid-swing; fetch them with the idle ones
  for (const src of ["/characters/fighter-hadamard-attack.webp", "/characters/fighter-pauli-attack.webp"]) preload(src, { as: "image" });
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: "-10% 0px" });
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const yL = useTransform(scrollYProgress, [0, 1], [24, -24]);
  const yR = useTransform(scrollYProgress, [0, 1], [-16, 16]);
  const [turn, setTurn] = useState<Turn>("idle");
  const [round, setRound] = useState(0);

  // Demo bout: the fighters trade blows while the card is on screen.
  useEffect(() => {
    if (!inView) return;
    let alive = true;
    let timer = 0;
    const sequence = (next: Turn) => {
      if (!alive) return;
      setTurn(next);
      timer = window.setTimeout(() => {
        if (!alive) return;
        setTurn("idle");
        setRound((r) => r + 1);
        timer = window.setTimeout(() => sequence(next === "left" ? "right" : "left"), 1500);
      }, 520);
    };
    timer = window.setTimeout(() => sequence("left"), 900);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [inView]);

  const leftAttacks = turn === "left";
  const rightAttacks = turn === "right";
  const pLeft = 0.62;

  return (
    <div ref={ref} data-scene-anchor className="panel relative isolate flex h-full flex-col overflow-hidden p-6 md:p-7">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Qubit arena</span>
        <span className="eyebrow tnum text-paper">bell battle · round {String(round + 1).padStart(2, "0")}</span>
      </div>
      <h3 className="display mt-5 text-3xl">Build a fighter<br />from a circuit.</h3>
      <p className="mt-3 text-sm leading-relaxed text-mute">
        Two qubits, five gates, hidden circuits sealed with your passport. The
        exact wavefunction decides the winner.
      </p>

      <div className="relative mt-2 min-h-56 flex-1 md:min-h-64">
        <AnimatePresence>
          {turn !== "idle" ? (
            <motion.div
              key={`${turn}-${round}`}
              initial={{ opacity: 0, scale: 0.4 }}
              animate={{ opacity: [0, 0.9, 0], scale: [0.4, 1.3, 1.6] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal/40 blur-2xl"
            />
          ) : null}
        </AnimatePresence>

        <motion.div
          style={{ y: yL }}
          animate={{
            x: leftAttacks ? 56 : rightAttacks ? -10 : 0,
            rotate: leftAttacks ? -3 : rightAttacks ? -6 : 0,
            scale: leftAttacks ? 1.06 : 1,
          }}
          transition={{ type: "spring", stiffness: 420, damping: 26 }}
          className="absolute bottom-0 left-0 h-[88%] w-[48%] mix-blend-screen"
        >
          <CharacterSprite
            src={leftAttacks ? "/characters/fighter-hadamard-attack.webp" : "/characters/fighter-hadamard.webp"}
            alt="Arena fighter Hadamard, half matte black, half glowing lattice, holding a mirror blade"
            label="fighter-hadamard.webp"
            className="h-full w-full"
            tilt={6}
          />
        </motion.div>

        <div className="display-serif pointer-events-none absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2 text-4xl text-paper-2/80">
          vs
        </div>

        <motion.div
          style={{ y: yR }}
          animate={{
            x: rightAttacks ? -56 : leftAttacks ? 10 : 0,
            rotate: rightAttacks ? 3 : leftAttacks ? 6 : 0,
            scale: rightAttacks ? 1.06 : 1,
          }}
          transition={{ type: "spring", stiffness: 420, damping: 26 }}
          className="absolute bottom-0 right-0 h-[88%] w-[48%] mix-blend-screen"
        >
          <CharacterSprite
            src={rightAttacks ? "/characters/fighter-pauli-attack.webp" : "/characters/fighter-pauli.webp"}
            alt="Arena fighter Pauli, heavy stone gauntlets, glowing X seam across the chest"
            label="fighter-pauli.webp"
            className="h-full w-full"
            flip
            tilt={6}
          />
        </motion.div>
      </div>

      <div className="pt-6">
        {/* Fixed demo odds, not a live bout: the ladder and real tables live on /arena. */}
        <div className="mb-3 flex items-center justify-between">
          <span className="eyebrow">Demo bout</span>
          <span className="chip">
            <span className="h-1.5 w-1.5 rounded-full bg-signal" /> example
          </span>
        </div>
        <div className="flex justify-between font-mono text-[11px] text-mute">
          <span>|H·CNOT⟩ {pLeft.toFixed(2)}</span>
          <span>{(1 - pLeft).toFixed(2)} |X·RY⟩</span>
        </div>
        <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-paper/10">
          <div className="h-full bg-paper" style={{ width: `${pLeft * 100}%` }} />
          <div className="h-full flex-1 bg-paper/25" />
        </div>
        <Link
          href="/arena"
          className="mt-4 inline-block text-[13px] font-medium text-paper underline-offset-4 hover:underline"
        >
          Enter the arena →
        </Link>
      </div>
    </div>
  );
}

export default function Playground() {
  return (
    <Section id="playground" index={5}>
      <ChapterHeader
        index={5}
        eyebrow="Playground"
        meta="Ranked bouts need a passport"
        title={
          <>
            Quantum,
            <br />
            <span className="display-serif text-paper-2">played by hand.</span>
          </>
        }
        lede="Three ways to feel the physics. Ranked arena bouts need a passport and pet badges need a signed wallet, so the games feed the product."
        className="mb-12 md:mb-16"
      />
      {/* page-coloured backdrop: the particle formation does not shine through the gaps between cards */}
      <div className="grid gap-4 rounded-[18px] bg-ink lg:grid-cols-3">
        <Reveal y={40} className="h-full min-w-0">
          <ToyKeyCrack />
        </Reveal>
        <Reveal y={40} delay={0.1} className="h-full min-w-0">
          <PetCard />
        </Reveal>
        <Reveal y={40} delay={0.2} className="h-full min-w-0">
          <ArenaCard />
        </Reveal>
      </div>
    </Section>
  );
}

"use client";

/**
 * The two fighters side by side. Idle, it previews your circuit against the
 * chosen opponent. Given a spar result it plays the 100 sampled shots as
 * ten rounds of ten: the side with more shots in a round lands a blow, the
 * tally climbs, and the exact pA stays on screen the whole time, because
 * the blows are the sample and the number is the truth.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import FighterCard, { FighterTag } from "@/components/arena/FighterCard";
import { formatP3, roundsOf } from "@/components/arena/format";
import type { Circuit, SparResult } from "@/lib/arena";
import { motionReduced } from "@/lib/motion";

interface Props {
  player: Circuit;
  opponent: Circuit;
  opponentName: string;
  /** the latest exhibition; a new boutId restarts the exchange */
  spar: SparResult | null;
  className?: string;
}

/** One beat of the exchange: who swings, and how hard (the decisive blow is 1). */
type Turn = "idle" | "left" | "right" | "clash";

interface Play {
  boutId: string;
  round: number;
  /** increments every beat so the impact flash re-mounts */
  beat: number;
  turn: Turn;
  power: number;
  a: number;
  b: number;
  done: boolean;
}

/** A swing, the pause after it, and the pause before the next round. */
const BEAT_MS = 250;
const GAP_MS = 110;
const ROUND_GAP_MS = 170;
/** Before the first round: a beat to settle, or long enough to scroll the stage into view. */
const START_MS = 200;
const START_AFTER_SCROLL_MS = 750;
/** The fixed top bar's height: a stage tucked under it counts as out of view. */
const NAV_PX = 80;

/**
 * The beats of one round of ten shots. Both fighters swing whenever they own
 * at least one shot: the side with fewer shots swings first (a glancing blow,
 * scaled by its share), then the side with more lands the decisive one. A
 * tied round is a clash in the middle.
 */
function beatsOf(r: { a: number; b: number; winner: "a" | "b" | "tie" }): { turn: Turn; power: number }[] {
  const total = Math.max(1, r.a + r.b);
  if (r.winner === "tie") return [{ turn: "clash", power: 0.7 }];
  const win: Turn = r.winner === "a" ? "left" : "right";
  const lose: Turn = r.winner === "a" ? "right" : "left";
  const loserShots = r.winner === "a" ? r.b : r.a;
  const beats: { turn: Turn; power: number }[] = [];
  if (loserShots > 0) beats.push({ turn: lose, power: 0.45 + (0.4 * loserShots) / total });
  beats.push({ turn: win, power: 1 });
  return beats;
}

export default function FightStage({
  player,
  opponent,
  opponentName,
  spar,
  className = "",
}: Props) {
  const [play, setPlay] = useState<Play | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Drive the exchange with timers; every state update happens inside one.
  useEffect(() => {
    if (!spar) return;
    // On one-column layouts the Spar button sits far below the stage: bring
    // the stage into view and hold the first blow until it gets there.
    let startMs = START_MS;
    const el = stageRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < NAV_PX || r.bottom > window.innerHeight) {
        const top = window.scrollY + r.top - Math.max(NAV_PX, (window.innerHeight - r.height) / 2);
        const reduced = motionReduced();
        window.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
        if (!reduced) startMs = START_AFTER_SCROLL_MS;
      }
    }
    const rounds = roundsOf(spar.shots.sequence);
    const id = spar.boutId;
    let alive = true;
    let timer = 0;
    let a = 0;
    let b = 0;
    let beatNo = 0;
    const show = (round: number, turn: Turn, power: number, done = false) =>
      setPlay({ boutId: id, round, beat: beatNo, turn, power, a, b, done });

    const round = (i: number) => {
      if (!alive) return;
      if (i >= rounds.length) {
        show(rounds.length, "idle", 1, true);
        return;
      }
      const r = rounds[i];
      const beats = beatsOf(r);
      const beat = (k: number) => {
        if (!alive) return;
        if (k >= beats.length) {
          // the round is scored once its blows have landed
          a += r.a;
          b += r.b;
          show(i + 1, "idle", 1);
          timer = window.setTimeout(() => round(i + 1), ROUND_GAP_MS);
          return;
        }
        beatNo += 1;
        show(i + 1, beats[k].turn, beats[k].power);
        timer = window.setTimeout(() => {
          if (!alive) return;
          show(i + 1, "idle", 1);
          timer = window.setTimeout(() => beat(k + 1), GAP_MS);
        }, BEAT_MS);
      };
      beat(0);
    };
    timer = window.setTimeout(() => round(0), startMs);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [spar]);

  // A new result shows round 01 at 0 · 0 at once, so the tally never blinks
  // back to the idle legend while the first blow is pending.
  const view: Play | null = spar
    ? play && play.boutId === spar.boutId
      ? play
      : { boutId: spar.boutId, round: 1, beat: 0, turn: "idle", power: 1, a: 0, b: 0, done: false }
    : null;
  const turn: Turn = view ? view.turn : "idle";
  const power = view ? view.power : 1;
  const shownOpponent = spar ? spar.house.circuit : opponent;
  const shownPlayer = spar ? spar.player : player;
  // a spar is always against the house, whatever the odds panel is set to
  const shownName = spar ? "house" : opponentName;

  return (
    <div ref={stageRef} className={className}>
      {/* The panel is the opaque backdrop the sprites' screen blend needs (their
          renders sit on black); `isolate` keeps the blend inside it. */}
      <div className="panel relative isolate overflow-hidden p-4 md:p-6">
        {/* Each fighter box is 48% wide and the renders are square, so a 2:1
            stage fits them edge to edge at every width. */}
        <div className="relative aspect-[2/1] max-h-96">
          <AnimatePresence>
            {view && turn !== "idle" ? (
              <motion.div
                key={`${turn}-${view.beat}`}
                initial={{ opacity: 0, scale: 0.4 }}
                animate={{ opacity: [0, 0.9, 0], scale: [0.4, 1.3, 1.6] }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
                className="pointer-events-none absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal/40 blur-2xl"
              />
            ) : null}
          </AnimatePresence>

          {/* Positioned wrappers: FighterCard's own root is `relative`, and an
            `absolute` passed in would lose to it. */}
          <div className="absolute inset-y-0 left-0 w-[48%]">
            <FighterCard
              circuit={shownPlayer}
              side="left"
              attacking={turn === "left" || turn === "clash"}
              hit={turn === "right"}
              power={power}
              className="h-full w-full"
            />
          </div>
          <div className="display-serif pointer-events-none absolute left-1/2 top-[55%] -translate-x-1/2 -translate-y-1/2 text-3xl text-paper-2/80 md:text-4xl">
            vs
          </div>
          <div className="absolute inset-y-0 right-0 w-[48%]">
            <FighterCard
              circuit={shownOpponent}
              side="right"
              attacking={turn === "right" || turn === "clash"}
              hit={turn === "left"}
              power={power}
              className="h-full w-full"
            />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 items-start gap-4">
          <FighterTag circuit={shownPlayer} side="left" name="you · A · q0" />
          <FighterTag circuit={shownOpponent} side="right" name={`${shownName} · B · q1`} />
        </div>
      </div>

      <div className="mt-6 border-t border-line pt-4">
        {view && spar ? (
          <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="eyebrow">
                  {view.done
                    ? "100 shots · sampled"
                    : `round ${String(view.round).padStart(2, "0")} of 10`}
                </div>
                <div className="tnum mt-1 font-mono text-3xl text-paper">
                  {view.a} <span className="text-mute">·</span> {view.b}
                </div>
              </div>
              <div className="text-right">
                <div className="eyebrow">exact pA</div>
                <div className="tnum mt-1 font-mono text-3xl text-paper">
                  {formatP3(spar.pA)}
                </div>
              </div>
            </div>
            <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-paper/10">
              <motion.div
                className="h-full bg-paper"
                initial={false}
                animate={{
                  width: `${view.a + view.b > 0 ? (view.a / (view.a + view.b)) * 100 : 50}%`,
                }}
                transition={{ duration: 0.3 }}
              />
            </div>
            {view.done ? (
              <p className="mt-3 font-mono text-[11px] text-mute">
                {spar.shots.a > spar.shots.b
                  ? "you took the sample"
                  : spar.shots.a < spar.shots.b
                    ? "the house took the sample"
                    : "the sample tied"}
                {" · "}
                the ranked rule says{" "}
                {spar.verdict === "a"
                  ? "you win"
                  : spar.verdict === "b"
                    ? "you lose"
                    : "draw"}{" "}
                · seed {spar.seed.slice(0, 8)} · day bits {spar.house.dayBits}
              </p>
            ) : null}
          </>
        ) : (
          <div className="flex justify-between font-mono text-[11px] text-mute">
            <span>A · parity 0 · |00⟩ |11⟩</span>
            <span>|01⟩ |10⟩ · parity 1 · B</span>
          </div>
        )}
      </div>
    </div>
  );
}

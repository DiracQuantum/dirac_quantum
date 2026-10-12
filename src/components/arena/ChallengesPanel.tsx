"use client";

/**
 * Challenges: today's puzzle, drawn from the pet's last collapsed bits, and
 * three permanent lessons. Every card runs the builder's circuit against
 * its opponent with the exact simulator, live, and shows the measured
 * numbers; a solve is remembered in this browser only. Nothing is sent.
 */

import { formatPct, formatWhen } from "@/components/arena/format";
import {
  LESSONS,
  challengeGoal,
  checkChallenge,
  circuitLabel,
  gateCount,
  type Challenge,
  type ChallengeCheck,
  type Circuit,
} from "@/lib/arena";
import { recordSolved, type SolvedChallenge, type SolvedMap } from "@/lib/arenaStore";

interface Props {
  circuit: Circuit;
  /** today's challenge; null while the day bits load or when they cannot be read */
  daily: Challenge | null;
  /** the pet day the daily challenge comes from */
  dailyDay: number | null;
  dailyState: "loading" | "ready" | "offline";
  solved: SolvedMap;
  /** keeps the challenge's opponent as the practice favourite, so the odds panel and the stage show it */
  onPractise(opponent: Circuit): void;
  className?: string;
}

export default function ChallengesPanel({ circuit, daily, dailyDay, dailyState, solved, onPractise, className = "" }: Props) {
  const lessonsSolved = LESSONS.filter((l) => solved[l.id]).length;
  const dailySolved = Object.keys(solved).filter((id) => id.startsWith("daily:")).length;

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Challenges</span>
        <span className="eyebrow tnum text-paper">
          {dailySolved} daily · {lessonsSolved}/{LESSONS.length} lessons
        </span>
      </div>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
        Build on the circuit builder; every card below reruns your circuit against its opponent, exactly, as you edit. A solve is
        remembered in this browser.
      </p>

      <div className="mt-6 border-t border-line pt-5">
        <span className="eyebrow">Today{dailyDay !== null ? ` · pet day ${dailyDay}` : ""}</span>
        {daily ? (
          <ChallengeCard challenge={daily} circuit={circuit} solved={solved[daily.id]} onPractise={onPractise} />
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-mute">
            {dailyState === "offline"
              ? "Today's challenge is drawn from the pet's last collapse, which the arena could not read. The lessons below work without it."
              : "Reading the pet's last collapse."}
          </p>
        )}
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <span className="eyebrow">Lessons</span>
        <ul className="divide-y divide-line">
          {LESSONS.map((l, i) => (
            <li key={l.id}>
              <ChallengeCard challenge={l} circuit={circuit} solved={solved[l.id]} onPractise={onPractise} index={i + 1} />
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-5 text-xs leading-relaxed text-mute">
        The daily challenge follows the pet&apos;s collapse at 00:00 UTC: same bits, same challenge, in every browser. Its threshold is
        set from an exhaustive search of every distribution a circuit can reach against that opponent, with room to spare, so each
        one is solvable.
      </p>
    </section>
  );
}

interface CardProps {
  challenge: Challenge;
  circuit: Circuit;
  solved: SolvedChallenge | undefined;
  onPractise(opponent: Circuit): void;
  index?: number;
}

function ChallengeCard({ challenge: ch, circuit, solved, onPractise, index }: CardProps) {
  const check = checkChallenge(ch, circuit);
  const status = solved ? "solved" : check.solved ? "passes now" : "open";
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-lg leading-tight text-paper">
          {index !== undefined ? <span className="tnum mr-2 font-mono text-xs text-mute">{index}</span> : null}
          {ch.title}
        </h3>
        <span className={`chip ${solved || check.solved ? "" : "text-mute"}`}>
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${solved ? "bg-paper" : check.solved ? "bg-signal" : "bg-mute"}`} />
          {status}
        </span>
      </div>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-mute">{ch.task}</p>

      <dl className="mt-3 grid gap-1.5 font-mono text-[11px]">
        <Line label="goal" value={challengeGoal(ch)} />
        <Line
          label="opponent"
          value={`${ch.opponentName}${gateCount(ch.opponent) === 0 ? "" : ` · ${circuitLabel(ch.opponent)}`} · plays ${ch.role === "a" ? "B" : "A"}`}
        />
        <Line label="you" value={`${circuitLabel(circuit)} · play ${ch.role.toUpperCase()}`} />
        <Line label="measured" value={measured(ch, check)} strong={check.solved} />
      </dl>
      <p className="tnum mt-2 font-mono text-[10px] text-mute">
        |00⟩ {formatPct(check.probs.p00)} · |01⟩ {formatPct(check.probs.p01)} · |10⟩ {formatPct(check.probs.p10)} · |11⟩{" "}
        {formatPct(check.probs.p11)}
      </p>
      {check.unmet ? <p className="mt-2 font-mono text-[11px] text-mute">not yet · {check.unmet}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {check.solved && !solved ? (
          <button type="button" onClick={() => recordSolved(ch.id, check.value, circuit)} className="pill !px-4 !py-2">
            Record solve
          </button>
        ) : null}
        <button type="button" onClick={() => onPractise(ch.opponent)} className="font-mono text-[11px] text-mute transition-colors hover:text-paper">
          practise against it
        </button>
      </div>
      {solved ? (
        <p className="tnum mt-2 font-mono text-[11px] text-mute">
          solved {formatWhen(solved.at)} with {circuitLabel(solved.circuit)}
        </p>
      ) : null}
      {ch.hint ? (
        <details className="mt-2 font-mono text-[11px] text-mute">
          <summary className="cursor-pointer transition-colors hover:text-paper">hint</summary>
          <p className="mt-1.5 leading-relaxed">{ch.hint}</p>
        </details>
      ) : null}
    </div>
  );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <dt className="text-mute">{label}</dt>
      <dd className={`tnum break-words ${strong ? "text-paper" : "text-paper/80"}`}>{value}</dd>
    </div>
  );
}

/** The number the goal reads, with enough digits to show an exact target is exact. */
function measured(ch: Challenge, check: ChallengeCheck): string {
  const v = check.value;
  switch (ch.kind) {
    case "floor":
      return `p${ch.outcome} = ${v.toFixed(3)}`;
    case "exact":
      return `pA = ${v.toFixed(9)}`;
    case "forbid":
      return `p${ch.outcome} = ${v <= 1e-9 ? "0 (under 1e-9)" : v.toFixed(6)} · pA = ${check.probs.pA.toFixed(3)}`;
    case "split":
      return `p00 = ${check.probs.p00.toFixed(3)} · p11 = ${check.probs.p11.toFixed(3)}`;
    default:
      return `pA = ${v.toFixed(3)}`;
  }
}

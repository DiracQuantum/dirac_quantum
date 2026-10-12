"use client";

/**
 * The standings of a resolved day: the podium, the full table (points,
 * record, summed margin, circuit), the forfeits, and the round-robin matrix
 * (row plays A, column plays B, the cell is the exact pA). Defaults to
 * yesterday; the arrows walk back through earlier days.
 */

import { memo } from "react";
import { ErrorNote } from "@/components/app/ui";
import { formatMargin, formatPoints, formatUtcClock, formatWhen, placeName } from "@/components/arena/format";
import { useTournament } from "@/components/arena/useArena";
import { circuitLabel, shiftDay, verdictOf, type TournamentResult, type TournamentView } from "@/lib/arena";
import { truncate } from "@/lib/solana/format";

/** The arrows stop here: dayOf and the Worker accept no earlier date. */
const FIRST_DAY = "1970-01-01";

interface Props {
  /** the day shown, "YYYY-MM-DD" */
  day: string;
  /** the newest day that can have standings (yesterday) */
  latest: string;
  onDay(day: string): void;
  wallet: string | null;
  className?: string;
}

/**
 * Memoised: the page re-renders every second for its clocks, and a full day's
 * matrix is 64 x 64 cells; the props here change only with the day or wallet.
 */
export default memo(TournamentResults);

function TournamentResults({ day, latest, onDay, wallet, className = "" }: Props) {
  const { view, error, loading } = useTournament(day, 120_000);
  const result = view?.result ?? null;

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="eyebrow">Standings</span>
        <div className="flex items-center gap-2">
          <DayButton label="earlier day" disabled={day <= FIRST_DAY} onClick={() => onDay(shiftDay(day, -1))}>
            ‹
          </DayButton>
          <span className="tnum font-mono text-[11px] text-paper">{day}</span>
          <DayButton label="later day" disabled={day >= latest} onClick={() => onDay(shiftDay(day, 1))}>
            ›
          </DayButton>
        </div>
      </div>

      {error ? <ErrorNote className="mt-4">{error}</ErrorNote> : null}
      {loading ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} aria-hidden className="shimmer h-2 rounded bg-paper/10" style={{ width: `${45 + ((i * 29) % 45)}%` }} />
          ))}
        </div>
      ) : null}

      {view && !result ? <NoResult view={view} /> : null}
      {view && result ? <Resolved view={view} result={result} wallet={wallet} /> : null}
    </section>
  );
}

function DayButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="chip !px-2.5 !py-0.5 transition-colors hover:border-paper/40 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function NoResult({ view }: { view: TournamentView }) {
  const text =
    view.entrants.length === 0
      ? `Nobody entered on ${view.day}.`
      : view.phase === "resolved"
        ? "Resolving: the standings appear on the next read."
        : `${view.counts.entries} entered so far. The standings arrive at 00:00 UTC after the day.`;
  return <p className="mt-4 text-sm leading-relaxed text-mute">{text}</p>;
}

function Resolved({ view, result, wallet }: { view: TournamentView; result: TournamentResult; wallet: string | null }) {
  const { standings, forfeits } = result;
  return (
    <>
      <p className="tnum mt-4 font-mono text-[11px] text-mute">
        {view.counts.entries} entered · {standings.length} revealed · {forfeits.length} forfeited · resolved {formatWhen(result.resolvedAt)}
      </p>

      {standings.length === 0 ? (
        <p className="mt-4 text-sm leading-relaxed text-mute">Nobody revealed: every entry is a forfeit and nothing was played.</p>
      ) : (
        <>
          <ol className="mt-5 grid gap-3 sm:grid-cols-3">
            {standings.slice(0, 3).map((s) => (
              <li
                key={s.wallet}
                className={`min-w-0 rounded-xl border p-4 ${s.place === 1 ? "border-paper/40 bg-paper/5" : "border-line"}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="display-serif text-3xl text-paper">{placeName(s.place)}</span>
                  <span className="tnum font-mono text-[11px] text-mute">{formatPoints(s.points)} pts</span>
                </div>
                <div className="mt-2 truncate font-mono text-xs text-paper" title={s.wallet}>
                  {truncate(s.wallet, 5, 4)}
                  {s.wallet === wallet ? <span className="text-mute"> · you</span> : null}
                </div>
                <div className="tnum mt-1 truncate font-mono text-[11px] text-mute" title={circuitLabel(s.circuit)}>
                  {circuitLabel(s.circuit)}
                </div>
                <div className="tnum mt-1 font-mono text-[11px] text-mute">margin {formatMargin(s.margin)}</div>
              </li>
            ))}
          </ol>
          {standings.length >= 2 ? (
            <p className="mt-3 text-xs leading-relaxed text-mute">The podium carries a tournament badge, a row in the registry.</p>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-mute">One fighter revealed: no game was played and no badge written.</p>
          )}

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse font-mono text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-[0.14em] text-mute">
                  <th className="py-2 pr-3 font-normal">#</th>
                  <th className="py-2 pr-3 font-normal">wallet</th>
                  <th className="py-2 pr-3 text-right font-normal">pts</th>
                  <th className="py-2 pr-3 text-right font-normal">w-d-l</th>
                  <th className="py-2 pr-3 text-right font-normal">margin</th>
                  <th className="py-2 font-normal">circuit</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((s) => (
                  <tr key={s.wallet} className={`border-t border-line ${s.wallet === wallet ? "bg-paper/5 text-paper" : "text-paper/90"}`}>
                    <td className="tnum py-2 pr-3 text-mute">{s.place}</td>
                    <td className="py-2 pr-3" title={s.wallet}>
                      {truncate(s.wallet, 5, 4)}
                      {s.wallet === wallet ? <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-mute">you</span> : null}
                    </td>
                    <td className="tnum py-2 pr-3 text-right">{formatPoints(s.points)}</td>
                    <td className="tnum py-2 pr-3 text-right">
                      {s.wins}-{s.draws}-{s.losses}
                    </td>
                    <td className="tnum py-2 pr-3 text-right">{formatMargin(s.margin)}</td>
                    <td className="tnum py-2 text-[11px] text-mute">{circuitLabel(s.circuit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {forfeits.length > 0 ? (
        <div className="mt-6 border-t border-line pt-5">
          <span className="eyebrow">Forfeits · not revealed</span>
          <ul className="mt-2 flex flex-wrap gap-2">
            {forfeits.map((f) => (
              <li key={f.commit} className="chip text-mute" title={f.wallet}>
                {truncate(f.wallet, 4, 4)} · {formatUtcClock(f.enteredAt).replace(" UTC", "")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {standings.length >= 2 ? <Matrix result={result} wallet={wallet} /> : null}
    </>
  );
}

function Matrix({ result, wallet }: { result: TournamentResult; wallet: string | null }) {
  const { standings, matrix } = result;
  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="eyebrow">Round robin · exact pA</span>
        <span className="font-mono text-[10px] text-mute">row plays A · column plays B</span>
      </div>
      <div className="mt-3 max-h-[440px] overflow-auto rounded-xl border border-line">
        <table className="min-w-full border-collapse whitespace-nowrap font-mono text-[10px]">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 bg-ink-2 px-2 py-1.5 text-left font-normal text-mute">A \ B</th>
              {standings.map((s) => (
                <th
                  key={s.wallet}
                  scope="col"
                  title={s.wallet}
                  className={`tnum sticky top-0 z-10 bg-ink-2 px-2 py-1.5 font-normal ${s.wallet === wallet ? "text-paper" : "text-mute"}`}
                >
                  {s.place}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, i) => (
              <tr key={standings[i].wallet} className="border-t border-line">
                <th
                  scope="row"
                  title={standings[i].wallet}
                  className={`tnum sticky left-0 z-10 bg-ink-2 px-2 py-1.5 text-left font-normal ${standings[i].wallet === wallet ? "text-paper" : "text-mute"}`}
                >
                  {standings[i].place} · {truncate(standings[i].wallet, 3, 3)}
                </th>
                {row.map((p, j) => {
                  if (p === null) {
                    return (
                      <td key={j} className="px-2 py-1.5 text-center text-mute/50">
                        ·
                      </td>
                    );
                  }
                  const v = verdictOf(p);
                  return (
                    <td
                      key={j}
                      title={`${placeName(standings[i].place)} as A vs ${placeName(standings[j].place)} as B · pA ${p.toFixed(6)}`}
                      className={`tnum px-2 py-1.5 text-center ${v === "a" ? "text-paper" : v === "b" ? "text-mute" : "text-signal"}`}
                    >
                      {p.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-mute">
        Bright: A won the game. Grey: B won. Blue: an exact draw. Each pair meets twice, once each way; a win is 1 point, a draw 0.5.
      </p>
    </div>
  );
}

"use client";

/**
 * Your bouts: the open ones with a Reveal button (enabled when this browser
 * holds the circuit and salt behind the commit) and the resolved ones with
 * the result, the exact pA and both circuits.
 */

import { useState } from "react";
import { ErrorNote, describeError } from "@/components/app/ui";
import { describeOutcome, formatElo, formatHoursLeft, formatP3, formatWhen, opponentOf, outcomeFor, roleOf, shortHex } from "@/components/arena/format";
import { circuitLabel, type ArenaBout, type ArenaMe, type MyBout } from "@/lib/arena";
import { revealFighter } from "@/lib/arenaApi";
import { fighterByCommit, markRevealed, type StoredFighter } from "@/lib/arenaStore";
import { truncate } from "@/lib/solana/format";

interface Props {
  wallet: string | null;
  me: ArenaMe | null;
  loading: boolean;
  error: string | null;
  fighters: readonly StoredFighter[];
  now: number | null;
  onChanged(): void;
  className?: string;
}

export default function BoutsPanel({ wallet, me, loading, error, fighters, now, onChanged, className = "" }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<{ id: string; message: string } | null>(null);

  const reveal = async (bout: MyBout) => {
    if (!wallet) return;
    const commit = bout.role === "a" ? bout.aCommit : bout.bCommit;
    const stored = fighterByCommit(wallet, commit);
    if (!stored) return;
    setBusyId(bout.id);
    setRevealError(null);
    try {
      await revealFighter(wallet, bout.id, stored.circuit, stored.salt);
      markRevealed(wallet, commit, bout.id);
      onChanged();
    } catch (e) {
      setRevealError({ id: bout.id, message: describeError(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Your bouts</span>
        <span className="eyebrow tnum text-paper">
          {me ? `${formatElo(me.rating.elo)} elo · ${me.rating.wins}w ${me.rating.losses}l ${me.rating.draws}d` : wallet ? "loading" : "no wallet"}
        </span>
      </div>

      {!wallet ? (
        <p className="mt-4 text-sm leading-relaxed text-mute">Connect a wallet to see its queue, open bouts and record.</p>
      ) : error ? (
        <ErrorNote className="mt-4">{error}</ErrorNote>
      ) : loading || !me ? (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} aria-hidden className="shimmer h-2 rounded bg-paper/10" style={{ width: `${55 + ((i * 29) % 40)}%` }} />
          ))}
        </div>
      ) : (
        <>
          <div className="mt-5">
            <span className="eyebrow">Open</span>
            {me.unresolved.length === 0 ? (
              <p className="mt-2 text-sm leading-relaxed text-mute">
                {me.queued ? "Your fighter is queued; a bout appears here once another wallet commits." : "No open bouts."}
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {me.unresolved.map((b) => {
                  const commit = b.role === "a" ? b.aCommit : b.bCommit;
                  const stored = fighters.find((f) => f.commit === commit) ?? null;
                  const left = now === null ? null : b.revealBy - now;
                  return (
                    <li key={b.id} className="py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-mono text-xs">
                        <span className="text-paper">
                          vs {truncate(opponentOf(b, b.role))} <span className="text-mute">· you are {b.role.toUpperCase()}</span>
                        </span>
                        <span className="tnum text-[11px] text-mute">
                          bout {shortHex(b.id)} · {left === null ? "" : `${formatHoursLeft(left)} to reveal`}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        {b.mustReveal ? (
                          stored ? (
                            <button
                              type="button"
                              onClick={() => void reveal(b)}
                              disabled={busyId !== null}
                              className="pill !px-4 !py-2 disabled:pointer-events-none disabled:opacity-50"
                            >
                              {busyId === b.id ? "Revealing…" : `Reveal ${circuitLabel(stored.circuit)}`}
                            </button>
                          ) : (
                            <span className="font-mono text-[11px] leading-relaxed text-mute">
                              committed from another browser: the circuit and salt are not here, so this side cannot reveal and
                              forfeits at {formatWhen(b.revealBy)}
                            </span>
                          )
                        ) : (
                          <span className="font-mono text-[11px] text-mute">
                            revealed · {b.opponentRevealed ? "resolving" : `waiting for the opponent until ${formatWhen(b.revealBy)}`}
                          </span>
                        )}
                      </div>
                      {revealError && revealError.id === b.id ? <ErrorNote className="mt-2">{revealError.message}</ErrorNote> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mt-6 border-t border-line pt-5">
            <span className="eyebrow">Resolved · last {me.recent.length}</span>
            {me.recent.length === 0 ? (
              <p className="mt-2 text-sm leading-relaxed text-mute">No resolved bouts yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {me.recent.map((b) => (
                  <BoutLine key={b.id} bout={b} wallet={wallet} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function BoutLine({ bout, wallet }: { bout: ArenaBout; wallet: string }) {
  const role = roleOf(bout, wallet) ?? "a";
  const result = bout.result;
  const outcome = result ? outcomeFor(result, role, bout.pA) : null;
  const mine = role === "a" ? bout.aCircuit : bout.bCircuit;
  const theirs = role === "a" ? bout.bCircuit : bout.aCircuit;
  return (
    <li className="grid gap-1 py-3 sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-4">
      <span className={`font-mono text-[11px] uppercase tracking-[0.14em] ${outcome === "won" ? "text-paper" : "text-mute"}`}>
        {result ? describeOutcome(result, role, bout.pA).split(" · ")[0] : "open"}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs">
          <span className="text-paper">vs {truncate(opponentOf(bout, role))}</span>
          <span className="tnum text-mute">pA {formatP3(bout.pA)}</span>
          {result ? <span className="text-mute">{describeOutcome(result, role, bout.pA)}</span> : null}
        </div>
        <div className="tnum mt-1 font-mono text-[11px] text-mute">
          {mine ? `you ${circuitLabel(mine)}` : "you · not revealed"} · {theirs ? `them ${circuitLabel(theirs)}` : "them · not revealed"} ·{" "}
          {bout.resolvedAt ? formatWhen(bout.resolvedAt) : ""}
        </div>
      </div>
    </li>
  );
}

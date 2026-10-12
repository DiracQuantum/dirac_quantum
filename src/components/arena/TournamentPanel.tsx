"use client";

/**
 * Today's daily tournament: the phase with a live countdown to the next
 * cut-off, the entry (until 21:00 UTC: the builder's circuit committed and
 * sealed with the passport, like a ranked commit), the reveal (21:00 to
 * 23:59 UTC, from this browser, which alone holds the circuit and salt) and
 * the entrants so far. Standings arrive at 00:00 UTC.
 */

import Link from "next/link";
import { useState } from "react";
import { ErrorNote, StatusLine, describeError, nextPaint } from "@/components/app/ui";
import type { Session } from "@/components/app/session";
import { formatCountdown, formatUtcClock, placeName, shortHex } from "@/components/arena/format";
import type { TournamentUi } from "@/components/arena/useArena";
import {
  DAY_MS,
  TOURNAMENT_ENTRY_CLOSE_MS,
  TOURNAMENT_REVEAL_CLOSE_MS,
  circuitLabel,
  commitHash,
  newSalt,
  tournamentDocHash,
  tournamentPhase,
  type ArenaBadge,
  type Circuit,
  type TournamentPhase,
  type TournamentView,
} from "@/lib/arena";
import { ArenaApiError, enterTournament, revealTournament } from "@/lib/arenaApi";
import { markTournamentRevealed, recordTournamentEntry, removeTournamentEntry, type StoredEntry } from "@/lib/arenaStore";
import { createSeal } from "@/lib/pq";
import { truncate } from "@/lib/solana/format";

interface Props {
  circuit: Circuit;
  wallet: string | null;
  session: Session;
  today: TournamentUi;
  entries: readonly StoredEntry[];
  badges: ArenaBadge[] | null;
  now: number | null;
  className?: string;
}

const PHASE_LABEL: Record<TournamentPhase, string> = {
  upcoming: "not open yet",
  entry: "entries open",
  reveal: "reveals open",
  closing: "reveals closed",
  resolved: "resolving",
};

/** The cut-off the countdown runs to, and what happens there. */
function nextCut(view: TournamentView, phase: TournamentPhase): { at: number; what: string } | null {
  const s = view.schedule;
  switch (phase) {
    case "upcoming":
      return { at: s.opensAt, what: "entries open" };
    case "entry":
      return { at: s.entryClosesAt, what: "entries close" };
    case "reveal":
      return { at: s.revealClosesAt, what: "reveals close" };
    case "closing":
      return { at: s.resolvesAt, what: "standings" };
    case "resolved":
      return null;
  }
}

const ENTRY_SHARE = (TOURNAMENT_ENTRY_CLOSE_MS / DAY_MS) * 100;
const REVEAL_SHARE = ((TOURNAMENT_REVEAL_CLOSE_MS - TOURNAMENT_ENTRY_CLOSE_MS) / DAY_MS) * 100;

export default function TournamentPanel({ circuit, wallet, session, today, entries, badges, now, className = "" }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const view = today.view;
  const passportMatches = session.passport !== null && wallet !== null && session.passport.wallet === wallet;
  const keysReady = passportMatches && session.keys !== null;

  // The server's phase decides what the buttons do; the countdown runs on the local clock corrected by the skew.
  const liveNow = now === null ? null : now + today.skew;
  const livePhase = view && liveNow !== null ? tournamentPhase(view.day, liveNow) : (view?.phase ?? null);
  const cut = view && livePhase ? nextCut(view, livePhase) : null;
  const dayProgress = view && liveNow !== null ? Math.min(100, Math.max(0, ((liveNow - view.schedule.opensAt) / DAY_MS) * 100)) : null;

  const mine = view && wallet ? (view.entrants.find((e) => e.wallet === wallet) ?? null) : null;
  const stored = mine ? (entries.find((e) => e.commit === mine.commit) ?? null) : null;
  const full = view ? view.counts.entries >= view.maxEntries : false;

  const enter = async () => {
    if (!view || !wallet || !session.passport || !session.keys || !passportMatches) return;
    const day = view.day;
    setError(null);
    setDone(null);
    setBusy("Sealing the entry with your passport key");
    await nextPaint();
    const salt = newSalt();
    const commit = commitHash(circuit, salt);
    try {
      const seal = createSeal(tournamentDocHash(day, commit), session.passport, session.keys.dsaSk, {
        anchorTx: session.anchorTx ?? undefined,
      });
      // Stored before the request: a reply lost on the wire must not lose the circuit.
      recordTournamentEntry(wallet, day, commit, salt, circuit);
      setBusy("Entering the tournament");
      const res = await enterTournament(wallet, day, commit, seal);
      setDone(`entered ${res.day} · ${res.entries} of ${view.maxEntries} · commit ${shortHex(res.commit)} · reveal from 21:00 UTC`);
      today.reload();
    } catch (e) {
      // A refusal means the server holds nothing for this commit; keep it on an unknown failure.
      if (e instanceof ArenaApiError && e.status >= 400 && e.status < 500) {
        removeTournamentEntry(wallet, commit);
        if (e.status === 409) today.reload();
      }
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const reveal = async () => {
    if (!view || !wallet || !stored) return;
    setError(null);
    setDone(null);
    setBusy("Revealing");
    try {
      const res = await revealTournament(wallet, view.day, stored.circuit, stored.salt);
      markTournamentRevealed(wallet, stored.commit);
      setDone(`revealed ${circuitLabel(res.circuit)} · standings at 00:00 UTC`);
      today.reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Daily tournament</span>
        <span className="chip">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${livePhase === "entry" || livePhase === "reveal" ? "bg-signal" : "bg-mute"}`} />
          {livePhase ? PHASE_LABEL[livePhase] : today.error ? "offline" : "loading"}
        </span>
      </div>

      {today.error && !view ? <ErrorNote className="mt-4">{today.error}</ErrorNote> : null}
      {!view && !today.error ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} aria-hidden className="shimmer h-2 rounded bg-paper/10" style={{ width: `${50 + ((i * 23) % 40)}%` }} />
          ))}
        </div>
      ) : null}

      {view ? (
        <>
          <div className="mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div>
              <div className="tnum font-mono text-[11px] text-mute">{view.day} · UTC</div>
              <div className="tnum mt-1 font-mono text-3xl text-paper">
                {cut && liveNow !== null ? formatCountdown(cut.at - liveNow) : "—"}
              </div>
              <div className="mt-1 font-mono text-[11px] text-mute">
                {cut ? `until ${cut.what} · ${formatUtcClock(cut.at)}` : "the standings are being computed"}
              </div>
            </div>
            <div className="sm:text-right">
              <div className="tnum font-mono text-3xl text-paper">
                {view.counts.entries}
                <span className="text-mute">/{view.maxEntries}</span>
              </div>
              <div className="tnum mt-1 font-mono text-[11px] text-mute">entered · {view.counts.revealed} revealed</div>
            </div>
          </div>

          {/* The day as a bar: entries until 21:00, reveals until 23:59, the standings at 00:00. */}
          <div className="relative mt-5 h-1.5 overflow-hidden rounded-full bg-paper/10" aria-hidden>
            <span className="absolute inset-y-0 left-0 bg-paper/35" style={{ width: `${ENTRY_SHARE}%` }} />
            <span className="absolute inset-y-0 bg-signal/70" style={{ left: `${ENTRY_SHARE}%`, width: `${REVEAL_SHARE}%` }} />
            {dayProgress !== null ? (
              <span className="absolute inset-y-0 w-0.5 bg-paper" style={{ left: `calc(${dayProgress}% - 1px)` }} />
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
            <span>00:00 entries</span>
            <span>21:00 reveals</span>
            <span>23:59 closed</span>
            <span>00:00 standings</span>
          </div>

          <div className="mt-6 border-t border-line pt-5">
            <span className="eyebrow">Your entry</span>
            <YourEntry
              view={view}
              wallet={wallet}
              session={session}
              keysReady={keysReady}
              passportMatches={passportMatches}
              circuit={circuit}
              mine={mine}
              stored={stored}
              full={full}
              busy={busy}
              onEnter={() => void enter()}
              onReveal={() => void reveal()}
            />
            {busy ? <StatusLine className="mt-3">{busy}</StatusLine> : null}
            {done ? <p className="mt-3 font-mono text-[11px] text-paper">{done}</p> : null}
            {error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
            {wallet && badges && badges.length > 0 ? <BadgeLine badges={badges} /> : null}
          </div>

          <div className="mt-6 border-t border-line pt-5">
            <div className="flex items-baseline justify-between gap-4">
              <span className="eyebrow">Entrants</span>
              <span className="eyebrow hidden sm:inline">circuits hidden until 00:00 UTC</span>
            </div>
            {view.entrants.length === 0 ? (
              <p className="mt-3 text-sm leading-relaxed text-mute">
                {view.phase === "entry" ? "Nobody has entered yet today." : "Nobody entered today."}
              </p>
            ) : (
              <ol className="mt-3 max-h-72 divide-y divide-line overflow-y-auto pr-1">
                {view.entrants.map((e, i) => (
                  <li key={e.commit} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-baseline gap-3 py-2 font-mono text-[11px]">
                    <span className="tnum text-mute">{i + 1}</span>
                    <span className={`truncate ${e.wallet === wallet ? "text-paper" : "text-paper/85"}`} title={e.wallet}>
                      {truncate(e.wallet, 4, 4)}
                      <span className="text-mute"> · {shortHex(e.commit)}</span>
                      {e.wallet === wallet ? <span className="text-mute"> · you</span> : null}
                    </span>
                    <span className="tnum text-mute">
                      {formatUtcClock(e.enteredAt).replace(" UTC", "")}
                      {e.revealedAt !== null ? <span className="text-paper"> · revealed</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

interface EntryProps {
  view: TournamentView;
  wallet: string | null;
  session: Session;
  keysReady: boolean;
  passportMatches: boolean;
  circuit: Circuit;
  mine: TournamentView["entrants"][number] | null;
  stored: StoredEntry | null;
  full: boolean;
  busy: string | null;
  onEnter(): void;
  onReveal(): void;
}

function YourEntry({ view, wallet, session, keysReady, passportMatches, circuit, mine, stored, full, busy, onEnter, onReveal }: EntryProps) {
  const line = "mt-3 font-mono text-[11px] leading-relaxed";
  if (!wallet) {
    return (
      <p className="mt-3 text-sm leading-relaxed text-mute">
        Entering needs a connected wallet with a registered passport. Anyone can follow the day and its standings.
      </p>
    );
  }

  if (mine) {
    const entered = `commit ${shortHex(mine.commit)} · entered ${formatUtcClock(mine.enteredAt)}`;
    if (mine.revealedAt !== null) {
      return (
        <p className={`${line} text-paper`}>
          {entered} · revealed {formatUtcClock(mine.revealedAt)}
          <br />
          <span className="text-mute">In the draw. The round robin runs at 00:00 UTC.</span>
        </p>
      );
    }
    if (view.phase === "entry") {
      return (
        <p className={`${line} text-paper`}>
          {entered}
          <br />
          <span className="text-mute">
            {stored
              ? `circuit ${circuitLabel(stored.circuit)} is kept in this browser; reveal it here between 21:00 and 23:59 UTC`
              : "committed from another browser: the reveal has to come from there"}
          </span>
        </p>
      );
    }
    if (view.phase === "reveal") {
      return stored ? (
        <div className="mt-3">
          <p className={`${line} mt-0 text-paper`}>{entered}</p>
          <button type="button" onClick={onReveal} disabled={busy !== null} className="pill mt-3 disabled:pointer-events-none disabled:opacity-50">
            {busy ? "Working…" : `Reveal ${circuitLabel(stored.circuit)}`}
          </button>
        </div>
      ) : (
        <p className={`${line} text-mute`}>
          {entered} · the circuit and salt are not in this browser, so this entry cannot be revealed here; unrevealed at 23:59 UTC it is
          listed as a forfeit
        </p>
      );
    }
    return <p className={`${line} text-mute`}>{entered} · not revealed in time: listed as a forfeit</p>;
  }

  if (view.phase === "upcoming") return <p className={`${line} text-mute`}>Entries open at 00:00 UTC.</p>;
  if (view.phase !== "entry") {
    return <p className={`${line} text-mute`}>Entries for {view.day} closed at 21:00 UTC. The next tournament opens at 00:00 UTC.</p>;
  }
  if (full) return <p className={`${line} text-mute`}>Today&apos;s bracket is full: {view.maxEntries} entries. The next opens at 00:00 UTC.</p>;
  if (!keysReady) {
    return (
      <div className="mt-3">
        <p className="text-sm leading-relaxed text-mute">
          The entry is sealed with your passport&apos;s ML-DSA key, so the keys must be in this browser session.{" "}
          {session.passport && !passportMatches
            ? "The passport in this session belongs to another wallet."
            : session.passport
              ? "Your passport is known, but its secret keys are not loaded."
              : "No passport in this session yet."}
        </p>
        <Link href="/passport" className="pill mt-4">
          {session.passport && passportMatches ? "Restore keys" : "Create passport"}
        </Link>
      </div>
    );
  }
  return (
    <div className="mt-3">
      <p className="max-w-md text-sm leading-relaxed text-mute">
        Enter the circuit on the builder. Only sha256(circuit + salt), sealed by your passport, goes to the server; the circuit and the
        salt stay in this browser until you reveal them between 21:00 and 23:59 UTC. One entry per wallet a day.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={onEnter} disabled={busy !== null} className="pill disabled:pointer-events-none disabled:opacity-50">
          {busy ? "Working…" : "Commit and enter"}
        </button>
        <span className="tnum font-mono text-[11px] text-mute">{circuitLabel(circuit)}</span>
      </div>
    </div>
  );
}

function BadgeLine({ badges }: { badges: ArenaBadge[] }) {
  const count = (place: number) => badges.filter((b) => b.place === place).length;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] text-mute">your podiums</span>
      {[1, 2, 3].map((place) =>
        count(place) > 0 ? (
          <span key={place} className="chip">
            {placeName(place)} <span className="tnum text-mute">×{count(place)}</span>
          </span>
        ) : null,
      )}
      <span className="tnum font-mono text-[11px] text-mute">latest {badges[0].day}</span>
    </div>
  );
}

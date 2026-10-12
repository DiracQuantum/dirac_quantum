"use client";

/**
 * Enter ranked: commit the circuit without showing it. The browser draws a
 * 16-byte salt, hashes the canonical circuit with it, seals the commit with
 * the passport's ML-DSA key and posts only the commit and the seal. The
 * circuit and the salt stay in this browser's storage, which is the only
 * place the reveal can come from. While the fighter waits in the queue the
 * same key can seal a withdrawal and take it back; once paired it stands.
 */

import Link from "next/link";
import { useState } from "react";
import { ErrorNote, StatusLine, describeError, nextPaint } from "@/components/app/ui";
import type { Session } from "@/components/app/session";
import { formatWhen, shortHex } from "@/components/arena/format";
import {
  MAX_UNRESOLVED,
  circuitLabel,
  commitDocHash,
  commitHash,
  newSalt,
  withdrawDocHash,
  type ArenaMe,
  type Circuit,
} from "@/lib/arena";
import { ArenaApiError, commitFighter, withdrawFighter } from "@/lib/arenaApi";
import { fighterByCommit, recordCommit, removeFighter, updateFighter } from "@/lib/arenaStore";
import { createSeal } from "@/lib/pq";
import { truncate } from "@/lib/solana/format";

interface Props {
  circuit: Circuit;
  wallet: string | null;
  session: Session;
  me: ArenaMe | null;
  /** after a successful commit, so the standing refreshes */
  onChanged(): void;
  className?: string;
}

type Done =
  | { kind: "queued"; commit: string }
  | { kind: "paired"; commit: string; boutId: string }
  | { kind: "withdrawn"; commit: string };

export default function RankedPanel({ circuit, wallet, session, me, onChanged, className = "" }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const passportMatches = session.passport !== null && wallet !== null && session.passport.wallet === wallet;
  const keysReady = passportMatches && session.keys !== null;
  const queued = me?.queued ?? null;
  /** Only bouts still waiting for your own reveal count; an opponent who stalls does not lock you out. */
  const open = me?.unresolved.filter((b) => b.mustReveal).length ?? 0;
  const blocked = queued !== null || open >= MAX_UNRESOLVED;
  const stored = wallet && queued ? fighterByCommit(wallet, queued.commit) : null;

  const leave = async () => {
    if (!wallet || !session.passport || !session.keys || !passportMatches || !queued) return;
    const commit = queued.commit;
    setError(null);
    setDone(null);
    setBusy("Sealing the withdrawal with your passport key");
    await nextPaint();
    try {
      const seal = createSeal(withdrawDocHash(commit), session.passport, session.keys.dsaSk, {
        anchorTx: session.anchorTx ?? undefined,
      });
      setBusy("Leaving the queue");
      await withdrawFighter(wallet, commit, seal);
      removeFighter(wallet, commit);
      setDone({ kind: "withdrawn", commit });
      onChanged();
    } catch (e) {
      // 404: it was paired in the meantime; the bout now shows below after the reload.
      if (e instanceof ArenaApiError && e.status === 404) onChanged();
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const enter = async () => {
    if (!wallet || !session.passport || !session.keys || !passportMatches) return;
    setError(null);
    setDone(null);
    setBusy("Sealing the commit with your passport key");
    await nextPaint();
    const salt = newSalt();
    const commit = commitHash(circuit, salt);
    try {
      const seal = createSeal(commitDocHash(commit), session.passport, session.keys.dsaSk, {
        anchorTx: session.anchorTx ?? undefined,
      });
      // Stored before the request: a reply lost on the wire must not lose the circuit.
      recordCommit(wallet, commit, salt, circuit);
      setBusy("Entering the queue");
      const res = await commitFighter(wallet, commit, seal);
      if (res.queued) {
        setDone({ kind: "queued", commit });
      } else {
        updateFighter(wallet, commit, { boutId: res.boutId });
        setDone({ kind: "paired", commit, boutId: res.boutId });
      }
      onChanged();
    } catch (e) {
      // A refusal means the server holds nothing for this commit; keep it on an unknown failure.
      if (e instanceof ArenaApiError && e.status >= 400 && e.status < 500) removeFighter(wallet, commit);
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Enter ranked</span>
        <span className="chip">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${keysReady ? "bg-signal" : "bg-mute"}`} />
          {keysReady && session.passport ? `|${truncate(session.passport.wallet)}⟩` : "no keys"}
        </span>
      </div>

      {!wallet ? (
        <p className="mt-4 text-sm leading-relaxed text-mute">
          Ranked bouts need a connected wallet with a registered passport. Connect in the top bar, then come back.
        </p>
      ) : !keysReady ? (
        <div className="mt-4">
          <p className="text-sm leading-relaxed text-mute">
            The commit is sealed with your passport&apos;s ML-DSA key, so the keys must be in this browser session.{" "}
            {session.passport && !passportMatches
              ? "The passport in this session belongs to another wallet."
              : session.passport
                ? "Your passport is known, but its secret keys are not loaded."
                : "No passport in this session yet."}
          </p>
          <Link href="/passport" className="pill mt-5">
            {session.passport && passportMatches ? "Restore keys" : "Create passport"}
          </Link>
        </div>
      ) : (
        <div className="mt-4">
          <p className="max-w-md text-sm leading-relaxed text-mute">
            Your circuit stays hidden: only sha256(circuit + salt), sealed by your passport, goes to the server. When another
            wallet is waiting you are paired at once; otherwise you wait in the queue, and can leave it until then. Once
            paired the commit stands. Both sides then reveal, and the exact pA decides.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void enter()} disabled={busy !== null || blocked} className="pill disabled:pointer-events-none disabled:opacity-50">
              {busy ? "Working…" : "Commit and enter"}
            </button>
            <span className="tnum font-mono text-[11px] text-mute">{circuitLabel(circuit)}</span>
          </div>
          {busy ? <StatusLine className="mt-3">{busy}</StatusLine> : null}
          {queued ? (
            <div className="mt-4 rounded-xl border border-line bg-ink-3 px-4 py-3 font-mono text-[11px] leading-relaxed text-paper">
              <span className="text-mute">in queue · </span>
              commit {shortHex(queued.commit)} · since {formatWhen(queued.queuedAt)}
              <br />
              <span className="text-mute">{stored ? `circuit ${circuitLabel(stored.circuit)} is stored in this browser` : "circuit not in this browser: committed elsewhere"}</span>
              <div className="mt-2">
                <button type="button" onClick={() => void leave()} disabled={busy !== null} className="pill !px-4 !py-2 disabled:pointer-events-none disabled:opacity-50">
                  Leave the queue
                </button>
              </div>
            </div>
          ) : null}
          {!queued && open >= MAX_UNRESOLVED ? (
            <p className="mt-3 font-mono text-[11px] text-mute">
              {MAX_UNRESOLVED} bouts are waiting for your reveal. Reveal them first.
            </p>
          ) : null}
          {done ? (
            <p className="mt-3 font-mono text-[11px] text-paper">
              {done.kind === "queued"
                ? `queued · commit ${shortHex(done.commit)} · waiting for another wallet`
                : done.kind === "withdrawn"
                  ? `withdrawn · commit ${shortHex(done.commit)} · the queue no longer holds your fighter`
                  : `paired · bout ${done.boutId} · you are B · reveal below`}
            </p>
          ) : null}
          {error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
          <p className="mt-5 max-w-md text-xs leading-relaxed text-mute">
            The reveal must come from this browser: the circuit and the salt are kept only in its local storage. Clear it or
            switch devices and the bout cannot be revealed; 24 h after pairing the other side wins by forfeit. One fighter in
            the queue, withdrawable until it is paired; at most {MAX_UNRESOLVED} bouts waiting for your reveal at a time. A
            commit is single-use: every entry draws a fresh salt.
          </p>
        </div>
      )}
    </section>
  );
}

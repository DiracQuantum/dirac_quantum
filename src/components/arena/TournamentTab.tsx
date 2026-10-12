"use client";

/**
 * The Tournament tab of /arena: today's tournament (entry, reveal,
 * entrants), the standings of a past day (yesterday by default) and the
 * rules. Owns the reads, so nothing is fetched while another tab is open.
 */

import { useState } from "react";
import { Row } from "@/components/app/ui";
import type { Session } from "@/components/app/session";
import TournamentPanel from "@/components/arena/TournamentPanel";
import TournamentResults from "@/components/arena/TournamentResults";
import { useArenaBadges, useTournament, useTournamentEntries } from "@/components/arena/useArena";
import { TOURNAMENT_MAX_ENTRIES, shiftDay, type Circuit } from "@/lib/arena";

interface Props {
  circuit: Circuit;
  wallet: string | null;
  session: Session;
  now: number | null;
}

export default function TournamentTab({ circuit, wallet, session, now }: Props) {
  const today = useTournament(null);
  const entries = useTournamentEntries(wallet);
  const [picked, setPicked] = useState<string | null>(null);
  const latest = today.view ? shiftDay(today.view.day, -1) : null;
  const resultsDay = latest === null ? null : picked !== null && picked <= latest ? picked : latest;
  // A new latest day means a day just resolved: the badge list is read again.
  const badges = useArenaBadges(wallet, latest ?? "");

  return (
    <>
      <TournamentPanel circuit={circuit} wallet={wallet} session={session} today={today} entries={entries} badges={badges} now={now} />
      {resultsDay && latest ? <TournamentResults day={resultsDay} latest={latest} onDay={setPicked} wallet={wallet} /> : null}
      <TournamentRules />
    </>
  );
}

function TournamentRules() {
  return (
    <section className="panel p-6 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Tournament rules</span>
        <span className="eyebrow hidden sm:inline">one a day · utc</span>
      </div>
      <dl className="mt-4">
        <Row label="Entry">
          00:00 to 21:00 UTC: a commit of your circuit, sealed by your passport; one per wallet, {TOURNAMENT_MAX_ENTRIES} a day, later
          ones refused
        </Row>
        <Row label="Reveal">21:00 to 23:59 UTC: circuit and salt, from the browser that entered; unrevealed is a forfeit</Row>
        <Row label="Games">at 00:00 UTC every revealed fighter meets every other twice, once as A and once as B; exact pA, no sampling</Row>
        <Row label="Score">win 1, draw 0.5 (pA within 1e-9 of 0.5), loss 0</Row>
        <Row label="Ties">summed margin, +|pA − 0.5| per win and −|pA − 0.5| per loss; then the earlier entry</Row>
        <Row label="Prize">
          places 1 to 3 get a tournament badge, a row in the registry, once at least two fighters revealed; no stakes, no pools
        </Row>
      </dl>
    </section>
  );
}

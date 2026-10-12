"use client";

/**
 * /arena: the Qubit Arena in full. Static export; everything live comes from
 * the Worker (`/api/arena/*`). Left: the chapter header, the two fighters
 * and the exact odds. Right: the tabs (`?tab=bout|tournament|challenges`),
 * the circuit builder every tab shares, then the tab: sparring, the ranked
 * entry, your bouts, the ladder, the latest bouts and the rules; or the
 * daily tournament; or the challenges.
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, useSyncExternalStore } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import { useSession } from "@/components/app/session";
import ArenaTabs, { parseTab, type ArenaTab } from "@/components/arena/ArenaTabs";
import BoutLookup from "@/components/arena/BoutLookup";
import BoutsPanel from "@/components/arena/BoutsPanel";
import ChallengesPanel from "@/components/arena/ChallengesPanel";
import CircuitBuilder from "@/components/arena/CircuitBuilder";
import FightStage from "@/components/arena/FightStage";
import Ladder from "@/components/arena/Ladder";
import ProbabilityReadout, { opponentCircuit, type OpponentKind } from "@/components/arena/ProbabilityReadout";
import RankedPanel from "@/components/arena/RankedPanel";
import RecentBouts from "@/components/arena/RecentBouts";
import RulesPanel from "@/components/arena/RulesPanel";
import SparPanel from "@/components/arena/SparPanel";
import TournamentTab from "@/components/arena/TournamentTab";
import { useArenaMe, useDraft, useFavourite, useFighters, useLadder, useSolved } from "@/components/arena/useArena";
import { useNow } from "@/components/pet/usePet";
import { LESSONS, checkChallenge, dailyChallenge, type Circuit, type SparResult } from "@/lib/arena";
import { recordSolved, saveDraft, saveFavourite } from "@/lib/arenaStore";
import { useWallet } from "@/lib/solana/wallet";

export default function ArenaPage() {
  return (
    <>
      <Nav />
      <main className="relative z-10 mx-auto max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        {/* The static HTML carries the Bout tab; the query (?tab=, ?bout=) is read on the client. */}
        <Suspense fallback={<Arena tab="bout" query="" />}>
          <ArenaFromQuery />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}

function ArenaFromQuery() {
  const params = useSearchParams();
  return <Arena tab={parseTab(params.get("tab"))} query={params.toString()} />;
}

/** Tailwind's `lg`: two columns from here up. */
const WIDE = "(min-width: 1024px)";
const subscribeWide = (onChange: () => void) => {
  const m = window.matchMedia(WIDE);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
};
const isWide = () => window.matchMedia(WIDE).matches;
const wideOnServer = () => true;

function Arena({ tab, query }: { tab: ArenaTab; query: string }) {
  const { wallet } = useWallet();
  const address = wallet?.address ?? null;
  const session = useSession();
  const ladder = useLadder();
  const me = useArenaMe(address);
  const fighters = useFighters(address);
  const favourite = useFavourite();
  const circuit = useDraft();
  const solved = useSolved();
  const now = useNow();
  const [opponent, setOpponent] = useState<OpponentKind>("house");
  const [spar, setSpar] = useState<SparResult | null>(null);
  // A shared bout link opens on its bout: in one column it sits under the
  // header instead of below the whole left column; the tabs follow it.
  const wide = useSyncExternalStore(subscribeWide, isWide, wideOnServer);
  const lookup = (
    <Suspense fallback={null}>
      <BoutLookup className={wide ? "" : "mt-10"} />
    </Suspense>
  );
  const tabs = <ArenaTabs tab={tab} query={query} className={wide ? "" : "mt-10"} />;

  const house = ladder.ladder?.house ?? null;
  const against = opponentCircuit(opponent, house, favourite);
  const opponentName = opponent === "house" ? "house" : opponent === "favourite" ? "favourite" : "identity";

  // The daily challenge searches every reachable distribution once (tens of ms), so only on its tab.
  const dayBits = house?.dayBits ?? null;
  const petDay = house?.day ?? null;
  const daily = useMemo(
    () => (tab === "challenges" && dayBits !== null ? dailyChallenge(dayBits, petDay) : null),
    [tab, dayBits, petDay],
  );

  const onCircuit = (next: Circuit) => {
    saveDraft(next);
    setSpar(null);
    // On the Challenges tab a circuit that meets a goal is remembered as you build.
    if (tab === "challenges") {
      for (const ch of daily ? [daily, ...LESSONS] : LESSONS) {
        if (solved[ch.id]) continue;
        const check = checkChallenge(ch, next);
        if (check.solved) recordSolved(ch.id, check.value, next);
      }
    }
  };

  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
      <div>
        <ChapterHeader
          as="h1"
          index={5}
          eyebrow="Qubit arena"
          meta={
            ladder.ladder
              ? `${ladder.ladder.totals.fighters} rated · house day ${ladder.ladder.house.day ?? "—"}`
              : ladder.error
                ? "offline"
                : "loading"
          }
          title={
            <>
              Build a fighter
              <br />
              <span className="display-serif text-paper-2">from a circuit.</span>
            </>
          }
          lede="Two qubits, one fixed entangling layer, your gates on one side. Ranked bouts and the daily tournament are decided by the exact wavefunction; circuits stay hidden until the result. Sparring samples 100 shots seeded by the pet's last collapse."
        />
        {wide ? null : lookup}
        {wide ? null : tabs}
        <FightStage player={circuit} opponent={against} opponentName={opponentName} spar={spar} className="mt-10" />
        <ProbabilityReadout
          circuit={circuit}
          house={house}
          houseError={ladder.error !== null}
          favourite={favourite}
          opponent={opponent}
          onOpponent={setOpponent}
          onSaveFavourite={() => saveFavourite(circuit)}
          onClearFavourite={() => {
            saveFavourite(null);
            setOpponent("house");
          }}
          className="mt-6"
        />
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        {wide ? lookup : null}
        {wide ? tabs : null}
        <CircuitBuilder circuit={circuit} onChange={onCircuit} />
        {tab === "bout" ? (
          <>
            <SparPanel circuit={circuit} house={house} houseError={ladder.error !== null} result={spar} onResult={setSpar} />
            <RankedPanel circuit={circuit} wallet={address} session={session} me={me.me} onChanged={me.reload} />
            <BoutsPanel
              wallet={address}
              me={me.me}
              loading={me.loading}
              error={me.error}
              fighters={fighters}
              now={now}
              onChanged={() => {
                me.reload();
                ladder.reload();
              }}
            />
            <Ladder ladder={ladder.ladder} loading={ladder.loading} error={ladder.error} wallet={address} />
            {ladder.ladder ? <RecentBouts bouts={ladder.ladder.recent} /> : null}
            <RulesPanel />
          </>
        ) : null}
        {tab === "tournament" ? <TournamentTab circuit={circuit} wallet={address} session={session} now={now} /> : null}
        {tab === "challenges" ? (
          <ChallengesPanel
            circuit={circuit}
            daily={daily}
            dailyDay={petDay}
            dailyState={house ? "ready" : ladder.error ? "offline" : "loading"}
            solved={solved}
            onPractise={(c) => {
              saveFavourite(c);
              setOpponent("favourite");
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

"use client";

/**
 * /pet: the quantum pet in full. Static export; everything live comes from the
 * Worker (`GET /api/pet`, `POST /api/pet/act`). Left: the chapter header and
 * today's body with the countdown. Right: the register, the gates, tonight's
 * odds, the weekly run on IBM hardware, the recent gates and the past days.
 */

import { useState } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import { ErrorNote, StatusLine } from "@/components/app/ui";
import ActionsFeed from "@/components/pet/ActionsFeed";
import GatesPanel from "@/components/pet/GatesPanel";
import HistoryList from "@/components/pet/HistoryList";
import OddsTable from "@/components/pet/OddsTable";
import { PetBadgesPanel } from "@/components/pet/PetBadges";
import PetBody from "@/components/pet/PetBody";
import QpuPanel from "@/components/pet/QpuPanel";
import Register from "@/components/pet/Register";
import { cnotTarget, dayLabel } from "@/components/pet/format";
import { useNow, usePet } from "@/components/pet/usePet";
import { useWallet } from "@/lib/solana/wallet";

export default function PetPage() {
  return (
    <>
      <Nav />
      <main className="relative z-10 mx-auto max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <Pet />
      </main>
      <Footer />
    </>
  );
}

function Pet() {
  const { wallet } = useWallet();
  const address = wallet?.address ?? null;
  const pet = usePet({ wallet: address });
  const now = useNow();
  const [selected, setSelected] = useState<number | null>(null);
  const { state } = pet;
  const target = selected === null ? null : cnotTarget(selected);

  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
      <div>
        <ChapterHeader
          as="h1"
          index={5}
          eyebrow="Quantum pet"
          meta={state ? `${dayLabel(state.day)} · ${state.form}` : "loading"}
          title={
            <>
              One creature.
              <br />
              <span className="display-serif text-paper-2">Everyone&apos;s gates.</span>
            </>
          }
          lede="A real 10-qubit register, simulated exactly, shared by every visitor. Each gate changes the odds for everyone. At 00:00 UTC one outcome is drawn and becomes tomorrow's body."
        />
        <PetBody state={state} now={now} className="mt-10" />
      </div>

      <div className="flex flex-col gap-5">
        {pet.error ? (
          <div className="panel p-6 md:p-8">
            <span className="eyebrow">Pet unavailable</span>
            <ErrorNote className="mt-4">{pet.error}</ErrorNote>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
              The state could not be read from the registry. Nothing is lost: the register lives on the
              server and keeps its superposition.
            </p>
            <button type="button" onClick={pet.reload} className="pill mt-5">
              Try again
            </button>
          </div>
        ) : null}

        {pet.loading ? (
          <div className="panel p-6 md:p-8">
            <span className="eyebrow">Register</span>
            <StatusLine className="mt-4">Reading the state vector</StatusLine>
            <div className="mt-6 space-y-3">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} aria-hidden className="shimmer h-2 rounded bg-paper/10" style={{ width: `${40 + ((i * 37) % 55)}%` }} />
              ))}
            </div>
          </div>
        ) : null}

        {state ? (
          <>
            <section className="panel p-6 md:p-8">
              <div className="flex items-center justify-between gap-4">
                <span className="eyebrow">Register</span>
                <span className="eyebrow hidden sm:inline">10 qubits · P(1) per qubit</span>
              </div>
              <Register
                qubits={state.qubits}
                selected={selected}
                target={target}
                onSelect={setSelected}
                now={now}
                className="mt-4"
              />
              <p className="mt-4 text-xs leading-relaxed text-mute">
                Click a qubit to aim the next gate at it. A blue bar is a protected qubit: it refuses
                gates until the protection runs out.
              </p>
            </section>

            <GatesPanel pet={pet} qubits={state.qubits} selected={selected} now={now} onActed={setSelected} />
            <OddsTable top={state.top} pForm={state.pForm} />
            {state.qpu ? <QpuPanel qpu={state.qpu} now={now} /> : null}
            <ActionsFeed actions={state.recent} actionsToday={state.actionsToday} now={now} />
            <PetBadgesPanel wallet={address} day={state.day} />
            <HistoryList days={state.history} pending={state.qpu?.pending ?? null} />
          </>
        ) : null}
      </div>
    </div>
  );
}

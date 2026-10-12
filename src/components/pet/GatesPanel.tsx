"use client";

/**
 * The six gates, the selected qubit and the CNOT target. A gate goes to the
 * selected qubit, or to a random unprotected one when nothing is selected.
 * With a connected wallet every gate is signed first (one wallet signature,
 * src/lib/petGate.ts): three per minute instead of one, written with the
 * wallet, and a badge at the collapse. A refused signature falls back to an
 * anonymous gate. The wait, a refused gate and the last MEASURE outcome show
 * inline.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { ErrorNote } from "@/components/app/ui";
import { GATES, type Gate, type PetQubit, type SignedGate } from "@/lib/pet";
import { ANON_PET_LIMIT, SIGNED_IP_LIMIT, SIGNED_PET_LIMIT, WALLETS_PER_IP_PER_DAY, signGate, windowOf } from "@/lib/petGate";
import { EASE } from "@/lib/anim";
import { triggerBurst } from "@/lib/petStore";
import { truncate } from "@/lib/solana/format";
import { describeWalletError, useWallet } from "@/lib/solana/wallet";
import { cnotTarget, GATE_INFO, pickRandomQubit, waitSeconds } from "@/components/pet/format";
import type { PetUi } from "@/components/pet/usePet";

interface Props {
  pet: PetUi;
  qubits: PetQubit[];
  selected: number | null;
  now: number | null;
  /** called with the qubit a gate went to, so the view can keep it selected */
  onActed?(q: number): void;
  className?: string;
}

export default function GatesPanel({ pet, qubits, selected, now, onActed, className = "" }: Props) {
  const { wallet } = useWallet();
  const [signing, setSigning] = useState(false);
  /** why the last gate went unsigned although a wallet was connected */
  const [unsigned, setUnsigned] = useState<string | null>(null);
  const wait = waitSeconds(pet.retryAt, now);
  const ready = pet.state !== null && !pet.busy && !signing && wait === 0;
  const target = selected === null ? null : cnotTarget(selected);
  const address = wallet?.address ?? null;

  // Signed gates left in the current fixed minute, from the hook's count of the ones that went through.
  const used = pet.signedWindow !== null && now !== null && pet.signedWindow.start === windowOf(now) ? pet.signedWindow.used : 0;
  const left = Math.max(0, SIGNED_PET_LIMIT - used);
  const forecast = address && pet.state ? badgeForecast(address, pet.state.myGates ?? 0, pet.state.leader ?? null) : null;

  const apply = async (gate: Gate) => {
    const q = selected ?? pickRandomQubit(qubits, now);
    const t = gate === "CNOT" ? cnotTarget(q) : undefined;
    let signed: SignedGate | null = null;
    if (wallet && pet.state) {
      setSigning(true);
      try {
        signed = await signGate(pet.state.day, gate, q, t ?? null, wallet);
        setUnsigned(null);
      } catch (e: unknown) {
        // The wallet refused (or failed): the gate still goes through, anonymously.
        setUnsigned(describeWalletError(e));
      } finally {
        setSigning(false);
      }
    }
    const ok = await pet.act(gate, q, t, signed);
    if (ok) {
      // the body on the left swells and flickers, as on the landing card
      triggerBurst();
      onActed?.(q);
    }
  };

  // One chip for the last gate that went through, hidden while the next one is in flight. A MEASURE
  // shows its result; any later gate replaces it with its own (the outcome belongs to its gate).
  const last = pet.lastGate;
  const chip =
    last === null || pet.busy
      ? null
      : pet.outcome && pet.outcome.seq === last.seq
        ? `qubit ${pet.outcome.q} → ${pet.outcome.value}`
        : `${GATE_INFO[last.gate].label} on q${last.q}${last.t === null ? "" : ` → q${last.t}`}`;

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Gates</span>
        <span className="eyebrow tnum text-paper">
          {selected === null ? "no qubit selected · random" : `q${selected}${target === null ? "" : ` · cnot target q${target}`}`}
        </span>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {GATES.map((gate) => (
          <button
            key={gate}
            type="button"
            title={GATE_INFO[gate].title}
            disabled={!ready}
            onClick={() => void apply(gate)}
            className="chip transition-all hover:-translate-y-0.5 hover:border-paper/50 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-line"
          >
            {GATE_INFO[gate].label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-mute">
        {address ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-paper">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-signal" />
              signed by {truncate(address)}
            </span>
            <span className="tnum">
              {SIGNED_PET_LIMIT} per minute · {left} left this minute
            </span>
            {forecast ? <span>tonight: {forecast}</span> : null}
          </>
        ) : (
          <span>
            anonymous · {ANON_PET_LIMIT} per minute per network address · connect a wallet for {SIGNED_PET_LIMIT} per minute
            of its own and a badge
          </span>
        )}
      </div>

      <div className="mt-3 flex min-h-[28px] flex-wrap items-center gap-2 font-mono text-[11px] text-mute">
        {signing ? <span>waiting for the wallet signature…</span> : null}
        {pet.busy ? <span>applying…</span> : null}
        {!pet.busy && !signing && wait > 0 ? (
          <span className="tnum">
            {address && pet.lastSigned ? `${SIGNED_PET_LIMIT} signed gates per minute` : "one gate per minute per network address"} · next in{" "}
            {wait} s
          </span>
        ) : null}
        {unsigned && address ? <span>unsigned · {unsigned}</span> : null}
        <AnimatePresence mode="wait">
          {chip !== null && last !== null ? (
            <motion.span
              key={last.seq}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="chip"
            >
              {chip}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>

      {pet.actError ? <ErrorNote className="mt-3">{pet.actError}</ErrorNote> : null}

      <p className="mt-5 max-w-md text-xs leading-relaxed text-mute">
        H puts a qubit in superposition, X flips it, CNOT entangles it with the next qubit, Measure
        collapses it to 0 or 1, Mutate rotates it by a random angle. Protect freezes a qubit for 30
        minutes; three at most. One gate per minute per network address, shared by everyone behind
        the same router; with a wallet, three per minute of its own ({SIGNED_IP_LIMIT} per address across
        wallets, {WALLETS_PER_IP_PER_DAY} wallets per address a day), each one a signed message, nothing on
        chain. The wallet must have an account on Solana. It is written next to the gate and earns a
        badge at the collapse: witness for one signed gate, influencer for the most.
      </p>
    </section>
  );
}

/** What the collapse will award this wallet if today ended now. */
function badgeForecast(address: string, myGates: number, leader: { wallet: string; gates: number } | null): string {
  if (myGates === 0) return "sign one gate for the witness badge";
  if (leader && leader.wallet === address) return `witness + influencer, leading with ${myGates}`;
  const ahead = leader ? leader.gates : 0;
  return `witness · influencer needs more than ${ahead}`;
}

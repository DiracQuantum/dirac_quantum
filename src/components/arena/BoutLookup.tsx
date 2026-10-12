"use client";

/**
 * `/arena?bout=<id>`: one bout by id, for sharing a result. Reads the query
 * string, so the page mounts it inside <Suspense>. Circuits show once the
 * bout is resolved; before that nobody sees them, not even their owners
 * (the server honours no viewer claim).
 */

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CopyButton, ErrorNote, Row, StatusLine, describeError } from "@/components/app/ui";
import { describeResult, formatP3, formatPct, formatWhen } from "@/components/arena/format";
import { circuitLabel, isBoutId, type ArenaBout } from "@/lib/arena";
import { fetchBout } from "@/lib/arenaApi";
import { truncate } from "@/lib/solana/format";

interface Props {
  className?: string;
}

export default function BoutLookup({ className = "" }: Props) {
  const id = useSearchParams().get("bout")?.trim().toLowerCase() ?? "";
  const [bout, setBout] = useState<ArenaBout | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isBoutId(id)) return;
    let cancelled = false;
    fetchBout(id)
      .then((b) => {
        if (cancelled) return;
        setBout(b);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (id === "") return null;
  const current = bout && bout.id === id ? bout : null;

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Bout {id.slice(0, 8)}</span>
        <CopyButton value={() => window.location.href} label="bout link" />
      </div>
      {!isBoutId(id) ? (
        <ErrorNote className="mt-4">a bout id is 16 hex characters</ErrorNote>
      ) : error ? (
        <ErrorNote className="mt-4">{error}</ErrorNote>
      ) : !current ? (
        <StatusLine className="mt-4">Reading the bout</StatusLine>
      ) : (
        <dl className="mt-4">
          <Row label="A · q0">{truncate(current.a, 6, 4)}</Row>
          <Row label="B · q1">{truncate(current.b, 6, 4)}</Row>
          <Row label="Status">
            {current.resolvedAt ? `${describeResult(current.result, current.pA)} · ${formatWhen(current.resolvedAt)}` : `open · reveal by ${formatWhen(current.revealBy)}`}
          </Row>
          <Row label="pA">{formatP3(current.pA)}</Row>
          <Row label="A circuit">{current.aCircuit ? circuitLabel(current.aCircuit) : current.aRevealedAt ? "revealed · hidden until resolved" : "not revealed"}</Row>
          <Row label="B circuit">{current.bCircuit ? circuitLabel(current.bCircuit) : current.bRevealedAt ? "revealed · hidden until resolved" : "not revealed"}</Row>
          {current.probs ? (
            <Row label="Table">
              |00⟩ {formatPct(current.probs.p00)} · |01⟩ {formatPct(current.probs.p01)} · |10⟩ {formatPct(current.probs.p10)} · |11⟩{" "}
              {formatPct(current.probs.p11)}
            </Row>
          ) : null}
          <Row label="Commits">
            {current.aCommit.slice(0, 12)}… · {current.bCommit.slice(0, 12)}…
          </Row>
        </dl>
      )}
    </section>
  );
}

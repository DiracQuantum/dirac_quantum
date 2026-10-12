"use client";

/**
 * Pet badges of one wallet, from `GET /api/pet/badges?wallet=`. Two shapes:
 * the panel on /pet (`PetBadgesPanel`, with the connected wallet) and one
 * row for the public passport page (`PetBadges`, the default export, a
 * `Row` for its details list). A badge is a registry row written at the
 * collapse of a day: witness for at least one signed gate that day,
 * influencer for the most. Nothing is minted.
 */

import { useEffect, useState } from "react";
import { describeError, Row } from "@/components/app/ui";
import { formatUtcDate } from "@/components/scan/format";
import type { PetBadge, PetBadgeKind } from "@/lib/pet";
import { fetchPetBadges } from "@/lib/petGate";
import { dayLabel } from "@/components/pet/format";

interface Loaded {
  wallet: string;
  badges: PetBadge[];
}

/** The wallet's badges; `refreshKey` (the current day on /pet) fetches them again when it changes. */
function useBadges(wallet: string | null, refreshKey = 0): { badges: PetBadge[] | null; error: string | null } {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ wallet: string; message: string } | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    fetchPetBadges(wallet)
      .then((badges) => {
        if (cancelled) return;
        setLoaded({ wallet, badges });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ wallet, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [wallet, refreshKey]);

  const badges = wallet && loaded?.wallet === wallet ? loaded.badges : null;
  const error = wallet && failure?.wallet === wallet ? failure.message : null;
  return { badges, error };
}

const KIND_LABEL: Record<PetBadgeKind, string> = {
  witness: "witness",
  influencer: "influencer",
};

const KIND_HINT: Record<PetBadgeKind, string> = {
  witness: "signed at least one gate that day",
  influencer: "the most signed gates that day",
};

/* ------------------------------------------------------------------ */
/* Row for the public passport page                                    */
/* ------------------------------------------------------------------ */

interface RowProps {
  wallet: string;
}

/** "witness ×3 · influencer ×1 · latest day 12" in one `Row`, or the reason there is nothing. */
export default function PetBadges({ wallet }: RowProps) {
  const { badges, error } = useBadges(wallet);
  if (error) return <Row label="Pet badges">{`unavailable · ${error}`}</Row>;
  if (badges === null) return <Row label="Pet badges">…</Row>;
  if (badges.length === 0) {
    return (
      <Row label="Pet badges">
        <span className="text-mute">none yet · a wallet-signed gate on /pet earns one at the collapse</span>
      </Row>
    );
  }
  const counts = countKinds(badges);
  const latest = badges[0];
  return (
    <Row label="Pet badges">
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        {(Object.keys(KIND_LABEL) as PetBadgeKind[])
          .filter((kind) => counts[kind] > 0)
          .map((kind) => (
            <span key={kind} className="chip" title={KIND_HINT[kind]}>
              {KIND_LABEL[kind]} <span className="tnum text-mute">×{counts[kind]}</span>
            </span>
          ))}
        <span className="text-mute">latest {dayLabel(latest.day)}</span>
      </span>
    </Row>
  );
}

function countKinds(badges: PetBadge[]): Record<PetBadgeKind, number> {
  const counts: Record<PetBadgeKind, number> = { witness: 0, influencer: 0 };
  for (const b of badges) counts[b.kind] += 1;
  return counts;
}

/* ------------------------------------------------------------------ */
/* Panel for /pet                                                      */
/* ------------------------------------------------------------------ */

interface PanelProps {
  /** the connected wallet, or null */
  wallet: string | null;
  /** the current day: a new one means the collapse ran, so the list is fetched again */
  day?: number;
  className?: string;
}

export function PetBadgesPanel({ wallet, day = 0, className = "" }: PanelProps) {
  const { badges, error } = useBadges(wallet, day);
  const counts = badges ? countKinds(badges) : null;

  return (
    <section className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Badges</span>
        <span className="eyebrow tnum hidden sm:inline">
          {counts ? `${counts.witness} witness · ${counts.influencer} influencer` : wallet ? "loading" : "no wallet"}
        </span>
      </div>

      {!wallet ? (
        <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
          Connect a wallet and every gate you apply is signed by it. At the collapse the registry
          writes a witness badge for the day to every wallet that signed a gate, and an influencer
          badge to the one with the most. Rows in the registry, not tokens.
        </p>
      ) : error ? (
        <p className="mt-4 font-mono text-[11px] text-mute">error · {error}</p>
      ) : badges === null ? (
        <p className="mt-4 font-mono text-[11px] text-mute">reading the registry…</p>
      ) : badges.length === 0 ? (
        <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
          No badge for this wallet yet. Sign a gate today and the collapse at 00:00 UTC writes the
          first one.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {badges.map((b) => (
            <li key={`${b.day}-${b.kind}`} className="grid gap-1 py-3 sm:grid-cols-[64px_minmax(0,1fr)] sm:gap-4">
              <span className="tnum font-mono text-[11px] uppercase tracking-[0.14em] text-mute">{dayLabel(b.day)}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="chip" title={KIND_HINT[b.kind]}>
                    {KIND_LABEL[b.kind]}
                  </span>
                  <span className="text-sm text-paper">
                    {b.form ?? "—"}
                    <span className="text-mute">
                      {" "}
                      · {b.gates} signed {b.gates === 1 ? "gate" : "gates"}
                    </span>
                  </span>
                </div>
                <div className="tnum mt-1 font-mono text-[11px] text-mute">
                  {b.measuredAt === null ? "collapse time unknown" : `collapsed ${formatUtcDate(Math.floor(b.measuredAt / 1000))}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {wallet ? (
        <p className="mt-4 max-w-md text-xs leading-relaxed text-mute">
          Badges are rows in the registry keyed by wallet and day; anyone can read them on the
          wallet&apos;s public page, /p?a=&lt;wallet&gt;, passport or not. Nothing is minted or sent on chain.
        </p>
      ) : null}
    </section>
  );
}

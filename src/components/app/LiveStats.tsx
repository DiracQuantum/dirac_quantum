"use client";

import { useEffect, useState } from "react";
import { fetchStats } from "@/lib/api";

interface Stats {
  passports: number;
  seals: number;
}

const REFRESH_MS = 60_000;

/**
 * Live registry counts for the landing stats row: "12 · 34" over
 * "Passports · Seals". Shows "—" while loading and stays quiet when the
 * registry cannot be reached.
 */
export default function LiveStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchStats()
        .then((s) => {
          if (cancelled) return;
          setStats({ passports: s.passports, seals: s.seals });
          setOffline(false);
        })
        .catch(() => {
          if (!cancelled) setOffline(true);
        });
    };
    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const n = (v: number) => v.toLocaleString("en-US");
  const dot = stats ? "bg-signal" : offline ? "bg-mute" : "animate-pulse bg-signal";

  return (
    <>
      <div className="tnum font-mono text-sm text-paper">
        {stats ? `${n(stats.passports)} · ${n(stats.seals)}` : "— · —"}
      </div>
      {/* the live dot hangs in the gutter so the label lines up with its neighbours and fits on one line */}
      <div className="eyebrow relative mt-1">
        <span aria-hidden className={`absolute -left-3.5 top-[0.4em] h-1.5 w-1.5 rounded-full ${dot}`} />
        Passports · Seals{offline && !stats ? " · offline" : ""}
      </div>
    </>
  );
}

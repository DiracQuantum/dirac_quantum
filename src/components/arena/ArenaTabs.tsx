"use client";

/**
 * The three parts of /arena as tabs: Bout (spar, ranked, ladder), Tournament
 * (the daily round robin) and Challenges. Each tab is a link to
 * `/arena?tab=<id>`, keeping the rest of the query (a shared `?bout=`), so
 * a tab is a deep link and the back button walks through them.
 */

import Link from "next/link";

export type ArenaTab = "bout" | "tournament" | "challenges";

const TABS: { id: ArenaTab; label: string }[] = [
  { id: "bout", label: "Bout" },
  { id: "tournament", label: "Tournament" },
  { id: "challenges", label: "Challenges" },
];

/** The tab a `?tab=` value names; anything else is the default, Bout. */
export function parseTab(value: string | null | undefined): ArenaTab {
  return value === "tournament" || value === "challenges" ? value : "bout";
}

function hrefFor(id: ArenaTab, query: string): string {
  const params = new URLSearchParams(query);
  if (id === "bout") params.delete("tab");
  else params.set("tab", id);
  const qs = params.toString();
  return qs ? `/arena?${qs}` : "/arena";
}

interface Props {
  tab: ArenaTab;
  /** the current query string, without the "?" */
  query: string;
  className?: string;
}

export default function ArenaTabs({ tab, query, className = "" }: Props) {
  return (
    <nav aria-label="Arena sections" className={`flex ${className}`}>
      <div className="inline-flex max-w-full rounded-full border border-line bg-ink-2 p-1">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <Link
              key={t.id}
              href={hrefFor(t.id, query)}
              scroll={false}
              aria-current={active ? "page" : undefined}
              className={`rounded-full px-3.5 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors sm:px-5 ${
                active ? "bg-paper text-ink" : "text-mute hover:text-paper"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

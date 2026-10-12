"use client";

/**
 * Badge panel for a public passport: a live preview of the embeddable SVG the
 * Worker draws from the registry (GET /api/badge/<wallet>.svg,
 * worker/badge.ts), size and theme toggles, and copy-ready embeds: HTML,
 * Markdown and the plain URL. An embedded badge links back to /p?a=<wallet>,
 * where a reader re-checks the signatures; the badge only repeats what the
 * registry holds. URL shapes and the drawing come from src/lib/badge.ts.
 */

import { useState, useSyncExternalStore } from "react";
import { CopyButton } from "@/components/app/ui";
import { API_BASE } from "@/lib/api";
import {
  BADGE_ALT,
  BADGE_SIZES,
  BADGE_THEMES,
  badgePath,
  badgeSnippets,
  renderBadge,
  type BadgeSize,
  type BadgeTheme,
} from "@/lib/badge";
import type { Passport } from "@/lib/pq";
import { siteOrigin } from "@/lib/share";

const noSubscribe = () => () => undefined;
const noOrigin = () => "";

/** The site origin for links shown on the page; empty while prerendering, where the subtree is not rendered anyway. */
export function useSiteOrigin(): string {
  return useSyncExternalStore(noSubscribe, siteOrigin, noOrigin);
}

const SIZE_NAME: Record<BadgeSize, string> = { s: "small", m: "medium" };
const THEME_NAME: Record<BadgeTheme, string> = { dark: "dark", light: "light" };

interface BadgeEmbedProps {
  wallet: string;
  mode: Passport["mode"];
  anchored: boolean;
  /** changes with the record (hash, anchor) so the preview never shows a badge cached before it */
  version: string;
  className?: string;
}

export default function BadgeEmbed({ wallet, mode, anchored, version, className = "" }: BadgeEmbedProps) {
  const [size, setSize] = useState<BadgeSize>("m");
  const [theme, setTheme] = useState<BadgeTheme>("dark");
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const origin = useSiteOrigin();

  const options = { size, theme };
  // In production the API is the site itself; in development NEXT_PUBLIC_API_BASE points at the deployed Worker.
  const api = API_BASE || origin;
  const snippets = badgeSnippets(wallet, options, { api, site: origin });
  const path = badgePath(wallet, options);
  const src = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
  // The Worker's own drawing for this record: the preview box has the badge's size before the image arrives.
  const { width, height } = renderBadge({ status: "ready", mode, anchored }, options);

  const embeds = [
    { label: "HTML", value: snippets.html, copy: "copy html" },
    { label: "Markdown", value: snippets.markdown, copy: "copy markdown" },
    { label: "URL", value: snippets.url, copy: "copy url" },
  ];

  return (
    <div className={`panel p-6 md:p-8 ${className}`}>
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Badge</span>
        <span className="font-mono text-[11px] text-mute">svg · {width} × {height}</span>
      </div>

      <div
        className={`mt-4 flex min-h-[104px] items-center justify-center rounded-xl border border-line px-4 py-8 transition-colors ${
          theme === "light" ? "bg-paper" : "bg-ink"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          width={width}
          height={height}
          alt={BADGE_ALT}
          onError={() => setFailedSrc(src)}
          className="block h-auto max-w-full"
        />
      </div>
      {failedSrc === src ? (
        <p className="mt-3 font-mono text-[11px] text-mute">the badge did not load; the snippets below still work</p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Choice label="Size" options={BADGE_SIZES} names={SIZE_NAME} value={size} onChange={setSize} />
        <Choice label="Theme" options={BADGE_THEMES} names={THEME_NAME} value={theme} onChange={setTheme} />
      </div>

      <div className="mt-6 flex flex-col gap-5">
        {embeds.map((embed) => (
          <div key={embed.label}>
            <div className="flex items-center justify-between gap-3">
              <span className="eyebrow">{embed.label}</span>
              <CopyButton value={embed.value} label={`badge ${embed.label}`} text={embed.copy} className="!px-3 !py-1.5" />
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-all rounded-xl border border-line bg-ink px-4 py-3 font-mono text-[11px] leading-relaxed text-mute">
              {embed.value}
            </pre>
          </div>
        ))}
      </div>

      <p className="mt-5 text-xs leading-relaxed text-mute">
        Drawn by the registry from this record and cached for ten minutes. The badge states the mode and the anchor;
        it proves neither. It links here, where every reader re-checks the signatures. Programs can read the same
        record as JSON at <span className="break-all font-mono text-[11px] text-paper">{api}{badgePath(wallet, {}, "json")}</span>.
      </p>
    </div>
  );
}

interface ChoiceProps<T extends string> {
  label: string;
  options: readonly T[];
  names: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}

function Choice<T extends string>({ label, options, names, value, onChange }: ChoiceProps<T>) {
  return (
    <div role="group" aria-label={`Badge ${label.toLowerCase()}`} className="flex items-center gap-2">
      <span className="eyebrow mr-1">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`chip !py-1 transition-colors ${value === option ? "!border-paper bg-paper/10" : "text-mute hover:!border-paper/40 hover:text-paper"}`}
        >
          {names[option]}
        </button>
      ))}
    </div>
  );
}

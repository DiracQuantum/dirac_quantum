"use client";

/** Small atoms shared by the app pages: notices, copy button, file helpers. */

import { useEffect, useRef, useState, type ReactNode } from "react";

/** One readable sentence out of whatever was thrown. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") return e.message;
  return "Something went wrong.";
}

/** Saves a text file through a temporary download link. */
export function downloadText(name: string, text: string, type = "application/json"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reads a File fully into memory. Nothing is uploaded anywhere. */
export async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** "3.4 KB" style size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Lets the browser paint (a status line, a disabled button) before a long synchronous job. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/** Error panel. Never alert(). */
export function ErrorNote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="alert"
      className={`rounded-xl border border-line bg-ink-3 px-4 py-3 font-mono text-[11px] leading-relaxed text-paper ${className}`}
    >
      <span className="text-mute">error · </span>
      {children}
    </div>
  );
}

/** Progress line with a pulsing dot, for the awaiting-wallet / fetching moments. */
export function StatusLine({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={`flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-mute ${className}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" />
      {children}
    </div>
  );
}

/** Mono label + value row used in the dark panels. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-line py-3 first:border-t-0 sm:grid-cols-[150px_1fr] sm:gap-6">
      <dt className="eyebrow">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-sm text-paper">{children}</dd>
    </div>
  );
}

interface CopyButtonProps {
  /** Text to copy, or a function producing it at click time (for window-dependent values). */
  value: string | (() => string);
  /** What is copied, for screen readers and the title. */
  label?: string;
  /** `ink` for the paper document, `paper` for dark panels. */
  tone?: "ink" | "paper";
  /** Idle label, for example "copy link" in a share row; "copied" and "failed" stay the same. */
  text?: string;
  className?: string;
}

export function CopyButton({ value, label = "value", tone = "paper", text = "copy", className = "" }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof value === "function" ? value() : value);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };

  const colour =
    tone === "ink"
      ? "text-ink/50 hover:text-ink border-line-ink"
      : "text-mute hover:text-paper border-line";

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${colour} ${className}`}
    >
      {state === "copied" ? "copied" : state === "failed" ? "failed" : text}
    </button>
  );
}

"use client";

/**
 * Exhibit 5: harvest now, decrypt later. The same sentence sealed twice in
 * the browser, with X25519 (the curve behind Ed25519) and with ML-KEM-768
 * from @noble/post-quantum: keygen, encapsulate and decapsulate really run,
 * the sizes and timings are measured. A year slider past Q-Day opens the
 * classical envelope and leaves the post-quantum one sealed. The reveal is
 * staged (we hold the plaintext because we encrypted it); the attack path
 * is real.
 */

import { motion } from "framer-motion";
import { Fragment, useEffect, useState } from "react";
import { describeError, ErrorNote, StatusLine } from "@/components/app/ui";
import { Exhibit, MonoTable } from "@/components/lab/Exhibit";
import { EASE } from "@/lib/anim";
import { hexPreview, sealClassical, sealPostQuantum, type Sealed } from "@/lib/lab/hndl";

const DEFAULT_TEXT = "Wire 40 SOL to the treasury on Friday.";
const DEFAULT_QDAY = 2032;
const MAX_QDAY = 2080;
const MAX_TEXT = 140;
/** Where the centre of a native range thumb (16 px) sits at a fraction of the track. */
const thumbAt = (fraction: number) => `calc(8px + (100% - 16px) * ${fraction})`;

interface Envelopes {
  text: string;
  classical: Sealed;
  pq: Sealed;
}

function seal(text: string): Envelopes {
  return { text, classical: sealClassical(text), pq: sealPostQuantum(text) };
}

export default function HarvestNow() {
  const [startYear] = useState(() => new Date().getUTCFullYear());
  const [qday, setQday] = useState(DEFAULT_QDAY);
  // The field holds a free-form draft; the clamped year is committed once the
  // draft is a full year, and on blur or Enter. Clamping every keystroke made
  // the field impossible to type into ("2" became 2027).
  const [qdayText, setQdayText] = useState(String(DEFAULT_QDAY));
  const [year, setYear] = useState<number | null>(null);
  const [text, setText] = useState(DEFAULT_TEXT);
  const [envelopes, setEnvelopes] = useState<Envelopes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First seal after mount, off the render path so the panel paints first.
  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(() => {
      try {
        const e = seal(DEFAULT_TEXT);
        if (alive) setEnvelopes(e);
      } catch (err: unknown) {
        if (alive) setError(describeError(err));
      }
    }, 60);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, []);

  const reseal = () => {
    setBusy(true);
    setError(null);
    window.setTimeout(() => {
      try {
        setEnvelopes(seal(text.trim() === "" ? DEFAULT_TEXT : text));
      } catch (err: unknown) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    }, 30);
  };

  const minQday = startYear + 1;
  const clampQday = (v: number) => Math.max(minQday, Math.min(MAX_QDAY, v));
  const commitQday = () => {
    const v = Number(qdayText);
    const next = qdayText.trim() !== "" && Number.isInteger(v) ? clampQday(v) : qday;
    setQday(next);
    setQdayText(String(next));
  };

  const maxYear = Math.max(2045, qday + 3);
  // Lowering Q-Day shrinks the slider; a year chosen under the old range must follow it.
  const shown = Math.min(year ?? startYear, maxYear);
  const opened = shown >= qday;
  const qdayFraction = (Math.min(qday, maxYear) - startYear) / (maxYear - startYear);

  return (
    <Exhibit
      id="harvest"
      index={5}
      eyebrow="Harvest now"
      meta="real X25519 and ML-KEM-768 in this tab"
      title={
        <>
          Harvest now,
          <br />
          decrypt later.
        </>
      }
      lede={
        <>
          Everything recorded today can be opened then. One sentence, sealed twice: once to a key on the curve
          your wallet uses, once to an ML-KEM-768 key from the real library. Both ciphertexts are copied to an
          archive the moment they cross the wire. Move the year.
        </>
      }
      takeaway="A key exchange or message encrypted to a curve key today is readable by whoever stored it, on Q-Day. The inbox encrypts to your passport's ML-KEM key for exactly this reason."
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="block">
          <span className="eyebrow">the sentence</span>
          <input
            type="text"
            value={text}
            maxLength={MAX_TEXT}
            onChange={(e) => setText(e.target.value)}
            className="mt-2 w-full rounded-lg border border-line bg-transparent px-3 py-2 font-serif text-base text-paper outline-none placeholder:text-mute focus:border-paper/50"
            placeholder={DEFAULT_TEXT}
          />
        </label>
        <button
          type="button"
          onClick={reseal}
          disabled={busy || envelopes === null}
          className="pill justify-self-start !px-4 !py-2.5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Sealing…" : "Seal again"}
        </button>
      </div>

      {/* Top-aligned so "the year" and "Q-Day" share a line; both label rows are as tall as the big year. */}
      <div className="mt-6 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-8">
        <label className="block">
          <span className="flex h-8 items-center justify-between gap-4">
            <span className="eyebrow">the year</span>
            <span className="tnum font-mono text-2xl text-paper">{shown}</span>
          </span>
          <span className="relative mt-2 block">
            <input
              type="range"
              min={startYear}
              max={maxYear}
              step={1}
              value={shown}
              onChange={(e) => setYear(Number(e.target.value))}
              className="relative z-10 block w-full accent-paper"
              aria-valuetext={`${shown}${opened ? ", after Q-Day" : ", before Q-Day"}`}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 h-4 w-px -translate-y-1/2 bg-signal"
              style={{ left: thumbAt(qdayFraction) }}
            />
          </span>
          {/* The Q-Day label follows its marker on the track, kept clear of the two end labels. */}
          <span className="relative mt-1 block h-4 font-mono text-[10px] leading-4 text-mute [--qday-min:10ch] sm:[--qday-min:21ch]">
            <span className="tnum absolute left-0 top-0 whitespace-nowrap">
              {startYear}
              <span className="hidden sm:inline"> · recorded</span>
            </span>
            <span
              className="tnum absolute top-0 -translate-x-1/2 whitespace-nowrap text-signal"
              style={{ left: `clamp(var(--qday-min), ${thumbAt(qdayFraction)}, calc(100% - 10ch))` }}
            >
              Q-Day {qday}
            </span>
            <span className="tnum absolute right-0 top-0">{maxYear}</span>
          </span>
        </label>
        <label className="block">
          <span className="flex h-8 items-center">
            <span className="eyebrow">Q-Day</span>
          </span>
          <input
            type="number"
            min={minQday}
            max={MAX_QDAY}
            value={qdayText}
            onChange={(e) => {
              const raw = e.target.value;
              setQdayText(raw);
              // A complete four-digit year takes effect while typing; shorter drafts wait for blur.
              if (/^\d{4}$/.test(raw)) setQday(clampQday(Number(raw)));
            }}
            onBlur={commitQday}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitQday();
            }}
            className="tnum mt-2 block w-24 rounded-lg border border-line bg-transparent px-3 py-2 font-mono text-sm text-paper outline-none focus:border-paper/50"
          />
        </label>
      </div>

      {error ? <ErrorNote className="mt-5">{error}</ErrorNote> : null}
      {envelopes === null && !error ? <StatusLine className="mt-5">Generating keys and sealing</StatusLine> : null}

      {/* Side by side only once each card has room for "encapsulate + encrypt" and its timing on one line. */}
      <div className="mt-5 grid gap-4 min-[1360px]:grid-cols-2">
        <EnvelopeCard
          label="X25519 + XChaCha20-Poly1305"
          sub="the curve behind every Ed25519 wallet key"
          sealed={envelopes?.classical ?? null}
          text={envelopes?.text ?? ""}
          opened={opened}
          openedNote={`Opened in ${shown}: Shor recovered the 32-byte secret from the 32-byte public key the archive kept, then decrypted like the recipient would.`}
          sealedNote="Sealed. Readable by the recipient, and by anyone holding a copy once Shor runs."
        />
        <EnvelopeCard
          label="ML-KEM-768 + XChaCha20-Poly1305"
          sub="keygen, encapsulate, decapsulate from @noble/post-quantum"
          sealed={envelopes?.pq ?? null}
          text={envelopes?.text ?? ""}
          opened={false}
          openedNote=""
          sealedNote={
            opened
              ? `Still sealed in ${shown}. No known quantum shortcut; the archive holds 1,088 bytes of noise.`
              : "Sealed. Readable by the recipient only."
          }
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-mute">
        The reveal is staged: this page can show the sentence because it encrypted it. Everything else is real,
        the keys, the sizes, the timings, and the fact that a 32-byte public key is all Shor needs.
      </p>
    </Exhibit>
  );
}

interface CardProps {
  label: string;
  sub: string;
  sealed: Sealed | null;
  text: string;
  opened: boolean;
  openedNote: string;
  sealedNote: string;
}

function EnvelopeCard({ label, sub, sealed, text, opened, openedNote, sealedNote }: CardProps) {
  return (
    // A column whose message box takes the slack, so side by side the two size tables line up row for row.
    <div className="flex flex-col rounded-xl border border-line p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Wraps at the "+", never inside "XChaCha20-Poly1305". */}
          <div className="font-mono text-[12px] text-paper">
            {label.split(" + ").map((part, i) => (
              <Fragment key={part}>
                {i > 0 ? " " : null}
                <span className="whitespace-nowrap">{i > 0 ? `+ ${part}` : part}</span>
              </Fragment>
            ))}
          </div>
          <div className="mt-0.5 text-[11px] text-mute">{sub}</div>
        </div>
        <span className={`chip shrink-0 ${opened ? "border-signal/70 text-signal" : ""}`}>{opened ? "opened" : "sealed"}</span>
      </div>

      {/* Keyed enter-only animation: the box never waits on an exit, so it is never empty. */}
      <div className="mt-4 min-h-[88px] flex-1 rounded-lg border border-line bg-ink p-3">
        {sealed === null ? (
          <div className="shimmer h-16 rounded bg-paper/5" aria-hidden />
        ) : opened ? (
          <motion.div
            key="open"
            initial={{ opacity: 0.2, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: EASE }}
          >
            <p className="font-serif text-lg leading-snug text-paper">{text}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-mute">{openedNote}</p>
          </motion.div>
        ) : (
          <motion.div
            key="sealed"
            initial={{ opacity: 0.2, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: EASE }}
          >
            <p className="break-words font-mono text-[11px] leading-relaxed text-paper/70">{hexPreview(sealed.ciphertext, 40)}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-mute">{sealedNote}</p>
          </motion.div>
        )}
      </div>

      {sealed ? (
        <div className="mt-4 grid gap-x-6 sm:grid-cols-2 lg:grid-cols-1">
          <MonoTable rows={sealed.sizes.map((s) => [s.label, `${s.bytes.toLocaleString("en-US")} B`])} />
          <MonoTable rows={sealed.timings.map((t) => [t.label, `${t.ms.toFixed(2)} ms`])} />
        </div>
      ) : null}
    </div>
  );
}

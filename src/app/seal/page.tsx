"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import { formatUtc } from "@/components/app/PassportDocument";
import { useSession } from "@/components/app/session";
import {
  CopyButton,
  ErrorNote,
  Row,
  StatusLine,
  describeError,
  downloadText,
  formatBytes,
  readFileBytes,
} from "@/components/app/ui";
import { fetchPassportHistory, fetchSeal, registerSeal, type PassportHistory, type PassportVersion } from "@/lib/api";
import {
  createSeal,
  hashBytes,
  sealId,
  sealIdentity,
  utf8,
  verifySeal,
  type QSeal,
  type SealIdentity,
} from "@/lib/pq";
import { truncate } from "@/lib/solana/format";
import { explorerTx } from "@/lib/solana/rpc";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function SealPage() {
  return (
    <>
      <Nav />
      {/* w-full: body is a flex column, so an auto-margined main would shrink to its content and jump as results appear. */}
      <main className="relative z-10 mx-auto w-full max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <ChapterHeader
          as="h1"
          index={3}
          eyebrow="Seal"
          meta="ML-DSA-65 over sha256 · in the browser"
          title={
            <>
              Sign anything.
              <br />
              <span className="display-serif text-paper-2">Verify anywhere.</span>
            </>
          }
          lede="A seal is a post-quantum signature over the hash of a text or a file. The document never leaves your device; only its hash is signed and only the hash is checked. The result is a small .qseal file or a public verification link."
        />
        <Suspense fallback={<Loading />}>
          <SealApp />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}

function Loading() {
  return (
    <div className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2">
      <div className="panel p-6 md:p-8">
        <StatusLine>Loading</StatusLine>
      </div>
      <div className="panel p-6 md:p-8">
        <StatusLine>Loading</StatusLine>
      </div>
    </div>
  );
}

function SealApp() {
  const params = useSearchParams();
  const id = params.get("id")?.trim() ?? "";
  return (
    // minmax(0,1fr) below lg: an auto track would take the .qseal preview's min-content and widen both panels past a phone's edge.
    <div className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 lg:items-start">
      <SignPanel />
      <VerifyPanel initialId={id} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Document input (shared by both panels)                              */
/* ------------------------------------------------------------------ */

interface DocSource {
  kind: "text" | "file";
  name: string;
  size: number;
  /** hex sha256 */
  hash: string;
}

const INPUT =
  "w-full rounded-xl border border-line bg-ink px-3.5 py-2.5 font-mono text-sm text-paper placeholder:text-mute/70 focus:border-paper/50";
const FILE_INPUT =
  "block w-full font-mono text-xs text-mute file:mr-3 file:rounded-full file:border file:border-line file:bg-transparent file:px-3 file:py-1.5 file:font-mono file:text-[11px] file:uppercase file:tracking-[0.14em] file:text-paper";

function textSource(text: string): DocSource | null {
  if (text.length === 0) return null;
  const bytes = utf8(text);
  return { kind: "text", name: "message.txt", size: bytes.length, hash: hashBytes(bytes) };
}

interface DocInputProps {
  label: string;
  value: DocSource | null;
  onChange: (doc: DocSource | null) => void;
  disabled?: boolean;
  placeholder: string;
}

function DocInput({ label, value, onChange, disabled = false, placeholder }: DocInputProps) {
  const [kind, setKind] = useState<"text" | "file">("text");
  const [text, setText] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchKind = (k: "text" | "file") => {
    setKind(k);
    setError(null);
    onChange(k === "text" ? textSource(text) : null);
  };

  const onText = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    onChange(textSource(e.target.value));
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setError(null);
    if (!file) {
      onChange(null);
      return;
    }
    setReading(true);
    try {
      const bytes = await readFileBytes(file);
      onChange({ kind: "file", name: file.name, size: file.size, hash: hashBytes(bytes) });
    } catch (err) {
      onChange(null);
      setError(describeError(err));
    } finally {
      setReading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        <div className="flex gap-1.5">
          {(["text", "file"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => switchKind(k)}
              aria-pressed={kind === k}
              disabled={disabled}
              className={`chip !py-1 transition-colors ${kind === k ? "!border-paper bg-paper/10" : "hover:!border-paper/40"}`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {kind === "text" ? (
        <textarea
          value={text}
          onChange={onText}
          disabled={disabled}
          rows={5}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={label}
          className={`${INPUT} mt-3`}
        />
      ) : (
        <input
          type="file"
          onChange={(e) => void onFile(e)}
          disabled={disabled || reading}
          aria-label={label}
          className={`${FILE_INPUT} mt-3`}
        />
      )}

      <div className="mt-2 min-h-[1.25rem] font-mono text-[11px] text-mute">
        {reading ? (
          <StatusLine>Hashing in the browser</StatusLine>
        ) : value ? (
          // break-words, not break-all: on a phone the line wraps between fields, not inside the hash.
          <span className="break-words">
            {value.name} · {formatBytes(value.size)} ·{" "}
            <span className="whitespace-nowrap">sha256 {truncate(value.hash, 10, 8)}</span>
          </span>
        ) : (
          <span>Nothing is uploaded. Only the sha256 hash is used.</span>
        )}
      </div>
      {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sign                                                                */
/* ------------------------------------------------------------------ */

function previewSeal(seal: QSeal): string {
  const short = (s: string) => (s.length > 24 ? `${s.slice(0, 12)}…${s.slice(-8)}` : s);
  const view: Record<string, unknown> = {
    v: seal.v,
    hash_alg: seal.hash_alg,
    doc_hash: short(seal.doc_hash),
    passport: short(seal.passport),
    dsa_pk: short(seal.dsa_pk),
    sig_alg: seal.sig_alg,
    signature: short(seal.signature),
    signed_at: seal.signed_at,
  };
  if (seal.name !== undefined) view.name = seal.name;
  if (seal.anchor_tx !== undefined) view.anchor_tx = short(seal.anchor_tx);
  return JSON.stringify(view, null, 2);
}

function safeFileName(name: string): string {
  // "otc terms: v2/final" -> "otc terms-v2-final", not "otc terms- v2-final".
  const base = name
    .replace(/\.qseal$/i, "")
    .replace(/\s*[\\/:*?"<>|]+\s*/g, "-")
    .trim();
  return base.length > 0 ? base : "document";
}

function SignPanel() {
  const session = useSession();
  const ready = session.passport !== null && session.keys !== null;

  const [doc, setDoc] = useState<DocSource | null>(null);
  const [name, setName] = useState("");
  const [seal, setSeal] = useState<QSeal | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDoc = (d: DocSource | null) => {
    setDoc(d);
    setSeal(null);
    setPublishedId(null);
    setError(null);
  };

  const sealName = safeFileName(name.trim() || doc?.name || "document");

  const sign = () => {
    if (!doc || !session.passport || !session.keys) return;
    setError(null);
    try {
      const s = createSeal(doc.hash, session.passport, session.keys.dsaSk, {
        name: sealName,
        anchorTx: session.anchorTx ?? undefined,
      });
      setSeal(s);
      setPublishedId(null);
    } catch (e) {
      setError(describeError(e));
    }
  };

  const download = () => {
    if (!seal) return;
    downloadText(`${sealName}.qseal`, JSON.stringify(seal, null, 2));
  };

  const publish = async () => {
    if (!seal) return;
    setBusy("Publishing to the registry");
    setError(null);
    try {
      const res = await registerSeal(seal);
      setPublishedId(res.id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const link = publishedId ? `/seal?id=${encodeURIComponent(publishedId)}` : null;

  return (
    <section className="panel min-w-0 p-6 md:p-8" aria-labelledby="sign-heading">
      {/* min-h-8 on both panel headers: the chip here is taller than the eyebrow there, and the two titles must line up. */}
      <div className="flex min-h-8 items-center justify-between gap-4">
        <span id="sign-heading" className="eyebrow">
          Sign
        </span>
        <span className="chip">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-signal" : "bg-mute"}`} />
          {ready && session.passport ? `|${truncate(session.passport.wallet)}⟩` : "no keys"}
        </span>
      </div>

      {!ready ? (
        <div className="mt-5">
          <p className="text-sm leading-relaxed text-mute">
            Sealing needs the passport keys in this browser session.{" "}
            {session.passport
              ? "Your passport is known, but its secret keys are not loaded."
              : "No passport in this session yet."}
          </p>
          <Link href="/passport" className="pill mt-5">
            {session.passport ? "Restore keys" : "Create passport"}
          </Link>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          <DocInput
            label="Document"
            value={doc}
            onChange={onDoc}
            disabled={busy !== null}
            placeholder="Paste the text to seal: OTC terms, a statement, a proposal…"
          />

          <div>
            <label htmlFor="seal-name" className="eyebrow">
              Name · optional
            </label>
            <input
              id="seal-name"
              type="text"
              value={name}
              onChange={(e) => {
                // The name is signed into the seal, so a new name needs a new seal.
                setName(e.target.value);
                setSeal(null);
                setPublishedId(null);
              }}
              placeholder={doc?.name ?? "otc-terms"}
              disabled={busy !== null}
              className={`${INPUT} mt-3`}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={sign} disabled={!doc || busy !== null} className="pill disabled:opacity-50">
              Seal with ML-DSA-65
            </button>
            {seal && (
              <span className="stamp text-paper !text-[10px]">Sealed</span>
            )}
          </div>

          {seal && (
            <div className="border-t border-line pt-6">
              <div className="flex items-center justify-between gap-4">
                {/* A file name keeps its case; the eyebrow would print it as OTC-TERMS.QSEAL. */}
                <span className="min-w-0 truncate font-mono text-[11px] text-paper">{sealName}.qseal</span>
                <span className="eyebrow shrink-0">json</span>
              </div>
              <pre className="mt-4 overflow-x-auto rounded-xl border border-line bg-ink px-4 py-3 font-mono text-[11px] leading-6 text-mute">
                {previewSeal(seal)}
              </pre>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button type="button" onClick={download} className="pill pill-ghost">
                  Download .qseal
                </button>
                <button
                  type="button"
                  onClick={() => void publish()}
                  disabled={busy !== null || publishedId !== null}
                  className="pill pill-ghost disabled:opacity-50"
                >
                  {publishedId ? "Published" : busy ? "Publishing…" : "Publish verification link"}
                </button>
              </div>
              {busy && <StatusLine className="mt-3">{busy}</StatusLine>}
              {link && (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3">
                  <Link href={link} className="break-all font-mono text-sm text-paper underline-offset-4 hover:underline">
                    {link}
                  </Link>
                  <CopyButton value={() => `${window.location.origin}${link}`} label="verification link" />
                </div>
              )}
              <p className="mt-4 text-xs leading-relaxed text-mute">
                The file holds the hash, the signature and your public key, not the document. Anyone
                with the original can verify it offline; the link lets them fetch the seal from the
                registry instead of the file.
              </p>
            </div>
          )}
        </div>
      )}
      {error && <ErrorNote className="mt-4">{error}</ErrorNote>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Verify                                                              */
/* ------------------------------------------------------------------ */

interface Registry {
  wallet: string;
  history: PassportHistory;
  /** unix ms when the history arrived: the verifier's clock for the "signed in the future" check */
  fetchedAt: number;
}

/** A loaded seal; `publishedAt` is the registry's receipt time when known (null: never published). */
interface LoadedSeal {
  source: string;
  seal: QSeal;
  publishedAt?: number | null;
}

type Verdict =
  | "invalid"
  | "pending"
  | "modified"
  | "checking"
  | "unchecked"
  | "verified"
  | "earlier"
  | "unproven"
  | "unbound"
  | "mismatch";

/** The main verdict: signature and document first, then which passport version, if any, the key belongs to. */
function verdictOf(
  sealOk: boolean | null,
  docMatch: boolean | null,
  identity: SealIdentity | "loading" | "unreachable",
): Verdict {
  if (sealOk === false) return "invalid";
  if (docMatch === null) return "pending";
  if (!docMatch) return "modified";
  if (identity === "loading") return "checking";
  if (identity === "unreachable") return "unchecked";
  if (identity.status === "earlier" && !identity.proven) return "unproven";
  return identity.status;
}

const VERDICT_TITLE: Record<Verdict, string> = {
  invalid: "Invalid",
  pending: "Add the original",
  modified: "Modified",
  checking: "Checking the registry",
  unchecked: "Registry unreachable",
  verified: "Verified identity",
  earlier: "Verified identity · earlier key",
  unproven: "Retired key · date unproven",
  unbound: "Unbound signature",
  mismatch: "Identity mismatch",
};

const VERDICT_STAMP: Record<Verdict, string> = {
  invalid: "Invalid",
  pending: "Sealed",
  modified: "Modified",
  checking: "Checking",
  unchecked: "Unchecked",
  verified: "Verified",
  earlier: "Earlier key",
  unproven: "Unproven",
  unbound: "Unbound",
  mismatch: "Mismatch",
};

/** Signal colour for a verified identity only; a mismatch is the one inverted stamp. */
const VERDICT_STYLE: Record<Verdict, string> = {
  invalid: "text-paper",
  pending: "text-mute",
  modified: "text-paper",
  checking: "text-mute",
  unchecked: "text-paper",
  verified: "text-signal",
  earlier: "text-paper",
  unproven: "text-paper",
  unbound: "text-mute",
  mismatch: "!border-paper bg-paper text-ink",
};

/** The seal id, or null for a file whose fields cannot be put in canonical form (e.g. a non-finite number). */
function safeSealId(seal: QSeal): string | null {
  try {
    return sealId(seal);
  } catch {
    return null;
  }
}

function parseSealJson(text: string): QSeal {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This is not a .qseal file (invalid JSON).");
  }
  if (typeof data !== "object" || data === null) throw new Error("This is not a .qseal file.");
  // The fields the panel renders directly must have the right type; everything else is reported by verifySeal.
  const s = data as Record<string, unknown>;
  if (typeof s.passport !== "string" || (s.name !== undefined && typeof s.name !== "string")) {
    throw new Error("This is not a Dirac .qseal file.");
  }
  return data as QSeal;
}

const BAD_SEAL_ID = "A seal id is 64 hex characters. Paste the id or the whole verification link.";

/** The seal id in what was pasted: the id itself or a verification link carrying `?id=`; null when there is none. */
function parseSealId(input: string): string | null {
  let id = input.trim();
  const fromLink = /[?&]id=([^&#\s]+)/.exec(id);
  if (fromLink) {
    try {
      id = decodeURIComponent(fromLink[1]);
    } catch {
      return null;
    }
  }
  return /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : null;
}

function VerifyPanel({ initialId }: { initialId: string }) {
  const [seal, setSeal] = useState<LoadedSeal | null>(null);
  /** The registry's receipt of a seal loaded from a file, looked up by its id. */
  const [receipt, setReceipt] = useState<{ id: string; at: number | null } | null>(null);
  const [sealError, setSealError] = useState<string | null>(null);
  /** Key of the last registry request whose fetch has settled (ok or error). */
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [idInput, setIdInput] = useState("");
  const [doc, setDoc] = useState<DocSource | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [registryError, setRegistryError] = useState<{ wallet: string; message: string } | null>(null);
  /** The id typed in the field; `n` makes a second Load of the same id fetch again. */
  const [request, setRequest] = useState<{ id: string; n: number } | null>(null);

  const linkedId = initialId.length > 0 ? parseSealId(initialId) : null;
  const active = request ?? (linkedId ? { id: linkedId, n: 0 } : null);
  const activeId = active?.id ?? null;
  const activeKey = active ? `${active.id}#${active.n}` : null;
  const fetching = activeKey !== null && settledKey !== activeKey;
  // A `/seal?id=` link with a malformed id is reported without asking the registry.
  const shownError = sealError ?? (!request && initialId.length > 0 && !linkedId ? BAD_SEAL_ID : null);

  // Seal from the registry, for `/seal?id=…` links and the id field.
  useEffect(() => {
    if (!activeId || !activeKey) return;
    let cancelled = false;
    fetchSeal(activeId)
      .then((res) => {
        if (cancelled) return;
        if (res) {
          setSeal({ source: `registry · ${truncate(activeId, 8, 6)}`, seal: res.seal, publishedAt: res.registered_at });
          setSealError(null);
        } else {
          // Never leave the previous seal's verdict under an id that was not found.
          setSeal(null);
          setSealError(`No seal with id ${truncate(activeId, 8, 6)} in the registry.`);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSeal(null);
        setSealError(describeError(e));
      })
      .finally(() => {
        if (!cancelled) setSettledKey(activeKey);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, activeKey]);

  // Which version of the wallet's passport, if any, the signing key belongs to: the whole history,
  // so a seal made before a rotation is placed on the key that was current then.
  const signer = seal?.seal.passport ?? null;
  useEffect(() => {
    if (!signer) return;
    let cancelled = false;
    fetchPassportHistory(signer)
      .then((history) => {
        if (cancelled) return;
        setRegistry({ wallet: signer, history, fetchedAt: Date.now() });
        setRegistryError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setRegistryError({ wallet: signer, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [signer]);

  // When the registry first received this exact seal: it existed by then, whatever signed_at says.
  // A seal fetched by id already carries it; a file is looked up by its id.
  const sid = useMemo(() => (seal ? safeSealId(seal.seal) : null), [seal]);
  const knownReceipt = seal?.publishedAt;
  useEffect(() => {
    if (!sid || knownReceipt !== undefined) return;
    let cancelled = false;
    fetchSeal(sid)
      .then((res) => {
        if (!cancelled) setReceipt({ id: sid, at: res ? res.registered_at : null });
      })
      .catch(() => {
        // Unreachable: no receipt to rely on, so an earlier key's seal stays unproven.
        if (!cancelled) setReceipt({ id: sid, at: null });
      });
    return () => {
      cancelled = true;
    };
  }, [sid, knownReceipt]);
  const publishedAt: number | null | undefined =
    knownReceipt !== undefined ? knownReceipt : sid === null ? null : receipt?.id === sid ? receipt.at : undefined;

  const onSealFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSealError(null);
    try {
      const text = new TextDecoder().decode(await readFileBytes(file));
      setSeal({ source: file.name, seal: parseSealJson(text) });
    } catch (err) {
      // The rows below must not keep showing the previous seal next to this file's error.
      setSeal(null);
      setSealError(describeError(err));
    }
  };

  const loadById = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (idInput.trim().length === 0) return;
    const id = parseSealId(idInput);
    if (!id) {
      setSealError(BAD_SEAL_ID);
      return;
    }
    setSealError(null);
    setRequest((r) => ({ id, n: (r?.n ?? 0) + 1 }));
  };

  const check = useMemo(() => (seal ? verifySeal(seal.seal) : null), [seal]);
  const docMatch = seal && doc ? seal.seal.doc_hash === doc.hash : null;

  const current = signer && registry?.wallet === signer ? registry : null;
  const history = current?.history ?? null;
  const lookupError = signer && registryError?.wallet === signer ? registryError.message : null;
  const identity: SealIdentity | "loading" | "unreachable" = useMemo(() => {
    if (!seal) return "loading";
    if (lookupError) return "unreachable";
    if (!current || publishedAt === undefined) return "loading";
    return sealIdentity(
      seal.seal,
      current.history.versions.map((v) => ({
        version: v.version,
        dsa_pk: v.passport.dsa_pk,
        registered_at: v.registered_at,
        superseded_at: v.superseded_at,
        created_at: v.passport.created_at,
      })),
      { now: current.fetchedAt, publishedAt },
    );
  }, [seal, current, lookupError, publishedAt]);
  const matched: PassportVersion | null =
    history && typeof identity === "object" && "version" in identity
      ? (history.versions.find((v) => v.version === identity.version) ?? null)
      : null;
  const verdict: Verdict | null = seal ? verdictOf(check?.ok ?? null, docMatch, identity) : null;

  const s = seal?.seal ?? null;

  return (
    <section className="panel min-w-0 p-6 md:p-8" aria-labelledby="verify-heading">
      <div className="flex min-h-8 items-center justify-between gap-4">
        <span id="verify-heading" className="eyebrow">
          Verify
        </span>
        <span className="eyebrow">offline-capable</span>
      </div>

      <div className="mt-6">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Seal</span>
          {seal && <span className="font-mono text-[11px] text-mute">{seal.source}</span>}
        </div>
        {/* Remounted on each id request, so the picker does not keep naming a file that is no longer shown. */}
        <input
          key={request?.n ?? 0}
          type="file"
          accept=".qseal,application/json,.json"
          onChange={(e) => void onSealFile(e)}
          aria-label="Seal file"
          className={`${FILE_INPUT} mt-3`}
        />
        {/* Stacked on a phone, like the wallet lookup on /p, so the placeholder is not cut mid-word. */}
        <form onSubmit={loadById} className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            placeholder="or paste a seal link or id"
            aria-label="Seal link or id"
            spellCheck={false}
            autoComplete="off"
            className={INPUT}
          />
          <button
            type="submit"
            disabled={idInput.trim().length === 0 || fetching}
            className="pill pill-ghost shrink-0 justify-center !px-4 !py-2 disabled:opacity-50"
          >
            Load
          </button>
        </form>
        {fetching && activeId && (
          <StatusLine className="mt-3">Fetching seal {truncate(activeId, 8, 6)}</StatusLine>
        )}
        {shownError && <ErrorNote className="mt-3">{shownError}</ErrorNote>}
      </div>

      <div className="mt-6">
        <DocInput
          label="Original document"
          value={doc}
          onChange={setDoc}
          placeholder="Paste the original text to compare with the seal…"
        />
      </div>

      {s && (
        <div className="relative mt-6 border-t border-line pt-6">
          <dl>
            <Row label="Signature">
              {check?.ok ? "valid · ML-DSA-65" : `invalid · ${check?.reason ?? "unknown"}`}
            </Row>
            <Row label="Document">
              {docMatch === null
                ? "add the original to compare"
                : docMatch
                  ? "unchanged · sha256 matches"
                  : "modified · sha256 differs"}
            </Row>
            <Row label="Signed by">
              <Link
                href={`/p?a=${encodeURIComponent(s.passport)}`}
                className="underline-offset-4 hover:underline"
                title={s.passport}
              >
                |{truncate(s.passport)}⟩
              </Link>
            </Row>
            <Row label="Signed at">{formatUtc(s.signed_at * 1000)}</Row>
            {s.name && <Row label="Name">{s.name}</Row>}
            <Row label="Identity">
              <IdentityLine
                identity={identity}
                error={lookupError}
                matched={matched}
                truncated={history?.truncated ?? false}
              />
            </Row>
            <Row label="Published">
              {publishedAt === undefined ? (
                <span className="text-mute">checking the registry…</span>
              ) : publishedAt === null ? (
                <span className="text-mute">not in the registry · nothing but the seal itself states its date</span>
              ) : (
                <>
                  {formatUtc(publishedAt)}
                  <span className="text-mute"> · the registry received it then</span>
                </>
              )}
            </Row>
            {sid && (
              <Row label="Seal id">
                <span className="inline-flex flex-wrap items-center gap-2">
                  {truncate(sid, 10, 8)}
                  <CopyButton value={sid} label="seal id" />
                </span>
              </Row>
            )}
          </dl>

          {verdict && (
            <div className="mt-6 flex items-center justify-between gap-4">
              <div className="min-w-0 max-w-sm">
                <div className="text-sm font-medium text-paper">{VERDICT_TITLE[verdict]}</div>
                <p className="mt-1 text-xs leading-relaxed text-mute">
                  <VerdictText verdict={verdict} identity={identity} />
                </p>
              </div>
              <span className={`stamp shrink-0 ${VERDICT_STYLE[verdict]}`}>{VERDICT_STAMP[verdict]}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The anchor of the passport version the key belongs to, verified or not. */
function VersionAnchor({ v }: { v: PassportVersion }) {
  if (!v.anchor_tx) return <span className="text-mute"> · not anchored</span>;
  if (!v.anchor_verified) return <span className="text-mute"> · anchor unverified</span>;
  return (
    <>
      {" · "}
      <a
        href={explorerTx(v.anchor_tx)}
        target="_blank"
        rel="noreferrer"
        className="text-paper underline-offset-4 hover:underline"
        title={v.anchor_tx}
      >
        anchored{v.anchor_time !== null ? ` ${formatUtc(v.anchor_time)}` : ""} ↗
      </a>
    </>
  );
}

interface IdentityLineProps {
  identity: SealIdentity | "loading" | "unreachable";
  error: string | null;
  matched: PassportVersion | null;
  truncated: boolean;
}

/** Which version of the wallet's passport the seal's key belongs to, in one line. */
function IdentityLine({ identity, error, matched, truncated }: IdentityLineProps) {
  if (identity === "unreachable") {
    return <span className="text-mute">could not reach the registry · {error ?? "unknown error"} · the key is unchecked</span>;
  }
  if (identity === "loading") return <span className="text-mute">reading the passport history…</span>;
  switch (identity.status) {
    case "unbound":
      return <>no passport for this wallet · only proves that someone holding this key signed</>;
    case "verified":
      return (
        <>
          key of version {identity.version}, the wallet&apos;s current passport
          {matched && <VersionAnchor v={matched} />}
        </>
      );
    case "earlier":
      return (
        <>
          key of version {identity.version}, replaced {formatUtc(identity.rotatedAt)}
          <span className="text-mute">
            {identity.proven ? " · published before the rotation" : " · not shown to predate the rotation"}
          </span>
          {matched && <VersionAnchor v={matched} />}
        </>
      );
    case "mismatch":
      if (identity.reason === "future") {
        return (
          <>
            key of version {identity.version}, but the stated signing time is later than now or than the
            registry&apos;s receipt of the seal
          </>
        );
      }
      if (identity.reason === "outside-window") {
        return (
          <>
            key of version {identity.version}, current from {formatUtc(identity.registeredAt)}
            {identity.rotatedAt !== null ? ` to ${formatUtc(identity.rotatedAt)}` : ""}, not at the stated signing time
          </>
        );
      }
      return truncated ? (
        <>key is not among the newest versions of this wallet&apos;s passport</>
      ) : (
        <>key is not any version of the passport registered for this wallet</>
      );
  }
}

/** The sentence under the verdict. */
function VerdictText({ verdict, identity }: { verdict: Verdict; identity: SealIdentity | "loading" | "unreachable" }) {
  switch (verdict) {
    case "invalid":
      return <>The seal does not verify. It was tampered with or is not a Dirac seal.</>;
    case "pending":
      return <>Add the original text or file to compare its hash with the seal.</>;
    case "modified":
      return <>The signature is fine, but this is not the signed document, or it changed after sealing.</>;
    case "checking":
      return <>Signature and document check out. Looking up which passport the key belongs to.</>;
    case "unchecked":
      return (
        <>
          Signature and document check out, but the registry could not be reached, so whether the key
          belongs to this wallet&apos;s passport is unknown.
        </>
      );
    case "verified":
      return (
        <>
          The signature verifies, the document matches, and the key belongs to the wallet&apos;s passport
          that was current at the signing time.
        </>
      );
    case "earlier":
      return (
        <>
          The signature verifies and the document matches. The key belonged to this wallet&apos;s passport
          at the stated signing time and was replaced
          {typeof identity === "object" && identity.status === "earlier" ? ` on ${formatUtc(identity.rotatedAt)}` : ""}.
          The registry received this seal before that, so its date is not only the signer&apos;s word.
        </>
      );
    case "unproven":
      return (
        <>
          The signature verifies and the document matches, and the key belonged to this wallet&apos;s
          passport until
          {typeof identity === "object" && identity.status === "earlier" ? ` ${formatUtc(identity.rotatedAt)}` : " its rotation"}.
          Nothing shows the seal existed before then: whoever holds a retired key can date a seal into
          its old window. Ask for a seal from the current key, or one published before the rotation.
        </>
      );
    case "unbound":
      return (
        <>
          The signature verifies and the document matches, but this wallet has no passport. The seal
          proves only that someone holding this key signed this hash, not who.
        </>
      );
    case "mismatch": {
      const reason = typeof identity === "object" && identity.status === "mismatch" ? identity.reason : "unknown-key";
      return (
        <>
          {reason === "future"
            ? "The signature and document check out, but the stated signing time is later than now or than the registry's receipt of the seal, so it is not a time the seal was made."
            : reason === "outside-window"
              ? "The signature and document check out, but the key was not this wallet's passport key at the stated signing time."
              : "The signature and document check out, but the key is not this wallet's passport key."}{" "}
          Do not treat this seal as signed by the wallet it names.
        </>
      );
    }
  }
}

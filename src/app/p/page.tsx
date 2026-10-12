"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import BadgeEmbed, { useSiteOrigin } from "@/components/app/BadgeEmbed";
import PassportDocument, { formatUtc, MODE_LABEL } from "@/components/app/PassportDocument";
import PassportShareCard from "@/components/app/PassportShareCard";
import PetBadges from "@/components/pet/PetBadges";
import { CopyButton, ErrorNote, Row, StatusLine, describeError } from "@/components/app/ui";
import { fetchPassport, fetchPassportHistory, type PassportHistory, type PassportRecord, type PassportVersion } from "@/lib/api";
import type { ArenaBadge } from "@/lib/arena";
import { fetchArenaBadges } from "@/lib/arenaApi";
import { inviteBlinkUrl } from "@/lib/blink";
import { fetchInvites, isWalletAddress } from "@/lib/inbox";
import { fingerprint, passportHash, verifyRotation, verifySelf, verifyWalletSig } from "@/lib/pq";
import { truncate } from "@/lib/solana/format";
import { explorerAddress, explorerTx } from "@/lib/solana/rpc";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function PublicPassportPage() {
  return (
    <>
      <Nav />
      {/* w-full: body is a flex column, so an auto-margined main would shrink to its content. */}
      <main className="relative z-10 mx-auto w-full max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <Suspense fallback={<Shell address={null} />}>
          <PublicPassport />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}

const INPUT =
  "w-full rounded-xl border border-line bg-ink px-3.5 py-2.5 font-mono text-sm text-paper placeholder:text-mute/70 focus:border-paper/50";

interface Lookup {
  wallet: string;
  record: PassportRecord | null;
}

function PublicPassport() {
  const params = useSearchParams();
  const raw = params.get("a")?.trim() ?? "";
  // A malformed address never reaches the registry: the lookup form comes back with it and a plain reason.
  const address = isWalletAddress(raw) ? raw : "";

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [failure, setFailure] = useState<{ wallet: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [invites, setInvites] = useState<{ wallet: string; count: number } | null>(null);
  const [history, setHistory] = useState<{ wallet: string; history: PassportHistory } | null>(null);
  const [historyFailure, setHistoryFailure] = useState<{ wallet: string; message: string } | null>(null);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchPassport(address)
      .then((record) => {
        if (cancelled) return;
        setLookup({ wallet: address, record });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ wallet: address, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [address, attempt]);

  const record = address && lookup?.wallet === address ? lookup.record : undefined;
  // The history is read once the record is in: the record read re-checks an unverified anchor
  // first, so both panels then show the same anchor state.
  const recordKey = record ? `${record.hash}:${record.anchor_verified}` : null;

  // Every version of the passport, for the history panel.
  useEffect(() => {
    if (!address || !recordKey) return;
    let cancelled = false;
    fetchPassportHistory(address)
      .then((h) => {
        if (cancelled) return;
        setHistory({ wallet: address, history: h });
        setHistoryFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setHistoryFailure({ wallet: address, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [address, recordKey, attempt]);

  // Who invited this wallet; a missing count is not worth an error on the page.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchInvites(address)
      .then((r) => {
        if (!cancelled) setInvites({ wallet: address, count: r.count });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [address, attempt]);

  const error = address && failure?.wallet === address ? failure.message : null;
  const versions = address && history?.wallet === address ? history.history : null;
  const historyError = address && historyFailure?.wallet === address ? historyFailure.message : null;
  const loading = !!address && record === undefined && !error;
  const inviteCount = address && invites?.wallet === address ? invites.count : 0;
  const writePath = `/write?to=${encodeURIComponent(address)}`;

  // Every reader re-checks the record: both signatures and the hash, in the browser.
  const checks = useMemo(() => {
    if (!record) return null;
    const p = record.passport;
    return {
      self: verifySelf(p, record.self_sig),
      wallet: verifyWalletSig(p, record.wallet_sig),
      hash: passportHash(p) === record.hash,
    };
  }, [record]);

  return (
    <Shell address={address || null}>
      {!address && <AddressForm key={raw} initial={raw} />}

      {loading && (
        <div className="panel p-6 md:p-8">
          <span className="eyebrow">Registry</span>
          <StatusLine className="mt-4">Fetching the passport of {truncate(address)}</StatusLine>
        </div>
      )}

      {error && (
        <div className="panel p-6 md:p-8">
          <span className="eyebrow">Registry</span>
          <ErrorNote className="mt-4">{error}</ErrorNote>
          <button
            type="button"
            onClick={() => {
              setFailure(null);
              setAttempt((n) => n + 1);
            }}
            className="pill pill-ghost mt-4 !px-4 !py-2"
          >
            Try again
          </button>
        </div>
      )}

      {record === null && (
        <div className="panel p-6 md:p-8">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Not found</span>
            <a
              href={explorerAddress(address)}
              target="_blank"
              rel="noreferrer"
              className="eyebrow transition-colors hover:text-paper"
            >
              explorer ↗
            </a>
          </div>
          <div className="mt-6 break-all font-serif text-3xl leading-none md:text-4xl">
            <span className="text-mute">|</span>
            {truncate(address)}
            <span className="text-mute">⟩</span>
          </div>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-mute">
            No passport is registered for this wallet. Its assets and signatures depend on Ed25519
            alone. If it is yours, issue a passport in a minute.
          </p>
          {/* Pet badges belong to the wallet, not the passport: a wallet signs gates with or without one. */}
          <dl className="mt-5">
            <PetBadges wallet={address} />
            <ArenaBadgesRow wallet={address} />
          </dl>
          {inviteCount > 0 && <InvitedBy count={inviteCount} className="mt-4" />}
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href="/passport" className="pill">
              Create passport
            </Link>
            <Link href={writePath} className="pill pill-ghost">
              Invite this wallet
            </Link>
            <Link href="/" className="pill pill-ghost">
              What is a passport?
            </Link>
          </div>
          <InviteLink wallet={address} />
        </div>
      )}

      {record && checks && (
        <>
          <PassportDocument
            passport={record.passport}
            anchorTx={record.anchor_tx}
            anchorVerified={record.anchor_verified}
            anchorTime={record.anchor_time}
            version={record.version}
          />

          <PassportShareCard passport={record.passport} anchored={record.anchor_verified} />

          <BadgeEmbed
            wallet={record.passport.wallet}
            mode={record.passport.mode}
            anchored={record.anchor_verified}
            version={`${record.hash.slice(0, 12)}${record.anchor_verified ? "a" : "u"}`}
          />

          <div className="panel p-6 md:p-8">
            <div className="flex items-center justify-between gap-4">
              <span className="eyebrow">Checked in your browser</span>
              <span className="chip shrink-0 whitespace-nowrap">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${checks.self && checks.wallet && checks.hash ? "bg-signal" : "bg-mute"}`}
                />
                {checks.self && checks.wallet && checks.hash ? "all checks pass" : "check failed"}
              </span>
            </div>
            <dl className="mt-4">
              <Row label="Self-signature">
                {checks.self ? "valid · ML-DSA-65 over the canonical passport" : "invalid · the passport does not sign itself"}
              </Row>
              <Row label="Wallet binding">
                {checks.wallet ? "valid · Ed25519 signature by the wallet" : "invalid · the wallet signature does not verify"}
              </Row>
              <Row label="Hash">{checks.hash ? "matches the registry record" : "does not match the registry record"}</Row>
              <Row label="Mode">
                {MODE_LABEL[record.passport.mode]}
                <span className="text-mute">
                  {record.passport.mode === "simple"
                    ? " · keys derived from a wallet signature, not Q-Day safe"
                    : " · independent keys, no Ed25519 dependence"}
                </span>
              </Row>
              <Row label="Anchor">
                <AnchorLine tx={record.anchor_tx} verified={record.anchor_verified} time={record.anchor_time} />
              </Row>
              <Row label="Registered">
                {formatUtc(record.registered_at)}
                {record.version > 1 && <span className="text-mute"> · version {record.version}</span>}
              </Row>
              <Row label="Wallet">
                <span className="inline-flex flex-wrap items-center gap-2">
                  <a
                    href={explorerAddress(record.passport.wallet)}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all underline-offset-4 hover:underline"
                  >
                    {record.passport.wallet}
                  </a>
                  <CopyButton value={record.passport.wallet} label="wallet address" />
                </span>
              </Row>
              <PetBadges wallet={record.passport.wallet} />
              <ArenaBadgesRow wallet={record.passport.wallet} />
            </dl>
            <p className="mt-5 text-xs leading-relaxed text-mute">
              The registry only stores what the wallet and the passport signed. A reader can re-run
              these checks without trusting it. A verified anchor shows the record existed by its block
              time, independent of the registry.
            </p>
          </div>

          <HistoryPanel history={versions} error={historyError} />

          <div className="panel p-6 md:p-8">
            <span className="eyebrow">Inbox</span>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
              A letter to this passport is encrypted in your browser with its ML-KEM-768 key. The
              registry stores the sealed envelope and your wallet address; only the holder can read it.
            </p>
            {inviteCount > 0 && <InvitedBy count={inviteCount} className="mt-4" />}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link href={writePath} className="pill">
                Write to this passport
              </Link>
            </div>
            <p className="mt-5 max-w-md text-xs leading-relaxed text-mute">
              A friend without a passport? Their wallet&apos;s page here carries an invite link to send them.{" "}
              <Link href="/p" className="whitespace-nowrap text-paper underline-offset-4 hover:underline">
                Look up a wallet →
              </Link>
            </p>
          </div>

          <div className="panel p-6 md:p-8">
            <span className="eyebrow">Documents</span>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
              Seals signed with this passport carry its ML-DSA-65 key. Verify one against the original
              text or file; nothing is uploaded.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Link href="/seal" className="pill">
                Verify a document from this passport
              </Link>
              <CopyButton value={() => window.location.href} label="page link" text="copy link" className="!px-3 !py-1.5" />
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** "invited by 3 wallets": the registry's count of invite transactions to this address. */
function InvitedBy({ count, className = "" }: { count: number; className?: string }) {
  return (
    <p className={`font-mono text-[11px] text-mute ${className}`}>
      invited by <span className="text-paper tnum">{count}</span> {count === 1 ? "wallet" : "wallets"}
    </p>
  );
}

/**
 * An anchor as the registry reports it: "verified" only when the Worker found the memo on chain
 * from this wallet; a named transaction it has not found yet stays "unverified".
 */
function AnchorLine({ tx, verified, time }: { tx: string | null; verified: boolean; time: number | null }) {
  if (!tx) return <span className="text-mute">not anchored on Solana yet</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <a
        href={explorerTx(tx)}
        target="_blank"
        rel="noreferrer"
        className="underline-offset-4 hover:underline"
        title={tx}
      >
        tx {truncate(tx, 6, 6)} ↗
      </a>
      <span className="text-mute">
        {verified
          ? `verified on chain${time !== null ? ` · block time ${formatUtc(time)}` : ""}`
          : "anchor unverified · the registry has not found this memo on chain yet"}
      </span>
    </span>
  );
}

/** What a version's rotation signature says, re-checked here against the previous version's key. */
function rotationNote(v: PassportVersion, prev: PassportVersion | undefined): string {
  if (v.version === 1) return "first passport of this wallet";
  if (!v.rotation_sig) return "replaced without a signature from the previous key (registered before the rotation rule)";
  if (!prev) return "rotated with a signature from the previous key · previous version not listed, not re-checked";
  return verifyRotation(prev.passport, v.passport, v.rotation_sig)
    ? "rotated with a signature from the previous key · checked in your browser"
    : "rotation signature does not verify against the previous key";
}

/** Every version of the passport, newest first, with its anchor and how it replaced the one before. */
function HistoryPanel({ history, error }: { history: PassportHistory | null; error: string | null }) {
  const rows = useMemo(() => {
    if (!history) return [];
    const byVersion = new Map(history.versions.map((v) => [v.version, v]));
    return history.versions.map((v) => ({
      v,
      fp: fingerprint(v.passport),
      hashOk: passportHash(v.passport) === v.hash,
      rotation: rotationNote(v, byVersion.get(v.version - 1)),
    }));
  }, [history]);

  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Versions</span>
        <span className="font-mono text-[11px] text-mute">
          {history ? `${history.total} ${history.total === 1 ? "version" : "versions"}` : error ? "unavailable" : "loading"}
        </span>
      </div>

      {error ? (
        <p className="mt-4 font-mono text-[11px] text-mute">history unavailable · {error}</p>
      ) : !history ? (
        <StatusLine className="mt-4">Reading the version history</StatusLine>
      ) : (
        <ol className="mt-4 divide-y divide-line">
          {rows.map(({ v, fp, hashOk, rotation }) => (
            <li key={v.version} className="grid gap-1 py-3 sm:grid-cols-[48px_minmax(0,1fr)] sm:gap-4">
              <span className="tnum font-mono text-[11px] uppercase tracking-[0.14em] text-mute">v{v.version}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm text-paper">{MODE_LABEL[v.mode]}</span>
                  <span className="chip !py-0.5">{v.superseded_at === null ? "active" : "replaced"}</span>
                  <span className="tnum font-mono text-[11px] text-mute" title={v.hash}>
                    {fp}
                    {hashOk ? "" : " · hash does not match"}
                  </span>
                </div>
                <div className="tnum mt-1 font-mono text-[11px] text-mute">
                  registered {formatUtc(v.registered_at)}
                  {v.superseded_at !== null && ` · replaced ${formatUtc(v.superseded_at)}`}
                </div>
                <div className="mt-1 font-mono text-[11px] text-mute">
                  {v.anchor_tx && v.anchor_verified ? (
                    <a
                      href={explorerTx(v.anchor_tx)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-paper underline-offset-4 hover:underline"
                      title={v.anchor_tx}
                    >
                      anchored{v.anchor_time !== null ? ` · block time ${formatUtc(v.anchor_time)}` : ""} ↗
                    </a>
                  ) : v.anchor_tx ? (
                    "anchor unverified"
                  ) : (
                    "not anchored"
                  )}
                </div>
                <div className="mt-1 font-mono text-[11px] text-mute">{rotation}</div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {history?.truncated && (
        <p className="mt-3 font-mono text-[11px] text-mute">
          showing the newest {history.versions.length} of {history.total} versions
        </p>
      )}
      <p className="mt-5 max-w-md text-xs leading-relaxed text-mute">
        A registered passport is replaced only with a signature from its current key, so a forged
        wallet signature alone cannot supersede a hardened one. A simple passport&apos;s key comes from
        a wallet signature and falls with the wallet key. Old versions stay listed so seals made
        with their keys can still be placed in time.
      </p>
    </div>
  );
}

const PLACE_LABEL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd" };

/** Tournament podium badges of the wallet (GET /api/arena/badges), one `Row` beside the pet badges. */
function ArenaBadgesRow({ wallet }: { wallet: string }) {
  const [loaded, setLoaded] = useState<{ wallet: string; badges: ArenaBadge[] } | null>(null);
  const [failure, setFailure] = useState<{ wallet: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchArenaBadges(wallet)
      .then((r) => {
        if (cancelled) return;
        setLoaded({ wallet, badges: Array.isArray(r.badges) ? r.badges : [] });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ wallet, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const badges = loaded?.wallet === wallet ? loaded.badges : null;
  const error = failure?.wallet === wallet ? failure.message : null;
  if (error) return <Row label="Arena badges">{`unavailable · ${error}`}</Row>;
  if (badges === null) return <Row label="Arena badges">…</Row>;
  if (badges.length === 0) {
    return (
      <Row label="Arena badges">
        <span className="text-mute">none yet · a top-three finish in a daily arena tournament earns one</span>
      </Row>
    );
  }
  const places = [1, 2, 3]
    .map((place) => ({ place, n: badges.filter((b) => b.place === place).length }))
    .filter((p) => p.n > 0);
  const latest = badges.reduce((a, b) => (b.day > a.day ? b : a), badges[0]);
  return (
    <Row label="Arena badges">
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        {places.map(({ place, n }) => (
          <span key={place} className="chip" title={`place ${place} in a daily tournament`}>
            {PLACE_LABEL[place]} <span className="tnum text-mute">×{n}</span>
          </span>
        ))}
        <span className="text-mute">latest {latest.day}</span>
      </span>
    </Row>
  );
}

/**
 * The "Invite to Dirac" Blink of a wallet without a passport (worker/actions.ts): where Blinks
 * render, `/invite/<wallet>` is a card with one button that sends the invite (X only once the
 * domain is in the Dialect registry, docs/CONTRACT-ACTIONS.md); anywhere else the Worker
 * redirects it to /write?to=<wallet>. Shown in the not-found state only: on a registered
 * passport it would invite the holder, who is already in.
 */
function InviteLink({ wallet }: { wallet: string }) {
  const origin = useSiteOrigin();
  const link = inviteBlinkUrl(wallet, origin);
  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="flex items-center justify-between gap-4">
        <span className="eyebrow">Share an invite link</span>
        <CopyButton value={() => inviteBlinkUrl(wallet)} label="invite link" text="copy link" className="shrink-0 !px-3 !py-1.5" />
      </div>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-mute">
        Where Blinks render, this link is a card with one button: the sender pays this wallet 0.0001 SOL
        with a memo that points to Dirac. Until the domain is in the Blink registry, only wallets that
        allow unregistered actions show the card; anywhere else the link opens the invite page here.
      </p>
      <pre className="mt-3 whitespace-pre-wrap break-all rounded-xl border border-line bg-ink px-4 py-3 font-mono text-[11px] leading-relaxed text-paper">
        {link}
      </pre>
    </div>
  );
}

function Shell({ address, children }: { address: string | null; children?: React.ReactNode }) {
  return (
    // The single column below lg is minmax(0,1fr) too: an auto track would take the record card's min-content and overflow a phone.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
      {/* The record column runs ~2000 px on desktop; the title column stays in view instead of leaving a black void (as on /lab). */}
      <div className="min-w-0 lg:sticky lg:top-28 lg:self-start">
        <ChapterHeader
          as="h1"
          index={2}
          eyebrow="Public passport"
          meta={address ? `wallet ${truncate(address)}` : "registry lookup"}
          title={
            <>
              Passport
              <br />
              <span className="display-serif text-paper-2">on public record.</span>
            </>
          }
          lede="A post-quantum identity bound to a Solana wallet: two public keys, a self-signature, a wallet signature and, once anchored, a memo transaction that fixes the date."
        />
        <p className="mt-8 max-w-md text-xs leading-relaxed text-mute">
          Note: the wallet binding uses Ed25519, so a binding made after Q-Day could be forged. An
          anchor proves only that the record existed before its block time. Once registered, a
          passport is replaced only with a signature from its current ML-DSA key. Simple mode keys
          come from a wallet signature and fall with the wallet key; hardened keys do not.
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </div>
  );
}

/** `initial` is a rejected `?a=` value: shown in the field with the reason, so it can be corrected. */
function AddressForm({ initial }: { initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(initial.length > 0);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const a = value.trim();
    if (!a) return;
    if (!isWalletAddress(a)) {
      setInvalid(true);
      return;
    }
    router.push(`/p?a=${encodeURIComponent(a)}`);
  };

  return (
    <div className="panel p-6 md:p-8">
      <span className="eyebrow">Look up a wallet</span>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
        Paste a Solana address to see whether it carries a Dirac passport. Your own page lives at
        /p?a=&lt;wallet&gt;.
      </p>
      <form onSubmit={submit} className="mt-5 flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setInvalid(false);
          }}
          placeholder="7xKq…9AsU"
          aria-label="Wallet address"
          spellCheck={false}
          autoComplete="off"
          className={INPUT}
        />
        <button type="submit" disabled={value.trim().length === 0} className="pill shrink-0 justify-center disabled:opacity-50">
          Open
        </button>
      </form>
      {invalid && (
        <ErrorNote className="mt-3">
          That is not a Solana address. A wallet address is 32 to 44 base58 characters.
        </ErrorNote>
      )}
    </div>
  );
}

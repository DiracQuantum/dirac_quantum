"use client";

/**
 * /inbox: the letters sealed to the connected wallet's passport. One wallet
 * signature over READ_MESSAGE (bound to the current minute) authorises the
 * read; the envelopes come back as ciphertext and are opened here with the
 * ML-KEM-768 secret key from the session. Without the keys the page still
 * lists senders and times and points to /passport to restore them.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import ConnectButton from "@/components/wallet/ConnectButton";
import { formatUtc } from "@/components/app/PassportDocument";
import { useSession } from "@/components/app/session";
import { CopyButton, ErrorNote, StatusLine, describeError } from "@/components/app/ui";
import {
  InboxApiError,
  READ_BUCKET_TOLERANCE,
  READ_MESSAGE,
  decryptLetter,
  deleteLetter,
  fetchInbox,
  fetchInvites,
  readBucket,
  type InboxMessage,
  type Letter,
  type LetterPayment,
} from "@/lib/inbox";
import { b64, utf8 } from "@/lib/pq";
import { truncate } from "@/lib/solana/format";
import { explorerTx } from "@/lib/solana/rpc";
import { formatUsdc } from "@/lib/solana/usdc";
import { useWallet } from "@/lib/solana/wallet";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function InboxPage() {
  return (
    <>
      <Nav />
      {/* w-full: the body is a flex column, so without it the page shrinks to its content and centres.
          z-20: the connect dropdown must paint over the footer (z-10). */}
      <main className="relative z-20 mx-auto w-full max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <InboxApp />
      </main>
      <Footer />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

/** A read signature: valid on the server for READ_BUCKET_TOLERANCE minutes either side of `bucket`. */
interface Auth {
  wallet: string;
  bucket: number;
  sig: string;
}

interface Loaded {
  wallet: string;
  list: InboxMessage[];
  /** unix ms of the fetch */
  at: number;
}

type Opened = { ok: true; letter: Letter } | { ok: false; error: string };

function InboxApp() {
  const { wallet } = useWallet();
  const session = useSession();
  const address = wallet?.address ?? null;
  // The session's keys only apply when its passport belongs to the connected wallet.
  const kemSk = address && session.passport?.wallet === address && session.keys ? session.keys.kemSk : null;

  const [auth, setAuth] = useState<Auth | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [invites, setInvites] = useState<{ wallet: string; count: number } | null>(null);

  // Invites addressed to the connected wallet; a missing count is not worth an error.
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
  }, [address]);

  const inbox = address && loaded?.wallet === address ? loaded : null;
  const inviteCount = address && invites?.wallet === address ? invites.count : 0;

  // Decrypt in the browser. Pure given the envelopes and the key, so it can live in a memo.
  const opened = useMemo(() => {
    const map = new Map<number, Opened>();
    if (!inbox || !kemSk) return map;
    for (const m of inbox.list) {
      try {
        map.set(m.id, { ok: true, letter: decryptLetter(m.envelope, kemSk) });
      } catch (e) {
        map.set(m.id, { ok: false, error: describeError(e) });
      }
    }
    return map;
  }, [inbox, kemSk]);

  /** The current read signature, or a fresh one when it is for another wallet or about to expire. */
  const getAuth = async (): Promise<Auth> => {
    if (!wallet) throw new Error("Connect a wallet first.");
    const bucket = readBucket();
    if (auth && auth.wallet === wallet.address && Math.abs(bucket - auth.bucket) < READ_BUCKET_TOLERANCE) {
      return auth;
    }
    setBusy("Waiting for the wallet to sign the read message");
    const sig = b64.encode(await wallet.signMessage(utf8(READ_MESSAGE(wallet.address, bucket))));
    const fresh: Auth = { wallet: wallet.address, bucket, sig };
    setAuth(fresh);
    return fresh;
  };

  /** A refused read signature is dropped, so the next attempt asks the wallet for a fresh one instead of resending it. */
  const fail = (e: unknown) => {
    if (e instanceof InboxApiError && e.status === 401) {
      setAuth(null);
      setError("The registry did not accept the read signature. Try again to sign a fresh one.");
      return;
    }
    setError(describeError(e));
  };

  const load = async () => {
    if (!wallet) return;
    setError(null);
    try {
      const a = await getAuth();
      setBusy("Fetching envelopes");
      const list = await fetchInbox(a.wallet, a.sig, a.bucket);
      setLoaded({ wallet: a.wallet, list, at: Date.now() });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: number) => {
    if (!wallet) return;
    setError(null);
    setRemoving(id);
    try {
      const a = await getAuth();
      setBusy(null);
      await deleteLetter(a.wallet, id, a.sig, a.bucket);
      setLoaded((prev) => (prev && prev.wallet === a.wallet ? { ...prev, list: prev.list.filter((m) => m.id !== id) } : prev));
    } catch (e) {
      fail(e);
    } finally {
      setRemoving(null);
      setBusy(null);
    }
  };

  const writePath = address ? `/write?to=${encodeURIComponent(address)}` : "/write";

  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
      <div>
        <ChapterHeader
          as="h1"
          index={4}
          eyebrow="Inbox"
          meta={address ? `wallet ${truncate(address)}` : "no wallet connected"}
          title={
            <>
              An inbox
              <br />
              <span className="display-serif text-paper-2">
                only you <span className="whitespace-nowrap">can open.</span>
              </span>
            </>
          }
          lede="Letters arrive sealed to your ML-KEM-768 passport key. One wallet signature fetches the envelopes; they are opened in this tab with the secret key from your session. The server stores ciphertext and the sender's address."
        />
        {inviteCount > 0 && (
          <p className="mt-8 font-mono text-[11px] text-mute">
            <span className="text-paper tnum">{inviteCount}</span> {inviteCount === 1 ? "invite" : "invites"} sent to you.
          </p>
        )}
        <p className="mt-8 max-w-md text-xs leading-relaxed text-mute">
          Note: the registry can see who wrote to you and when; it cannot read the text. Delete removes
          the envelope from the registry; a copy the sender kept is theirs. A letter can carry a USDC
          payment: the amount and both wallets are public on chain, only the note is private. The registry
          checks each transfer on chain before it shows it as verified.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        {!address && (
          <div className="panel p-6 md:p-8">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Wallet</span>
              <span className="eyebrow">Wallet Standard</span>
            </div>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
              Connect the wallet your passport is bound to. Reading needs one signature; it proves you hold
              the address and expires after two minutes.
            </p>
            <div className="mt-6">
              <ConnectButton align="left" />
            </div>
          </div>
        )}

        {address && !inbox && (
          <div className="panel p-6 md:p-8">
            <div className="flex items-center justify-between">
              <span className="eyebrow">Locked</span>
              <KeysChip loaded={kemSk !== null} />
            </div>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
              Sign a short read message with <span className="font-mono text-paper">{truncate(address)}</span>{" "}
              to fetch your envelopes. No transaction, no fee.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void load()} disabled={busy !== null} className="pill disabled:opacity-50">
                {busy ? "Unlocking…" : "Unlock inbox"}
              </button>
            </div>
            {busy && <StatusLine className="mt-4">{busy}</StatusLine>}
            {error && <ErrorNote className="mt-4">{error}</ErrorNote>}
            {!kemSk && <RestoreHint hasPassport={session.passport?.wallet === address} className="mt-5" />}
          </div>
        )}

        {address && inbox && (
          <section className="panel p-6 md:p-8" aria-labelledby="letters-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span id="letters-heading" className="eyebrow whitespace-nowrap">
                Letters · {inbox.list.length}
              </span>
              <div className="flex items-center gap-2">
                <KeysChip loaded={kemSk !== null} />
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={busy !== null || removing !== null}
                  className="pill pill-ghost whitespace-nowrap !px-3 !py-1.5 text-[11px] disabled:opacity-50"
                >
                  {busy ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            </div>

            {!kemSk && <RestoreHint hasPassport={session.passport?.wallet === address} className="mt-5" />}
            {busy && <StatusLine className="mt-4">{busy}</StatusLine>}
            {error && <ErrorNote className="mt-4">{error}</ErrorNote>}

            {inbox.list.length === 0 ? (
              <div className="mt-6 border-t border-line pt-6">
                <p className="max-w-md text-sm leading-relaxed text-mute">
                  Nothing here yet. Anyone can write to you from your passport page; the link below opens
                  the compose form for this wallet.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3">
                  <Link href={writePath} className="break-all font-mono text-sm text-paper underline-offset-4 hover:underline">
                    {writePath}
                  </Link>
                  <CopyButton value={() => `${window.location.origin}${writePath}`} label="write link" />
                </div>
              </div>
            ) : (
              <ul className="mt-6 border-t border-line">
                {inbox.list.map((m) => (
                  <LetterItem
                    key={m.id}
                    message={m}
                    opened={kemSk ? (opened.get(m.id) ?? null) : undefined}
                    removing={removing === m.id}
                    disabled={busy !== null || removing !== null}
                    onDelete={() => void remove(m.id)}
                  />
                ))}
              </ul>
            )}
            <p className="mt-5 font-mono text-[11px] text-mute">
              fetched {formatUtc(inbox.at)} · newest 50
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function KeysChip({ loaded }: { loaded: boolean }) {
  return (
    <span className="chip whitespace-nowrap">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${loaded ? "bg-signal" : "bg-mute"}`} />
      {loaded ? "keys loaded" : "no keys"}
    </span>
  );
}

function RestoreHint({ hasPassport, className = "" }: { hasPassport: boolean; className?: string }) {
  return (
    <div className={`rounded-xl border border-line px-4 py-3 ${className}`}>
      <p className="text-xs leading-relaxed text-mute">
        {hasPassport
          ? "Your passport is known, but its secret keys are not loaded in this session. Senders and times show; the text needs the ML-KEM-768 secret key."
          : "No passport keys in this session. Letters can only be opened with the ML-KEM-768 secret key of the passport bound to this wallet."}
      </p>
      <Link href="/passport" className="pill pill-ghost mt-3 !px-4 !py-2">
        {hasPassport ? "Restore keys" : "Open passport"}
      </Link>
    </div>
  );
}

const PAYMENT_NOTE: Record<LetterPayment["status"], string> = {
  verified: "found on chain, bound to this letter",
  pending: "unverified · not found on chain yet, checked again on refresh",
  invalid: "did not verify",
};

/** The USDC chip of a letter: amount, status and the transaction on the explorer. */
function PaymentLine({ payment }: { payment: LetterPayment }) {
  const dot =
    payment.status === "verified" ? "bg-signal" : payment.status === "pending" ? "animate-pulse bg-mute" : "bg-paper";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <a
        href={explorerTx(payment.signature)}
        target="_blank"
        rel="noreferrer"
        title={`${payment.signature} on the explorer`}
        className="chip whitespace-nowrap tnum transition-colors hover:text-paper"
      >
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        {formatUsdc(payment.amount)} USDC · {payment.status} ↗
      </a>
      <span className="font-mono text-[11px] text-mute">
        {payment.status === "invalid" && payment.reason ? `did not verify · ${payment.reason}` : PAYMENT_NOTE[payment.status]}
      </span>
    </div>
  );
}

interface LetterItemProps {
  message: InboxMessage;
  /** The decrypted letter or the failure; `undefined` when no key is loaded. */
  opened: Opened | null | undefined;
  removing: boolean;
  disabled: boolean;
  onDelete: () => void;
}

function LetterItem({ message: m, opened, removing, disabled, onDelete }: LetterItemProps) {
  const senderPath = `/p?a=${encodeURIComponent(m.from)}`;
  const innerFrom = opened?.ok ? opened.letter.from : undefined;
  const mismatch = opened?.ok === true && innerFrom !== m.from;

  return (
    <li className="border-b border-line py-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex flex-wrap items-center gap-2 font-mono text-sm">
          <Link href={senderPath} className="text-paper underline-offset-4 hover:underline" title={m.from}>
            |{truncate(m.from)}⟩
          </Link>
          <CopyButton value={m.from} label="sender address" />
        </span>
        <span className="font-mono text-[11px] text-mute tnum">{formatUtc(m.created_at)}</span>
      </div>

      {m.payment && <PaymentLine payment={m.payment} />}

      <div className="mt-3">
        {opened === undefined ? (
          <p className="font-mono text-[11px] text-mute">locked · restore your keys to read</p>
        ) : opened === null ? (
          <p className="font-mono text-[11px] text-mute">not opened</p>
        ) : opened.ok ? (
          <>
            <p className="whitespace-pre-wrap break-words font-serif text-lg leading-relaxed text-paper">
              {opened.letter.text}
            </p>
            {mismatch && (
              <p className="mt-2 font-mono text-[11px] text-mute">
                inside the letter the sender is {innerFrom ? `|${truncate(innerFrom)}⟩` : "not named"}; the
                envelope was signed by |{truncate(m.from)}⟩
              </p>
            )}
          </>
        ) : (
          <p className="font-mono text-[11px] text-mute">could not open · {opened.error}</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-mute">#{m.id} · ML-KEM-768 + XChaCha20-Poly1305 · signed by the sender</span>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          className="pill pill-ghost !px-3 !py-1 text-[11px] disabled:opacity-50"
        >
          {removing ? "Deleting…" : "Delete"}
        </button>
      </div>
    </li>
  );
}

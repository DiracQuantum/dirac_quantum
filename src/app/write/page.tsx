"use client";

/**
 * /write?to=<wallet>: a sealed letter to one passport. The recipient's
 * ML-KEM-768 key comes from the registry; the text is encrypted in this tab,
 * the envelope hash is signed by the connected wallet, and only the envelope
 * travels. A USDC payment can ride along: one transaction moves the amount
 * to the recipient's USDC account with a memo bound to the envelope hash,
 * and the letter becomes its private note; once the transfer is sent, the
 * sealed letter is kept in sessionStorage until the registry stores it, so a
 * reload can still deliver it. Without a passport for `to`, the
 * page offers an on-chain invite (0.0001 SOL plus a memo), a shareable
 * invite link, and shows how many invites the wallet already has.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import ConnectButton from "@/components/wallet/ConnectButton";
import { CopyButton, ErrorNote, StatusLine, describeError, nextPaint } from "@/components/app/ui";
import { fetchPassport, type PassportRecord } from "@/lib/api";
import { inviteBlinkUrl } from "@/lib/blink";
import {
  MAX_TEXT_CHARS,
  SEND_MESSAGE,
  encryptLetter,
  envelopeHash,
  fetchInvites,
  isWalletAddress,
  parseEnvelope,
  parsePaymentClaim,
  registerInvite,
  sendLetter,
  type Envelope,
  type Letter,
  type LetterPayment,
  type PaymentClaim,
} from "@/lib/inbox";
import { b64, fingerprint, utf8 } from "@/lib/pq";
import { formatSol, truncate } from "@/lib/solana/format";
import { INVITE_LAMPORTS, sendInvite } from "@/lib/solana/invite";
import { awaitPayment, buildUsdcPaymentTx, readPaymentAccounts, type PaymentAccounts } from "@/lib/solana/pay";
import { explorerAddress, explorerTx } from "@/lib/solana/rpc";
import { TOKEN_ACCOUNT_RENT_LAMPORTS, formatUsdc, parseUsdcAmount } from "@/lib/solana/usdc";
import { useWallet } from "@/lib/solana/wallet";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function WritePage() {
  return (
    <>
      <Nav />
      {/* w-full: the body is a flex column, so without it the page shrinks to its content and centres.
          z-20: the connect dropdown must paint over the footer (z-10). */}
      <main className="relative z-20 mx-auto w-full max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <Suspense fallback={<Shell to={null} />}>
          <Write />
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
  /** The `attempt` this answer belongs to; older while a re-check is in flight. */
  attempt: number;
}

function Write() {
  const params = useSearchParams();
  const to = params.get("to")?.trim() ?? "";
  const valid = to.length > 0 && isWalletAddress(to);

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [failure, setFailure] = useState<{ wallet: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    fetchPassport(to)
      .then((record) => {
        if (cancelled) return;
        setLookup({ wallet: to, record, attempt });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ wallet: to, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [to, valid, attempt]);

  const record = valid && lookup?.wallet === to ? lookup.record : undefined;
  const error = valid && failure?.wallet === to ? failure.message : null;
  const loading = valid && record === undefined && !error;
  /** A "Check again" in flight: the previous answer stays on screen, its buttons show progress. */
  const checking = record !== undefined && !error && lookup?.attempt !== attempt;

  const retry = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };

  return (
    <Shell to={valid ? to : null}>
      {!to && <AddressForm />}

      {to && !valid && (
        <div className="panel p-6 md:p-8">
          <span className="eyebrow block">Recipient</span>
          <div className="mt-4">
            {/* The address from the link stays in the field, so a typo can be fixed in place. */}
            <AddressForm key={to} bare initial={to} initialError={NOT_AN_ADDRESS} />
          </div>
        </div>
      )}

      {loading && (
        <div className="panel p-6 md:p-8">
          <span className="eyebrow block">Registry</span>
          <StatusLine className="mt-4">Fetching the passport of {truncate(to)}</StatusLine>
        </div>
      )}

      {error && (
        <div className="panel p-6 md:p-8">
          <span className="eyebrow block">Registry</span>
          <ErrorNote className="mt-4">{error}</ErrorNote>
          <button type="button" onClick={retry} className="pill pill-ghost mt-4 !px-4 !py-2">
            Try again
          </button>
        </div>
      )}

      {record && <ComposePanel to={to} record={record} />}
      {record === null && <InvitePanel to={to} onCheckAgain={retry} checking={checking} />}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function Shell({ to, children }: { to: string | null; children?: React.ReactNode }) {
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
      <div>
        <ChapterHeader
          as="h1"
          index={4}
          eyebrow="Write"
          meta={to ? `to ${truncate(to)}` : "sealed letter"}
          title={
            <>
              A letter
              <br />
              <span className="display-serif text-paper-2">
                only they <span className="whitespace-nowrap">can open.</span>
              </span>
            </>
          }
          lede={
            <>
              The text is encrypted in this tab with the recipient&apos;s{" "}
              <span className="whitespace-nowrap">ML-KEM-768</span> passport key and the envelope is signed by your
              wallet. The registry stores the sealed envelope: it can see who wrote to whom, not what.
            </>
          }
        />
        <p className="mt-8 max-w-md text-xs leading-relaxed text-mute">
          Note: your wallet address is visible to the server and to the recipient; the text is not.
          An attached USDC payment is a public transfer: the amount and both wallets are on chain, only
          the note is private. Letters are one-way for now. A reply needs a passport of your own.
        </p>
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

const NOT_AN_ADDRESS = "Not a Solana address. Expected a base58 public key of 32 bytes.";

function AddressForm({
  bare = false,
  initial = "",
  initialError = null,
}: {
  bare?: boolean;
  initial?: string;
  initialError?: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(initialError);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const a = value.trim();
    if (!isWalletAddress(a)) {
      setError(NOT_AN_ADDRESS);
      return;
    }
    setError(null);
    router.push(`/write?to=${encodeURIComponent(a)}`);
  };

  const form = (
    <>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Recipient wallet, 7xKq…9AsU"
          aria-label="Recipient wallet address"
          spellCheck={false}
          autoComplete="off"
          className={INPUT}
        />
        <button type="submit" disabled={value.trim().length === 0} className="pill shrink-0 justify-center disabled:opacity-50">
          Open
        </button>
      </form>
      {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
    </>
  );

  if (bare) return form;
  return (
    <div className="panel p-6 md:p-8">
      <span className="eyebrow block">Write to a passport</span>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
        Paste the wallet address of the person you are writing to. If it carries a Dirac passport, the
        letter is sealed to its key; if not, you can invite them.
      </p>
      <div className="mt-5">{form}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Compose                                                             */
/* ------------------------------------------------------------------ */

/** The letter, stamped with the current time, sealed to the passport's ML-KEM-768 key (base64). Called from handlers only. */
function sealLetter(text: string, from: string, kemPk: string): Envelope {
  const letter: Letter = { v: 1, text, from, sent_at: Date.now() };
  return encryptLetter(letter, b64.decode(kemPk));
}

interface Sent {
  to: string;
  id: number;
  payment: LetterPayment | null;
}

/** A payment that was sent but whose letter has not reached the registry yet: delivering again costs no second transfer. */
interface Undelivered {
  to: string;
  from: string;
  envelope: Envelope;
  sig: string;
  payment: PaymentClaim;
}

/**
 * Where this tab keeps sealed letters whose transfer went out (or may have)
 * but which the registry has not stored yet, so a reload can still deliver
 * them. Only ciphertext, the envelope signature and the public transaction:
 * nothing readable. Cleared per letter on delivery or Discard.
 */
const UNDELIVERED_KEY = "dirac:write:undelivered";
/** Letters kept at most; the oldest go first. */
const UNDELIVERED_MAX = 8;

/** One stored entry checked field by field, or null. */
function toUndelivered(value: unknown): Undelivered | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { to, from, envelope, sig, payment } = value as Record<string, unknown>;
  if (!isWalletAddress(to) || !isWalletAddress(from)) return null;
  if (typeof sig !== "string" || sig.length === 0 || sig.length > 128) return null;
  const sealed = parseEnvelope(envelope);
  const claim = parsePaymentClaim(payment);
  if (!sealed.ok || !claim.ok || claim.value === null) return null;
  return { to, from, envelope: sealed.value, sig, payment: claim.value };
}

/** The letters held in this tab's sessionStorage, oldest first; empty when there are none or storage is blocked. */
function readUndelivered(): Undelivered[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(UNDELIVERED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.map(toUndelivered).filter((u): u is Undelivered => u !== null);
  } catch {
    return [];
  }
}

function writeUndelivered(list: Undelivered[]): void {
  try {
    if (list.length === 0) window.sessionStorage.removeItem(UNDELIVERED_KEY);
    else window.sessionStorage.setItem(UNDELIVERED_KEY, JSON.stringify(list.slice(-UNDELIVERED_MAX)));
  } catch {
    // Blocked storage: the letter is held by this page only, until a reload.
  }
}

const withoutPayment = (list: Undelivered[], signature: string): Undelivered[] =>
  list.filter((u) => u.payment.signature !== signature);

/** Adds or replaces (same transaction) a letter in storage. */
function storeUndelivered(u: Undelivered): void {
  writeUndelivered([...withoutPayment(readUndelivered(), u.payment.signature), u]);
}

/** Drops the letter paid by `signature` from storage. */
function dropUndelivered(signature: string): void {
  writeUndelivered(withoutPayment(readUndelivered(), signature));
}

function ComposePanel({ to, record }: { to: string; record: PassportRecord }) {
  const { wallet } = useWallet();
  const [text, setText] = useState("");
  const [payOpen, setPayOpen] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  // This panel renders only in the browser (after the passport fetch), so the initialiser can read storage.
  const [undelivered, setUndelivered] = useState<Undelivered[]>(readUndelivered);
  const [accounts, setAccounts] = useState<{ key: string; value: PaymentAccounts } | null>(null);
  const [accountsError, setAccountsError] = useState<{ key: string; message: string } | null>(null);
  const [accountsAttempt, setAccountsAttempt] = useState(0);

  const fp = fingerprint(record.passport);
  const pagePath = `/p?a=${encodeURIComponent(to)}`;
  const delivered = sent?.to === to ? sent : null;
  const empty = text.trim().length === 0;
  const from = wallet?.address ?? null;
  // Before the wallet reconnects after a reload, a held letter to this recipient shows too: delivering needs no wallet.
  const heldHere = undelivered.filter((u) => u.to === to && (from === null || u.from === from));
  const held = heldHere.length > 0 ? heldHere[heldHere.length - 1] : null;
  const selfPay = from === to;

  // Balances for the payment, read through the RPC proxy while the payment row is open.
  const accountsKey = payOpen && from && !selfPay ? `${from}:${to}:${accountsAttempt}` : null;
  useEffect(() => {
    if (!accountsKey || !from) return;
    let cancelled = false;
    readPaymentAccounts(from, to)
      .then((value) => {
        if (!cancelled) setAccounts({ key: accountsKey, value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setAccountsError({ key: accountsKey, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [accountsKey, from, to]);

  const balances = accountsKey && accounts?.key === accountsKey ? accounts.value : null;
  const balancesError = accountsKey && accountsError?.key === accountsKey ? accountsError.message : null;
  const amount = parseUsdcAmount(amountText);
  const units = amount.ok ? amount.units : null;
  const payBlock = payOpen ? paymentBlock({ selfPay, amountText, amount, balances, balancesError }) : null;
  // With a payment, the balances must have been read: the checks above run on them.
  const canSend =
    !!wallet && !empty && busy === null && (!payOpen || (payBlock === null && units !== null && balances !== null));

  const reloadBalances = () => {
    setAccountsError(null);
    setAccountsAttempt((n) => n + 1);
  };

  /** Keeps a sealed letter whose transfer went out, in this tab's storage and on screen. */
  const hold = (u: Undelivered) => {
    storeUndelivered(u);
    setUndelivered((list) => [...withoutPayment(list, u.payment.signature), u]);
  };

  /** Forgets the letter paid by `signature`: delivered, or discarded. */
  const release = (signature: string) => {
    dropUndelivered(signature);
    setUndelivered((list) => withoutPayment(list, signature));
  };

  const finish = (res: { id: number; payment?: LetterPayment | null }, paidBy: string | null) => {
    if (paidBy) release(paidBy);
    setSent({ to, id: res.id, payment: res.payment ?? null });
    setText("");
    setAmountText("");
    setPayOpen(false);
    // The balances read before this payment are stale now.
    setAccountsAttempt((n) => n + 1);
  };

  const send = async () => {
    if (!wallet || !canSend) return;
    const payUnits = payOpen ? units : null;
    setError(null);
    setBusy("Encrypting with ML-KEM-768 and XChaCha20-Poly1305");
    /** Set once the wallet sent the transfer (unset if it failed on chain): a failed delivery then keeps the sealed letter. */
    let paid: Undelivered | null = null;
    try {
      await nextPaint();
      const envelope = sealLetter(text, wallet.address, record.passport.kem_pk);
      const hash = envelopeHash(envelope);
      setBusy("Waiting for the wallet to sign the envelope");
      const sig = b64.encode(await wallet.signMessage(utf8(SEND_MESSAGE(to, hash))));

      let payment: PaymentClaim | undefined;
      if (payUnits !== null) {
        setBusy("Waiting for the wallet to approve the USDC transfer");
        const tx = await buildUsdcPaymentTx({ from: wallet.address, to, amount: payUnits, envelopeHash: hash });
        const signature = await wallet.signAndSend(tx);
        payment = { signature, amount: payUnits };
        paid = { to, from: wallet.address, envelope, sig, payment };
        // From here a reload must not lose the letter: the transfer may land whatever this tab does next.
        storeUndelivered(paid);
        setBusy("Confirming the transfer on chain");
        if ((await awaitPayment(signature)) === "failed") {
          dropUndelivered(signature);
          paid = null;
          throw new Error("The transfer failed on chain; no USDC moved and the letter was not sent.");
        }
      }

      setBusy(payment ? "Sending the sealed envelope; the registry checks the transfer" : "Sending the sealed envelope");
      finish(await sendLetter(to, envelope, wallet.address, sig, payment), payment?.signature ?? null);
    } catch (e) {
      // Delivering again re-posts the same envelope and payment: never a second transfer.
      if (paid) hold(paid);
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const deliver = async () => {
    if (!held) return;
    setError(null);
    setBusy("Sending the sealed envelope; the registry checks the transfer");
    try {
      finish(await sendLetter(held.to, held.envelope, held.from, held.sig, held.payment), held.payment.signature);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel p-6 md:p-8" aria-labelledby="compose-heading">
      <div className="flex items-center justify-between">
        <span id="compose-heading" className="eyebrow">
          To
        </span>
        <span className="chip">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${wallet ? "bg-signal" : "bg-mute"}`} />
          {wallet ? `from |${truncate(wallet.address)}⟩` : "no wallet"}
        </span>
      </div>

      <div className="mt-5 flex flex-wrap items-baseline justify-between gap-3">
        <Link href={pagePath} className="font-serif text-3xl leading-none md:text-4xl" title={to}>
          <span className="text-mute">|</span>
          {truncate(to)}
          <span className="text-mute">⟩</span>
        </Link>
        <span className="font-mono text-[11px] text-mute">fingerprint {fp}</span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-mute">
        Passport found. The letter is sealed to its <span className="whitespace-nowrap">ML-KEM-768</span> key; only the holder of the matching
        secret key can open it.
      </p>

      {delivered ? (
        <div className="mt-6 border-t border-line pt-6">
          <div className="flex items-center justify-between gap-4">
            <p className="max-w-sm text-sm leading-relaxed text-paper">
              Sent, only <span className="font-mono">|{truncate(to)}⟩</span> can open it.
              <span className="text-mute"> Envelope #{delivered.id} is in their inbox.</span>
            </p>
            <span className="stamp shrink-0 text-signal">Sent</span>
          </div>
          {delivered.payment && <SentPayment payment={delivered.payment} />}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setSent(null)} className="pill">
              Write another
            </button>
            <Link href={pagePath} className="pill pill-ghost">
              Their passport
            </Link>
          </div>
        </div>
      ) : held ? (
        <div className="mt-6 border-t border-line pt-6">
          <span className="eyebrow block">Transfer sent, letter not delivered</span>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-paper">
            {formatUsdc(held.payment.amount)} USDC was sent in{" "}
            <a
              href={explorerTx(held.payment.signature)}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline-offset-4 hover:underline"
              title={held.payment.signature}
            >
              tx {truncate(held.payment.signature, 6, 6)} ↗
            </a>
            <span className="text-mute">
              , but the sealed letter has not reached the registry. Delivering again sends the same envelope; there is
              no second transfer.
            </span>
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void deliver()} disabled={busy !== null} className="pill disabled:opacity-50">
              {busy ? "Delivering…" : "Deliver the letter"}
            </button>
            <button
              type="button"
              onClick={() => release(held.payment.signature)}
              disabled={busy !== null}
              className="pill pill-ghost disabled:opacity-50"
            >
              Discard
            </button>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-mute">
            Discard drops the sealed letter from this tab. The transfer stays on chain either way.
          </p>
          {busy && <StatusLine className="mt-4">{busy}</StatusLine>}
          {error && <ErrorNote className="mt-4">{error}</ErrorNote>}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-4">
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="letter-text" className="eyebrow">
                {payOpen ? "Private note" : "Letter"}
              </label>
              <span className={`font-mono text-[11px] tnum ${text.length >= MAX_TEXT_CHARS ? "text-paper" : "text-mute"}`}>
                {text.length} / {MAX_TEXT_CHARS}
              </span>
            </div>
            <textarea
              id="letter-text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT_CHARS))}
              disabled={busy !== null}
              rows={8}
              maxLength={MAX_TEXT_CHARS}
              spellCheck={false}
              placeholder={
                payOpen
                  ? "Invoice number, terms, what the payment is for. Encrypted here; only they can read it."
                  : "Written here, encrypted here. Nothing readable leaves this tab."
              }
              className={`${INPUT} mt-3`}
            />
          </div>

          <PaymentRow
            open={payOpen}
            onToggle={() => setPayOpen((v) => !v)}
            amountText={amountText}
            onAmount={setAmountText}
            disabled={busy !== null}
            connected={!!wallet}
            balances={balances}
            balancesError={balancesError}
            onReload={reloadBalances}
            block={payBlock}
          />

          {wallet ? (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => void send()} disabled={!canSend} className="pill disabled:opacity-50">
                {busy ? "Sending…" : payOpen && units !== null ? `Encrypt, pay ${formatUsdc(units)} USDC and send` : "Encrypt and send"}
              </button>
              <span className="font-mono text-[11px] text-mute">
                {payOpen ? "one signature and one transaction" : "one wallet signature, no transaction"}
              </span>
            </div>
          ) : (
            <div>
              <p className="text-sm leading-relaxed text-mute">
                Connect a wallet to sign the envelope. The signature lets the recipient see who wrote and
                lets the registry refuse spam; it is not needed for the encryption.
              </p>
              <div className="mt-4">
                <ConnectButton align="left" />
              </div>
            </div>
          )}
          {busy && <StatusLine>{busy}</StatusLine>}
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* USDC payment                                                        */
/* ------------------------------------------------------------------ */

/** Why the payment cannot go out as entered, or null when it can. */
function paymentBlock({
  selfPay,
  amountText,
  amount,
  balances,
  balancesError,
}: {
  selfPay: boolean;
  amountText: string;
  amount: ReturnType<typeof parseUsdcAmount>;
  balances: PaymentAccounts | null;
  balancesError: string | null;
}): string | null {
  if (selfPay) return "This is your own wallet; a payment to it moves nothing.";
  if (amountText.trim().length > 0 && !amount.ok) return amount.error;
  if (balancesError) return `Balance unavailable: ${balancesError}`;
  if (!balances) return null;
  if (balances.usdc === null) return "This wallet has no USDC account, so there is nothing to send.";
  if (balances.frozen) return "Your USDC account is frozen by the issuer; it cannot send.";
  if (amount.ok && BigInt(amount.units) > balances.usdc) {
    return `Not enough USDC: the balance is ${formatUsdc(balances.usdc)}, the amount ${formatUsdc(amount.units)}.`;
  }
  if (balances.sol < balances.solNeeded) {
    return balances.recipientHasAccount
      ? `Not enough SOL: the network fee and the rent minimum your wallet must keep need about ${formatSol(balances.solNeeded)} SOL.`
      : `Not enough SOL: the network fee, the rent of their USDC account and the rent minimum your wallet must keep need about ${formatSol(balances.solNeeded)} SOL.`;
  }
  return null;
}

interface PaymentRowProps {
  open: boolean;
  onToggle: () => void;
  amountText: string;
  onAmount: (value: string) => void;
  disabled: boolean;
  connected: boolean;
  balances: PaymentAccounts | null;
  balancesError: string | null;
  onReload: () => void;
  block: string | null;
}

function PaymentRow({
  open,
  onToggle,
  amountText,
  onAmount,
  disabled,
  connected,
  balances,
  balancesError,
  onReload,
  block,
}: PaymentRowProps) {
  return (
    <div className="rounded-xl border border-line px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="eyebrow">USDC payment</span>
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled}
          aria-expanded={open}
          className="pill pill-ghost !px-3 !py-1 text-[11px] disabled:opacity-50"
        >
          {open ? "Remove" : "Attach USDC"}
        </button>
      </div>

      {!open ? (
        <p className="mt-2 text-xs leading-relaxed text-mute">
          Send USDC in the same step and the letter becomes its private note: invoices, salaries, OTC.
        </p>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-3">
            <input
              type="text"
              inputMode="decimal"
              value={amountText}
              // A comma is read as the decimal point, never dropped: "1,5" must not become 15 USDC.
              // "1,000" turns into 1.000 and is refused (two decimals at most), not read as a thousand.
              onChange={(e) => onAmount(e.target.value.replace(/,/g, ".").replace(/[^\d.]/g, "").slice(0, 14))}
              disabled={disabled}
              placeholder="0.00"
              aria-label="Amount in USDC"
              spellCheck={false}
              autoComplete="off"
              className={`${INPUT} tnum`}
            />
            <span className="shrink-0 font-mono text-sm text-mute">USDC</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-mute">
            {!connected ? (
              <span>connect a wallet to read your balance</span>
            ) : balancesError ? (
              <>
                <span>balance unavailable</span>
                <button type="button" onClick={onReload} className="text-paper underline-offset-4 hover:underline">
                  try again
                </button>
              </>
            ) : balances ? (
              <>
                <span className="tnum">
                  balance {balances.usdc === null ? "no USDC account" : `${formatUsdc(balances.usdc)} USDC`}
                </span>
                <span className="tnum">{formatSol(balances.sol, 6)} SOL</span>
                <button type="button" onClick={onReload} className="underline-offset-4 hover:text-paper hover:underline">
                  refresh
                </button>
              </>
            ) : (
              <span>reading your USDC balance…</span>
            )}
          </div>

          {block && <p className="mt-2 font-mono text-[11px] leading-relaxed text-paper">{block}</p>}

          <p className="mt-3 text-xs leading-relaxed text-mute">
            The amount and both wallets are public on chain; only the note is private. The memo carries the first 32
            hex characters of the sealed envelope&apos;s hash, which ties the transfer to this letter without revealing
            it.{" "}
            {balances && !balances.recipientHasAccount
              ? `They have no USDC account yet: the same transaction opens one, and you pay its rent of ${formatSol(TOKEN_ACCOUNT_RENT_LAMPORTS)} SOL.`
              : "The registry checks the transfer on chain before it marks the payment verified."}
          </p>
        </>
      )}
    </div>
  );
}

const PAYMENT_STATUS_COPY: Record<LetterPayment["status"], string> = {
  verified: "The registry found the transfer on chain and tied it to this letter.",
  pending: "The transaction is not visible to the registry yet; it checks again when they open their inbox.",
  invalid: "The registry could not verify the payment",
};

function SentPayment({ payment }: { payment: LetterPayment }) {
  return (
    <div className="mt-5 rounded-xl border border-line px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="chip tnum">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${payment.status === "verified" ? "bg-signal" : payment.status === "pending" ? "animate-pulse bg-mute" : "bg-paper"}`}
          />
          {formatUsdc(payment.amount)} USDC · {payment.status}
        </span>
        <a
          href={explorerTx(payment.signature)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-mute underline-offset-4 hover:text-paper hover:underline"
          title={payment.signature}
        >
          tx {truncate(payment.signature, 6, 6)} ↗
        </a>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-mute">
        {payment.status === "invalid"
          ? `${PAYMENT_STATUS_COPY.invalid}${payment.reason ? `: ${payment.reason}` : ""}.`
          : PAYMENT_STATUS_COPY[payment.status]}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Invite                                                              */
/* ------------------------------------------------------------------ */

interface Invites {
  wallet: string;
  count: number;
  from: string[];
}

function InvitePanel({ to, onCheckAgain, checking }: { to: string; onCheckAgain: () => void; checking: boolean }) {
  const { wallet } = useWallet();
  const [invites, setInvites] = useState<Invites | null>(null);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A transfer that landed but could not be recorded in the registry yet. */
  const [pending, setPending] = useState<{ to: string; from: string; tx: string } | null>(null);
  const [done, setDone] = useState<{ to: string; from: string; tx: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInvites(to)
      .then((r) => {
        if (cancelled) return;
        setInvites({ wallet: to, count: r.count, from: r.from });
        setInvitesError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setInvitesError(describeError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [to, attempt]);

  const current = invites?.wallet === to ? invites : null;
  const sent = done && done.to === to && done.from === wallet?.address ? done : null;
  const alreadyInvited = !!wallet && !!current && current.from.includes(wallet.address);
  const inviteLink = (from: string) => `${window.location.origin}/passport?from=${encodeURIComponent(from)}`;

  const invite = async () => {
    if (!wallet) return;
    setError(null);
    try {
      let tx = pending && pending.to === to && pending.from === wallet.address ? pending.tx : null;
      if (!tx) {
        setBusy("Waiting for the wallet to approve the transfer");
        tx = await sendInvite(wallet, to, window.location.origin);
        // Remember the landed transaction so a registry hiccup never costs a second one.
        setPending({ to, from: wallet.address, tx });
      }
      setBusy("Confirmed on chain. Recording the invite");
      await registerInvite(wallet.address, to, tx);
      setPending(null);
      setDone({ to, from: wallet.address, tx });
      setAttempt((n) => n + 1);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel p-6 md:p-8" aria-labelledby="invite-heading">
      <div className="flex items-center justify-between">
        <span id="invite-heading" className="eyebrow">
          No passport yet
        </span>
        <a href={explorerAddress(to)} target="_blank" rel="noreferrer" className="eyebrow transition-colors hover:text-paper">
          explorer ↗
        </a>
      </div>
      <div className="mt-6 break-all font-serif text-3xl leading-none md:text-4xl">
        <span className="text-mute">|</span>
        {truncate(to)}
        <span className="text-mute">⟩</span>
      </div>
      <p className="mt-5 max-w-md text-sm leading-relaxed text-mute">
        This wallet has no Dirac passport, so there is no post-quantum key to seal a letter to. An
        invite is a transfer of {formatSol(INVITE_LAMPORTS)} SOL with a memo that links to the passport
        page; the owner sees it in their transaction history.
      </p>

      <p className="mt-4 font-mono text-[11px] text-mute">
        {current
          ? current.count === 0
            ? "No invites sent to this wallet yet."
            : `${current.count} ${current.count === 1 ? "invite" : "invites"} sent to this wallet so far${alreadyInvited ? ", one of them yours" : ""}.`
          : invitesError
            ? `invite count unavailable · ${invitesError}`
            : "Counting invites…"}
      </p>

      {sent ? (
        <div className="mt-6 border-t border-line pt-6">
          <div className="flex items-center justify-between gap-4">
            <p className="max-w-sm text-sm leading-relaxed text-paper">
              Invite sent. When they issue a passport, come back here to write.
            </p>
            <span className="stamp shrink-0 text-signal">Invited</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 font-mono text-sm">
            <a
              href={explorerTx(sent.tx)}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:underline"
              title={sent.tx}
            >
              tx {truncate(sent.tx, 6, 6)} ↗
            </a>
            <CopyButton value={() => inviteLink(sent.from)} label="invite link" />
          </div>
          <div className="mt-5">
            <button type="button" onClick={onCheckAgain} disabled={checking} className="pill pill-ghost disabled:opacity-50">
              {checking ? "Checking…" : "Check for a passport"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {wallet ? (
            <button
              type="button"
              onClick={() => void invite()}
              disabled={busy !== null || alreadyInvited || wallet.address === to}
              className="pill disabled:opacity-50"
            >
              {wallet.address === to
                ? "This is your wallet"
                : alreadyInvited
                  ? "Already invited"
                  : busy
                    ? "Sending…"
                    : `Send an invite · ${formatSol(INVITE_LAMPORTS)} SOL`}
            </button>
          ) : (
            <ConnectButton align="left" />
          )}
          <button
            type="button"
            onClick={onCheckAgain}
            disabled={busy !== null || checking}
            className="pill pill-ghost disabled:opacity-50"
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
      )}
      {busy && <StatusLine className="mt-4">{busy}</StatusLine>}
      {error && <ErrorNote className="mt-4">{error}</ErrorNote>}

      {wallet && wallet.address === to && (
        <p className="mt-4 text-xs leading-relaxed text-mute">
          To receive letters here, issue your own passport.{" "}
          <Link href="/passport" className="text-paper underline-offset-4 hover:underline">
            Create passport
          </Link>
        </p>
      )}

      <div className="mt-6 rounded-xl border border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="eyebrow">Share an invite link</span>
          <CopyButton value={() => inviteBlinkUrl(to)} label="invite link" text="copy link" />
        </div>
        <p className="mt-2 font-mono text-[11px] text-paper" title={`/invite/${to}`}>
          /invite/{truncate(to, 6, 6)}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-mute">
          On X and in Blink-aware wallets the link shows a Send invite button, so anyone can send the same invite;
          everyone else lands on this page.
        </p>
      </div>
      <p className="mt-5 text-xs leading-relaxed text-mute">
        The transfer costs {formatSol(INVITE_LAMPORTS)} SOL plus the network fee, about 0.000005 SOL. The
        amount stays in their wallet. The registry records the pair of addresses and the transaction, so
        their passport page can say who invited them.
      </p>
    </section>
  );
}

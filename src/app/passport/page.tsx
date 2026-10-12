"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import ConnectButton from "@/components/wallet/ConnectButton";
import PassportDocument, { formatUtc, MODE_LABEL } from "@/components/app/PassportDocument";
import { useSession } from "@/components/app/session";
import {
  CopyButton,
  ErrorNote,
  StatusLine,
  describeError,
  downloadText,
  nextPaint,
  readFileBytes,
} from "@/components/app/ui";
import {
  ApiError,
  fetchPassport,
  registerPassport,
  type PassportRecord,
  type RegisterPassportResult,
} from "@/lib/api";
import { isWalletAddress } from "@/lib/inbox";
import {
  ANCHOR_MEMO,
  KEY_DERIVATION_MESSAGE,
  WALLET_MESSAGE,
  b64,
  buildPassport,
  decryptRecovery,
  encryptRecovery,
  entropyToPhrase,
  keysFromSeeds,
  newEntropy,
  passportHash,
  phraseToEntropy,
  seedsFromEntropy,
  seedsFromSignature,
  selfSign,
  signRotation,
  utf8,
  verifyWalletSig,
  type Passport,
  type PassportKeys,
  type PassportMode,
  type RecoveryFile,
  type Seeds,
} from "@/lib/pq";
import { anchorMemo } from "@/lib/solana/memo";
import { truncate } from "@/lib/solana/format";
import { explorerTx } from "@/lib/solana/rpc";
import { useWallet } from "@/lib/solana/wallet";

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function PassportPage() {
  return (
    <>
      <Nav />
      {/* w-full: body is a flex column, so an auto-margined main would shrink to its content. */}
      <main className="relative z-10 mx-auto w-full max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <PassportFlow />
      </main>
      <Footer />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Flow                                                                */
/* ------------------------------------------------------------------ */

type Action = "create" | "restore" | "anchor";
interface Busy {
  action: Action;
  label: string;
}
interface Failure {
  action: Action;
  message: string;
}
interface Lookup {
  wallet: string;
  record: PassportRecord | null;
}
interface LookupFailure {
  wallet: string;
  message: string;
}

const INPUT =
  "w-full rounded-xl border border-line bg-ink px-3.5 py-2.5 font-mono text-sm text-paper placeholder:text-mute/70 focus:border-paper/50";

/** Registry checks of a fresh anchor before the retry is left to the button, and the pause between them. */
const ANCHOR_ATTEMPTS = 3;
const ANCHOR_RETRY_MS = 4000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function keysMatch(p: Passport, keys: PassportKeys): boolean {
  return b64.encode(keys.kemPk) === p.kem_pk && b64.encode(keys.dsaPk) === p.dsa_pk;
}

function PassportFlow() {
  const { wallet } = useWallet();
  const session = useSession();
  const address = wallet?.address ?? null;

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupFailure, setLookupFailure] = useState<LookupFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** A memo transaction that landed but could not be recorded in the registry yet, keyed by passport hash. */
  const [pending, setPending] = useState<{ hash: string; tx: string } | null>(null);
  /** Why the registry kept the last anchor as unverified, keyed by passport hash. */
  const [anchorNote, setAnchorNote] = useState<{ hash: string; note: string } | null>(null);

  // Registry lookup for the connected wallet.
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    fetchPassport(address)
      .then((record) => {
        if (cancelled) return;
        setLookup({ wallet: address, record });
        setLookupFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLookupFailure({ wallet: address, message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [address, attempt]);

  const registered = address && lookup?.wallet === address ? lookup.record : null;
  const lookupError = address && lookupFailure?.wallet === address ? lookupFailure.message : null;
  const checking = !!address && !lookupError && (!lookup || lookup.wallet !== address);
  const sessionHash = useMemo(
    () => (session.passport ? passportHash(session.passport) : null),
    [session.passport],
  );
  const keysReady = !!registered && !!session.keys && sessionHash === registered.hash;
  const anchorTx = registered?.anchor_tx ?? null;
  const anchorVerified = !!registered && registered.anchor_tx !== null && registered.anchor_verified;
  const pendingAnchor = registered && pending?.hash === registered.hash ? pending.tx : null;
  const unverifiedNote = registered && anchorNote?.hash === registered.hash ? anchorNote.note : null;

  /* ---- actions ---------------------------------------------------- */

  const run = async (action: Action, label: string, job: () => Promise<void>) => {
    setBusy({ action, label });
    setFailure(null);
    try {
      await job();
    } catch (e) {
      setFailure({ action, message: describeError(e) });
    } finally {
      setBusy(null);
    }
  };

  const create = (mode: PassportMode, entropy: Uint8Array | null) =>
    run("create", "Starting", async () => {
      if (!wallet) throw new Error("Connect a wallet first.");
      // A registered passport is replaced only with a signature from its current key.
      const current = registered;
      const currentKeys = current && keysReady ? session.keys : null;
      if (current && !currentKeys) {
        throw new Error(
          "Load the current passport's keys first: the new passport must be signed by the old one.",
        );
      }
      let seeds: Seeds;
      if (mode === "simple") {
        setBusy({ action: "create", label: "Waiting for the wallet to sign the key derivation message" });
        const sig = await wallet.signMessage(utf8(KEY_DERIVATION_MESSAGE(wallet.address)));
        seeds = seedsFromSignature(sig);
      } else {
        if (!entropy) throw new Error("Generate a recovery phrase first.");
        seeds = seedsFromEntropy(entropy);
      }
      setBusy({ action: "create", label: "Generating ML-KEM-768 and ML-DSA-65 keys" });
      await nextPaint();
      const keys = keysFromSeeds(seeds);
      const passport = buildPassport(wallet.address, keys, mode, Date.now());
      const selfSig = selfSign(passport, keys.dsaSk);

      setBusy({ action: "create", label: "Waiting for the wallet to sign the passport" });
      const walletSig = b64.encode(await wallet.signMessage(utf8(WALLET_MESSAGE(passport))));
      if (!verifyWalletSig(passport, walletSig)) {
        throw new Error(
          "The wallet signature does not verify against this address. Some hardware wallets cannot sign messages; they need the hardened mode and a different signing wallet.",
        );
      }

      let rotationSig: string | undefined;
      if (current && currentKeys) {
        setBusy({ action: "create", label: "Signing the rotation with the current ML-DSA key" });
        await nextPaint();
        rotationSig = signRotation(current.passport, currentKeys.dsaSk, passport);
      }

      setBusy({ action: "create", label: current ? "Registering the new version" : "Registering the passport" });
      const res = await registerPassport({ passport, self_sig: selfSig, wallet_sig: walletSig, rotation_sig: rotationSig });
      session.update({ passport, keys, selfSig, walletSig, anchorTx: null });
      setLookup({
        wallet: wallet.address,
        record: {
          passport,
          self_sig: selfSig,
          wallet_sig: walletSig,
          anchor_tx: res.anchor_tx ?? null,
          hash: res.hash,
          registered_at: res.registered_at,
          version: res.version ?? (current ? current.version + 1 : 1),
          anchor_verified: res.anchor_verified === true,
          anchor_slot: null,
          anchor_time: null,
          rotated_from: current?.hash ?? null,
        },
      });
      setReplacing(false);
    });

  const adopt = (rec: PassportRecord, keys: PassportKeys) => {
    if (!keysMatch(rec.passport, keys)) {
      throw new Error(
        "These keys do not match the registered passport. The wallet may have signed differently, or the passport was issued in the other mode. Without its keys this passport cannot be replaced.",
      );
    }
    session.update({
      passport: rec.passport,
      keys,
      selfSig: rec.self_sig,
      walletSig: rec.wallet_sig,
      // Seals carry the anchor only once the registry has verified it.
      anchorTx: rec.anchor_verified ? rec.anchor_tx : null,
    });
  };

  const restoreSimple = () =>
    run("restore", "Waiting for the wallet to sign the key derivation message", async () => {
      if (!wallet || !registered) return;
      const sig = await wallet.signMessage(utf8(KEY_DERIVATION_MESSAGE(wallet.address)));
      setBusy({ action: "restore", label: "Deriving keys" });
      await nextPaint();
      adopt(registered, keysFromSeeds(seedsFromSignature(sig)));
    });

  const restoreFromPhrase = (phrase: string) =>
    run("restore", "Checking the phrase", async () => {
      if (!registered) return;
      const entropy = phraseToEntropy(phrase);
      setBusy({ action: "restore", label: "Deriving keys" });
      await nextPaint();
      adopt(registered, keysFromSeeds(seedsFromEntropy(entropy)));
    });

  const restoreFromFile = (file: File, password: string) =>
    run("restore", "Reading the recovery file", async () => {
      if (!registered) return;
      const text = new TextDecoder().decode(await readFileBytes(file));
      let parsed: RecoveryFile;
      try {
        parsed = JSON.parse(text) as RecoveryFile;
      } catch {
        throw new Error("This is not a Dirac recovery file (invalid JSON).");
      }
      if (typeof parsed.wallet === "string" && parsed.wallet !== registered.passport.wallet) {
        throw new Error(`This recovery file belongs to ${truncate(parsed.wallet)}, not to this wallet.`);
      }
      setBusy({ action: "restore", label: "Decrypting with Argon2id, this takes a moment" });
      await nextPaint();
      const entropy = decryptRecovery(parsed, password);
      adopt(registered, keysFromSeeds(seedsFromEntropy(entropy)));
    });

  const anchor = () =>
    run("anchor", "Waiting for the wallet to approve the memo transaction", async () => {
      if (!wallet || !registered) return;
      const rec = registered;
      let tx = pendingAnchor;
      if (!tx) {
        tx = await anchorMemo(wallet, ANCHOR_MEMO(rec.passport));
        // Remember the landed transaction so a registry hiccup never costs a second one.
        setPending({ hash: rec.hash, tx });
      }
      // The registry records the anchor only once it sees the transaction on chain (a re-register
      // carries no fresh signature, so an unseen claim is not kept); a confirmed one usually shows
      // within seconds, so ask a few times before handing the retry to the button.
      let res: RegisterPassportResult | null = null;
      for (let attempt = 0; attempt < ANCHOR_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          setBusy({ action: "anchor", label: "Waiting for the transaction to show on chain" });
          await wait(ANCHOR_RETRY_MS);
        }
        setBusy({ action: "anchor", label: "Confirmed on chain. The registry is checking the transaction" });
        try {
          res = await registerPassport({
            passport: rec.passport,
            self_sig: rec.self_sig,
            wallet_sig: rec.wallet_sig,
            anchor_tx: tx,
          });
        } catch (e) {
          // A refusal (400) means the chain contradicts this transaction: recording it again cannot help.
          if (e instanceof ApiError && e.status === 400) setPending(null);
          throw e;
        }
        if (res.anchor_verified) break;
      }
      if (!res) return;
      const fresh = await fetchPassport(rec.passport.wallet).catch(() => null);
      const record: PassportRecord =
        fresh && fresh.hash === rec.hash
          ? fresh
          : { ...rec, anchor_tx: res.anchor_tx, anchor_verified: res.anchor_verified === true };
      setLookup({ wallet: rec.passport.wallet, record });
      if (record.anchor_verified) {
        setAnchorNote(null);
        setPending(null);
        if (sessionHash === rec.hash) session.setAnchorTx(record.anchor_tx);
      } else {
        // The transaction stays pending here, so "Record the anchor" sends it again without a second one.
        setAnchorNote({ hash: rec.hash, note: res.anchor_note ?? "not visible on chain yet" });
      }
    });

  /** Reads the record again: the registry re-checks an unverified anchor on read, at most once a minute. */
  const recheckAnchor = () =>
    run("anchor", "Asking the registry to check the transaction again", async () => {
      if (!registered) return;
      const rec = registered;
      const fresh = await fetchPassport(rec.passport.wallet);
      if (!fresh || fresh.hash !== rec.hash) {
        setAttempt((n) => n + 1);
        return;
      }
      setLookup({ wallet: rec.passport.wallet, record: fresh });
      if (fresh.anchor_verified) {
        setAnchorNote(null);
        if (sessionHash === rec.hash) session.setAnchorTx(fresh.anchor_tx);
      } else {
        setAnchorNote({ hash: rec.hash, note: "still not found; the registry checks again at most once a minute" });
      }
    });

  const retryLookup = () => {
    setLookupFailure(null);
    setAttempt((n) => n + 1);
  };

  /* ---- derived copy ---------------------------------------------- */

  const steps = [
    {
      label: "Wallet",
      detail: address ? truncate(address) : "Connect the wallet the passport binds to",
      done: !!address,
      active: !address,
    },
    {
      label: "Keys",
      detail: registered && !replacing ? `${MODE_LABEL[registered.passport.mode]} mode` : "Hardened (recommended) or simple",
      done: !!registered && !replacing,
      active: !!address && !checking && !lookupError && (!registered || replacing),
    },
    {
      label: "Issue",
      detail:
        registered && !replacing
          ? `${formatUtc(registered.registered_at)}${registered.version > 1 ? ` · version ${registered.version}` : ""}`
          : replacing
            ? "Signed by the current key, then registered"
            : "Self-signed, wallet-signed, registered",
      done: !!registered && !replacing,
      active: false,
    },
    {
      label: "Anchor",
      detail: anchorTx
        ? `tx ${truncate(anchorTx)}${anchorVerified ? "" : " · unverified"}`
        : "One memo on Solana, about 0.000005 SOL",
      done: anchorVerified && !replacing,
      active: !!registered && !replacing && !anchorVerified,
    },
  ];

  return (
    // The single column below lg is minmax(0,1fr) too (as on /p): an auto track would take the anchor memo's
    // min-content and push every panel past the right edge of a phone.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
      <div className="min-w-0">
        <ChapterHeader
          as="h1"
          index={2}
          eyebrow="Passport"
          meta={address ? `wallet ${truncate(address)}` : "no wallet connected"}
          title={
            <>
              Issue your
              <br />
              <span className="display-serif text-paper-2">post-quantum passport.</span>
            </>
          }
          lede="Two keys, ML-KEM-768 for encryption and ML-DSA-65 for signatures, bound to your wallet. The wallet signs the passport, the passport signs itself, and one memo on Solana fixes the date. Everything is generated in this tab."
        />

        <Suspense fallback={null}>
          <InvitedByLine hidden={!!registered} />
        </Suspense>

        <ol className="mt-10 border-t border-line">
          {steps.map((s, i) => (
            <li key={s.label} className="flex items-baseline gap-5 border-b border-line py-4">
              <span className={`eyebrow tnum ${s.done ? "text-paper" : ""}`}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-medium ${s.done || s.active ? "text-paper" : "text-mute"}`}>
                  {s.label}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-mute">{s.detail}</div>
              </div>
              <span className="eyebrow">{s.done ? "done" : s.active ? "now" : ""}</span>
            </li>
          ))}
        </ol>

        <p className="mt-8 max-w-md text-xs leading-relaxed text-mute">
          Note: the wallet binding uses Ed25519, so after Q-Day a new binding could be forged. An
          anchor proves only that this record existed before its block time. Once registered, the
          passport is replaced only with a signature from its current ML-DSA key, so a forged wallet
          signature alone cannot swap it. Simple mode keys come from a wallet signature and fall with
          the wallet key; hardened keys do not.
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        {!address && <ConnectPanel />}

        {address && checking && (
          <div className="panel p-6 md:p-8">
            <span className="eyebrow">Registry</span>
            <StatusLine className="mt-4">Checking the registry for {truncate(address)}</StatusLine>
          </div>
        )}

        {address && lookupError && (
          <div className="panel p-6 md:p-8">
            <span className="eyebrow">Registry</span>
            <ErrorNote className="mt-4">{lookupError}</ErrorNote>
            <button type="button" onClick={retryLookup} className="pill pill-ghost mt-4 !px-4 !py-2">
              Try again
            </button>
          </div>
        )}

        {address && !checking && !lookupError && registered && !replacing && (
          <>
            <PassportDocument
              passport={registered.passport}
              anchorTx={anchorTx}
              anchorVerified={anchorVerified}
              anchorTime={registered.anchor_time}
              version={registered.version}
            />
            <KeysPanel
              record={registered}
              ready={keysReady}
              busy={busy?.action === "restore" ? busy.label : null}
              error={failure?.action === "restore" ? failure.message : null}
              disabled={busy !== null}
              onRestoreSimple={restoreSimple}
              onRestorePhrase={restoreFromPhrase}
              onRestoreFile={restoreFromFile}
              onReplace={() => {
                setFailure(null);
                setReplacing(true);
              }}
            />
            <AnchorPanel
              passport={registered.passport}
              anchorTx={anchorTx}
              anchorVerified={anchorVerified}
              anchorTime={registered.anchor_time}
              unverifiedNote={unverifiedNote}
              pendingAnchor={pendingAnchor}
              busy={busy?.action === "anchor" ? busy.label : null}
              error={failure?.action === "anchor" ? failure.message : null}
              disabled={busy !== null}
              onAnchor={anchor}
              onRecheck={recheckAnchor}
            />
            <NextPanel address={address} keysReady={keysReady} />
          </>
        )}

        {address && !checking && !lookupError && (!registered || replacing) && (
          <CreatePanel
            address={address}
            replacing={replacing}
            currentMode={registered?.passport.mode ?? null}
            busy={busy?.action === "create" ? busy.label : null}
            error={failure?.action === "create" ? failure.message : null}
            disabled={busy !== null}
            onCreate={create}
            onEdit={() => setFailure(null)}
            onCancel={() => {
              setFailure(null);
              setReplacing(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

/** `/passport?from=<wallet>`: the inviter, shown while this wallet has no passport yet. */
function InvitedByLine({ hidden }: { hidden: boolean }) {
  const from = useSearchParams().get("from")?.trim() ?? "";
  if (hidden || !isWalletAddress(from)) return null;
  return (
    <p className="mt-10 flex flex-wrap items-center gap-2 font-mono text-[11px] text-mute">
      <span className="eyebrow">Invited by</span>
      <Link href={`/p?a=${encodeURIComponent(from)}`} className="text-paper underline-offset-4 hover:underline" title={from}>
        |{truncate(from)}⟩
      </Link>
    </p>
  );
}

function ConnectPanel() {
  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-center justify-between">
        <span className="eyebrow">01 / Wallet</span>
        <span className="eyebrow">Wallet Standard</span>
      </div>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
        Connect the wallet the passport will be bound to. It signs two short messages; nothing is sent
        on chain until you choose to anchor.
      </p>
      <div className="mt-6">
        <ConnectButton align="left" />
      </div>
    </div>
  );
}

const MODES: { id: PassportMode; name: string; tag: string; body: string }[] = [
  {
    id: "hardened",
    name: "Hardened",
    tag: "recommended",
    body: "Independent random keys, a 24-word phrase and an optional recovery file. Nothing derives from Ed25519.",
  },
  {
    id: "simple",
    name: "Simple",
    tag: "Convenience · not Q-Day safe",
    body: "Keys derived from a wallet signature, nothing to store. Its keys come from a wallet signature, so a broken wallet key breaks them too.",
  },
];

interface CreatePanelProps {
  address: string;
  replacing: boolean;
  /** mode of the registered passport being replaced, null on a first issue */
  currentMode: PassportMode | null;
  busy: string | null;
  error: string | null;
  disabled: boolean;
  onCreate: (mode: PassportMode, entropy: Uint8Array | null) => void;
  /** The mode or the phrase changed: an error about the previous attempt no longer applies. */
  onEdit: () => void;
  onCancel: () => void;
}

function CreatePanel({ address, replacing, currentMode, busy, error, disabled, onCreate, onEdit, onCancel }: CreatePanelProps) {
  const [mode, setMode] = useState<PassportMode>("hardened");
  // Hardened is the default, so its phrase exists from the start. The panel only mounts in the
  // browser once a wallet is connected, never in the prerendered page.
  const [entropy, setEntropy] = useState<Uint8Array | null>(() => newEntropy());
  const [wroteDown, setWroteDown] = useState(false);
  const [password, setPassword] = useState("");
  const [encrypting, setEncrypting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const phrase = useMemo(() => (entropy ? entropyToPhrase(entropy) : null), [entropy]);
  const words = phrase ? phrase.split(" ") : [];

  const pickMode = (m: PassportMode) => {
    if (m !== mode) onEdit();
    setMode(m);
    if (m === "hardened" && !entropy) setEntropy(newEntropy());
  };

  const regenerate = () => {
    onEdit();
    setEntropy(newEntropy());
    setWroteDown(false);
    setSaved(false);
  };

  const downloadRecovery = async () => {
    if (!entropy) return;
    setFileError(null);
    setEncrypting(true);
    try {
      await nextPaint();
      const file = encryptRecovery(entropy, password, address);
      downloadText(`dirac-recovery-${address}.json`, JSON.stringify(file, null, 2));
      setSaved(true);
    } catch (e) {
      setFileError(describeError(e));
    } finally {
      setEncrypting(false);
    }
  };

  const canCreate = !disabled && (mode === "simple" || (!!entropy && wroteDown));

  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-center justify-between">
        <span className="eyebrow">02 / Keys</span>
        {replacing ? (
          <button type="button" onClick={onCancel} className="eyebrow transition-colors hover:text-paper">
            cancel
          </button>
        ) : (
          <span className="eyebrow">choose one</span>
        )}
      </div>

      {replacing && (
        <p className="mt-4 text-sm leading-relaxed text-mute">
          Replacing issues a new version under this wallet. The current passport signs the rotation
          with its ML-DSA key.
          {currentMode === "simple"
            ? " That key comes from a wallet signature, so whoever holds the wallet key can do the same; moving to hardened ends that."
            : " A stolen wallet key alone cannot replace it."}{" "}
          The old version stays in the public history; its seals still verify as made with an earlier
          key, and as proven when they reached the registry before the rotation.
        </p>
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Passport mode">
        {MODES.map((m) => {
          const on = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => pickMode(m.id)}
              className={`flex flex-col justify-start rounded-2xl border p-5 text-left transition-colors ${
                on ? "border-paper bg-ink-3" : "border-line hover:border-paper/40"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-paper">{m.name}</span>
                <span className="eyebrow">{m.tag}</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-mute">{m.body}</p>
            </button>
          );
        })}
      </div>

      {mode === "simple" ? (
        <p className="mt-6 text-xs leading-relaxed text-mute">
          Your wallet signs a fixed message once; both keys are derived from that signature with HKDF.
          You can re-derive them on any device by signing again. That is the convenience and the
          limit: whoever breaks the wallet key after Q-Day can sign the same message and derive the
          same keys. Some hardware wallets cannot sign messages; use hardened mode with those.
        </p>
      ) : (
        <div className="mt-6 border-t border-line pt-6">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Recovery phrase</span>
            <button
              type="button"
              onClick={regenerate}
              disabled={disabled}
              className="eyebrow transition-colors hover:text-paper"
            >
              new phrase
            </button>
          </div>
          <ol className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3 md:grid-cols-4">
            {words.map((w, i) => (
              <li key={`${i}-${w}`} className="flex items-baseline gap-2 font-mono text-sm">
                <span className="tnum w-5 text-[11px] text-mute">{i + 1}</span>
                <span className="text-paper">{w}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-mute">
            The phrase is the only way back to hardened keys. It is generated here and never leaves this
            page. Write it down on paper.
          </p>
          <label className="mt-4 flex items-center gap-3 text-sm text-paper">
            <input
              type="checkbox"
              checked={wroteDown}
              disabled={disabled}
              onChange={(e) => setWroteDown(e.target.checked)}
              className="h-4 w-4 accent-paper"
            />
            I wrote these 24 words down.
          </label>

          <div className="mt-6 border-t border-line pt-6">
            <span className="eyebrow">Recovery file · optional</span>
            <p className="mt-2 text-xs leading-relaxed text-mute">
              The same secret encrypted with a password (Argon2id, XChaCha20-Poly1305). Keep it next to
              the phrase, not instead of it.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={disabled || encrypting}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password for the file"
                aria-label="Password for the recovery file"
                className={INPUT}
              />
              <button
                type="button"
                onClick={() => void downloadRecovery()}
                disabled={disabled || encrypting || password.length < 8}
                className="pill pill-ghost shrink-0 justify-center disabled:opacity-50"
              >
                {encrypting ? "Encrypting…" : saved ? "Download again" : "Download file"}
              </button>
            </div>
            {password.length > 0 && password.length < 8 && (
              <p className="mt-2 font-mono text-[11px] text-mute">At least 8 characters.</p>
            )}
            {fileError && <ErrorNote className="mt-3">{fileError}</ErrorNote>}
            {saved && (
              <p className="mt-2 font-mono text-[11px] text-mute">
                Saved as dirac-recovery-{truncate(address)}.json
              </p>
            )}
          </div>
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => onCreate(mode, entropy)}
          disabled={!canCreate}
          className="pill disabled:opacity-50"
        >
          {busy ? "Creating…" : replacing ? "Issue new passport" : "Create passport"}
        </button>
        {busy && <StatusLine>{busy}</StatusLine>}
      </div>
      {error && <ErrorNote className="mt-4">{error}</ErrorNote>}

      <p className="mt-6 text-xs leading-relaxed text-mute">
        What happens: keys are generated in this tab, the passport is self-signed with ML-DSA-65, your
        wallet signs its hash with Ed25519
        {replacing ? ", the current passport's key signs the rotation" : ""}, and the public parts go to
        the registry. Secret keys stay in memory. {mode === "simple" ? "Two" : "One"} wallet signature
        {mode === "simple" ? "s" : ""}, no transaction.
      </p>
    </div>
  );
}

interface KeysPanelProps {
  record: PassportRecord;
  ready: boolean;
  busy: string | null;
  error: string | null;
  disabled: boolean;
  onRestoreSimple: () => void;
  onRestorePhrase: (phrase: string) => void;
  onRestoreFile: (file: File, password: string) => void;
  onReplace: () => void;
}

function KeysPanel({
  record,
  ready,
  busy,
  error,
  disabled,
  onRestoreSimple,
  onRestorePhrase,
  onRestoreFile,
  onReplace,
}: KeysPanelProps) {
  const [tab, setTab] = useState<"phrase" | "file">("phrase");
  const [phrase, setPhrase] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const hardened = record.passport.mode === "hardened";

  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-center justify-between">
        <span className="eyebrow">02 / Keys</span>
        <span className="chip">
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-signal" : "bg-mute"}`} />
          {ready ? "in memory" : "not loaded"}
        </span>
      </div>

      {ready ? (
        <p className="mt-4 text-sm leading-relaxed text-mute">
          Both secret keys are in this tab&apos;s memory and can seal documents. They are gone when the
          tab closes; restoring takes {hardened ? "the phrase or the recovery file" : "one wallet signature"}.
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm leading-relaxed text-mute">
            This passport is registered, but its secret keys are not in this browser session. Restore
            them to seal documents.
          </p>

          {!hardened ? (
            <div className="mt-5 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={onRestoreSimple}
                disabled={disabled}
                className="pill disabled:opacity-50"
              >
                {busy ? "Restoring…" : "Sign to restore keys"}
              </button>
              {busy && <StatusLine>{busy}</StatusLine>}
            </div>
          ) : (
            <div className="mt-5">
              <div className="flex gap-2">
                {(["phrase", "file"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    aria-pressed={tab === t}
                    className={`chip transition-colors ${tab === t ? "!border-paper bg-paper/10" : "hover:!border-paper/40"}`}
                  >
                    {t === "phrase" ? "24-word phrase" : "Recovery file"}
                  </button>
                ))}
              </div>

              {tab === "phrase" ? (
                <div className="mt-4">
                  <textarea
                    value={phrase}
                    disabled={disabled}
                    onChange={(e) => setPhrase(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="word word word … (24 words)"
                    aria-label="Recovery phrase"
                    className={INPUT}
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      onClick={() => onRestorePhrase(phrase)}
                      disabled={disabled || phrase.trim().split(/\s+/).length !== 24}
                      className="pill disabled:opacity-50"
                    >
                      {busy ? "Restoring…" : "Restore keys"}
                    </button>
                    {busy && <StatusLine>{busy}</StatusLine>}
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-2">
                  <input
                    type="file"
                    accept="application/json,.json"
                    disabled={disabled}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    aria-label="Recovery file"
                    className="block w-full font-mono text-xs text-mute file:mr-3 file:rounded-full file:border file:border-line file:bg-transparent file:px-3 file:py-1.5 file:font-mono file:text-[11px] file:uppercase file:tracking-[0.14em] file:text-paper"
                  />
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={disabled}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password of the file"
                    aria-label="Password of the recovery file"
                    className={INPUT}
                  />
                  <div className="mt-1 flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      onClick={() => file && onRestoreFile(file, password)}
                      disabled={disabled || !file || password.length === 0}
                      className="pill disabled:opacity-50"
                    >
                      {busy ? "Restoring…" : "Decrypt and restore"}
                    </button>
                    {busy && <StatusLine>{busy}</StatusLine>}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && <ErrorNote className="mt-4">{error}</ErrorNote>}

      <div className="mt-6 border-t border-line pt-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-relaxed text-mute">
            {ready
              ? "Switch modes or rotate keys by issuing a new version. The current key signs the rotation."
              : "Replacing this passport needs its current keys: load them above first."}
          </p>
          <button
            type="button"
            onClick={onReplace}
            disabled={disabled || !ready}
            className="pill pill-ghost shrink-0 !px-4 !py-2 disabled:opacity-50"
          >
            Replace passport
          </button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-mute">
          {hardened
            ? "A new passport must be signed by the old one, so a stolen wallet key alone cannot replace it."
            : "A new passport must be signed by the old one. In simple mode that key comes from a wallet signature, so whoever holds the wallet key can replace it; hardened mode closes that."}
          {ready
            ? ""
            : hardened
              ? " Without the phrase or the recovery file, this passport cannot be replaced, by you or anyone else; a fresh wallet is the way to a new one."
              : " If the wallet no longer derives the same keys, this passport cannot be replaced; a fresh wallet is the way to a new one."}
        </p>
      </div>
    </div>
  );
}

interface AnchorPanelProps {
  passport: Passport;
  anchorTx: string | null;
  /** the registry found anchorTx on chain, from this wallet, with this passport's memo */
  anchorVerified: boolean;
  /** block time of the verified anchor, unix ms */
  anchorTime: number | null;
  /** why the registry has not verified anchorTx yet, when it said */
  unverifiedNote: string | null;
  pendingAnchor: string | null;
  busy: string | null;
  error: string | null;
  disabled: boolean;
  onAnchor: () => void;
  onRecheck: () => void;
}

function AnchorPanel({
  passport,
  anchorTx,
  anchorVerified,
  anchorTime,
  unverifiedNote,
  pendingAnchor,
  busy,
  error,
  disabled,
  onAnchor,
  onRecheck,
}: AnchorPanelProps) {
  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-center justify-between">
        <span className="eyebrow">04 / Anchor</span>
        {anchorTx && anchorVerified ? (
          <span className="stamp text-signal !text-[10px]">Anchored</span>
        ) : anchorTx ? (
          <span className="eyebrow">unverified</span>
        ) : (
          <span className="eyebrow">memo</span>
        )}
      </div>

      {anchorTx && anchorVerified ? (
        <>
          <p className="mt-4 text-sm leading-relaxed text-mute">
            The registry found the memo on Solana, signed by this wallet and carrying this passport&apos;s
            hash. Its block time{anchorTime !== null ? `, ${formatUtc(anchorTime)},` : ""} shows the record
            existed by then, independent of this registry. That date is all an anchor proves.
          </p>
          <a
            href={explorerTx(anchorTx)}
            target="_blank"
            rel="noreferrer"
            className="chip mt-5 transition-colors hover:!border-paper/40"
            title={anchorTx}
          >
            <span className="text-mute">tx</span> {truncate(anchorTx, 6, 6)} ↗
          </a>
        </>
      ) : anchorTx ? (
        <>
          <p className="mt-4 text-sm leading-relaxed text-mute">
            The registry recorded this transaction but has not found it on chain yet, so the passport
            is not shown as anchored. It checks again when the passport is read, at most once a minute.
            If the transaction never landed, anchor with a new one.
          </p>
          <a
            href={explorerTx(anchorTx)}
            target="_blank"
            rel="noreferrer"
            className="chip mt-5 transition-colors hover:!border-paper/40"
            title={anchorTx}
          >
            <span className="text-mute">tx</span> {truncate(anchorTx, 6, 6)} ↗
          </a>
          {pendingAnchor && pendingAnchor !== anchorTx && !busy && <PendingAnchorNote tx={pendingAnchor} />}
          {unverifiedNote && <p className="mt-3 font-mono text-[11px] text-mute">{unverifiedNote}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <button type="button" onClick={onRecheck} disabled={disabled} className="pill pill-ghost disabled:opacity-50">
              {busy ? "Checking…" : "Check again"}
            </button>
            <button type="button" onClick={onAnchor} disabled={disabled} className="pill pill-ghost disabled:opacity-50">
              {pendingAnchor && pendingAnchor !== anchorTx ? "Record the anchor" : "Anchor again"}
            </button>
            {busy && <StatusLine>{busy}</StatusLine>}
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-sm leading-relaxed text-mute">
            One memo transaction from your wallet carries the passport hash. The base network fee
            is 0.000005 SOL; your wallet may add a small priority fee. Nothing else moves. Anyone
            can later confirm the date without trusting this registry.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-xl border border-line bg-ink px-4 py-3 font-mono text-[11px] leading-relaxed text-mute">
            {ANCHOR_MEMO(passport)}
          </pre>

          {pendingAnchor && !busy && (
            <>
              <PendingAnchorNote tx={pendingAnchor} />
              {unverifiedNote && <p className="mt-3 font-mono text-[11px] text-mute">{unverifiedNote}</p>}
            </>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-4">
            <button type="button" onClick={onAnchor} disabled={disabled} className="pill disabled:opacity-50">
              {busy ? "Anchoring…" : pendingAnchor ? "Record the anchor" : "Anchor on Solana"}
            </button>
            {busy && <StatusLine>{busy}</StatusLine>}
          </div>
        </>
      )}

      {error && <ErrorNote className="mt-4">{error}</ErrorNote>}
    </div>
  );
}

/** A memo transaction this tab sent that the registry has not recorded: it records one only once it sees it on chain. */
function PendingAnchorNote({ tx }: { tx: string }) {
  return (
    <p className="mt-4 text-sm leading-relaxed text-mute">
      Transaction{" "}
      <a
        href={explorerTx(tx)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-paper underline-offset-4 hover:underline"
      >
        {truncate(tx, 6, 6)}
      </a>{" "}
      was sent, but the registry cannot see it on chain yet, so it is not recorded. It usually shows
      within a minute. No second transaction is needed.
    </p>
  );
}

function NextPanel({ address, keysReady }: { address: string; keysReady: boolean }) {
  const path = `/p?a=${encodeURIComponent(address)}`;
  return (
    <div className="panel p-6 md:p-8">
      <div className="flex items-center justify-between">
        <span className="eyebrow">05 / Next</span>
        <span className="eyebrow">public</span>
      </div>
      <p className="mt-4 text-sm leading-relaxed text-mute">
        The public page shows the document and re-verifies both signatures in the reader&apos;s browser.
        {keysReady
          ? " Your keys are loaded, so you can seal a document right away."
          : " Restore the keys above before sealing documents."}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link href={path} className="pill">
          Public page
        </Link>
        <CopyButton value={() => `${window.location.origin}${path}`} label="public page link" text="copy link" className="!px-3 !py-1.5" />
        <Link href="/seal" className="pill pill-ghost">
          Seal a document
        </Link>
      </div>
    </div>
  );
}

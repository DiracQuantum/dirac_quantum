"use client";

/**
 * Address input + "Scan" button, plus a "Use connected wallet" ghost pill when
 * a wallet is connected. Used on the landing chapter and on /scan itself.
 * Validation happens here (base58, 32 bytes); the page only receives valid
 * addresses through `?a=`.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { isValidWallet } from "@/lib/scan";
import { truncate } from "@/lib/solana/format";
import { useWallet } from "@/lib/solana/wallet";

export const INPUT =
  "w-full rounded-xl border border-line bg-ink px-3.5 py-2.5 font-mono text-sm text-paper placeholder:text-mute/70 focus:border-paper/50";

export function scanHref(wallet: string): string {
  return `/scan?a=${encodeURIComponent(wallet)}`;
}

interface ScanFormProps {
  className?: string;
  /** Label on the submit button. */
  action?: string;
  /** Address already shown on the page; the connected-wallet pill hides when it is the same one. */
  current?: string | null;
  autoFocus?: boolean;
}

export default function ScanForm({ className = "", action = "Scan", current = null, autoFocus = false }: ScanFormProps) {
  const router = useRouter();
  const { wallet } = useWallet();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const go = (address: string) => {
    if (!isValidWallet(address)) {
      setError("Not a Solana address. Expected a base58 public key of 32 bytes.");
      return;
    }
    setError(null);
    // On /scan the form stays mounted while the next report loads; leave it empty.
    setValue("");
    router.push(scanHref(address));
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    go(value.trim());
  };

  const connected = wallet && wallet.address !== current ? wallet.address : null;

  return (
    <div className={className}>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Paste a Solana address"
          aria-label="Wallet address to scan"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          autoFocus={autoFocus}
          className={INPUT}
        />
        <button
          type="submit"
          disabled={value.trim().length === 0}
          className="pill shrink-0 justify-center disabled:pointer-events-none disabled:opacity-50"
        >
          {action}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 font-mono text-[11px] leading-relaxed text-mute">
          <span className="text-mute">error · </span>
          <span className="text-paper">{error}</span>
        </p>
      ) : null}
      {connected ? (
        <button
          type="button"
          onClick={() => go(connected)}
          className="pill pill-ghost mt-3 !px-4 !py-2"
        >
          Use connected wallet
          <span className="font-mono normal-case tracking-normal text-mute">{truncate(connected)}</span>
        </button>
      ) : null}
    </div>
  );
}

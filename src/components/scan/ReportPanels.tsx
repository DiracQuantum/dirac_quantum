"use client";

/**
 * The detail panels of /scan: recommendations, holdings, control
 * (authorities and Squads multisigs), activity and methodology. Pure
 * presentation over a v3 ScanReport. Every number is nullable: a null reads
 * "Unavailable" through the atoms, never "0". Dates are relative to the
 * report's own `scannedAt`.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Row } from "@/components/app/ui";
import {
  Address,
  EmptyFor,
  LowerBound,
  Panel,
  SOURCE_LABEL,
  SOURCE_METHOD,
  SOURCE_ORDER,
  Stat,
  Unavailable,
  sourceOf,
} from "@/components/scan/atoms";
import {
  count,
  formatAmount,
  formatInt,
  formatSolAmount,
  formatTxCount,
  formatUsd,
  formatUsdHeadline,
  formatUtcDateTime,
  joinList,
  relativeTime,
} from "@/components/scan/format";
import type { ScanAuthorityMint, ScanMultisigAccount, ScanMultisigMember, ScanReport, SourceState } from "@/lib/scan";
import { truncate } from "@/lib/solana/format";

/* ------------------------------------------------------------------ */
/* Holdings                                                            */
/* ------------------------------------------------------------------ */

const TOKENS_FOLDED = 8;

function tokenLabel(symbol: string, mint: string): string {
  return symbol && symbol !== "?" ? symbol : truncate(mint);
}

/** "1,234" or "1,234+" when the read stopped at the cap. */
function boundedCount(n: number, truncated: boolean): string {
  return `${formatInt(n)}${truncated ? "+" : ""}`;
}

export function HoldingsPanel({ report }: { report: ScanReport }) {
  const [expanded, setExpanded] = useState(false);
  const { sol, solUsd, tokens, tokenCount, tokensUsd, nfts, stakeSol, stakeAccounts, assetsTruncated } = report;
  const balance = sourceOf(report, "balance");
  const assets = sourceOf(report, "assets");
  const stake = sourceOf(report, "stake");
  const price = sourceOf(report, "price");
  const solValue = sol !== null && solUsd !== null ? sol * solUsd : null;
  const stakeValue = stakeSol !== null && solUsd !== null ? stakeSol * solUsd : null;
  const shown = expanded ? tokens : tokens.slice(0, TOKENS_FOLDED);
  const hidden = tokens.length - shown.length;
  const bound = assetsTruncated ? <LowerBound /> : undefined;

  return (
    <Panel
      eyebrow="Holdings"
      aside={
        solUsd !== null ? (
          <span className="tnum font-mono text-[11px] text-mute">SOL {formatUsd(solUsd)}</span>
        ) : (
          <span className="font-mono text-[11px] text-mute" title={price.error}>
            price unavailable
          </span>
        )
      }
    >
      {/* Two columns while the report sits in the narrow right column (lg up): four collided on large balances. */}
      <div className="mt-6 grid grid-cols-2 gap-6 md:grid-cols-4 lg:grid-cols-2">
        <Stat
          label="SOL"
          value={sol !== null ? formatSolAmount(sol) : <Unavailable source={balance} className="text-base" />}
          sub={solValue !== null ? formatUsd(solValue) : undefined}
        />
        <Stat
          label="Tokens"
          value={
            tokenCount !== null ? (
              boundedCount(tokenCount, assetsTruncated)
            ) : (
              <Unavailable source={assets} className="text-base" />
            )
          }
          tag={tokenCount !== null ? bound : undefined}
          sub={
            tokenCount !== null && tokenCount > 0 && tokensUsd !== null ? `${formatUsd(tokensUsd)} priced` : undefined
          }
        />
        <Stat
          label="NFTs"
          value={nfts !== null ? boundedCount(nfts, assetsTruncated) : <Unavailable source={assets} className="text-base" />}
          tag={nfts !== null ? bound : undefined}
        />
        <Stat
          label="Stake"
          value={
            stakeSol !== null ? `${formatSolAmount(stakeSol)} SOL` : <Unavailable source={stake} className="text-base" />
          }
          sub={
            stakeAccounts !== null && stakeAccounts > 0
              ? `${count(stakeAccounts, "account")}${stakeValue !== null ? ` · ${formatUsd(stakeValue)}` : ""}`
              : undefined
          }
        />
      </div>

      {tokens.length > 0 ? (
        <div className="mt-7">
          <div className="flex items-baseline justify-between">
            <span className="eyebrow">Top tokens</span>
            <span className="tnum font-mono text-[11px] text-mute">
              {tokens.length} of {tokenCount !== null ? boundedCount(tokenCount, assetsTruncated) : "?"}
            </span>
          </div>
          <table className="tnum mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="font-mono text-[11px] uppercase tracking-[0.14em] text-mute">
                <th scope="col" className="py-2 text-left font-normal">
                  Token
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  Amount
                </th>
                <th scope="col" className="py-2 text-right font-normal">
                  USD
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.mint} className="border-t border-line">
                  <td className="py-2.5 pr-3">
                    <span className="font-mono text-paper" title={t.mint}>
                      {tokenLabel(t.symbol, t.mint)}
                    </span>
                    {t.name && t.name !== t.symbol ? (
                      <span className="ml-2 hidden text-xs text-mute sm:inline">{t.name}</span>
                    ) : null}
                  </td>
                  <td className="py-2.5 text-right font-mono text-paper">{formatAmount(t.amount)}</td>
                  <td className="py-2.5 pl-3 text-right font-mono text-paper">
                    {t.usd !== null ? formatUsd(t.usd) : <span className="text-mute">not priced</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hidden > 0 || expanded ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-mute transition-colors hover:text-paper"
            >
              {expanded ? "Show fewer" : `Show ${hidden} more`}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-6">
          <span className="eyebrow">Tokens</span>
          <EmptyFor source={assets} whenEmpty="No fungible tokens were read for this address." />
        </div>
      )}

      {assets.status === "truncated" ? (
        <p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-mute">
          The asset read stopped at its cap{assets.error ? ` (${assets.error})` : ""}. Token and NFT counts are
          lower bounds, and the priced total covers only what was read.
        </p>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-mute">
        The USD total under this key is in Quantum exposure: SOL, priced tokens and stake at the SOL price when
        scanned.
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Control                                                             */
/* ------------------------------------------------------------------ */

const ROLE_LABEL: Record<ScanAuthorityMint["role"], string> = {
  mint: "mint",
  freeze: "freeze",
  both: "mint + freeze",
};

/** The co-controlled clause of the blast radius: one of the keys on N multisigs, holding X, not movable alone. */
function coControlled(report: ScanReport): string {
  const { memberOf, coControlledUsd, valued, memberOfTruncated } = report.multisigs;
  if (memberOf.length === 0) return "";
  const n = `${count(memberOf.length, "Squads multisig")}${memberOfTruncated ? " or more" : ""}`;
  const one = memberOf.length === 1 && !memberOfTruncated;
  const value =
    coControlledUsd !== null
      ? ` holding ${formatUsdHeadline(coControlledUsd)}${valued < memberOf.length ? " or more" : ""} in ${
          one ? "its first vault" : "their first vaults"
        }`
      : "";
  return ` It is also one of the keys on ${n}${value}, which it cannot move alone.`;
}

/** The one sentence on what depends on this key, from the facts that were read. Wallet kind only. */
function blastRadius(report: ScanReport): string {
  const { authorities, nfts, stakeSol, stakeAccounts, exposure, sol, tokenCount, confidence } = report;
  const parts: string[] = [];
  if (exposure.usd !== null && exposure.usd > 0) {
    parts.push(`${formatUsdHeadline(exposure.usd)} of holdings`);
  } else {
    if (sol !== null && sol > 0) parts.push(`${formatSolAmount(sol)} SOL`);
    if (tokenCount !== null && tokenCount > 0) parts.push(count(tokenCount, "token"));
    if (stakeSol !== null && stakeSol > 0) {
      parts.push(
        `${formatSolAmount(stakeSol)} SOL staked${stakeAccounts !== null ? ` in ${count(stakeAccounts, "account")}` : ""}`,
      );
    }
  }
  if (nfts !== null && nfts > 0) parts.push(count(nfts, "NFT"));
  const mints = authorities.mints.length;
  if (mints > 0) parts.push(`the supply of ${count(mints, "token")}`);
  const programs = authorities.programs.length;
  if (programs > 0) parts.push(`the code of ${count(programs, "upgradeable program")}`);

  const caveat = confidence === "complete" ? "" : " Sources that did not answer are not included.";
  if (parts.length === 0) {
    if (confidence === "unavailable") return "Nothing could be read, so the reach of this key is unknown.";
    return `Nothing was found that depends on this key.${coControlled(report)}${caveat}`;
  }
  return `Whoever can sign for this Ed25519 key controls ${joinList(parts)}.${coControlled(report)}${caveat}`;
}

interface AuthorityListProps<T> {
  items: T[];
  source: SourceState;
  whenEmpty: string;
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
}

function AuthorityList<T>({ items, source, whenEmpty, keyOf, render }: AuthorityListProps<T>) {
  if (items.length === 0) return <EmptyFor source={source} whenEmpty={whenEmpty} />;
  return (
    <ul className="mt-3 border-t border-line">
      {items.map((item) => (
        <li key={keyOf(item)}>{render(item)}</li>
      ))}
    </ul>
  );
}

/* --- Squads multisigs --------------------------------------------- */

const MEMBERS_FOLDED = 5;
const MULTISIGS_FOLDED = 3;

function permissionLabel(m: ScanMultisigMember): string {
  const parts: string[] = [];
  if (m.initiate) parts.push("initiate");
  if (m.vote) parts.push("vote");
  if (m.execute) parts.push("execute");
  return parts.length > 0 ? parts.join(" · ") : "no permissions";
}

/** "1h 30m" style time lock, from seconds. */
function timeLockLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round((seconds / 3600) * 10) / 10}h`;
  return `${Math.round((seconds / 86_400) * 10) / 10}d`;
}

function MemberList({ members, memberCount, scanned }: { members: ScanMultisigMember[]; memberCount: number; scanned: string }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? members : members.slice(0, MEMBERS_FOLDED);
  const hidden = members.length - shown.length;
  const unlisted = memberCount - members.length;
  return (
    <ul className="mt-3 border-t border-line">
      {shown.map((m) => (
        <li
          key={m.key}
          // The scan column keeps a fixed width, so the permission labels line up on every row,
          // including the scanned address that has no scan link.
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-line py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_2.5rem]"
        >
          <span className="col-span-2 inline-flex flex-wrap items-center gap-2 sm:col-span-1">
            <Address value={m.key} label="member key" head={6} tail={6} />
            {m.key === scanned ? <span className="chip !px-2 !py-0.5 text-[10px] uppercase tracking-[0.14em]">this address</span> : null}
          </span>
          <span className="font-mono text-[11px] text-mute">{permissionLabel(m)}</span>
          {m.key === scanned ? (
            <span aria-hidden />
          ) : (
            <Link
              href={`/scan?a=${encodeURIComponent(m.key)}`}
              className="justify-self-end font-mono text-[11px] uppercase tracking-[0.14em] text-mute transition-colors hover:text-paper"
            >
              scan
            </Link>
          )}
        </li>
      ))}
      {hidden > 0 || expanded ? (
        <li className="py-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="font-mono text-[11px] uppercase tracking-[0.14em] text-mute transition-colors hover:text-paper"
          >
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        </li>
      ) : null}
      {unlisted > 0 ? (
        <li className="py-2 font-mono text-[11px] text-mute">
          {count(unlisted, "more member")} not listed in the report
        </li>
      ) : null}
    </ul>
  );
}

/** One multisig: address, k of n, time lock, config authority, vault 0 and its value, the members. */
function MultisigCard({ m, scanned, heading }: { m: ScanMultisigAccount; scanned: string; heading?: string }) {
  const { vault } = m;
  const vaultSub =
    vault === null
      ? null
      : [
          vault.sol !== null ? `${formatSolAmount(vault.sol)} SOL` : "SOL not read",
          vault.tokenCount !== null ? count(vault.tokenCount, "token") : null,
          vault.note || null,
        ]
          .filter((x): x is string => x !== null)
          .join(" · ");

  return (
    <div className="mt-3 rounded-xl border border-line bg-ink p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex flex-wrap items-center gap-2">
          {heading ? <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mute">{heading}</span> : null}
          <Address value={m.address} label="multisig address" head={6} tail={6} />
        </span>
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="chip">
            {m.threshold} of {m.memberCount}
          </span>
          {m.timeLock > 0 ? <span className="chip">time lock {timeLockLabel(m.timeLock)}</span> : null}
        </span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 font-mono text-[11px] text-mute sm:grid-cols-[auto_1fr]">
        <dt>config authority</dt>
        <dd className="text-paper">
          {m.configAuthority === null ? (
            "the multisig itself"
          ) : (
            <Address value={m.configAuthority} label="config authority" head={6} tail={6} />
          )}
        </dd>
        <dt>transactions</dt>
        <dd className="tnum text-paper">{formatInt(m.transactionIndex)}</dd>
      </dl>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="inline-flex flex-wrap items-center gap-2 text-sm">
          <span className="text-paper">Vault 0</span>
          {vault !== null ? <Address value={vault.address} label="vault address" head={6} tail={6} /> : null}
        </span>
        <span className="tnum font-mono text-sm text-paper">
          {vault === null ? (
            <span className="text-mute">not valued</span>
          ) : vault.usd !== null ? (
            formatUsd(vault.usd)
          ) : (
            <Unavailable />
          )}
        </span>
      </div>
      {vaultSub ? <div className="tnum mt-1 font-mono text-[11px] text-mute">{vaultSub}</div> : null}

      <div className="mt-4 flex items-baseline justify-between">
        <span className="eyebrow">Members</span>
        <span className="tnum font-mono text-[11px] text-mute">{m.memberCount}</span>
      </div>
      <MemberList members={m.members} memberCount={m.memberCount} scanned={scanned} />
    </div>
  );
}

function MultisigBlock({ report }: { report: ScanReport }) {
  const [expanded, setExpanded] = useState(false);
  const { multisigs, wallet } = report;
  const source = sourceOf(report, "multisigs");
  const { self, memberOf, coControlledUsd, coControlledSol, valued, memberOfTruncated } = multisigs;
  const shown = expanded ? memberOf : memberOf.slice(0, MULTISIGS_FOLDED);
  const hidden = memberOf.length - shown.length;

  return (
    <div className="mt-7">
      <div className="flex items-baseline justify-between">
        <span className="eyebrow">{self ? "Squads multisig" : "Squads memberships"}</span>
        <span className="tnum font-mono text-[11px] text-mute">
          {self ? (
            `${self.threshold} of ${self.memberCount}`
          ) : source.status === "ok" || source.status === "truncated" ? (
            `${memberOf.length}${memberOfTruncated ? "+" : ""}`
          ) : (
            <Unavailable source={source} />
          )}
        </span>
      </div>

      {self ? <MultisigCard m={self} scanned={wallet} /> : null}

      {memberOf.length > 0 ? (
        <>
          {self ? <div className="eyebrow mt-5">Member of</div> : null}
          {shown.map((m) => (
            <MultisigCard key={m.address} m={m} scanned={wallet} />
          ))}
          {hidden > 0 || expanded ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-mute transition-colors hover:text-paper"
            >
              {expanded ? "Show fewer" : `Show ${hidden} more`}
            </button>
          ) : null}
          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-line pt-3 text-sm">
            <span className="min-w-0">
              <span className="text-paper">Co-controlled through multisigs</span>
              <span className="ml-2 text-xs text-mute">
                vault 0 valued for {valued} of {memberOf.length}
                {memberOfTruncated ? "+" : ""} · not in Quantum exposure
              </span>
            </span>
            <span className="tnum shrink-0 font-mono text-paper">
              {coControlledUsd !== null ? formatUsd(coControlledUsd) : <Unavailable />}
            </span>
          </div>
          {coControlledSol !== null ? (
            <div className="tnum mt-1 font-mono text-[11px] text-mute">{formatSolAmount(coControlledSol)} SOL across them</div>
          ) : null}
        </>
      ) : self === null ? (
        <EmptyFor source={source} whenEmpty={multisigs.note} />
      ) : null}

      {source.status === "truncated" && source.error ? (
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-mute">{source.error}</p>
      ) : null}
      {self !== null || memberOf.length > 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-mute">{multisigs.note}</p>
      ) : null}
    </div>
  );
}

export function ControlPanel({ report }: { report: ScanReport }) {
  const { mints, programs, burnedIgnored } = report.authorities;
  const mintSource = sourceOf(report, "mintAuthorities");
  const programSource = sourceOf(report, "programAuthorities");
  const multisigSource = sourceOf(report, "multisigs");
  const isWallet = report.address.kind === "wallet";
  const multisigAside =
    report.multisigs.self !== null
      ? "a Squads v4 multisig"
      : multisigSource.status === "ok" || multisigSource.status === "truncated"
        ? `multisigs: ${report.multisigs.memberOf.length}${report.multisigs.memberOfTruncated ? "+" : ""} · Squads v4`
        : multisigSource.status === "skipped"
          ? "multisigs: not checked"
          : "multisigs: unavailable";

  return (
    <Panel eyebrow="Control" aside={<span className="font-mono text-[11px] text-mute">{multisigAside}</span>}>
      <div className="mt-6">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Mint authorities</span>
          <span className="tnum font-mono text-[11px] text-mute">
            {mintSource.status === "ok" || mints.length > 0 ? mints.length : <Unavailable source={mintSource} />}
          </span>
        </div>
        <AuthorityList
          items={mints}
          source={mintSource}
          whenEmpty="This address is not the mint or freeze authority of any token it holds."
          keyOf={(m) => m.mint}
          render={(m) => (
            <div className="grid gap-x-4 gap-y-1 border-b border-line py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
              <Address value={m.mint} label="mint address" head={6} tail={6} />
              <span className="tnum font-mono text-xs text-mute">
                {m.supply !== null ? `supply ${formatAmount(m.supply)}` : "supply unavailable"}
              </span>
              <span className="chip justify-self-start sm:justify-self-end">{ROLE_LABEL[m.role]}</span>
            </div>
          )}
        />
      </div>

      <div className="mt-7">
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">Program upgrade authorities</span>
          <span className="tnum font-mono text-[11px] text-mute">
            {programSource.status === "ok" || programs.length > 0 ? (
              programs.length
            ) : (
              <Unavailable source={programSource} />
            )}
          </span>
        </div>
        <AuthorityList
          items={programs}
          source={programSource}
          whenEmpty="No upgradeable program lists this address as its upgrade authority."
          keyOf={(p) => p}
          render={(p) => (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3">
              <Address value={p} label="program data address" head={6} tail={6} />
              <span className="font-mono text-xs text-mute">program data</span>
            </div>
          )}
        />
      </div>

      {burnedIgnored > 0 ? (
        <p className="mt-5 font-mono text-[11px] leading-relaxed text-mute">
          {count(burnedIgnored, "authority field", "authority fields")} set to 111…111 (burned) or to an off-curve
          value {burnedIgnored === 1 ? "was" : "were"} ignored: no private key exists for them.
        </p>
      ) : null}

      <MultisigBlock report={report} />

      {isWallet ? (
        <div className="mt-7 rounded-xl border border-line bg-ink p-4">
          <div className="eyebrow">Blast radius</div>
          <p className="mt-2 text-sm leading-relaxed text-paper">{blastRadius(report)}</p>
        </div>
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Activity                                                            */
/* ------------------------------------------------------------------ */

function When({ unixSeconds, nowMs, source }: { unixSeconds: number | null; nowMs: number; source: SourceState }) {
  if (unixSeconds === null) {
    return source.status === "ok" ? <span className="text-mute">none seen</span> : <Unavailable source={source} />;
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-sans text-paper">{relativeTime(unixSeconds, nowMs)}</span>
      <span className="tnum font-mono text-xs text-mute">{formatUtcDateTime(unixSeconds)}</span>
    </span>
  );
}

export function ActivityPanel({ report }: { report: ScanReport }) {
  const { lastActivity, oldestSeen, txCount, scannedAt } = report;
  const signatures = sourceOf(report, "signatures");
  return (
    <Panel eyebrow="Activity">
      <dl className="mt-4">
        <Row label="Last activity">
          <When unixSeconds={lastActivity} nowMs={scannedAt} source={signatures} />
        </Row>
        <Row label="Transactions">
          {txCount !== null ? (
            <>
              {formatTxCount(txCount)}
              {txCount >= 1000 ? (
                <span className="text-mute"> · only the newest 1,000 signatures were read</span>
              ) : null}
            </>
          ) : (
            <Unavailable source={signatures} />
          )}
        </Row>
        <Row label="Oldest seen">
          <When unixSeconds={oldestSeen} nowMs={scannedAt} source={signatures} />
        </Row>
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-mute">
        Oldest seen is the oldest of the last 1,000 signatures, not the first transaction of this address.
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Recommendations                                                     */
/* ------------------------------------------------------------------ */

/** Recommendations the page can act on, matched by prefix against the server's wording. */
const ACTIONS: [prefix: string, href: string, cta: string][] = [
  ["create a dirac passport", "/passport", "Create passport"],
  ["switch to hardened mode", "/passport", "Reissue"],
  ["anchor the passport", "/passport", "Anchor"],
];

function actionFor(text: string): { href: string; cta: string } | null {
  const t = text.trim().toLowerCase();
  const hit = ACTIONS.find(([prefix]) => t.startsWith(prefix));
  return hit ? { href: hit[1], cta: hit[2] } : null;
}

export function RecommendationsPanel({ report }: { report: ScanReport }) {
  const items = report.recommendations;
  const isWallet = report.address.kind === "wallet";
  const complete = report.confidence === "complete";

  return (
    <section className="rounded-[18px] border border-line bg-ink p-6 md:p-8">
      <span className="eyebrow">Do this first</span>
      {items.length > 0 ? (
        <ul className="mt-4 space-y-3 text-sm text-paper">
          {items.map((text) => {
            const action = isWallet ? actionFor(text) : null;
            return (
              <li key={text} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-mute">→</span>
                <span className="min-w-0 flex-1 leading-relaxed">{text}</span>
                {action ? (
                  <Link href={action.href} className="chip transition-colors hover:border-paper/40">
                    {action.cta}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-4 text-sm leading-relaxed text-mute">
          {isWallet
            ? "Nothing pressing. No missing passport step, held authority or dormant holding was found."
            : report.address.kind === "unknown"
              ? "No recommendation: the address could not be classified."
              : "Nothing to do here: no private key signs for this address."}
        </p>
      )}
      {!complete ? (
        <p className="mt-4 font-mono text-[11px] leading-relaxed text-mute">
          Some sources did not answer, so this list may be incomplete.
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Methodology                                                         */
/* ------------------------------------------------------------------ */

const DEFINITIONS: [string, string][] = [
  [
    "Quantum exposure",
    "SOL, priced tokens and stake under this key, at the SOL price when scanned. Unpriced tokens, NFTs and the supply behind held mint authorities are listed but not valued. A passport does not change this number.",
  ],
  [
    "PQ identity",
    "none: no Dirac passport in the registry. simple: passport keys derived from a wallet signature. hardened: independent keys. Anchored means a memo on Solana fixes the date of the passport.",
  ],
  [
    "Data confidence",
    "complete: every source answered. partial: some did not; their fields read Unavailable, the report is not cached and cannot be shared. unavailable: both the balance and the asset read failed.",
  ],
  [
    "Address kind",
    "The address is classified first: account owner, executable flag, Ed25519 curve check and the known list of system programs. Passport advice applies to signing wallets only. Authorities set to 111…111 or to an off-curve value count as burned, not as control.",
  ],
  [
    "Multisig",
    "Squads v4 only. The address is a multisig when the Squads program owns it and the account parses; memberships come from 20 filtered program scans covering the first 10 member slots of both account layouts, cap 20; the first 16 members of each multisig are listed (the member count is the real count); vault 0 only is valued (SOL plus one page of priced tokens, first 10 multisigs). Co-controlled value is reported apart from the key's own exposure, never added to it.",
  ],
  [
    "Recommendations",
    "Derived facts only, at most five: missing passport steps, held authorities, dormant holdings over 180 days with at least 1 SOL, and large balances under one key.",
  ],
];

export function MethodologyPanel({ report }: { report: ScanReport }) {
  return (
    <Panel eyebrow="Methodology" aside={<span className="font-mono text-[11px] text-mute">v3 · open</span>}>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-mute">
        There is no single score. Three indicators are computed on the server from public chain data; every
        read is listed with its status under Data confidence. Anyone can repeat the reads.
      </p>

      <dl className="mt-4 border-t border-line">
        {DEFINITIONS.map(([k, v]) => (
          <div key={k} className="grid gap-1 border-b border-line py-2.5 sm:grid-cols-[150px_1fr] sm:gap-6">
            <dt className="text-xs text-paper">{k}</dt>
            <dd className="text-xs leading-relaxed text-mute">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6">
        <span className="eyebrow">What is read</span>
        <dl className="mt-2">
          {SOURCE_ORDER.map((name) => (
            <div key={name} className="grid gap-1 border-t border-line py-2 sm:grid-cols-[150px_1fr] sm:gap-6">
              <dt className="text-xs text-mute">{SOURCE_LABEL[name]}</dt>
              <dd className="font-mono text-xs text-paper">{SOURCE_METHOD[name]}</dd>
            </div>
          ))}
        </dl>
      </div>

      {report.limited ? (
        <div className="mt-6 rounded-xl border border-line bg-ink-3 px-4 py-3 font-mono text-[11px] leading-relaxed text-paper">
          <span className="text-mute">limited data · </span>
          No private RPC was configured on the server, so assets, stake and authorities were not read. Those
          fields read not checked.
        </div>
      ) : null}
    </Panel>
  );
}

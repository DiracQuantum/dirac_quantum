-- Quantum pet, Sybil caps on wallet-signed gates (worker/pet.ts, docs/CONTRACT-WEEK2.md).
-- pet_wallet_ips: the wallets that signed a gate from one network address on one UTC day; the Worker
--   lets at most WALLETS_PER_IP_PER_DAY (src/lib/petGate.ts) of them in per (utc_day, ip_hash).
--   ip_hash is the first 16 hex of sha256(client ip), the same tag pet_actions.client stores; never the address.
-- pet_wallets: whether a wallet has an account on Solana (getAccountInfo), cached per wallet with the time
--   of the check; a wallet with no account cannot sign gates, so a throwaway key costs a funded account.

CREATE TABLE IF NOT EXISTS pet_wallet_ips (
  utc_day INTEGER NOT NULL,
  ip_hash TEXT    NOT NULL,
  wallet  TEXT    NOT NULL,
  PRIMARY KEY (utc_day, ip_hash, wallet)
);

CREATE TABLE IF NOT EXISTS pet_wallets (
  wallet     TEXT    PRIMARY KEY,
  on_chain   INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);

# FWaaS spike — bank-free ledger + instant on-chain settlement

A runnable spike evaluating a **fiat-wallet-as-a-service** architecture with **no
bank or banking partner in the fund-movement path**: a self-hosted double-entry
ledger plus a self-custodied stablecoin settlement rail.

- **Ledger:** [TigerBeetle](https://tigerbeetle.com) — purpose-built financial
  accounting DB (double-entry, two-phase transfers). Falls back to an in-memory
  ledger with identical semantics when no cluster is reachable, so the demo runs
  anywhere.
- **Settlement rail:** **USDC on Stellar** (testnet here). ~5s finality,
  sub-cent fees, self-custody = total control. Swap the asset issuer + Horizon
  URL for mainnet; the flow is unchanged.

## The one honest caveat

Software cannot make **fiat** move without a regulated entity. USD in/out (the
on/off-ramp between USD and USDC) still touches a licensed party
(Circle/Bridge/Stellar anchor). What you *do* get bank-free: custody, the
ledger, and near-instant settlement of the on-chain balance. Running this for
third parties may also require money-transmitter licensing (FinCEN MSB + state
MTLs) — confirm with counsel.

## Flow

```
FUNDING ──post──► TRUST_OPERATING        (USD→USDC on-ramp, seeds the wallet)

TRUST_OPERATING ──pending(hold)──► BENEFICIARY     (1) book distribution
        │
        ▼   USDC-on-Stellar payment (distributor → beneficiary), ~5s
   on-chain confirmed?
        ├─ yes → post pending transfer   (2) ledger = settled, reconciled
        └─ no  → void pending transfer       (funds released, no double-spend)
```

The two-phase transfer is the maker/checker hold: funds are atomically reserved,
then only posted once the chain confirms — ledger and chain never diverge.

## Run

```bash
npm install

# Option A — with a real TigerBeetle cluster (recommended):
#   download the single binary from https://tigerbeetle.com, then:
TB_BIN=/path/to/tigerbeetle npm run tb:format
TB_BIN=/path/to/tigerbeetle npm run tb:start        # leave running in another shell
TB_ADDRESS=3033 npm run demo

# Option B — in-memory ledger (no TigerBeetle needed):
npm run demo

# Ledger mechanics only, skip the network:
npm run demo:ledger-only
```

Env knobs: `AMOUNT_CENTS` (default 125000 = $1,250), `SEED_CENTS` (default
500000 = $5,000), `HORIZON_URL`, `FRIENDBOT_URL`, `USDC_CODE`, `TB_ADDRESS`.

## Example run (TigerBeetle + Stellar testnet)

```
[1] Ledger backend: tigerbeetle@3033
[2] Funded trust operating wallet: $5,000.00
[3] Booked distribution HOLD: $1,250.00  (pending, funds reserved)
[5] Settling on-chain (distributor → beneficiary)…
    ✔ confirmed in ledger #3708495 in 4929 ms
    beneficiary USDC after:  1250.0000000  (+1250.00)
[6] On-chain confirmed → ledger hold POSTED (settled).
[7] Final reconciliation (cents):
    trust operating available: 375000  (= $3,750.00)
    beneficiary received:      125000  (= $1,250.00)
```

## Files

- `ledger.js` — double-entry ledger (TigerBeetle adapter + in-memory fallback).
- `stellarSettlement.js` — USDC-on-Stellar provisioning + settlement.
- `demo.js` — end-to-end orchestration + reconciliation.
- `scripts/tb-run.js` — format/start a local TigerBeetle dev cluster.

## Where this could go in dlbtrust-app

This maps cleanly onto the existing Payment Hub maker/checker model: a
`stellar`/`usdc` connector alongside the ACH/wire connectors, with the Payment
Hub intent lifecycle (pending → approved → submitted → settled) driving the
two-phase ledger transfer and the on-chain payment. TigerBeetle would sit beside
(or eventually behind) the Fineract GL as the high-throughput settlement ledger.

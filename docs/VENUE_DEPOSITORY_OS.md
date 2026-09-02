# Venue Depository OS

The trust's own bank accounts, wired into the unified data workflow.

A depository is registered in Venue Account OS (`--provider depository`) as a
record only. Venue Depository OS joins that record to:

1. the **BankingAggregator** connection/account that reads the bank, and
2. the **trust GL cash account** the bank's transactions book to (default `1000`).

Once linked, nothing about the balance is asserted by hand:

| Step | Where | What happens |
|------|-------|--------------|
| Read | `VenueDepositoryOsEngine.read` | Latest `banking_aggregator_accounts` row. Fresh → `live`; older than `VENUE_DEPOSITORY_FRESH_MINUTES` → `unverified` with `lastKnownCents` kept for context. |
| Evidence | `VenueAccountOsEngine.probe` → `ReserveEngine.record` | A live read is recorded as `depository_account` custody evidence. Stale reads are never recorded as current funds. |
| Booking | `DataBridge.syncAggregatorToAccounting` | Aggregator transactions post to the linked GL account; unlinked accounts still post to `1000`. |
| Reconcile | `DataBridge.runFullSync` → `VenueDepositoryOsEngine.reconcile` | Live bank balances summed per GL account vs `trust_accounts.balance`. Gaps become `depository_balance_mismatch` discrepancies; balanced accounts auto-resolve them. |
| Status | `DataBridge.getDataFlowStatus().modules.venue_depositories` | Linked / live / total confirmed cents / unlinked depository venues. |

## Guards

- The venue must exist and be a `depository` provider.
- The aggregator account must already have been pulled; the `internal_rails`
  connector is refused (it is the trust's own ledger, not an outside bank).
- The GL account must be an active `asset` account.
- One aggregator account maps to one venue.

## Operator workflow

```bash
npm run trust:venues -- register --provider depository --by trustee@dlbtrust.org --label "Trust checking"
npm run trust:venues -- approved --id VENUE-… --by trustee@dlbtrust.org --evidence "bank welcome letter"
npm run trust:depositories -- accounts
npm run trust:depositories -- link --id VENUE-… --connection <conn> --account <acct> --gl 1000 --by trustee@dlbtrust.org
npm run trust:depositories -- probe --id VENUE-… --refresh
npm run trust:depositories -- reconcile
npm run trust:depositories -- list
```

## API (`/api/venue-depository-os`)

| Method | Path | Role |
|--------|------|------|
| GET | `/depositories` | operator |
| GET | `/depositories/:id` | operator |
| POST | `/depositories` `{ venueId, connectionId, externalAccountId, glAccountCode?, linkedBy? }` | admin |
| DELETE | `/depositories/:id` | admin |
| POST | `/depositories/:id/probe` `{ refresh? }` | admin |
| POST | `/reconcile` `{ refresh? }` | admin |

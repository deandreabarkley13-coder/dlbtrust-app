---
name: testing-payment-hub
description: Test the Payment Hub ACH orchestration lifecycle end-to-end. Use when verifying intent state, local ACH staging, signed webhooks, accounting idempotency, or sandbox transport safety.
---

# Testing Payment Hub

## Scope

Exercise one canonical payment intent through creation, approval, safe submission, processor-confirmed settlement, and exactly-once accounting. Default to an isolated PostgreSQL database and local ACH sandbox staging. Never claim real bank settlement from local evidence.

## Devin Secrets Needed

Local sandbox testing can use session-only synthetic values; no production secret is required.

Secret names used by the runtime:

- `ADMIN_SECRET_TOKEN`
- `PAYMENT_DATA_ENCRYPTION_KEY`
- `PAYMENT_HUB_SERVICE_TOKEN`
- `PAYMENT_HUB_WEBHOOK_SECRET`
- `PAYMENT_HUB_AUTH_TOKEN` when testing a real Payment Hub EE endpoint
- Bank/ODFI connector credentials only after explicit live-transmission approval

Never place real routing/account numbers, private keys, bank credentials, or webhook secrets in evidence or source control.

## Runtime setup

1. Use `server/server-3002.js` and an isolated PostgreSQL database.
2. Set `PAYMENT_HUB_MODE=local_ach`, `PAYMENT_HUB_LIVE=false`, and database `system_settings.system_mode=sandbox` for the initial gate test.
3. Use valid synthetic ACH originator values. Keep beneficiary data synthetic and verify it is masked publicly and encrypted in PostgreSQL.
4. Confirm startup logs show ACH schema initialization before Payment Hub schema initialization and listening:

```text
[ach] tables ensured
[payment-hub] tables ensured
[dlbtrust-treasury] running on port ...
```

An isolated database might emit warnings from unrelated modules whose tables or services are absent. Treat Payment Hub/ACH initialization or route failures as blockers; report unrelated warnings as test limitations.

## Primary lifecycle

1. Verify unauthenticated operator access returns `401` and authenticated health returns readiness details.
2. Create one intent with an idempotency key. Verify status, amount, source/debit accounts, public masking, and encrypted database storage.
3. Repeat the exact request and require the same intent with `idempotent=true`. Change the payload under the same key and require `409` without a second intent.
4. Approve the intent and verify no hold, ACH batch, journal, or balance change exists yet.
5. Submit while `PAYMENT_HUB_LIVE=false`; require fail-closed behavior and no financial mutation.
6. Restart the same database with `PAYMENT_HUB_LIVE=true` while `system_mode=sandbox`, then submit once. Require one active hold and one Payment Hub-owned ACH batch, with no pre-settlement journal.
7. Reject an invalid HMAC and an expired correctly signed webhook before persistence.
8. Sign `<unix_timestamp>.<exact raw JSON bytes>` with HMAC-SHA256 and settle the intent. Require captured hold, settled batch, posted accounting, balanced lines, and expected balances.
9. Replay the exact event and require idempotency. Reuse its event ID with a changed payload and require `409` without duplicate accounting.
10. Fetch the final intent and require masked values plus `audit.valid=true` with a nonzero event count.

## Proving local staging rather than external transmission

Do not expect the sanitized submission response to expose `mode`, `system_mode`, internal paths, or raw connector data. Prove transport behavior by combining:

- authenticated health: `systemMode=sandbox`, selected `partner=null`;
- linked batch: `partner_id=null`, `orchestration_owner=payment_hub`;
- exactly one matching encrypted local export;
- active partner rows: only the built-in `DLBTRUST-DIRECT`, protocol `rest_api`, `partner_url=direct`, with no API base URL, key, or secret;
- no remote endpoint evidence in logs or results.

The built-in active `DLBTRUST-DIRECT` row is expected and is not an external ODFI. Fail the assertion if another active partner, remote URL, or external credential is present.

## NACHA evidence

The generator uses CRLF separators. Decrypt the database/file evidence, split it on `\r\n`, remove the final empty element, and require every logical record to be exactly 94 characters. Do not divide total byte length by 94 because separators are not record columns.

Require encrypted/non-plaintext stored content and owner-only file permissions (`0600`) where supported. Public responses must omit NACHA content, internal file/export paths, and raw external responses.

## Reporting and cleanup

- Preserve every HTTP body/status and SQL invariant query.
- Clearly separate preliminary harness failures from application failures; retain corrected evidence without rewriting history.
- State that sandbox staging is not live ACH/wire settlement and does not prove ODFI onboarding or production operations.
- Stop the local server after evidence collection. Do not delete or alter settled evidence before the report is complete.

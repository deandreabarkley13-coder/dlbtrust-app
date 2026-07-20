# Eaton Family CU — ACH Origination Onboarding

This document is the request to send Eaton Family Credit Union's treasury / cash-management
(or their core/IT) team so this application can move funds from its ledgers into the
**Eaton Family CU Trust Checking** account as **on-us ACH credits**, and — once approved —
auto-deliver the generated NACHA files with no human in the loop.

Eaton is both the **ODFI** (originating institution) and the **RDFI** (receiving institution)
for this flow, so these transfers are on-us ACH credits (an internal book transfer within
Eaton). We generate a standard NACHA file and deliver it to Eaton's drop; Eaton submits/settles it.

---

## 1. What we are asking Eaton to provide

Please provision the following so we can originate ACH credits to the trust checking account:

### A. ACH origination authorization
- [ ] Authorization for us to **originate ACH credit entries** (SEC code **CCD**) to the
      trust checking account, as an on-us transfer.
- [ ] Our **ACH Company ID / Originator ID** (10-digit company identification) and the
      **Company Name** Eaton wants in the batch header.
- [ ] The **immediate origin / immediate destination** routing values Eaton expects in the
      file header (confirm whether Eaton's ABA **241075470** is used for both, since Eaton is
      ODFI and RDFI).
- [ ] Any **origination limits** (per-file, daily, monthly) and the **cutoff times** /
      settlement calendar for same-day vs. next-day ACH.

### B. Destination (trust checking) account details
- [ ] **Routing / ABA number** of the trust checking account (we currently default to
      Eaton's `241075470` — please confirm).
- [ ] **Account number** of the *Eaton Family CU Trust Checking* account (the credit destination).
- [ ] The exact **account name** to use on entries.

### C. File transmission channel (SFTP)
- [ ] **SFTP hostname and port** for the NACHA drop.
- [ ] The **username** and the **directory** to place outbound files in (e.g. `/incoming/`).
- [ ] Authentication method:
      - **Preferred:** SSH **public-key** auth — we will send you our public key; you install it.
      - **Fallback:** a password (we will store it as a secret, never in code or git).
- [ ] Eaton's **SFTP host key / fingerprint** so we can pin it (`known_hosts`) and reject MITM.
- [ ] The **file naming convention** and any **PGP encryption** requirement for files at rest.
- [ ] Where Eaton drops **acknowledgment / return files** (ACK/NACK, R-return records) for us to pull.

### C-alt. File transmission channel (REST API) — if Eaton prefers HTTPS over SFTP
The app also supports transmitting the same NACHA/ISO 20022 payment file over a
**REST API** (machine-to-machine), as an alternative to SFTP. If Eaton exposes a
REST file-exchange API instead of (or in addition to) SFTP, provide:
- [ ] **API base URL** (e.g. `https://api.eatonfamilycu.example/v1`).
- [ ] **OAuth2 token URL** + **client_id** / **client_secret** (client-credentials grant),
      and/or **mutual TLS** client-certificate requirements.
- [ ] **File-intake endpoint** (POST) that accepts a payment file (we send a JSON
      envelope `{ filename, format, encoding: "base64", content }`).
- [ ] **File-status endpoint** (GET by submission id) and **returns endpoint** (GET)
      for ACK/NACK and R-return records.

### D. Testing
- [ ] A **test/sandbox** window: a penny-test or zero-dollar prenote (SEC code with
      transaction code `23`/`28` prenotification) to validate routing + account before live credits.
- [ ] Contact for **return/exception handling** (R01 insufficient funds, R02 account closed, etc.).

---

## 2. How the application uses these values (all env-driven, no secrets in code)

Once Eaton returns the above, they are set as environment variables / secrets — nothing is hardcoded:

| Setting | Purpose |
| --- | --- |
| `TRUST_BANK_ROUTING` | Trust checking routing/ABA (default `241075470`). |
| `TRUST_BANK_ACCOUNT` | Trust checking account number (the credit destination). **Required.** |
| `TRUST_BANK_NAME` | Display name for the destination (default `Eaton Family CU Trust Checking`). |
| `ACH_SFTP_URL` | `sftp://user@host:port/incoming` — presence enables SFTP delivery. |
| `ACH_SFTP_KEY` | Path to our SSH private key (preferred auth). |
| `ACH_SFTP_PASSWORD` | Password (fallback auth) — stored as a secret. |
| `ACH_SFTP_KNOWN_HOSTS` | Path to a `known_hosts` file pinning Eaton's host key. |
| `ACH_SFTP_RETURN_PATH` | Remote directory where Eaton drops return/ACK files (default `/outbound`). |
| `ACH_RETURNS_DIR` | Local directory to save downloaded return files (default `data/ach-returns`). |
| `TRUST_BANK_AUTO_TRANSMIT` | `true` to auto-deliver each generated NACHA file to Eaton. |
| `TRUST_ID` | Protected trust identifier (redacted in logs; never hardcoded). |
| `TRUST_MASTER_ACCOUNT` | Protected trust master (control) account number (redacted; never hardcoded). |

The ACH Company ID / Originator ID lives in the NACHA generator config
(`server/integrations/ach/nachaGenerator.js`) — provide the value and we set it there.

### Automated SFTP file-drop client (`server/scripts/eaton-file-drop.js`)
Once Eaton returns the SFTP channel, this env-driven CLI handles the file-drop
protocol machine-to-machine — no host, credential, or account value is hardcoded,
and every identifier is redacted in output:

```
node server/scripts/eaton-file-drop.js --status            # show redacted config + readiness
node server/scripts/eaton-file-drop.js --upload <batchId>  # upload one NACHA batch
node server/scripts/eaton-file-drop.js --upload-pending    # upload all pending batches
node server/scripts/eaton-file-drop.js --fetch-returns     # download return/ACK files
node server/scripts/eaton-file-drop.js --dry-run --upload-pending   # report only, no I/O
```

Uploads route through the hardened ACH transmit path (arguments via `execFile`,
no shell; password read from `SSHPASS` env, never argv; host key pinned via
`ACH_SFTP_KNOWN_HOSTS` or trust-on-first-use). Without `ACH_SFTP_URL` the script
**refuses to transmit** (fail-safe). It can run on a schedule (cron / systemd timer)
for fully hands-off origination and return reconciliation.

### Alternative: REST payment-file transmission (aggregator `eaton` connector)
If Eaton uses a REST API instead of SFTP, register the direct connection with
`node server/scripts/register-eaton-connection.js` using these variables. The
`eaton` connector then transmits the payment file over REST with machine-to-machine
OAuth2 (and optional mutual TLS), and pulls file status + ACH returns back:

| Setting | Purpose |
| --- | --- |
| `EATON_CONNECTOR` | `eaton` (REST payment-file exchange) or `generic_rest` (default `eaton`). |
| `EATON_BASE_URL` | Eaton REST API base URL. **Required.** |
| `EATON_TOKEN_URL` / `EATON_CLIENT_ID` / `EATON_CLIENT_SECRET` | OAuth2 client-credentials (M2M). **Required.** |
| `EATON_FILE_INTAKE_PATH` | POST payment file (default `/ach/files`). |
| `EATON_FILE_STATUS_PATH` | GET submission status (default `/ach/files`). |
| `EATON_RETURNS_PATH` | GET ACH returns / ACK-NACK (default `/ach/returns`). |
| `EATON_USE_MTLS` + `EATON_CLIENT_CERT_PATH` / `EATON_CLIENT_KEY_PATH` | Optional mutual TLS. |

Transmit a file: `POST /api/aggregator/connections/CONN-EATON-FCU/push` with
`{ "kind": "ach_file", "ach_batch_id": "<batch>" }` (or inline `content`).
Reconcile: `GET .../file-status?submissionId=<id>` and `POST .../returns`.

### Optional hands-off sweep (off by default)
An automated sweep can move accumulated fixed-income cash into the trust checking account on a
schedule. It is disabled unless explicitly enabled and is idempotent (a persisted per-window
ledger prevents a restart from double-sweeping):

| Setting | Purpose |
| --- | --- |
| `TRUST_SWEEP_ENABLED` | `true` to enable the scheduled sweep (default off). |
| `TRUST_SWEEP_INTERVAL_MS` | Sweep cadence (default daily). |
| `TRUST_SWEEP_SOURCE_ACCOUNT` | Source GL cash account (default `1000`). |
| `TRUST_SWEEP_MIN_RESERVE` | Cash to leave in the source account each sweep. |
| `TRUST_SWEEP_MIN_AMOUNT` | Don't sweep below this (no dust transfers). |
| `TRUST_SWEEP_MAX_AMOUNT` | Optional per-run cap. |

---

## 3. What the application does automatically (already built)

1. Books the transfer as an **asset reclass** — `DR 1010 Eaton Family CU Trust Checking /
   CR source cash` — no P&L impact (it is not an expense or a distribution).
2. Generates a **NACHA CCD credit** entry (transaction code `22`) to the trust checking account.
3. When `TRUST_BANK_AUTO_TRANSMIT=true`, **delivers the file over SFTP** to Eaton's drop
   (key-based auth, host-key verified), with no human step.
4. Records every deposit as a tracked settlement, and every sweep in a **persisted idempotent
   audit ledger** (`trust_sweeps`) queryable at `GET /api/electronic-settlement/sweep-history`.

## 4. Important constraints (accurate expectations)

- A NACHA file alone does **not** move money — Eaton must **accept and submit** it into settlement.
  Live movement begins only after Eaton enables origination and we set the values above.
- We will not transmit live files until Eaton confirms the SFTP channel and provides a
  successful prenote/penny-test result.
- No account numbers, keys, or passwords are ever committed to source control or logged in plaintext.

---

### Contacts

- **Requestor:** DeAndrea Lavar Barkley Trust
- **Please route to:** Eaton Family CU Treasury / Cash Management / ACH Operations

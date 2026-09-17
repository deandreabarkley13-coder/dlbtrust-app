# M2M OS runbook — unattended payment file exchange with a bank

How the trust goes from "an operator uploads a file to the bank portal" to
"two backends exchange payment files on a timer, with no human in the loop".

Two engines do the work and neither needs to be rebuilt:

- `MftOsEngine` (`server/integrations/os/mftOsEngine.js`) — builds the payment
  file, holds its lifecycle (`built → approved → transmitted → acknowledged →
  settled`), puts the bytes on the bank host under a staging name, renames, and
  reads the bank's acknowledgements and returns back.
- `M2mOsEngine` (`server/integrations/os/m2mOsEngine.js`) — owns *who* the bank
  is talking to. Each banking partner gets an RSA key pair generated on this
  host; the private half is encrypted into Postgres with
  `PAYMENT_DATA_ENCRYPTION_KEY` and is never served by any route, written to the
  environment, or handed to a person. The public half goes to the bank once, out
  of band, for `authorized_keys`.

All steps below are HTTP calls against `/api/m2m-os`
(`server/routes/m2mOs.js`). Identities and partners are admin-gated; handshake,
cycle and manifest verification are operator-gated. Either a JWT
(`Authorization: Bearer ...`) or the legacy admin token satisfies both:

```bash
BASE=https://<host>
AUTH="x-admin-token: $ADMIN_SECRET_TOKEN"
```

## 1. Configure the environment

See the `MFT OS / M2M OS` block in `.env.example` for every variable. The ones
that decide whether the exchange runs at all:

| Variable | Effect |
| --- | --- |
| `M2M_CYCLE_INTERVAL_MS` | `0` (default) = no scheduler. A positive value arms the unattended cycle; e.g. `300000` for every 5 minutes. |
| `M2M_KEY_BITS` / `M2M_KEY_COMMENT` | Identity key size (default `3072`) and the comment in the `authorized_keys` line (default `dlbtrust-m2m`). |
| `PAYMENT_DATA_ENCRYPTION_KEY` | Required. Encrypts identity private keys at rest. No key, no identities — and rotating it orphans the keyring. |
| `MFT_SFTP_HOST` | Must be a real bank host. Without it a channel uses the local spool transport, which `channelReadiness()` refuses in production unless `MFT_ALLOW_SPOOL_IN_PRODUCTION=true`. |
| `MFT_REQUIRE_APPROVAL` | `true` (default) = only files a second human released are transmitted. `false` = `transmit` auto-approves as `policy:no-approval`, which is what makes the flow fully unattended. See [Governance](#governance-the-control-being-removed). |

The scheduler itself is already wired: `server/server-3002.js` registers the
`m2m-os-cycle` leader job, which calls `M2mOsEngine.startScheduler()` on
election and `stopScheduler()` on loss. `startScheduler` is a no-op while
`M2M_CYCLE_INTERVAL_MS` is `0`, so only the environment decides whether the
timer runs — and only the elected leader replica runs it.

## 2. Create the machine identity

```bash
curl -sX POST "$BASE/api/m2m-os/identities" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"label":"Acme Bank production"}'
```

Returns the `identityId` and fingerprint. Fetch the `authorized_keys` line and
hand it to the bank out of band (their onboarding form, not email if avoidable):

```bash
curl -s "$BASE/api/m2m-os/identities/$IDENTITY_ID/public-key" -H "$AUTH"
```

The response body is the literal `ssh-rsa AAAA... dlbtrust-m2m:<label>` line;
the fingerprint is repeated in the `X-Key-Fingerprint` header so the bank can
confirm it over a second channel.

## 3. Register the partner

Requires the bank's own host key fingerprint — registration is refused without
it, because nothing is allowed to connect to an unpinned host.

```bash
curl -sX POST "$BASE/api/m2m-os/partners" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{
    "name": "Acme Bank",
    "bankName": "Acme Bank, N.A.",
    "host": "sftp.acmebank.example",
    "port": 22,
    "username": "dlbtrust-prod",
    "hostKeyFingerprint": "SHA256:...",
    "identityId": "'"$IDENTITY_ID"'"
  }'
```

This also registers the bound MFT channel (`m2m-<partnerId>`) with
`identityId` set, so every session on that channel authenticates with the
machine key and ignores `MFT_SFTP_PASSWORD` / `MFT_SFTP_PRIVATE_KEY*` entirely.
Omitting `identityId` mints a fresh identity instead — then go back to step 2
to get its public key authorized.

Per-partner directory layout overrides go in `layout`; policy flags go in
`policy`.

## 4. Run the handshake until the partner is `verified`

```bash
curl -sX POST "$BASE/api/m2m-os/partners/$PARTNER_ID/handshake" -H "$AUTH"
```

The handshake connects with the identity key against the pinned host key, lists
all four remote directories (`outbound`, `ack`, `returns`, `archive`), writes a
probe under the staging name, renames it, and deletes it. Passing promotes the
partner to `verified`; failing marks it `degraded` and the response names the
step that broke. Re-run it after the bank confirms the key is authorized.

`runCycle` only touches `verified` partners, and a partner cannot be marked
verified by hand without a passing handshake.

## 5. Confirm the partner policy allows the machine to act

```bash
curl -s "$BASE/api/m2m-os/partners/$PARTNER_ID" -H "$AUTH"
```

- `policy.autoTransmit` must not be `false` — it gates the transmit half of the cycle.
- `policy.collect` must not be `false` — it gates reading acks and returns.
- `policy.signManifests` (default on) writes a signed `<filename>.m2m.json`
  sidecar next to each file so the bank can verify sender and bytes without
  trusting the transport.

Both default to enabled when the partner is registered; they are only `false`
if explicitly set that way.

## 6. Validate before trusting the timer

```bash
curl -s "$BASE/api/m2m-os/status" -H "$AUTH"
```

Check:

- `scheduler.running === true` and `scheduler.intervalMs` equals
  `M2M_CYCLE_INTERVAL_MS`. Running is `false` on non-leader replicas by design —
  confirm on the leader (`[leader] elected leader` in its logs).
- the partner's `status` is `verified`.
- the bound channel's `readiness.blockers` is empty
  (`GET /api/mft-os/channels`): SFTP host set, host key pinned, identity bound.

Then force one pass by hand before relying on the interval:

```bash
curl -sX POST "$BASE/api/m2m-os/run" -H "$AUTH" \
  -H 'content-type: application/json' -d '{"partnerId":"'"$PARTNER_ID"'"}'
```

The response lists `transmitted`, `skipped`, `errors` and the `collected`
acknowledgements, rejections and returns per partner. `GET
/api/m2m-os/events?partnerId=...` is the audit trail: `identity_created`,
`partner_registered`, `handshake_passed`, `manifest_signed`,
`cycle_completed` / `cycle_degraded`.

A cycle that errors marks the partner `degraded` and stops processing it on
subsequent passes — a fresh passing handshake is what brings it back.

## One channel, both rails: ACH + host-to-host wire on the shared M2M identity

The ACH rails (beneficiary direct deposits, vendor bill pay — Payer OS) and
the host-to-host wire rail (settlement funding) transmit over the **one**
bound channel that step 3 created, under the **one** machine identity from
step 2. Nothing new is provisioned; both rails are pointed at the same id:

```bash
ACH_MFT_CHANNEL=m2m-<partnerId>        # ACHEngine.mftChannelId()
WIRE_H2H_MFT_CHANNEL=m2m-<partnerId>   # getWireChannelConfig() -> transport 'mft'
WIRE_H2H_RAILS=fedwire                 # must carry the settlement-funding rail
```

Steps 2–4 can be driven from the deployment shell in one go with
`node server/scripts/provisionM2mPartner.js identity | register | handshake --wait | status`;
`register` reads the bank's host, username and host-key fingerprint from
`M2M_PARTNER_HOST` / `M2M_PARTNER_USERNAME` / `M2M_PARTNER_HOST_KEY_FINGERPRINT`
(secrets) and prints the exact `ACH_MFT_CHANNEL` / `WIRE_H2H_MFT_CHANNEL`
lines to set. The partner of record is Lili Bank (DB NET MGMT).

Set both only after step 4 reports the partner `verified`; the bound channel
is what carries the bank host, pinned host key, username and directory
`layout`, so:

- Every Payer OS NACHA file goes through `MftOsEngine.deliver` (protocol
  `mft`), ahead of `ACH_SFTP_URL`, the AS2 partner and the `bank_endpoint`
  setting. `PayerOsEngine.readiness().achChannel` reports `via: 'mft'`,
  `ready: true` with the channel's `readiness.blockers` empty
  (`node server/scripts/sendPayerCredit.js status`).
- Every settlement-funding pacs.008 goes through `MftOsEngine.deliver` as
  `fileType: 'wire_payment'`, carrying the payment's last approver as
  `approvedBy`. `WireHostToHostEngine.readiness()` reports `transport: 'mft'`
  with the warning that the channel's readiness is checked at transmission —
  that is expected, not a blocker. The wire engine keeps its own conventions
  (`WIRE_H2H_FILE_PREFIX`, staging suffix, ACK/settlement SLAs); the
  outbound / ack / return / archive directories are the channel's `layout`,
  so match that layout to the bank's connectivity pack. `WIRE_H2H_SFTP_*`,
  `WIRE_H2H_REMOTE_ROOT` and `WIRE_H2H_*_DIR` are ignored in MFT mode — do
  not also set them.
- The channel refuses any rail not listed in `WIRE_H2H_RAILS`; the default
  `fedwire` is what the settlement-funding wire uses.
- Both rails' files land in the same outbound directory beside a manifest
  signed by the same identity, and every transmission is recorded with actor
  `machine:<identityId>`.

**Four-eyes stays on.** `MFT_REQUIRE_APPROVAL=true` is the locked decision for
this deployment and `MFT_MAX_FILE_CENTS` is left as-is. Sharing a channel does
not share a release: each ACH file and each wire file is released separately,
by a human who is not its builder, before the machine carries it. A file
delivered without an approver registers as `built` and `transmit` refuses it
(`MFT_WRONG_STATE`); the builder approving their own file is refused
(`MFT_FOUR_EYES`); a distinct checker's `POST /api/mft-os/files/:id/approve`
(or the wire's own approve step) is what lets the next send transmit it.
The unattended cycle (`M2M_CYCLE_INTERVAL_MS`) still queues only `approved`
files and otherwise collects acknowledgements and returns. Regression
coverage: `tests/sharedM2mChannel.test.ts`.

## Governance: the control being removed

`MFT_REQUIRE_APPROVAL=true` is the maker/checker (four-eyes) release control on
outbound money: `MftOsEngine.transmit` will only carry a file that a second
person, not its builder, read the totals of and released. With it on, the
machine automates *delivery* but a human still authorizes every payment file.

Setting `MFT_REQUIRE_APPROVAL=false` makes `transmit` auto-approve a `built`
file as `policy:no-approval` and transmit it in the same call, and `runCycle`
widens its queue to `built` files as well as `approved` ones, so a file the
system generates reaches the bank on the next cycle with zero human touches.
With the gate on, the cycle still queues only `approved` files, so a `built`
file waits for its release exactly as before.

That is the point of an unattended exchange, and it is a deliberate removal of
the four-eyes control — the decision lives entirely in that one variable.

Controls that remain in force with approval off, and that should be treated as
the compensating set:

- Nothing transmits to an unverified partner or an unpinned host.
- Exactly-once delivery: a file already transmitted is never re-sent, and
  byte-identical content on the same channel inside
  `MFT_REPLAY_WINDOW_HOURS` is refused as a duplicate.
- Every file is archived by content hash and every action is recorded in
  `mft_events` / `m2m_events` with the machine actor (`machine:<identityId>`).
- `MFT_MAX_FILE_CENTS` is the only remaining value ceiling. It is `0`
  (unlimited) by default; set a real one when approval is off.

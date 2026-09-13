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

# Hyperledger Fabric + FireFly

Two gaps this closes, and nothing else.

**1. Nobody outside the trust can verify the trust's own record.** Postgres holds
the sub-ledger, Fineract holds the canonical GL, and both are writable by the
people who operate them. A settled wire's row can be edited afterwards and no
artifact contradicts the edit. Fabric fixes only that: the digest of a record is
anchored on a permissioned channel, and `verify` re-derives the digest from the
record as it stands today.

**2. Counterparty handoffs are files.** A NACHA file over AS2, a CSV an operator
downloads, a wire an officer keys in — the counterparty gets the money and,
separately and unverifiably, gets told what it was for. FireFly sends the
instruction to a named org over the same network the value moves on, with the
payload private and only its hash pinned.

Neither ledger holds trust money. Fineract is still the system of record.

## Surfaces

| Surface | What it does |
| --- | --- |
| `server/integrations/hyperledger/fabricLedgerEngine.js` | digest, notarize, receipt poll, verify |
| `server/integrations/hyperledger/fireflyEngine.js` | node status, private instructions, token transfers, event booking, reconcile |
| `server/routes/hyperledger.js` | `/api/hyperledger/**` — reads operator-gated, writes admin-gated |
| `server/scripts/hyperledgerFabricFireflyWire.js` | `npm run trust:hyperledger` — the end-to-end wire |

Tables are created on first use: `fabric_notarizations`,
`firefly_settlements`. Both engines fall back to in-memory storage when
`DAPP_MEMORY_MODE=true`.

## Configuration

Fabric (through [Fabconnect](https://github.com/hyperledger/firefly-fabconnect),
usable standalone or as FireFly's Fabric connector):

| Variable | Default | Meaning |
| --- | --- | --- |
| `FABRIC_CONNECT_URL` | — | Fabconnect REST gateway |
| `FABRIC_CONNECT_TOKEN` | — | bearer token, when the gateway requires one |
| `FABRIC_CHANNEL` | `trustchannel` | channel the notary chaincode is committed to |
| `FABRIC_CHAINCODE` | `trustnotary` | chaincode name |
| `FABRIC_SIGNER` | — | enrolled identity in the trust's MSP |
| `FABRIC_NOTARIZE_FUNCTION` | `NotarizeRecord` | invoke function |
| `FABRIC_QUERY_FUNCTION` | `GetRecord` | query function |
| `FABRIC_LEDGER_LIVE` | `false` | must be `true` to invoke chaincode |

FireFly:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FIREFLY_API_URL` | — | FireFly Core API |
| `FIREFLY_API_KEY` | — | bearer token, when the node requires one |
| `FIREFLY_NAMESPACE` | `default` | namespace |
| `FIREFLY_TOKEN_POOL` | — | pool the trust settles from |
| `FIREFLY_TOKEN_DECIMALS` | `2` | minor units per unit of value in that pool |
| `FIREFLY_COUNTERPARTY_ORG` | — | counterparty org identity / DID |
| `FIREFLY_SIGNING_KEY` | — | signing key for transfers |
| `FIREFLY_TOPIC` | `trust-settlement` | message topic |
| `FIREFLY_SOURCE_TYPE` | `trust` | `canonical` makes the Fineract GL the authority |
| `FIREFLY_SOURCE_ACCOUNT_ID` | — | account the value leaves |
| `FIREFLY_TOKEN_ACCOUNT_CODE` | `1210` | debited on a confirmed transfer |
| `FIREFLY_CASH_ACCOUNT_CODE` | `1000` | credited on a confirmed transfer |
| `FIREFLY_MAX_TRANSFER_USD` | `0` (off) | per-transfer ceiling |
| `FIREFLY_WEBHOOK_SECRET` | — | HMAC-SHA256 secret over the raw webhook body |
| `FIREFLY_WEBHOOK_URL` | — | URL the subscription posts to |
| `FIREFLY_NOTARIZE_INSTRUCTIONS` | `true` | also notarize each instruction on Fabric |
| `FIREFLY_LIVE` | `false` | must be `true` to move tokenized value |

## Gating

Direction decides the gate, as elsewhere in the platform:

- **Digesting and verifying** need nothing. They spend nothing and are always available.
- **Anchoring** needs a reachable channel plus `FABRIC_LEDGER_LIVE=true`. Without it
  `notarize` still computes and stores the digest and marks the row `shadow` — the
  digest pins the record at a point in time but makes no claim about a block.
- **Messaging** needs a reachable node only; an instruction moves no value.
- **Transferring** needs `FIREFLY_LIVE=true`, a pool, a counterparty, and a source of
  funds that can cover it. Without the gate `transfer` returns a plan.

Booking follows confirmation, never submission: a transfer posts its journal
entry when FireFly confirms it (webhook or `sync`), exactly once. A confirmed
transfer whose journal entry fails stays `booked = false` and is picked up by
`POST /api/hyperledger/firefly/reconcile` — it is never silently dropped.

## The wire

```bash
# what is reachable, and which gates are open
npm run trust:hyperledger

# anchor a settled wire, then prove it is unchanged
node server/scripts/hyperledgerFabricFireflyWire.js --record-type wire --notarize ./wire-9001.json
node server/scripts/hyperledgerFabricFireflyWire.js --record-type wire --verify   ./wire-9001.json

# tell the counterparty what is coming, then send it
node server/scripts/hyperledgerFabricFireflyWire.js --instruct ./instruction.json --live
node server/scripts/hyperledgerFabricFireflyWire.js --transfer 25000 --reference WIRE-9001 \
  --source-type canonical --source-account 1000 --live

# book it once FireFly confirms, or sweep everything confirmed-but-unbooked
node server/scripts/hyperledgerFabricFireflyWire.js --sync FFXFER-...
node server/scripts/hyperledgerFabricFireflyWire.js --reconcile
```

`--verify` exits `2` on a mismatch, so it can run as a scheduled audit check.

## Required chaincode

The engine expects a notary chaincode on the channel with two functions. Any
implementation satisfying this interface works; the digest is the only thing
ever written, so no trust data reaches the ledger.

```
NotarizeRecord(recordType, recordId, digest, metadataJSON)
  key   = recordType + "\u0000" + recordId
  value = { recordType, recordId, digest, metadata, notarizedAt, submitter }
  Reject an overwrite with a different digest, or keep a history — Fabric's
  own key history already proves when each digest was written.

GetRecord(recordType, recordId) -> the value above (or its digest string)
```

`verify` accepts either shape back from `GetRecord`: the JSON object, or a bare
64-character hex digest.

`chaincode/trustnotary` is a reference implementation of exactly that interface
(Go, `fabric-contract-api-go`), and is the one the live run below was verified
against. It keeps every superseded digest under a history key, so a mismatch can
be walked back to the version the channel accepted.

## Standing the nodes up

`scripts/hyperledger/bootstrap-stack.sh` builds both networks on one Linux
host with Docker: installs the FireFly CLI and Go, packages and commits
`chaincode/trustnotary`, brings up Fabric + fabconnect and a two-member FireFly
stack with an ERC-20 settlement pool minted to the trust org, and writes the
`FABRIC_*`/`FIREFLY_*` block to `~/.env.hyperledger`. It is idempotent, so it
doubles as the health check for a host that already has the stacks. Point the
app at that host (the URLs it prints are `localhost`; substitute the host name
or put fabconnect and FireFly behind TLS) and set `FIREFLY_API_KEY` /
`FABRIC_CONNECT_TOKEN` once those are fronted by auth.

## What each node has to have

Verified end to end against a Fabric network with fabconnect and a two-member
FireFly stack (ERC-20 pool), which settled the flow above on-chain.

Fabric, via fabconnect:

- an enrolled signer registered with fabconnect — `FABRIC_SIGNER` is that
  identity's name, not an MSP path
- the notary chaincode below, committed on `FABRIC_CHANNEL`

Fabconnect answers a `SendTransaction` with the receipt lookup id in
`headers.requestId`, the committed hash in `transactionHash`, and `status:
VALID`; `headers.id` is only a correlation id, so a record is `pending` until a
hash exists, and `headers.type: TransactionFailure` marks it `failed`. Until the
block commits, `GET /receipts/{requestId}` answers `404 Receipt not available` —
that is in-flight, not failed, so `--receipt` can be run on a schedule.

FireFly:

- the counterparty registered as an org with a blockchain verifier.
  `FIREFLY_COUNTERPARTY_ORG` takes the DID or org name; the engine resolves it
  to that verifier's key, because a token transfer credits a key, not a DID
- a token pool. `FIREFLY_TOKEN_POOL` takes the pool name or id, and
  `FIREFLY_TOKEN_DECIMALS` must match the pool's own decimals (18 for a stock
  ERC-20 pool, not the default 2) or every amount is off by orders of magnitude
- nothing else: the `settlement_instruction` datatype is broadcast to the
  namespace on first use

A confirmed transfer references its blockchain event by id, so the chain hash is
read from that event rather than from the transfer's `tx`, which is a FireFly
operation reference.

## Webhook

Point the FireFly subscription at `POST /api/hyperledger/firefly/webhook`
(`POST /api/hyperledger/firefly/subscription` registers it). The route is
unauthenticated by design — FireFly calls it — and verifies an HMAC-SHA256 over
the raw body against `FIREFLY_WEBHOOK_SECRET` when one is set. Events that match
no settlement are acknowledged, not retried forever; a booking failure is
acknowledged too and left to `reconcile`.

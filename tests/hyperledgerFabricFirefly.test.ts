import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// Must be set before the engines load: it decides at require time whether to use Postgres.
process.env.DAPP_MEMORY_MODE = 'true';

const { FabricLedgerEngine } = require('../server/integrations/hyperledger/fabricLedgerEngine');
const { FireflyEngine } = require('../server/integrations/hyperledger/fireflyEngine');
const { SourceOfFundsAdapter } = require('../server/integrations/stablecoin/sourceOfFundsAdapter');
const { CanonicalFundingSource } = require('../server/integrations/fineract/canonicalFundingSource');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');

const saved = { ...process.env };

function position(availableCents: number, fundingEligible = true) {
  return { availableBalanceCents: availableCents, fundingEligible, segregationReason: fundingEligible ? null : 'segregated' } as any;
}

function call(index = 0) {
  const [url, init] = (globalThis.fetch as any).mock.calls[index];
  return { url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null };
}

function mockFetch(responses: any[]) {
  const spy = vi.spyOn(globalThis, 'fetch');
  for (const body of responses) {
    spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', text: async () => JSON.stringify(body) } as any);
  }
  return spy;
}

const WIRE = { id: 'WIRE-9001', amountUsd: 25000, beneficiary: 'Partner Bank', settledAt: '2026-09-06' };

// What a FireFly node answers for the registrations the engine resolves before
// it sends anything: the datatype, the counterparty's verifier, the pool id.
const DATATYPES = [{ id: 'dt-1', name: 'settlement_instruction', version: '1.0.0' }];
const IDENTITIES = [{
  did: 'org.partnerbank',
  name: 'partnerbank',
  verifiers: [{ type: 'ethereum_address', value: '0xpartner' }],
}];
const POOLS = [{ id: 'pool-uuid-1', name: 'usd-deposit', symbol: 'USDD', decimals: 6 }];

/** Preflight for a first instruction (datatype) or transfer (+ identity, pool). */
function preflight(kind: 'instruction' | 'transfer') {
  return kind === 'instruction' ? [DATATYPES] : [DATATYPES, IDENTITIES, POOLS];
}

beforeEach(() => {
  process.env.DAPP_MEMORY_MODE = 'true';
  process.env.FABRIC_CONNECT_URL = 'https://fabconnect.trust.internal';
  process.env.FABRIC_SIGNER = 'trust-signer';
  process.env.FABRIC_CHANNEL = 'trustchannel';
  process.env.FABRIC_CHAINCODE = 'trustnotary';
  process.env.FIREFLY_API_URL = 'https://firefly.trust.internal';
  process.env.FIREFLY_NAMESPACE = 'trust';
  process.env.FIREFLY_TOKEN_POOL = 'usd-deposit';
  process.env.FIREFLY_COUNTERPARTY_ORG = 'org.partnerbank';
  process.env.FIREFLY_SOURCE_ACCOUNT_ID = '1000';
  delete process.env.FABRIC_LEDGER_LIVE;
  delete process.env.FIREFLY_LIVE;
  delete process.env.FIREFLY_WEBHOOK_SECRET;
  delete process.env.FIREFLY_MAX_TRANSFER_USD;
  FabricLedgerEngine._resetMemory();
  FireflyEngine._resetMemory();
  vi.spyOn(SourceOfFundsAdapter, 'getPosition').mockResolvedValue(position(500_000_00));
  vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ id: 'je-1' } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('fabric readiness', () => {
  it('separates being able to digest from being able to anchor', () => {
    const shadow = FabricLedgerEngine.readiness();
    expect(shadow.canNotarize).toBe(true);
    expect(shadow.canAnchor).toBe(false);
    expect(shadow.mode).toBe('shadow');

    process.env.FABRIC_LEDGER_LIVE = 'true';
    expect(FabricLedgerEngine.readiness().canAnchor).toBe(true);
  });

  it('names every missing piece of channel config', () => {
    delete process.env.FABRIC_CONNECT_URL;
    delete process.env.FABRIC_SIGNER;
    const readiness = FabricLedgerEngine.readiness();
    expect(readiness.canNotarize).toBe(false);
    expect(readiness.issues.join(' ')).toContain('FABRIC_CONNECT_URL');
    expect(readiness.issues.join(' ')).toContain('FABRIC_SIGNER');
  });
});

describe('fabric digest', () => {
  it('is stable under key order and nesting', () => {
    const a = FabricLedgerEngine.digest({ b: 2, a: 1, nested: { y: [1, { q: 1, p: 2 }], x: 'v' } });
    const b = FabricLedgerEngine.digest({ nested: { x: 'v', y: [1, { p: 2, q: 1 }] }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any value changes', () => {
    expect(FabricLedgerEngine.digest(WIRE)).not.toBe(FabricLedgerEngine.digest({ ...WIRE, amountUsd: 25000.01 }));
  });
});

describe('fabric notarize', () => {
  it('stores the digest without invoking chaincode in shadow mode', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const row = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    expect(spy).not.toHaveBeenCalled();
    expect(row.status).toBe('shadow');
    expect(row.anchored).toBe(false);
    expect(row.digest).toBe(FabricLedgerEngine.digest(WIRE));
  });

  it('invokes the notarize chaincode function with the digest only', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    mockFetch([{ id: 'req-1', transactionID: 'tx-abc', blockNumber: 42 }]);
    const row = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });

    const invoke = call(0);
    expect(invoke.url).toBe('https://fabconnect.trust.internal/transactions');
    expect(invoke.body.func).toBe('NotarizeRecord');
    expect(invoke.body.headers).toMatchObject({ signer: 'trust-signer', channel: 'trustchannel', chaincode: 'trustnotary' });
    expect(invoke.body.args.slice(0, 3)).toEqual(['wire', WIRE.id, row.digest]);
    // The payload itself never leaves the trust.
    expect(JSON.stringify(invoke.body)).not.toContain('Partner Bank');
    expect(row).toMatchObject({ status: 'anchored', transactionId: 'tx-abc', blockNumber: 42 });
  });

  it('is idempotent for an unchanged record and anchors again when it changes', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    mockFetch([
      { id: 'req-1', transactionID: 'tx-1' },
      { id: 'req-2', transactionID: 'tx-2' },
    ]);
    const first = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    const again = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    expect(again.idempotent).toBe(true);
    expect(again.id).toBe(first.id);
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);

    const changed = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: { ...WIRE, amountUsd: 1 } });
    expect(changed.transactionId).toBe('tx-2');
    expect((globalThis.fetch as any).mock.calls.length).toBe(2);
  });

  it('records the failure instead of pretending it anchored', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 500, statusText: 'boom', text: async () => '{"error":"endorsement failed"}' } as any);
    await expect(FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE })).rejects.toThrow(/endorsement failed/);
    const history = await FabricLedgerEngine.history('wire', WIRE.id);
    expect(history[0]).toMatchObject({ status: 'failed' });
  });
});

describe('fabric transaction responses', () => {
  it('reads a real fabconnect success: request id in the headers, hash and block at the top', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    mockFetch([{
      headers: { type: 'TransactionSuccess', id: 'corr-1', requestId: 'req-9' },
      transactionHash: 'abc123',
      blockNumber: 10,
      status: 'VALID',
    }]);
    const row = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    expect(row).toMatchObject({
      status: 'anchored', requestId: 'req-9', transactionId: 'abc123', blockNumber: 10,
    });
  });

  it('will not call a record anchored on a correlation id alone', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    mockFetch([{ headers: { id: 'corr-1', requestId: 'req-9', type: 'TransactionUpdate' } }]);
    const row = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    expect(row).toMatchObject({ status: 'pending', anchored: false, requestId: 'req-9' });
  });

  it('records a rejected transaction as failed', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    mockFetch([{ headers: { type: 'TransactionFailure', requestId: 'req-9' }, errorMessage: 'chaincode error' }]);
    await expect(FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE }))
      .rejects.toThrow(/chaincode error/);
    expect((await FabricLedgerEngine.history('wire', WIRE.id))[0]).toMatchObject({ status: 'failed', anchored: false });
  });
});

describe('fabric verify', () => {
  it('reports an unnotarized record rather than a pass', async () => {
    const result = await FabricLedgerEngine.verify({ recordType: 'wire', recordId: 'WIRE-NONE', payload: WIRE });
    expect(result).toMatchObject({ outcome: 'unnotarized', verified: false });
  });

  it('verifies an unchanged record against the channel', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    const digest = FabricLedgerEngine.digest(WIRE);
    mockFetch([{ id: 'req-1', transactionID: 'tx-1' }, { result: { digest } }]);
    await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });

    const result = await FabricLedgerEngine.verify({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    expect(result).toMatchObject({ outcome: 'verified', verified: true, localMatch: true, chainMatch: true });
    expect(call(1).body.func).toBe('GetRecord');
  });

  it('catches a record edited after it was notarized', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    const digest = FabricLedgerEngine.digest(WIRE);
    mockFetch([{ id: 'req-1', transactionID: 'tx-1' }, { result: digest }]);
    await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });

    const tampered = { ...WIRE, amountUsd: 2500 };
    const result = await FabricLedgerEngine.verify({ recordType: 'wire', recordId: WIRE.id, payload: tampered });
    expect(result).toMatchObject({ outcome: 'mismatch', verified: false, localMatch: false });
    expect(result.detail).toContain('changed after it was notarized');
  });

  it('still verifies locally when the channel query fails', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    const spy = mockFetch([{ id: 'req-1', transactionID: 'tx-1' }]);
    await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    spy.mockRejectedValueOnce(new Error('peer unavailable'));

    const result = await FabricLedgerEngine.verify({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    expect(result).toMatchObject({ outcome: 'verified', chainMatch: null });
    expect(result.onChainError).toContain('peer unavailable');
  });
});

describe('fabric receipts', () => {
  it('upgrades a pending notarization once the block commits', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    mockFetch([
      { id: 'req-1' },
      { status: 'Complete', transactionID: 'tx-9', blockNumber: 77 },
    ]);
    const row = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    expect(row.status).toBe('pending');

    const synced = await FabricLedgerEngine.syncReceipt(row.id);
    expect(synced).toMatchObject({ polled: true, status: 'anchored', transactionId: 'tx-9', blockNumber: 77 });
  });

  it('treats an unavailable receipt as still in flight, not as a failure', async () => {
    process.env.FABRIC_LEDGER_LIVE = 'true';
    const spy = mockFetch([{ headers: { requestId: 'req-1' } }]);
    const row = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    spy.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":"Receipt not available"}' } as any);

    const synced = await FabricLedgerEngine.syncReceipt(row.id);
    expect(synced).toMatchObject({ polled: true, status: 'pending' });
    expect(synced.reason).toContain('in flight');
  });

  it('has nothing to poll for a shadow notarization', async () => {
    const row = await FabricLedgerEngine.notarize({ recordType: 'wire', recordId: WIRE.id, payload: WIRE });
    const synced = await FabricLedgerEngine.syncReceipt(row.id);
    expect(synced.polled).toBe(false);
  });
});

describe('firefly readiness', () => {
  it('allows messaging without the money gate but not transfers', () => {
    const readiness = FireflyEngine.readiness();
    expect(readiness.canMessage).toBe(true);
    expect(readiness.canTransfer).toBe(false);

    process.env.FIREFLY_LIVE = 'true';
    expect(FireflyEngine.readiness().canTransfer).toBe(true);
  });

  it('separates node issues from transfer issues', () => {
    delete process.env.FIREFLY_TOKEN_POOL;
    delete process.env.FIREFLY_API_URL;
    const readiness = FireflyEngine.readiness();
    expect(readiness.issues.join(' ')).toContain('FIREFLY_API_URL');
    expect(readiness.transferIssues.join(' ')).toContain('FIREFLY_TOKEN_POOL');
  });
});

describe('firefly settlement instructions', () => {
  it('pins the hash, keeps the payload private to the counterparty, and notarizes it', async () => {
    mockFetch([...preflight('instruction'), { header: { id: 'msg-1' }, state: 'sent' }]);
    const instruction = { reference: 'SETTLE-1', amountUsd: 1000, beneficiary: 'Partner Bank' };
    const sent = await FireflyEngine.sendInstruction({ reference: 'SETTLE-1', instruction });

    const posted = call(1);
    expect(posted.url).toBe('https://firefly.trust.internal/api/v1/namespaces/trust/messages/private');
    expect(posted.body.group.members).toEqual([{ identity: 'org.partnerbank' }]);
    expect(posted.body.header.group).toBeUndefined();
    expect(posted.body.data[0].value.digest).toBe(FabricLedgerEngine.digest(instruction));
    expect(sent).toMatchObject({ messageId: 'msg-1', status: 'sent' });
    expect(await FabricLedgerEngine.history('settlement_instruction', 'SETTLE-1')).toHaveLength(1);
  });

  it('is idempotent on the reference', async () => {
    mockFetch([...preflight('instruction'), { header: { id: 'msg-1' } }]);
    await FireflyEngine.sendInstruction({ reference: 'SETTLE-1', instruction: { amountUsd: 1 } });
    const again = await FireflyEngine.sendInstruction({ reference: 'SETTLE-1', instruction: { amountUsd: 1 } });
    expect(again.idempotent).toBe(true);
    expect((globalThis.fetch as any).mock.calls.length).toBe(2);
  });

  it('defines the instruction datatype on a node that does not have it yet', async () => {
    mockFetch([[], { id: 'dt-new', name: 'settlement_instruction', version: '1.0.0' }, { header: { id: 'msg-1' } }]);
    await FireflyEngine.sendInstruction({ reference: 'SETTLE-2', instruction: { amountUsd: 1 } });

    const definition = call(1);
    expect(definition.method).toBe('POST');
    expect(definition.url).toContain('/datatypes');
    expect(definition.body).toMatchObject({ name: 'settlement_instruction', version: '1.0.0', validator: 'json' });
    expect(definition.body.value.required).toEqual(['reference', 'digest']);
  });

  it('refuses without a counterparty', async () => {
    delete process.env.FIREFLY_COUNTERPARTY_ORG;
    await expect(FireflyEngine.sendInstruction({ reference: 'X', instruction: { amountUsd: 1 } }))
      .rejects.toThrow(/counterparty/i);
  });
});

describe('firefly transfers', () => {
  it('plans without moving value when the live gate is closed', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const row = await FireflyEngine.transfer({ amountUsd: 100, reference: 'T-1' });
    expect(spy).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'shadow', booked: false });
    expect(row.detail.reason).toContain('FIREFLY_LIVE');
  });

  it('refuses a transfer the source cannot fund', async () => {
    process.env.FIREFLY_LIVE = 'true';
    (SourceOfFundsAdapter.getPosition as any).mockResolvedValue(position(5_00));
    await expect(FireflyEngine.transfer({ amountUsd: 100, reference: 'T-2' })).rejects.toThrow(/INSUFFICIENT|available/i);
  });

  it('refuses a segregated source', async () => {
    process.env.FIREFLY_LIVE = 'true';
    (SourceOfFundsAdapter.getPosition as any).mockResolvedValue(position(500_000_00, false));
    await expect(FireflyEngine.transfer({ amountUsd: 100, reference: 'T-3' })).rejects.toThrow(/cannot fund/i);
  });

  it('refuses a counterparty the node has no verifier for', async () => {
    process.env.FIREFLY_LIVE = 'true';
    mockFetch([DATATYPES, [], POOLS]);
    await expect(FireflyEngine.transfer({ amountUsd: 100, reference: 'T-4b' }))
      .rejects.toThrow(/no registered blockchain verifier/);
    const stored = await FireflyEngine.list({ limit: 5 });
    expect(stored[0]).toMatchObject({ status: 'failed', booked: false });
  });

  it('checks the account it is about to debit when no source account is configured', async () => {
    process.env.FIREFLY_LIVE = 'true';
    delete process.env.FIREFLY_SOURCE_ACCOUNT_ID;
    mockFetch([...preflight('transfer'), { localId: 'xfer-4', state: 'pending' }]);
    await FireflyEngine.transfer({ amountUsd: 100, reference: 'T-4c' });
    expect(SourceOfFundsAdapter.getPosition).toHaveBeenCalledWith(expect.objectContaining({ sourceAccountId: '1000' }));
  });

  it('honours the per-transfer ceiling', async () => {
    process.env.FIREFLY_LIVE = 'true';
    process.env.FIREFLY_MAX_TRANSFER_USD = '50';
    await expect(FireflyEngine.transfer({ amountUsd: 100, reference: 'T-4' })).rejects.toThrow(/exceeds/);
  });

  it('submits in the pool base units with the advice attached, and books nothing yet', async () => {
    process.env.FIREFLY_LIVE = 'true';
    process.env.FIREFLY_TOKEN_DECIMALS = '6';
    mockFetch([...preflight('transfer'), { localId: 'xfer-1', message: 'msg-2', state: 'pending' }]);
    const row = await FireflyEngine.transfer({ amountUsd: 250.5, reference: 'T-5', memo: 'Q3 distribution' });

    const posted = call(3);
    expect(posted.url).toContain('/namespaces/trust/tokens/transfers');
    // The pool is addressed by id and the counterparty by its verifier; FireFly
    // rejects a pool name or an org DID in either field.
    expect(posted.body).toMatchObject({ pool: 'pool-uuid-1', amount: '250500000', to: '0xpartner' });
    expect(posted.body.message.data[0].value.memo).toBe('Q3 distribution');
    expect(row).toMatchObject({ status: 'pending', transferId: 'xfer-1', booked: false });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('keeps a confirmation that lands while the transfer is still being notarized', async () => {
    process.env.FIREFLY_LIVE = 'true';
    process.env.FABRIC_LEDGER_LIVE = 'true';
    mockFetch([...preflight('transfer'), { localId: 'xfer-race', state: 'pending' }]);
    let webhook: any;
    vi.spyOn(FabricLedgerEngine, 'notarize').mockImplementation(async () => {
      // A fast chain confirms before the notarization round-trip completes.
      webhook = await FireflyEngine.handleEvent({ type: 'token_transfer_confirmed', tokenTransfer: { localId: 'xfer-race' } });
      return { id: 'notary-race' } as any;
    });

    const row = await FireflyEngine.transfer({ amountUsd: 25, reference: 'T-RACE' });
    expect(webhook).toMatchObject({ handled: true, booked: true });
    expect(row).toMatchObject({ status: 'confirmed', booked: true, journalEntryId: 'je-1', notarizationId: 'notary-race' });
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledTimes(1);
  });

  it('books once on confirmation and never twice', async () => {
    process.env.FIREFLY_LIVE = 'true';
    mockFetch([
      ...preflight('transfer'),
      { localId: 'xfer-1', state: 'pending' },
      { state: 'confirmed', blockchainEvent: { tx: { transactionHash: '0xdead' } } },
      { state: 'confirmed', blockchainEvent: { tx: { transactionHash: '0xdead' } } },
    ]);
    const row = await FireflyEngine.transfer({ amountUsd: 400, reference: 'T-6' });

    const synced = await FireflyEngine.sync(row.id);
    expect(synced).toMatchObject({ status: 'confirmed', booked: true, txHash: '0xdead', journalEntryId: 'je-1' });
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledTimes(1);
    const lines = (TrustAccountingEngine.postJournalEntry as any).mock.calls[0][0].lines;
    expect(lines).toEqual([
      { accountCode: '1210', debitAmount: 400, creditAmount: 0 },
      { accountCode: '1000', debitAmount: 0, creditAmount: 400 },
    ]);

    await FireflyEngine.sync(row.id);
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledTimes(1);
  });

  it('follows the blockchain event reference to store a real chain hash', async () => {
    process.env.FIREFLY_LIVE = 'true';
    mockFetch([
      ...preflight('transfer'),
      { localId: 'xfer-hash', state: 'pending' },
      { state: 'confirmed', blockchainEvent: 'evt-1', tx: { type: 'token_transfer', id: 'op-1' } },
      { id: 'evt-1', info: { transactionHash: '0xchain' } },
    ]);
    const row = await FireflyEngine.transfer({ amountUsd: 20, reference: 'T-6b' });
    const synced = await FireflyEngine.sync(row.id);
    expect(synced).toMatchObject({ status: 'confirmed', txHash: '0xchain' });
  });

  it('posts to both books when the source is the canonical ERP', async () => {
    process.env.FIREFLY_LIVE = 'true';
    vi.spyOn(CanonicalFundingSource, 'assertAvailable').mockResolvedValue({ availableBalanceCents: 900_000_00 } as any);
    const commit = vi.spyOn(CanonicalFundingSource, 'commit').mockResolvedValue({ committed: true, journalEntry: { id: 'je-canonical' } } as any);
    mockFetch([
      ...preflight('transfer'),
      { localId: 'xfer-2', state: 'pending' },
      { state: 'confirmed' },
    ]);

    const row = await FireflyEngine.transfer({ amountUsd: 750, reference: 'T-7', sourceType: 'canonical', sourceAccountId: '1000' });
    const synced = await FireflyEngine.sync(row.id);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(synced).toMatchObject({ booked: true, journalEntryId: 'je-canonical' });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('leaves a confirmed transfer unbooked and reconcilable when the ledger rejects the entry', async () => {
    process.env.FIREFLY_LIVE = 'true';
    (TrustAccountingEngine.postJournalEntry as any).mockRejectedValue(new Error('GL closed'));
    mockFetch([
      ...preflight('transfer'),
      { localId: 'xfer-3', state: 'pending' },
      { state: 'confirmed' },
    ]);
    const row = await FireflyEngine.transfer({ amountUsd: 10, reference: 'T-8' });
    const synced = await FireflyEngine.sync(row.id);
    expect(synced).toMatchObject({ status: 'confirmed', booked: false });
    expect(synced.failureReason).toContain('GL closed');

    (TrustAccountingEngine.postJournalEntry as any).mockResolvedValue({ id: 'je-2' });
    const report = await FireflyEngine.reconcile();
    expect(report).toMatchObject({ unbookedBefore: 1, booked: 1 });
  });
});

describe('firefly transfer retries', () => {
  const failure = (status: number, error: string) =>
    ({ ok: false, status, statusText: 'error', text: async () => JSON.stringify({ error }) } as any);

  beforeEach(() => {
    process.env.FIREFLY_LIVE = 'true';
    process.env.FIREFLY_SUBMIT_RETRY_DELAY_MS = '0';
  });

  it('resends a failed submission once under the same idempotency key', async () => {
    const spy = mockFetch(preflight('transfer'));
    spy.mockResolvedValueOnce(failure(503, 'connector unavailable'));
    spy.mockResolvedValueOnce({ ok: true, status: 202, statusText: 'ok', text: async () => JSON.stringify({ localId: 'xfer-r1', state: 'pending' }) } as any);

    const row = await FireflyEngine.transfer({ amountUsd: 100, reference: 'R-1' });
    expect(row).toMatchObject({ status: 'pending', transferId: 'xfer-r1' });
    expect(call(3).body.idempotencyKey).toBe('R-1');
    expect(call(4).body.idempotencyKey).toBe('R-1');
    expect(row.detail.submit).toMatchObject({ sent: 2 });
    expect(row.detail.submit.errors[0].error).toContain('connector unavailable');
  });

  it('adopts the transfer FireFly already accepted when the resend hits the idempotency key', async () => {
    const spy = mockFetch(preflight('transfer'));
    spy.mockRejectedValueOnce(new Error('socket hang up'));
    spy.mockResolvedValueOnce(failure(409, "FF10431: Idempotency key 'R-2' already used for transaction 'tx-77'"));
    spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', text: async () => JSON.stringify([{ localId: 'xfer-landed', tx: { id: 'tx-77' } }]) } as any);

    const row = await FireflyEngine.transfer({ amountUsd: 100, reference: 'R-2' });
    expect(call(5).url).toContain('/tokens/transfers?tx=tx-77');
    expect(row).toMatchObject({ status: 'pending', transferId: 'xfer-landed' });
    expect(row.detail.submit).toMatchObject({ sent: 2, adopted: true });
  });

  it('fails after the resend also fails, then re-drives once via retry() and no further', async () => {
    const spy = mockFetch(preflight('transfer'));
    spy.mockResolvedValueOnce(failure(503, 'down'));
    spy.mockResolvedValueOnce(failure(503, 'still down'));
    await expect(FireflyEngine.transfer({ amountUsd: 100, reference: 'R-3' })).rejects.toThrow(/still down/);
    const [failed] = await FireflyEngine.list({ limit: 1 });
    expect(failed).toMatchObject({ status: 'failed', transferId: null, reference: 'R-3' });
    expect(failed.detail.attempt).toBe(1);

    // Nothing was ever accepted, so the re-drive keeps the original key.
    spy.mockResolvedValueOnce({ ok: true, status: 202, statusText: 'ok', text: async () => JSON.stringify({ localId: 'xfer-r3', state: 'pending' }) } as any);
    const retried = await FireflyEngine.retry(failed.id);
    expect(retried).toMatchObject({ id: failed.id, status: 'pending', transferId: 'xfer-r3', reference: 'R-3' });
    expect(retried.detail.attempt).toBe(2);
    expect(retried.detail.priorAttempts).toHaveLength(1);
    expect(call(5).body.idempotencyKey).toBe('R-3');
    expect(await FireflyEngine.list({ limit: 5 })).toHaveLength(1);

    // A pending transfer is not retried, and a second failure is not re-driven.
    expect(await FireflyEngine.retry(failed.id)).toMatchObject({ retried: false, reason: expect.stringContaining('pending') });
    await FireflyEngine._update(failed.id, { status: 'failed', failureReason: 'reverted' });
    const exhausted = await FireflyEngine.retry(failed.id);
    expect(exhausted).toMatchObject({ retried: false, reason: expect.stringContaining('retry limit') });
  });

  it('treats a new transfer under a failed reference as the retry', async () => {
    const spy = mockFetch(preflight('transfer'));
    spy.mockResolvedValueOnce(failure(503, 'down'));
    spy.mockResolvedValueOnce(failure(503, 'down'));
    await expect(FireflyEngine.transfer({ amountUsd: 100, reference: 'R-4' })).rejects.toThrow();

    spy.mockResolvedValueOnce({ ok: true, status: 202, statusText: 'ok', text: async () => JSON.stringify({ localId: 'xfer-r4', state: 'pending' }) } as any);
    const again = await FireflyEngine.transfer({ amountUsd: 100, reference: 'R-4' });
    expect(again).toMatchObject({ status: 'pending', transferId: 'xfer-r4' });
    expect(again.idempotent).toBeUndefined();
    expect(again.detail.attempt).toBe(2);

    // Once it is in flight the reference is simply idempotent again.
    expect(await FireflyEngine.transfer({ amountUsd: 100, reference: 'R-4' })).toMatchObject({ idempotent: true, transferId: 'xfer-r4' });
  });

  it('re-drives a transfer FireFly reported failed under a fresh idempotency key', async () => {
    const spy = mockFetch([...preflight('transfer'), { localId: 'xfer-r5', state: 'pending' }]);
    const row = await FireflyEngine.transfer({ amountUsd: 100, reference: 'R-5' });
    await FireflyEngine.handleEvent({ type: 'token_transfer_op_failed', tokenTransfer: { localId: 'xfer-r5' }, error: 'execution reverted' });
    expect(await FireflyEngine.get(row.id)).toMatchObject({ status: 'failed' });

    spy.mockResolvedValueOnce({ ok: true, status: 202, statusText: 'ok', text: async () => JSON.stringify({ localId: 'xfer-r5b', state: 'pending' }) } as any);
    const retried = await FireflyEngine.retry(row.id);
    expect(retried).toMatchObject({ status: 'pending', transferId: 'xfer-r5b' });
    expect(call(4).body.idempotencyKey).toBe('R-5#2');
    expect(retried.detail.priorAttempts[0]).toMatchObject({ transferId: 'xfer-r5' });
  });

  it('books a re-driven transfer that confirms under the first attempt\'s local id', async () => {
    const spy = mockFetch(preflight('transfer'));
    spy.mockResolvedValueOnce(failure(500, 'FF10274: Error from tokens service'));
    spy.mockResolvedValueOnce(failure(500, 'FF10274: Error from tokens service'));
    await expect(FireflyEngine.transfer({ amountUsd: 40, reference: 'R-7' })).rejects.toThrow();
    const [failed] = await FireflyEngine.list({ limit: 1 });

    // The resend re-drives FireFly's original transaction tx-r7 ...
    spy.mockResolvedValueOnce({ ok: true, status: 202, statusText: 'ok', text: async () => JSON.stringify({ localId: 'xfer-r7-resend', state: 'pending', tx: { type: 'token_transfer', id: 'tx-r7' } }) } as any);
    const retried = await FireflyEngine.retry(failed.id);
    expect(retried).toMatchObject({ status: 'pending', transferId: 'xfer-r7-resend' });
    expect(retried.detail).toMatchObject({ idempotencyKey: 'R-7', fireflyTx: 'tx-r7' });

    // ... and the confirmation names the transfer the first attempt created.
    spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', text: async () => JSON.stringify({ id: 'tx-r7', idempotencyKey: 'R-7' }) } as any);
    const result = await FireflyEngine.handleEvent({ type: 'token_transfer_confirmed', tx: 'tx-r7', tokenTransfer: { localId: 'xfer-r7-first', tx: { id: 'tx-r7' } } });
    expect(result).toMatchObject({ handled: true, booked: true });
    expect(await FireflyEngine.get(failed.id)).toMatchObject({ status: 'confirmed', booked: true, transferId: 'xfer-r7-first' });
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledTimes(1);
  });

  it('sync follows the idempotency key when FireFly no longer knows the stored transfer id', async () => {
    const spy = mockFetch([...preflight('transfer'), { localId: 'xfer-r8-resend', state: 'pending', tx: { id: 'tx-r8' } }]);
    const row = await FireflyEngine.transfer({ amountUsd: 40, reference: 'R-8' });

    spy.mockResolvedValueOnce(failure(404, 'FF10109: Not found'));
    spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', text: async () => JSON.stringify([{ id: 'tx-r8', idempotencyKey: 'R-8' }]) } as any);
    spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', text: async () => JSON.stringify([{ localId: 'xfer-r8-first', state: 'confirmed', tx: { id: 'tx-r8' } }]) } as any);
    const synced = await FireflyEngine.sync(row.id);
    expect(call(5).url).toContain('/transactions?idempotencyKey=R-8');
    expect(call(6).url).toContain('/tokens/transfers?tx=tx-r8');
    expect(synced).toMatchObject({ polled: true, status: 'confirmed', booked: true, transferId: 'xfer-r8-first' });
  });

  it('sync reports, rather than fails, a re-driven transfer FireFly has not produced yet', async () => {
    const spy = mockFetch([...preflight('transfer'), { localId: 'xfer-r9', state: 'pending', tx: { id: 'tx-r9' } }]);
    const row = await FireflyEngine.transfer({ amountUsd: 40, reference: 'R-9' });
    spy.mockResolvedValueOnce(failure(404, 'FF10109: Not found'));
    spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', text: async () => JSON.stringify([{ id: 'tx-r9', idempotencyKey: 'R-9' }]) } as any);
    spy.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'ok', text: async () => JSON.stringify([]) } as any);
    expect(await FireflyEngine.sync(row.id)).toMatchObject({ polled: true, status: 'pending', booked: false, reason: expect.stringContaining('no transfer') });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('does not retry a shadow, confirmed or booked transfer', async () => {
    delete process.env.FIREFLY_LIVE;
    const shadow = await FireflyEngine.transfer({ amountUsd: 5, reference: 'R-6' });
    expect(await FireflyEngine.retry(shadow.id)).toMatchObject({ retried: false });
    await expect(FireflyEngine.retry('nope')).rejects.toThrow(/not found/);
  });
});

describe('firefly webhook', () => {
  it('books a confirmation for a known transfer', async () => {
    process.env.FIREFLY_LIVE = 'true';
    mockFetch([...preflight('transfer'), { localId: 'xfer-9', state: 'pending' }]);
    await FireflyEngine.transfer({ amountUsd: 60, reference: 'T-9' });

    const result = await FireflyEngine.handleEvent({
      type: 'token_transfer_confirmed',
      tokenTransfer: { localId: 'xfer-9', blockchainEvent: { tx: { transactionHash: '0xbeef' } } },
    });
    expect(result).toMatchObject({ handled: true, booked: true });
    expect(result.settlement).toMatchObject({ status: 'confirmed', txHash: '0xbeef' });
  });

  it('marks a failed transfer without booking it', async () => {
    process.env.FIREFLY_LIVE = 'true';
    mockFetch([...preflight('transfer'), { localId: 'xfer-10', state: 'pending' }]);
    await FireflyEngine.transfer({ amountUsd: 60, reference: 'T-10' });

    const result = await FireflyEngine.handleEvent({
      type: 'token_transfer_op_failed',
      tokenTransfer: { localId: 'xfer-10', message: 'insufficient token balance' },
    });
    expect(result).toMatchObject({ handled: true, booked: false });
    expect(result.settlement).toMatchObject({ status: 'failed' });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('ignores unrelated events and unknown transfers instead of failing', async () => {
    expect(await FireflyEngine.handleEvent({ type: 'message_confirmed' })).toMatchObject({ handled: false, ignored: true });
    expect(await FireflyEngine.handleEvent({ type: 'token_transfer_confirmed', tokenTransfer: { localId: 'nope' } }))
      .toMatchObject({ handled: false });
  });

  it('rejects an unsigned or wrongly signed body once a secret is configured', async () => {
    process.env.FIREFLY_WEBHOOK_SECRET = 'shhh';
    const body = JSON.stringify({ type: 'token_transfer_confirmed', tokenTransfer: { localId: 'xfer-11' } });
    await expect(FireflyEngine.handleEvent(JSON.parse(body), { rawBody: body, signature: 'sha256=deadbeef' }))
      .rejects.toThrow(/signature/i);
    await expect(FireflyEngine.handleEvent(JSON.parse(body), { rawBody: body, signature: null }))
      .rejects.toThrow(/signature/i);

    const signature = crypto.createHmac('sha256', 'shhh').update(body).digest('hex');
    expect(FireflyEngine.verifySignature(body, `sha256=${signature}`)).toBe(true);
  });
});

describe('firefly subscription', () => {
  it('does not duplicate an existing subscription', async () => {
    process.env.FIREFLY_SUBSCRIPTION_NAME = 'dlbtrust-settlement';
    mockFetch([[{ id: 'sub-1', name: 'dlbtrust-settlement', transport: 'webhooks' }]]);
    const result = await FireflyEngine.ensureSubscription({ webhookUrl: 'https://trust.example/api/hyperledger/firefly/webhook' });
    expect(result).toMatchObject({ created: false });
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it('creates one filtered to transfer outcomes', async () => {
    mockFetch([[], { id: 'sub-2', name: 'dlbtrust-settlement', transport: 'webhooks' }]);
    const result = await FireflyEngine.ensureSubscription({ webhookUrl: 'https://trust.example/hook' });
    expect(result).toMatchObject({ created: true });
    expect(call(1).body.filter.events).toContain('token_transfer_confirmed');
    expect(call(1).body.options.url).toBe('https://trust.example/hook');
  });
});

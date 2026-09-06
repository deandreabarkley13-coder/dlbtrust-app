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
    mockFetch([{ header: { id: 'msg-1' }, state: 'sent' }]);
    const instruction = { reference: 'SETTLE-1', amountUsd: 1000, beneficiary: 'Partner Bank' };
    const sent = await FireflyEngine.sendInstruction({ reference: 'SETTLE-1', instruction });

    const posted = call(0);
    expect(posted.url).toBe('https://firefly.trust.internal/api/v1/namespaces/trust/messages/private');
    expect(posted.body.header.group.members).toEqual([{ identity: 'org.partnerbank' }]);
    expect(posted.body.data[0].value.digest).toBe(FabricLedgerEngine.digest(instruction));
    expect(sent).toMatchObject({ messageId: 'msg-1', status: 'sent' });
    expect(await FabricLedgerEngine.history('settlement_instruction', 'SETTLE-1')).toHaveLength(1);
  });

  it('is idempotent on the reference', async () => {
    mockFetch([{ header: { id: 'msg-1' } }]);
    await FireflyEngine.sendInstruction({ reference: 'SETTLE-1', instruction: { amountUsd: 1 } });
    const again = await FireflyEngine.sendInstruction({ reference: 'SETTLE-1', instruction: { amountUsd: 1 } });
    expect(again.idempotent).toBe(true);
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
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

  it('honours the per-transfer ceiling', async () => {
    process.env.FIREFLY_LIVE = 'true';
    process.env.FIREFLY_MAX_TRANSFER_USD = '50';
    await expect(FireflyEngine.transfer({ amountUsd: 100, reference: 'T-4' })).rejects.toThrow(/exceeds/);
  });

  it('submits in the pool base units with the advice attached, and books nothing yet', async () => {
    process.env.FIREFLY_LIVE = 'true';
    process.env.FIREFLY_TOKEN_DECIMALS = '6';
    mockFetch([{ localId: 'xfer-1', message: 'msg-2', state: 'pending' }]);
    const row = await FireflyEngine.transfer({ amountUsd: 250.5, reference: 'T-5', memo: 'Q3 distribution' });

    const posted = call(0);
    expect(posted.url).toContain('/namespaces/trust/tokens/transfers');
    expect(posted.body).toMatchObject({ pool: 'usd-deposit', amount: '250500000', to: 'org.partnerbank' });
    expect(posted.body.message.data[0].value.memo).toBe('Q3 distribution');
    expect(row).toMatchObject({ status: 'pending', transferId: 'xfer-1', booked: false });
    expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
  });

  it('books once on confirmation and never twice', async () => {
    process.env.FIREFLY_LIVE = 'true';
    mockFetch([
      { localId: 'xfer-1', state: 'pending' },
      { state: 'confirmed', blockchainEvent: { tx: '0xdead' } },
      { state: 'confirmed', blockchainEvent: { tx: '0xdead' } },
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

  it('posts to both books when the source is the canonical ERP', async () => {
    process.env.FIREFLY_LIVE = 'true';
    vi.spyOn(CanonicalFundingSource, 'assertAvailable').mockResolvedValue({ availableBalanceCents: 900_000_00 } as any);
    const commit = vi.spyOn(CanonicalFundingSource, 'commit').mockResolvedValue({ committed: true, journalEntry: { id: 'je-canonical' } } as any);
    mockFetch([
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

describe('firefly webhook', () => {
  it('books a confirmation for a known transfer', async () => {
    process.env.FIREFLY_LIVE = 'true';
    mockFetch([{ localId: 'xfer-9', state: 'pending' }]);
    await FireflyEngine.transfer({ amountUsd: 60, reference: 'T-9' });

    const result = await FireflyEngine.handleEvent({
      type: 'token_transfer_confirmed',
      tokenTransfer: { localId: 'xfer-9', blockchainEvent: { tx: '0xbeef' } },
    });
    expect(result).toMatchObject({ handled: true, booked: true });
    expect(result.settlement).toMatchObject({ status: 'confirmed', txHash: '0xbeef' });
  });

  it('marks a failed transfer without booking it', async () => {
    process.env.FIREFLY_LIVE = 'true';
    mockFetch([{ localId: 'xfer-10', state: 'pending' }]);
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

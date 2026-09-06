import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { ThirdwebSettlementEngine } = require('../server/integrations/dapp/thirdwebSettlementEngine');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const WALLET = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
const RECIPIENT = '0x86167EcF041fFA95E5A4aEEFCB2632665Eb7FA16';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const SECRET = 'whsec_test';

function signed(body: object, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return { rawBody: Buffer.from(raw), headers: { 'x-webhook-signature': sig, 'x-webhook-timestamp': String(ts) } };
}

let rows: Record<string, any[]>;
let updates: any[][];
let claimRowCount: number;

beforeEach(() => {
  rows = {};
  updates = [];
  claimRowCount = 1;
  vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params: any[]) => {
    if (/^\s*UPDATE/i.test(sql)) {
      updates.push([sql, params]);
      return { rows: [], rowCount: sql.includes("SET status = 'settling'") ? claimRowCount : 1 };
    }
    for (const [needle, result] of Object.entries(rows)) if (sql.includes(needle)) return { rows: result, rowCount: result.length };
    return { rows: [], rowCount: 0 };
  });
  process.env.DAPP_CHAIN_ID = '1';
  process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
  process.env.THIRDWEB_SERVER_WALLET_ADDRESS = WALLET;
  process.env.THIRDWEB_WEBHOOK_SECRET = SECRET;
  process.env.THIRDWEB_SETTLEMENT_TOKEN = USDC;
  delete process.env.THIRDWEB_SERVER_WALLET_LIVE;
  vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({
    chainId: 1, tokenAddress: USDC, symbol: 'USDC', decimals: 6, priceUsd: 1, source: 'thirdweb', fetchedAt: Date.now(),
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('thirdweb settlement readiness', () => {
  it('is ready when wallet, webhook secret and settlement token are configured', () => {
    const r = ThirdwebSettlementEngine.readiness();
    expect(r.ready).toBe(true);
    expect(r.shadow).toBe(true);
    expect(r.webhookPath).toBe('/api/dapp/thirdweb/webhooks');
  });

  it('flags the missing webhook secret', () => {
    delete process.env.THIRDWEB_WEBHOOK_SECRET;
    const r = ThirdwebSettlementEngine.readiness();
    expect(r.ready).toBe(false);
    expect(r.issues.join(' ')).toMatch(/THIRDWEB_WEBHOOK_SECRET/);
  });
});

describe('settleDistribution', () => {
  const approved = {
    id: 'DR-1', type: 'distribution', status: 'approved', amount_cents: 250000,
    destination_address: RECIPIENT, memo: 'medical', metadata: { expenseId: 'EXP-9', purpose: 'medical' },
  };

  it('records a shadow USDC transfer and finalizes the request + linked expense', async () => {
    rows['FROM dapp_distribution_requests WHERE id'] = [approved];
    const result = await ThirdwebSettlementEngine.settleDistribution('DR-1');
    expect(result.transfer.shadow).toBe(true);
    expect(result.transfer.tokenAddress).toBe(USDC);
    expect(result.transfer.quantity).toBe('2500000000');
    expect(result.transfer.reference).toBe('DR-1');
    const distUpdates = updates.filter(([sql]) => sql.includes('dapp_distribution_requests'));
    expect(distUpdates[0][0]).toContain("SET status = 'settling'");
    expect(distUpdates.slice(1).map(([, p]) => p[1])).toEqual(['payout_created', 'executed']);
    const expStatuses = updates.filter(([sql]) => sql.includes('expense_records')).map(([, p]) => p[1]);
    expect(expStatuses[expStatuses.length - 1]).toBe('paid');
  });

  it('refuses unapproved requests and never sends twice', async () => {
    rows['FROM dapp_distribution_requests WHERE id'] = [{ ...approved, status: 'requested' }];
    await expect(ThirdwebSettlementEngine.settleDistribution('DR-1')).rejects.toThrow(/only approved/);

    const send = vi.spyOn(ThirdwebServerWalletEngine, 'send');
    rows['FROM dapp_distribution_requests WHERE id'] = [{ ...approved, metadata: { thirdwebTransferId: 'TWSW-1' } }];
    const again = await ThirdwebSettlementEngine.settleDistribution('DR-1');
    expect(again.alreadySettled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a non-EVM destination and non-USD records', async () => {
    rows['FROM dapp_distribution_requests WHERE id'] = [{ ...approved, destination_address: 'acct-1000' }];
    await expect(ThirdwebSettlementEngine.settleDistribution('DR-1')).rejects.toThrow(/EVM address/);
    const send = vi.spyOn(ThirdwebServerWalletEngine, 'send');
    rows['FROM dapp_distribution_requests WHERE id'] = [{ ...approved, currency: 'EUR' }];
    await expect(ThirdwebSettlementEngine.settleDistribution('DR-1')).rejects.toMatchObject({ status: 422 });
    rows['FROM expense_records WHERE id'] = [{ id: 'EXP-1', status: 'approved', amount_cents: 100, currency: 'GBP', metadata: { walletAddress: RECIPIENT, purpose: 'home' } }];
    await expect(ThirdwebSettlementEngine.settleExpense('EXP-1')).rejects.toMatchObject({ status: 422 });
    expect(send).not.toHaveBeenCalled();
  });

  it('lets only one concurrent caller broadcast', async () => {
    rows['FROM dapp_distribution_requests WHERE id'] = [approved];
    const send = vi.spyOn(ThirdwebServerWalletEngine, 'send');
    let claims = 0;
    (pool.query as any).mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes("SET status = 'settling'")) return { rows: [], rowCount: claims++ === 0 ? 1 : 0 };
      if (/^\s*UPDATE/i.test(sql)) { updates.push([sql, params]); return { rows: [], rowCount: 1 }; }
      for (const [needle, result] of Object.entries(rows)) if (sql.includes(needle)) return { rows: result, rowCount: result.length };
      return { rows: [], rowCount: 0 };
    });
    const outcomes = await Promise.allSettled([
      ThirdwebSettlementEngine.settleDistribution('DR-1'),
      ThirdwebSettlementEngine.settleDistribution('DR-1'),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the send fails so the payable stays retryable', async () => {
    rows['FROM dapp_distribution_requests WHERE id'] = [approved];
    vi.spyOn(ThirdwebServerWalletEngine, 'send').mockRejectedValue(new Error('thirdweb down'));
    await expect(ThirdwebSettlementEngine.settleDistribution('DR-1')).rejects.toThrow('thirdweb down');
    const release = updates.find(([sql]) => sql.includes("SET status = 'approved'") && sql.includes("status = 'settling'"));
    expect(release?.[1]).toEqual(['DR-1']);
  });

  it('reconcile re-attaches a broadcast transfer to a payable stuck in settling instead of paying again', async () => {
    rows["r.status = 'settling'"] = [{ id: 'DR-7', metadata: {}, transfer_id: 'TWSW-7', thirdweb_transaction_id: 'tx-7', transaction_hash: null, transfer_status: 'submitted', shadow: false }];
    const send = vi.spyOn(ThirdwebServerWalletEngine, 'send');
    vi.spyOn(ThirdwebServerWalletEngine, 'openTransfers').mockResolvedValue([]);
    const r = await ThirdwebSettlementEngine.reconcile();
    expect(send).not.toHaveBeenCalled();
    expect(r.repaired).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'DR-7', action: 'reattached', transferId: 'TWSW-7' })]));
    const upd = updates.find(([, p]) => p && p[0] === 'DR-7');
    expect(upd[1][1]).toBe('payout_created');
    expect(JSON.parse(upd[1][2]).thirdwebTransferId).toBe('TWSW-7');
  });

  it('reconcile walks every open transfer, not just a recent window', async () => {
    const open = vi.spyOn(ThirdwebServerWalletEngine, 'openTransfers')
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => ({ id: `T${i}`, transactionId: `tx${i}`, status: 'submitted' })))
      .mockResolvedValueOnce([{ id: 'OLD', transactionId: 'txold', status: 'submitted' }]);
    vi.spyOn(ThirdwebServerWalletEngine, 'getTransaction').mockResolvedValue({ id: 'x', status: 'QUEUED' } as any);
    const r = await ThirdwebSettlementEngine.reconcile();
    expect(open).toHaveBeenCalledTimes(2);
    expect(r.checked).toBe(201);
  });
});

describe('webhooks', () => {
  it('rejects a bad signature and a stale timestamp', async () => {
    const bad = signed({ id: 'evt', type: 'engine.transaction.confirmed', data: {} }, 'wrong');
    await expect(ThirdwebSettlementEngine.handleWebhook(bad)).rejects.toMatchObject({ status: 401 });
    const stale = signed({ id: 'evt', type: 'engine.transaction.confirmed', data: {} }, SECRET, Math.floor(Date.now() / 1000) - 3600);
    await expect(ThirdwebSettlementEngine.handleWebhook(stale)).rejects.toMatchObject({ status: 401 });
  });

  it('acknowledges but ignores deliveries when no secret is configured (so thirdweb can create the webhook)', async () => {
    delete process.env.THIRDWEB_WEBHOOK_SECRET;
    const apply = vi.spyOn(ThirdwebSettlementEngine, '_applyTransaction');
    const r = await ThirdwebSettlementEngine.handleWebhook({ rawBody: Buffer.from('{"type":"engine.transaction.confirmed","data":{"id":"tx-1"}}'), headers: {} });
    expect(r.ignored).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect((pool.query as any).mock.calls.some(([sql]: [string]) => /thirdweb_webhook_events/.test(sql))).toBe(false);
    expect(ThirdwebSettlementEngine.verifySignature.bind(ThirdwebSettlementEngine, signed({ id: 'e', type: 'x', data: {} }))).toThrow(/not configured/);
  });

  it('does not mark a delivery as handled when dispatch fails, so redelivery is processed', async () => {
    vi.spyOn(ThirdwebSettlementEngine, '_applyTransaction').mockRejectedValueOnce(new Error('db down'));
    const evt = signed({ id: 'evt_x', type: 'engine.transaction.confirmed', data: { id: 'tx-x', status: 'CONFIRMED' } });
    await expect(ThirdwebSettlementEngine.handleWebhook(evt)).rejects.toMatchObject({ status: 500 });
    expect(updates.length).toBe(0);
    const inserts = (pool.query as any).mock.calls.filter(([sql]: [string]) => /INSERT INTO thirdweb_webhook_events/.test(sql));
    expect(inserts).toHaveLength(0);
    const events = await ThirdwebSettlementEngine.recentEvents(10);
    expect(events.find((e: any) => e.id === 'evt_x')).toBeUndefined();
  });

  it('finalizes the distribution referenced by a confirmed engine transaction, once', async () => {
    rows['FROM thirdweb_server_wallet_transfers WHERE thirdweb_transaction_id'] = [{ id: 'TWSW-1', reference: 'DR-1', transaction_hash: null, error: null }];
    rows["FROM dapp_distribution_requests WHERE metadata->>'thirdwebTransferId'"] = [{ id: 'DR-1' }];
    rows['SELECT metadata, amount_cents, destination_address'] = [{ metadata: {}, amount_cents: 100, destination_address: RECIPIENT }];
    const evt = signed({ id: 'evt_1', type: 'engine.transaction.confirmed', data: { id: 'tx-1', status: 'CONFIRMED', transactionHash: '0xabc' } });
    const first = await ThirdwebSettlementEngine.handleWebhook(evt);
    expect(first.duplicate).toBe(false);
    expect(first.outcome).toMatchObject({ handled: true, applied: true, outcome: 'confirmed', distributions: ['DR-1'] });
    const dist = updates.find(([sql]) => sql.includes('dapp_distribution_requests'));
    expect(dist[1][1]).toBe('executed');
    expect(dist[1][2]).toBe('0xabc');

    rows['FROM thirdweb_webhook_events WHERE id'] = [{ id: 'evt_1', outcome: first.outcome }];
    const second = await ThirdwebSettlementEngine.handleWebhook(evt);
    expect(second.duplicate).toBe(true);
  });

  it('routes Payments events to the bond subscription that owns the paymentId', async () => {
    const { BondSubscriptionEngine } = require('../server/integrations/bonds/bondSubscriptionEngine');
    const sync = vi.spyOn(BondSubscriptionEngine, 'sync').mockResolvedValue({ id: 'SUB-1', status: 'DELIVERED' });
    rows['FROM bond_subscriptions WHERE payment_id'] = [{ id: 'SUB-1' }];
    const evt = signed({ version: 2, type: 'pay.onchain-transaction', data: { paymentId: '0xpay', status: 'COMPLETED' } });
    const r = await ThirdwebSettlementEngine.handleWebhook(evt);
    expect(sync).toHaveBeenCalledWith('SUB-1');
    expect(r.outcome.subscriptions[0].status).toBe('DELIVERED');
  });
});

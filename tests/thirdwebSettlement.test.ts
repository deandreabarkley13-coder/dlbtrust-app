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

beforeEach(() => {
  rows = {};
  updates = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params: any[]) => {
    if (/^\s*UPDATE/i.test(sql)) { updates.push([sql, params]); return { rows: [], rowCount: 1 }; }
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
    const distStatuses = updates.filter(([sql]) => sql.includes('dapp_distribution_requests')).map(([, p]) => p[1]);
    expect(distStatuses).toEqual(['payout_created', 'executed']);
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

  it('rejects a non-EVM destination', async () => {
    rows['FROM dapp_distribution_requests WHERE id'] = [{ ...approved, destination_address: 'acct-1000' }];
    await expect(ThirdwebSettlementEngine.settleDistribution('DR-1')).rejects.toThrow(/EVM address/);
  });
});

describe('webhooks', () => {
  it('rejects a bad signature and a stale timestamp', async () => {
    const bad = signed({ id: 'evt', type: 'engine.transaction.confirmed', data: {} }, 'wrong');
    await expect(ThirdwebSettlementEngine.handleWebhook(bad)).rejects.toMatchObject({ status: 401 });
    const stale = signed({ id: 'evt', type: 'engine.transaction.confirmed', data: {} }, SECRET, Math.floor(Date.now() / 1000) - 3600);
    await expect(ThirdwebSettlementEngine.handleWebhook(stale)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses every delivery when no secret is configured', async () => {
    delete process.env.THIRDWEB_WEBHOOK_SECRET;
    await expect(ThirdwebSettlementEngine.handleWebhook(signed({ id: 'e', type: 'x', data: {} }))).rejects.toMatchObject({ status: 503 });
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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import type { AddressInfo } from 'net';

const require = createRequire(import.meta.url);
const express = require('express');
const { BankSettlementEngine } = require('../server/integrations/payments/bankSettlementEngine');
const { LiliSettlementBankEngine } = require('../server/integrations/payments/liliSettlementBankEngine');
const { LiliDirectDepositEngine } = require('../server/integrations/payments/liliDirectDepositEngine');
const { LiliMcpEngine } = require('../server/integrations/payments/liliMcpEngine');
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const pool = require('../server/integrations/bonds/pgPool');
const bankSettlementRoutes = require('../server/routes/bankSettlement');

const saved = { ...process.env };
const TOKEN = 'test-payment-server-token';

let baseUrl = '';
let server: ReturnType<typeof app.listen>;
const app = express();
app.use(express.json());
app.use('/api/payment-server/v1', bankSettlementRoutes);

function call(method: string, path: string, body?: any, token: string | null = TOKEN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/api/payment-server/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('S2S payment server — /api/payment-server/v1', () => {
  let events: Record<string, any>;
  let odfi: any;

  beforeEach(() => {
    events = {};
    odfi = { ready: true, channels: ['sftp'], loopback: [], blocker: null };
    process.env.PAYMENT_SERVER_SERVICE_TOKEN = TOKEN;
    process.env.LILI_CLEARING_LIVE = 'true';
    process.env.LILI_DD_ROUTING_NUMBER = '121145307';
    process.env.LILI_DD_ACCOUNT_NUMBER = '692101092959';
    process.env.LILI_DD_ACCOUNT_NAME = 'DB NET MGMT LLC';
    process.env.ACH_SFTP_URL = 'sftp://odfi.example.com/inbound';
    vi.spyOn(SystemSettings, 'get').mockResolvedValue(null);
    vi.spyOn(LiliDirectDepositEngine, 'odfiStatus').mockImplementation(async () => odfi);
    vi.spyOn(LiliMcpEngine, 'getPublicConfig').mockResolvedValue({ configured: true });
    vi.spyOn(pool, 'query').mockImplementation(async (text: any, params: any[] = []) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      if (t.startsWith('CREATE TABLE')) return { rows: [] } as any;
      if (t.startsWith('INSERT INTO settlement_bank_events')) {
        events[params[0]] = {
          settlement_id: params[0], bank_id: params[1], provider: params[2], rail: params[3], amount_cents: params[4], currency: params[5],
          status: params[6], live: params[7], approval_ref: params[8], screening_ref: params[9], reference: params[10], description: params[11],
          initiated_by: params[12], result: null, reconciliation: null, error_message: null,
        };
        return { rows: [] } as any;
      }
      if (t.startsWith('UPDATE settlement_bank_events SET')) {
        const e = events[params[0]];
        if (e) {
          if (params[1]) e.status = params[1];
          if (params[2]) e.provider_reference = params[2];
          if (params[3]) e.provider_status = params[3];
          e.error_message = params[4];
          if (params[5]) e.result = JSON.parse(params[5]);
          if (params[6]) e.reconciliation = JSON.parse(params[6]);
        }
        return { rows: [] } as any;
      }
      if (t.startsWith('SELECT * FROM settlement_bank_events WHERE settlement_id')) return { rows: events[params[0]] ? [events[params[0]]] : [] } as any;
      if (t.startsWith('SELECT * FROM settlement_banks')) return { rows: [] } as any;
      return { rows: [] } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('401 without the service token', async () => {
    expect((await call('GET', '/settlement-banks', undefined, null)).status).toBe(401);
    expect((await call('GET', '/settlement-banks', undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/settlements', { bankId: 'lili', amountCents: 100 }, null)).status).toBe(401);
    delete process.env.PAYMENT_SERVER_SERVICE_TOKEN;
    expect((await call('GET', '/settlement-banks')).status).toBe(401);
  });

  it('lists lili (registered from LILI_DD_* env) and reports live + ready readiness', async () => {
    const list = await call('GET', '/settlement-banks');
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.data[0]).toMatchObject({ bankId: 'lili', provider: 'lili', routingNumber: '121145307', accountNumberMasked: '****2959' });
    expect(body.data[0]).not.toHaveProperty('_account');

    const ready = await call('GET', '/settlement-banks/lili/readiness');
    expect(ready.status).toBe(200);
    const r = await ready.json();
    expect(r.data).toMatchObject({ bankId: 'lili', live: true, mode: 'live', ready: true, blockers: [], requires: ['approvalRef', 'screeningRef'] });
    expect(r.data.destination.configured).toBe(true);
    expect(r.data.odfi.ready).toBe(true);
    expect(r.data.mcp.configured).toBe(true);
  });

  it('POST /settlements delegates to LiliSettlementBankEngine._sendPayment with autoTransmit via the ODFI channel', async () => {
    const send = vi.spyOn(LiliSettlementBankEngine, '_sendPayment').mockResolvedValue({
      transferId: 'LILIDD-1', status: 'originated', live: true, provider: 'lili', lili: { depositId: 'LILIDD-1', achBatchId: 'ACH-1' },
    });
    const res = await call('POST', '/settlements', { bankId: 'lili', amountCents: 12345, approvalRef: 'APR-1', screeningRef: 'SCR-1', reference: 'INV-9' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ bankId: 'lili', provider: 'lili', rail: 'ach', amountCents: 12345, live: true, status: 'originated', providerReference: 'LILIDD-1' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ amount: 123.45, currency: 'USD', type: 'push', reference: 'INV-9', destination: null }));

    const got = await call('GET', `/settlements/${body.data.settlementId}`);
    expect(got.status).toBe(200);
    expect((await got.json()).data).toMatchObject({ status: 'originated', providerReference: 'LILIDD-1', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
  });

  it('live settlement without approvalRef/screeningRef is refused (409) before any provider call', async () => {
    const send = vi.spyOn(LiliSettlementBankEngine, '_sendPayment');
    const res = await call('POST', '/settlements', { bankId: 'lili', amountCents: 100 });
    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it('destination mismatch → 400', async () => {
    const send = vi.spyOn(LiliSettlementBankEngine, '_sendPayment');
    const res = await call('POST', '/settlements', {
      bankId: 'lili', amountCents: 100, approvalRef: 'APR-1', screeningRef: 'SCR-1',
      destination: { routingNumber: '121145307', accountNumber: '000000001' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/registered Lili account/);
    expect(send).not.toHaveBeenCalled();

    const reg = await call('POST', '/settlement-banks', { bankId: 'lili', provider: 'lili', routingNumber: '091000019', accountNumber: '692101092959' });
    expect(reg.status).toBe(400);
  });

  it('no ODFI channel → 503 awaiting_odfi, nothing transmitted', async () => {
    odfi = { ready: false, channels: [], loopback: [], blocker: 'No ODFI channel configured (AS2/MFT/REST/SFTP)' };
    const create = vi.spyOn(LiliDirectDepositEngine, 'createDirectDeposit');

    const ready = await call('GET', '/settlement-banks/lili/readiness');
    expect(ready.status).toBe(503);
    expect((await ready.json()).data.blockers.join(' ')).toMatch(/No ODFI channel/);

    const res = await call('POST', '/settlements', { bankId: 'lili', amountCents: 100, approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('awaiting_odfi');
    expect(body.error).toMatch(/No ODFI channel/);
    expect(create).not.toHaveBeenCalled();
    expect(events[body.settlementId].status).toBe('awaiting_odfi');
  });

  it('reconcile delegates to LiliDirectDepositEngine.reconcile and marks the settlement reconciled on a match', async () => {
    vi.spyOn(LiliSettlementBankEngine, '_sendPayment').mockResolvedValue({ transferId: 'LILIDD-7', status: 'originated', lili: { depositId: 'LILIDD-7' } });
    const rec = vi.spyOn(LiliDirectDepositEngine, 'reconcile').mockResolvedValue({ matched: 1, unmatched: 0, deposits: [{ depositId: 'LILIDD-7', matched: true, liliTransactionId: 'T-1' }] });
    const created = await (await call('POST', '/settlements', { bankId: 'lili', amountCents: 500, approvalRef: 'A', screeningRef: 'S' })).json();

    const res = await call('POST', `/settlements/${created.data.settlementId}/reconcile`, { windowDays: 3 });
    expect(res.status).toBe(200);
    expect(rec).toHaveBeenCalledWith(expect.objectContaining({ depositId: 'LILIDD-7', windowDays: 3 }));
    const body = await res.json();
    expect(body.data.status).toBe('reconciled');
    expect(body.data.reconciliation).toMatchObject({ channel: 'lili_mcp', matched: true, depositId: 'LILIDD-7' });

    expect((await call('POST', '/settlements/SBS-nope/reconcile', {})).status).toBe(404);
  });

  it('BankSettlementEngine.clearAndSettle rejects unknown banks and bad amounts', async () => {
    await expect(BankSettlementEngine.clearAndSettle({ bankId: 'nope', amountCents: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(BankSettlementEngine.clearAndSettle({ bankId: 'lili', amountCents: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(BankSettlementEngine.clearAndSettle({ bankId: 'lili', amountCents: 10.5 })).rejects.toMatchObject({ status: 400 });
  });
});

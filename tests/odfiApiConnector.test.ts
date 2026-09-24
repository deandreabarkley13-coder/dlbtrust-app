import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

const pool = require('../server/integrations/bonds/pgPool');
const { ACHEngine } = require('../server/integrations/ach/achEngine');
const { OdfiApiConnectorEngine, OdfiApiError } = require('../server/integrations/ach/odfiApiConnectorEngine');

type Row = Record<string, any>;

const ENV = ['ACH_ODFI_ENABLED', 'ACH_ODFI_PROVIDER', 'ACH_ODFI_API_BASE_URL', 'ACH_ODFI_API_KEY', 'ACH_ODFI_ACCOUNT_ID', 'ACH_ODFI_WEBHOOK_SECRET', 'ACH_ODFI_PROVIDER_NAME'];
const saved: Record<string, string | undefined> = {};

function configure(overrides: Record<string, string> = {}) {
  process.env.ACH_ODFI_PROVIDER = 'increase';
  process.env.ACH_ODFI_API_KEY = 'test_key';
  process.env.ACH_ODFI_ACCOUNT_ID = 'account_abc';
  process.env.ACH_ODFI_WEBHOOK_SECRET = 'whsec_test';
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
}

function batch(entries: Row[] = [{ entry_sequence: 1, amount_cents: 100, transaction_code: '22', receiving_routing: '121145307', account_number: '2959', individual_name: 'DB NET MGMT LLC', individual_id: 'INTENT1' }]): Row {
  return { batch_id: 'B1', sec_code: 'CCD', entry_description: 'TRUST PMT', effective_date: '2026-09-25', status: 'transmitted', entries };
}

/** In-memory odfi_api_transfers + minimal ach_batches state. */
function world() {
  const transfers: Row[] = [];
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    if (/^SELECT \* FROM odfi_api_transfers WHERE batch_id = \$1 AND entry_sequence = \$2/.test(text)) {
      return { rows: transfers.filter((t) => t.batch_id === params[0] && t.entry_sequence === params[1]) };
    }
    if (/^SELECT \* FROM odfi_api_transfers WHERE provider = \$1 AND provider_transfer_id = \$2/.test(text)) {
      return { rows: transfers.filter((t) => t.provider === params[0] && t.provider_transfer_id === params[1]) };
    }
    if (/^SELECT \* FROM odfi_api_transfers WHERE provider = \$1 AND provider_transfer_id IS NOT NULL/.test(text)) {
      return { rows: transfers.filter((t) => t.provider === params[0] && t.provider_transfer_id && !params[1].includes(t.status)) };
    }
    if (/^INSERT INTO odfi_api_transfers/.test(text)) {
      const row = { transfer_id: params[0], provider: params[1], provider_transfer_id: params[2], batch_id: params[3], entry_sequence: params[4], amount_cents: params[5], status: params[6], trace_number: params[7], settled_at: params[8], raw: params[9], return_code: null, return_reason: null, created_at: new Date(), updated_at: new Date() };
      const i = transfers.findIndex((t) => t.batch_id === row.batch_id && t.entry_sequence === row.entry_sequence);
      if (i >= 0) transfers[i] = { ...transfers[i], ...row, transfer_id: transfers[i].transfer_id }; else transfers.push(row);
      return { rows: [i >= 0 ? transfers[i] : row] };
    }
    if (/^UPDATE odfi_api_transfers SET status/.test(text)) {
      const t = transfers.find((x) => x.transfer_id === params[0]);
      Object.assign(t, { status: params[1], trace_number: params[2] ?? t.trace_number, settled_at: params[3] ?? t.settled_at, return_code: params[4] ?? t.return_code, return_reason: params[5] ?? t.return_reason, raw: params[6] });
      return { rows: [t] };
    }
    if (/^SELECT COUNT\(\*\)::int AS n FROM odfi_api_transfers/.test(text)) {
      return { rows: [{ n: transfers.filter((t) => t.batch_id === params[0] && t.status !== 'settled').length }] };
    }
    if (/^UPDATE ach_entries SET trace_number/.test(text)) return { rows: [] };
    if (/^SELECT \* FROM odfi_api_transfers/.test(text)) return { rows: transfers.slice() };
    if (/^SELECT status, COUNT/.test(text)) return { rows: [] };
    throw new Error(`unexpected sql: ${text}`);
  });
  return { transfers, query };
}

function increaseTransfer(over: Row = {}): Row {
  return { id: 'ach_transfer_1', status: 'submitted', submission: { trace_number: '121145307000001' }, settlement: null, return: null, ...over };
}

function signIncrease(secret: string, body: string) {
  const id = 'msg_1';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v1,${crypto.createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64')}`;
  return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig };
}

let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: any) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OdfiApiConnectorEngine readiness', () => {
  it('is not ready without a provider and yields no partner config', () => {
    const r = OdfiApiConnectorEngine.readiness();
    expect(r.ready).toBe(false);
    expect(r.issues[0]).toMatch(/ACH_ODFI_PROVIDER/);
    expect(OdfiApiConnectorEngine.partnerConfig()).toBeNull();
    expect(ACHEngine.odfiApiPartnerConfig()).toBeNull();
  });

  it('rejects unsupported providers', () => {
    configure({ ACH_ODFI_PROVIDER: 'dwolla' });
    const r = OdfiApiConnectorEngine.readiness();
    expect(r.ready).toBe(false);
    expect(r.issues.join(' ')).toMatch(/not supported \(increase, column\)/);
  });

  it('requires the API key and the funded account id; warns without webhook secret', () => {
    configure({ ACH_ODFI_API_KEY: '', ACH_ODFI_ACCOUNT_ID: '', ACH_ODFI_WEBHOOK_SECRET: '' });
    const r = OdfiApiConnectorEngine.readiness();
    expect(r.ready).toBe(false);
    expect(r.issues).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/ACH_ODFI_WEBHOOK_SECRET/);
    expect(r.creditsOnly).toBe(true);
  });

  it('becomes an odfi_api partner for ACHEngine when configured', () => {
    configure({ ACH_ODFI_PROVIDER_NAME: 'Increase (Grasshopper)' });
    const p = OdfiApiConnectorEngine.partnerConfig();
    expect(p).toMatchObject({ partnerId: 'ODFI-API-INCREASE', partnerName: 'Increase (Grasshopper)', protocol: 'odfi_api', provider: 'increase', apiBaseUrl: 'https://api.increase.com' });
    expect(OdfiApiConnectorEngine.readiness().webhookConfigured).toBe(true);
  });

  it('can be switched off explicitly', () => {
    configure({ ACH_ODFI_ENABLED: 'false' });
    expect(OdfiApiConnectorEngine.readiness().issues).toContain('ACH_ODFI_ENABLED=false');
  });
});

describe('OdfiApiConnectorEngine.originateBatch (increase)', () => {
  it('refuses debit entries before touching the provider', async () => {
    configure();
    const { query } = world();
    vi.spyOn(pool, 'query').mockImplementation(query);
    await expect(OdfiApiConnectorEngine.originateBatch(batch([{ entry_sequence: 1, amount_cents: 100, transaction_code: '27', receiving_routing: '121145307', account_number: '1' }])))
      .rejects.toMatchObject({ code: 'CREDITS_ONLY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the provider available balance is below the batch total', async () => {
    configure();
    const { query } = world();
    vi.spyOn(pool, 'query').mockImplementation(query);
    fetchMock.mockResolvedValueOnce(respond(200, { available_balance: 29, current_balance: 29 }));
    await expect(OdfiApiConnectorEngine.originateBatch(batch())).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', status: 409, details: { availableCents: 29, requiredCents: 100 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.increase.com/accounts/account_abc/balance');
  });

  it('originates one idempotent ACH credit per entry and returns the transmit result shape', async () => {
    configure();
    const w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query);
    fetchMock
      .mockResolvedValueOnce(respond(200, { available_balance: 1_000_000, current_balance: 1_000_000 }))
      .mockResolvedValueOnce(respond(200, increaseTransfer({ status: 'pending_submission', submission: null })));

    const result = await OdfiApiConnectorEngine.originateBatch(batch());
    expect(result).toMatchObject({ success: true, mode: 'odfi_api', message_id: 'ODFI-INCREASE-B1', status_code: 200, mdn_received: false });
    expect(result.odfi.transfers).toHaveLength(1);
    expect(result.odfi.transfers[0]).toMatchObject({ provider: 'increase', providerTransferId: 'ach_transfer_1', status: 'pending', amountCents: 100, batchId: 'B1', entrySequence: 1 });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.increase.com/ach_transfers');
    expect(init.headers.authorization).toBe('Bearer test_key');
    expect(init.headers['Idempotency-Key']).toBe('dlbtrust:B1:1');
    expect(JSON.parse(init.body)).toMatchObject({
      account_id: 'account_abc', amount: 100, routing_number: '121145307', account_number: '2959', funding: 'checking',
      individual_name: 'DB NET MGMT LLC', individual_id: 'INTENT1', standard_entry_class_code: 'corporate_credit_or_debit',
      statement_descriptor: 'TRUST PMT', preferred_effective_date: { date: '2026-09-25' },
    });

    // Re-running the same batch does not re-originate at the provider.
    fetchMock.mockResolvedValueOnce(respond(200, { available_balance: 1_000_000, current_balance: 1_000_000 }));
    const again = await OdfiApiConnectorEngine.originateBatch(batch());
    expect(again.odfi.transfers[0].providerTransferId).toBe('ach_transfer_1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps savings receivers and PPD batches for Increase', async () => {
    configure();
    const w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query);
    fetchMock
      .mockResolvedValueOnce(respond(200, { available_balance: 500, current_balance: 500 }))
      .mockResolvedValueOnce(respond(200, increaseTransfer()));
    const b = batch([{ entry_sequence: 1, amount_cents: 100, transaction_code: '32', receiving_routing: '121145307', account_number: '1', individual_name: 'X' }]);
    b.sec_code = 'PPD';
    await OdfiApiConnectorEngine.originateBatch(b);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ funding: 'savings', standard_entry_class_code: 'prearranged_payments_and_deposit' });
  });

  it('surfaces provider errors with the provider detail', async () => {
    configure();
    const w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query);
    fetchMock.mockResolvedValueOnce(respond(401, { title: 'Invalid API key', type: 'invalid_api_key_error' }));
    await expect(OdfiApiConnectorEngine.originateBatch(batch())).rejects.toMatchObject({ code: 'PROVIDER_ERROR', status: 502, message: expect.stringMatching(/Invalid API key/) });
  });

  it('refuses to originate when not configured', async () => {
    await expect(OdfiApiConnectorEngine.originateBatch(batch())).rejects.toMatchObject({ code: 'NOT_READY', status: 503 });
  });
});

describe('OdfiApiConnectorEngine.originateBatch (column)', () => {
  it('creates a counterparty then a CREDIT transfer with Basic auth', async () => {
    configure({ ACH_ODFI_PROVIDER: 'column', ACH_ODFI_ACCOUNT_ID: 'bacc_1' });
    const w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query);
    fetchMock
      .mockResolvedValueOnce(respond(200, { id: 'bacc_1', balances: { available_amount: 5000, holding_amount: 0 } }))
      .mockResolvedValueOnce(respond(200, { id: 'cpty_1' }))
      .mockResolvedValueOnce(respond(200, { id: 'acht_1', status: 'INITIATED' }));
    const r = await OdfiApiConnectorEngine.originateBatch(batch());
    expect(r.odfi.transfers[0]).toMatchObject({ provider: 'column', providerTransferId: 'acht_1', status: 'pending' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.column.com/bank-accounts/bacc_1');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.column.com/counterparties');
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.column.com/transfers/ach');
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe(`Basic ${Buffer.from(':test_key').toString('base64')}`);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ bank_account_id: 'bacc_1', counterparty_id: 'cpty_1', amount: 100, type: 'CREDIT', entry_class_code: 'CCD', currency_code: 'USD' });
  });
});

describe('OdfiApiConnectorEngine webhooks and sync', () => {
  async function seed(w: ReturnType<typeof world>) {
    fetchMock
      .mockResolvedValueOnce(respond(200, { available_balance: 1_000_000, current_balance: 1_000_000 }))
      .mockResolvedValueOnce(respond(200, increaseTransfer({ status: 'pending_submission', submission: null })));
    await OdfiApiConnectorEngine.originateBatch(batch());
    fetchMock.mockClear();
  }

  it('rejects unsigned and mis-signed webhooks and provider mismatches', async () => {
    configure();
    const body = JSON.stringify({ category: 'ach_transfer.updated', associated_object_type: 'ach_transfer', associated_object_id: 'ach_transfer_1' });
    await expect(OdfiApiConnectorEngine.handleWebhook('column', body, {})).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH', status: 404 });
    await expect(OdfiApiConnectorEngine.handleWebhook('increase', body, {})).rejects.toMatchObject({ code: 'BAD_SIGNATURE', status: 401 });
    await expect(OdfiApiConnectorEngine.handleWebhook('increase', body, signIncrease('wrong', body))).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    const stale = signIncrease('whsec_test', body); stale['webhook-timestamp'] = String(Math.floor(Date.now() / 1000) - 3600);
    await expect(OdfiApiConnectorEngine.handleWebhook('increase', body, stale)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the batch on submission and settles it once every transfer settled', async () => {
    configure();
    const w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query);
    await seed(w);
    const state = { status: 'transmitted' };
    vi.spyOn(ACHEngine, 'getBatch').mockImplementation(async () => ({ batch_id: 'B1', status: state.status }));
    const accept = vi.spyOn(ACHEngine, 'acceptBatch').mockImplementation(async () => { state.status = 'accepted'; });
    const settle = vi.spyOn(ACHEngine, 'settleBatch').mockImplementation(async () => { state.status = 'settled'; });
    const returns = vi.spyOn(ACHEngine, 'processReturns').mockResolvedValue({});

    const body = JSON.stringify({ category: 'ach_transfer.updated', associated_object_type: 'ach_transfer', associated_object_id: 'ach_transfer_1' });
    fetchMock.mockResolvedValueOnce(respond(200, increaseTransfer({ status: 'submitted' })));
    let r = await OdfiApiConnectorEngine.handleWebhook('increase', Buffer.from(body), signIncrease('whsec_test', body));
    expect(r.updated[0]).toMatchObject({ status: 'submitted', traceNumber: '121145307000001' });
    expect(accept).toHaveBeenCalledWith('B1', { source: 'odfi_api:increase' });
    expect(settle).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(respond(200, increaseTransfer({ status: 'submitted', settlement: { settled_at: '2026-09-26T14:00:00Z' } })));
    r = await OdfiApiConnectorEngine.handleWebhook('increase', Buffer.from(body), signIncrease('whsec_test', body));
    expect(r.updated[0].status).toBe('settled');
    expect(settle).toHaveBeenCalledWith('B1', { settlementDate: '2026-09-26', source: 'odfi_api:increase' });
    expect(returns).not.toHaveBeenCalled();
    expect(w.transfers[0].status).toBe('settled');
  });

  it('processes a provider return on the ACH batch', async () => {
    configure();
    const w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query);
    await seed(w);
    vi.spyOn(ACHEngine, 'getBatch').mockResolvedValue({ batch_id: 'B1', status: 'accepted' });
    const returns = vi.spyOn(ACHEngine, 'processReturns').mockResolvedValue({});
    fetchMock.mockResolvedValueOnce(respond(200, increaseTransfer({ status: 'returned', return: { raw_return_reason_code: 'R03', return_reason_code: 'no_account' } })));
    const r = await OdfiApiConnectorEngine.sync();
    expect(r.checked).toBe(1);
    expect(r.updated[0]).toMatchObject({ status: 'returned', returnCode: 'R03', returnReason: 'no_account' });
    expect(returns).toHaveBeenCalledWith('B1', [expect.objectContaining({ entrySequence: 1, returnCode: 'R03', returnAmountCents: 100 })], { returnFileRef: 'odfi_api:increase:ach_transfer_1' });
  });

  it('ignores webhooks for transfers it did not originate', async () => {
    configure();
    const w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query);
    const body = JSON.stringify({ category: 'ach_transfer.updated', associated_object_type: 'ach_transfer', associated_object_id: 'ach_transfer_other' });
    const r = await OdfiApiConnectorEngine.handleWebhook('increase', body, signIncrease('whsec_test', body));
    expect(r).toEqual({ received: true, provider: 'increase', updated: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('status reports the funded balance and flips unready when the account is unreadable', async () => {
    configure();
    const w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query);
    fetchMock.mockResolvedValueOnce(respond(200, { available_balance: 12345, current_balance: 12345 }));
    let s = await OdfiApiConnectorEngine.status();
    expect(s.ready).toBe(true);
    expect(s.balance).toMatchObject({ provider: 'increase', accountId: 'account_abc', availableCents: 12345 });
    fetchMock.mockResolvedValueOnce(respond(404, { title: 'Account not found' }));
    s = await OdfiApiConnectorEngine.status();
    expect(s.ready).toBe(false);
    expect(s.issues.join(' ')).toMatch(/Account not found/);
    expect(new OdfiApiError('x', 'Y').name).toBe('OdfiApiError');
  });
});

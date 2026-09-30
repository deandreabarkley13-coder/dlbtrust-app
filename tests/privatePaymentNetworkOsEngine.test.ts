import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

process.env.DAPP_RPC_URL = process.env.DAPP_RPC_URL || 'http://127.0.0.1:8545';
process.env.DAPP_USDC_ADDRESS = process.env.DAPP_USDC_ADDRESS || '0x2222222222222222222222222222222222222222';
process.env.NACHA_ODFI_ROUTING = process.env.NACHA_ODFI_ROUTING || '091017138';

const pool = require('../server/integrations/bonds/pgPool');
const { PrivatePaymentNetworkOsEngine } = require('../server/integrations/os/privatePaymentNetworkOsEngine');
const { EnterpriseNetworkOsEngine } = require('../server/integrations/os/enterpriseNetworkOsEngine');
const { PaymentProcessorOsEngine } = require('../server/integrations/os/paymentProcessorOsEngine');
const { EngineWiringReadiness } = require('../server/integrations/os/engineWiringReadiness');
const { PaymentGatewayServerEngine } = require('../server/integrations/payments/paymentGatewayServerEngine');
const { CashEngine } = require('../server/integrations/cash/cashEngine');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const { TrustAccountStructure } = require('../server/integrations/fineract/trustAccountStructure');
const OS = require('../server/integrations/os/osEngine');
const osRouter = require('../server/routes/os');
const { MftGatewayClient } = require('../server/integrations/edi/mftGatewayClient');
const { OpenAchFileRelay } = require('../server/integrations/openach/openachFileRelay');
const PaymentCrypto = require('../server/integrations/paymentHub/paymentCrypto');

const ENV_KEYS = [
  'GCP_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'DATABASE_URL', 'APP_URL', 'DEPLOY_URL', 'DOMAIN',
  'PRIVATE_PAYMENT_NETWORK_LIVE', 'PRIVATE_PAYMENT_NETWORK_REQUIRE_APPROVAL_REF', 'PRIVATE_PAYMENT_NETWORK_REQUIRE_SCREENING_REF',
  'PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT', 'PRIVATE_PAYMENT_NETWORK_DEFAULT_PROCESSOR', 'PRIVATE_PAYMENT_NETWORK_MAX_TRANSFER_CENTS',
  'PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET', 'ENTERPRISE_NETWORK_LIVE', 'ENTERPRISE_NETWORK_WEBHOOK_SECRET',
  'PAYMENT_PROCESSOR_LIVE', 'PAYMENT_PROCESSOR_REQUIRE_APPROVAL_REF', 'PAYMENT_PROCESSOR_REQUIRE_SCREENING_REF', 'PAYMENT_DATA_ENCRYPTION_KEY',
  'PRIVATE_PAYMENT_NETWORK_MFT_LIVE', 'MFTGATEWAY_API_TOKEN_ID', 'MFTGATEWAY_API_TOKEN_SECRET', 'MFTGATEWAY_STATION_AS2_ID', 'MFTGATEWAY_PARTNER_AS2_ID',
  'EDI_820_SENDER_ID', 'EDI_820_RECEIVER_ID', 'AS2_LOCAL_AS2_ID', 'OPENACH_ACH_FILES_BUCKET',
  'FINERACT_URL', 'FINERACT_TENANT_ID', 'CANONICAL_FUNDING_LIVE', 'CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID', 'CANONICAL_FUNDING_PAYMENT_TYPE_ID', 'PRIVATE_PAYMENT_NETWORK_CORE_BANKING',
];

const FINERACT_URL = 'https://dlbtrust-fineract-514695212719.us-east1.run.app/fineract-provider/api/v1';

function savingsAccount(id: string | number, overrides: Record<string, any> = {}) {
  return {
    id: Number(id), accountNo: String(id).padStart(9, '0'), clientName: 'DeAndrea Lavar Barkley Irrevocable Trust', savingsProductName: 'Trust Account of Record (USD)',
    status: { active: true }, subStatus: { block: false, blockDebit: false },
    summary: { accountBalance: 7709589.04, availableBalance: 7709589.04 },
    ...overrides,
  };
}

/** Fineract core-banking account of record behind the ledger: FINERACT_URL + CANONICAL_FUNDING_LIVE, default savings account 2. */
function coreBankingLive(accounts: Record<string, any> = { '2': savingsAccount(2) }) {
  process.env.FINERACT_URL = FINERACT_URL;
  process.env.CANONICAL_FUNDING_LIVE = 'true';
  process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID = '2';
  const balance = vi.spyOn(FineractClient, 'getAccountBalance').mockImplementation(async (id: any) => {
    const a = accounts[String(id)];
    if (!a) throw new Error(`Fineract savings account ${id} not found`);
    return a;
  });
  const withdraw = vi.spyOn(FineractClient, 'withdrawSavings').mockResolvedValue({ resourceId: 901 });
  const deposit = vi.spyOn(FineractClient, 'depositSavings').mockResolvedValue({ resourceId: 902 });
  return { balance, withdraw, deposit };
}
const saved: Record<string, string | undefined> = {};

function upstreamLive(processor = 'payment_hub') {
  return {
    config: { ...PaymentProcessorOsEngine.getConfig(), live: true, requireApproval: true, requireScreening: true },
    sources: [{ id: processor, liveFlag: 'PAYMENT_HUB_LIVE', mode: 'live', configured: true, realValueCapable: true, reason: null }],
    realValueCapable: [processor],
    anyRealValueCapable: true,
  };
}

function upstreamShadow() {
  return {
    config: { ...PaymentProcessorOsEngine.getConfig(), live: false },
    sources: [{ id: 'payment_hub', liveFlag: 'PAYMENT_HUB_LIVE', mode: 'shadow', configured: true, realValueCapable: false, reason: 'PAYMENT_PROCESSOR_LIVE=false' }],
    realValueCapable: [],
    anyRealValueCapable: false,
  };
}

/** Bring the private network to live: its own flag, the encryption key, a live registry and a live processor engine. */
function networkLive(processor = 'payment_hub') {
  process.env.PRIVATE_PAYMENT_NETWORK_LIVE = 'true';
  process.env.PAYMENT_PROCESSOR_LIVE = 'true';
  process.env.ENTERPRISE_NETWORK_LIVE = 'true';
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'ab'.repeat(32);
  vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamLive(processor));
  return coreBankingLive();
}

function account(id: string, overrides: Record<string, any> = {}) {
  return { account_id: id, name: id, account_type: 'operating', status: 'active', balance_cents: 1000000, currency: 'USD', ...overrides };
}

function stubLedger(accounts: Record<string, any> = { 'CA-TRUST': account('CA-TRUST'), 'CA-RESERVE': account('CA-RESERVE') }) {
  return vi.spyOn(CashEngine, 'getAccount').mockImplementation(async (id: string) => accounts[id] || null);
}

function achMethod(overrides: Record<string, any> = {}) {
  return { method_id: 'PM-ACH-1', type: 'ach', processor: 'payment_hub', member_id: 'vendor@acme.test', last4: '6789', status: 'active', ...overrides };
}

function txRow(overrides: Record<string, any> = {}) {
  return {
    transaction_id: 'PPN-1', type: 'payout', source_account_id: 'CA-TRUST', destination_account_id: null, method_id: 'PM-ACH-1', participant_id: 'ENP-1',
    processor: 'payment_hub', route_policy_id: null, amount_cents: 250000, currency: 'USD', status: 'submitted', real_value: false, reference: null, memo: null,
    destination: {}, metadata: { methodType: 'ach' }, requested_by: 'maker@dlbtrust.com', approved_by: null, approval_ref: null, screening_ref: null,
    movement_id: null, gateway_tx_id: null, processor_tx_id: null, route: null, result: null, error_message: null, created_at: new Date(), approved_at: null, cleared_at: null, settled_at: null,
    ...overrides,
  };
}

/** Cloud SQL stub for private_payment_network_transactions; every requested table exists unless listed in `missing`. */
function stubCloudSql(rows: Record<string, any> = {}, missing: string[] = []) {
  return vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (/current_database\(\)/i.test(text)) return { rows: [{ db: 'dlbtrust', version: 'PostgreSQL 16' }] } as any;
    if (/information_schema\.tables/i.test(text)) return { rows: (params[0] || []).filter((n: string) => !missing.includes(n)).map((table_name: string) => ({ table_name })) } as any;
    if (/SELECT \* FROM private_payment_network_transactions WHERE transaction_id/i.test(text)) return { rows: rows[params[0]] ? [rows[params[0]]] : [] } as any;
    if (/SELECT \* FROM private_payment_network_transactions WHERE gateway_tx_id/i.test(text)) return { rows: Object.values(rows).filter((r: any) => r.gateway_tx_id === params[0] || r.processor_tx_id === params[0]) } as any;
    if (/INSERT INTO private_payment_network_transactions/i.test(text)) {
      const [transaction_id, type, source_account_id, destination_account_id, method_id, participant_id, processor, route_policy_id, amount_cents, currency, real_value, reference, memo, destination, metadata, requested_by, approval_ref, screening_ref] = params;
      rows[transaction_id] = txRow({ transaction_id, type, source_account_id, destination_account_id, method_id, participant_id, processor, route_policy_id, amount_cents, currency, real_value, reference, memo, destination: JSON.parse(destination), metadata: JSON.parse(metadata), requested_by, approval_ref, screening_ref });
      return { rows: [rows[transaction_id]] } as any;
    }
    const r = rows[params[0]];
    if (r && /UPDATE private_payment_network_transactions SET status = 'approved'/i.test(text)) Object.assign(r, { status: 'approved', approved_by: params[1], approval_ref: params[2], screening_ref: params[3], real_value: params[4] });
    if (r && /UPDATE private_payment_network_transactions SET status = 'shadow'/i.test(text)) Object.assign(r, { status: 'shadow', route: 'shadow', result: JSON.parse(params[1]) });
    if (r && /UPDATE private_payment_network_transactions SET status = 'failed'/i.test(text)) Object.assign(r, { status: 'failed', error_message: params[1] });
    if (r && /UPDATE private_payment_network_transactions SET status = \$2, route = \$3/i.test(text)) Object.assign(r, { status: params[1], route: params[2], movement_id: params[3], gateway_tx_id: params[4], processor_tx_id: params[5], result: JSON.parse(params[6]) });
    if (r && /UPDATE private_payment_network_transactions SET status = \$2, processor_tx_id/i.test(text)) Object.assign(r, { status: params[1], processor_tx_id: r.processor_tx_id || params[2] });
    return { rows: [] } as any;
  });
}

function responseStub() {
  const response: any = {
    statusCode: 200,
    status: vi.fn(function status(code: number) { response.statusCode = code; return response; }),
    json: vi.fn(function json(body: any) { response.body = body; return response; }),
  };
  return response;
}

function routeHandler(method: string, path: string) {
  const layer = osRouter.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.GCP_PROJECT = 'dlb-treasury-management';
  process.env.GOOGLE_CLOUD_PROJECT = 'dlb-treasury-management';
  process.env.DATABASE_URL = 'postgres://app:pw@10.0.0.5:5432/dlbtrust';
  process.env.APP_URL = 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app';
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('private-payment-network OS engine registration and routing', () => {
  it('is registered in the OS engine map, route map and readiness audit with its tables', () => {
    expect(OS.engines['private-payment-network']).toBe(OS.PrivatePaymentNetworkPlatformEngine);
    expect(OS.PrivatePaymentNetworkPlatformEngine.platformEngine).toBe('private-payment-network');
    expect(EngineWiringReadiness.ENGINE_KEYS).toEqual(expect.arrayContaining(['enterprise-network', 'private-payment-network']));
    expect(EngineWiringReadiness.ENGINE_KEYS).toHaveLength(20);
    expect(EngineWiringReadiness.ENGINE_TITLES['private-payment-network']).toMatch(/Private Electronic Payment Network/);
    expect(PrivatePaymentNetworkOsEngine.TABLES[0]).toBe('private_payment_network_transactions');
    expect(EngineWiringReadiness.TABLES['private-payment-network']).toEqual(PrivatePaymentNetworkOsEngine.TABLES);
    const paths = osRouter.stack.filter((l: any) => l.route).map((l: any) => l.route.path);
    expect(paths).toEqual(expect.arrayContaining(['/:engine/status', '/:engine/process', '/private-payment-network/webhook']));
  });

  it('creates private_payment_network_transactions (and the enterprise registry) through ensureTables()', async () => {
    const query = stubCloudSql();
    await OS.PrivatePaymentNetworkPlatformEngine.ensureTables();
    const ddl = query.mock.calls.map(([sql]: any[]) => String(sql)).filter((s) => /CREATE TABLE IF NOT EXISTS/i.test(s));
    for (const t of ['private_payment_network_transactions', 'enterprise_network_participants', 'enterprise_network_exposure_limits', 'os_events']) {
      expect(ddl.some((s) => s.includes(t)), t).toBe(true);
    }
  });

  it('serves /api/os/private-payment-network/status in shadow mode by default', async () => {
    stubCloudSql();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const res = responseStub();
    await routeHandler('get', '/:engine/status')({ params: { engine: 'private-payment-network' }, query: {}, osEngine: OS.PrivatePaymentNetworkPlatformEngine }, res);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ engine: 'private-payment-network', mode: 'shadow', live: false, realValueCapable: false, gate: 'PRIVATE_PAYMENT_NETWORK_LIVE=false' });
    expect(res.body.data.integrations).toMatchObject({ privatePaymentNetworkOs: true, gateway: true, paymentProcessorOs: true, enterpriseNetwork: true, cashLedger: true });
  });

  it('rejects direct ledger transfers and gateway money movement on /process with 409 and audits them', async () => {
    const query = stubCloudSql();
    const handler = routeHandler('post', '/:engine/process');
    const actions = ['sale', 'payout', 'transfer', 'bookTransfer', 'settle', 'dispatch'];
    for (const action of actions) {
      const res = responseStub();
      await handler({ params: { engine: 'private-payment-network' }, body: { action, amount: 100 }, osEngine: OS.PrivatePaymentNetworkPlatformEngine, user: { username: 'ops-admin' } }, res);
      expect(res.statusCode, action).toBe(409);
      expect(res.body.error).toMatch(/maker-checker/);
    }
    const audits = query.mock.calls.filter(([sql, params]: any[]) => /INSERT INTO os_events/i.test(String(sql)) && params[1] === 'private-payment-network');
    expect(audits).toHaveLength(actions.length);
    expect(audits[0][1][3]).toBe('rejected');
  });
});

describe('private-payment-network fail-closed gates', () => {
  it('submits a payout bound to an enterprise participant, a ledger account and a tokenized payout instrument', async () => {
    const query = stubCloudSql();
    stubLedger();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    const admit = vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({ participant: { participantId: 'ENP-1' }, exposure: {} });
    vi.spyOn(EnterpriseNetworkOsEngine, 'resolveRoute').mockResolvedValue({ policyId: 'ENR-1', processor: 'payment_hub', rail: 'ach' });
    const tx = await PrivatePaymentNetworkOsEngine.submit({ type: 'payout', sourceAccountId: 'CA-TRUST', methodId: 'PM-ACH-1', participantId: 'ENP-1', amountCents: 250000, requestedBy: 'maker@dlbtrust.com' });
    expect(tx).toMatchObject({ status: 'submitted', type: 'payout', processor: 'payment_hub', routePolicyId: 'ENR-1', realValue: false, participantId: 'ENP-1' });
    expect(admit).toHaveBeenCalledWith({ participantId: 'ENP-1', amountCents: 250000, realValue: false });
    expect(query.mock.calls.some(([sql]: any[]) => /INSERT INTO private_payment_network_transactions/i.test(String(sql)))).toBe(true);
  });

  it('refuses payouts without a participant, to disabled instruments, over the cap, or from unknown accounts', async () => {
    stubCloudSql();
    stubLedger();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const getMethod = vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    const base = { type: 'payout', sourceAccountId: 'CA-TRUST', methodId: 'PM-ACH-1', amountCents: 250000, requestedBy: 'maker@dlbtrust.com' };
    await expect(PrivatePaymentNetworkOsEngine.submit(base)).rejects.toMatchObject({ status: 409, message: /participantId .* is required/ });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, sourceAccountId: 'CA-404', participantId: 'ENP-1' })).rejects.toMatchObject({ status: 404 });
    getMethod.mockResolvedValueOnce(achMethod({ status: 'disabled' }));
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-1' })).rejects.toMatchObject({ status: 409, message: /is disabled/ });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-1', processor: 'internal_ledger' })).rejects.toMatchObject({ status: 409, message: /cannot carry an external payout/ });
    process.env.PRIVATE_PAYMENT_NETWORK_MAX_TRANSFER_CENTS = '100000';
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-1' })).rejects.toMatchObject({ status: 409, message: /exceeds PRIVATE_PAYMENT_NETWORK_MAX_TRANSFER_CENTS/ });
  });

  it('refuses a participant that is suspended or would breach its exposure limit (real enterprise-network admission)', async () => {
    stubLedger();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    const participants: Record<string, any> = { 'ENP-1': { participant_id: 'ENP-1', status: 'active', endpoint: {} }, 'ENP-2': { participant_id: 'ENP-2', status: 'suspended', endpoint: {} } };
    vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
      const text = String(sql);
      if (/FROM enterprise_network_participants WHERE participant_id/i.test(text)) return { rows: participants[params[0]] ? [participants[params[0]]] : [] } as any;
      if (/FROM enterprise_network_exposure_limits/i.test(text)) return { rows: [{ participant_id: params[0], limit_cents: 300000, currency: 'USD', status: 'active' }] } as any;
      if (/SUM\(amount_cents\)/i.test(text)) return { rows: [{ cents: 100000 }] } as any;
      return { rows: [] } as any;
    });
    const base = { type: 'payout', sourceAccountId: 'CA-TRUST', methodId: 'PM-ACH-1', requestedBy: 'maker@dlbtrust.com' };
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-2', amountCents: 1000 })).rejects.toMatchObject({ status: 409, message: /is suspended/ });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-1', amountCents: 250000 })).rejects.toMatchObject({ status: 409, message: /exposure limit exceeded for ENP-1/ });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, participantId: 'ENP-404', amountCents: 1000 })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses self-loopback payout destinations at submit and approve', async () => {
    const rows = { 'PPN-1': txRow({ destination: { partnerAs2Id: 'DLBTRUST-DIRECT' } }) };
    const query = stubCloudSql(rows);
    stubLedger();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({});
    vi.spyOn(EnterpriseNetworkOsEngine, 'resolveRoute').mockResolvedValue(null);
    const base = { type: 'payout', sourceAccountId: 'CA-TRUST', methodId: 'PM-ACH-1', participantId: 'ENP-1', amountCents: 1000, requestedBy: 'maker@dlbtrust.com' };
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, destination: { partnerUrl: 'direct' } })).rejects.toMatchObject({ status: 409, message: /self-loopback partner refused/ });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, destination: { endpoint: 'https://dlbtrust-app-r5oawu76jq-ue.a.run.app/api/os/private-payment-network/process' } })).rejects.toMatchObject({ status: 409 });
    expect(query.mock.calls.some(([sql]: any[]) => /INSERT INTO private_payment_network_transactions/i.test(String(sql)))).toBe(false);
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /self-loopback partner refused: partner DLBTRUST-DIRECT/ });
    expect(rows['PPN-1'].status).toBe('submitted');
  });

  it('enforces maker/checker: the approver must differ from the requester', async () => {
    stubCloudSql({ 'PPN-1': txRow() });
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'maker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /approver must differ from requester/ });
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-404', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 404 });
  });

  it('records shadow approvals without posting to the ledger or calling the gateway while PRIVATE_PAYMENT_NETWORK_LIVE is off', async () => {
    const rows = { 'PPN-1': txRow(), 'PPN-2': txRow({ transaction_id: 'PPN-2', type: 'book_transfer', destination_account_id: 'CA-RESERVE', method_id: null, participant_id: null, processor: 'internal_ledger' }) };
    stubCloudSql(rows);
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamLive());
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    const transfer = vi.spyOn(CashEngine, 'transfer');
    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out).toMatchObject({ status: 'shadow', dispatched: false, note: 'PRIVATE_PAYMENT_NETWORK_LIVE=false', realValue: false });
    const book = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-2', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-2', screeningRef: 'SCR-2' });
    expect(book).toMatchObject({ status: 'shadow', dispatched: false });
    expect(sale).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /is shadow, expected submitted/ });
  });

  it('stays shadow when the network flag is on but the processor is not real-value capable', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    process.env.PRIVATE_PAYMENT_NETWORK_LIVE = 'true';
    process.env.ENTERPRISE_NETWORK_LIVE = 'true';
    process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'ab'.repeat(32);
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out.status).toBe('shadow');
    expect(out.note).toMatch(/PAYMENT_PROCESSOR_LIVE=false/);
    expect(sale).not.toHaveBeenCalled();
  });

  it('never dispatches a real-value approval without both checker references', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    networkLive();
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com' })).rejects.toMatchObject({ status: 409, message: /approvalRef/ });
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1' })).rejects.toMatchObject({ status: 409, message: /screeningRef/ });
    expect(sale).not.toHaveBeenCalled();
    expect(rows['PPN-1'].status).toBe('submitted');
  });

  it('dispatches an approved real-value payout through PaymentGatewayServerEngine.sale with the checker references', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    networkLive();
    stubLedger();
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    const admit = vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({});
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale').mockResolvedValue({ gatewayTxId: 'GW-TX-1', processorTxId: 'PH-1', status: 'processing' });
    const transfer = vi.spyOn(CashEngine, 'transfer');
    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out).toMatchObject({ status: 'cleared', dispatched: true, gatewayTxId: 'GW-TX-1', route: 'FineractClient.withdrawSavings → PaymentGatewayServerEngine.sale', realValue: true });
    expect(out.result.coreBanking).toMatchObject({ system: 'fineract', savingsAccountId: '2', withdrawalTransactionId: '901', amount: 2500 });
    expect(admit).toHaveBeenCalledWith({ participantId: 'ENP-1', amountCents: 0, realValue: true });
    expect(sale).toHaveBeenCalledTimes(1);
    expect(sale.mock.calls[0][0]).toMatchObject({
      amount: 2500, currency: 'USD', methodId: 'PM-ACH-1', processor: 'payment_hub', direction: 'outbound', initiatedBy: 'checker@dlbtrust.com',
      source: { ledgerAccountId: 'CA-TRUST' },
      metadata: expect.objectContaining({ network: 'private-payment-network', participantId: 'ENP-1', approvalRef: 'APR-1', screeningRef: 'SCR-1', approvedBy: 'checker@dlbtrust.com' }),
    });
    expect(transfer).not.toHaveBeenCalled();
  });

  it('refuses a real-value approval when the source ledger account cannot cover the amount', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    networkLive();
    stubLedger({ 'CA-TRUST': account('CA-TRUST', { balance_cents: 1000 }) });
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' })).rejects.toMatchObject({ status: 409, message: /insufficient balance/ });
    expect(sale).not.toHaveBeenCalled();
  });

  it('settles an approved real-value book transfer on the trust ledger via CashEngine.transfer', async () => {
    const rows = { 'PPN-2': txRow({ transaction_id: 'PPN-2', type: 'book_transfer', destination_account_id: 'CA-RESERVE', method_id: null, participant_id: null, processor: 'internal_ledger' }) };
    stubCloudSql(rows);
    process.env.PRIVATE_PAYMENT_NETWORK_LIVE = 'true';
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    stubLedger();
    const transfer = vi.spyOn(CashEngine, 'transfer').mockResolvedValue({ movement_id: 'MOV-1' });
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-2', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out).toMatchObject({ status: 'settled', dispatched: true, movementId: 'MOV-1', route: 'CashEngine.transfer' });
    expect(transfer).toHaveBeenCalledWith(expect.objectContaining({ fromAccountId: 'CA-TRUST', toAccountId: 'CA-RESERVE', amountCents: 250000, referenceId: 'PPN-2', referenceType: 'private_payment_network', initiatedBy: 'checker@dlbtrust.com' }));
    expect(sale).not.toHaveBeenCalled();
  });

  it('marks the transaction failed when the dispatch throws', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    networkLive();
    stubLedger();
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({});
    vi.spyOn(PaymentGatewayServerEngine, 'sale').mockRejectedValue(new Error('processor declined'));
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' })).rejects.toMatchObject({ status: 502, message: /dispatch failed: processor declined/ });
    expect(rows['PPN-1'].status).toBe('failed');
  });
});

describe('private-payment-network Fineract core-banking funding source', () => {
  it('lists the Fineract account of record as the funding source and keeps every payout processor shadow until it is live', async () => {
    process.env.PRIVATE_PAYMENT_NETWORK_LIVE = 'true';
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    process.env.ENTERPRISE_NETWORK_LIVE = 'true';
    process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'ab'.repeat(32);
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamLive());
    let inv = await PrivatePaymentNetworkOsEngine.processors();
    expect(inv.fundingSource).toMatchObject({ id: 'fineract_core_banking', system: 'fineract', mode: 'shadow', required: true, configured: false });
    expect(inv.coreBankingGate).toMatch(/FINERACT_URL not set/);
    expect(inv.sources.find((s: any) => s.id === 'payment_hub')).toMatchObject({ realValueCapable: false, reason: expect.stringMatching(/core-banking funding source: FINERACT_URL/) });
    expect(inv.realValueCapable).toEqual(['internal_ledger']);

    process.env.FINERACT_URL = FINERACT_URL;
    inv = await PrivatePaymentNetworkOsEngine.processors();
    expect(inv.coreBankingGate).toMatch(/CANONICAL_FUNDING_LIVE=false/);

    process.env.CANONICAL_FUNDING_LIVE = 'true';
    inv = await PrivatePaymentNetworkOsEngine.processors();
    expect(inv.coreBankingGate).toBeNull();
    expect(inv.fundingSource).toMatchObject({ mode: 'live', live: true });
    expect(inv.realValueCapable).toEqual(['internal_ledger', 'payment_hub']);

    process.env.PRIVATE_PAYMENT_NETWORK_CORE_BANKING = 'false';
    delete process.env.CANONICAL_FUNDING_LIVE;
    inv = await PrivatePaymentNetworkOsEngine.processors();
    expect(inv.fundingSource.mode).toBe('disabled');
    expect(inv.realValueCapable).toEqual(['internal_ledger', 'payment_hub']);
  });

  it('refuses a real-value payout when the ledger account has no Fineract account, or that account is inactive, debit-blocked or short', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    const fx = networkLive();
    stubLedger();
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({});
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');
    const approve = () => PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });

    delete process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID;
    await expect(approve()).rejects.toMatchObject({ status: 409, message: /not linked to a Fineract core-banking account/ });
    process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID = '2';

    fx.balance.mockResolvedValueOnce(savingsAccount(2, { status: { active: false } }));
    await expect(approve()).rejects.toMatchObject({ status: 409, message: /not active/ });
    fx.balance.mockResolvedValueOnce(savingsAccount(2, { subStatus: { blockDebit: true } }));
    await expect(approve()).rejects.toMatchObject({ status: 409, message: /debit-blocked/ });
    fx.balance.mockResolvedValueOnce(savingsAccount(2, { summary: { accountBalance: 5000, availableBalance: 10 } }));
    await expect(approve()).rejects.toMatchObject({ status: 409, message: /insufficient core-banking balance in Fineract account 2: 1000 < 250000/ });
    expect(sale).not.toHaveBeenCalled();
    expect(fx.withdraw).not.toHaveBeenCalled();
  });

  it('uses the ledger account\'s own linked_fineract_account_id over the default and withdraws before the processor is called', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    const fx = coreBankingLive({ '2': savingsAccount(2), '7': savingsAccount(7, { summary: { accountBalance: 3000, availableBalance: 3000 } }) });
    process.env.PRIVATE_PAYMENT_NETWORK_LIVE = 'true';
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    process.env.ENTERPRISE_NETWORK_LIVE = 'true';
    process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'ab'.repeat(32);
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamLive());
    stubLedger({ 'CA-TRUST': account('CA-TRUST', { linked_fineract_account_id: '7' }) });
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({});
    const order: string[] = [];
    fx.withdraw.mockImplementation(async () => { order.push('withdraw'); return { resourceId: 77 }; });
    vi.spyOn(PaymentGatewayServerEngine, 'sale').mockImplementation(async () => { order.push('sale'); return { gatewayTxId: 'GW-TX-1', processorTxId: 'PH-1', status: 'processing' }; });
    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(order).toEqual(['withdraw', 'sale']);
    expect(fx.withdraw).toHaveBeenCalledWith(expect.objectContaining({ accountId: '7', amount: 2500, paymentTypeId: 1 }));
    expect(out.result.coreBanking).toMatchObject({ savingsAccountId: '7', withdrawalTransactionId: '77' });
    expect(fx.deposit).not.toHaveBeenCalled();
  });

  it('falls back to the Fineract account of record recorded by the trust account structure when no account is linked or pinned', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    const fx = coreBankingLive({ '2': savingsAccount(2) });
    process.env.PRIVATE_PAYMENT_NETWORK_LIVE = 'true';
    process.env.PAYMENT_PROCESSOR_LIVE = 'true';
    process.env.ENTERPRISE_NETWORK_LIVE = 'true';
    process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'ab'.repeat(32);
    delete process.env.CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID;
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamLive());
    stubLedger();
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({});
    const recorded = vi.spyOn(TrustAccountStructure, 'recordedAccountId').mockResolvedValue('2');
    vi.spyOn(PaymentGatewayServerEngine, 'sale').mockResolvedValue({ gatewayTxId: 'GW-TX-1', processorTxId: 'PH-1', status: 'processing' });
    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(recorded).toHaveBeenCalledWith('account-of-record');
    expect(fx.withdraw).toHaveBeenCalledWith(expect.objectContaining({ accountId: '2' }));
    expect(out.result.coreBanking).toMatchObject({ savingsAccountId: '2' });
  });

  it('redeposits the withdrawal when the processor rejects the payout and when a cleared payout is returned', async () => {
    const rows = { 'PPN-1': txRow() };
    stubCloudSql(rows);
    const fx = networkLive();
    stubLedger();
    vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({});
    vi.spyOn(PaymentGatewayServerEngine, 'sale').mockRejectedValue(new Error('processor declined'));
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' })).rejects.toMatchObject({ status: 502 });
    expect(fx.withdraw).toHaveBeenCalledTimes(1);
    expect(fx.deposit).toHaveBeenCalledWith(expect.objectContaining({ accountId: '2', amount: 2500, note: expect.stringMatching(/processor rejected/) }));

    fx.deposit.mockClear();
    const cleared = {
      'PPN-5': txRow({ transaction_id: 'PPN-5', status: 'cleared', gateway_tx_id: 'GW-TX-5', real_value: true, result: { coreBanking: { system: 'fineract', savingsAccountId: '2', withdrawalTransactionId: '901', amount: 2500 } } }),
    };
    stubCloudSql(cleared);
    vi.spyOn(PaymentGatewayServerEngine, 'reconcileWebhook').mockResolvedValue({ ok: true });
    const returned = await PrivatePaymentNetworkOsEngine.reconcile({ transactionId: 'PPN-5', status: 'returned' });
    expect(returned.status).toBe('returned');
    expect(returned.coreBanking).toMatchObject({ savingsAccountId: '2', reversal: { depositTransactionId: '902', reason: 'payout returned' } });
    expect(fx.deposit).toHaveBeenCalledWith(expect.objectContaining({ accountId: '2', amount: 2500 }));
    fx.deposit.mockClear();
    const settled = await PrivatePaymentNetworkOsEngine.reconcile({ transactionId: 'PPN-5', status: 'settled' });
    expect(fx.deposit).not.toHaveBeenCalled();
    expect(settled.status).toBe('returned');
  });

  it('mirrors a book transfer between ledger accounts linked to different Fineract accounts as withdrawal + deposit', async () => {
    const rows = { 'PPN-2': txRow({ transaction_id: 'PPN-2', type: 'book_transfer', destination_account_id: 'CA-RESERVE', method_id: null, participant_id: null, processor: 'internal_ledger' }) };
    stubCloudSql(rows);
    process.env.PRIVATE_PAYMENT_NETWORK_LIVE = 'true';
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const fx = coreBankingLive({ '2': savingsAccount(2), '1': savingsAccount(1, { summary: { accountBalance: 0, availableBalance: 0 } }) });
    stubLedger({ 'CA-TRUST': account('CA-TRUST', { linked_fineract_account_id: '2' }), 'CA-RESERVE': account('CA-RESERVE', { linked_fineract_account_id: '1' }) });
    vi.spyOn(CashEngine, 'transfer').mockResolvedValue({ movement_id: 'MOV-1' });
    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-2', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out.status).toBe('settled');
    expect(fx.withdraw).toHaveBeenCalledWith(expect.objectContaining({ accountId: '2', amount: 2500 }));
    expect(fx.deposit).toHaveBeenCalledWith(expect.objectContaining({ accountId: '1', amount: 2500 }));
    expect(out.result.coreBanking).toMatchObject({ mirrored: true, savingsAccountId: '2', toSavingsAccountId: '1', withdrawalTransactionId: '901', depositTransactionId: '902' });
  });
});

describe('private-payment-network webhook and reconciliation', () => {
  it('reconciles a cleared payout to settled and a returned payout to returned', async () => {
    const rows = { 'PPN-1': txRow({ status: 'cleared', gateway_tx_id: 'GW-TX-1', real_value: true }), 'PPN-3': txRow({ transaction_id: 'PPN-3', status: 'cleared', gateway_tx_id: 'GW-TX-3', real_value: true }) };
    stubCloudSql(rows);
    const reconcile = vi.spyOn(PaymentGatewayServerEngine, 'reconcileWebhook').mockResolvedValue({ ok: true });
    const settled = await PrivatePaymentNetworkOsEngine.reconcile({ transactionId: 'PPN-1', status: 'succeeded' });
    expect(settled).toMatchObject({ previousStatus: 'cleared', status: 'settled', gatewayTxId: 'GW-TX-1' });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ gatewayTxId: 'GW-TX-1', status: 'settled' }));
    const returned = await PrivatePaymentNetworkOsEngine.reconcile({ gatewayTxId: 'GW-TX-3', status: 'returned' });
    expect(returned.status).toBe('returned');
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({ gatewayTxId: 'GW-TX-3', status: 'failed' }));
    await expect(PrivatePaymentNetworkOsEngine.reconcile({ transactionId: 'PPN-404', status: 'settled' })).rejects.toMatchObject({ status: 404 });
  });

  it('verifies the processor callback HMAC on /api/os/private-payment-network/webhook before reconciling', async () => {
    const rows = { 'PPN-1': txRow({ status: 'cleared', gateway_tx_id: 'GW-TX-1', real_value: true }) };
    stubCloudSql(rows);
    process.env.PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET = 'whsec_ppn';
    const reconcile = vi.spyOn(PaymentGatewayServerEngine, 'reconcileWebhook').mockResolvedValue({ gatewayTxId: 'GW-TX-1', status: 'settled' });
    const body = JSON.stringify({ gatewayTxId: 'GW-TX-1', processorTxId: 'PH-1', status: 'settled' });
    const good = crypto.createHmac('sha256', 'whsec_ppn').update(body).digest('hex');

    await expect(PrivatePaymentNetworkOsEngine.webhook({ rawBody: body, signature: 'sha256=deadbeef', payload: JSON.parse(body) })).rejects.toMatchObject({ status: 401 });
    expect(reconcile).not.toHaveBeenCalled();

    const res = responseStub();
    await routeHandler('post', '/private-payment-network/webhook')({ body: JSON.parse(body), rawBody: Buffer.from(body), get: (h: string) => (h === 'x-network-signature' ? `sha256=${good}` : undefined) }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.result).toMatchObject({ transactionId: 'PPN-1', status: 'settled' });
    expect(rows['PPN-1'].status).toBe('settled');

    delete process.env.PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET;
    expect(PrivatePaymentNetworkOsEngine.verifyWebhookSignature(body, good)).toMatchObject({ ok: false, reason: /PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET not set/ });
  });
});

describe('private-payment-network readiness on dlb-treasury-management', () => {
  it('reports shadow mode and the exact blockers while live flags and secrets are absent', async () => {
    stubCloudSql({}, ['private_payment_network_transactions']);
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const r = await EngineWiringReadiness.engineReadiness('private-payment-network');
    expect(r.ready).toBe(false);
    expect(r.healthy).toBe(true);
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/^PRIVATE_PAYMENT_NETWORK_LIVE is not true/),
      expect.stringMatching(/^PAYMENT_PROCESSOR_LIVE is not true/),
      expect.stringMatching(/^ENTERPRISE_NETWORK_LIVE is not true/),
      expect.stringMatching(/^no real-value payout processor/),
      expect.stringMatching(/^PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET not set/),
      expect.stringMatching(/^PAYMENT_DATA_ENCRYPTION_KEY not set/),
      'Cloud SQL tables missing: private_payment_network_transactions',
    ]));
  });

  it('names relaxed gates as blockers and goes live once every flag, gate and secret is in place', async () => {
    stubCloudSql();
    networkLive();
    process.env.PRIVATE_PAYMENT_NETWORK_WEBHOOK_SECRET = 'whsec_ppn';
    process.env.PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT = 'false';
    const relaxed = await EngineWiringReadiness.engineReadiness('private-payment-network');
    expect(relaxed.blockers).toContain('PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT=false allows payouts outside the enterprise-network registry');
    delete process.env.PRIVATE_PAYMENT_NETWORK_REQUIRE_PARTICIPANT;
    const r = await EngineWiringReadiness.engineReadiness('private-payment-network');
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.mode).toBe('live');
    expect(r.liveFlags).toMatchObject({ PRIVATE_PAYMENT_NETWORK_LIVE: true, PAYMENT_PROCESSOR_LIVE: true, ENTERPRISE_NETWORK_LIVE: true, REQUIRE_APPROVAL_REF: true, REQUIRE_SCREENING_REF: true, REQUIRE_PARTICIPANT: true, CORE_BANKING_FUNDING_SOURCE: 'fineract', CANONICAL_FUNDING_LIVE: true, CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID: '2' });
    expect(r.liveFlags.REAL_VALUE_PROCESSORS).toEqual(['internal_ledger', 'payment_hub']);
    expect(r.modules.fundingSource).toMatchObject({ id: 'fineract_core_banking', mode: 'live' });
    delete process.env.CANONICAL_FUNDING_LIVE;
    const shadow = await EngineWiringReadiness.engineReadiness('private-payment-network');
    expect(shadow.blockers).toContainEqual(expect.stringMatching(/core-banking funding source \(Fineract\): CANONICAL_FUNDING_LIVE=false/));
  });
});

describe('private-payment-network MFT Gateway / AS2 station file drop (mft_as2)', () => {
  const as2Meta = { methodType: 'ach', as2: { stationAs2Id: 'DLBTRUST-AS2', partnerAs2Id: 'SUNRISE-AS2', partnerSource: 'participant' } };
  const mftRow = (overrides: Record<string, any> = {}) => txRow({ processor: 'mft_as2', metadata: as2Meta, ...overrides });

  function mftLive() {
    networkLive();
    process.env.PRIVATE_PAYMENT_NETWORK_MFT_LIVE = 'true';
    process.env.MFTGATEWAY_API_TOKEN_ID = 'tok-id';
    process.env.MFTGATEWAY_API_TOKEN_SECRET = 'tok-secret';
    process.env.MFTGATEWAY_STATION_AS2_ID = 'DLBTRUST-AS2';
    process.env.OPENACH_ACH_FILES_BUCKET = 'dlb-treasury-management-openach-ach-files';
  }

  function tokenizedAch() {
    const encrypted_payload = PaymentCrypto.encrypt(JSON.stringify({ accountNumber: '000123456789', routingNumber: '121145307' }));
    return vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod({ processor: 'generic', encrypted_payload, billing_details: { name: 'Acme Vendor LLC' } }));
  }

  it('lists mft_as2 as a shadow payout processor until PRIVATE_PAYMENT_NETWORK_MFT_LIVE and the MFT Gateway token pair are set', async () => {
    networkLive();
    let inv = await PrivatePaymentNetworkOsEngine.processors();
    let mft = inv.sources.find((s: any) => s.id === 'mft_as2');
    expect(mft).toMatchObject({ kind: 'payout', mode: 'shadow', realValueCapable: false, stationAs2Id: 'DLBTRUST-AS2' });
    expect(mft.reason).toMatch(/PRIVATE_PAYMENT_NETWORK_MFT_LIVE=false/);
    process.env.PRIVATE_PAYMENT_NETWORK_MFT_LIVE = 'true';
    inv = await PrivatePaymentNetworkOsEngine.processors();
    expect(inv.sources.find((s: any) => s.id === 'mft_as2').reason).toMatch(/MFTGATEWAY_API_TOKEN_ID not configured/);
    mftLive();
    inv = await PrivatePaymentNetworkOsEngine.processors();
    mft = inv.sources.find((s: any) => s.id === 'mft_as2');
    expect(mft).toMatchObject({ mode: 'live', realValueCapable: true, reason: null, configured: true });
    expect(inv.realValueCapable).toContain('mft_as2');
  });

  it('submits an ACH payout routed to the participant AS2 partner and refuses non-ACH instruments and our own station', async () => {
    const query = stubCloudSql();
    stubLedger();
    vi.spyOn(PaymentProcessorOsEngine, 'processors').mockResolvedValue(upstreamShadow());
    const getMethod = vi.spyOn(PaymentGatewayServerEngine, 'getMethod').mockResolvedValue(achMethod());
    vi.spyOn(EnterpriseNetworkOsEngine, 'resolveRoute').mockResolvedValue({ policyId: 'ENR-9', processor: 'mft_as2', rail: 'ach' });
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({ participant: { participantId: 'ENP-1', endpoint: { partnerAs2Id: 'SUNRISE-AS2' } }, exposure: {} });
    const base = { type: 'payout', sourceAccountId: 'CA-TRUST', methodId: 'PM-ACH-1', participantId: 'ENP-1', amountCents: 250000, requestedBy: 'maker@dlbtrust.com' };
    const tx = await PrivatePaymentNetworkOsEngine.submit(base);
    expect(tx).toMatchObject({ processor: 'mft_as2', routePolicyId: 'ENR-9', realValue: false, status: 'submitted' });
    expect(tx.metadata.as2).toEqual({ stationAs2Id: 'DLBTRUST-AS2', partnerAs2Id: 'SUNRISE-AS2', partnerSource: 'participant' });

    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, destination: { partnerAs2Id: 'dlbtrust-as2' } })).rejects.toMatchObject({ status: 409, message: /own AS2 station/ });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, destination: { partnerAs2Id: 'DLBTRUST-DIRECT' } })).rejects.toMatchObject({ status: 409, message: /self-loopback partner refused/ });
    getMethod.mockResolvedValueOnce(achMethod({ type: 'card' }));
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, processor: 'mft_as2' })).rejects.toMatchObject({ status: 409, message: /NACHA credits only/ });
    await expect(PrivatePaymentNetworkOsEngine.submit({ ...base, destination: { secCode: 'WEB' } })).rejects.toMatchObject({ status: 400, message: /secCode/ });
    expect(query.mock.calls.filter(([sql]: any[]) => /INSERT INTO private_payment_network_transactions/i.test(String(sql)))).toHaveLength(1);
  });

  it('records a shadow approval and builds no file while PRIVATE_PAYMENT_NETWORK_MFT_LIVE is off', async () => {
    const rows = { 'PPN-1': mftRow() };
    stubCloudSql(rows);
    networkLive();
    const submit = vi.spyOn(MftGatewayClient, 'submit');
    const archive = vi.spyOn(OpenAchFileRelay, 'archive');
    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out).toMatchObject({ status: 'shadow', dispatched: false, realValue: false });
    expect(out.note).toMatch(/PRIVATE_PAYMENT_NETWORK_MFT_LIVE=false/);
    expect(submit).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it('refuses a stored partner that is our own station at approve, and a real-value approval with no AS2 partner', async () => {
    const rows = { 'PPN-1': mftRow({ metadata: { methodType: 'ach', as2: { partnerAs2Id: 'DLBTRUST-AS2' } } }), 'PPN-2': mftRow({ transaction_id: 'PPN-2', metadata: { methodType: 'ach', as2: { partnerAs2Id: null } } }) };
    stubCloudSql(rows);
    mftLive();
    stubLedger();
    tokenizedAch();
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({ participant: { participantId: 'ENP-1', endpoint: {} } });
    const submit = vi.spyOn(MftGatewayClient, 'submit');
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' })).rejects.toMatchObject({ status: 409, message: /own AS2 station/ });
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-2', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' })).rejects.toMatchObject({ status: 409, message: /no AS2 partner/ });
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-2', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1' })).rejects.toMatchObject({ status: 409, message: /screeningRef/ });
    expect(submit).not.toHaveBeenCalled();
    expect(rows['PPN-1'].status).toBe('submitted');
    expect(rows['PPN-2'].status).toBe('submitted');
  });

  it('drops an approved real-value payout as a NACHA credit through the AS2 station and keeps the account number out of the record', async () => {
    const rows = { 'PPN-1': mftRow() };
    stubCloudSql(rows);
    mftLive();
    stubLedger();
    tokenizedAch();
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({ participant: { participantId: 'ENP-1', endpoint: { partnerAs2Id: 'SUNRISE-AS2' } } });
    const archive = vi.spyOn(OpenAchFileRelay, 'archive').mockResolvedValue('gs://dlb-treasury-management-openach-ach-files/private-network/outbound/PPN-1.ach');
    const submit = vi.spyOn(MftGatewayClient, 'submit').mockResolvedValue({ success: true, transport: 'mftgateway', as2_from: 'DLBTRUST-AS2', as2_to: 'SUNRISE-AS2', message_id: 'MSG-1', status_code: 202, response_body: 'queued', link: null, transmitted_at: '2026-09-27T15:00:00.000Z' });
    const sale = vi.spyOn(PaymentGatewayServerEngine, 'sale');

    const out = await PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(out).toMatchObject({ status: 'cleared', dispatched: true, route: 'MftGatewayClient.submit', processorTxId: 'MSG-1', realValue: true });
    expect(sale).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith('private-network/outbound/PPN-1.ach', expect.any(Buffer));
    expect(submit).toHaveBeenCalledTimes(1);
    const [payload, filename, opts] = submit.mock.calls[0] as any[];
    expect(filename).toBe('PPN-1.ach');
    expect(opts).toMatchObject({ stationAs2Id: 'DLBTRUST-AS2', partnerAs2Id: 'SUNRISE-AS2', contentType: 'text/plain' });
    const lines = payload.toString('utf8').split('\r\n').filter(Boolean);
    expect(lines.every((l: string) => l.length === 94)).toBe(true);
    expect(lines[0].slice(3, 13)).toBe(' 091017138');
    const batch = lines.find((l: string) => l[0] === '5');
    expect(batch.slice(1, 4)).toBe('220');
    expect(batch.slice(50, 53)).toBe('CCD');
    const entry = lines.find((l: string) => l[0] === '6');
    expect(entry.slice(1, 3)).toBe('22');
    expect(entry.slice(3, 12)).toBe('121145307');
    expect(entry.slice(12, 29).trim()).toBe('000123456789');
    expect(Number(entry.slice(29, 39))).toBe(250000);
    expect(entry.slice(54, 76).trim()).toBe('ACME VENDOR LLC');
    expect(rows['PPN-1'].result).toMatchObject({ transport: 'mftgateway', as2To: 'SUNRISE-AS2', messageId: 'MSG-1', filename: 'PPN-1.ach', entries: 1 });
    expect(JSON.stringify(rows['PPN-1'].result)).not.toContain('000123456789');
  });

  it('marks the file drop failed when MFT Gateway rejects the AS2 submission', async () => {
    const rows = { 'PPN-1': mftRow() };
    stubCloudSql(rows);
    mftLive();
    stubLedger();
    tokenizedAch();
    vi.spyOn(EnterpriseNetworkOsEngine, 'admit').mockResolvedValue({ participant: { participantId: 'ENP-1', endpoint: { partnerAs2Id: 'SUNRISE-AS2' } } });
    vi.spyOn(OpenAchFileRelay, 'archive').mockResolvedValue('gs://bucket/private-network/outbound/PPN-1.ach');
    vi.spyOn(MftGatewayClient, 'submit').mockResolvedValue({ success: false, status_code: 404, response_body: 'Partner not found' });
    await expect(PrivatePaymentNetworkOsEngine.approve({ transactionId: 'PPN-1', approvedBy: 'checker@dlbtrust.com', approvalRef: 'APR-1', screeningRef: 'SCR-1' })).rejects.toMatchObject({ status: 502, message: /MFT Gateway 404: Partner not found/ });
    expect(rows['PPN-1'].status).toBe('failed');
  });

  it('reconciles a cleared file drop by its AS2 message id without touching the gateway', async () => {
    const rows = { 'PPN-1': mftRow({ status: 'cleared', processor_tx_id: 'MSG-1', real_value: true }) };
    stubCloudSql(rows);
    const gw = vi.spyOn(PaymentGatewayServerEngine, 'reconcileWebhook');
    const out = await PrivatePaymentNetworkOsEngine.reconcile({ processorTxId: 'MSG-1', status: 'settled' });
    expect(out).toMatchObject({ transactionId: 'PPN-1', previousStatus: 'cleared', status: 'settled', reconciliation: { transport: 'mftgateway', messageId: 'MSG-1' } });
    expect(gw).not.toHaveBeenCalled();
  });
});

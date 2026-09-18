import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ApiGatewayClearingEngine } = require('../server/integrations/dapp/apiGatewayClearingEngine');
const { GoogleWalletEngine } = require('../server/integrations/dapp/googleWalletEngine');
const { PayoutRouteEngine } = require('../server/integrations/dapp/payoutRouteEngine');
const { ApigeeGatewayEngine, ApacheApisixEngine } = require('../server/integrations/os/osEngine');
const { VendorPaymentEngine } = require('../server/integrations/dapp/vendorPaymentEngine');
const { CanonicalConsensusEngine } = require('../server/integrations/dapp/canonicalConsensusEngine');
const { LiliSettlementBankEngine } = require('../server/integrations/payments/liliSettlementBankEngine');
const { LiliMcpEngine } = require('../server/integrations/payments/liliMcpEngine');

const ENV_KEYS = [
  'APIGEE_LIVE', 'APIGEE_HOSTNAME', 'APIGEE_BASE_URL', 'APIGEE_API_KEY', 'APIGEE_CLIENT_ID',
  'APIGEE_ODFI_ROUTING', 'APIGEE_ODFI_ACCOUNT', 'APISIX_LIVE', 'API_GATEWAY_PROVIDER',
  'API_GATEWAY_REQUIRE_APPROVAL_REF', 'API_GATEWAY_REQUIRE_SCREENING_REF',
  'GCS_CLEARING_EVIDENCE_BUCKET', 'GOOGLE_WALLET_LIVE', 'GOOGLE_WALLET_SERVICE_ACCOUNT_KEY',
  'GOOGLE_WALLET_ISSUER_ID', 'LILI_CLEARING_LIVE', 'LILI_BUSINESS_USER_ID',
];
const saved: Record<string, string | undefined> = {};

const destination = { name: 'Jane Beneficiary', routingNumber: '021000021', accountNumber: '123456789', accountType: 'checking' };

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.APIGEE_HOSTNAME = 'dlb-trust.apigee.net';
  process.env.APIGEE_API_KEY = 'test-key';
  process.env.APIGEE_ODFI_ROUTING = '021000021';
  process.env.APIGEE_ODFI_ACCOUNT = '999000111';
  vi.spyOn(ApiGatewayClearingEngine, 'ensureTables').mockResolvedValue(undefined);
  vi.spyOn(ApiGatewayClearingEngine, '_insert').mockImplementation(async (row: unknown) => row);
  vi.spyOn(ApiGatewayClearingEngine, '_update').mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('gateway rail registration', () => {
  it('recognises api_gateway / apigee / apisix everywhere a rail is dispatched', () => {
    for (const rail of ['api_gateway', 'apigee', 'apisix']) {
      expect(ApiGatewayClearingEngine.isGatewayRail(rail)).toBe(true);
      expect(VendorPaymentEngine.RAILS).toContain(rail);
    }
    expect(ApiGatewayClearingEngine.isGatewayRail('ach')).toBe(false);
  });

  it('resolves provider: aliases pin, api_gateway auto-selects Apigee when configured', () => {
    expect(ApiGatewayClearingEngine.resolveProvider('apigee')).toBe('apigee');
    expect(ApiGatewayClearingEngine.resolveProvider('apisix')).toBe('apisix');
    expect(ApiGatewayClearingEngine.resolveProvider('api_gateway')).toBe('apigee');
    process.env.API_GATEWAY_PROVIDER = 'apisix';
    expect(ApiGatewayClearingEngine.resolveProvider('api_gateway')).toBe('apisix');
    expect(ApiGatewayClearingEngine.engineFor('apigee')).toBe(ApigeeGatewayEngine);
    expect(ApiGatewayClearingEngine.engineFor('apisix')).toBe(ApacheApisixEngine);
  });

  it('selects Lili as the settlement bank via API_GATEWAY_PROVIDER or LILI_CLEARING_LIVE', () => {
    process.env.API_GATEWAY_PROVIDER = 'lili';
    expect(ApiGatewayClearingEngine.resolveProvider('api_gateway')).toBe('lili');
    delete process.env.API_GATEWAY_PROVIDER;
    process.env.LILI_CLEARING_LIVE = 'true';
    expect(ApiGatewayClearingEngine.resolveProvider('api_gateway')).toBe('lili');
    expect(ApiGatewayClearingEngine.resolveProvider('apigee')).toBe('apigee');
    expect(ApiGatewayClearingEngine.engineFor('lili')).toBe(LiliSettlementBankEngine);
  });

  it('accepts gateway rails on canonical vendor_bill proposals', () => {
    const payload = { vendorPaymentBillId: 'BILL-1', vendor: { name: 'Acme' }, amount: 100, rail: 'apigee' };
    expect(() => CanonicalConsensusEngine._validateVendorBillPayload(payload)).not.toThrow();
    expect(() => CanonicalConsensusEngine._validateVendorBillPayload({ ...payload, rail: 'carrier_pigeon' })).toThrow(/rail is not supported/);
  });
});

describe('ApiGatewayClearingEngine.clearPayment (fail-closed)', () => {
  it('refuses without an approval reference', async () => {
    await expect(ApiGatewayClearingEngine.clearPayment({ flow: 'distribution', amount: 10, screeningRef: 'SCR-1', destination }))
      .rejects.toThrow(/approvalRef/);
  });

  it('refuses without a compliance screening reference', async () => {
    await expect(ApiGatewayClearingEngine.clearPayment({ flow: 'distribution', amount: 10, approvalRef: 'REQ-1', destination }))
      .rejects.toThrow(/screeningRef/);
  });

  it('refuses non-positive amounts and missing destination bank details', async () => {
    await expect(ApiGatewayClearingEngine.clearPayment({ flow: 'distribution', amount: 0, approvalRef: 'A', screeningRef: 'S', destination }))
      .rejects.toThrow(/amount/i);
    await expect(ApiGatewayClearingEngine.clearPayment({ flow: 'distribution', amount: 5, approvalRef: 'A', screeningRef: 'S', destination: { name: 'x' } }))
      .rejects.toThrow(/routing|account/i);
  });

  it('runs in shadow by default: records the event, makes no outbound call, moves no money', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await ApiGatewayClearingEngine.clearPayment({
      rail: 'apigee', flow: 'distribution', amount: 250, approvalRef: 'REQ-1', screeningRef: 'SCR-1', destination,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.provider).toBe('apigee');
    expect(result.live).toBe(false);
    expect(result.shadow).toBe(true);
    expect(result.status).toBe('shadow');
    expect(result.gatewayReference).toMatch(/^APIGEE-/);
    expect(ApiGatewayClearingEngine._insert).toHaveBeenCalledOnce();
    const row = (ApiGatewayClearingEngine._insert as any).mock.calls[0][0];
    expect(row.approval_ref).toBe('REQ-1');
    expect(row.screening_ref).toBe('SCR-1');
    expect(JSON.stringify(row)).not.toContain('123456789');
  });

  it('provisions a Google Wallet pass only after the money leg, keyed by the beneficiary identity', async () => {
    const result = await ApiGatewayClearingEngine.clearPayment({
      rail: 'apigee', flow: 'distribution', amount: 25, approvalRef: 'REQ-2', screeningRef: 'SCR-2', destination,
      walletPass: { email: 'Jane@Example.com', role: 'beneficiary' },
    });
    expect(result.walletPass).toBeTruthy();
    expect(result.walletPass.mode).toBe('shadow');
    expect(result.walletPass.objectId).toContain(GoogleWalletEngine.passKey({ email: 'jane@example.com' }));
    expect(result.walletPass.addToWalletLink).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(String(result.walletPass.cardFunding)).toMatch(/TSP|Token Service Provider/);
  });
});

describe('Lili settlement bank', () => {
  it('stays shadow by default: no MCP call, simulated reference', async () => {
    process.env.API_GATEWAY_PROVIDER = 'lili';
    const pay = vi.spyOn(LiliMcpEngine, 'payToPayee');
    const result = await ApiGatewayClearingEngine.clearPayment({
      rail: 'api_gateway', flow: 'vendor_bill', amount: 40, approvalRef: 'REQ-L1', screeningRef: 'SCR-L1', destination,
    });
    expect(pay).not.toHaveBeenCalled();
    expect(result.provider).toBe('lili');
    expect(result.shadow).toBe(true);
    expect(result.gatewayReference).toMatch(/^LILI-TX-/);
  });

  it('live: fails closed when Lili MCP is not configured', async () => {
    process.env.LILI_CLEARING_LIVE = 'true';
    vi.spyOn(LiliMcpEngine, 'getConfig').mockResolvedValue({ mcpEnabled: false });
    const pay = vi.spyOn(LiliMcpEngine, 'payToPayee');
    await expect(ApiGatewayClearingEngine.clearPayment({
      rail: 'api_gateway', flow: 'distribution', amount: 40, approvalRef: 'REQ-L2', screeningRef: 'SCR-L2', destination,
    })).rejects.toThrow(/Lili MCP is not configured/);
    expect(pay).not.toHaveBeenCalled();
    expect(ApiGatewayClearingEngine._update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'failed' }));
  });

  it('live: originates through LiliMcpEngine.payToPayee and rejects anything but api_pending', async () => {
    process.env.LILI_CLEARING_LIVE = 'true';
    process.env.LILI_BUSINESS_USER_ID = 'biz-1';
    vi.spyOn(LiliMcpEngine, 'getConfig').mockResolvedValue({ mcpEnabled: true, mcpUrl: 'https://mcp.lili.co/mcp', clientId: 'c', accessToken: 't' });
    const pay = vi.spyOn(LiliMcpEngine, 'payToPayee').mockResolvedValue({ status: 'api_pending', billId: 'BILL-9', supplierId: 'SUP-1' });
    const result = await ApiGatewayClearingEngine.clearPayment({
      rail: 'api_gateway', flow: 'distribution', amount: 40, approvalRef: 'REQ-L3', screeningRef: 'SCR-L3', destination,
    });
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({ amount: 40, recipientRouting: '021000021', recipientAccount: '123456789', businessUserId: 'biz-1' }));
    expect(result.live).toBe(true);
    expect(result.status).toBe('originated');
    expect(result.gatewayReference).toBe('BILL-9');

    pay.mockResolvedValue({ status: 'manual_pending', reason: 'lili_pay_bill tool not available' });
    await expect(ApiGatewayClearingEngine.clearPayment({
      rail: 'api_gateway', flow: 'distribution', amount: 40, approvalRef: 'REQ-L4', screeningRef: 'SCR-L4', destination,
    })).rejects.toThrow(/Lili did not accept/);
  });

  it('readiness names the Lili live flag', async () => {
    process.env.API_GATEWAY_PROVIDER = 'lili';
    const readiness = await ApiGatewayClearingEngine.readiness();
    expect(readiness.provider).toBe('lili');
    expect(readiness.blockers.join(' ')).toContain('LILI_CLEARING_LIVE=false');
  });
});

describe('readiness / pipeline', () => {
  it('reports shadow mode with blockers and the seven stages', async () => {
    const readiness = await ApiGatewayClearingEngine.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.mode).toBe('shadow');
    expect(readiness.provider).toBe('apigee');
    expect(readiness.blockers.join(' ')).toMatch(/shadow/);
    expect(readiness.stages).toEqual(ApiGatewayClearingEngine.STAGES);
    expect(ApiGatewayClearingEngine.STAGES).toEqual([
      'request', 'two_trustee_approval', 'compliance_gate', 'rail_routing',
      'gateway_settlement', 'google_wallet_pass', 'ledger_reconciliation',
    ]);
  });
});

describe('GoogleWalletEngine', () => {
  it('derives a deterministic, case-insensitive pass key from email or wallet address', () => {
    expect(GoogleWalletEngine.passKey({ email: 'A@B.co' })).toBe(GoogleWalletEngine.passKey({ email: 'a@b.co ' }));
    expect(GoogleWalletEngine.passKey({ walletAddress: '0xabc' })).not.toBe(GoogleWalletEngine.passKey({ email: 'a@b.co' }));
    expect(() => GoogleWalletEngine.passKey({})).toThrow(/required/);
  });

  it('stays shadow (no Google API call) unless GOOGLE_WALLET_LIVE=true with a service-account key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const pass = await GoogleWalletEngine.createPass({ email: 'trustee@dlbtrust.test', role: 'trustee' });
    expect(pass.mode).toBe('shadow');
    expect(pass.signed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    process.env.GOOGLE_WALLET_LIVE = 'true';
    expect(GoogleWalletEngine.readiness().ready).toBe(false);
  });
});

describe('PayoutRouteEngine gateway + google_wallet routing', () => {
  const bank = { routingNumber: '021000021', accountNumber: '123456789', accountHolderName: 'Jane Beneficiary' };

  it('plans a bank destination on a gateway rail', () => {
    const route = PayoutRouteEngine.plan({ destinationType: 'bank', payoutRail: 'apigee', bank });
    expect(route.rail).toBe('apigee');
    expect(route.destinationType).toBe('bank');
    expect(JSON.stringify(route.redacted)).not.toContain('123456789');
  });

  it('plans a google_wallet destination funded through the gateway when bank details are given', () => {
    const route = PayoutRouteEngine.plan({ destinationType: 'google_wallet', googleWallet: { email: 'jane@example.com', bank } });
    expect(route.rail).toBe('google_wallet');
    expect(route.redacted.fundingRail).toBe('api_gateway');
    expect(route.redacted.email).toBe('jane@example.com');
    expect(String(route.redacted.cardFunding)).toMatch(/Token Service Provider/);
  });

  it('plans a google_wallet destination funded through SIT when a wallet address is given', () => {
    const route = PayoutRouteEngine.plan({
      destinationType: 'google_wallet',
      googleWallet: { walletAddress: '0x1111111111111111111111111111111111111111', role: 'trustee' },
    });
    expect(route.redacted.fundingRail).toBe('sit');
    expect(route.redacted.role).toBe('trustee');
  });

  it('rejects a google_wallet destination with no identity', () => {
    expect(() => PayoutRouteEngine.plan({ destinationType: 'google_wallet', googleWallet: {} })).toThrow();
  });
});

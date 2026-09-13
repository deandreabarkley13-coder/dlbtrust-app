import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const POLICY = '0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYOUT = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';

process.env.SPRITZ_API_KEY = 'test-key';
process.env.SPRITZ_API_BASE_URL = 'https://platform.spritz.finance';
process.env.TRUST_POLICY_ADDRESS = POLICY;
process.env.THIRDWEB_SETTLEMENT_TOKEN = USDC;
process.env.THIRDWEB_CHAIN_ID = '8453';
process.env.DAPP_CHAIN_ID = '8453';
process.env.DAPP_OPERATOR_ADDRESS = PAYOUT;
process.env.DAPP_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.SPRITZ_PAYOUT_WALLET = PAYOUT;
process.env.TRUST_OPERATING_GL_ACCOUNT_CODE = '1000';
process.env.CANONICAL_FUNDING_CASH_ACCOUNT_CODE = '1000';

const pool = require('../server/integrations/bonds/pgPool');
const { CanonicalFundingSource } = require('../server/integrations/fineract/canonicalFundingSource');
const { BankTransferEngine } = require('../server/integrations/dapp/bankTransferEngine');
const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');
const { TrustAllocationEngine } = require('../server/integrations/dapp/trustAllocationEngine');
const { CollateralOsEngine } = require('../server/integrations/os/collateralOsEngine');
const { SpritzFiatFundingEngine } = require('../server/integrations/spritz/spritzFiatFundingEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');

type FetchCall = { url: string; init: RequestInit };

const ACCOUNT = {
  id: 'ar_policy', status: 'active', address: POLICY.toLowerCase(), network: 'base', token: 'USDC', currency: 'USD',
  depositInstructions: { type: 'us', bankName: 'Lead Bank', bankAddress: '1801 Main St', paymentRails: ['ach', 'wire'], bankRoutingNumber: '101019644', bankAccountNumber: '1234567890' },
};
const CAPS_ACTIVE = [
  { product: 'fiat_to_crypto', method: 'ach_credit', status: 'active', requirements: [] },
  { product: 'fiat_to_crypto', method: 'wire', status: 'active', requirements: [] },
  { product: 'crypto_to_fiat', method: 'ach_credit', status: 'active', requirements: [] },
];
const CAPS_TERMS = [
  { product: 'fiat_to_crypto', method: 'ach_credit', status: 'requirements_needed', requirements: [{ type: 'terms_acceptance', status: 'pending', actionUrl: 'https://spritz.example/terms' }] },
  { product: 'fiat_to_crypto', method: 'wire', status: 'requirements_needed', requirements: [] },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Spritz fiat funding (ERP credit push -> auto-ramp)', () => {
  const calls: FetchCall[] = [];
  let rows: Record<string, any>;

  function stubSpritz(handler: (path: string, init: RequestInit) => unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname + (new URL(url).search || '');
      return jsonResponse(handler(path, init));
    }));
  }

  function stubDb() {
    rows = {};
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO spritz_fiat_fundings/.test(sql)) {
        if (!rows[params[0]]) rows[params[0]] = { reference: params[0], bucket: params[1], amount_usd: params[2], rail: params[3], auto_ramp_account_id: params[4], deposit_instructions: JSON.parse(params[5]), source_account: params[6], erp_commit: JSON.parse(params[7]), transfer_id: params[8], transfer_status: params[9], status: params[10], error: params[11], created_at: new Date('2026-09-01T00:00:00Z') };
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE spritz_fiat_fundings SET onramp_id/.test(sql)) {
        Object.assign(rows[params[4]], { onramp_id: params[0], onramp: JSON.parse(params[1]), status: params[2], error: params[3] });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE spritz_fiat_fundings SET transfer_status/.test(sql)) {
        Object.assign(rows[params[3]], { transfer_status: params[0], status: params[1], error: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT \* FROM spritz_fiat_fundings WHERE reference/.test(sql)) return { rows: rows[params[0]] ? [rows[params[0]]] : [], rowCount: 0 };
      if (/SELECT \* FROM spritz_fiat_fundings/.test(sql)) return { rows: Object.values(rows), rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    calls.length = 0;
    delete process.env.SPRITZ_AUTO_RAMP_ACCOUNT_ID;
    delete process.env.SPRITZ_FIAT_FUNDING_COLLATERAL_GATE;
    stubDb();
    vi.spyOn(CollateralOsEngine, 'facility').mockResolvedValue({ spendableUsd: 0, drawnUsd: 0, availableUsd: 0, byPosition: [] });
    vi.spyOn(CanonicalFundingSource, 'commit').mockResolvedValue({ committed: true, shadow: false, entryId: 'je_1' });
    vi.spyOn(CanonicalFundingSource, 'position').mockResolvedValue({
      accountCode: '1000', glAccountId: 68, canonicalBalanceCents: 100_000_00, ledgerBalanceCents: 100_000_00, driftCents: 0,
      availableBalanceCents: 100_000_00, fundingEligible: true, segregationStatus: 'available', segregationReason: null, degraded: null, live: true,
    });
    vi.spyOn(BankTransferEngine, 'pushCredit').mockResolvedValue({ transfer_id: 'BTO-1', status: 'initiated', ach_batch_id: 'ach_1' });
    vi.spyOn(BankTransferEngine, 'sendPushCredit').mockResolvedValue({ transfer_id: 'BTO-1', status: 'completed' });
    delete process.env.ACH_MFT_CHANNEL;
    delete process.env.ACH_SFTP_URL;
  });

  it('refuses to transmit ACH without an ODFI channel (self-posting the NACHA file is not a bank submission)', async () => {
    stubSpritz(() => [ACCOUNT]);
    vi.spyOn(SpritzFiatFundingEngine, 'capability').mockResolvedValue({ rail: 'ach', method: 'ach_credit', status: 'active', active: true, requirements: [] });
    await SpritzFiatFundingEngine.fund({ amountUsd: 50, bucket: 'trust_operating', reference: 'REF-odfi' });
    await expect(SpritzFiatFundingEngine.send({ reference: 'REF-odfi' })).rejects.toMatchObject({ code: 'ERP_ORIGINATION_CHANNEL_MISSING' });
    expect(BankTransferEngine.sendPushCredit).not.toHaveBeenCalled();
    expect((await SpritzFiatFundingEngine.get('REF-odfi')).status).toBe('prepared');

    const readiness = await SpritzFiatFundingEngine.readiness();
    expect(readiness.originationChannels.find((c: any) => c.rail === 'ach')).toMatchObject({ ready: false, channel: null });
    expect(readiness.issues.some((i: string) => /ach origination: no ODFI channel/.test(i))).toBe(true);

    process.env.ACH_MFT_CHANNEL = 'odfi-nacha';
    expect(await SpritzFiatFundingEngine.originationChannel('ach')).toMatchObject({ ready: true, channel: 'mft' });
    expect(await SpritzFiatFundingEngine.originationChannel('wire')).toMatchObject({ ready: false });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads the live Fineract cash position: an overdrawn/drifted canonical account or unreachable core blocks readiness', async () => {
    stubSpritz(() => [ACCOUNT]);
    vi.spyOn(SpritzFiatFundingEngine, 'capability').mockResolvedValue({ rail: 'ach', method: 'ach_credit', status: 'active', active: true, requirements: [] });

    let readiness = await SpritzFiatFundingEngine.readiness();
    expect(readiness.erpPosition).toMatchObject({ ok: true, accountCode: '1000', canonicalUsd: 100000, availableUsd: 100000 });
    expect(readiness.issues.some((i: string) => /ERP canonical cash/.test(i))).toBe(false);

    vi.spyOn(CanonicalFundingSource, 'position').mockResolvedValue({
      accountCode: '1000', glAccountId: 68, canonicalBalanceCents: -592749476, ledgerBalanceCents: 0, driftCents: 592749476,
      availableBalanceCents: 0, fundingEligible: false, segregationStatus: 'restricted',
      segregationReason: 'sub-ledger and canonical GL differ by $5927494.76 — reconcile before funding', degraded: null, live: true,
    });
    readiness = await SpritzFiatFundingEngine.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.erpPosition).toMatchObject({ ok: false, canonicalUsd: -5927494.76, availableUsd: 0, driftUsd: 5927494.76 });
    expect(readiness.issues.some((i: string) => /ERP canonical cash: fineract 1000 canonical balance \$-5927494\.76 .* no spendable cash booked in the core/.test(i))).toBe(true);

    vi.spyOn(CanonicalFundingSource, 'position').mockRejectedValue(new Error('ECONNREFUSED dlbtrust-fineract:8443'));
    readiness = await SpritzFiatFundingEngine.readiness();
    expect(readiness.erpPosition).toMatchObject({ ok: false, canonicalUsd: null, availableUsd: 0 });
    expect(readiness.issues.some((i: string) => /fineract unreachable: ECONNREFUSED/.test(i))).toBe(true);
  });

  it('finds the auto-ramp account converting to the policy contract and refuses a mismatched pin', async () => {
    stubSpritz(() => [{ ...ACCOUNT, id: 'ar_other', address: PAYOUT }, ACCOUNT]);
    const account = await SpritzFiatFundingEngine.account();
    expect(account.id).toBe('ar_policy');
    expect(account.active).toBe(true);
    expect(account.depositInstructions.bankRoutingNumber).toBe('101019644');

    process.env.SPRITZ_AUTO_RAMP_ACCOUNT_ID = 'ar_other';
    await expect(SpritzFiatFundingEngine.account()).rejects.toMatchObject({ code: 'AUTO_RAMP_ACCOUNT_MISMATCH' });
  });

  it('creates the account only when asked, targeting USDC on base at the policy contract', async () => {
    stubSpritz((path, init) => {
      if (path === '/v1/auto-ramp-accounts/' && init.method === 'POST') return { ...ACCOUNT, id: 'ar_new' };
      return [];
    });
    expect(await SpritzFiatFundingEngine.account()).toBeNull();
    const created = await SpritzFiatFundingEngine.account({ ensure: true });
    expect(created.id).toBe('ar_new');
    expect(created.created).toBe(true);
    const post = calls.find((c) => c.init.method === 'POST');
    expect(JSON.parse(String(post!.init.body))).toEqual({ address: POLICY, network: 'base', token: 'USDC' });
  });

  it('SPRITZ_AUTO_RAMP_DESTINATION overrides the policy contract as the conversion wallet and is flagged as ungoverned', async () => {
    const WALLET = '0xA0f8C3d9e4fE7F531968b11f1Ce298F56483040F';
    process.env.SPRITZ_AUTO_RAMP_DESTINATION = WALLET;
    try {
      stubSpritz((path, init) => {
        if (path === '/v1/auto-ramp-accounts/' && init.method === 'POST') return { ...ACCOUNT, id: 'ar_wallet', address: WALLET.toLowerCase() };
        return [ACCOUNT];
      });
      expect(await SpritzFiatFundingEngine.account()).toBeNull();
      const created = await SpritzFiatFundingEngine.account({ ensure: true });
      expect(created.id).toBe('ar_wallet');
      const post = calls.find((c) => c.init.method === 'POST');
      expect(JSON.parse(String(post!.init.body))).toEqual({ address: WALLET, network: 'base', token: 'USDC' });

      vi.spyOn(SpritzFiatFundingEngine, 'capability').mockResolvedValue({ rail: 'ach', method: 'ach_credit', status: 'active', active: true, requirements: [] });
      const readiness = await SpritzFiatFundingEngine.readiness();
      expect(readiness).toMatchObject({ destination: WALLET, destinationIsPolicy: false, policyContract: POLICY });
      expect(readiness.warnings.some((w: string) => /outside TrustDistributionPolicy governance/.test(w))).toBe(true);
    } finally {
      delete process.env.SPRITZ_AUTO_RAMP_DESTINATION;
    }
  });

  it('fails closed when the Spritz fiat_to_crypto capability needs terms acceptance', async () => {
    stubSpritz((path) => (path.startsWith('/v1/users/capabilities') || /capabilit/.test(path) ? CAPS_TERMS : [ACCOUNT]));
    vi.spyOn(SpritzFiatFundingEngine, 'capability').mockResolvedValue({ rail: 'ach', method: 'ach_credit', status: 'requirements_needed', active: false, requirements: [{ type: 'terms_acceptance', status: 'pending', actionUrl: 'https://spritz.example/terms' }] });
    await expect(SpritzFiatFundingEngine.fund({ amountUsd: 100, bucket: 'trust_operating', reference: 'REF-1' }))
      .rejects.toMatchObject({ code: 'FIAT_FUNDING_CAPABILITY_INACTIVE', message: expect.stringContaining('https://spritz.example/terms') });
    expect(CanonicalFundingSource.commit).not.toHaveBeenCalled();
    expect(BankTransferEngine.pushCredit).not.toHaveBeenCalled();
    const readiness = await SpritzFiatFundingEngine.readiness();
    expect(readiness.ready).toBe(false);
  });

  it('rejects unsupported rails and non-canonical sources before touching the ERP', async () => {
    await expect(SpritzFiatFundingEngine.fund({ amountUsd: 100, bucket: 'trust_operating', reference: 'REF-x', rail: 'rtp' }))
      .rejects.toMatchObject({ code: 'FIAT_FUNDING_RAIL_UNSUPPORTED' });
    expect(CanonicalFundingSource.commit).not.toHaveBeenCalled();
  });

  it('originates the ERP credit push to the deposit instructions, books the ERP commit, and is idempotent', async () => {
    stubSpritz(() => [ACCOUNT]);
    vi.spyOn(SpritzFiatFundingEngine, 'capability').mockResolvedValue({ rail: 'ach', method: 'ach_credit', status: 'active', active: true, requirements: [] });
    const first = await SpritzFiatFundingEngine.fund({ amountUsd: 250, bucket: 'trust_operating', reference: 'REF-2', createdBy: 'maker' });
    expect(first.status).toBe('prepared');
    expect(first.rail).toBe('ach');
    expect(first.source).toMatchObject({ kind: 'treasury_core_erp', account: '1000' });
    expect(CanonicalFundingSource.commit).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 250, reference: 'REF-2', cashAccountCode: '1000', assetAccountCode: '1210' }));
    expect(BankTransferEngine.pushCredit).toHaveBeenCalledWith(expect.objectContaining({
      amount: 250, rail: 'ach', memo: 'REF-2',
      destinationDetails: expect.objectContaining({ routingNumber: '101019644', accountNumber: '1234567890', bankName: 'Lead Bank' }),
    }));
    expect(first.transfer).toEqual({ id: 'BTO-1', status: 'initiated', achBatchId: 'ach_1', wirePayoutId: null });

    const again = await SpritzFiatFundingEngine.fund({ amountUsd: 250, bucket: 'trust_operating', reference: 'REF-2' });
    expect(again.idempotent).toBe(true);
    expect(CanonicalFundingSource.commit).toHaveBeenCalledTimes(1);
  });

  it('gates on Collateral OS headroom when the facility carries pledges', async () => {
    stubSpritz(() => [ACCOUNT]);
    vi.spyOn(SpritzFiatFundingEngine, 'capability').mockResolvedValue({ rail: 'ach', method: 'ach_credit', status: 'active', active: true, requirements: [] });
    (CollateralOsEngine.facility as any).mockResolvedValue({ spendableUsd: 1000, drawnUsd: 900, availableUsd: 100, byPosition: [{ positionId: 'p1' }] });
    await expect(SpritzFiatFundingEngine.fund({ amountUsd: 250, bucket: 'trust_operating', reference: 'REF-3' }))
      .rejects.toMatchObject({ code: 'COLLATERAL_INSUFFICIENT' });
    expect(CanonicalFundingSource.commit).not.toHaveBeenCalled();
  });

  it('transmits the credit push and reconciles the Spritz on-ramp without claiming completion early', async () => {
    let onRamps: any[] = [];
    stubSpritz((path) => (path.startsWith('/v1/on-ramps') ? onRamps : [ACCOUNT]));
    vi.spyOn(SpritzFiatFundingEngine, 'capability').mockResolvedValue({ rail: 'ach', method: 'ach_credit', status: 'active', active: true, requirements: [] });
    vi.spyOn(TrustPolicyEngine, 'status').mockResolvedValue({ treasury: { token: USDC, balance: '0', available: '0' } });
    await SpritzFiatFundingEngine.fund({ amountUsd: 250, bucket: 'trust_operating', reference: 'REF-4' });

    process.env.ACH_MFT_CHANNEL = 'odfi-nacha';
    const sent = await SpritzFiatFundingEngine.send({ reference: 'REF-4' });
    expect(sent.status).toBe('submitted');
    expect(BankTransferEngine.sendPushCredit).toHaveBeenCalledWith('BTO-1');

    let rec = await SpritzFiatFundingEngine.reconcile();
    expect(rec.funded).toBe(false);
    expect(rec.updates).toEqual([]);

    onRamps = [{ id: 'or_1', status: 'processing', createdAt: '2026-09-02T00:00:00Z', input: { amount: '250.00', currency: 'USD', rail: 'ach_credit' } }];
    rec = await SpritzFiatFundingEngine.reconcile();
    expect(rec.updates).toEqual([{ reference: 'REF-4', onRampId: 'or_1', from: 'submitted', to: 'processing' }]);

    onRamps = [{ id: 'or_1', status: 'completed', createdAt: '2026-09-02T00:00:00Z', input: { amount: '250.00', currency: 'USD', rail: 'ach_credit' }, output: { amount: '249.10', token: 'USDC', network: 'base' } }];
    (TrustPolicyEngine.status as any).mockResolvedValue({ treasury: { token: USDC, balance: '249100000', available: '249100000' } });
    rec = await SpritzFiatFundingEngine.reconcile();
    expect(rec.fundings[0].status).toBe('completed');
    expect(rec.completedUsd).toBe('250.00');
    expect(rec.funded).toBe(true);
  });

  it('straight-through settle stops at funding when the policy holds no USDC, then at approval', async () => {
    stubSpritz(() => [ACCOUNT]);
    vi.spyOn(SpritzFiatFundingEngine, 'capability').mockResolvedValue({ rail: 'ach', method: 'ach_credit', status: 'active', active: true, requirements: [] });
    vi.spyOn(TrustPolicyEngine, 'status').mockResolvedValue({ treasury: { token: USDC, balance: '0', available: '0' } });
    const stage = vi.spyOn(SpritzTreasuryLegEngine, 'stagePayout').mockResolvedValue({ status: 'proposed', spritzQuoteId: 'q1', distribution: { distributionId: '1' } });
    vi.spyOn(TrustAllocationEngine, 'listPayouts').mockResolvedValue([]);

    const blocked = await SpritzTreasuryLegEngine.settle({ amountUsd: 100, bucket: 'trust_operating', purpose: 'trustee_fee', reference: 'RUN-1' });
    expect(blocked).toMatchObject({ stage: 'funding', status: 'blocked' });
    expect(blocked.funding.reference).toBe('RUN-1-fund');
    expect(BankTransferEngine.sendPushCredit).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();

    (TrustPolicyEngine.status as any).mockResolvedValue({ treasury: { token: USDC, balance: '100000000', available: '100000000' } });
    const staged = await SpritzTreasuryLegEngine.settle({ amountUsd: 100, bucket: 'trust_operating', purpose: 'trustee_fee', reference: 'RUN-1' });
    expect(staged).toMatchObject({ stage: 'approval', status: 'blocked' });
    expect(stage).toHaveBeenCalledTimes(1);

    (TrustAllocationEngine.listPayouts as any).mockResolvedValue([{ reference: 'RUN-1', status: 'proposed', distributionId: '1', spritzQuoteId: 'q1' }]);
    vi.spyOn(TrustPolicyEngine, 'distribution').mockResolvedValue({ distributionId: '1', status: 'approved', approvals: 1, releasableAt: new Date(Date.now() + 3600e3).toISOString() });
    const exec = vi.spyOn(SpritzTreasuryLegEngine, 'executePayout').mockResolvedValue({ status: 'submitted' });
    const timelocked = await SpritzTreasuryLegEngine.settle({ amountUsd: 100, bucket: 'trust_operating', purpose: 'trustee_fee', reference: 'RUN-1' });
    expect(timelocked).toMatchObject({ stage: 'timelock', status: 'blocked' });
    expect(exec).not.toHaveBeenCalled();
  });
});

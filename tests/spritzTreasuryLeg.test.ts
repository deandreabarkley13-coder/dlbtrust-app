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

const pool = require('../server/integrations/bonds/pgPool');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');
const { SpritzEngine } = require('../server/integrations/spritz/spritzEngine');
const { SpritzTreasuryLegEngine, usdToUnits, unitsToUsd } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { OnOffRampEngine } = require('../server/integrations/dapp/onOffRampEngine');

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Spritz treasury leg', () => {
  const calls: FetchCall[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    calls.length = 0;
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [], rowCount: 0 } as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubSpritz(handler: (path: string, init: RequestInit) => unknown) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      const out = handler(path, init);
      if (out instanceof Response) return out;
      return jsonResponse(out);
    }));
  }

  it('converts between USD and 6-decimal USDC units', () => {
    expect(usdToUnits('10')).toBe(10_000_000n);
    expect(usdToUnits('0.25')).toBe(250_000n);
    expect(unitsToUsd('123456789')).toBe('123.456789');
    expect(() => usdToUnits('-1')).toThrow(/positive/);
  });

  it('prepares a deposit that targets the policy contract on Base and sends the Idempotency-Key on create', async () => {
    stubSpritz((path, init) => {
      if (path === '/v1/funding-sources/') return [{ id: 'fs_1', status: 'active' }];
      if (path === '/v1/deposits/direct/prepare') return { id: 'prep_1', amountUsd: '10.00' };
      if (path === '/v1/deposits/direct') return { id: 'dep_1', status: 'pending', amountUsd: '10.00', feeUsd: '0.10' };
      throw new Error(`unexpected ${path}`);
    });
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-1' } as any);

    const out = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, reference: 'FUND-TEST-1' });

    const prepare = calls.find(c => c.url.endsWith('/v1/deposits/direct/prepare'))!;
    expect(JSON.parse(prepare.init.body as string)).toMatchObject({
      sourceId: 'fs_1', address: POLICY, network: 'base', asset: 'USDC', amountUsd: '10.00', quoteType: 'exact_input', priority: 'normal',
    });
    const create = calls.find(c => c.url.endsWith('/v1/deposits/direct'))!;
    expect((create.init.headers as Record<string, string>)['Idempotency-Key']).toBe('dlb-fund-FUND-TEST-1');
    expect(JSON.parse(create.init.body as string)).toEqual({ preparationId: 'prep_1' });

    expect(out).toMatchObject({ depositId: 'dep_1', destination: POLICY, network: 'base', amountUsd: '10.00', feeUsd: '0.10' });
    expect(out.journal).toMatchObject({ status: 'booked', entryId: 'JRN-1' });
    const entry = post.mock.calls[0][0];
    expect(entry.referenceType).toBe('spritz_deposit');
    expect(entry.referenceId).toBe('dep_1');
    const debits = entry.lines.reduce((s: number, l: any) => s + l.debitAmount, 0);
    const credits = entry.lines.reduce((s: number, l: any) => s + l.creditAmount, 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect(entry.lines.find((l: any) => l.accountCode === '1210').debitAmount).toBeCloseTo(9.9, 2);
  });

  it('refuses to fund without a Plaid-linked funding source', async () => {
    stubSpritz((path) => {
      if (path === '/v1/funding-sources/') return [];
      throw new Error(`unexpected ${path}`);
    });
    await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, reference: 'FUND-TEST-2' }))
      .rejects.toMatchObject({ code: 'SPRITZ_NO_FUNDING_SOURCE' });
    expect(calls.some(c => c.url.includes('/v1/deposits/'))).toBe(false);
  });

  it('routes a spritz onramp proposal through the treasury leg', async () => {
    const fund = vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'pending', depositId: 'dep_2' } as any);
    const out = await OnOffRampEngine._executeProvider({
      id: 'PROP-1',
      payload: { direction: 'onramp', provider: 'spritz', amount: '25', sourceId: 'fs_1', reference: 'REF-1' },
    });
    expect(fund).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: '25', sourceId: 'fs_1', reference: 'REF-1' }));
    expect(out).toMatchObject({ depositId: 'dep_2' });
  });

  it('refuses to stage a payout when the payout wallet is not allow-listed on the policy contract', async () => {
    vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: false, frozen: false } as any);
    const propose = vi.spyOn(TrustPolicyEngine, 'propose');
    stubSpritz(() => { throw new Error('Spritz must not be called'); });

    await expect(SpritzTreasuryLegEngine.stagePayout({ bankAccountId: 'ba_1', amountUsd: 100, purpose: 'distribution', reference: 'PAY-1' }))
      .rejects.toMatchObject({ code: 'PAYOUT_WALLET_NOT_ALLOWLISTED' });
    expect(propose).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('stages a payout as a Spritz quote plus a governed distribution for the quoted USDC input', async () => {
    vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: true, frozen: false } as any);
    const propose = vi.spyOn(TrustPolicyEngine, 'propose').mockResolvedValue({ distributionId: '7', status: 'proposed' } as any);
    stubSpritz((path) => {
      if (path === '/v1/off-ramp-quotes/') return { id: 'q_1', requiredTokenInput: '100500000' };
      throw new Error(`unexpected ${path}`);
    });

    const out = await SpritzTreasuryLegEngine.stagePayout({ bankAccountId: 'ba_1', amountUsd: 100, purpose: 'distribution', reference: 'PAY-2', rail: 'rtp' });

    const quote = calls[0];
    expect(JSON.parse(quote.init.body as string)).toMatchObject({ accountId: 'ba_1', amount: '100.00', chain: 'base', tokenAddress: USDC, rail: 'rtp', amountMode: 'output' });
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({ beneficiary: PAYOUT, quantity: '100500000', purpose: 'distribution', reference: 'PAY-2' }));
    expect(out).toMatchObject({ status: 'proposed', spritzQuoteId: 'q_1', quantityUnits: '100500000', distribution: { distributionId: '7' } });
  });

  it('reconciles Spritz deposits against the on-chain policy balance', async () => {
    vi.spyOn(TrustPolicyEngine, 'status').mockResolvedValue({ treasury: { token: USDC, balance: '0', reserved: '0', available: '0' } } as any);
    stubSpritz((path) => {
      if (path === '/v1/deposits/') return { data: [{ id: 'dep_1', status: 'pending', address: POLICY.toLowerCase() }, { id: 'dep_x', status: 'completed', address: '0x0000000000000000000000000000000000000001' }] };
      throw new Error(`unexpected ${path}`);
    });
    const out = await SpritzTreasuryLegEngine.reconcileFunding();
    expect(out.funded).toBe(false);
    expect(out.spritz).toMatchObject({ depositsToContract: 1, settled: 0, pending: [{ id: 'dep_1', status: 'pending' }] });
    expect(out.onChain.balanceUsd).toBe('0.000000');
  });
});

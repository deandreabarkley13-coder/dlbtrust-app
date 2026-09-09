import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const POLICY = '0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYOUT = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';
const PRB = '0x3f3a354f76be6ad0e7fc9b6efe39727b39cbd160';

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
const { CanonicalMoneyEngine } = require('../server/integrations/dapp/canonicalMoneyEngine');
const { SpritzTreasuryLegEngine, usdToUnits, unitsToUsd } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { OnOffRampEngine } = require('../server/integrations/dapp/onOffRampEngine');

type FetchCall = { url: string; init: RequestInit };

const BANKS = [
  { id: 'ba_dbnet', label: 'DB NET MGMT Operating', accountHolderName: 'DB NET MGMT LLC', institution: { name: 'Column' }, status: 'active', supportedRails: ['ach_standard', 'rtp'] },
  { id: 'ba_other', label: 'Personal checking', accountHolderName: 'Deandrea Barkley', institution: { name: 'Sunrise' }, status: 'active', supportedRails: ['ach_standard'] },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Spritz treasury leg', () => {
  const calls: FetchCall[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    calls.length = 0;
    delete process.env.SPRITZ_SETTLEMENT_BANK_ACCOUNT_ID;
    delete process.env.SPRITZ_FUNDING_SOURCE_TOKEN;
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

  // ─── funding: ERP reserve -> USDC -> policy contract ──────────────────────

  it('funds the policy contract from an ERP reserve through maker/checker consensus, never a bank', async () => {
    vi.spyOn(CanonicalMoneyEngine, 'quote').mockResolvedValue({ action: 'dex_swap', tokenIn: PRB, targetAddress: USDC, poolAddress: '0xpool', amount: '10.00', targetAsset: 'USDC' } as any);
    const propose = vi.spyOn(CanonicalMoneyEngine, 'propose').mockResolvedValue({ requestId: 'CM-1', proposalId: 'PROP-1', route: { action: 'dex_swap' } } as any);
    stubSpritz(() => { throw new Error('Spritz must not be called for funding'); });

    const out = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, sourceToken: PRB, reference: 'FUND-1', createdBy: 'ops' });

    expect(propose).toHaveBeenCalledWith(expect.objectContaining({ sourceToken: PRB, amount: '10.00', targetAsset: 'USDC', recipient: POLICY, autoApprove: false }));
    expect(out).toMatchObject({ status: 'proposed', requestId: 'CM-1', proposalId: 'PROP-1', destination: POLICY, chainId: 8453 });
    expect(calls).toHaveLength(0);
  });

  it('refuses to fund when the ERP route has no canonical liquidity', async () => {
    vi.spyOn(CanonicalMoneyEngine, 'quote').mockResolvedValue({ action: 'dex_swap', tokenIn: PRB, poolAddress: null, note: 'No canonical liquidity pool found; create one first' } as any);
    const propose = vi.spyOn(CanonicalMoneyEngine, 'propose');
    await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, sourceToken: PRB, reference: 'FUND-2' }))
      .rejects.toMatchObject({ code: 'ERP_FUNDING_ROUTE_UNAVAILABLE' });
    expect(propose).not.toHaveBeenCalled();
  });

  it('requires an ERP funding source', async () => {
    await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, reference: 'FUND-3' }))
      .rejects.toMatchObject({ code: 'ERP_FUNDING_SOURCE_REQUIRED' });
  });

  it('returns the existing request for a repeated reference instead of re-proposing', async () => {
    vi.spyOn(CanonicalMoneyEngine, 'quote').mockResolvedValue({ action: 'mint_and_swap' } as any);
    const propose = vi.spyOn(CanonicalMoneyEngine, 'propose');
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ id: 'CM-9', proposal_id: 'PROP-9', status: 'pending' }], rowCount: 1 } as any);
    const out = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, sourceType: 'treasury', sourceAccountId: 'TRS-1', reference: 'FUND-9' });
    expect(out).toMatchObject({ requestId: 'CM-9', proposalId: 'PROP-9', idempotent: true });
    expect(propose).not.toHaveBeenCalled();
  });

  it('routes erp_policy_funding ramp proposals through the leg and rejects Spritz as an on-ramp', async () => {
    const fund = vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'proposed', requestId: 'CM-2' } as any);
    const out = await OnOffRampEngine._executeProvider({
      id: 'PROP-1',
      payload: { direction: 'reserve_to_canonical', provider: 'erp_policy_funding', amount: '25', sourceToken: PRB, reference: 'REF-1' },
    });
    expect(fund).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: '25', sourceToken: PRB, reference: 'REF-1' }));
    expect(out).toMatchObject({ requestId: 'CM-2' });

    await expect(OnOffRampEngine._executeProvider({ id: 'PROP-2', payload: { direction: 'onramp', provider: 'spritz', amount: '25' } }))
      .rejects.toMatchObject({ code: 'SPRITZ_NOT_A_FUNDING_SOURCE' });

    const providers = await OnOffRampEngine.providers();
    expect(providers.find((p: any) => p.id === 'spritz').directions).toEqual(['offramp']);
    expect(providers.find((p: any) => p.id === 'erp_policy_funding')).toBeTruthy();
  });

  it('books completed ERP funding requests once against the on-chain balance', async () => {
    vi.spyOn(TrustPolicyEngine, 'status').mockResolvedValue({ treasury: { token: USDC, balance: '10000000', reserved: '0', available: '10000000' } } as any);
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (/canonical_money_requests r/.test(sql)) {
        return { rows: [
          { id: 'CM-1', proposal_id: 'P-1', source_token: PRB, amount: '10.00', status: 'completed' },
          { id: 'CM-2', proposal_id: 'P-2', source_token: PRB, amount: '5.00', status: 'pending' },
        ], rowCount: 2 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-1' } as any);

    const out = await SpritzTreasuryLegEngine.reconcileFunding();

    expect(out.funded).toBe(true);
    expect(out.onChain.balanceUsd).toBe('10.000000');
    expect(out.erp).toMatchObject({ requestsToContract: 2, completed: 1, completedUsd: '10.00', pending: [{ id: 'CM-2', status: 'pending' }] });
    expect(post).toHaveBeenCalledTimes(1);
    const entry = post.mock.calls[0][0];
    expect(entry.referenceType).toBe('erp_policy_funding');
    expect(entry.referenceId).toBe('CM-1');
    expect(entry.lines).toEqual([
      expect.objectContaining({ accountCode: '1210', debitAmount: 10, creditAmount: 0 }),
      expect.objectContaining({ accountCode: '1100', debitAmount: 0, creditAmount: 10 }),
    ]);
  });

  // ─── payout: policy contract -> payout wallet -> Spritz -> settlement bank ─

  it('resolves DB NET MGMT as the settlement bank', async () => {
    stubSpritz((path) => {
      if (path === '/v1/bank-accounts/') return BANKS;
      throw new Error(`unexpected ${path}`);
    });
    const bank = await SpritzTreasuryLegEngine.settlementBank();
    expect(bank).toMatchObject({ id: 'ba_dbnet', institution: 'Column' });
  });

  it('refuses to stage a payout when the payout wallet is not allow-listed on the policy contract', async () => {
    vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: false, frozen: false } as any);
    const propose = vi.spyOn(TrustPolicyEngine, 'propose');
    stubSpritz(() => { throw new Error('Spritz must not be called'); });

    await expect(SpritzTreasuryLegEngine.stagePayout({ amountUsd: 100, purpose: 'distribution', reference: 'PAY-1' }))
      .rejects.toMatchObject({ code: 'PAYOUT_WALLET_NOT_ALLOWLISTED' });
    expect(propose).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('refuses to pay out to any bank other than the settlement bank', async () => {
    vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: true, frozen: false } as any);
    const propose = vi.spyOn(TrustPolicyEngine, 'propose');
    stubSpritz((path) => {
      if (path === '/v1/bank-accounts/') return BANKS;
      throw new Error(`unexpected ${path}`);
    });
    await expect(SpritzTreasuryLegEngine.stagePayout({ bankAccountId: 'ba_other', amountUsd: 100, purpose: 'distribution', reference: 'PAY-X' }))
      .rejects.toMatchObject({ code: 'SPRITZ_SETTLEMENT_BANK_MISMATCH' });
    expect(propose).not.toHaveBeenCalled();
  });

  it('stages a payout as a Spritz quote to the settlement bank plus a governed distribution for the quoted USDC input', async () => {
    vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: true, frozen: false } as any);
    const propose = vi.spyOn(TrustPolicyEngine, 'propose').mockResolvedValue({ distributionId: '7', status: 'proposed' } as any);
    stubSpritz((path) => {
      if (path === '/v1/bank-accounts/') return BANKS;
      if (path === '/v1/off-ramp-quotes/') return { id: 'q_1', requiredTokenInput: '100500000' };
      throw new Error(`unexpected ${path}`);
    });

    const out = await SpritzTreasuryLegEngine.stagePayout({ amountUsd: 100, purpose: 'distribution', reference: 'PAY-2', rail: 'rtp' });

    const quote = calls.find(c => c.url.endsWith('/v1/off-ramp-quotes/'))!;
    expect(JSON.parse(quote.init.body as string)).toMatchObject({ accountId: 'ba_dbnet', amount: '100.00', chain: 'base', tokenAddress: USDC, rail: 'rtp', amountMode: 'output' });
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({ beneficiary: PAYOUT, quantity: '100500000', purpose: 'distribution', reference: 'PAY-2' }));
    expect(out).toMatchObject({ status: 'proposed', spritzQuoteId: 'q_1', quantityUnits: '100500000', settlementBank: { id: 'ba_dbnet' }, distribution: { distributionId: '7' } });
  });
});

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
process.env.DAPP_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.SPRITZ_PAYOUT_WALLET = PAYOUT;

const pool = require('../server/integrations/bonds/pgPool');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');
const { CanonicalMoneyEngine } = require('../server/integrations/dapp/canonicalMoneyEngine');
const { TrustAllocationEngine } = require('../server/integrations/dapp/trustAllocationEngine');
const { SpritzTreasuryLegEngine, usdToUnits, unitsToUsd, DEFAULT_SPRITZ_PAYOUT_WALLET } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { ExternalWalletEngine } = require('../server/integrations/dapp/externalWalletEngine');
const { SpritzEngine } = require('../server/integrations/spritz/spritzEngine');
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
    delete process.env.TRUST_ALLOCATION_BENEFICIARY_WALLETS;
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

  it('defaults the payout wallet to the Coinbase Spritz wallet as an external signer, and connect registers it', async () => {
    const COINBASE = '0xA0f8C3d9e4fE7F531968b11f1Ce298F56483040F';
    expect(DEFAULT_SPRITZ_PAYOUT_WALLET).toBe(COINBASE);
    delete process.env.SPRITZ_PAYOUT_WALLET;
    try {
      expect(SpritzTreasuryLegEngine.config()).toMatchObject({ payoutWallet: COINBASE, payoutWalletSigner: 'external', payoutWalletProvider: 'coinbase' });

      const register = vi.spyOn(ExternalWalletEngine, 'register').mockResolvedValue({ id: 'EW-1', type: 'coinbase', address: COINBASE.toLowerCase(), label: 'coinbase Spritz payout wallet' } as any);
      vi.spyOn(ExternalWalletEngine, 'getWalletByAddress').mockResolvedValue({ id: 'EW-1', type: 'coinbase', label: 'coinbase Spritz payout wallet', created_at: 'now' } as any);
      vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: true, frozen: false } as any);

      const out = await SpritzTreasuryLegEngine.connectPayoutWallet({ createdBy: 'trustee' });
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: 'coinbase', address: COINBASE, createdBy: 'trustee' }));
      expect(out).toMatchObject({ address: COINBASE, configured: true, signer: { type: 'external', provider: 'coinbase' }, registry: { id: 'EW-1', type: 'coinbase' }, ready: true, issues: [], registered: { id: 'EW-1' } });

      await expect(SpritzTreasuryLegEngine.connectPayoutWallet({ address: 'not-an-address' })).rejects.toThrow(/valid EVM address/);
    } finally {
      process.env.SPRITZ_PAYOUT_WALLET = PAYOUT;
    }
  });

  it('executePayout with the external payout wallet returns the unsigned Spritz payment instead of signing; confirmPayout books it', async () => {
    const COINBASE = '0xA0f8C3d9e4fE7F531968b11f1Ce298F56483040F';
    process.env.SPRITZ_PAYOUT_WALLET = COINBASE;
    try {
      const release = vi.spyOn(TrustPolicyEngine, 'execute').mockResolvedValue({ txHash: '0xrelease' } as any);
      const exec = vi.spyOn(SpritzEngine, 'executeQuote');
      const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-GL-9' } as any);
      const mark = vi.spyOn(TrustAllocationEngine, 'markExecuted').mockResolvedValue(null as any);
      stubSpritz((path) => {
        if (path === '/v1/off-ramp-quotes/q_9/transaction') return { type: 'evm', contractAddress: '0x' + '22'.repeat(20), calldata: '0xbeef', inputToken: USDC, requiredTokenInput: '100000000' };
        if (path === '/v1/off-ramp-quotes/q_9') return { id: 'q_9', status: 'created', output: { amount: '100.00' }, input: { amount: '101.00' } };
        throw new Error(`unexpected ${path}`);
      });

      const out = await SpritzTreasuryLegEngine.executePayout({ distributionId: 7, spritzQuoteId: 'q_9', reference: 'REF-9', amountUsd: 100, createdBy: 'ops' });
      expect(release).toHaveBeenCalledWith({ distributionId: 7 });
      expect(exec).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(out).toMatchObject({ status: 'awaiting_signature', payoutWallet: COINBASE, signer: { type: 'external', provider: 'coinbase' }, unsignedTx: { senderAddress: COINBASE, payment: { data: '0xbeef' } } });

      const txHash = '0x' + 'cd'.repeat(32);
      const booked = await SpritzTreasuryLegEngine.confirmPayout({ distributionId: 7, spritzQuoteId: 'q_9', txHash, reference: 'REF-9', amountUsd: 100, createdBy: 'ops' });
      expect(booked).toMatchObject({ status: 'settling', txHash, spritzQuoteId: 'q_9', amountUsd: '100.00' });
      expect(post).toHaveBeenCalledTimes(1);
      expect(mark).toHaveBeenCalledWith('REF-9');
      await expect(SpritzTreasuryLegEngine.confirmPayout({ distributionId: 7, spritzQuoteId: 'q_9', reference: 'REF-9', txHash: '0x12' })).rejects.toThrow(/txHash required/);
    } finally {
      process.env.SPRITZ_PAYOUT_WALLET = PAYOUT;
    }
  });

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

  it('segregates coupon income from trust operating: a bucket is funded only from its own source, and the source pins the bucket', async () => {
    const TREASURY = '0x5d3192581e6f12eeecc0fd414ef5672a454f611c';
    process.env.DLB_PRB_TOKEN_ADDRESS = PRB;
    process.env.DLB_TREASURY_TOKEN_ADDRESS = TREASURY;
    process.env.SPRITZ_FUNDING_SOURCE_TYPE = 'treasury';
    process.env.SPRITZ_FUNDING_SOURCE_ACCOUNT = 'TRS-1';
    try {
      const quote = vi.spyOn(CanonicalMoneyEngine, 'quote').mockResolvedValue({ action: 'mint_and_swap' } as any);
      const propose = vi.spyOn(CanonicalMoneyEngine, 'propose').mockResolvedValue({ requestId: 'CM-1', proposalId: 'PROP-1', route: {} } as any);

      await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, bucket: 'coupon_income', sourceToken: TREASURY, reference: 'MIX-1' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH', status: 409 });
      await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, bucket: 'trust_operating', sourceModule: 'bond_portfolio', reference: 'MIX-2' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
      await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, bucket: 'trust_operating', sourceType: 'treasury', sourceAccountId: 'TRS-1', reference: 'MIX-3' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
      await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, sourceToken: PRB, sourceModule: 'treasury', reference: 'MIX-4' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
      expect(quote).not.toHaveBeenCalled();
      expect(propose).not.toHaveBeenCalled();

      // Bucket alone resolves its own source; the SPRITZ_FUNDING_SOURCE_* default is not consulted.
      const coupon = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, bucket: 'coupon_income', reference: 'CPN-1' });
      expect(coupon).toMatchObject({ bucket: 'coupon_income', source: { sourceToken: PRB, sourceModule: 'bond_portfolio' } });
      expect(propose).toHaveBeenLastCalledWith(expect.objectContaining({ sourceToken: PRB, sourceModule: 'bond_portfolio', sourceType: undefined, title: expect.stringContaining('coupon_income') }));

      // A bucket source alone pins the bucket.
      const operating = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, sourceToken: TREASURY, reference: 'OPS-1' });
      expect(operating).toMatchObject({ bucket: 'trust_operating', source: { sourceToken: TREASURY, sourceModule: 'treasury' } });

      // Un-bucketed ledger funding still works from the configured default.
      const ledger = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, reference: 'LEDGER-1' });
      expect(ledger).toMatchObject({ bucket: null, source: { sourceType: 'treasury', sourceAccountId: 'TRS-1' } });

      const sources = await TrustAllocationEngine.fundingSources({ quote: (q: any) => CanonicalMoneyEngine.quote(q) });
      expect(sources).toEqual([
        expect.objectContaining({ bucket: 'coupon_income', sourceToken: PRB, sourceModule: 'bond_portfolio', configured: true, executable: true, payeeRole: 'beneficiary' }),
        expect.objectContaining({ bucket: 'trust_operating', sourceToken: TREASURY, sourceModule: 'treasury', configured: true, executable: true, payeeRole: 'trustee' }),
      ]);
    } finally {
      delete process.env.DLB_PRB_TOKEN_ADDRESS;
      delete process.env.DLB_TREASURY_TOKEN_ADDRESS;
      delete process.env.SPRITZ_FUNDING_SOURCE_TYPE;
      delete process.env.SPRITZ_FUNDING_SOURCE_ACCOUNT;
    }
  });

  it('funds a bucket from its Treasury-Core ERP GL account with no DEX pool, and keeps the two GL accounts segregated', async () => {
    process.env.COUPON_INCOME_GL_ACCOUNT_CODE = '1105';
    process.env.TRUST_OPERATING_GL_ACCOUNT_CODE = '1110';
    process.env.DLB_PRB_TOKEN_ADDRESS = PRB;
    try {
      const propose = vi.spyOn(CanonicalMoneyEngine, 'propose').mockResolvedValue({ requestId: 'CM-1', proposalId: 'PROP-1', route: { action: 'erp_treasury' } } as any);

      // Real _pickRoute: the canonical source routes through the ERP, never a pool.
      const route = await CanonicalMoneyEngine.quote({ sourceType: 'canonical', sourceAccountId: '1105', sourceModule: 'bond_portfolio', amount: '1', targetAsset: 'USDC' });
      expect(route).toMatchObject({ action: 'erp_treasury', sourceAccountId: '1105', glAccounts: { cash: '1105' } });
      expect(route.poolAddress).toBeUndefined();
      expect(TrustAllocationEngine.routeExecutable(route)).toBe(true);

      // Bucket resolves to its GL account (GL wins over the module token).
      expect(TrustAllocationEngine.fundingSource('coupon_income')).toEqual({ sourceType: 'canonical', sourceAccountId: '1105', sourceModule: 'bond_portfolio' });
      const coupon = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, bucket: 'coupon_income', reference: 'ERP-1' });
      expect(coupon).toMatchObject({ bucket: 'coupon_income', source: { sourceType: 'canonical', sourceAccountId: '1105' } });
      expect(propose).toHaveBeenLastCalledWith(expect.objectContaining({ sourceType: 'canonical', sourceAccountId: '1105', recipient: POLICY }));

      // The GL account alone pins the bucket; the other bucket's GL account is refused.
      const ops = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, sourceType: 'canonical', sourceAccountId: '1110', reference: 'ERP-2' });
      expect(ops).toMatchObject({ bucket: 'trust_operating' });
      await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, bucket: 'coupon_income', sourceType: 'canonical', sourceAccountId: '1110', reference: 'ERP-3' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
      await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, bucket: 'trust_operating', sourceType: 'canonical', sourceAccountId: '9999', reference: 'ERP-4' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
      await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, sourceType: 'canonical', sourceAccountId: '1105', sourceModule: 'treasury', reference: 'ERP-5' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
      expect(propose).toHaveBeenCalledTimes(2);

      const sources = await TrustAllocationEngine.fundingSources({ quote: (q: any) => CanonicalMoneyEngine.quote(q) });
      expect(sources).toEqual([
        expect.objectContaining({ bucket: 'coupon_income', liquidity: 'treasury_core_erp', glAccountCode: '1105', configured: true, executable: true }),
        expect.objectContaining({ bucket: 'trust_operating', liquidity: 'treasury_core_erp', glAccountCode: '1110', configured: true, executable: true }),
      ]);
    } finally {
      delete process.env.COUPON_INCOME_GL_ACCOUNT_CODE;
      delete process.env.TRUST_OPERATING_GL_ACCOUNT_CODE;
      delete process.env.DLB_PRB_TOKEN_ADDRESS;
    }
  });

  it('refuses to fund when the ERP route has no canonical liquidity', async () => {
    vi.spyOn(CanonicalMoneyEngine, 'quote').mockResolvedValue({ action: 'dex_swap', tokenIn: PRB, poolAddress: null, note: 'No canonical liquidity pool found; create one first' } as any);
    const propose = vi.spyOn(CanonicalMoneyEngine, 'propose');
    await expect(SpritzTreasuryLegEngine.fund({ amountUsd: 10, sourceToken: PRB, reference: 'FUND-2' }))
      .rejects.toMatchObject({ code: 'ERP_FUNDING_ROUTE_UNAVAILABLE' });
    expect(propose).not.toHaveBeenCalled();
  });

  it('defaults the funding source to the Treasury-Core ERP canonical GL cash account, never a bank', async () => {
    const quote = vi.spyOn(CanonicalMoneyEngine, 'quote').mockResolvedValue({ action: 'erp_treasury', sourceType: 'canonical', sourceAccountId: '1000', amount: '10.00', targetAsset: 'USDC', live: false } as any);
    const propose = vi.spyOn(CanonicalMoneyEngine, 'propose').mockResolvedValue({ requestId: 'CM-3', proposalId: 'PROP-3', route: { action: 'erp_treasury' } } as any);
    stubSpritz(() => { throw new Error('Spritz must not be called for funding'); });

    expect(SpritzTreasuryLegEngine.config().fundingSource).toMatchObject({ kind: 'treasury_core_erp', sourceType: 'canonical', sourceAccountId: '1000' });
    const out = await SpritzTreasuryLegEngine.fund({ amountUsd: 10, reference: 'FUND-3', createdBy: 'ops' });

    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'canonical', sourceAccountId: '1000' }));
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'canonical', sourceAccountId: '1000', recipient: POLICY }));
    expect(out).toMatchObject({ requestId: 'CM-3', source: expect.objectContaining({ sourceType: 'canonical', sourceAccountId: '1000' }) });
    expect(calls).toHaveLength(0);
  });

  it('stages a payout to a linked Spritz bill on the bill_pay rail when the trust has no settlement bank', async () => {
    process.env.TRUST_ALLOCATION_BENEFICIARY_WALLETS = PAYOUT;
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (/FROM coupon_payments/.test(sql)) return { rows: [{ total: '83333.33' }], rowCount: 1 } as any;
      return { rows: [], rowCount: 0 } as any;
    });
    vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: true, frozen: false } as any);
    vi.spyOn(TrustPolicyEngine, 'propose').mockResolvedValue({ distributionId: '9', status: 'proposed' } as any);
    stubSpritz((path) => {
      if (path === '/v1/bank-accounts/') return [];
      if (path === '/v1/bills/') return [{ id: 'bill_1', status: 'active', name: 'Chase Sapphire', type: 'credit_card', institution: { name: 'Chase' }, accountNumberLast4: '1234' }];
      if (path === '/v1/off-ramp-quotes/') return { id: 'q_bill', requiredTokenInput: '101000000' };
      throw new Error(`unexpected ${path}`);
    });

    const out = await SpritzTreasuryLegEngine.stagePayout({ amountUsd: 100, purpose: 'distribution', reference: 'PAY-BILL' });

    const quote = calls.find(c => c.url.endsWith('/v1/off-ramp-quotes/'))!;
    expect(JSON.parse(quote.init.body as string)).toMatchObject({ accountId: 'bill_1', rail: 'bill_pay', amount: '100.00', chain: 'base' });
    expect(out).toMatchObject({ rail: 'bill_pay', settlementBank: null, destination: { kind: 'bill', bill: { id: 'bill_1', institution: 'Chase' } }, spritzQuoteId: 'q_bill' });
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
    process.env.TRUST_ALLOCATION_BENEFICIARY_WALLETS = PAYOUT;
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (/FROM coupon_payments/.test(sql)) return { rows: [{ total: '83333.33' }], rowCount: 1 } as any;
      return { rows: [], rowCount: 0 } as any;
    });
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
    expect(out).toMatchObject({ status: 'proposed', bucket: 'coupon_income', spritzQuoteId: 'q_1', quantityUnits: '100500000', settlementBank: { id: 'ba_dbnet' }, distribution: { distributionId: '7' } });
  });

  it('prepareAllowlistPayoutWallet encodes owner-only setBeneficiary/setBeneficiaryLimits for the trustee owner without submitting', async () => {
    const OWNER = '0xD7Fa15572dc6553FEaC54E2304E42dce82443cb0';
    vi.spyOn(TrustPolicyEngine, 'owner').mockResolvedValue(OWNER);
    vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: false, frozen: false, remainingPeriodAllowance: {} } as any);
    const write = vi.spyOn(TrustPolicyEngine as any, '_write');

    const out = await SpritzTreasuryLegEngine.prepareAllowlistPayoutWallet({ maxPerDistributionUsd: '500', periodCapUsd: '2000', periodSeconds: 2592000 });

    expect(write).not.toHaveBeenCalled();
    expect(out).toMatchObject({ owner: OWNER, beneficiary: PAYOUT, token: USDC, alreadyAllowed: false, serverWalletIsOwner: false, chainId: 8453 });
    expect(out.txs.map((t: any) => t.action)).toEqual(['setBeneficiary', 'setBeneficiaryLimits']);
    for (const tx of out.txs) {
      expect(tx.from).toBe(OWNER);
      expect(tx.to).toBe(POLICY);
      expect(tx.data).toMatch(/^0x[0-9a-f]+$/i);
    }
    expect(out.txs[1].call.params).toEqual([PAYOUT, USDC, '500000000', '2000000000', 2592000]);
    expect(JSON.stringify(out)).toBeTruthy();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TREASURY = '0x4b2e9C1D6f8A0b3c5D7e9F1a2B3c4D5e6F708192';

process.env.DAPP_MEMORY_MODE = 'true';
process.env.SPRITZ_API_KEY = 'test-key';
process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
process.env.THIRDWEB_SERVER_WALLET_ADDRESS = TREASURY;
process.env.THIRDWEB_SETTLEMENT_TOKEN = USDC;
process.env.THIRDWEB_CHAIN_ID = '8453';
process.env.DAPP_CHAIN_ID = '8453';
process.env.SPRITZ_PAYOUT_WALLET = TREASURY;
process.env.TREASURY_TOPUP_HOLD_ACCOUNT_ID = '1000';

const { ThirdwebOnrampBillPayPipeline } = require('../server/integrations/spritz/thirdwebOnrampBillPayPipeline');
const { SpritzBillPayEngine } = require('../server/integrations/spritz/spritzBillPayEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { ThirdwebTreasuryFundingEngine } = require('../server/integrations/dapp/thirdwebTreasuryFundingEngine');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { VendorPaymentEngine } = require('../server/integrations/dapp/vendorPaymentEngine');
const { CanonicalConsensusEngine } = require('../server/integrations/dapp/canonicalConsensusEngine');

const BILL = { id: 'bill_chase', status: 'active', name: 'Chase Sapphire', type: 'credit_card', institution: 'Chase', accountNumberLast4: '1234', payable: true, liability: { nextPaymentDueDate: '2026-10-01' } };

describe('thirdweb on-ramp -> server wallet -> Spritz bill pay pipeline', () => {
  let balance: number | null;
  let topUpStatus: string;
  let proposalStatus: string;
  const created: any[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    ThirdwebOnrampBillPayPipeline._resetMemory();
    created.length = 0;
    balance = 0;
    topUpStatus = 'PENDING';
    proposalStatus = 'pending';

    vi.spyOn(SpritzBillPayEngine, 'quote').mockResolvedValue({ quoteId: 'q_1', status: 'created', amountUsd: 250, feeUsd: 2.5, inputUsd: 252.5, expiresAt: null, bill: BILL });
    vi.spyOn(SpritzTreasuryLegEngine, 'payoutWalletUsdcBalance').mockImplementation(async () => (balance === null ? null : balance.toFixed(2)));
    vi.spyOn(ThirdwebTreasuryFundingEngine, 'createTopUp').mockImplementation(async (args: any) => ({
      id: 'TWTOP-1', paymentId: 'pay_1', link: 'https://checkout.thirdweb.com/pay_1', amountFiat: args.amountFiat, status: 'PENDING', booked: false,
    }));
    vi.spyOn(ThirdwebTreasuryFundingEngine, 'syncTopUp').mockImplementation(async () => {
      if (topUpStatus === 'COMPLETED') balance = 300;
      return { id: 'TWTOP-1', status: topUpStatus, booked: topUpStatus === 'COMPLETED', transactionHash: topUpStatus === 'COMPLETED' ? '0xtop' : null };
    });
    vi.spyOn(VendorPaymentEngine, 'listVendors').mockResolvedValue([]);
    vi.spyOn(VendorPaymentEngine, 'createVendor').mockResolvedValue({ vendor_id: 'VENDOR-1', name: 'Chase Chase Sapphire', metadata: { spritzBillId: 'bill_chase' } });
    vi.spyOn(VendorPaymentEngine, 'getVendor').mockResolvedValue({ vendor_id: 'VENDOR-1', name: 'Chase Chase Sapphire', metadata: { spritzBillId: 'bill_chase' } });
    vi.spyOn(VendorPaymentEngine, 'createBill').mockImplementation(async (args: any) => ({ bill_id: 'BILL-1', vendor_id: args.vendorId, amount_cents: Math.round(args.amount * 100), memo: args.memo, metadata: args.metadata }));
    vi.spyOn(CanonicalConsensusEngine, 'createProposal').mockImplementation(async (args: any) => { created.push(args); return { id: 'PROP-1', status: 'pending', payload: args.payload }; });
    vi.spyOn(CanonicalConsensusEngine, 'getProposal').mockImplementation(async () => ({
      id: 'PROP-1', status: proposalStatus,
      result: proposalStatus === 'executed' ? { payment: { paymentId: 'SBP-1', status: 'settling', txHash: '0xpaid' } } : proposalStatus === 'failed' ? { error: 'PAYOUT_WALLET_UNDERFUNDED' } : {},
    }));
  });

  it('is ready only when the payout wallet is the thirdweb server wallet', async () => {
    const r = await ThirdwebOnrampBillPayPipeline.readiness();
    expect(r).toMatchObject({ ready: true, payoutWallet: TREASURY, payoutWalletSigner: 'thirdweb', fundingMode: 'treasury_wallet', topUp: { provider: 'thirdweb-bridge', canTopUp: true } });
  });

  it('opens a top-up for the exact USDC shortfall, waits for it, then stages a treasury_wallet vendor bill for maker/checker and reports the paid bill', async () => {
    balance = 52.5;
    const p = await ThirdwebOnrampBillPayPipeline.start({ spritzBillId: 'bill_chase', amountUsd: 250, topUp: { sourceType: 'canonical', sourceAccountId: '1000' }, createdBy: 'trustee@dlb' });

    expect(ThirdwebTreasuryFundingEngine.createTopUp).toHaveBeenCalledWith(expect.objectContaining({ amountFiat: 200, sourceType: 'canonical', sourceAccountId: '1000', tokenAddress: USDC, chainId: 8453, requestedBy: 'trustee@dlb' }));
    expect(p).toMatchObject({ status: 'awaiting_topup', requiredUsd: 252.5, walletBalanceUsd: 52.5, topUpId: 'TWTOP-1', proposalId: null, checkoutLink: 'https://checkout.thirdweb.com/pay_1', wallet: TREASURY });
    expect(created).toHaveLength(0);

    // Checkout not finished yet: nothing is staged.
    let a = await ThirdwebOnrampBillPayPipeline.advance(p.id);
    expect(a).toMatchObject({ status: 'awaiting_topup', proposalId: null });
    expect(created).toHaveLength(0);

    // thirdweb delivers the USDC and the top-up is booked -> proposal staged.
    topUpStatus = 'COMPLETED';
    a = await ThirdwebOnrampBillPayPipeline.advance(p.id);
    expect(a).toMatchObject({ status: 'awaiting_approval', proposalId: 'PROP-1', vendorBillId: 'BILL-1', walletBalanceUsd: 300, checkoutLink: null });
    expect(created[0]).toMatchObject({ category: 'vendor_bill', createdBy: 'trustee@dlb', payload: { vendorPaymentBillId: 'BILL-1', rail: 'spritz_bill_pay', spritzBillId: 'bill_chase', fundingMode: 'treasury_wallet', fundingSource: { kind: 'treasury_wallet', wallet: TREASURY, assetAccountCode: '1210', topUpId: 'TWTOP-1' }, amount: 250 } });
    expect(VendorPaymentEngine.createBill).toHaveBeenCalledWith(expect.objectContaining({ vendorId: 'VENDOR-1', amount: 250, metadata: expect.objectContaining({ fundingMode: 'treasury_wallet', pipelineId: p.id }) }));

    // Signatures pending: stays put, no second proposal or sync.
    a = await ThirdwebOnrampBillPayPipeline.advance(p.id);
    expect(a.status).toBe('awaiting_approval');
    expect(created).toHaveLength(1);
    expect(ThirdwebTreasuryFundingEngine.syncTopUp).toHaveBeenCalledTimes(2);

    proposalStatus = 'executed';
    a = await ThirdwebOnrampBillPayPipeline.advance(p.id);
    expect(a).toMatchObject({ status: 'paid', nextAction: null, metadata: { payment: { paymentId: 'SBP-1', txHash: '0xpaid' } } });
    expect(a.metadata.history.map((h: any) => h.status)).toEqual(['awaiting_topup', 'awaiting_topup', 'awaiting_approval', 'awaiting_approval', 'paid']);

    // Terminal: advance is a no-op.
    expect(await ThirdwebOnrampBillPayPipeline.advance(p.id)).toMatchObject({ status: 'paid' });
    expect(ThirdwebTreasuryFundingEngine.syncTopUp).toHaveBeenCalledTimes(2);
  });

  it('skips the top-up and stages the proposal immediately when the wallet already holds the gross quote', async () => {
    balance = 1000;
    const p = await ThirdwebOnrampBillPayPipeline.start({ spritzBillId: 'bill_chase', amountUsd: 250, createdBy: 'trustee@dlb' });
    expect(ThirdwebTreasuryFundingEngine.createTopUp).not.toHaveBeenCalled();
    expect(p).toMatchObject({ status: 'awaiting_approval', topUpId: null, proposalId: 'PROP-1', checkoutLink: null, metadata: { shortfallUsd: 0 } });
  });

  it('marks the run topup_failed when thirdweb reports FAILED and never stages a proposal', async () => {
    const p = await ThirdwebOnrampBillPayPipeline.start({ spritzBillId: 'bill_chase', amountUsd: 250, topUp: { sourceAccountId: '1000' } });
    topUpStatus = 'FAILED';
    const a = await ThirdwebOnrampBillPayPipeline.advance(p.id);
    expect(a).toMatchObject({ status: 'topup_failed', proposalId: null });
    expect(created).toHaveLength(0);
  });

  it('holds at awaiting_funds when the completed top-up still leaves the wallet short, and surfaces a failed proposal', async () => {
    balance = 10;
    const p = await ThirdwebOnrampBillPayPipeline.start({ spritzBillId: 'bill_chase', amountUsd: 250, topUp: { amountFiat: 500, sourceAccountId: '1000' } });
    expect(ThirdwebTreasuryFundingEngine.createTopUp).toHaveBeenCalledWith(expect.objectContaining({ amountFiat: 500 }));
    await expect(ThirdwebOnrampBillPayPipeline.start({ spritzBillId: 'bill_chase', amountUsd: 250, topUp: { amountFiat: 5, sourceAccountId: '1000' } })).rejects.toMatchObject({ code: 'TOPUP_TOO_SMALL' });

    topUpStatus = 'COMPLETED';
    (ThirdwebTreasuryFundingEngine.syncTopUp as any).mockImplementation(async () => ({ id: 'TWTOP-1', status: 'COMPLETED', booked: true }));
    balance = 100;
    let a = await ThirdwebOnrampBillPayPipeline.advance(p.id);
    expect(a).toMatchObject({ status: 'awaiting_funds', proposalId: null, walletBalanceUsd: 100 });

    balance = 300;
    a = await ThirdwebOnrampBillPayPipeline.advance(p.id);
    expect(a).toMatchObject({ status: 'awaiting_approval', proposalId: 'PROP-1' });

    proposalStatus = 'failed';
    a = await ThirdwebOnrampBillPayPipeline.advance(p.id);
    expect(a).toMatchObject({ status: 'failed', metadata: { proposalError: 'PAYOUT_WALLET_UNDERFUNDED' } });
  });

  it('refuses to start when the payout wallet is not the thirdweb server wallet', async () => {
    process.env.SPRITZ_PAYOUT_WALLET = '0xA0f8C3d9e4fE7F531968b11f1Ce298F56483040F';
    try {
      await expect(ThirdwebOnrampBillPayPipeline.start({ spritzBillId: 'bill_chase', amountUsd: 250 })).rejects.toMatchObject({ code: 'PAYOUT_SIGNER_MISMATCH' });
      expect((await ThirdwebOnrampBillPayPipeline.readiness()).ready).toBe(false);
    } finally {
      process.env.SPRITZ_PAYOUT_WALLET = TREASURY;
    }
  });

  it('reads the thirdweb server wallet USDC through the thirdweb API', async () => {
    (SpritzTreasuryLegEngine.payoutWalletUsdcBalance as any).mockRestore();
    const bal = vi.spyOn(ThirdwebServerWalletEngine, 'balance').mockResolvedValue([{ chainId: 8453, tokenAddress: USDC, symbol: 'USDC', decimals: 6, value: '252500000', displayValue: '252.5' }]);
    expect(await SpritzTreasuryLegEngine.payoutWalletUsdcBalance({ address: TREASURY })).toBe('252.500000');
    expect(bal).toHaveBeenCalledWith({ address: TREASURY, chainId: 8453, tokenAddress: USDC });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYOUT = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';

process.env.SPRITZ_API_KEY = 'test-key';
process.env.SPRITZ_API_BASE_URL = 'https://platform.spritz.finance';
process.env.TRUST_POLICY_ADDRESS = '0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64';
process.env.THIRDWEB_SETTLEMENT_TOKEN = USDC;
process.env.THIRDWEB_CHAIN_ID = '8453';
process.env.DAPP_CHAIN_ID = '8453';
process.env.DAPP_OPERATOR_ADDRESS = PAYOUT;
process.env.DAPP_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.SPRITZ_PAYOUT_WALLET = PAYOUT;

const pool = require('../server/integrations/bonds/pgPool');
const { SpritzEngine } = require('../server/integrations/spritz/spritzEngine');
const { SpritzBillPayEngine } = require('../server/integrations/spritz/spritzBillPayEngine');
const { CanonicalFundingSource } = require('../server/integrations/fineract/canonicalFundingSource');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { VendorPaymentEngine } = require('../server/integrations/dapp/vendorPaymentEngine');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const { CanonicalConsensusEngine } = require('../server/integrations/dapp/canonicalConsensusEngine');

type FetchCall = { url: string; init: RequestInit };

const BILLS = [
  { id: 'bill_chase', status: 'active', name: 'Chase Sapphire', type: 'credit_card', institution: { name: 'Chase' }, accountNumberLast4: '1234', currency: 'USD', liability: { amountDue: '250.00' } },
  { id: 'bill_pending', status: 'action_required', name: 'ComEd', type: 'utility', institution: { name: 'ComEd' }, unpayableCode: 'verification_required' },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Spritz Bill Pay from the Treasury-Core ERP', () => {
  const calls: FetchCall[] = [];
  const saved: any[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    calls.length = 0;
    saved.length = 0;
    delete process.env.SPRITZ_BILLPAY_LIVE;
    delete process.env.CANONICAL_FUNDING_LIVE;
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      if (/INSERT INTO spritz_bill_payments/.test(sql)) {
        const row = { payment_id: params![0], run_id: params![1], vendor_bill_id: params![2], spritz_bill_id: params![3], spritz_quote_id: params![4], spritz_offramp_id: params![5], tx_hash: params![6], amount_usd: params![7], fee_usd: params![8], erp_cash_account: params![9], erp_journal_entry_id: params![10], gl_journal_entry_id: params![11], status: params![12], payer_wallet: params![13], memo: params![14], metadata: JSON.parse(params![15]), created_by: params![16] };
        saved.push(row);
        return { rows: [row], rowCount: 1 } as any;
      }
      return { rows: [], rowCount: 0 } as any;
    });
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

  it('reports the ERP canonical GL as the only funding source and lists payable bills', async () => {
    stubSpritz((path) => {
      if (path === '/v1/bills/') return BILLS;
      if (path === '/v1/capabilities') return [{ product: 'crypto_to_fiat', method: 'bill_pay', status: 'active' }];
      throw new Error(`unexpected ${path}`);
    });
    const r = await SpritzBillPayEngine.readiness();
    expect(r.fundingSource).toMatchObject({ kind: 'treasury_core_erp', sourceType: 'canonical', cashAccountCode: '1000', assetAccountCode: '1210' });
    expect(r.mode).toBe('shadow');
    expect(r.bills.map((b: any) => [b.id, b.payable])).toEqual([['bill_chase', true], ['bill_pending', false]]);
    expect(r.issues).toEqual([]);
  });

  it('activates Bill Pay with the operator consent and client context Spritz requires', async () => {
    stubSpritz((path) => {
      if (path === '/v1/bills/activate') return { status: 'verification_required', activationId: 'act_1' };
      throw new Error(`unexpected ${path}`);
    });
    const r = await SpritzEngine.activateBills({ clientContext: { clientIp: '203.0.113.7', userAgent: 'vitest', sessionId: 'sess_1' } });
    expect(r).toMatchObject({ status: 'verification_required', activationId: 'act_1' });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.consent).toMatchObject({ termsText: expect.any(String), termsTextVersion: expect.any(String), acceptedAt: expect.any(String) });
    expect(body.clientContext).toEqual({ clientIp: '203.0.113.7', platform: 'web', userAgent: 'vitest', sessionId: 'sess_1' });

    await expect(SpritzEngine.activateBills({})).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it('quotes a linked bill on the bill_pay rail and refuses unpayable bills', async () => {
    stubSpritz((path) => {
      if (path === '/v1/bills/') return BILLS;
      if (path === '/v1/off-ramp-quotes/') return { id: 'q_bill', status: 'created', input: { amount: '252.50' }, output: { amount: '250.00', rail: 'bill_pay', accountId: 'bill_chase' } };
      throw new Error(`unexpected ${path}`);
    });
    const q = await SpritzBillPayEngine.quote({ spritzBillId: 'bill_chase', amountUsd: 250 });
    const body = JSON.parse(calls.find(c => c.url.endsWith('/v1/off-ramp-quotes/'))!.init.body as string);
    expect(body).toMatchObject({ accountId: 'bill_chase', rail: 'bill_pay', amount: '250.00', amountMode: 'output', chain: 'base', tokenAddress: USDC });
    expect(q).toMatchObject({ quoteId: 'q_bill', amountUsd: 250, feeUsd: 2.5, bill: { id: 'bill_chase', institution: 'Chase' } });

    await expect(SpritzBillPayEngine.quote({ spritzBillId: 'bill_pending', amountUsd: 10 })).rejects.toMatchObject({ code: 'SPRITZ_BILL_NOT_PAYABLE' });
    await expect(SpritzBillPayEngine.quote({ spritzBillId: 'nope', amountUsd: 10 })).rejects.toMatchObject({ code: 'SPRITZ_BILL_NOT_FOUND' });
  });

  it('shadows a bill payment: draws the plan from the ERP cash account, quotes Spritz, never sends on-chain', async () => {
    const commit = vi.spyOn(CanonicalFundingSource, 'commit').mockResolvedValue({ shadow: true, committed: false, accountCode: '1000', assetAccountCode: '1210', reason: 'CANONICAL_FUNDING_LIVE=false' } as any);
    const exec = vi.spyOn(SpritzEngine, 'executeQuote');
    stubSpritz((path) => {
      if (path === '/v1/bills/') return BILLS;
      if (path === '/v1/off-ramp-quotes/') return { id: 'q_shadow', status: 'created', input: { amount: '252.50' }, output: { amount: '250.00' } };
      throw new Error(`unexpected ${path}`);
    });

    const out = await SpritzBillPayEngine.pay({ runId: 'VPAY-1', vendorBillId: 'BILL-1', spritzBillId: 'bill_chase', amountUsd: 250, initiatedBy: 'ops' });

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 252.5, reference: 'VPAY-1', cashAccountCode: '1000', assetAccountCode: '1210', referenceType: 'spritz_bill_pay_funding' }));
    expect(exec).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: 'shadow', shadow: true, runId: 'VPAY-1', spritzBillId: 'bill_chase', spritzQuoteId: 'q_shadow', amountUsd: 250, feeUsd: 2.5, fundingSource: { kind: 'treasury_core_erp', cashAccountCode: '1000' } });
    expect(saved).toHaveLength(1);
  });

  it('live: commits the ERP draw, pays the quote from the treasury wallet, and books Dr expense + fee / Cr USDC treasury', async () => {
    process.env.SPRITZ_BILLPAY_LIVE = 'true';
    vi.spyOn(CanonicalFundingSource, 'commit').mockResolvedValue({ shadow: false, committed: true, journalEntryId: 'JE-ERP-1' } as any);
    vi.spyOn(SpritzEngine, 'executeQuote').mockResolvedValue({ txHash: '0xabc', quoteId: 'q_live' } as any);
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-GL-1' } as any);
    stubSpritz((path) => {
      if (path === '/v1/bills/') return BILLS;
      if (path === '/v1/off-ramp-quotes/') return { id: 'q_live', status: 'created', input: { amount: '252.50' }, output: { amount: '250.00' } };
      throw new Error(`unexpected ${path}`);
    });

    const out = await SpritzBillPayEngine.pay({ runId: 'VPAY-2', vendorBillId: 'BILL-2', spritzBillId: 'bill_chase', amountUsd: 250, initiatedBy: 'ops' });

    expect(out).toMatchObject({ status: 'settling', txHash: '0xabc', erpJournalEntryId: 'JE-ERP-1', glJournalEntryId: 'JE-GL-1' });
    const lines = post.mock.calls[0][0].lines;
    expect(lines).toEqual([
      expect.objectContaining({ accountCode: '5100', debitAmount: 250, creditAmount: 0 }),
      expect.objectContaining({ accountCode: '5300', debitAmount: 2.5, creditAmount: 0 }),
      expect.objectContaining({ accountCode: '1210', debitAmount: 0, creditAmount: 252.5 }),
    ]);
  });

  it('live: reverses the ERP draw when the Spritz transaction fails', async () => {
    process.env.SPRITZ_BILLPAY_LIVE = 'true';
    vi.spyOn(CanonicalFundingSource, 'commit').mockResolvedValue({ shadow: false, committed: true, journalEntryId: 'JE-ERP-2' } as any);
    const reverse = vi.spyOn(CanonicalFundingSource, 'reverse').mockResolvedValue({} as any);
    vi.spyOn(SpritzEngine, 'executeQuote').mockRejectedValue(new Error('Insufficient USDC balance'));
    stubSpritz((path) => {
      if (path === '/v1/bills/') return BILLS;
      if (path === '/v1/off-ramp-quotes/') return { id: 'q_fail', status: 'created', input: { amount: '252.50' }, output: { amount: '250.00' } };
      throw new Error(`unexpected ${path}`);
    });

    await expect(SpritzBillPayEngine.pay({ runId: 'VPAY-3', spritzBillId: 'bill_chase', amountUsd: 250 })).rejects.toThrow(/Insufficient USDC/);
    expect(reverse).toHaveBeenCalledWith(expect.objectContaining({ journalEntryId: 'JE-ERP-2', amountUsd: 252.5, reference: 'VPAY-3' }));
    expect(saved.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('live with the external Coinbase payout wallet: never signs, returns the unsigned approve+pay calldata, and confirm() books the wallet-sent tx', async () => {
    const COINBASE = '0xA0f8C3d9e4fE7F531968b11f1Ce298F56483040F';
    process.env.SPRITZ_BILLPAY_LIVE = 'true';
    process.env.SPRITZ_PAYOUT_WALLET = COINBASE;
    try {
      expect(SpritzBillPayEngine.config()).toMatchObject({ payoutWallet: COINBASE, payoutWalletSigner: 'external', payoutWalletProvider: 'coinbase' });
      vi.spyOn(CanonicalFundingSource, 'commit').mockResolvedValue({ shadow: false, committed: true, journalEntryId: 'JE-ERP-3' } as any);
      const exec = vi.spyOn(SpritzEngine, 'executeQuote');
      const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-GL-3' } as any);
      stubSpritz((path) => {
        if (path === '/v1/bills/') return BILLS;
        if (path === '/v1/off-ramp-quotes/') return { id: 'q_cb', status: 'created', input: { amount: '252.50' }, output: { amount: '250.00' } };
        if (path === '/v1/off-ramp-quotes/q_cb/transaction') return { type: 'evm', contractAddress: '0x' + '22'.repeat(20), calldata: '0xdeadbeef', inputToken: USDC, requiredTokenInput: '252500000' };
        throw new Error(`unexpected ${path}`);
      });

      const out = await SpritzBillPayEngine.pay({ runId: 'VPAY-CB', vendorBillId: 'BILL-3', spritzBillId: 'bill_chase', amountUsd: 250, initiatedBy: 'ops' });

      expect(exec).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(out).toMatchObject({ status: 'awaiting_signature', spritzQuoteId: 'q_cb', erpJournalEntryId: 'JE-ERP-3', payerWallet: COINBASE });
      expect(out.unsignedTx).toMatchObject({ senderAddress: COINBASE, chainId: 8453, inputToken: USDC, requiredTokenInput: '252500000', payment: { to: '0x' + '22'.repeat(20), data: '0xdeadbeef' } });
      expect(out.unsignedTx.approve).toMatchObject({ to: USDC });
      expect(out.next).toMatch(/coinbase wallet/);
      const txCall = calls.find(c => c.url.includes('/transaction'));
      expect(JSON.parse(txCall!.init.body as string)).toMatchObject({ senderAddress: COINBASE });

      const awaiting = saved.at(-1);
      vi.spyOn(SpritzBillPayEngine, 'getPayment').mockResolvedValue(awaiting);
      const txHash = '0x' + 'ab'.repeat(32);
      const confirmed = await SpritzBillPayEngine.confirm({ paymentId: awaiting.payment_id, txHash, confirmedBy: 'trustee' });
      expect(confirmed).toMatchObject({ status: 'settling', txHash, glJournalEntryId: 'JE-GL-3', paymentId: awaiting.payment_id, runId: 'VPAY-CB' });
      expect(post.mock.calls[0][0].lines).toEqual([
        expect.objectContaining({ accountCode: '5100', debitAmount: 250 }),
        expect.objectContaining({ accountCode: '5300', debitAmount: 2.5 }),
        expect.objectContaining({ accountCode: '1210', creditAmount: 252.5 }),
      ]);

      await expect(SpritzBillPayEngine.confirm({ paymentId: awaiting.payment_id, txHash: 'nope' })).rejects.toThrow(/txHash required/);
    } finally {
      process.env.SPRITZ_PAYOUT_WALLET = PAYOUT;
    }
  });

  it('is idempotent on the payment run', async () => {
    vi.spyOn(SpritzBillPayEngine, 'getPayment').mockResolvedValue({ payment_id: 'SBP-1', run_id: 'VPAY-1', spritz_bill_id: 'bill_chase', amount_usd: '250', fee_usd: '2.5', status: 'shadow', metadata: {} } as any);
    stubSpritz(() => { throw new Error('Spritz must not be called on replay'); });
    const out = await SpritzBillPayEngine.pay({ runId: 'VPAY-1', spritzBillId: 'bill_chase', amountUsd: 250 });
    expect(out).toMatchObject({ paymentId: 'SBP-1', idempotent: true, status: 'shadow' });
    expect(calls).toHaveLength(0);
  });

  it('vendor bills on the spritz_bill_pay rail go through maker/checker, compliance, SpritzBillPayEngine and the payment-run pipeline', async () => {
    const rows: Record<string, any[]> = {};
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      if (/FROM canonical_proposals/.test(sql)) return { rows: [{ category: 'vendor_bill', status: 'approved', payload: { vendorPaymentBillId: 'BILL-9' }, approvals: [{ role: 'maker', status: 'approved' }, { role: 'checker', status: 'approved' }] }] } as any;
      if (/FROM vendor_bills/.test(sql)) return { rows: [{ bill_id: 'BILL-9', vendor_id: 'VENDOR-9', amount_cents: 25000, status: 'pending', memo: 'Card statement', metadata: { spritzBillId: 'bill_chase' } }] } as any;
      if (/FROM vendor_payees/.test(sql)) return { rows: [{ vendor_id: 'VENDOR-9', name: 'Chase Card Services', country: 'US', metadata: {} }] } as any;
      if (/INSERT INTO vendor_payment_runs/.test(sql)) { rows.runs = [params]; return { rows: [], rowCount: 1 } as any; }
      if (/UPDATE vendor_bills/.test(sql)) { rows.bills = [params]; return { rows: [], rowCount: 1 } as any; }
      return { rows: [], rowCount: 0 } as any;
    });
    const screen = vi.spyOn(PaymentComplianceGate, 'screenVendorPayment').mockResolvedValue({ screeningId: 'SCR-1', status: 'clear' } as any);
    const pay = vi.spyOn(SpritzBillPayEngine, 'pay').mockResolvedValue({ paymentId: 'SBP-9', status: 'shadow', spritzQuoteId: 'q_9' } as any);

    const out = await VendorPaymentEngine.payBill({ billId: 'BILL-9', consensusProposalId: 'PROP-9', rail: 'spritz_bill_pay', initiatedBy: 'checker' });

    expect(screen).toHaveBeenCalledWith(expect.objectContaining({ rail: 'spritz_bill_pay', action: 'export', reference: 'BILL-9' }));
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({ vendorBillId: 'BILL-9', spritzBillId: 'bill_chase', amountUsd: 250, initiatedBy: 'checker' }));
    expect(rows.runs[0]).toEqual(expect.arrayContaining(['BILL-9', 'spritz_bill_pay', 'SBP-9', 'pending', 'SCR-1']));
    expect(out).toMatchObject({ billId: 'BILL-9', status: 'pending', payment: { paymentId: 'SBP-9' } });
    expect(VendorPaymentEngine.RAILS).toContain('spritz_bill_pay');
  });

  it('consensus accepts spritz_bill_pay vendor bills only with a linked Spritz bill', () => {
    const base = { vendorPaymentBillId: 'BILL-1', amount: 100, vendor: { name: 'Chase' } };
    expect(() => CanonicalConsensusEngine._validateVendorBillPayload({ ...base, rail: 'spritz_bill_pay' })).toThrow(/spritzBillId/);
    expect(CanonicalConsensusEngine._validateVendorBillPayload({ ...base, rail: 'spritz_bill_pay', spritzBillId: 'bill_chase' })).toMatchObject({ direct: true });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { StablecoinTreasuryEngine } = require('../server/integrations/os/stablecoinTreasuryEngine');
const { StablecoinPayoutRail } = require('../server/integrations/os/stablecoinPayoutRail');
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { CircleMintClient } = require('../server/integrations/stablecoin/circleMintClient');
const { StellarDexSwap } = require('../server/integrations/stablecoin/stellarDexSwap');
const { MoonPayOnramp } = require('../server/integrations/stablecoin/onrampProvider');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { FundingSourceRegistry } = require('../server/integrations/inhouseBank/clearing/fundingSourceRegistry');
const pool = require('../server/integrations/bonds/pgPool');

const DISTRIBUTOR = 'GANCFNWGTHXEZH7EL3L5WTUKUBAUUBQUH562XBKAP62NB7ZEGLB2TVXK';
const CIRCLE_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** The distributor's actual on-chain position, as the payout rail reads it. */
function position(availableCents = 0) {
  vi.spyOn(StablecoinPayoutRail, 'position').mockResolvedValue({
    address: DISTRIBUTOR,
    asset: 'USDC',
    issuer: CIRCLE_ISSUER,
    network: 'mainnet',
    balance: (availableCents / 100).toFixed(7),
    availableCents,
    readiness: { ready: true, issues: [] },
  });
}

/**
 * MoonPay's public listing for Stellar USDC, shaped as their /v3/currencies
 * entry: live-only, Circle's issuer in `contractAddress`, $5 floor.
 */
function listing(overrides: any = {}) {
  const currency = {
    code: 'usdc_xlm',
    isSuspended: false,
    supportsTestMode: false,
    supportsLiveMode: true,
    minBuyAmount: 5,
    maxBuyAmount: 30000,
    addressRegex: '^(G[A-D]{1}[A-Z2-7]{54}|M[A-D]{1}[A-Z2-7]{67})$',
    metadata: { networkCode: 'stellar', contractAddress: `USDC-${CIRCLE_ISSUER}` },
    ...overrides,
  };
  vi.spyOn(MoonPayOnramp.prototype, 'currency').mockResolvedValue(currency);
  return currency;
}

function purchaseRow(overrides: any = {}) {
  return {
    purchase_id: 'USDCBUY-1',
    status: 'approved',
    amount_cents: '50000',
    currency: 'USD',
    network: 'mainnet',
    distributor_address: DISTRIBUTOR,
    initiated_by: 'trustee-one@example.com',
    approved_by: 'trustee-two@example.com',
    circle_recipient_id: null,
    circle_transfer_id: null,
    opening_balance: null,
    ...overrides,
  };
}

/**
 * The purchases table captured rather than performed: reads answer with `row`,
 * writes are recorded so a test can assert what would have been persisted.
 */
function purchaseLedger({ row = null as any, openCents = 0 } = {}) {
  const writes: any[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/CREATE (TABLE|INDEX)/.test(text)) return { rows: [] } as any;
    if (/SUM\(amount_cents\)/.test(text)) return { rows: [{ cents: String(openCents) }] } as any;
    if (/INSERT INTO stablecoin_purchases/.test(text)) {
      const inserted = purchaseRow({
        purchase_id: params[0],
        status: 'pending_approval',
        amount_cents: String(params[1]),
        network: params[2],
        distributor_address: params[3],
        initiated_by: params[7],
        approved_by: null,
      });
      writes.push({ op: 'insert', inserted });
      return { rows: [inserted] } as any;
    }
    if (/UPDATE stablecoin_purchases/.test(text)) {
      writes.push({ op: 'update', sql: text, params });
      return { rows: [{ ...(row || purchaseRow()), updated: params }] } as any;
    }
    if (/FROM stablecoin_purchases/.test(text)) return { rows: row ? [row] : [] } as any;
    return { rows: [] } as any;
  });
  return writes;
}

describe('Buying real USDC for the distributor', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.CIRCLE_MINT_API_KEY = 'test-key';
    process.env.CIRCLE_MINT_WIRE_BANK_ACCOUNT_ID = 'bank-1';
    process.env.STABLECOIN_TARGET_FLOOR_CENTS = '100000';
    vi.spyOn(PayerOsEngine, 'stablecoinInFlightCents').mockResolvedValue(0);
    vi.spyOn(FundingSourceRegistry, 'resolve').mockResolvedValue({
      sourceId: '1010',
      accountName: 'Trust Operating Account',
      availableCents: 250000,
      eligible: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  describe('what the desk is short', () => {
    it('sizes the gap from the on-chain position, not from a stated intention', async () => {
      position(20000);
      purchaseLedger();
      const result = await StablecoinTreasuryEngine.position();
      expect(result.heldCents).toBe(20000);
      expect(result.gapCents).toBe(80000);
      expect(result.distributor).toBe(DISTRIBUTOR);
    });

    it('counts USDC already promised to a payout as unavailable for the floor', async () => {
      position(100000);
      purchaseLedger();
      vi.spyOn(PayerOsEngine, 'stablecoinInFlightCents').mockResolvedValue(40000);
      const result = await StablecoinTreasuryEngine.position();
      expect(result.spendableCents).toBe(60000);
      expect(result.gapCents).toBe(40000);
    });

    it('counts a purchase already in flight, so the same gap is not bought twice', async () => {
      position(20000);
      purchaseLedger({ openCents: 80000 });
      const result = await StablecoinTreasuryEngine.position();
      expect(result.purchasingCents).toBe(80000);
      expect(result.gapCents).toBe(0);
    });

    it('refuses to plan a purchase when the position is already at the floor', async () => {
      position(100000);
      purchaseLedger();
      await expect(StablecoinTreasuryEngine.plan()).rejects.toThrow(/at or above/);
    });

    it('plans both legs, naming which one a bank has to do', async () => {
      position(0);
      purchaseLedger();
      const plan = await StablecoinTreasuryEngine.plan({ amountCents: 50000 });
      expect(plan.amount).toBe('$500.00');
      expect(plan.legs.map((leg: any) => leg.automated)).toEqual([false, true]);
      expect(plan.legs[0].posts).toMatch(/credit 1010/);
      expect(plan.legs[1].posts).toMatch(/debit 1210/);
      expect(plan.fundingAccount.id).toBe('1010');
    });
  });

  describe('refusing rather than pretending', () => {
    it('will not buy anything without a Circle Mint key', async () => {
      delete process.env.CIRCLE_MINT_API_KEY;
      position(0);
      purchaseLedger();
      await expect(
        StablecoinTreasuryEngine.initiate({ amountCents: 50000, initiatedBy: 'trustee-one@example.com' })
      ).rejects.toThrow(/CIRCLE_MINT_API_KEY is not configured|not configured/);
    });

    it('will not hand out wire instructions for a bank account nobody linked', async () => {
      delete process.env.CIRCLE_MINT_WIRE_BANK_ACCOUNT_ID;
      await expect(StablecoinTreasuryEngine.wireInstructions()).rejects.toThrow(/link the trust's bank account/);
    });
  });

  describe('dual control', () => {
    it('raises a purchase awaiting a second trustee', async () => {
      position(0);
      purchaseLedger();
      const { purchase } = await StablecoinTreasuryEngine.initiate({
        amountCents: 50000,
        initiatedBy: 'trustee-one@example.com',
      });
      expect(purchase.status).toBe('pending_approval');
      expect(purchase.amount_cents).toBe('50000');
    });

    it('refuses the maker as their own checker', async () => {
      purchaseLedger({ row: purchaseRow({ status: 'pending_approval', approved_by: null }) });
      await expect(
        StablecoinTreasuryEngine.approve('USDCBUY-1', 'trustee-one@example.com')
      ).rejects.toThrow(/cannot also approve/);
    });

    it('refuses to transfer a purchase no second trustee approved', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ status: 'approved', approved_by: null }) });
      await expect(StablecoinTreasuryEngine.transfer('USDCBUY-1')).rejects.toThrow(/second trustee/);
    });
  });

  describe('the Circle leg', () => {
    it('registers the distributor on Stellar, not on Circle\'s default chain', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ status: 'wire_sent' }) });
      const recipient = vi.spyOn(CircleMintClient.prototype, 'createRecipientAddress')
        .mockResolvedValue({ data: { id: 'addr-1' } });
      const transfer = vi.spyOn(CircleMintClient.prototype, 'createTransfer')
        .mockResolvedValue({ data: { id: 'xfer-1', status: 'pending' } });

      await StablecoinTreasuryEngine.transfer('USDCBUY-1');

      expect(recipient).toHaveBeenCalledWith(expect.objectContaining({
        address: DISTRIBUTOR,
        chain: 'XLM',
      }));
      expect(transfer).toHaveBeenCalledWith(expect.objectContaining({
        destinationAddressId: 'addr-1',
        amount: '500.00',
      }));
    });

    it('refuses to send to a distributor the rail no longer uses', async () => {
      vi.spyOn(StablecoinPayoutRail, 'position').mockResolvedValue({
        address: 'GDIFFERENTACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        asset: 'USDC',
        issuer: CIRCLE_ISSUER,
        network: 'mainnet',
        availableCents: 0,
        readiness: { ready: true, issues: [] },
      });
      purchaseLedger({ row: purchaseRow({ status: 'wire_sent' }) });
      await expect(StablecoinTreasuryEngine.transfer('USDCBUY-1'))
        .rejects.toThrow(/rail now points at/);
    });

    it('records nothing as sent when Circle returns no transfer id', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ status: 'wire_sent' }) });
      vi.spyOn(CircleMintClient.prototype, 'createRecipientAddress').mockResolvedValue({ data: { id: 'addr-1' } });
      vi.spyOn(CircleMintClient.prototype, 'createTransfer').mockResolvedValue({ data: {} });
      await expect(StablecoinTreasuryEngine.transfer('USDCBUY-1')).rejects.toThrow(/did not return a transfer id/);
    });
  });

  describe('the ledger follows the tokens, not the provider', () => {
    it('posts the wire as USD in transit, out of Trust Operating', async () => {
      purchaseLedger({ row: purchaseRow({ status: 'approved' }) });
      const journal = vi.spyOn(TrustAccountingEngine, 'postJournalEntry')
        .mockResolvedValue({ entry_id: 'JE-1' });

      await StablecoinTreasuryEngine.recordWire('USDCBUY-1', { reference: 'FED-REF-9' });

      const lines = journal.mock.calls[0][0].lines;
      expect(lines[0]).toMatchObject({ accountCode: '1215', debitAmount: 500 });
      expect(lines[1]).toMatchObject({ accountCode: '1010', creditAmount: 500 });
    });

    it('refuses a wire with no reference, since nothing evidences the dollars left', async () => {
      purchaseLedger({ row: purchaseRow({ status: 'approved' }) });
      await expect(StablecoinTreasuryEngine.recordWire('USDCBUY-1', {})).rejects.toThrow(/wire reference is required/);
    });

    it('does not post the asset while Circle says sent but Horizon shows nothing', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ status: 'in_transit', circle_transfer_id: 'xfer-1', opening_balance: '0' }) });
      const journal = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-2' });

      const result = await StablecoinTreasuryEngine.confirm('USDCBUY-1');

      expect(result.confirmed).toBe(false);
      expect(journal).not.toHaveBeenCalled();
    });

    it('posts the asset once the distributor\'s own balance has risen by the amount', async () => {
      position(50000);
      purchaseLedger({ row: purchaseRow({ status: 'in_transit', circle_transfer_id: 'xfer-1', opening_balance: '0' }) });
      const journal = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-3' });

      const result = await StablecoinTreasuryEngine.confirm('USDCBUY-1');

      expect(result.confirmed).toBe(true);
      const lines = journal.mock.calls[0][0].lines;
      expect(lines[0]).toMatchObject({ accountCode: '1210', debitAmount: 500 });
      expect(lines[1]).toMatchObject({ accountCode: '1215', creditAmount: 500 });
    });

    it('will not confirm a purchase that was never sent', async () => {
      purchaseLedger({ row: purchaseRow({ status: 'approved' }) });
      await expect(StablecoinTreasuryEngine.confirm('USDCBUY-1')).rejects.toThrow(/nothing in transit/);
    });
  });

  describe('funding without a Circle account', () => {
    it('rejects a venue nobody implemented rather than defaulting to Circle', async () => {
      position(0);
      purchaseLedger();
      await expect(StablecoinTreasuryEngine.plan({ amountCents: 50000, source: 'venmo' }))
        .rejects.toThrow(/not a funding source/);
    });

    it('plans an exchange purchase as two legs no engine can perform', async () => {
      position(0);
      purchaseLedger();
      const plan = await StablecoinTreasuryEngine.plan({ amountCents: 50000, source: 'exchange' });
      expect(plan.legs.map((leg: any) => leg.automated)).toEqual([false, false]);
      expect(plan.legs[1].description).toMatch(/Stellar/);
    });

    it('refuses to originate an exchange purchase at Circle, and says what to do instead', async () => {
      purchaseLedger({ row: purchaseRow({ source: 'exchange', status: 'wire_sent' }) });
      await expect(StablecoinTreasuryEngine.transfer('USDCBUY-1'))
        .rejects.toThrow(/recordWithdrawal/);
    });

    it('records an exchange withdrawal as in transit, posting nothing', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'exchange', status: 'wire_sent' }) });
      const journal = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-4' });

      const updated = await StablecoinTreasuryEngine.recordWithdrawal('USDCBUY-1', { reference: 'WD-7781' });

      expect(updated.updated).toContain('WD-7781');
      expect(journal).not.toHaveBeenCalled();
    });

    it('will not record a withdrawal without the venue\'s reference', async () => {
      purchaseLedger({ row: purchaseRow({ source: 'exchange', status: 'wire_sent' }) });
      await expect(StablecoinTreasuryEngine.recordWithdrawal('USDCBUY-1', {}))
        .rejects.toThrow(/withdrawal reference is required/);
    });
  });

  describe('the hosted on-ramp', () => {
    beforeEach(() => {
      process.env.MOONPAY_PUBLISHABLE_KEY = 'pk_test_key';
      process.env.MOONPAY_SECRET_KEY = 'sk_test_key';
      process.env.STABLECOIN_ONRAMP_PROVIDER = 'moonpay';
      listing();
    });

    it('signs a checkout that names the amount, the asset, the network and the distributor', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'onramp', status: 'approved' }) });

      const { checkout } = await StablecoinTreasuryEngine.checkout('USDCBUY-1');

      expect(checkout.url).toContain('currencyCode=usdc_xlm');
      expect(checkout.url).toContain(`walletAddress=${DISTRIBUTOR}`);
      expect(checkout.url).toContain('quoteCurrencyAmount=500.00');
      expect(checkout.url).toMatch(/&signature=/);
      expect(checkout.network).toBe('stellar');
    });

    it('refuses a checkout no second trustee approved', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'onramp', status: 'approved', approved_by: null }) });
      await expect(StablecoinTreasuryEngine.checkout('USDCBUY-1')).rejects.toThrow(/second trustee/);
    });

    it('refuses Coinbase Onramp, which cannot deliver USDC on Stellar', async () => {
      process.env.STABLECOIN_ONRAMP_PROVIDER = 'coinbase';
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'onramp', status: 'approved' }) });
      await expect(StablecoinTreasuryEngine.checkout('USDCBUY-1')).rejects.toThrow(/not Stellar|cannot deliver/);
    });

    it('refuses a checkout for a token issued by anyone but the issuer the rail pays out', async () => {
      listing({ metadata: { networkCode: 'stellar', contractAddress: 'USDC-GIMPOSTOR' } });
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'onramp', status: 'approved' }) });
      await expect(StablecoinTreasuryEngine.checkout('USDCBUY-1')).rejects.toThrow(/unspendable/);
    });

    it('refuses a sandbox checkout for an asset MoonPay only sells in live mode', async () => {
      process.env.MOONPAY_ENV = 'sandbox';
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'onramp', status: 'approved' }) });
      await expect(StablecoinTreasuryEngine.checkout('USDCBUY-1')).rejects.toThrow(/in test mode/);
    });

    it('refuses an amount below the provider\u2019s own floor before sending anyone to pay', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'onramp', status: 'approved', amount_cents: '34' }) });
      await expect(StablecoinTreasuryEngine.checkout('USDCBUY-1')).rejects.toThrow(/minimum/);
    });

    it('will not sign a checkout with no MoonPay secret, since MoonPay would reject it anyway', async () => {
      delete process.env.MOONPAY_SECRET_KEY;
      position(0);
      purchaseLedger();
      await expect(
        StablecoinTreasuryEngine.initiate({ amountCents: 50000, initiatedBy: 'trustee-one@example.com', source: 'onramp' })
      ).rejects.toThrow(/MOONPAY_SECRET_KEY/);
    });
  });

  describe('the order-book swap', () => {
    it('plans one automated leg that gives up XLM rather than cash', async () => {
      position(0);
      purchaseLedger();
      vi.spyOn(StellarDexSwap, 'quote').mockResolvedValue({
        sendAmount: '1234.5000000', sendMax: '1259.1900000', maxSlippageBps: 200,
      });
      const plan = await StablecoinTreasuryEngine.plan({ amountCents: 50000, source: 'stellar_dex' });
      expect(plan.legs).toHaveLength(1);
      expect(plan.legs[0].automated).toBe(true);
      expect(plan.legs[0].posts).toMatch(/debit 1210 \/ credit 1216/);
    });

    it('has no wire to record, since no dollars leave the bank', async () => {
      purchaseLedger({ row: purchaseRow({ source: 'stellar_dex', status: 'approved' }) });
      await expect(StablecoinTreasuryEngine.recordWire('USDCBUY-1', { reference: 'FED-REF-9' }))
        .rejects.toThrow(/no dollars leave the bank/);
    });

    it('signs the swap and records the hash, recognising nothing yet', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'stellar_dex', status: 'approved' }) });
      vi.spyOn(StellarDexSwap, 'swap').mockResolvedValue({
        hash: 'abc123', quote: { sendMax: '1259.19', sendAmount: '1234.50', maxSlippageBps: 200 },
      });
      const journal = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-5' });

      const { swap } = await StablecoinTreasuryEngine.swap('USDCBUY-1');

      expect(swap.hash).toBe('abc123');
      expect(journal).not.toHaveBeenCalled();
    });

    it('refuses to swap a purchase no second trustee approved', async () => {
      position(0);
      purchaseLedger({ row: purchaseRow({ source: 'stellar_dex', status: 'approved', approved_by: null }) });
      await expect(StablecoinTreasuryEngine.swap('USDCBUY-1')).rejects.toThrow(/second trustee/);
    });

    it('credits the XLM account, not USD in transit, once the tokens land', async () => {
      position(50000);
      purchaseLedger({
        row: purchaseRow({ source: 'stellar_dex', status: 'in_transit', chain_reference: 'abc123', opening_balance: '0' }),
      });
      const journal = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-6' });

      await StablecoinTreasuryEngine.confirm('USDCBUY-1');

      const lines = journal.mock.calls[0][0].lines;
      expect(lines[0]).toMatchObject({ accountCode: '1210', debitAmount: 500 });
      expect(lines[1]).toMatchObject({ accountCode: '1216', creditAmount: 500 });
    });
  });
});

describe('Swapping XLM for USDC on Stellar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('will not swap more XLM than the distributor can spare after reserves', async () => {
    vi.spyOn(StellarDexSwap, 'quote').mockResolvedValue({
      affordable: false, sendMax: '1259.1900000', spendableXlm: '10.0000000', reserveXlm: 3,
    });
    await expect(StellarDexSwap.swap({ amountCents: 50000 })).rejects.toThrow(/only 10.0000000 is spendable/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { StablecoinTreasuryEngine } = require('../server/integrations/os/stablecoinTreasuryEngine');
const { StablecoinPayoutRail } = require('../server/integrations/os/stablecoinPayoutRail');
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { CircleMintClient } = require('../server/integrations/stablecoin/circleMintClient');
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
});

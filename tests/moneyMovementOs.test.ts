import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { MoneyMovementOsEngine } = require('../server/integrations/os/moneyMovementOsEngine');
const { StellarVenue } = require('../server/integrations/stablecoin/stellarVenue');
const { VenueAccountOsEngine } = require('../server/integrations/os/venueAccountOsEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { FundingSourceRegistry } = require('../server/integrations/inhouseBank/clearing/fundingSourceRegistry');
const pool = require('../server/integrations/bonds/pgPool');

const DISTRIBUTOR = 'GANCFNWGTHXEZH7EL3L5WTUKUBAUUBQUH562XBKAP62NB7ZEGLB2TVXK';

function acquisitionRow(overrides: any = {}) {
  return {
    acquisition_id: 'XLMBUY-1',
    status: 'approved',
    usd_cents: '500',
    network: 'mainnet',
    destination: DISTRIBUTOR,
    venue: 'coinbase',
    venue_order_id: null,
    venue_withdrawal_id: null,
    xlm_bought: null,
    xlm_confirmed: null,
    opening_balance: null,
    initiated_by: 'trustee-one@example.com',
    approved_by: 'trustee-two@example.com',
    metadata: {},
    ...overrides,
  };
}

/** The acquisitions table captured rather than performed. */
function ledger({ row = null as any } = {}) {
  const writes: any[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/CREATE (TABLE|INDEX)/.test(text)) return { rows: [] } as any;
    if (/SUM\(usd_cents\)/.test(text)) return { rows: [{ cents: '0' }] } as any;
    if (/INSERT INTO xlm_acquisitions/.test(text)) {
      const inserted = acquisitionRow({
        acquisition_id: params[0],
        status: 'pending_approval',
        usd_cents: String(params[1]),
        destination: params[3],
        initiated_by: params[6],
        approved_by: null,
      });
      writes.push({ op: 'insert', inserted });
      return { rows: [inserted] } as any;
    }
    if (/UPDATE xlm_acquisitions/.test(text)) {
      writes.push({ op: 'update', sql: text, params });
      return { rows: [{ ...(row || acquisitionRow()), updated: params }] } as any;
    }
    if (/FROM xlm_acquisitions/.test(text)) return { rows: row ? [row] : [] } as any;
    return { rows: [] } as any;
  });
  return writes;
}

/** Horizon's answer for the destination: 404 until somebody funds it. */
function horizon({ exists = false, xlm = '0' } = {}) {
  const fetchMock = vi.fn().mockResolvedValue(exists
    ? { ok: true, status: 200, json: async () => ({ subentry_count: 0, balances: [{ asset_type: 'native', balance: xlm }] }) }
    : { ok: false, status: 404, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Money Movement OS: turning dollars into the trust’s first XLM', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.STABLECOIN_DISTRIBUTOR_PUBLIC = DISTRIBUTOR;
    process.env.STABLECOIN_NETWORK = 'mainnet';
    process.env.COINBASE_CDP_KEY_NAME = 'organizations/x/apiKeys/y';
    process.env.COINBASE_CDP_PRIVATE_KEY = 'test-private-key';
    vi.spyOn(FundingSourceRegistry, 'operatingAccountCode').mockReturnValue('1010');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  describe('what the network says, not what the books say', () => {
    it('reads a 404 as an account that has never been funded', async () => {
      horizon({ exists: false });
      const state = await MoneyMovementOsEngine.destinationState();
      expect(state).toMatchObject({ address: DISTRIBUTOR, exists: false, xlm: 0, needsXlm: 2 });
    });

    it('reports how much more XLM an existing account needs for a trustline', async () => {
      horizon({ exists: true, xlm: '1.2000000' });
      const state = await MoneyMovementOsEngine.destinationState();
      expect(state).toMatchObject({ exists: true, xlm: 1.2, needsXlm: 0.8 });
    });

    it('refuses to guess when Horizon itself is unavailable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
      await expect(MoneyMovementOsEngine.destinationState()).rejects.toThrow(/network state is unknown/);
    });
  });

  describe('readiness names the account, not a generic failure', () => {
    it('is not ready without a venue, and says which keys are missing', async () => {
      delete process.env.COINBASE_CDP_KEY_NAME;
      horizon({ exists: false });
      const state = await MoneyMovementOsEngine.readiness();
      expect(state.ready).toBe(false);
      expect(state.issues.join(' ')).toMatch(/COINBASE_CDP_KEY_NAME/);
      expect(state.issues.join(' ')).toMatch(/account that holds USD/);
    });

    it('is ready with a venue configured, even though the destination does not exist yet', async () => {
      horizon({ exists: false });
      const state = await MoneyMovementOsEngine.readiness();
      expect(state.ready).toBe(true);
      expect(state.destination.exists).toBe(false);
    });

    it('carries the venue register’s verdict when an account is registered', async () => {
      horizon({ exists: false });
      vi.spyOn(VenueAccountOsEngine, 'forCapability').mockResolvedValue({
        capability: 'buy_xlm',
        account: null,
        candidates: [{ venueId: 'VENUE-COINBASE-1' }],
        issues: ['Coinbase (VENUE-COINBASE-1): onboarding is under_review'],
      });
      const state = await MoneyMovementOsEngine.readiness();
      expect(state.ready).toBe(false);
      expect(state.issues.join(' ')).toMatch(/onboarding is under_review/);
    });

    it('stays on the environment alone while no account is registered', async () => {
      horizon({ exists: false });
      vi.spyOn(VenueAccountOsEngine, 'forCapability').mockResolvedValue({
        capability: 'buy_xlm', account: null, candidates: [], issues: ['no venue account is registered'],
      });
      const state = await MoneyMovementOsEngine.readiness();
      expect(state.ready).toBe(true);
    });
  });

  describe('the plan says which legs a human still has to do', () => {
    it('leaves the fiat deposit manual and automates buy, withdrawal and confirmation', async () => {
      horizon({ exists: false });
      const plan = await MoneyMovementOsEngine.plan({ usdCents: 500 });
      const manual = plan.legs.filter((leg: any) => !leg.automated).map((leg: any) => leg.leg);
      const auto = plan.legs.filter((leg: any) => leg.automated).map((leg: any) => leg.leg);
      expect(manual).toEqual(['usd_to_venue']);
      expect(auto).toEqual(['venue_buy', 'venue_withdraw', 'chain_confirm']);
      expect(plan.legs[2].description).toMatch(/which creates the account/);
    });

    it('refuses a non-positive amount', async () => {
      await expect(MoneyMovementOsEngine.plan({ usdCents: 0 })).rejects.toThrow(/positive amount/);
    });
  });

  describe('dual control', () => {
    it('refuses to raise an acquisition when no venue could perform it', async () => {
      delete process.env.COINBASE_CDP_PRIVATE_KEY;
      horizon({ exists: false });
      ledger();
      await expect(MoneyMovementOsEngine.initiate({ usdCents: 500, initiatedBy: 'trustee-one@example.com' }))
        .rejects.toThrow(/XLM cannot be acquired/);
    });

    it('refuses the maker as their own checker', async () => {
      ledger({ row: acquisitionRow({ status: 'pending_approval', approved_by: null }) });
      await expect(MoneyMovementOsEngine.approve('XLMBUY-1', 'trustee-one@example.com'))
        .rejects.toThrow(/cannot also approve it/);
    });

    it('will not call the venue before a second trustee has approved', async () => {
      horizon({ exists: false });
      ledger({ row: acquisitionRow({ status: 'pending_approval', approved_by: null }) });
      const buy = vi.spyOn(StellarVenue, 'buy');
      await expect(MoneyMovementOsEngine.execute('XLMBUY-1')).rejects.toThrow(/second trustee approves/);
      expect(buy).not.toHaveBeenCalled();
    });
  });

  describe('live, not shadow', () => {
    it('is live on Stellar public with the rail not simulating', () => {
      process.env.STABLECOIN_MODE = 'mainnet';
      const state = MoneyMovementOsEngine.liveness();
      expect(state.live).toBe(true);
      expect(state.horizonUrl).toBe('https://horizon.stellar.org');
    });

    it('refuses to buy real XLM for a rail that fabricates its settlements', async () => {
      process.env.STABLECOIN_MODE = 'shadow';
      expect(MoneyMovementOsEngine.liveness().issues.join(' ')).toMatch(/shadow/);
      horizon({ exists: false });
      ledger({ row: acquisitionRow() });
      const quote = vi.spyOn(StellarVenue, 'quote');
      await expect(MoneyMovementOsEngine.execute('XLMBUY-1')).rejects.toThrow(/not be a live transfer.*shadow/);
      expect(quote).not.toHaveBeenCalled();
    });

    it('refuses a test ledger, because the venue withdraws on public only', async () => {
      process.env.STABLECOIN_NETWORK = 'testnet';
      const state = MoneyMovementOsEngine.liveness();
      expect(state.live).toBe(false);
      expect(state.issues.join(' ')).toMatch(/set it to mainnet/);
      expect(state.issues.join(' ')).toMatch(/test ledger/);
      const readiness = await MoneyMovementOsEngine.readiness().catch(() => null);
      if (readiness) expect(readiness.ready).toBe(false);
    });

    it('refuses to confirm against a test ledger as well', async () => {
      process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
      ledger({ row: acquisitionRow({ status: 'withdrawn', opening_balance: '0' }) });
      await expect(MoneyMovementOsEngine.confirm('XLMBUY-1')).rejects.toThrow(/not be a live transfer/);
    });
  });

  describe('buying and withdrawing', () => {
    it('stops before spending when the venue account holds no dollars', async () => {
      horizon({ exists: false });
      ledger({ row: acquisitionRow() });
      vi.spyOn(StellarVenue, 'quote').mockResolvedValue({
        ok: false, needsDeposit: true, errors: ['INSUFFICIENT_FUND'], product: 'XLM-USD', usd: '5.00', xlm: null,
      });
      const buy = vi.spyOn(StellarVenue, 'buy');
      await expect(MoneyMovementOsEngine.execute('XLMBUY-1')).rejects.toThrow(/holds no dollars/);
      expect(buy).not.toHaveBeenCalled();
    });

    it('records the venue references and recognises nothing yet', async () => {
      horizon({ exists: false });
      const writes = ledger({ row: acquisitionRow() });
      vi.spyOn(StellarVenue, 'quote').mockResolvedValue({ ok: true, errors: [], xlm: '20.5', usd: '5.00', product: 'XLM-USD', needsDeposit: false });
      vi.spyOn(StellarVenue, 'buy').mockResolvedValue({ orderId: 'CB-ORDER-1', xlm: '20.5', response: {} });
      const withdraw = vi.spyOn(StellarVenue, 'withdraw').mockResolvedValue({ withdrawalId: 'CB-WD-1', status: 'pending', hash: '', response: {} });
      const posting = vi.spyOn(TrustAccountingEngine, 'postJournalEntry');

      await MoneyMovementOsEngine.execute('XLMBUY-1');

      expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ address: DISTRIBUTOR, xlm: '20.5' }));
      expect(posting).not.toHaveBeenCalled();
      const withdrawn = writes.filter(w => w.op === 'update' && w.params.includes('withdrawn'));
      expect(withdrawn.length).toBe(1);
    });

    it('keeps the bought XLM on the record when the withdrawal fails', async () => {
      horizon({ exists: false });
      const writes = ledger({ row: acquisitionRow() });
      vi.spyOn(StellarVenue, 'quote').mockResolvedValue({ ok: true, errors: [], xlm: '20.5', usd: '5.00', product: 'XLM-USD', needsDeposit: false });
      vi.spyOn(StellarVenue, 'buy').mockResolvedValue({ orderId: 'CB-ORDER-1', xlm: '20.5', response: {} });
      vi.spyOn(StellarVenue, 'withdraw').mockRejectedValue(new Error('destination account does not exist'));

      await expect(MoneyMovementOsEngine.execute('XLMBUY-1')).rejects.toThrow(/bought 20.5 XLM but the withdrawal/);
      const failure = writes.find(w => w.op === 'update' && w.params.some((p: any) => /withdrawal to/.test(String(p))));
      expect(failure).toBeTruthy();
      expect(failure.params).toContain('20.5');
    });
  });

  describe('confirmation is Horizon’s, not the venue’s', () => {
    it('refuses to recognise XLM at an account that still does not exist', async () => {
      horizon({ exists: false });
      ledger({ row: acquisitionRow({ status: 'withdrawn', xlm_bought: '20.5', opening_balance: '0' }) });
      const posting = vi.spyOn(TrustAccountingEngine, 'postJournalEntry');
      await expect(MoneyMovementOsEngine.confirm('XLMBUY-1')).rejects.toThrow(/still does not exist/);
      expect(posting).not.toHaveBeenCalled();
    });

    it('refuses when the balance has not moved', async () => {
      horizon({ exists: true, xlm: '3.0000000' });
      ledger({ row: acquisitionRow({ status: 'withdrawn', xlm_bought: '20.5', opening_balance: '3' }) });
      await expect(MoneyMovementOsEngine.confirm('XLMBUY-1')).rejects.toThrow(/unchanged from 3/);
    });

    it('posts XLM against the transit account for what actually arrived', async () => {
      horizon({ exists: true, xlm: '20.5000000' });
      ledger({ row: acquisitionRow({ status: 'withdrawn', xlm_bought: '20.5', opening_balance: '0' }) });
      const posting = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-1' });

      await MoneyMovementOsEngine.confirm('XLMBUY-1');

      const entry = posting.mock.calls[0][0] as any;
      expect(entry.lines.map((l: any) => [l.accountCode, l.debitAmount, l.creditAmount]))
        .toEqual([['1216', 5, 0], ['1215', 0, 5]]);
      expect(entry.description).toMatch(/20.5 XLM confirmed/);
    });

    it('books the fiat deposit only against a reference somebody can point at', async () => {
      ledger({ row: acquisitionRow({ status: 'approved' }) });
      await expect(MoneyMovementOsEngine.recordDeposit('XLMBUY-1', {})).rejects.toThrow(/reference is required/);
    });

    it('moves dollars out of the operating account when the deposit is recorded', async () => {
      ledger({ row: acquisitionRow({ status: 'approved' }) });
      const posting = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-2' });
      await MoneyMovementOsEngine.recordDeposit('XLMBUY-1', { reference: 'ACH-9911' });
      const entry = posting.mock.calls[0][0] as any;
      expect(entry.lines.map((l: any) => [l.accountCode, l.debitAmount, l.creditAmount]))
        .toEqual([['1215', 5, 0], ['1010', 0, 5]]);
    });
  });

  describe('the venue adapter', () => {
    it('refuses to trade with no keys, naming what is unset', () => {
      delete process.env.COINBASE_CDP_KEY_NAME;
      delete process.env.COINBASE_CDP_PRIVATE_KEY;
      expect(StellarVenue.enabled()).toBe(false);
      expect(() => StellarVenue._requireVenue()).toThrow(/COINBASE_CDP_KEY_NAME/);
    });

    it('refuses a withdrawal without a destination or an amount', async () => {
      await expect(StellarVenue.withdraw({ xlm: '5' })).rejects.toThrow(/destination Stellar address is required/);
      await expect(StellarVenue.withdraw({ address: DISTRIBUTOR, xlm: 0 })).rejects.toThrow(/positive amount/);
    });
  });
});

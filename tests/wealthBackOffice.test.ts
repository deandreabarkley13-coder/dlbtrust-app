import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WealthBackOfficeEngine } = require('../server/integrations/os/wealthBackOfficeEngine');
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { CashEngine } = require('../server/integrations/cash/cashEngine');
const { BondEngine } = require('../server/integrations/bonds/bondEngine');
const { TaxEngine } = require('../server/integrations/tax/taxEngine');
const { CrmEngine } = require('../server/integrations/crm/crmEngine');
const { CalendarEngine } = require('../server/integrations/calendar/calendarEngine');
const { MessagingEngine } = require('../server/integrations/messaging/messagingEngine');
const { CorporateTreasuryEngine } = require('../server/integrations/finops/corporateTreasuryEngine');
const pool = require('../server/integrations/bonds/pgPool');

const VENDOR_PAYABLE = {
  payment_id: 'VPAY-1',
  amount: '2500.00',
  currency: 'USD',
  status: 'approved',
  due_date: '2026-09-01',
  description: 'August retainer',
  invoice_number: 'INV-77',
  payment_method: 'ach',
  vendor_name: 'ACME PLUMBING LLC',
  vendor_id: 'VEND-1',
};

const DISTRIBUTION = {
  id: 'DIST-1',
  beneficiary_name: 'JANE DOE',
  beneficiary_email: 'jane@example.com',
  amount_cents: 120_000,
  currency: 'USD',
  status: 'approved',
  memo: 'August distribution',
  created_at: '2026-08-01T00:00:00.000Z',
};

const PAYEES = {
  vendor_payout: [{ key: 'acme', purpose: 'vendor_payout', label: 'ACME Plumbing LLC', name: 'ACME PLUMBING LLC', glAccountCode: '5300' }],
  direct_deposit: [{ key: 'jane-doe', purpose: 'direct_deposit', label: 'Jane Doe — payroll', name: 'JANE DOE', glAccountCode: '5200' }],
};

/**
 * The back office reads nine engines and one table of its own handoffs. Every
 * read is answered here, and every write is captured rather than performed.
 */
function backOffice({
  payables = [VENDOR_PAYABLE] as any[],
  distributions = [DISTRIBUTION] as any[],
  existingPushes = [] as any[],
  inFlight = [] as any[],
  melioExports = [] as any[],
  handoffInsertFails = false,
} = {}) {
  const inserted: any[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any) => {
    const text = String(sql);
    if (/^\s*CREATE (TABLE|UNIQUE INDEX|INDEX)/.test(text)) return { rows: [] } as any;
    if (/to_regclass/.test(text)) return { rows: [{ oid: 'present' }] } as any;
    if (/FROM vendor_payments/.test(text)) return { rows: payables } as any;
    if (/FROM dapp_distribution_requests/.test(text)) return { rows: distributions } as any;
    if (/FROM wealth_credit_pushes/.test(text)) return { rows: existingPushes } as any;
    if (/FROM melio_payments/.test(text)) return { rows: melioExports } as any;
    if (/INSERT INTO wealth_credit_pushes/.test(text)) {
      if (handoffInsertFails) throw new Error('duplicate key value violates unique constraint');
      inserted.push(text);
      return { rows: [] } as any;
    }
    return { rows: [] } as any;
  });
  vi.spyOn(PayerOsEngine, 'list').mockResolvedValue(inFlight as any);
  vi.spyOn(PayerOsEngine, 'payees').mockImplementation((type: any) => (PAYEES as any)[type] || []);
  return { inserted };
}

function ledgerDesks({ glCashDollars = 1_000, cashLedgerCents = 100_000 } = {}) {
  vi.spyOn(TrustAccountingEngine, 'getBalanceSheet').mockResolvedValue({
    as_of_date: '2026-08-30',
    assets: [
      { account_code: '1000', account_name: 'Trust Cash', sub_type: 'cash', balance: glCashDollars },
      { account_code: '1200', account_name: 'Bonds', sub_type: 'investment', balance: 500 },
    ],
    liabilities: [],
    equity: [],
    total_assets: glCashDollars + 500,
    total_liabilities: 0,
    total_equity: glCashDollars + 500,
    is_balanced: true,
  } as any);
  vi.spyOn(CashEngine, 'getPositionSummary').mockResolvedValue({
    by_type: { checking: { total_cents: cashLedgerCents, account_count: 1 } },
    grand_total_cents: cashLedgerCents,
  } as any);
  vi.spyOn(BondEngine, 'listBonds').mockResolvedValue([{ id: 'BOND-1', bond_name: 'Series A' }] as any);
  vi.spyOn(BondEngine, 'getBondDashboard').mockResolvedValue({
    bond: { bond_name: 'Series A', isin: 'US0000000001', status: 'active', coupon_rate: 0.05, maturity_date: '2030-01-01' },
    balances: {
      principal_balance: 500,
      accrued_interest: 10,
      pending_accrual: 2.5,
      total_current_value: 512.5,
      total_interest_paid: 30,
      last_accrual_date: '2026-08-01',
    },
  } as any);
  vi.spyOn(CorporateTreasuryEngine, 'getDashboard').mockResolvedValue({ accounts: [] } as any);
  vi.spyOn(TaxEngine, 'getDashboard').mockResolvedValue({ tax_year: 2026, latest_return: null } as any);
}

describe('Wealth Back Office OS — one floor over the family bank', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  describe('every obligation in one shape', () => {
    beforeEach(() => { backOffice(); });

    it('unifies vendor payables and beneficiary distributions into one queue with one vocabulary', async () => {
      const queue = await WealthBackOfficeEngine.creditQueue({});
      expect(queue.items).toHaveLength(2);
      expect(queue.items.map((item: any) => item.origin)).toEqual(['vendor_payable', 'beneficiary_distribution']);
      expect(queue.items[0]).toMatchObject({
        originId: 'VPAY-1',
        disbursementType: 'vendor_payout',
        payeeKey: 'acme',
        amountCents: 250_000,
        pushable: true,
      });
      expect(queue.items[1]).toMatchObject({
        originId: 'DIST-1',
        disbursementType: 'direct_deposit',
        payeeKey: 'jane-doe',
        amountCents: 120_000,
        pushable: true,
      });
      expect(queue.totals).toMatchObject({ count: 2, pushableCount: 2, openCents: 370_000, pushableCents: 370_000 });
    });

    it('gives a business a CCD vendor payout and a beneficiary a PPD direct deposit, never the other way round', async () => {
      const queue = await WealthBackOfficeEngine.creditQueue({});
      const types = new Map(queue.items.map((item: any) => [item.origin, item.disbursementType]));
      expect(types.get('vendor_payable')).toBe('vendor_payout');
      expect(types.get('beneficiary_distribution')).toBe('direct_deposit');
    });

    it('carries no routing or account number on a queued obligation', async () => {
      const queue = await WealthBackOfficeEngine.creditQueue({});
      for (const item of queue.items) {
        expect(Object.keys(item)).not.toContain('routingNumber');
        expect(Object.keys(item)).not.toContain('accountNumber');
      }
    });
  });

  it('lists a credit Payer OS already has in flight, and refuses to raise it again', async () => {
    backOffice({
      payables: [],
      distributions: [],
      inFlight: [{
        disbursement_id: 'PAYVP-1',
        disbursement_type: 'vendor_payout',
        status: 'pending_approval',
        amount_cents: 250_000,
        currency: 'USD',
        payee_key: 'acme',
        payee_label: 'ACME Plumbing LLC',
      }],
    });
    const queue = await WealthBackOfficeEngine.creditQueue({});
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ origin: 'payer_disbursement', pushable: false });
    expect(queue.items[0].blockers[0]).toMatch(/Already originated as PAYVP-1/);
  });

  describe('the counterparty stays an allowlist', () => {
    it('will not queue an obligation whose counterparty is not a registered payee as pushable', async () => {
      backOffice({ payables: [{ ...VENDOR_PAYABLE, vendor_name: 'SOME OTHER COMPANY' }], distributions: [] });
      const queue = await WealthBackOfficeEngine.creditQueue({ origin: 'vendor_payable' });
      expect(queue.items[0].pushable).toBe(false);
      expect(queue.items[0].payeeKey).toBeNull();
      expect(queue.items[0].blockers[0]).toMatch(/not a registered vendor_payout payee/);
    });

    it('matches a counterparty exactly, so a similarly named entity is not paid on somebody else’s invoice', async () => {
      backOffice({ payables: [{ ...VENDOR_PAYABLE, vendor_name: 'ACME PLUMBING HOLDINGS LLC' }], distributions: [] });
      const queue = await WealthBackOfficeEngine.creditQueue({ origin: 'vendor_payable' });
      expect(queue.items[0].payeeKey).toBeNull();
    });

    it('refuses an unknown origin rather than guessing which desk raised it', async () => {
      backOffice();
      await expect(WealthBackOfficeEngine.creditQueue({ origin: 'invoice' })).rejects.toThrowError(/Unknown credit origin/);
    });
  });

  describe('handing a credit to Payer OS', () => {
    const initiated = {
      disbursement: {
        disbursement_id: 'PAYVP-9',
        disbursement_type: 'vendor_payout',
        rail: 'ach',
        status: 'pending_approval',
        amount_cents: 250_000,
        payee_label: 'ACME Plumbing LLC',
        initiated_by: 'trustee-one@example.com',
      },
      plan: { amount: '2500.00' },
    };

    it('raises the push on the payee the obligation resolves to, and stops before dual control', async () => {
      const { inserted } = backOffice();
      const initiate = vi.spyOn(PayerOsEngine, 'initiate').mockResolvedValue(initiated as any);
      const approve = vi.spyOn(PayerOsEngine, 'approve');
      const send = vi.spyOn(PayerOsEngine, 'send');
      vi.spyOn(MessagingEngine, 'notify').mockResolvedValue({ id: 'THREAD-1' } as any);

      const result = await WealthBackOfficeEngine.pushCredit({
        origin: 'vendor_payable',
        originId: 'VPAY-1',
        initiatedBy: 'trustee-one@example.com',
      });

      expect(initiate).toHaveBeenCalledWith(expect.objectContaining({
        disbursementType: 'vendor_payout',
        amountCents: 250_000,
        payee: 'acme',
        initiatedBy: 'trustee-one@example.com',
      }));
      expect(approve).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(result.disbursement.status).toBe('pending_approval');
      expect(inserted).toHaveLength(1);
    });

    it('is raised by a named trustee or not at all', async () => {
      backOffice();
      await expect(
        WealthBackOfficeEngine.pushCredit({ origin: 'vendor_payable', originId: 'VPAY-1' })
      ).rejects.toThrowError(/initiatedBy is required/);
    });

    it('refuses an obligation its own desk has not approved', async () => {
      backOffice({ payables: [] });
      await expect(WealthBackOfficeEngine.pushCredit({
        origin: 'vendor_payable',
        originId: 'VPAY-1',
        initiatedBy: 'trustee-one@example.com',
      })).rejects.toThrowError(/is not awaiting a credit push/);
    });

    it('refuses to pay an obligation that already has a live push', async () => {
      backOffice({ existingPushes: [{ origin_id: 'VPAY-1', disbursement_id: 'PAYVP-1', status: 'approved' }] });
      const initiate = vi.spyOn(PayerOsEngine, 'initiate');
      await expect(WealthBackOfficeEngine.pushCredit({
        origin: 'vendor_payable',
        originId: 'VPAY-1',
        initiatedBy: 'trustee-one@example.com',
      })).rejects.toThrowError(/cannot be pushed twice/);
      expect(initiate).not.toHaveBeenCalled();
    });

    it('queues an obligation again once its earlier push has settled', async () => {
      backOffice({ existingPushes: [{ origin_id: 'VPAY-1', disbursement_id: 'PAYVP-1', status: 'settled' }] });
      const queue = await WealthBackOfficeEngine.creditQueue({ origin: 'vendor_payable' });
      expect(queue.items[0].pushable).toBe(true);
    });

    it('cancels the disbursement when the handoff cannot be recorded, rather than leaving it unlinked', async () => {
      backOffice({ handoffInsertFails: true });
      vi.spyOn(PayerOsEngine, 'initiate').mockResolvedValue(initiated as any);
      const cancel = vi.spyOn(PayerOsEngine, 'cancel').mockResolvedValue({} as any);
      await expect(WealthBackOfficeEngine.pushCredit({
        origin: 'vendor_payable',
        originId: 'VPAY-1',
        initiatedBy: 'trustee-one@example.com',
      })).rejects.toThrowError(/could not be recorded, so the push was cancelled/);
      expect(cancel).toHaveBeenCalledWith('PAYVP-9', 'trustee-one@example.com');
    });
  });

  describe('one position for the family bank', () => {
    it('adds the desks up in cents and reports what is committed to payees', async () => {
      backOffice();
      ledgerDesks({ glCashDollars: 1_000, cashLedgerCents: 100_000 });
      const book = await WealthBackOfficeEngine.bookOfRecord({});
      expect(book.complete).toBe(true);
      expect(book.position).toMatchObject({
        assetsCents: 150_000,
        cashCents: 100_000,
        bondCarryingCents: 51_250,
        committedToPayeesCents: 370_000,
        unencumberedCashCents: -270_000,
      });
      expect(book.reconciliation).toMatchObject({ ledgerCashCents: 100_000, cashLedgerCents: 100_000, reconciled: true });
    });

    it('reports the drift between the general ledger and the cash ledger instead of reconciling it away', async () => {
      backOffice();
      ledgerDesks({ glCashDollars: 1_500, cashLedgerCents: 100_000 });
      const book = await WealthBackOfficeEngine.bookOfRecord({});
      expect(book.reconciliation).toMatchObject({ driftCents: 50_000, reconciled: false });
    });

    it('marks the roll-up incomplete when a desk cannot be read rather than quietly omitting it', async () => {
      backOffice();
      ledgerDesks();
      vi.spyOn(TrustAccountingEngine, 'getBalanceSheet').mockRejectedValue(new Error('relation "trust_accounts" does not exist'));
      const book = await WealthBackOfficeEngine.bookOfRecord({});
      expect(book.complete).toBe(false);
      expect(book.errors[0]).toMatchObject({ desk: 'trust_accounting' });
      expect(book.position.assetsCents).toBeNull();
    });

    it('separates bond interest that has accrued from bond interest the ledger has posted', async () => {
      backOffice();
      ledgerDesks();
      const portfolio = await WealthBackOfficeEngine.fixedIncomePortfolio();
      expect(portfolio.totals).toMatchObject({ accruedCents: 1_000, unpostedAccrualCents: 250, carryingCents: 51_250 });
    });
  });

  describe("the day's duties", () => {
    it('names the desk accountable for every break and action it finds', async () => {
      backOffice();
      ledgerDesks({ glCashDollars: 1_500, cashLedgerCents: 100_000 });
      vi.spyOn(TrustAccountingEngine, 'listPeriods').mockResolvedValue([{ period_id: 'P-1' }] as any);
      vi.spyOn(CalendarEngine, 'listEvents').mockResolvedValue([] as any);

      const runbook = await WealthBackOfficeEngine.runbook({});
      const findings = runbook.findings.map((finding: any) => `${finding.desk}:${finding.severity}`);
      expect(findings).toContain('payouts:action');
      expect(findings).toContain('bookkeeping:break');
      expect(findings).toContain('treasury:break');
      expect(findings).toContain('fixed_income:action');
      expect(findings).toContain('bookkeeping:action');
      expect(findings).toContain('tax:action');
      expect(runbook.breaks).toBeGreaterThan(0);
    });
  });

  describe('reading a desk', () => {
    it('reports the section it could not read instead of failing the whole desk', async () => {
      backOffice();
      vi.spyOn(CashEngine, 'getPositionSummary').mockRejectedValue(new Error('cash_accounts is missing'));
      vi.spyOn(CorporateTreasuryEngine, 'listTransactions').mockResolvedValue([] as any);
      vi.spyOn(CashEngine, 'getMovements').mockResolvedValue([] as any);

      const banking = await WealthBackOfficeEngine.deskReport('core_banking', {});
      expect(banking.complete).toBe(false);
      expect(banking.errors[0]).toMatchObject({ section: 'cash' });

      const transactions = await WealthBackOfficeEngine.deskReport('transactions', {});
      expect(transactions.complete).toBe(true);
    });

    it('refuses a desk the family bank does not run', async () => {
      await expect(WealthBackOfficeEngine.deskReport('crypto_prop_trading', {})).rejects.toThrowError(/Unknown desk/);
    });

    it('states which engine owns each duty', () => {
      const desks = WealthBackOfficeEngine.desks();
      expect(desks.map((desk: any) => desk.desk)).toEqual(expect.arrayContaining([
        'treasury', 'core_banking', 'bookkeeping', 'trust_accounting', 'transactions',
        'payouts', 'tax', 'fixed_income', 'crm', 'scheduling', 'messaging',
      ]));
      for (const desk of desks) {
        expect(desk.sourceOfTruth).toBeTruthy();
        expect(desk.duties.length).toBeGreaterThan(0);
      }
    });
  });

  describe('clients, scheduling and messaging', () => {
    it('gathers one client from every desk that holds something of theirs', async () => {
      backOffice();
      vi.spyOn(CrmEngine, 'getContact').mockResolvedValue({
        contact_id: 'CONTACT-1', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com',
      } as any);
      vi.spyOn(CrmEngine, 'getBondSubscriptions').mockResolvedValue([{ subscription_id: 'SUB-1' }] as any);
      vi.spyOn(CrmEngine, 'getInteractions').mockResolvedValue([] as any);
      vi.spyOn(CalendarEngine, 'listEvents').mockResolvedValue([] as any);
      vi.spyOn(MessagingEngine, 'listThreads').mockResolvedValue([] as any);

      const client = await WealthBackOfficeEngine.client('CONTACT-1', {});
      expect(client).toMatchObject({ contactId: 'CONTACT-1', complete: true });
      expect(client.label).toBe('Client — Jane Doe');
      expect(client.data.subscriptions).toHaveLength(1);
    });

    it('schedules a duty against the desk that owns it', async () => {
      const createEvent = vi.spyOn(CalendarEngine, 'createEvent').mockResolvedValue({ id: 'EVT-1' } as any);
      await WealthBackOfficeEngine.scheduleDuty({
        desk: 'tax', duty: 'File Form 1041', dueAt: '2027-04-15', createdBy: 'trustee-one@example.com',
      });
      expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Tax reporting: File Form 1041',
        relatedModule: 'wealth_back_office',
        metadata: { desk: 'tax', duty: 'File Form 1041' },
      }));
    });

    it('will not open a thread with no subject or body', async () => {
      await expect(WealthBackOfficeEngine.postNote({ desk: 'payouts', subject: 'Missing body' }))
        .rejects.toThrowError(/subject and body are required/);
    });
  });

  describe('the Melio CSV rail the back office does not originate', () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

    const EXPORT = {
      id: 'MEL-1',
      status: 'exported',
      amount_cents: 250_000,
      currency: 'USD',
      created_at: daysAgo(0),
      updated_at: daysAgo(0),
      vendor_name: 'ACME PLUMBING LLC',
      file_name: 'melio-MEL-1.csv',
      portal_reference: null,
    };

    it('queues an open export as committed dollars nobody may push again, with the manual step named', async () => {
      backOffice({ payables: [], distributions: [], melioExports: [EXPORT] });
      const queue = await WealthBackOfficeEngine.creditQueue({});
      const item = queue.items.find((row: any) => row.origin === 'melio_export');
      expect(item).toMatchObject({ originId: 'MEL-1', pushable: false, amountCents: 250_000, desk: 'payouts' });
      expect(item.blockers[0]).toMatch(/Import melio-MEL-1\.csv in the Melio Bills portal/);
      expect(queue.totals.openCents).toBe(250_000);
      expect(queue.totals.pushableCents).toBe(0);
    });

    it('refuses to credit an obligation the same dollars are already exported for', async () => {
      backOffice({ distributions: [], melioExports: [EXPORT] });
      const queue = await WealthBackOfficeEngine.creditQueue({ origin: 'vendor_payable' });
      const payable = queue.items.find((row: any) => row.originId === 'VPAY-1');
      expect(payable.pushable).toBe(false);
      expect(payable.blockers.join(' ')).toMatch(/Melio CSV export MEL-1 \(exported\) already commits \$2,500\.00/);
    });

    it('leaves a second, different bill to the same vendor pushable', async () => {
      backOffice({
        distributions: [],
        melioExports: [{ ...EXPORT, amount_cents: 90_000 }],
      });
      const queue = await WealthBackOfficeEngine.creditQueue({ origin: 'vendor_payable' });
      const payable = queue.items.find((row: any) => row.originId === 'VPAY-1');
      expect(payable.pushable).toBe(true);
      expect(payable.blockers).toEqual([]);
    });

    it('ages each export against the step it is waiting on', async () => {
      backOffice({
        payables: [],
        distributions: [],
        melioExports: [
          { ...EXPORT, updated_at: daysAgo(3) },
          { ...EXPORT, id: 'MEL-2', status: 'submitted', portal_reference: 'MELIO-9911', updated_at: daysAgo(1) },
        ],
      });
      const exports_ = await WealthBackOfficeEngine.melioExports({});
      expect(exports_.totals).toMatchObject({ count: 2, staleCount: 1, openCents: 500_000 });
      expect(exports_.items[0]).toMatchObject({ awaiting: 'awaiting_import', ageDays: 3, stale: true });
      expect(exports_.items[1]).toMatchObject({ awaiting: 'awaiting_settlement', ageDays: 1, stale: false });
      expect(exports_.items[1].nextStep).toMatch(/MELIO-9911 is awaiting settlement/);
    });

    it('reports nothing outstanding when the rail has never been used', async () => {
      vi.spyOn(pool, 'query').mockImplementation(async (sql: any) => (
        /to_regclass/.test(String(sql)) ? { rows: [{ oid: null }] } : { rows: [] }
      ) as any);
      const exports_ = await WealthBackOfficeEngine.melioExports({});
      expect(exports_).toMatchObject({ items: [], totals: { count: 0, openCents: 0 } });
    });

    it('raises a break for an export that has sat unimported, and an action for one merely pending', async () => {
      backOffice({
        payables: [],
        distributions: [],
        melioExports: [
          { ...EXPORT, updated_at: daysAgo(4) },
          { ...EXPORT, id: 'MEL-3', status: 'submitted', portal_reference: 'MELIO-2', updated_at: daysAgo(1) },
        ],
      });
      ledgerDesks();
      const runbook = await WealthBackOfficeEngine.runbook({});
      const payouts = runbook.findings.filter((finding: any) => finding.desk === 'payouts');
      expect(payouts.find((finding: any) => finding.severity === 'break').finding)
        .toMatch(/Melio export MEL-1 for \$2,500\.00 to ACME PLUMBING LLC has been awaiting import for 4 day\(s\)/);
      expect(payouts.filter((finding: any) => finding.severity === 'action').map((finding: any) => finding.finding).join(' '))
        .toMatch(/waiting to be imported in the Bills portal[\s\S]*awaiting settlement/);
    });
  });

  describe('opening the desks', () => {
    /** Only these tables exist; `to_regclass` answers accordingly. */
    function withTables(present: string[]) {
      vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
        if (/to_regclass/.test(String(sql))) {
          return { rows: [{ oid: present.includes(String(params[0])) ? String(params[0]) : null }] } as any;
        }
        return { rows: [] } as any;
      });
    }

    it('prepares the desks that own their schema and leaves the rest to their migration', async () => {
      withTables(['trust_config', 'tax_returns_1041', 'k1_schedules', 'calendar_events']);
      const tax = vi.spyOn(TaxEngine, 'ensureTables').mockResolvedValue(true as any);
      const calendar = vi.spyOn(CalendarEngine, 'ensureTables').mockResolvedValue(undefined as any);
      vi.spyOn(CorporateTreasuryEngine, 'ensureTables').mockResolvedValue(undefined as any);
      vi.spyOn(MessagingEngine, 'ensureTables').mockResolvedValue(undefined as any);
      vi.spyOn(PayerOsEngine, 'ensureTables').mockResolvedValue(true as any);

      const schema = await WealthBackOfficeEngine.initDesks({});
      expect(tax).toHaveBeenCalled();
      expect(calendar).toHaveBeenCalled();

      const byDesk = new Map(schema.desks.map((desk: any) => [desk.desk, desk]));
      expect(byDesk.get('tax')).toMatchObject({ ready: true, prepared: ['tax_engine'] });
      expect(byDesk.get('crm')).toMatchObject({ ready: false, ownsSchema: false, missingTables: ['crm_contacts'] });
      expect(byDesk.get('crm').action).toMatch(/migrate-postgres-full\.sql/);
      expect(schema.ready).toBe(false);
    });

    it('reports a desk whose tables are still missing after its own engine ran, rather than calling it ready', async () => {
      withTables([]);
      vi.spyOn(CalendarEngine, 'ensureTables').mockResolvedValue(undefined as any);
      const schema = await WealthBackOfficeEngine.initDesks({ desk: 'scheduling' });
      expect(schema.desks).toHaveLength(1);
      expect(schema.desks[0]).toMatchObject({ ready: false, prepared: ['calendar'], missingTables: ['calendar_events'] });
      expect(schema.desks[0].action).toMatch(/still missing after the desk engine prepared its own schema/);
    });

    it('names the engine that could not prepare its own schema', async () => {
      withTables(['corporate_treasury_accounts']);
      vi.spyOn(CorporateTreasuryEngine, 'ensureTables').mockRejectedValue(new Error('permission denied for schema public'));
      const schema = await WealthBackOfficeEngine.initDesks({ desk: 'treasury' });
      expect(schema.desks[0]).toMatchObject({ ready: false, failures: [{ engine: 'corporate_treasury', error: 'permission denied for schema public' }] });
    });

    it('prepares nothing for a desk the family bank does not run', async () => {
      await expect(WealthBackOfficeEngine.initDesks({ desk: 'crypto_prop_trading' })).rejects.toThrowError(/Unknown desk/);
    });
  });

  describe('readiness', () => {
    it('reports whether credits can leave separately from whether the desks can be read', async () => {
      backOffice();
      ledgerDesks();
      vi.spyOn(WealthBackOfficeEngine, 'deskReport').mockResolvedValue({ complete: true, errors: [] } as any);
      vi.spyOn(PayerOsEngine, 'readiness').mockResolvedValue({
        ready: false,
        blockers: ['ACH credits cannot be originated: the system is in sandbox mode.'],
        originates: [],
        fundingSource: null,
      } as any);

      const readiness = await WealthBackOfficeEngine.readiness();
      expect(readiness.canPushCredits).toBe(false);
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers[0]).toMatch(/sandbox mode/);
      expect(readiness.note).toMatch(/never originates a payment itself/);
    });
  });
});

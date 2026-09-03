import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { BondStatementEngine, COUPON_TXN_TYPE } = require('../server/integrations/bonds/bondStatementEngine');
const { buildStatementPdf } = require('../server/integrations/bonds/bondStatementPdf');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

const BOND: Row = {
  id: 1,
  bond_name: 'DLB-PRB',
  isin: 'US-DLB-PRB-2024',
  bond_identifier: '19781443-DLB-PRB',
  statement_id: '197814430',
  bondholder: 'DeAndrea Lavar Barkley',
  issuer: 'DEANDREA LAVAR BARKLEY TRUST COMPANY',
  issuer_state: 'CA',
  venue_state: 'OH',
  face_value: '100000000.00',
  coupon_rate: '0.010000',
  issue_date: new Date('2024-02-28T00:00:00Z'),
  maturity_date: new Date('2124-02-28T00:00:00Z'),
  payment_freq: 'semi-annual',
  day_count: '30/360',
  currency: 'USD',
  status: 'active',
};

interface State {
  balance: Row;
  txns: Row[];
}

function fakeDb(state: State) {
  let nextId = 100;
  const handler = async (sql: string, params: any[] = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK') return { rows: [] };
    if (q.startsWith('SELECT b.*, bb.principal_balance')) {
      const key = params[0];
      const match = q.includes('FOR UPDATE')
        ? Number(key) === BOND.id
        : key === BOND.statement_id || params[1] === BOND.id || String(key).toUpperCase() === BOND.bond_identifier || String(key).toUpperCase() === BOND.bond_name;
      return { rows: match ? [{ ...BOND, ...state.balance }] : [] };
    }
    if (q.startsWith('SELECT transaction_date FROM bond_transactions')) {
      return { rows: state.txns.filter((t) => t.bond_id === params[0] && t.transaction_type === params[1]) };
    }
    if (q.startsWith('SELECT transaction_type, amount, running_balance')) {
      const asOf = String(params[2]);
      return {
        rows: state.txns
          .filter((t) => t.bond_id === params[0] && (t.transaction_type === 'issuance' || t.transaction_type === params[1]) && t.transaction_date <= asOf)
          .sort((a, b) => (a.transaction_date < b.transaction_date ? -1 : 1)),
      };
    }
    if (q.startsWith('INSERT INTO bond_transactions')) {
      const [bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date] = params;
      state.txns.push({ id: nextId++, bond_id, transaction_type, amount: String(amount), running_balance, accrued_interest, description, transaction_date });
      return { rows: [] };
    }
    if (q.startsWith('UPDATE bond_balances SET accrued_interest')) {
      state.balance = { ...state.balance, accrued_interest: String(params[0]), last_accrual_date: params[1] };
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${q.slice(0, 80)}`);
  };
  return handler;
}

describe('BondStatementEngine', () => {
  let state: State;

  beforeEach(() => {
    state = {
      balance: { principal_balance: '100000000.00', accrued_interest: '0.00', total_interest_paid: '0.00', total_principal_paid: '0.00', last_accrual_date: '2024-02-28', last_payment_date: null },
      txns: [{ id: 1, bond_id: 1, transaction_type: 'issuance', amount: '100000000.00', running_balance: '100000000.00', accrued_interest: '0', description: 'issued', transaction_date: '2024-02-28' }],
    };
    const db = fakeDb(state);
    vi.spyOn(pool, 'query').mockImplementation(db as any);
    vi.spyOn(pool, 'connect').mockImplementation(async () => ({ query: db, release: () => undefined }) as any);
  });

  afterEach(() => vi.restoreAllMocks());

  it('derives the semi-annual schedule the statement shows: 5 periods of $500k through 2026-09-01', () => {
    const sched = BondStatementEngine.schedule(BOND, '2026-09-01');
    expect(sched.couponPerPeriod).toBe(500000);
    expect(sched.periodRate).toBeCloseTo(0.005);
    expect(sched.rows.map((r: Row) => r.date)).toEqual(['2024-02-28', '2024-08-28', '2025-02-28', '2025-08-28', '2026-02-28', '2026-08-28']);
    expect(sched.rows[5]).toMatchObject({ period: 5, cumulativeInterest: 2500000, endingBalance: 102500000 });
  });

  it('clamps coupon dates to month end and never schedules past maturity', () => {
    const sched = BondStatementEngine.schedule({ ...BOND, issue_date: '2024-08-31', maturity_date: '2025-02-28', payment_freq: 'quarterly' }, '2030-01-01');
    expect(sched.rows.map((r: Row) => r.date)).toEqual(['2024-08-31', '2024-11-30', '2025-02-28']);
    expect(sched.couponPerPeriod).toBe(250000);
  });

  it('registers elapsed coupons on the ledger idempotently and carries them into the balance', async () => {
    const first = await BondStatementEngine.registerCoupons('197814430', { asOf: '2026-09-01', actor: 'trustee' });
    expect(first.registered).toHaveLength(5);
    expect(first.accruedInterest).toBe(2500000);
    expect(first.lastAccrualDate).toBe('2026-08-28');
    expect(state.txns.filter((t) => t.transaction_type === COUPON_TXN_TYPE)).toHaveLength(5);
    expect(state.balance.accrued_interest).toBe('2500000');

    const again = await BondStatementEngine.registerCoupons(1, { asOf: '2026-09-01' });
    expect(again.registered).toHaveLength(0);
    expect(again.skipped).toBe(5);
    expect(state.txns.filter((t) => t.transaction_type === COUPON_TXN_TYPE)).toHaveLength(5);
  });

  it('only registers the periods missing from the ledger', async () => {
    state.txns.push({ id: 2, bond_id: 1, transaction_type: COUPON_TXN_TYPE, amount: '500000.00', running_balance: '100000000', accrued_interest: '500000', description: 'p1', transaction_date: '2024-08-28' });
    state.balance.accrued_interest = '500000.00';
    const result = await BondStatementEngine.registerCoupons('DLB-PRB', { asOf: '2025-03-01' });
    expect(result.registered.map((r: Row) => r.date)).toEqual(['2025-02-28']);
    expect(result.accruedInterest).toBe(1000000);
  });

  it('builds the statement from the ledger and reports it reconciled to the schedule', async () => {
    await BondStatementEngine.registerCoupons(1, { asOf: '2026-09-01' });
    const s = await BondStatementEngine.buildStatement('#197814430', { asOf: '2026-09-01' });
    expect(s.statementId).toBe('197814430');
    expect(s.bondholder).toBe('DeAndrea Lavar Barkley');
    expect(s.venueState).toBe('OH');
    expect(s.terms).toMatchObject({ principal: 100000000, couponRate: 0.01, paymentFrequency: 'Semi-Annual', couponPerPeriod: 500000, termYears: 100 });
    expect(s.balance).toEqual({ originalPrincipal: 100000000, periodsElapsed: 5, cumulativeInterest: 2500000, endToDateBalance: 102500000 });
    expect(s.ledger).toMatchObject({ couponRows: 5, cumulativeInterest: 2500000, reconciled: true, missingPeriods: [] });
    expect(s.schedule.every((r: Row) => r.ledgered)).toBe(true);
  });

  it('flags periods the ledger has not registered yet', async () => {
    const s = await BondStatementEngine.buildStatement(1, { asOf: '2025-03-01' });
    expect(s.balance.periodsElapsed).toBe(2);
    expect(s.ledger.reconciled).toBe(false);
    expect(s.ledger.missingPeriods).toEqual(['2024-08-28', '2025-02-28']);
    expect(s.schedule[0].ledgered).toBe(true);
    expect(s.schedule[1].ledgered).toBe(false);
  });

  it('rejects unknown bond references', async () => {
    await expect(BondStatementEngine.buildStatement('nope')).rejects.toThrow('not found');
    await expect(BondStatementEngine.registerCoupons('999')).rejects.toThrow('not found');
  });

  it('renders a two-page PDF carrying the statement figures', async () => {
    await BondStatementEngine.registerCoupons(1, { asOf: '2026-09-01' });
    const { pdf, filename, statement } = await BondStatementEngine.renderPdf(1, { asOf: '2026-09-01' });
    expect(filename).toBe('bond-statement-197814430-2026-09-01.pdf');
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('STATEMENT ID: #197814430');
    expect(text).toContain('$102,500,000.00 USD');
    expect(text).toContain('State of Ohio');
    expect(text).toContain('5 Semi-Annual Periods');
    expect(text.match(/%%EOF/g)).toHaveLength(1);
    expect(buildStatementPdf(statement).length).toBe(pdf.length);
  });
});

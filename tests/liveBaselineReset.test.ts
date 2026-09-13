import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { LiveBaselineReset, CONFIRM_TOKEN } = require('../server/integrations/accounting/liveBaselineReset');
const { DataBridge } = require('../server/integrations/accounting/dataBridge');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

function prodLikeStore() {
  const writes: string[] = [];
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(UPDATE|INSERT|DELETE|WITH del|CREATE)/.test(text)) { writes.push(text); return { rows: [], rowCount: 0 }; }
    if (text.startsWith('SELECT id, bond_name, face_value, coupon_rate')) {
      return { rows: [{ id: 1, bond_name: 'DLB-PRB', face_value: '100000000', coupon_rate: '0.01', payment_freq: 'semi-annual',
        issue_date: '2024-02-28', maturity_date: '2124-02-28', status: 'active' }] };
    }
    if (text.startsWith('SELECT account_id, account_name, account_type, balance_cents')) {
      return { rows: [{ account_id: 'CA-OPERATING', account_name: 'Trust Operating Account', account_type: 'operating', balance_cents: '584259700', status: 'active' }] };
    }
    if (text.startsWith('SELECT id, amount, transaction_date FROM bond_transactions')) {
      return { rows: [250, 251, 252, 253, 254].map((id, i) => ({ id, amount: '500000', transaction_date: `${2024 + Math.floor((i + 1) / 2)}-${(i % 2) === 0 ? '08' : '02'}-28` })) };
    }
    if (text.startsWith('SELECT COUNT(*) AS c FROM bond_transactions WHERE bond_id')) return { rows: [{ c: '6' }] };
    if (text.startsWith('SELECT COUNT(*) AS c FROM data_bridge_discrepancies')) return { rows: [{ c: '2089' }] };
    if (text.startsWith('SELECT COUNT(*) AS c FROM')) return { rows: [{ c: '42' }] };
    if (text.startsWith('SELECT id, bond_name, face_value, status FROM bonds')) {
      return { rows: [{ id: 2, bond_name: 'PR243-Test', face_value: '100', status: 'active' }] };
    }
    if (text.startsWith('SELECT account_id, account_name, balance_cents FROM cash_accounts')) {
      return { rows: [{ account_id: 'CA-BOND-PROCEEDS', account_name: 'Bond Proceeds', balance_cents: '9400000000' }] };
    }
    if (text.startsWith('SELECT account_code, account_name, balance FROM trust_accounts')) {
      return { rows: [{ account_code: '1210', account_name: 'Stablecoin', balance: '8786154' }] };
    }
    if (text.startsWith('SELECT sub_ledger_id, sub_account_name')) {
      return { rows: [{ sub_ledger_id: 'SL-1', sub_account_name: 'Client A', parent_account_code: '1100', balance: '98822652.72' }] };
    }
    throw new Error('unexpected query: ' + text.slice(0, 120));
  });
  vi.spyOn(pool, 'query').mockImplementation(query as any);
  return { query, writes };
}

function balanced(entry: Row) {
  const dr = entry.lines.reduce((s: number, l: Row) => s + l.debit, 0);
  const cr = entry.lines.reduce((s: number, l: Row) => s + l.credit, 0);
  return Math.abs(dr - cr) < 0.005;
}

afterEach(() => vi.restoreAllMocks());

describe('LiveBaselineReset.plan', () => {
  it('derives issuer-side baseline entries from the live bond, real cash and registered coupon periods', async () => {
    const { writes } = prodLikeStore();
    const plan = await LiveBaselineReset.plan({ asOf: '2026-09-13' });

    expect(writes).toEqual([]);
    expect(plan.liveBond.name).toBe('DLB-PRB');
    expect(plan.realCashTotal).toBe(5842597);
    expect(plan.subscriptionReceivable).toBe(94157403);
    expect(plan.couponPeriodsRegistered).toBe(5);
    expect(plan.couponPeriodsExpected).toBe(5);
    expect(plan.couponsPayableTotal).toBe(2500000);

    expect(plan.baselineEntries).toHaveLength(7);
    expect(plan.baselineEntries.every(balanced)).toBe(true);

    const [issuance, cash, ...coupons] = plan.baselineEntries;
    expect(issuance.lines).toEqual([
      { accountCode: '1310', debit: 100000000, credit: 0 },
      { accountCode: '2300', debit: 0, credit: 100000000 },
    ]);
    expect(cash.lines).toEqual([
      { accountCode: '1000', debit: 5842597, credit: 0 },
      { accountCode: '1310', debit: 0, credit: 5842597 },
    ]);
    expect(coupons.map((c: Row) => c.referenceId)).toEqual(['250', '251', '252', '253', '254']);
    expect(coupons[0].lines.map((l: Row) => l.accountCode)).toEqual(['5400', '2320']);

    expect(plan.archive.testBondsToRetire).toEqual([{ id: 2, name: 'PR243-Test', faceValue: 100 }]);
    expect(plan.archive.subLedgersToReparent[0]).toMatchObject({ from: '1100', to: '2300' });
    expect(plan.archive.openDiscrepanciesToResolve).toBe(2089);
  });

  it('refuses a real-cash figure larger than the bond face', async () => {
    const { query } = prodLikeStore();
    query.mockImplementationOnce(async () => ({ rows: [{ id: 1, bond_name: 'DLB-PRB', face_value: '1000', coupon_rate: '0.01',
      payment_freq: 'semi-annual', issue_date: '2024-02-28', maturity_date: '2124-02-28', status: 'active' }] }));
    await expect(LiveBaselineReset.plan({ asOf: '2026-09-13' })).rejects.toThrow(/exceeds bond face/);
  });
});

describe('LiveBaselineReset.run', () => {
  it('is a dry run unless dryRun=false AND the confirm token is supplied', async () => {
    const { writes } = prodLikeStore();
    const connect = vi.spyOn(pool, 'connect');

    const a = await LiveBaselineReset.run({});
    const b = await LiveBaselineReset.run({ dryRun: false });
    const c = await LiveBaselineReset.run({ confirm: CONFIRM_TOKEN });

    expect([a.mode, b.mode, c.mode]).toEqual(['dry_run', 'dry_run', 'dry_run']);
    expect(a.note).toContain(CONFIRM_TOKEN);
    expect(writes).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('DataBridge live baseline cutoff', () => {
  it('produces no filter when unset and a bound timestamp filter when set', async () => {
    const q = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as any);
    expect(await DataBridge.liveBaselineCutoffSql('bt.created_at')).toBe('');

    q.mockResolvedValue({ rows: [{ value: '2026-09-13T12:00:00.000Z' }] } as any);
    expect(await DataBridge.liveBaselineCutoffSql('bt.created_at'))
      .toBe(" AND bt.created_at >= '2026-09-13T12:00:00.000Z'::timestamptz");
    await expect(DataBridge.liveBaselineCutoffSql('bt.created_at; DROP')).rejects.toThrow(/Invalid cutoff column/);
  });
});

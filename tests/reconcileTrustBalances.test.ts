import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { deriveBalances, reconcileTrustBalances, parseArgs } = require('../server/scripts/reconcileTrustBalances');

function fakeDb() {
  const calls = [];
  const rows = [
    { account_code: '1000', account_name: 'Trust Cash', account_type: 'asset', stored_balance: '90.00', derived_balance: '100.00' },
    { account_code: '2100', account_name: 'Fees Payable', account_type: 'liability', stored_balance: '25.00', derived_balance: '20.00' },
  ];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT ta.account_code')) return { rows };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, params) {
          calls.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

describe('trust balance reconciliation script', () => {
  it('reports drift by default without opening an apply transaction', async () => {
    const db = fakeDb();
    const result = await reconcileTrustBalances({ db });

    expect(result.apply).toBe(false);
    expect(result.drift).toHaveLength(2);
    expect(result.balances[0].drift).toBe(10);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain("je.status = 'posted'");
  });

  it('applies derived balances only with --apply and records an audit row', async () => {
    const db = fakeDb();
    const result = await reconcileTrustBalances({ apply: parseArgs(['--apply']).apply, db });

    expect(result.apply).toBe(true);
    expect(result.applied).toHaveLength(2);
    expect(db.calls.some((call) => call.sql.startsWith('UPDATE trust_accounts'))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO admin_audit_log'))).toBe(true);
  });

  it('does not enable apply for arbitrary arguments', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--report']).apply).toBe(false);
  });
});

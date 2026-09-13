import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DataBridge } = require('../server/integrations/accounting/dataBridge');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/** Fineract GL summary shaped like FineractClient.getGLSummary(): grouped by category. */
function glSummary(balances: Record<string, number>) {
  return {
    accounts: {
      assets: [
        { id: 68, glCode: '1000', balance: balances['1000'] ?? 0 },
        { id: 73, glCode: '1100', balance: balances['1100'] ?? 0 },
      ],
      liabilities: [],
      equity: [{ id: 81, glCode: '3000', balance: balances['3000'] ?? 0 }],
      income: [],
      expenses: [],
    },
  };
}

function fineractLine(transactionId: string, comments: string, glAccountId: number, reversed = false) {
  return { transactionId, comments, glAccountId, reversed, amount: 1, entryType: { value: 'DEBIT' } };
}

/** Local trust books answered from memory; every write is recorded. */
function store({
  accounts = [
    { account_code: '1000', account_name: 'Cash', account_type: 'asset', balance: 100 },
    { account_code: '1100', account_name: 'Bonds', account_type: 'asset', balance: 500 },
    { account_code: '3000', account_name: 'Corpus', account_type: 'equity', balance: 600 },
  ] as Row[],
  mappings = [
    { trust_account_code: '1000', fineract_gl_id: 68, description: 'Cash' },
    { trust_account_code: '1100', fineract_gl_id: 73, description: 'Bonds' },
    { trust_account_code: '3000', fineract_gl_id: 81, description: 'Corpus' },
  ] as Row[],
  entries = [] as Row[],
  integrity = [] as Row[],
} = {}) {
  const writes: Array<{ sql: string; params: any[] }> = [];
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
    if (text.startsWith('INSERT INTO data_sync_log') || text.startsWith('INSERT INTO data_discrepancies')) {
      writes.push({ sql: text, params }); return { rows: [] };
    }
    if (text.startsWith('UPDATE trust_journal_entries')) {
      writes.push({ sql: text, params });
      if (params.length === 2) {
        const entry = entries.find((e) => e.entry_id === params[1]);
        if (entry) entry.fineract_txn_id = params[0];
      } else {
        entries.forEach((e) => { e.fineract_txn_id = null; });
      }
      return { rows: [] };
    }
    if (text.includes('FROM fineract_gl_mappings')) return { rows: mappings };
    if (text.startsWith('SELECT account_code, account_name, account_type, balance FROM trust_accounts')) return { rows: accounts };
    if (text.includes('journal_balance')) return { rows: integrity };
    if (text.includes('COUNT(*) FILTER (WHERE fineract_txn_id IS NULL) AS unsynced')) {
      return { rows: [{ total: String(entries.length), unsynced: String(entries.filter((e) => !e.fineract_txn_id).length) }] };
    }
    if (text.startsWith('SELECT COUNT(*) AS count FROM trust_journal_entries')) {
      return { rows: [{ count: String(entries.filter((e) => !e.fineract_txn_id).length) }] };
    }
    if (text.includes('json_agg') && text.includes('FROM trust_journal_entries je')) {
      return { rows: entries.filter((e) => !e.fineract_txn_id).slice(0, params[0]) };
    }
    throw new Error('unexpected query: ' + text.slice(0, 120));
  });
  vi.spyOn(pool, 'query').mockImplementation(query as any);
  return { query, writes, entries };
}

function localEntry(entryId: string, status = 'posted', description = 'Fund cash') {
  return {
    id: 1, entry_id: entryId, entry_date: '2026-09-01', description, reference_type: 'wire',
    reference_id: null, bond_id: null, posted_by: 'test', fineract_txn_id: null, status,
    lines: [
      { account_code: '1000', debit_amount: '100', credit_amount: '0', memo: null },
      { account_code: '3000', debit_amount: '0', credit_amount: '100', memo: null },
    ],
  };
}

beforeEach(() => {
  vi.spyOn(DataBridge, '_logSync').mockResolvedValue(undefined);
  vi.spyOn(DataBridge, '_logDiscrepancy').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DataBridge._flattenGlAccounts', () => {
  it('flattens the category-grouped summary into one account list', () => {
    const flat = DataBridge._flattenGlAccounts(glSummary({ '1000': 1, '1100': 2, '3000': 3 }));
    expect(flat.map((a: Row) => a.id)).toEqual([68, 73, 81]);
  });

  it('accepts the degraded bare-array shape and empty input', () => {
    expect(DataBridge._flattenGlAccounts({ accounts: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(DataBridge._flattenGlAccounts({ accounts: [] })).toEqual([]);
    expect(DataBridge._flattenGlAccounts(null)).toEqual([]);
  });
});

describe('DataBridge.reconcileFineractGL', () => {
  it('reconciles every mapped account against the grouped Fineract summary', async () => {
    store();
    vi.spyOn(FineractClient, 'getGLSummary').mockResolvedValue(glSummary({ '1000': 100, '1100': 3_400_000_000, '3000': 600 }));

    const result = await DataBridge.reconcileFineractGL();

    expect(result.message).toBeUndefined();
    expect(result.matched).toBe(2);
    expect(result.unmatched).toBe(1);
    const mismatch = result.discrepancies.find((d: Row) => d.type === 'balance_mismatch');
    expect(mismatch.trustAccountCode).toBe('1100');
    expect(mismatch.severity).toBe('critical');
    expect(mismatch.difference).toBeCloseTo(500 - 3_400_000_000, 2);
  });

  it('still reports a connection problem when Fineract returns nothing', async () => {
    store();
    vi.spyOn(FineractClient, 'getGLSummary').mockResolvedValue({ accounts: [] });
    const result = await DataBridge.reconcileFineractGL();
    expect(result.message).toMatch(/no accounts/);
    expect(result.matched).toBe(0);
  });
});

describe('DataBridge.pushToFineract', () => {
  it('mirrors posted, reversed and reversal entries and records the Fineract transactionId', async () => {
    const { entries } = store({ entries: [localEntry('JRN-A'), localEntry('JRN-B', 'reversed'), localEntry('JRN-C', 'posted', 'Reversal of JRN-B')] });
    vi.spyOn(FineractClient, 'getAllJournalEntries').mockResolvedValue([]);
    const post = vi.spyOn(FineractClient, 'postJournalEntry').mockImplementation(async ({ comments }: any) => ({
      resourceId: 9, transactionId: 'TX-' + comments.slice(9, 14),
    }));

    const result = await DataBridge.pushToFineract();

    expect(result).toMatchObject({ synced: 3, skipped: 0, failed: 0, remaining: 0 });
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls[0][0].comments).toBe('Trust JE JRN-A: Fund cash');
    expect(post.mock.calls[0][0].debits).toEqual([{ glAccountId: 68, amount: 100 }]);
    expect(post.mock.calls[0][0].credits).toEqual([{ glAccountId: 81, amount: 100 }]);
    expect(entries.map((e) => e.fineract_txn_id)).toEqual(['TX-JRN-A', 'TX-JRN-B', 'TX-JRN-C']);
  });

  it('links entries already present in Fineract instead of posting them again', async () => {
    const { entries } = store({ entries: [localEntry('JRN-A')] });
    vi.spyOn(FineractClient, 'getAllJournalEntries').mockResolvedValue([
      fineractLine('TX-OLD', 'Trust JE JRN-A: Fund cash', 68),
      fineractLine('TX-GONE', 'Trust JE JRN-A: Fund cash', 68, true),
    ]);
    const post = vi.spyOn(FineractClient, 'postJournalEntry').mockResolvedValue({ transactionId: 'TX-NEW' });

    const result = await DataBridge.pushToFineract();

    expect(post).not.toHaveBeenCalled();
    expect(result).toMatchObject({ synced: 0, skipped: 1, failed: 0 });
    expect(entries[0].fineract_txn_id).toBe('TX-OLD');
  });

  it('refuses to post when the Fineract journal cannot be read for the idempotency check', async () => {
    store({ entries: [localEntry('JRN-A')] });
    vi.spyOn(FineractClient, 'getAllJournalEntries').mockRejectedValue(new Error('fineract down'));
    const post = vi.spyOn(FineractClient, 'postJournalEntry').mockResolvedValue({ transactionId: 'TX-NEW' });

    const result = await DataBridge.pushToFineract();

    expect(post).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toMatch(/idempotency/);
  });

  it('reports entries whose accounts have no GL mapping instead of silently dropping them', async () => {
    const entry = localEntry('JRN-A');
    entry.lines[0].account_code = 'PTC-UNMAPPED';
    store({ entries: [entry] });
    vi.spyOn(FineractClient, 'getAllJournalEntries').mockResolvedValue([]);
    const post = vi.spyOn(FineractClient, 'postJournalEntry');

    const result = await DataBridge.pushToFineract();

    expect(post).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.errors[0]).toMatchObject({ entryId: 'JRN-A', skipped: true });
    expect(result.errors[0].error).toMatch(/PTC-UNMAPPED/);
  });
});

describe('DataBridge.verifyTrustBalanceIntegrity', () => {
  it('flags accounts whose cached balance drifted from their journal lines', async () => {
    store({
      integrity: [
        { account_code: '1000', account_name: 'Cash', account_type: 'asset', balance: '100.00', journal_balance: '100.00', line_count: '4' },
        { account_code: '1100', account_name: 'Bonds', account_type: 'asset', balance: '98823257.11', journal_balance: '100000374.39', line_count: '23' },
      ],
    });
    const result = await DataBridge.verifyTrustBalanceIntegrity();
    expect(result.consistent).toBe(false);
    expect(result.accountsChecked).toBe(2);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({ accountCode: '1100', difference: -1177117.28 });
  });
});

describe('DataBridge.rebuildFineractMirror', () => {
  const fineractJournal = [
    fineractLine('TX-1', 'Opening balance — DLB-PRB bond issuance $100M face value', 73),
    fineractLine('TX-2', 'Opening balance — DLB-PRB bond issuance $100M face value', 73),
    fineractLine('TX-3', 'Trust JE JRN-A: Fund cash', 68),
    fineractLine('TX-4', 'Trust JE JRN-A: Fund cash', 68),
    fineractLine('TX-5', 'Trust JE JRN-Z: Old', 68, true),
    fineractLine('TX-6', 'Reversal entry for Journal Entry with Entry Id  :5 and transaction Id TX-5', 68),
  ];

  it('dry-runs by default and touches neither book', async () => {
    const { writes } = store({ entries: [localEntry('JRN-A'), localEntry('JRN-B')] });
    vi.spyOn(FineractClient, 'getAllJournalEntries').mockResolvedValue(fineractJournal);
    const reverse = vi.spyOn(FineractClient, 'reverseJournalEntry');
    const post = vi.spyOn(FineractClient, 'postJournalEntry');

    const result = await DataBridge.rebuildFineractMirror({ dryRun: false });

    expect(result.mode).toBe('dry_run');
    expect(result.plan).toMatchObject({
      fineractLiveTransactions: 4,
      fineractDuplicateTransactions: 1,
      fineractTransactionsWithoutLocalEntry: 2,
      localEntriesToMirror: 2,
    });
    expect(reverse).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('reverses every live Fineract transaction and re-pushes the whole local journal when confirmed', async () => {
    const { entries } = store({ entries: [localEntry('JRN-A'), localEntry('JRN-B')] });
    const journal = fineractJournal.map((j) => ({ ...j }));
    vi.spyOn(FineractClient, 'getAllJournalEntries').mockImplementation(async () => journal);
    const reverse = vi.spyOn(FineractClient, 'reverseJournalEntry').mockImplementation(async (txn: string) => {
      journal.forEach((j) => { if (j.transactionId === txn) j.reversed = true; });
      return { transactionId: txn + '-REV' };
    });
    vi.spyOn(FineractClient, 'clearCache').mockImplementation(() => undefined);
    const post = vi.spyOn(FineractClient, 'postJournalEntry').mockImplementation(async ({ comments }: any) => ({ transactionId: 'NEW-' + comments.slice(9, 14) }));
    vi.spyOn(FineractClient, 'getGLSummary').mockResolvedValue(glSummary({ '1000': 100, '1100': 500, '3000': 600 }));

    const result = await DataBridge.rebuildFineractMirror({ dryRun: false, confirm: 'REBUILD_FINERACT_MIRROR' });

    expect(result.mode).toBe('executed');
    expect(result.reversed).toBe(4);
    expect(reverse.mock.calls.map((c) => c[0]).sort()).toEqual(['TX-1', 'TX-2', 'TX-3', 'TX-4']);
    expect(post).toHaveBeenCalledTimes(2);
    expect(result.pushed).toMatchObject({ synced: 2, skipped: 0, failed: 0 });
    expect(entries.map((e) => e.fineract_txn_id)).toEqual(['NEW-JRN-A', 'NEW-JRN-B']);
    expect(result.reconciliation.matched).toBe(3);
  });

  it('aborts before re-pushing when a Fineract reversal fails', async () => {
    const { entries } = store({ entries: [localEntry('JRN-A')] });
    entries[0].fineract_txn_id = 'TX-3';
    vi.spyOn(FineractClient, 'getAllJournalEntries').mockResolvedValue(fineractJournal);
    vi.spyOn(FineractClient, 'reverseJournalEntry').mockRejectedValue(new Error('403 closed period'));
    const post = vi.spyOn(FineractClient, 'postJournalEntry');

    const result = await DataBridge.rebuildFineractMirror({ dryRun: false, confirm: 'REBUILD_FINERACT_MIRROR' });

    expect(result.mode).toBe('aborted');
    expect(result.errors).toHaveLength(4);
    expect(post).not.toHaveBeenCalled();
    expect(entries[0].fineract_txn_id).toBe('TX-3');
  });
});

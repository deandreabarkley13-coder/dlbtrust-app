import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pool = require('../server/integrations/bonds/pgPool');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { DataBridge } = require('../server/integrations/accounting/dataBridge');
const { WireEngine } = require('../server/integrations/wire/wireEngine');
const { ExpenseManagementEngine } = require('../server/integrations/accounting/expenseManagementEngine');
const { DistributionRequestEngine } = require('../server/integrations/dapp/distributionRequestEngine');
const { PayoutCenterEngine } = require('../server/integrations/dapp/payoutCenterEngine');
const { MessagingEngine } = require('../server/integrations/messaging/messagingEngine');
const { CalendarEngine } = require('../server/integrations/calendar/calendarEngine');

let transactionQuery: ReturnType<typeof vi.fn>;

beforeEach(() => {
  transactionQuery = vi.fn().mockResolvedValue({ rows: [] });
  vi.spyOn(pool, 'connect').mockResolvedValue({
    query: transactionQuery,
    release: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wire bookkeeping', () => {
  it('posts trust distributions to undistributed income and links the journal', async () => {
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry')
      .mockResolvedValue({ entry_id: 'JRN-WIRE-1' });

    const entry = await WireEngine.postAccountingEntry({
      wire_id: 'WIRE-1',
      payment_type: 'trust_distribution',
      amount_cents: 12550,
      beneficiary_name: 'Beneficiary',
      metadata: {},
    });

    expect(entry.entry_id).toBe('JRN-WIRE-1');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      referenceType: 'wire_transfer',
      referenceId: 'WIRE-1',
      lines: [
        expect.objectContaining({ accountCode: '3100', debitAmount: 125.5, creditAmount: 0 }),
        expect.objectContaining({ accountCode: '1000', debitAmount: 0, creditAmount: 125.5 }),
      ],
    }));
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wire_transfers SET journal_entry_id'),
      ['WIRE-1', 'JRN-WIRE-1']
    );
  });

  it('reuses legacy wire journal references instead of posting a duplicate', async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT entry_id')) return { rows: [{ entry_id: 'JRN-LEGACY' }] };
      return { rows: [] };
    });
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry');

    const entry = await WireEngine.postAccountingEntry({
      wire_id: 'WIRE-LEGACY',
      payment_type: 'vendor_payment',
      amount_cents: 5000,
      metadata: {},
    });

    expect(entry.entry_id).toBe('JRN-LEGACY');
    expect(post).not.toHaveBeenCalled();
  });

  it('reverses a referenced wire journal when a wire is returned', async () => {
    const wire = {
      wire_id: 'WIRE-RETURN',
      status: 'settled',
      journal_entry_id: null,
    };
    vi.spyOn(WireEngine, 'getWire')
      .mockResolvedValueOnce(wire)
      .mockResolvedValueOnce({ ...wire, status: 'returned', journal_entry_id: 'JE-RETURN' });
    const query = vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (sql.includes('FROM trust_journal_entries')) return { rows: [{ entry_id: 'JE-RETURN' }] };
      return { rows: [] };
    });
    const reverse = vi.spyOn(TrustAccountingEngine, 'reverseJournalEntry').mockResolvedValue({
      entry_id: 'JE-REVERSAL',
    });

    const result = await WireEngine.returnWire('WIRE-RETURN', 'Beneficiary account closed');

    expect(result.status).toBe('returned');
    expect(reverse).toHaveBeenCalledWith('JE-RETURN', { postedBy: 'system' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wire_transfers SET journal_entry_id'),
      ['WIRE-RETURN', 'JE-RETURN']
    );
  });
});

describe('expense lifecycle', () => {
  it('creates a pending trust payment request with an explicit expense account', async () => {
    vi.spyOn(ExpenseManagementEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(ExpenseManagementEngine, 'getExpense').mockResolvedValue({
      id: 'EXP-1',
      expense_type: 'Legal services',
      amount_cents: 25000,
      currency: 'USD',
      payee: 'Counsel',
      status: 'approved',
      metadata: {},
    });
    const createRequest = vi.spyOn(DistributionRequestEngine, 'createRequest')
      .mockResolvedValue({ id: 'REQ-1', status: 'requested' });
    const update = vi.spyOn(ExpenseManagementEngine, '_update').mockResolvedValue({
      id: 'EXP-1',
      status: 'payment_pending',
      request_id: 'REQ-1',
      metadata: {},
    });

    await ExpenseManagementEngine.payExpense('EXP-1', {
      destinationAddress: '0x1111111111111111111111111111111111111111',
      createdBy: 'trustee@example.com',
    });

    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'trust',
      sourceAccountId: '1000',
      metadata: expect.objectContaining({
        expenseId: 'EXP-1',
        expenseAccountCode: '5200',
      }),
    }));
    expect(update).toHaveBeenCalledWith(
      'expense_records',
      'EXP-1',
      expect.objectContaining({ status: 'payment_pending', request_id: 'REQ-1' })
    );
  });

  it('keeps an expense pending until its payout completes', async () => {
    const request = {
      id: 'REQ-2',
      type: 'disbursement',
      status: 'approved',
      amount_cents: 10000,
      destination_address: '0x2222222222222222222222222222222222222222',
      beneficiary_email: 'beneficiary@example.com',
      metadata: { expenseId: 'EXP-2' },
    };
    vi.spyOn(DistributionRequestEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(request);
    const update = vi.spyOn(DistributionRequestEngine, '_update').mockResolvedValue(request);
    vi.spyOn(PayoutCenterEngine, 'createPayment').mockResolvedValue({
      id: 'PC-1',
      status: 'pending',
      tx_hash: null,
    });
    vi.spyOn(MessagingEngine, 'notify').mockResolvedValue(undefined);
    vi.spyOn(CalendarEngine, 'createEvent').mockResolvedValue(undefined);
    const query = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] });

    await DistributionRequestEngine.executeRequest('REQ-2');

    expect(update).toHaveBeenCalledWith(
      'REQ-2',
      expect.objectContaining({ status: 'payout_created', payout_id: 'PC-1' })
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE expense_records'),
      expect.arrayContaining(['EXP-2', 'payment_pending', 'PC-1'])
    );
  });

  it('marks an expense payment failed when its payout fails', async () => {
    const request = {
      id: 'REQ-FAILED',
      type: 'disbursement',
      status: 'approved',
      amount_cents: 10000,
      destination_address: '0x3333333333333333333333333333333333333333',
      beneficiary_email: 'beneficiary@example.com',
      metadata: { expenseId: 'EXP-FAILED' },
    };
    vi.spyOn(DistributionRequestEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(DistributionRequestEngine, 'getRequest').mockResolvedValue(request);
    const update = vi.spyOn(DistributionRequestEngine, '_update').mockResolvedValue(request);
    vi.spyOn(PayoutCenterEngine, 'createPayment').mockResolvedValue({
      id: 'PC-FAILED',
      status: 'failed',
      tx_hash: null,
    });
    vi.spyOn(MessagingEngine, 'notify').mockResolvedValue(undefined);
    vi.spyOn(CalendarEngine, 'createEvent').mockResolvedValue(undefined);
    const query = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] });

    await DistributionRequestEngine.executeRequest('REQ-FAILED');

    expect(update).toHaveBeenCalledWith(
      'REQ-FAILED',
      expect.objectContaining({ status: 'failed', payout_id: 'PC-FAILED' })
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE expense_records'),
      expect.arrayContaining(['EXP-FAILED', 'payment_failed', 'PC-FAILED'])
    );
  });
});

describe('live trust activity sync', () => {
  it('posts a completed expense exactly once against stablecoin backing', async () => {
    const activity = {
      id: 'REQ-3',
      status: 'payout_created',
      payout_status: 'completed',
      payout_rail: 'sit',
      payout_id: 'PC-3',
      expense_id: 'EXP-3',
      expense_type: 'Operating',
      amount_cents: 7500,
      source_type: 'trust',
      source_account_id: '1000',
      metadata: { expenseAccountCode: '5300' },
      expense_metadata: {},
    };
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (sql.includes('to_regclass')) return { rows: [{ table_name: 'present' }] };
      if (sql.includes('FROM dapp_distribution_requests')) return { rows: [activity] };
      if (sql.includes('FROM trust_journal_entries')) return { rows: [] };
      return { rows: [] };
    });
    vi.spyOn(DataBridge, '_logSync').mockResolvedValue(undefined);
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry')
      .mockResolvedValue({ entry_id: 'JRN-EXP-3' });

    const result = await DataBridge.syncTrustActivityToAccounting();

    expect(result).toMatchObject({ posted: 1, failed: 0 });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      referenceType: 'expense_payment',
      referenceId: 'EXP-3',
      lines: [
        expect.objectContaining({ accountCode: '5300', debitAmount: 75 }),
        expect.objectContaining({ accountCode: '1210', creditAmount: 75 }),
      ],
    }));
  });

  it('reuses an existing expense journal instead of posting a duplicate', async () => {
    const activity = {
      id: 'REQ-EXISTING',
      status: 'executed',
      payout_status: 'completed',
      payout_rail: 'sit',
      payout_id: 'PC-EXISTING',
      expense_id: 'EXP-EXISTING',
      amount_cents: 7500,
      source_type: 'trust',
      source_account_id: '1000',
      metadata: {},
      expense_metadata: {},
    };
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (sql.includes('to_regclass')) return { rows: [{ table_name: 'present' }] };
      if (sql.includes('FROM dapp_distribution_requests')) return { rows: [activity] };
      if (sql.includes('FROM trust_journal_entries')) return { rows: [{ entry_id: 'JRN-EXISTING' }] };
      return { rows: [] };
    });
    vi.spyOn(DataBridge, '_logSync').mockResolvedValue(undefined);
    const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry');

    const result = await DataBridge.syncTrustActivityToAccounting();

    expect(result).toMatchObject({ posted: 0, linksRepaired: 1, failed: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

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
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const { WireOriginationEngine } = require('../server/integrations/dapp/wireOriginationEngine');
const { CashEngine } = require('../server/integrations/cash/cashEngine');
const wireRouter = require('../server/routes/wire');

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
  const approvedWire = {
    wire_id: 'WIRE-TRANSMIT-1',
    status: 'approved',
    amount_cents: 5700,
    currency: 'USD',
    payment_type: 'vendor_payment',
    requires_approval: true,
    initiated_by: 'maker',
    approved_by: 'checker',
    sender_name: 'DLB Trust',
    sender_routing: '111000025',
    sender_account: 'sender-account',
    beneficiary_name: 'DB NET MGMT',
    beneficiary_routing: '222000111',
    beneficiary_account: 'beneficiary-account',
    beneficiary_bank_name: 'Lili Bank',
    description: 'Micro-deposit test',
  };

  it('fails closed when no wire endpoint is configured', async () => {
    vi.spyOn(WireEngine, 'getWire').mockResolvedValue(approvedWire);
    vi.spyOn(SystemSettings, 'getMode').mockResolvedValue('production');
    vi.spyOn(SystemSettings, 'getWireEndpoint').mockResolvedValue('');
    const query = vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{ wire_id: approvedWire.wire_id }],
    });
    const accounting = vi.spyOn(WireEngine, 'postAccountingEntry');
    vi.spyOn(WireEngine, 'logAudit').mockResolvedValue(undefined);

    await expect(WireEngine.sendWire(approvedWire.wire_id)).rejects.toThrow(
      'Wire transmission endpoint is not configured',
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      [
        approvedWire.wire_id,
        expect.stringContaining('Wire transmission endpoint is not configured'),
      ],
    );
    expect(accounting).not.toHaveBeenCalled();
  });

  it('requires independent maker/checker approval for live transmission', async () => {
    vi.spyOn(WireEngine, 'getWire').mockResolvedValue({
      ...approvedWire,
      approved_by: null,
    });
    const transmit = vi.spyOn(WireEngine, '_transmitWire');

    await expect(WireEngine.sendWire(approvedWire.wire_id)).rejects.toThrow(
      'Live wire transmission requires independent maker/checker approval',
    );
    expect(transmit).not.toHaveBeenCalled();
  });

  it('does not mark externally rejected transmissions sent', async () => {
    vi.spyOn(WireEngine, 'getWire').mockResolvedValue(approvedWire);
    vi.spyOn(SystemSettings, 'getMode').mockResolvedValue('production');
    vi.spyOn(SystemSettings, 'getWireEndpoint').mockResolvedValue('https://wire.example.test/send');
    vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue({});
    vi.spyOn(SystemSettings, 'getBankAuth').mockResolvedValue({});
    vi.spyOn(WireEngine, '_transmitWire').mockRejectedValue(
      new Error('Wire endpoint returned 422: rejected'),
    );
    const query = vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{ wire_id: approvedWire.wire_id }],
    });
    const accounting = vi.spyOn(WireEngine, 'postAccountingEntry');
    vi.spyOn(WireEngine, 'logAudit').mockResolvedValue(undefined);

    await expect(WireEngine.sendWire(approvedWire.wire_id)).rejects.toThrow(
      'Wire endpoint returned 422: rejected',
    );

    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      expect.anything(),
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      [approvedWire.wire_id, 'Wire endpoint returned 422: rejected'],
    );
    expect(accounting).not.toHaveBeenCalled();
  });

  it('rejects non-success provider HTTP responses', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'rejected', error: 'invalid beneficiary' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server failed to bind');

    try {
      await expect(WireEngine._transmitWire(
        approvedWire,
        `http://127.0.0.1:${address.port}/wire`,
        {},
      )).rejects.toThrow('Wire endpoint returned 422');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (
        err ? reject(err) : resolve()
      )));
    }
  });

  it('uses idempotent wire IDs and provider-supplied evidence for transmission', async () => {
    let requestHeaders: http.IncomingHttpHeaders = {};
    let requestBody = '';
    const server = http.createServer((req, res) => {
      requestHeaders = req.headers;
      req.on('data', (chunk) => { requestBody += chunk; });
      req.on('end', () => {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'accepted',
          transaction_id: 'PROVIDER-TRANSACTION-1',
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server failed to bind');

    try {
      const result = await WireEngine._transmitWire(
        approvedWire,
        `http://127.0.0.1:${address.port}/wire`,
        {},
      );
      const parsedBody = JSON.parse(requestBody);

      expect(result).toMatchObject({
        providerReference: 'PROVIDER-TRANSACTION-1',
        providerStatus: 'accepted',
        imad: null,
        omad: null,
      });
      expect(requestHeaders['x-request-id']).toBe(approvedWire.wire_id);
      expect(requestHeaders['idempotency-key']).toBe(approvedWire.wire_id);
      expect(parsedBody).not.toHaveProperty('imad');
      expect(parsedBody).not.toHaveProperty('omad');
      expect(parsedBody).toMatchObject({
        client_reference: approvedWire.wire_id,
        beneficiary_name: approvedWire.beneficiary_name,
        amount_cents: approvedWire.amount_cents,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (
        err ? reject(err) : resolve()
      )));
    }
  });

  it('fails the wire when the provider times out', async () => {
    vi.spyOn(WireEngine, 'getWire').mockResolvedValue(approvedWire);
    vi.spyOn(SystemSettings, 'getMode').mockResolvedValue('production');
    vi.spyOn(SystemSettings, 'getWireEndpoint').mockResolvedValue('https://wire.example.test/send');
    vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue({});
    vi.spyOn(SystemSettings, 'getBankAuth').mockResolvedValue({});
    vi.spyOn(WireEngine, '_transmitWire').mockRejectedValue(
      new Error('Wire endpoint timeout'),
    );
    const query = vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{ wire_id: approvedWire.wire_id }],
    });
    vi.spyOn(WireEngine, 'logAudit').mockResolvedValue(undefined);

    await expect(WireEngine.sendWire(approvedWire.wire_id)).rejects.toThrow(
      'Wire endpoint timeout',
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      [approvedWire.wire_id, 'Wire endpoint timeout'],
    );
  });

  it('marks a wire sent only after provider acceptance without synthetic references', async () => {
    vi.spyOn(WireEngine, 'getWire')
      .mockResolvedValueOnce(approvedWire)
      .mockResolvedValueOnce({
        ...approvedWire,
        status: 'sent',
        imad: null,
        omad: null,
        fed_reference: null,
        confirmation_number: null,
      });
    vi.spyOn(SystemSettings, 'getMode').mockResolvedValue('production');
    vi.spyOn(SystemSettings, 'getWireEndpoint').mockResolvedValue('https://wire.example.test/send');
    vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue({});
    vi.spyOn(SystemSettings, 'getBankAuth').mockResolvedValue({});
    vi.spyOn(WireEngine, '_transmitWire').mockResolvedValue({
      providerReference: 'PROVIDER-WIRE-1',
      providerStatus: 'accepted',
      imad: null,
      omad: null,
      fedReference: null,
      confirmationNumber: null,
    });
    const query = vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{ wire_id: approvedWire.wire_id }],
    });
    const accounting = vi.spyOn(WireEngine, 'postAccountingEntry');
    vi.spyOn(WireEngine, 'logAudit').mockResolvedValue(undefined);

    const result = await WireEngine.sendWire(approvedWire.wire_id);

    expect(result).toMatchObject({
      status: 'sent',
      imad: null,
      omad: null,
      fed_reference: null,
      confirmation_number: null,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      expect.arrayContaining([
        approvedWire.wire_id,
        null,
        null,
        null,
        null,
      ]),
    );
    expect(accounting).not.toHaveBeenCalled();
  });

  it('preserves provider acceptance for reconciliation when local sent recording fails', async () => {
    vi.spyOn(WireEngine, 'getWire').mockResolvedValue(approvedWire);
    vi.spyOn(SystemSettings, 'getMode').mockResolvedValue('production');
    vi.spyOn(SystemSettings, 'getWireEndpoint').mockResolvedValue('https://wire.example.test/send');
    vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue({});
    vi.spyOn(SystemSettings, 'getBankAuth').mockResolvedValue({});
    vi.spyOn(WireEngine, '_transmitWire').mockResolvedValue({
      providerReference: 'PROVIDER-WIRE-RECOVERY',
      providerStatus: 'accepted',
      imad: null,
      omad: null,
      fedReference: null,
      confirmationNumber: null,
    });
    const query = vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [{ wire_id: approvedWire.wire_id }] })
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ rows: [] });
    vi.spyOn(WireEngine, 'logAudit').mockResolvedValue(undefined);

    await expect(WireEngine.sendWire(approvedWire.wire_id)).rejects.toThrow(
      'database unavailable',
    );

    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("SET status = 'sending'"),
      expect.arrayContaining([
        approvedWire.wire_id,
        'database unavailable',
        expect.stringContaining('PROVIDER-WIRE-RECOVERY'),
      ]),
    );
  });

  it('requires authenticated provider evidence before confirmation and settlement', async () => {
    const sentWire = { ...approvedWire, status: 'sent' };
    vi.spyOn(WireEngine, 'getWire').mockResolvedValue(sentWire);

    await expect(WireEngine.confirmWire(sentWire.wire_id, {
      providerStatus: 'confirmed',
    })).rejects.toThrow('Authenticated provider confirmation reference is required');
    await expect(WireEngine.settleWire(sentWire.wire_id, {
      providerStatus: 'settled',
      settlementReference: 'SETTLEMENT-1',
    })).rejects.toThrow("Wire must be in 'confirmed' status to settle, current: sent");
  });

  it('records provider-confirmed evidence before allowing settlement', async () => {
    const sentWire = { ...approvedWire, status: 'sent' };
    const confirmedWire = {
      ...sentWire,
      status: 'confirmed',
      confirmation_number: 'CONFIRMED-1',
    };
    vi.spyOn(WireEngine, 'getWire')
      .mockResolvedValueOnce(sentWire)
      .mockResolvedValueOnce(confirmedWire);
    const query = vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{ wire_id: sentWire.wire_id }],
    });
    vi.spyOn(WireEngine, 'logAudit').mockResolvedValue(undefined);

    const result = await WireEngine.confirmWire(sentWire.wire_id, {
      providerStatus: 'confirmed',
      confirmationReference: 'PROVIDER-CONFIRM-1',
      confirmationNumber: 'CONFIRMED-1',
      confirmedBy: 'checker',
    });

    expect(result.status).toBe('confirmed');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'confirmed'"),
      expect.arrayContaining([
        sentWire.wire_id,
        'CONFIRMED-1',
      ]),
    );
  });

  it('posts settlement accounting once after confirmed provider settlement', async () => {
    const confirmedWire = {
      ...approvedWire,
      status: 'confirmed',
      journal_entry_id: null,
    };
    const settledWire = {
      ...confirmedWire,
      status: 'settled',
      journal_entry_id: 'JRN-WIRE-SETTLE',
    };
    vi.spyOn(WireEngine, 'getWire')
      .mockResolvedValueOnce(confirmedWire)
      .mockResolvedValueOnce(settledWire)
      .mockResolvedValueOnce(settledWire);
    const accounting = vi.spyOn(WireEngine, 'postAccountingEntry')
      .mockResolvedValue({ entry_id: 'JRN-WIRE-SETTLE' });
    vi.spyOn(WireEngine, 'logAudit').mockResolvedValue(undefined);
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string) => {
      if (sql.includes('RETURNING wire_id')) return { rows: [{ wire_id: confirmedWire.wire_id }] };
      return { rows: [] };
    });

    const first = await WireEngine.settleWire(confirmedWire.wire_id, {
      providerStatus: 'settled',
      settlementReference: 'PROVIDER-SETTLEMENT-1',
      settledBy: 'checker',
    });
    const second = await WireEngine.settleWire(confirmedWire.wire_id, {
      providerStatus: 'settled',
      settlementReference: 'PROVIDER-SETTLEMENT-1',
      settledBy: 'checker',
    });

    expect(first.status).toBe('settled');
    expect(second.alreadySettled).toBe(true);
    expect(accounting).toHaveBeenCalledTimes(1);
    expect(accounting).toHaveBeenCalledWith(
      expect.objectContaining({
        ...confirmedWire,
        sent_at: expect.any(Date),
      }),
      { postedBy: 'checker' },
    );
  });

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

describe('wire origination transmission', () => {
  const payout = {
    payout_id: 'PAYOUT-WIRE-1',
    wire_id: 'WIRE-PAYOUT-1',
    status: 'approved',
    approved_by: 'checker',
    metadata: {},
  };

  it('delegates transmission to the provider-evidence wire engine', async () => {
    vi.spyOn(WireEngine, 'getWire').mockResolvedValue({
      wire_id: payout.wire_id,
      status: 'approved',
      initiated_by: 'maker',
      approved_by: 'checker',
      requires_approval: true,
    });
    vi.spyOn(WireEngine, 'sendWire').mockResolvedValue({
      wire_id: payout.wire_id,
      status: 'sent',
      sent_at: '2026-08-27T18:00:00.000Z',
      metadata: {
        externalProviderReference: 'PROVIDER-WIRE-PAYOUT-1',
      },
    });
    const query = vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] });
    vi.spyOn(WireOriginationEngine, 'getPayout').mockResolvedValue({
      ...payout,
      status: 'sent',
    });

    const result = await WireOriginationEngine._sendWire(payout);

    expect(WireEngine.sendWire).toHaveBeenCalledWith(payout.wire_id);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      expect.arrayContaining([
        payout.payout_id,
        expect.stringContaining('PROVIDER-WIRE-PAYOUT-1'),
      ]),
    );
    expect(result.status).toBe('sent');
  });

  it('propagates provider transmission failures without synthetic success', async () => {
    vi.spyOn(WireEngine, 'getWire').mockResolvedValue({
      wire_id: payout.wire_id,
      status: 'approved',
      initiated_by: 'maker',
      approved_by: 'checker',
      requires_approval: true,
    });
    vi.spyOn(WireEngine, 'sendWire').mockRejectedValue(new Error('provider unavailable'));
    const query = vi.spyOn(pool, 'query');

    await expect(WireOriginationEngine._sendWire(payout)).rejects.toThrow(
      'provider unavailable',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('settles the payout hold idempotently from provider evidence', async () => {
    const confirmedPayout = {
      ...payout,
      status: 'confirmed',
      hold_movement_id: 'MOV-HOLD-1',
      amount_cents: 5700,
    };
    const settledPayout = { ...confirmedPayout, status: 'settled' };
    vi.spyOn(WireOriginationEngine, 'ensureTables').mockResolvedValue(undefined);
    const query = vi.spyOn(pool, 'query')
      .mockResolvedValueOnce({ rows: [confirmedPayout] })
      .mockResolvedValueOnce({ rows: [{ movement_id: 'MOV-SETTLED-1' }] })
      .mockResolvedValueOnce({ rows: [settledPayout] });
    const transfer = vi.spyOn(CashEngine, 'transfer');

    const result = await WireOriginationEngine.syncWireSettlement({
      wire_id: payout.wire_id,
      status: 'settled',
    }, {
      settlementReference: 'PROVIDER-SETTLEMENT-PAYOUT-1',
      settledBy: 'checker',
    });

    expect(result.status).toBe('settled');
    expect(transfer).not.toHaveBeenCalled();
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("SET status = 'settled'"),
      expect.arrayContaining([
        payout.payout_id,
        expect.stringContaining('PROVIDER-SETTLEMENT-PAYOUT-1'),
      ]),
    );
  });
});

describe('wire evidence routes', () => {
  it('exposes authenticated confirmation and settlement handlers', () => {
    expect(wireRouter.stack.some(
      (layer: any) => layer.route?.path === '/:id/confirm'
        && layer.route.methods.post,
    )).toBe(true);
    expect(wireRouter.stack.some(
      (layer: any) => layer.route?.path === '/:id/settle'
        && layer.route.methods.post,
    )).toBe(true);
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

describe('live bookkeeping summary', () => {
  it('surfaces inactive synchronization modules as top-level warnings', async () => {
    vi.spyOn(DataBridge, 'syncWiresToAccounting').mockResolvedValue({
      posted: 0,
      linksRepaired: 0,
      failed: 0,
    });
    vi.spyOn(DataBridge, 'syncTrustActivityToAccounting').mockResolvedValue({
      inactive: true,
      message: 'Trust activity module not initialized',
      posted: 0,
      linksRepaired: 0,
      failed: 0,
    });
    vi.spyOn(DataBridge, 'verifyWireSync').mockResolvedValue({
      totalWiresWithoutJE: 0,
      gaps: [],
    });
    vi.spyOn(DataBridge, 'getDataFlowStatus').mockResolvedValue({
      syncHealth: 'healthy',
    });

    const result = await DataBridge.runLiveBookkeeping({ dryRun: true });

    expect(result).toMatchObject({
      mode: 'preview',
      health: 'warning',
      totalFailed: 0,
      warnings: ['Trust activity module not initialized'],
    });
  });
});

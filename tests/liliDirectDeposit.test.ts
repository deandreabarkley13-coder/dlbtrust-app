import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { LiliDirectDepositEngine } = require('../server/integrations/payments/liliDirectDepositEngine');
const { LiliMcpEngine } = require('../server/integrations/payments/liliMcpEngine');
const { LiliBankEngine } = require('../server/integrations/payments/liliBankEngine');
const { ACHEngine } = require('../server/integrations/ach/achEngine');
const { PaymentOrchestrator } = require('../server/integrations/ach/paymentOrchestrator');
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const { AS2Client } = require('../server/integrations/ach/as2Client');
const { AS2Partners } = require('../server/integrations/ach/as2Partners');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

describe('Lili direct deposit — unified ACH credit workflow', () => {
  let settings: Record<string, string>;
  let sql: { text: string; params: any[] }[];
  let deposits: Record<string, any>;
  let disburse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.ACH_SFTP_URL;
    delete process.env.ACH_MFT_CHANNEL;
    settings = { LILI_DD_ROUTING_NUMBER: '091000019', LILI_DD_ACCOUNT_NUMBER: '123456789012', LILI_DD_ACCOUNT_NAME: 'DB NET MGMT LLC' };
    sql = [];
    deposits = {};
    vi.spyOn(SystemSettings, 'get').mockImplementation(async (k: string) => settings[k] ?? null);
    vi.spyOn(SystemSettings, 'set').mockImplementation(async (k: string, v: string) => { settings[k] = v; });
    vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue(null as any);
    vi.spyOn(AS2Client, 'getConfigStatus').mockReturnValue({ configured: false } as any);
    vi.spyOn(AS2Partners, 'getDefaultPartnerConfig').mockResolvedValue(null as any);
    vi.spyOn(LiliBankEngine, 'ensureTables').mockResolvedValue(undefined as any);
    disburse = vi.spyOn(PaymentOrchestrator, 'createDisbursementWithAccounting').mockResolvedValue({
      batch: { batch_id: 'ACH-77' }, journal_entry: { entry_id: 'JE-9' },
    } as any);

    vi.spyOn(pool, 'query').mockImplementation(async (text: any, params: any[] = []) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      sql.push({ text: t, params });
      if (t.startsWith('INSERT INTO lili_direct_deposits')) {
        deposits[params[0]] = {
          deposit_id: params[0], status: 'awaiting_odfi', amount_cents: params[1], sec_code: params[2], effective_date: params[3],
          memo: params[4], payment_type: params[5], receiver_name: params[6], receiver_routing: params[7], receiver_account_last4: params[8],
          lili_payment_id: params[9], ach_batch_id: params[10], journal_entry_id: params[11], lili_transaction_id: null, error_message: null,
        };
      }
      if (t.startsWith('UPDATE lili_direct_deposits SET status=$1')) {
        const id = params[params.length - 1];
        if (deposits[id]) deposits[id].status = params[0];
      }
      if (t.startsWith("UPDATE lili_direct_deposits SET status='reconciled'")) {
        deposits[params[1]].status = 'reconciled'; deposits[params[1]].lili_transaction_id = params[0];
      }
      if (t.startsWith('SELECT * FROM lili_direct_deposits WHERE deposit_id=')) return { rows: deposits[params[0]] ? [deposits[params[0]]] : [] } as any;
      if (t.startsWith('SELECT * FROM lili_direct_deposits WHERE status IN')) return { rows: Object.values(deposits).filter(d => ['transmitted', 'awaiting_odfi'].includes(d.status)) } as any;
      if (t.startsWith('SELECT lili_transaction_id FROM')) return { rows: [] } as any;
      if (t.startsWith('SELECT payment_id, status')) return { rows: [{ payment_id: params[0], status: 'manual_pending' }] } as any;
      if (t.startsWith('SELECT batch_id, status')) return { rows: [{ batch_id: params[0], status: 'pending' }] } as any;
      return { rows: [] } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('creates one unified record: lili_payments row + NACHA PPD credit (entry 22) to the Lili account, queued awaiting_odfi when no ODFI channel exists', async () => {
    const dep = await LiliDirectDepositEngine.createDirectDeposit({ amount: 1250.5, memo: 'Q3 sweep', effectiveDate: '2026-09-04', createdBy: 'trustee' });

    expect(dep.status).toBe('awaiting_odfi');
    expect(dep.amount_cents).toBe(125050);
    expect(dep.ach_batch_id).toBe('ACH-77');
    expect(dep.journal_entry_id).toBe('JE-9');
    expect(dep.receiver_account_last4).toBe('9012');
    expect(dep.lili_payment).toMatchObject({ status: 'manual_pending' });
    expect(dep.ach_batch).toMatchObject({ batch_id: 'ACH-77' });

    expect(disburse).toHaveBeenCalledTimes(1);
    const call = disburse.mock.calls[0][0];
    expect(call.secCode).toBe('PPD');
    expect(call.paymentType).toBe('trust_distribution');
    expect(call.description).toBe('Q3 SWEEP');
    expect(call.entries).toEqual([expect.objectContaining({
      receivingRouting: '091000019', accountNumber: '123456789012', amountCents: 125050, transactionCode: '22', individualName: 'DB NET MGMT LLC',
    })]);

    const payInsert = sql.find(s => s.text.startsWith('INSERT INTO lili_payments'));
    expect(payInsert).toBeTruthy();
    expect(payInsert!.params[3]).toBe('****9012');
    expect(payInsert!.params[4]).toBe('091000019');
    const payUpdate = sql.find(s => s.text.startsWith('UPDATE lili_payments SET status=\'manual_pending\''));
    expect(payUpdate!.params[0]).toMatch(/no ODFI channel configured/);
  });

  it('transmits through the ODFI when a channel is configured and refuses when none is', async () => {
    const dep = await LiliDirectDepositEngine.createDirectDeposit({ amountCents: 5000, createdBy: 'trustee' });
    await expect(LiliDirectDepositEngine.transmit(dep.deposit_id)).rejects.toThrow(/No ODFI channel configured/);

    (AS2Client.getConfigStatus as any).mockReturnValue({ configured: true });
    const transmit = vi.spyOn(ACHEngine, 'transmitBatch').mockResolvedValue({ success: true, message_id: 'AS2-1' } as any);
    const out = await LiliDirectDepositEngine.transmit(dep.deposit_id, { approvedBy: 'trustee-two', actor: 'trustee' });

    expect(transmit).toHaveBeenCalledWith('ACH-77', { approvedBy: 'trustee-two', actor: 'trustee' });
    expect(out.status).toBe('transmitted');
    const payUpdate = sql.filter(s => s.text.startsWith('UPDATE lili_payments SET status=$1, external_tx_id')).pop();
    expect(payUpdate!.params.slice(0, 2)).toEqual(['api_pending', 'AS2-1']);
  });

  it('auto-transmits on create when an ODFI channel is ready', async () => {
    process.env.ACH_SFTP_URL = 'sftp://odfi.test/inbound';
    const transmit = vi.spyOn(ACHEngine, 'transmitBatch').mockResolvedValue({ success: true, transmission_id: 'TX-5' } as any);
    const dep = await LiliDirectDepositEngine.createDirectDeposit({ amount: 10, createdBy: 'trustee' });
    expect(transmit).toHaveBeenCalledTimes(1);
    expect(dep.status).toBe('transmitted');
    expect((await LiliDirectDepositEngine.odfiStatus())).toEqual({ ready: true, channels: ['sftp'] });
  });

  it('reconciles a transmitted deposit against a matching FUND_TRANSFER credit on the Lili MCP transaction feed', async () => {
    process.env.ACH_SFTP_URL = 'sftp://odfi.test/inbound';
    vi.spyOn(ACHEngine, 'transmitBatch').mockResolvedValue({ success: true } as any);
    const settle = vi.spyOn(ACHEngine, 'settleBatch').mockResolvedValue({} as any);
    const dep = await LiliDirectDepositEngine.createDirectDeposit({ amount: 300, effectiveDate: '2026-09-04', createdBy: 'trustee' });

    vi.spyOn(LiliMcpEngine, 'getConfig').mockResolvedValue({ businessUserId: 'biz-1' } as any);
    const callTool = vi.spyOn(LiliMcpEngine, 'callTool').mockResolvedValue({
      result: { content: [{ type: 'text', text: JSON.stringify({ transactions: [
        { transactionId: 'T-1', transactionType: 'FUND_TRANSFER', amountCents: 12500, timestamp: '2026-09-05T10:00:00Z', pending: false },
        { transactionId: 'T-2', transactionType: 'FUND_TRANSFER', amountCents: 30000, timestamp: '2026-09-05T12:00:00Z', pending: false },
      ] }) }] },
    } as any);

    const out = await LiliDirectDepositEngine.reconcile();
    expect(callTool).toHaveBeenCalledWith('lili_search_transactions', expect.objectContaining({
      businessUserId: 'biz-1', transactionType: 'FUND_TRANSFER', startDate: '2026-09-03', endDate: '2026-09-09',
    }));
    expect(out).toMatchObject({ matched: 1, unmatched: 0, deposits: [{ depositId: dep.deposit_id, matched: true, liliTransactionId: 'T-2' }] });
    expect(settle).toHaveBeenCalledWith('ACH-77', expect.objectContaining({ liliTransactionId: 'T-2' }));
    const completed = sql.find(s => s.text.startsWith("UPDATE lili_payments SET status='completed'"));
    expect(completed!.params[0]).toBe('T-2');
  });

  it('refuses to create a deposit without a configured Lili destination and reports readiness in the workflow status', async () => {
    delete settings.LILI_DD_ACCOUNT_NUMBER;
    await expect(LiliDirectDepositEngine.createDirectDeposit({ amount: 5 })).rejects.toThrow(/destination account not configured/);
    vi.spyOn(LiliMcpEngine, 'getPublicConfig').mockResolvedValue({ configured: true, lastRefreshError: null } as any);
    const status = await LiliDirectDepositEngine.getWorkflowStatus();
    expect(status.ready).toBe(false);
    expect(status.destination).toEqual({ configured: false, routingNumber: '091000019', accountNumberMasked: null, accountName: 'DB NET MGMT LLC' });
    expect(status.odfi).toEqual({ ready: false, channels: [] });
    expect(status.mcp.configured).toBe(true);
  });
});

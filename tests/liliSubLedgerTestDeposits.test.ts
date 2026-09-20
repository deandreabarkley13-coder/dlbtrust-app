import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const script = require('../scripts/lili-sub-ledger-test-deposits.cjs');
const { LiliDirectDepositEngine } = require('../server/integrations/payments/liliDirectDepositEngine');
const { LiliBankEngine } = require('../server/integrations/payments/liliBankEngine');
const { ACHEngine } = require('../server/integrations/ach/achEngine');
const { PaymentOrchestrator } = require('../server/integrations/ach/paymentOrchestrator');
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const { AS2Client } = require('../server/integrations/ach/as2Client');
const { AS2Partners } = require('../server/integrations/ach/as2Partners');
const { SubLedgerEngine } = require('../server/integrations/accounting/subLedgerEngine');
const { PtcPortalEngine } = require('../server/integrations/dapp/ptcPortalEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

const SEEDED_LEDGERS = [
  { sub_ledger_id: 'SL-BEN-1', contact_id: 'CRM-BEN-1782927036064', first_name: 'DeAndrea', last_name: 'Barkley', parent_account_code: '2000', sub_account_type: 'distribution', sub_account_name: 'DeAndrea L Barkley — Beneficiary Trust Sub-Ledger', status: 'active' },
  { sub_ledger_id: 'SL-BEN-2', contact_id: 'CRM-BEN-1782927155850', first_name: 'Malissa', last_name: 'Robinson', parent_account_code: '2000', sub_account_type: 'distribution', sub_account_name: 'Malissa Robinson — Beneficiary Trust Sub-Ledger', status: 'active' },
  { sub_ledger_id: 'SL-BEN-3', contact_id: 'CRM-BEN-1782927793173', first_name: 'Jeremy', last_name: 'Robinson', parent_account_code: '2000', sub_account_type: 'distribution', sub_account_name: 'Jeremy N Robinson — Beneficiary Trust Sub-Ledger', status: 'active' },
  { sub_ledger_id: 'SL-COMP-1', contact_id: 'CRM-BEN-1782927155850', first_name: 'Malissa', last_name: 'Robinson', parent_account_code: '5100', sub_account_type: 'trustee_fee', sub_account_name: 'Malissa Robinson — Trustee Compensation', status: 'active' },
  { sub_ledger_id: 'SL-FEE-1', contact_id: 'CRM-BEN-1782927155850', first_name: 'Malissa', last_name: 'Robinson', parent_account_code: '2100', sub_account_type: 'fee', sub_account_name: 'Malissa Robinson — Trustee Fees', status: 'active' },
  { sub_ledger_id: 'SL-COMP-2', contact_id: 'CRM-BEN-1782927036064', first_name: 'DeAndrea', last_name: 'Barkley', parent_account_code: '5100', sub_account_type: 'trustee_fee', sub_account_name: 'DeAndrea L Barkley — Trustee Compensation', status: 'active' },
  { sub_ledger_id: 'SL-FEE-2', contact_id: 'CRM-BEN-1782927036064', first_name: 'DeAndrea', last_name: 'Barkley', parent_account_code: '2100', sub_account_type: 'fee', sub_account_name: 'DeAndrea L Barkley — Trustee Fees', status: 'active' },
  // Not a PTC member ledger — must be ignored
  { sub_ledger_id: 'SL-BOND-9', contact_id: 'CRM-INV-1', parent_account_code: '1100', sub_account_type: 'bond_investment', sub_account_name: 'Bondholder', status: 'active' },
  // Closed member ledger — must be ignored
  { sub_ledger_id: 'SL-OLD', contact_id: 'CRM-BEN-1782927793173', parent_account_code: '2000', sub_account_type: 'distribution', sub_account_name: 'old', status: 'closed' },
];

describe('scripts/lili-sub-ledger-test-deposits — small Lili deposits per sub-ledger context', () => {
  let settings: Record<string, string>;
  let sql: { text: string; params: any[] }[];
  let deposits: Record<string, any>;
  let disburse: ReturnType<typeof vi.fn>;
  let logs: string[];
  const log = (...a: any[]) => { logs.push(a.join(' ')); };

  beforeEach(() => {
    delete process.env.ACH_SFTP_URL;
    delete process.env.ACH_MFT_CHANNEL;
    settings = { LILI_DD_ROUTING_NUMBER: '091000019', LILI_DD_ACCOUNT_NUMBER: '123456789012', LILI_DD_ACCOUNT_NAME: 'DB NET MGMT LLC' };
    sql = [];
    deposits = {};
    logs = [];
    vi.spyOn(SystemSettings, 'get').mockImplementation(async (k: string) => settings[k] ?? null);
    vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue(null as any);
    vi.spyOn(AS2Client, 'getConfigStatus').mockReturnValue({ configured: false } as any);
    vi.spyOn(AS2Partners, 'getDefaultPartnerConfig').mockResolvedValue(null as any);
    vi.spyOn(LiliBankEngine, 'ensureTables').mockResolvedValue(undefined as any);
    vi.spyOn(SubLedgerEngine, 'listSubLedgers').mockResolvedValue(SEEDED_LEDGERS as any);
    vi.spyOn(PtcPortalEngine, 'ensureSubLedgerAccounts').mockResolvedValue({ created: [], existing: SEEDED_LEDGERS } as any);
    disburse = vi.spyOn(PaymentOrchestrator, 'createDisbursementWithAccounting').mockImplementation(async () => ({
      batch: { batch_id: 'ACH-' + (disburse.mock.calls.length) }, journal_entry: { entry_id: 'JE-' + disburse.mock.calls.length },
    }) as any);

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
      if (t.startsWith('SELECT * FROM lili_direct_deposits WHERE deposit_id=')) return { rows: deposits[params[0]] ? [deposits[params[0]]] : [] } as any;
      if (t.startsWith('SELECT * FROM lili_direct_deposits WHERE status IN')) return { rows: Object.values(deposits).filter(d => ['transmitted', 'awaiting_odfi'].includes(d.status)) } as any;
      if (t.startsWith("SELECT * FROM lili_direct_deposits WHERE status='awaiting_odfi'")) return { rows: Object.values(deposits).filter(d => d.status === 'awaiting_odfi') } as any;
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

  it('builds one $1.00 context per seeded member sub-ledger with the sub-ledger id as sourceAccountId and a descriptive memo', () => {
    const ctxs = script.buildDepositContexts(SEEDED_LEDGERS, { amount: 1 });
    expect(ctxs).toHaveLength(7);
    expect(ctxs.map((c: any) => c.subLedgerId)).not.toContain('SL-BOND-9');
    expect(ctxs.map((c: any) => c.subLedgerId)).not.toContain('SL-OLD');
    const comp = ctxs.find((c: any) => c.subLedgerId === 'SL-COMP-1');
    expect(comp).toMatchObject({ amount: 1, sourceAccountId: 'SL-COMP-1', label: 'Trustee Compensation', parentAccountCode: '5100', subAccountType: 'trustee_fee', paymentType: 'trustee_fee' });
    expect(comp.memo).toBe('LILI TEST Trustee Compensation — Malissa Robinson (SL-COMP-1)');
    const ben = ctxs.find((c: any) => c.subLedgerId === 'SL-BEN-3');
    expect(ben).toMatchObject({ label: 'Beneficiary Trust Sub-Ledger', paymentType: 'trust_distribution', member: 'Jeremy Robinson' });

    expect(script.buildDepositContexts(SEEDED_LEDGERS, { only: 'trustee' })).toHaveLength(4);
    expect(script.buildDepositContexts(SEEDED_LEDGERS, { only: 'beneficiary' })).toHaveLength(3);
  });

  it('parses CLI flags and rejects a non-positive amount', () => {
    expect(script.parseArgs(['--amount=0.50', '--only=trustee', '--dry-run'])).toMatchObject({ amount: 0.5, only: 'trustee', dryRun: true, skipTransmit: false });
    expect(script.parseArgs([])).toMatchObject({ amount: 1, only: 'all', dryRun: false });
    expect(() => script.parseArgs(['--amount=0'])).toThrow(/positive/);
    expect(() => script.parseArgs(['--only=everyone'])).toThrow(/--only/);
  });

  it('skips with a clear message and creates nothing when the Lili destination is not configured', async () => {
    delete settings.LILI_DD_ACCOUNT_NUMBER;
    const out = await script.runTestDeposits({}, { log });
    expect(out.skipped).toBe(true);
    expect(out.reason).toMatch(/Lili destination account not configured/);
    expect(out.deposits).toEqual([]);
    expect(disburse).not.toHaveBeenCalled();
    expect(sql.some(s => s.text.startsWith('INSERT INTO lili_direct_deposits'))).toBe(false);
    expect(logs.join('\n')).toMatch(/SKIPPED — Lili destination account not configured/);
  });

  it('skips when the destination is configured but no ODFI channel is (deposits would only queue)', async () => {
    const out = await script.runTestDeposits({}, { log });
    expect(out.skipped).toBe(true);
    expect(out.reason).toMatch(/No ODFI channel configured/);
    expect(out.destination).toMatchObject({ configured: true, accountNumberMasked: '****9012' });
    expect(out.odfi).toEqual({ ready: false, channels: [] });
    expect(disburse).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/SKIPPED — No ODFI channel configured/);
  });

  it('creates a deposit per context, then transmits queued batches and reconciles when destination + ODFI are configured', async () => {
    process.env.ACH_SFTP_URL = 'sftp://odfi.test/inbound';
    const transmit = vi.spyOn(ACHEngine, 'transmitBatch').mockResolvedValue({ success: true, transmission_id: 'TX-1' } as any);
    const transmitQueued = vi.spyOn(LiliDirectDepositEngine, 'transmitQueued');
    const reconcile = vi.spyOn(LiliDirectDepositEngine, 'reconcile').mockResolvedValue({ matched: 0, checked: 7, mcp: 'not configured' } as any);

    const out = await script.runTestDeposits({ amount: 1 }, { log });

    expect(out.skipped).toBe(false);
    expect(PtcPortalEngine.ensureSubLedgerAccounts).toHaveBeenCalledTimes(1);
    expect(out.deposits).toHaveLength(7);
    expect(out.deposits.every((d: any) => d.ok && d.status === 'transmitted')).toBe(true);
    expect(disburse).toHaveBeenCalledTimes(7);
    expect(transmit).toHaveBeenCalledTimes(7);

    const calls = disburse.mock.calls.map((c: any[]) => c[0]);
    expect(calls.every((c: any) => c.entries[0].amountCents === 100 && c.entries[0].transactionCode === '22' && c.secCode === 'PPD')).toBe(true);
    expect(calls.filter((c: any) => c.paymentType === 'trustee_fee')).toHaveLength(4);
    expect(calls.filter((c: any) => c.paymentType === 'trust_distribution')).toHaveLength(3);
    expect(calls.map((c: any) => c.entries[0].memo)).toContain('LILI TEST Trustee Fees — DeAndrea Barkley (SL-FEE-2)');

    // sourceAccountId flows into the lili_payments row for each deposit
    const payInserts = sql.filter(s => s.text.startsWith('INSERT INTO lili_payments'));
    expect(payInserts.map(s => s.params[5])).toEqual(expect.arrayContaining(['SL-BEN-1', 'SL-COMP-1', 'SL-FEE-1', 'SL-COMP-2', 'SL-FEE-2']));

    expect(transmitQueued).toHaveBeenCalledTimes(1);
    expect(out.transmit).toMatchObject({ transmitted: 0 });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(out.reconcile).toMatchObject({ checked: 7 });
  });

  it('dry run lists contexts without creating, transmitting or reconciling', async () => {
    process.env.ACH_SFTP_URL = 'sftp://odfi.test/inbound';
    const transmitQueued = vi.spyOn(LiliDirectDepositEngine, 'transmitQueued');
    const reconcile = vi.spyOn(LiliDirectDepositEngine, 'reconcile');
    const out = await script.runTestDeposits({ dryRun: true }, { log });
    expect(out.contexts).toHaveLength(7);
    expect(out.deposits).toEqual([]);
    expect(disburse).not.toHaveBeenCalled();
    expect(transmitQueued).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });
});

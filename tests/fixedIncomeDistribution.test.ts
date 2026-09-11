import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const POLICY = '0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64';
process.env.TRUST_POLICY_ADDRESS = POLICY;
process.env.DAPP_CHAIN_ID = '8453';
process.env.COUPON_INCOME_GL_ACCOUNT_CODE = '1020';
process.env.TRUST_OPERATING_GL_ACCOUNT_CODE = '1030';
process.env.DLB_PRB_TOKEN_ADDRESS = '0x3f3a354f76be6ad0e7fc9b6efe39727b39cbd160';
process.env.DLB_TREASURY_TOKEN_ADDRESS = '0x5d3192581e6f12eeecc0fd414ef5672a454f611c';
delete process.env.TRUST_ALLOCATION_TRUSTEE_WALLETS;
delete process.env.TRUST_ALLOCATION_BENEFICIARY_WALLETS;

const pool = require('../server/integrations/bonds/pgPool');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { TrustPolicyEngine } = require('../server/integrations/dapp/trustPolicyEngine');
const { TrustAllocationEngine } = require('../server/integrations/dapp/trustAllocationEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { FixedIncomeDistributionEngine, policyAnnualAllocations, SOURCE_BUCKETS } = require('../server/integrations/os/fixedIncomeDistributionEngine');

type Row = Record<string, any>;

const BENEFICIARIES = TrustAllocationEngine.payees('coupon_income').map((p: any) => p.address.toLowerCase());
const TRUSTEES = TrustAllocationEngine.payees('trust_operating').map((p: any) => p.address.toLowerCase());

/** Minimal in-memory store for fixed_income_distributions + read-only source rows. */
function store(sources: Row[]) {
  const t: Record<string, Row[]> = { fixed_income_distributions: [], canonical_money_requests: [] };
  const cols = /\(([^)]+)\)\s+VALUES/i;
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    let m: RegExpExecArray | null;
    if (/FROM trust_journal_entries je/.test(text)) {
      return { rows: sources.filter(s => !t.fixed_income_distributions.some(d => d.source_entry_id === s.entry_id)) };
    }
    if (/FROM trust_journal_lines jl/.test(text)) {
      const total = sources.filter(s => s.gl === params[0]).reduce((n, s) => n + Number(s.amount), 0);
      return { rows: [{ total }] };
    }
    if (/FROM trust_allocation_payouts/.test(text) && /SUM/.test(text)) return { rows: [{ total: 0 }] };
    if (/FROM trust_allocation_payouts/.test(text)) return { rows: [] };
    if (/^INSERT INTO trust_allocation_payouts/.test(text)) return { rows: [] };
    if (/^UPDATE trust_allocation_payouts/.test(text)) return { rows: [] };
    if ((m = /^INSERT INTO fixed_income_distributions/.exec(text))) {
      const names = cols.exec(text)![1].split(',').map(s => s.trim());
      const values = /VALUES \((.+?)\)/.exec(text)![1].split(',').map(s => s.trim());
      const row: Row = { status: 'planned', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      names.forEach((n, i) => { row[n] = params[Number(values[i].replace(/\D/g, '')) - 1]; });
      if (t.fixed_income_distributions.some(r => r.source_entry_id === row.source_entry_id && r.payee === row.payee)) return { rows: [] };
      t.fixed_income_distributions.push(row);
      return { rows: [row] };
    }
    if ((m = /^UPDATE fixed_income_distributions SET (.+) WHERE distribution_id = \$1$/.exec(text))) {
      t.fixed_income_distributions.filter(r => r.distribution_id === params[0]).forEach(r => {
        m![1].split(/, (?=\w+ = )/).forEach(pair => {
          const [col, value] = pair.split(/ = (.+)/);
          r[col] = value === 'NOW()' ? new Date().toISOString() : params[Number(value.slice(1)) - 1];
        });
      });
      return { rows: [] };
    }
    if (/^SELECT id, status FROM canonical_money_requests/.test(text)) return { rows: t.canonical_money_requests.filter(r => String(r.id) === String(params[0])) };
    if (/^SELECT \* FROM fixed_income_distributions WHERE distribution_id = \$1$/.test(text)) return { rows: t.fixed_income_distributions.filter(r => r.distribution_id === params[0]) };
    if ((m = /^SELECT \* FROM fixed_income_distributions( WHERE (.+?))? ORDER BY .+ LIMIT \$\d+$/.exec(text))) {
      let rows = [...t.fixed_income_distributions];
      if (m[2]) m[2].split(' AND ').forEach(cond => { const [col, ref] = cond.split(' = '); rows = rows.filter(r => r[col] === params[Number(ref.slice(1)) - 1]); });
      return { rows };
    }
    if (/GROUP BY bucket, status/.test(text)) {
      const agg: Record<string, Row> = {};
      t.fixed_income_distributions.forEach(r => {
        const k = `${r.bucket}|${r.status}`;
        agg[k] = agg[k] || { bucket: r.bucket, status: r.status, count: 0, total: 0 };
        agg[k].count += 1; agg[k].total += Number(r.amount_usd);
      });
      return { rows: Object.values(agg) };
    }
    throw new Error(`unhandled SQL in test store: ${text}`);
  });
  return { t, query };
}

const COUPON = { entry_id: 'JE-CPN-5', entry_date: '2026-08-28', reference_type: 'coupon_period', reference_id: '55', bond_id: 1, payment_freq: 'semi-annual', amount: '500000', gl: '1020', description: 'coupon' };
const ALLOC = { entry_id: 'JE-OPS-5', entry_date: '2026-08-28', reference_type: 'operating_allocation', reference_id: '55', bond_id: 1, payment_freq: 'semi-annual', amount: '1000000', gl: '1030', description: 'alloc' };

describe('FixedIncomeDistributionEngine', () => {
  let s: ReturnType<typeof store>;
  beforeEach(() => {
    s = store([COUPON, ALLOC]);
    vi.spyOn(pool, 'query').mockImplementation(s.query as any);
    vi.spyOn(TrustPolicyEngine, 'beneficiaryStatus').mockResolvedValue({ allowed: true, frozen: false });
    vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entryId: 'JE-X' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('maps source journals to buckets and reads annual allocations from the policy config', () => {
    expect(SOURCE_BUCKETS.coupon_period).toBe('coupon_income');
    expect(SOURCE_BUCKETS.operating_allocation).toBe('trust_operating');
    const a = policyAnnualAllocations();
    expect(a['0x5bcdfcbb7c35d51c5c346caad83b632b8ceae169']).toBe(300000);
    expect(a['0x491c175a4c24106e52a7423f216a56af7786125f']).toBe(1000000);
  });

  it('splits a coupon period across beneficiaries only, prorated to the coupon frequency', () => {
    const split = FixedIncomeDistributionEngine.allocate({ bucket: 'coupon_income', paymentFreq: 'semi-annual', amountUsd: 500000 });
    expect(split.periodsPerYear).toBe(2);
    expect(split.lines.map((l: any) => l.payee.toLowerCase()).sort()).toEqual([...BENEFICIARIES].sort());
    expect(split.lines.every((l: any) => l.payeeRole === 'beneficiary' && l.purpose === 'distribution')).toBe(true);
    expect(split.allocatedUsd).toBe(250000); // (300k + 100k + 100k) / 2
    expect(split.retainedUsd).toBe(250000);
    expect(split.lines.some((l: any) => TRUSTEES.includes(l.payee.toLowerCase()))).toBe(false);
  });

  it('splits an operating allocation to the trustee only and never over-allocates a short period', () => {
    const split = FixedIncomeDistributionEngine.allocate({ bucket: 'trust_operating', paymentFreq: 'semi-annual', amountUsd: 1000000 });
    expect(split.lines).toHaveLength(1);
    expect(split.lines[0].payeeRole).toBe('trustee');
    expect(split.lines[0].purpose).toBe('operating');
    expect(split.allocatedUsd).toBe(500000);
    const short = FixedIncomeDistributionEngine.allocate({ bucket: 'coupon_income', paymentFreq: 'semi-annual', amountUsd: 100000 });
    expect(short.allocatedUsd).toBe(100000);
    expect(short.retainedUsd).toBe(0);
  });

  it('plans idempotently: one distribution per source journal per payee', async () => {
    const first = await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    expect(first.planned).toBe(BENEFICIARIES.length + TRUSTEES.length);
    expect(first.totalUsd).toBe(750000);
    const again = await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    expect(again.planned).toBe(0);
    expect(s.t.fixed_income_distributions.filter(r => r.bucket === 'coupon_income').every(r => r.payee_role === 'beneficiary')).toBe(true);
    expect(s.t.fixed_income_distributions.filter(r => r.bucket === 'trust_operating').every(r => r.payee_role === 'trustee')).toBe(true);
  });

  it('stages through the segregated ERP funding leg with a source-linked reference and waits for the checker', async () => {
    await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    const d = (await FixedIncomeDistributionEngine.list({ bucket: 'coupon_income' }))[0];
    const fund = vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ requestId: 'REQ-1', proposalId: 'P-1', status: 'proposed' });
    const staged = await FixedIncomeDistributionEngine.stage({ distributionId: d.distributionId, actor: 't' });
    expect(fund).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'coupon_income', amountUsd: d.amountUsd, reference: `${d.distributionId}:FUND` }));
    expect(staged.status).toBe('funding');
    expect(staged.fundingRequestId).toBe('REQ-1');
    await expect(FixedIncomeDistributionEngine.execute({ distributionId: d.distributionId })).rejects.toMatchObject({ code: 'FIXED_INCOME_STATE' });
  });

  it('reconcile raises an on-chain beneficiary proposal only after the ERP request completed', async () => {
    await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    const d = (await FixedIncomeDistributionEngine.list({ bucket: 'coupon_income' }))[0];
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ requestId: 'REQ-1', proposalId: 'P-1' });
    await FixedIncomeDistributionEngine.stage({ distributionId: d.distributionId });
    const propose = vi.spyOn(TrustPolicyEngine, 'propose').mockResolvedValue({ distributionId: '42' });
    s.t.canonical_money_requests.push({ id: 'REQ-1', status: 'proposed' });
    await FixedIncomeDistributionEngine.reconcile({});
    expect(propose).not.toHaveBeenCalled();
    expect((await FixedIncomeDistributionEngine.get(d.distributionId)).status).toBe('funding');
    s.t.canonical_money_requests[0].status = 'completed';
    await FixedIncomeDistributionEngine.reconcile({});
    const after = await FixedIncomeDistributionEngine.get(d.distributionId);
    expect(after.status).toBe('proposed');
    expect(after.policyDistributionId).toBe('42');
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({ beneficiary: d.payee, purpose: 'distribution', reference: `${d.distributionId}:PAY` }));
  });

  it('routes the trustee payout through the Spritz off-ramp and executes it via the treasury leg', async () => {
    await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    const d = (await FixedIncomeDistributionEngine.list({ bucket: 'trust_operating' }))[0];
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ requestId: 'REQ-2' });
    await FixedIncomeDistributionEngine.stage({ distributionId: d.distributionId });
    s.t.canonical_money_requests.push({ id: 'REQ-2', status: 'completed' });
    const stagePayout = vi.spyOn(SpritzTreasuryLegEngine, 'stagePayout').mockResolvedValue({ distribution: { distributionId: '7' }, spritzQuoteId: 'Q-1' });
    await FixedIncomeDistributionEngine.reconcile({});
    expect(stagePayout).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'trust_operating', purpose: 'operating', payoutWallet: d.payee }));
    const executePayout = vi.spyOn(SpritzTreasuryLegEngine, 'executePayout').mockResolvedValue({ txHash: '0xabc', journal: { entryId: 'JE-9' } });
    const out = await FixedIncomeDistributionEngine.execute({ distributionId: d.distributionId, actor: 't' });
    expect(executePayout).toHaveBeenCalledWith(expect.objectContaining({ distributionId: '7', spritzQuoteId: 'Q-1' }));
    expect(out.status).toBe('executed');
    expect(out.txHash).toBe('0xabc');
  });

  it('executes a beneficiary distribution on-chain and books Dr distributions / Cr USDC treasury', async () => {
    await FixedIncomeDistributionEngine.plan({ createdBy: 't' });
    const d = (await FixedIncomeDistributionEngine.list({ bucket: 'coupon_income' }))[0];
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ requestId: 'REQ-3' });
    await FixedIncomeDistributionEngine.stage({ distributionId: d.distributionId });
    s.t.canonical_money_requests.push({ id: 'REQ-3', status: 'completed' });
    vi.spyOn(TrustPolicyEngine, 'propose').mockResolvedValue({ distributionId: '9' });
    await FixedIncomeDistributionEngine.reconcile({});
    const exec = vi.spyOn(TrustPolicyEngine, 'execute').mockResolvedValue({ txHash: '0xdef' });
    const post = TrustAccountingEngine.postJournalEntry as any;
    const out = await FixedIncomeDistributionEngine.execute({ distributionId: d.distributionId, actor: 't' });
    expect(exec).toHaveBeenCalledWith({ distributionId: '9' });
    const lines = post.mock.calls.at(-1)[0].lines;
    expect(lines).toEqual([
      expect.objectContaining({ accountCode: '2000', debitAmount: d.amountUsd }),
      expect.objectContaining({ accountCode: '1210', creditAmount: d.amountUsd }),
    ]);
    expect(out.status).toBe('executed');
    expect(out.journalEntryId).toBe('JE-X');
  });

  it('runCycle plans but does not stage or execute unless the auto flags are on', async () => {
    const fund = vi.spyOn(SpritzTreasuryLegEngine, 'fund');
    const out = await FixedIncomeDistributionEngine.runCycle({});
    expect(out.planned).toBe(BENEFICIARIES.length + TRUSTEES.length);
    expect(out.staged).toBe(0);
    expect(fund).not.toHaveBeenCalled();
    expect(out.summary.every((r: any) => r.status === 'planned')).toBe(true);
  });

  it('recognised() follows the bucket GL cash account', async () => {
    expect(await TrustAllocationEngine.recognised('coupon_income')).toBe(500000);
    expect(await TrustAllocationEngine.recognised('trust_operating')).toBe(1000000);
  });
});

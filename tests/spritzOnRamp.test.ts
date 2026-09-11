import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const WALLET = '0x1A904F795a0511C31Ba6347504D08d1bA58E4f89';
process.env.DAPP_CHAIN_ID = '8453';
process.env.SPRITZ_API_KEY = 'test-key';
process.env.COUPON_INCOME_GL_ACCOUNT_CODE = '1020';
process.env.TRUST_OPERATING_GL_ACCOUNT_CODE = '1030';
process.env.THIRDWEB_SERVER_WALLET_ADDRESS = WALLET;
process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID = '8453';
delete process.env.SPRITZ_ONRAMP_FUNDING_SOURCE_ID;
delete process.env.SPRITZ_ONRAMP_LIVE;

const pool = require('../server/integrations/bonds/pgPool');
const { SpritzEngine } = require('../server/integrations/spritz/spritzEngine');
const { TrustAllocationEngine } = require('../server/integrations/dapp/trustAllocationEngine');
const { CanonicalFundingSource } = require('../server/integrations/fineract/canonicalFundingSource');
const { CanonicalConsensusEngine } = require('../server/integrations/dapp/canonicalConsensusEngine');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { CanonicalMoneyEngine } = require('../server/integrations/dapp/canonicalMoneyEngine');
const { SpritzOnRampEngine, SPRITZ_ON_RAMP_CATEGORY } = require('../server/integrations/spritz/spritzOnRampEngine');

type Row = Record<string, any>;

function store() {
  const rows: Row[] = [];
  const cols = /\(([^)]+)\)\s+VALUES/i;
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    let m: RegExpExecArray | null;
    if (/^INSERT INTO spritz_on_ramps/.test(text)) {
      const names = cols.exec(text)![1].split(',').map(s => s.trim());
      const row: Row = { status: 'proposed', shadow: false, created_at: new Date().toISOString() };
      names.forEach((n, i) => { row[n] = params[i]; });
      rows.push(row);
      return { rows: [row] };
    }
    if ((m = /^UPDATE spritz_on_ramps SET (.+) WHERE on_ramp_id=\$(\d+)$/.exec(text))) {
      rows.filter(r => r.on_ramp_id === params[Number(m![2]) - 1]).forEach(r => {
        m![1].split(', ').forEach(pair => {
          const [col, value] = pair.split('=');
          if (value === 'NOW()') r[col] = new Date().toISOString();
          else if (value === 'TRUE') r[col] = true;
          else if (value.startsWith("'")) r[col] = value.slice(1, -1);
          else r[col] = params[Number(value.slice(1)) - 1];
        });
      });
      return { rows: [] };
    }
    if (/WHERE reference=\$1$/.test(text)) return { rows: rows.filter(r => r.reference === params[0]) };
    if (/WHERE on_ramp_id=\$1$/.test(text)) return { rows: rows.filter(r => r.on_ramp_id === params[0]) };
    if (/WHERE status='submitted'/.test(text)) return { rows: rows.filter(r => r.status === 'submitted') };
    if (/GROUP BY bucket, status/.test(text)) return { rows: [] };
    if (/^SELECT \* FROM spritz_on_ramps/.test(text)) return { rows: [...rows] };
    return { rows: [] };
  });
  return { rows, query };
}

const position = (cents: number, code: string) => ({
  accountCode: code, glAccountId: 70, canonicalBalanceCents: cents, ledgerBalanceCents: cents, availableBalanceCents: cents, driftCents: 0, fundingEligible: cents > 0, segregationStatus: cents > 0 ? 'available' : 'restricted',
});

const SOURCE = { id: 'fs_trust_bank', status: 'active', institution: { name: 'Trust Bank' }, last4: '2959' };

describe('SpritzOnRampEngine', () => {
  let db: ReturnType<typeof store>;
  let proposals: Row[];

  beforeEach(() => {
    db = store();
    proposals = [];
    vi.spyOn(pool, 'query').mockImplementation(db.query as any);
    vi.spyOn(SpritzEngine, 'capabilities').mockResolvedValue([{ product: 'fiat_to_crypto', method: 'ach_debit', status: 'active' }]);
    vi.spyOn(SpritzEngine, 'listFundingSources').mockResolvedValue([SOURCE]);
    vi.spyOn(SpritzEngine, 'getFundingSourceDepositLimits').mockResolvedValue({ daily: '50000.00' });
    vi.spyOn(SpritzEngine, 'prepareDirectDeposit').mockResolvedValue({ id: 'prep_1', amountUsd: '1000.00', estimatedOutput: '999.50' });
    vi.spyOn(SpritzEngine, 'createDirectDeposit').mockResolvedValue({ id: 'dep_1', status: 'pending' });
    vi.spyOn(ThirdwebServerWalletEngine, 'resolveAddress').mockResolvedValue(WALLET);
    vi.spyOn(CanonicalFundingSource, 'position').mockImplementation(async ({ accountCode }: any) => position(accountCode === '1020' ? 258333333 : accountCode === '1030' ? 500000000 : 0, accountCode));
    vi.spyOn(CanonicalFundingSource, 'assertAvailable').mockImplementation(async ({ accountCode, amountUsd }: any) => {
      const p = position(accountCode === '1020' ? 258333333 : 500000000, accountCode);
      if (p.availableBalanceCents < Math.round(amountUsd * 100)) throw Object.assign(new Error('insufficient'), { code: 'INSUFFICIENT_CANONICAL_FUNDS' });
      return p;
    });
    vi.spyOn(CanonicalFundingSource, 'commit').mockResolvedValue({ shadow: false, journalEntryId: 'JE-1' });
    vi.spyOn(CanonicalFundingSource, 'reverse').mockResolvedValue({ reversed: true });
    vi.spyOn(CanonicalConsensusEngine, 'createProposal').mockImplementation(async (p: any) => { const row = { id: `CP-${proposals.length + 1}`, ...p, status: 'pending' }; proposals.push(row); return row; });
    vi.spyOn(CanonicalConsensusEngine, 'isApproved').mockReturnValue(false);
  });

  afterEach(() => { vi.restoreAllMocks(); delete process.env.SPRITZ_ONRAMP_LIVE; });

  it('is ready with an active ACH-debit capability, one linked bank and the treasury wallet on base', async () => {
    const r = await SpritzOnRampEngine.readiness();
    expect(r.issues).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.live).toBe(false);
    expect(r.wallet).toEqual({ address: WALLET, chainId: 8453, network: 'base' });
    expect(r.fundingSource).toMatchObject({ id: 'fs_trust_bank', last4: '2959', institution: 'Trust Bank' });
    expect(r.buckets.map((b: any) => [b.bucket, b.cashAccount, b.walletAccount])).toEqual([['coupon_income', '1020', '1025'], ['trust_operating', '1030', '1035']]);
  });

  it('fails closed when no Spritz funding source is linked', async () => {
    (SpritzEngine.listFundingSources as any).mockResolvedValue([]);
    const r = await SpritzOnRampEngine.readiness();
    expect(r.ready).toBe(false);
    expect(r.issues.join(' ')).toMatch(/no Spritz funding source linked/);
    await expect(SpritzOnRampEngine.quote({ amountUsd: 100, bucket: 'coupon_income' })).rejects.toMatchObject({ code: 'ONRAMP_SOURCE_MISSING', status: 409 });
    expect(SpritzEngine.prepareDirectDeposit).not.toHaveBeenCalled();
  });

  it('requires a pinned source when several banks are linked', async () => {
    (SpritzEngine.listFundingSources as any).mockResolvedValue([SOURCE, { id: 'fs_other' }]);
    await expect(SpritzOnRampEngine.quote({ amountUsd: 100, bucket: 'coupon_income' })).rejects.toMatchObject({ code: 'ONRAMP_SOURCE_AMBIGUOUS' });
  });

  it('quotes a deposit of bucket cash to the treasury wallet without debiting', async () => {
    const q = await SpritzOnRampEngine.quote({ amountUsd: 1000, bucket: 'coupon_income' });
    expect(q).toMatchObject({ bucket: 'coupon_income', cashAccount: '1020', walletAccount: '1025', live: false });
    expect(SpritzEngine.prepareDirectDeposit).toHaveBeenCalledWith({ sourceId: 'fs_trust_bank', address: WALLET, network: 'base', asset: 'USDC', amountUsd: 1000, quoteType: 'exact_input', priority: 'normal' });
    expect(SpritzEngine.createDirectDeposit).not.toHaveBeenCalled();
    expect(CanonicalFundingSource.commit).not.toHaveBeenCalled();
  });

  it('refuses more than the bucket holds canonically', async () => {
    await expect(SpritzOnRampEngine.quote({ amountUsd: 3_000_000, bucket: 'coupon_income' })).rejects.toMatchObject({ code: 'INSUFFICIENT_CANONICAL_FUNDS' });
  });

  it('proposes a maker/checker spritz_on_ramp with the bucket pair and is idempotent on reference', async () => {
    const r = await SpritzOnRampEngine.propose({ amountUsd: 1000, bucket: 'trust_operating', reference: 'ONRAMP-1', createdBy: 'maker@dlb' });
    expect(r.status).toBe('proposed');
    expect(r.proposal.category).toBe(SPRITZ_ON_RAMP_CATEGORY);
    expect(r.proposal.payload).toMatchObject({ bucket: 'trust_operating', cashAccount: '1030', walletAccount: '1035', walletAddress: WALLET, network: 'base', fundingSourceId: 'fs_trust_bank', amountUsd: 1000 });
    expect(r.proposal.autoExecute).toBe(false);
    const again = await SpritzOnRampEngine.propose({ amountUsd: 1000, bucket: 'trust_operating', reference: 'ONRAMP-1' });
    expect(again.idempotent).toBe(true);
    expect(proposals).toHaveLength(1);
  });

  it('execution without SPRITZ_ONRAMP_LIVE only prepares (shadow) and moves nothing', async () => {
    const r = await SpritzOnRampEngine.propose({ amountUsd: 500, bucket: 'coupon_income', reference: 'ONRAMP-2' });
    const out = await SpritzOnRampEngine._execute(proposals[0]);
    expect(out).toMatchObject({ status: 'shadow', shadow: true, onRampId: r.onRampId });
    expect(SpritzEngine.createDirectDeposit).not.toHaveBeenCalled();
    expect(CanonicalFundingSource.commit).not.toHaveBeenCalled();
  });

  it('live execution debits via Spritz with the reference as idempotency key and books Dr wallet / Cr bucket cash', async () => {
    process.env.SPRITZ_ONRAMP_LIVE = 'true';
    const r = await SpritzOnRampEngine.propose({ amountUsd: 500, bucket: 'coupon_income', reference: 'ONRAMP-3' });
    const out = await SpritzOnRampEngine._execute(proposals[0]);
    expect(out).toMatchObject({ status: 'submitted', depositId: 'dep_1' });
    expect(SpritzEngine.createDirectDeposit).toHaveBeenCalledWith({ preparationId: 'prep_1', idempotencyKey: 'ONRAMP-3' });
    expect(CanonicalFundingSource.commit).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 500, cashAccountCode: '1020', assetAccountCode: '1025', referenceType: 'spritz_on_ramp', reference: 'ONRAMP-3' }));
    expect((await SpritzOnRampEngine.get(r.onRampId)).status).toBe('submitted');
    // re-running the approved proposal is a no-op
    expect(await SpritzOnRampEngine._execute(proposals[0])).toMatchObject({ idempotent: true });
    expect(SpritzEngine.createDirectDeposit).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the funding source or wallet changed between proposal and approval', async () => {
    process.env.SPRITZ_ONRAMP_LIVE = 'true';
    await SpritzOnRampEngine.propose({ amountUsd: 500, bucket: 'coupon_income', reference: 'ONRAMP-4' });
    (SpritzEngine.listFundingSources as any).mockResolvedValue([{ id: 'fs_swapped' }]);
    await expect(SpritzOnRampEngine._execute(proposals[0])).rejects.toMatchObject({ code: 'ONRAMP_SOURCE_MISMATCH' });
    expect(SpritzEngine.createDirectDeposit).not.toHaveBeenCalled();
    expect(db.rows[0].status).toBe('failed');
  });

  it('reconcile completes settled deposits and reverses the ERP journal on a returned ACH', async () => {
    process.env.SPRITZ_ONRAMP_LIVE = 'true';
    const a = await SpritzOnRampEngine.propose({ amountUsd: 500, bucket: 'coupon_income', reference: 'ONRAMP-5' });
    const b = await SpritzOnRampEngine.propose({ amountUsd: 700, bucket: 'trust_operating', reference: 'ONRAMP-6' });
    (SpritzEngine.createDirectDeposit as any).mockResolvedValueOnce({ id: 'dep_a', status: 'pending' }).mockResolvedValueOnce({ id: 'dep_b', status: 'pending' });
    await SpritzOnRampEngine._execute(proposals[0]);
    await SpritzOnRampEngine._execute(proposals[1]);
    vi.spyOn(SpritzEngine, 'getDeposit').mockImplementation(async (id: string) => id === 'dep_a' ? { id, status: 'completed' } : { id, status: 'returned' });
    const out = await SpritzOnRampEngine.reconcile();
    expect(out.checked).toBe(2);
    expect((await SpritzOnRampEngine.get(a.onRampId)).status).toBe('completed');
    expect((await SpritzOnRampEngine.get(b.onRampId)).status).toBe('failed');
    expect(CanonicalFundingSource.reverse).toHaveBeenCalledWith(expect.objectContaining({ journalEntryId: 'JE-1', amountUsd: 700, reference: 'ONRAMP-6' }));
  });

  it('keeps wallet accounts segregated per bucket', () => {
    expect(TrustAllocationEngine.bucketForSource({ sourceType: 'canonical', sourceAccountId: '1025' })?.key).toBe('coupon_income');
    expect(TrustAllocationEngine.bucketForSource({ sourceType: 'canonical', sourceAccountId: '1035' })?.key).toBe('trust_operating');
    expect(() => TrustAllocationEngine.assertFundingSource({ bucket: 'coupon_income', sourceType: 'canonical', sourceAccountId: '1035' })).toThrow(/must not mix/);
    expect(TrustAllocationEngine.assertFundingSource({ bucket: 'trust_operating', sourceType: 'canonical', sourceAccountId: '1035' }).bucket.key).toBe('trust_operating');
  });

  it('erp_treasury draws credit the bucket wallet account once the on-ramp funded it', async () => {
    (CanonicalFundingSource.position as any).mockImplementation(async ({ accountCode }: any) => position(accountCode === '1025' ? 100000 : accountCode === '1020' ? 258333333 : 0, accountCode));
    expect(await CanonicalMoneyEngine._erpCashAccount('1020', 500)).toBe('1025');
    expect(await CanonicalMoneyEngine._erpCashAccount('1020', 5000)).toBe('1020');
    expect(await CanonicalMoneyEngine._erpCashAccount('1030', 10)).toBe('1030');
  });
});

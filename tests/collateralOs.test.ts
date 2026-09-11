import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const POLICY = '0x9682bEF7fbA219DB0dF7A52B5b7151484aFceB64';
const PRB = '0x3f3a354f76be6ad0e7fc9b6efe39727b39cbd160';
const CUSTODY = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';

process.env.TRUST_POLICY_ADDRESS = POLICY;
process.env.DAPP_CHAIN_ID = '8453';
process.env.COLLATERAL_CUSTODY_WALLET = CUSTODY;
const TREASURY_TOKEN = '0x5d3192581e6f12eeecc0fd414ef5672a454f611c';
process.env.DLB_PRB_TOKEN_ADDRESS = PRB;
process.env.DLB_TREASURY_TOKEN_ADDRESS = TREASURY_TOKEN;

const pool = require('../server/integrations/bonds/pgPool');
const { BondTokenizationEngine } = require('../server/integrations/dapp/bondTokenizationEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { CollateralOsEngine, facilityMath, advanceRateFor, DRAW_TRANSITIONS } = require('../server/integrations/os/collateralOsEngine');

type Row = Record<string, any>;

const TOKEN = { id: 'tok-1', bond_id: 7, token_symbol: 'DLB-PRB', token_address: PRB, metadata: { chainId: 8453, decimals: 6 } };

/** In-memory store answering the SQL shapes the engine emits. */
function store() {
  const t: Record<string, Row[]> = { collateral_positions: [], collateral_draws: [], collateral_events: [], canonical_money_requests: [] };
  let seq = 0;
  const cols = /\(([^)]+)\)\s+VALUES/i;
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    let m: RegExpExecArray | null;
    if ((m = /^INSERT INTO (\w+)/.exec(text))) {
      const table = m[1];
      const names = cols.exec(text)![1].split(',').map(s => s.trim());
      const values = /VALUES \((.+?)\)( RETURNING)?/.exec(text)![1].split(',').map(s => s.trim());
      const row: Row = { created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      names.forEach((n, i) => {
        const v = values[i];
        if (/^\$\d+/.test(v)) row[n] = params[Number(v.replace(/\D/g, '')) - 1];
        else if (/^'.*'$/.test(v)) row[n] = v.slice(1, -1);
        else row[n] = v;
      });
      if (table === 'collateral_events') row.event_id = ++seq;
      t[table].push(row);
      return { rows: [row] };
    }
    if ((m = /^UPDATE (\w+) SET (.+) WHERE (\w+) = \$1$/.exec(text))) {
      const [, table, set, key] = m;
      t[table].filter(r => r[key] === params[0]).forEach(r => {
        set.split(/, (?=\w+ = )/).forEach(pair => {
          const [col, value] = pair.split(/ = (.+)/);
          if (value === 'NOW()') r[col] = new Date().toISOString();
          else if (value === 'NULL') r[col] = null;
          else if (/^'.*'$/.test(value)) r[col] = value.slice(1, -1);
          else if (/^\d+$/.test(value)) r[col] = Number(value);
          else r[col] = params[Number(value.replace(/\$|::jsonb/g, '')) - 1];
        });
      });
      return { rows: [] };
    }
    if (/^SELECT id, status, amount FROM canonical_money_requests/.test(text)) return { rows: t.canonical_money_requests.filter(r => r.id === params[0]) };
    if ((m = /^SELECT \* FROM (\w+) WHERE (\w+) = \$1( ORDER BY .+)?$/.exec(text))) return { rows: t[m[1]].filter(r => r[m![2]] === params[0]) };
    if ((m = /^SELECT \* FROM (\w+)( WHERE (.+?))? ORDER BY .+ LIMIT \d+$/.exec(text))) {
      let rows = [...t[m[1]]];
      if (m[3]) m[3].split(' AND ').forEach(cond => { const [col, ref] = cond.split(' = '); rows = rows.filter(r => r[col] === params[Number(ref.slice(1)) - 1]); });
      return { rows };
    }
    throw new Error(`unhandled SQL in test store: ${text}`);
  });
  return { t, query };
}

describe('facility math (pure)', () => {
  it('advance-rates collateral into spendable value and tracks utilization / margin call', () => {
    const positions = [
      { status: 'pledged', valueUsd: 1_000_000, advanceRateBps: 7000 },
      { status: 'pledged', valueUsd: 100_000, advanceRateBps: 9500 },
      { status: 'released', valueUsd: 5_000_000, advanceRateBps: 7000 },
    ];
    const f = facilityMath(positions, [{ status: 'funded', outstandingUsd: 500_000 }, { status: 'repaid', outstandingUsd: 0 }], 9000);
    expect(f).toMatchObject({ positions: 2, collateralUsd: 1_100_000, spendableUsd: 795_000, drawnUsd: 500_000, availableUsd: 295_000, marginCall: false });
    expect(f.utilizationBps).toBe(Math.round(500_000 / 795_000 * 10000));
    const stressed = facilityMath([{ status: 'pledged', valueUsd: 500_000, advanceRateBps: 7000 }], [{ status: 'funded', outstandingUsd: 340_000 }], 9000);
    expect(stressed).toMatchObject({ spendableUsd: 350_000, availableUsd: 10_000, utilizationBps: 9714, marginCall: true });
    expect(facilityMath([], [], 9000)).toMatchObject({ spendableUsd: 0, utilizationBps: 0, marginCall: false });
  });

  it('resolves advance rates: explicit override > per-token env > per-class env > class default', () => {
    delete process.env.COLLATERAL_ADVANCE_RATES_BPS;
    delete process.env.COLLATERAL_ADVANCE_RATE_BOND_TOKEN_BPS;
    expect(advanceRateFor({ assetClass: 'bond_token', tokenSymbol: 'DLB-PRB' })).toBe(7000);
    expect(advanceRateFor({ assetClass: 'stablecoin' })).toBe(9500);
    expect(advanceRateFor({ assetClass: 'bond_token', override: 6000 })).toBe(6000);
    process.env.COLLATERAL_ADVANCE_RATE_BOND_TOKEN_BPS = '6500';
    expect(advanceRateFor({ assetClass: 'bond_token', tokenSymbol: 'DLB-PRB' })).toBe(6500);
    process.env.COLLATERAL_ADVANCE_RATES_BPS = 'dlb-prb:8000';
    expect(advanceRateFor({ assetClass: 'bond_token', tokenSymbol: 'DLB-PRB' })).toBe(8000);
    delete process.env.COLLATERAL_ADVANCE_RATES_BPS;
    delete process.env.COLLATERAL_ADVANCE_RATE_BOND_TOKEN_BPS;
    expect(() => advanceRateFor({ assetClass: 'bond_token', override: 12000 })).toThrow(/0\.\.10000/);
  });

  it('draw state machine: repaid and cancelled are terminal; proposed cannot settle', () => {
    expect(DRAW_TRANSITIONS.repaid.size).toBe(0);
    expect(DRAW_TRANSITIONS.cancelled.size).toBe(0);
    expect(DRAW_TRANSITIONS.proposed.has('settling')).toBe(false);
    expect(DRAW_TRANSITIONS.funded.has('settling')).toBe(true);
  });
});

describe('Collateral OS lifecycle', () => {
  let db: ReturnType<typeof store>;
  let postJournal: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.COLLATERAL_REQUIRE_VERIFIED_BALANCE;
    delete process.env.COLLATERAL_PAR_FALLBACK;
    db = store();
    vi.spyOn(pool, 'query').mockImplementation(db.query as any);
    vi.spyOn(BondTokenizationEngine, 'getToken').mockResolvedValue(TOKEN as any);
    vi.spyOn(BondTokenizationEngine, 'getTokenBySymbol').mockResolvedValue(TOKEN as any);
    vi.spyOn(BondTokenizationEngine, 'getTokenByAddress').mockResolvedValue(TOKEN as any);
    vi.spyOn(BondTokenizationEngine, 'classifyToken').mockReturnValue('deployed' as any);
    vi.spyOn(ThirdwebServerWalletEngine, 'readiness').mockReturnValue({ ready: true, issues: [] } as any);
    vi.spyOn(ThirdwebServerWalletEngine, 'balance').mockResolvedValue([{ tokenAddress: PRB, value: '1000000000000', decimals: 6 }] as any);
    vi.spyOn(ThirdwebPriceOracle, 'getPrice').mockResolvedValue({ priceUsd: 1, decimals: 6, source: 'thirdweb' } as any);
    postJournal = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockImplementation(async (e: any) => ({ entryId: `JE-${e.referenceId}`, status: 'posted' }) as any);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  async function pledgeMillion() {
    return CollateralOsEngine.pledge({ tokenSymbol: 'DLB-PRB', quantity: '1000000', reference: 'PLEDGE-1', pledgedBy: 'trustee' });
  }

  it('pledges a custody-verified bond token off-balance-sheet at the class advance rate', async () => {
    const p = await pledgeMillion();
    expect(p).toMatchObject({ tokenSymbol: 'DLB-PRB', tokenAddress: PRB, chainId: 8453, quantityUnits: '1000000000000', custodyWallet: CUSTODY, verification: 'verified', assetClass: 'bond_token', advanceRateBps: 7000, priceUsd: 1, valueUsd: 1_000_000, spendableUsd: 700_000, status: 'pledged', glImpact: expect.stringMatching(/off-balance-sheet/) });
    expect(postJournal).not.toHaveBeenCalled();
    expect(db.t.collateral_events.map(e => e.kind)).toEqual(['pledged']);
    const f = await CollateralOsEngine.facility();
    expect(f).toMatchObject({ collateralUsd: 1_000_000, spendableUsd: 700_000, drawnUsd: 0, availableUsd: 700_000, destination: POLICY });
  });

  it('refuses to pledge more than custody holds, shadow tokens, and unverified balances when required', async () => {
    await expect(CollateralOsEngine.pledge({ tokenSymbol: 'DLB-PRB', quantity: '5000000', pledgedBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_INSUFFICIENT_HOLDING' });
    (BondTokenizationEngine.classifyToken as any).mockReturnValue('shadow');
    await expect(CollateralOsEngine.pledge({ tokenSymbol: 'DLB-PRB', quantity: '1', pledgedBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_TOKEN_SHADOW' });
    (BondTokenizationEngine.classifyToken as any).mockReturnValue('deployed');
    (ThirdwebServerWalletEngine.readiness as any).mockReturnValue({ ready: false, issues: ['no key'] });
    process.env.COLLATERAL_REQUIRE_VERIFIED_BALANCE = 'true';
    await expect(CollateralOsEngine.pledge({ tokenSymbol: 'DLB-PRB', quantity: '1', pledgedBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_UNVERIFIED' });
    delete process.env.COLLATERAL_REQUIRE_VERIFIED_BALANCE;
    const p = await CollateralOsEngine.pledge({ tokenSymbol: 'DLB-PRB', quantity: '10', pledgedBy: 'trustee' });
    expect(p.verification).toBe('unverified');
    expect(db.t.collateral_positions).toHaveLength(1);
  });

  it('falls back to par when the oracle has no quote, and fails closed when par fallback is off', async () => {
    (ThirdwebPriceOracle.getPrice as any).mockRejectedValue(new Error('no quote'));
    const p = await pledgeMillion();
    expect(p).toMatchObject({ priceSource: 'par', priceUsd: 1, valueUsd: 1_000_000 });
    process.env.COLLATERAL_PAR_FALLBACK = 'false';
    await expect(CollateralOsEngine.pledge({ tokenSymbol: 'DLB-PRB', quantity: '1', pledgedBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_PRICE_UNAVAILABLE' });
  });

  it('draws through the Spritz treasury leg (ERP -> USDC -> policy contract), never a bank, and caps at the borrowing base', async () => {
    await pledgeMillion();
    const fund = vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'proposed', requestId: 'CM-1', proposalId: 'PROP-1', destination: POLICY, source: { sourceToken: PRB } } as any);

    await expect(CollateralOsEngine.draw({ amountUsd: 700_000.01, reference: 'DRAW-BIG', bucket: 'trust_operating', createdBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_INSUFFICIENT' });
    await expect(CollateralOsEngine.draw({ amountUsd: 10, bucket: 'trust_operating', createdBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_INVALID' });
    expect(fund).not.toHaveBeenCalled();

    const d = await CollateralOsEngine.draw({ amountUsd: 250_000, reference: 'DRAW-1', bucket: 'trust_operating', createdBy: 'trustee' });
    expect(fund).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 250_000, reference: 'DRAW-1', bucket: 'trust_operating', sourceToken: TREASURY_TOKEN, sourceModule: 'treasury', autoApprove: false, createdBy: 'trustee' }));
    expect(d).toMatchObject({ status: 'proposed', amountUsd: 250_000, outstandingUsd: 250_000, requestId: 'CM-1', proposalId: 'PROP-1', destination: POLICY });
    expect(d.facility.availableUsd).toBe(450_000);

    const again = await CollateralOsEngine.draw({ amountUsd: 999, reference: 'DRAW-1', bucket: 'trust_operating', createdBy: 'trustee' });
    expect(again).toMatchObject({ drawId: d.drawId, idempotent: true });
    expect(fund).toHaveBeenCalledTimes(1);
    expect(postJournal).not.toHaveBeenCalled();
  });

  it('keeps coupon income and trust operating segregated: cross-bucket sources are refused before any ERP proposal', async () => {
    await pledgeMillion();
    const fund = vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'proposed', requestId: 'CM-1', proposalId: 'P1', destination: POLICY } as any);

    await expect(CollateralOsEngine.draw({ amountUsd: 1_000, reference: 'MIX-1', createdBy: 't' })).rejects.toMatchObject({ code: 'ALLOCATION_BUCKET_REQUIRED' });
    await expect(CollateralOsEngine.draw({ amountUsd: 1_000, reference: 'MIX-2', bucket: 'trust_operating', sourceToken: PRB, createdBy: 't' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH', status: 409 });
    await expect(CollateralOsEngine.draw({ amountUsd: 1_000, reference: 'MIX-3', bucket: 'coupon_income', sourceModule: 'treasury', createdBy: 't' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
    await expect(CollateralOsEngine.draw({ amountUsd: 1_000, reference: 'MIX-4', bucket: 'coupon_income', sourceType: 'ledger', sourceAccountId: '1100', createdBy: 't' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
    await expect(CollateralOsEngine.draw({ amountUsd: 1_000, reference: 'MIX-5', bucket: 'coupon_income', sourceToken: '0x00000000000000000000000000000000000000aa', createdBy: 't' })).rejects.toMatchObject({ code: 'ALLOCATION_SOURCE_MISMATCH' });
    await expect(CollateralOsEngine.draw({ amountUsd: 1_000, reference: 'MIX-6', bucket: 'petty_cash', createdBy: 't' })).rejects.toMatchObject({ code: 'ALLOCATION_BUCKET_UNKNOWN' });
    expect(fund).not.toHaveBeenCalled();

    const coupon = await CollateralOsEngine.draw({ amountUsd: 1_000, reference: 'CPN-1', sourceToken: PRB, createdBy: 't' });
    expect(coupon.bucket).toBe('coupon_income');
    expect(fund).toHaveBeenLastCalledWith(expect.objectContaining({ bucket: 'coupon_income', sourceToken: PRB, sourceModule: 'bond_portfolio' }));
    const events = await CollateralOsEngine.events({ subjectId: coupon.drawId });
    expect(events.find((e: any) => e.kind === 'draw_proposed')?.payload).toMatchObject({ bucket: 'coupon_income' });

    await expect(CollateralOsEngine.draw({ amountUsd: 5, reference: 'CPN-1', bucket: 'trust_operating', createdBy: 't' })).rejects.toMatchObject({ code: 'ALLOCATION_REFERENCE_CONFLICT' });
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it('reconcile funds checker-approved draws with DR USDC treasury / CR facility, cancels rejected ones', async () => {
    await pledgeMillion();
    vi.spyOn(SpritzTreasuryLegEngine, 'fund')
      .mockResolvedValueOnce({ status: 'proposed', requestId: 'CM-1', proposalId: 'P1', destination: POLICY } as any)
      .mockResolvedValueOnce({ status: 'proposed', requestId: 'CM-2', proposalId: 'P2', destination: POLICY } as any)
      .mockResolvedValueOnce({ status: 'proposed', requestId: 'CM-3', proposalId: 'P3', destination: POLICY } as any);
    const a = await CollateralOsEngine.draw({ amountUsd: 100_000, reference: 'A', bucket: 'coupon_income', createdBy: 't' });
    const b = await CollateralOsEngine.draw({ amountUsd: 50_000, reference: 'B', bucket: 'coupon_income', createdBy: 't' });
    const c = await CollateralOsEngine.draw({ amountUsd: 25_000, reference: 'C', bucket: 'coupon_income', createdBy: 't' });
    db.t.canonical_money_requests.push({ id: 'CM-1', status: 'completed', amount: '100000' }, { id: 'CM-2', status: 'rejected', amount: '50000' }, { id: 'CM-3', status: 'pending_approval', amount: '25000' });

    const out = await CollateralOsEngine.reconcile({ postedBy: 'ops' });
    expect(out.reconciled).toBe(3);
    expect(out.draws).toEqual(expect.arrayContaining([
      expect.objectContaining({ drawId: c.drawId, status: 'proposed', requestStatus: 'pending_approval' }),
      expect.objectContaining({ drawId: b.drawId, status: 'cancelled' }),
      expect.objectContaining({ drawId: a.drawId, status: 'funded', journal: expect.objectContaining({ booked: true, entryId: `JE-${a.drawId}` }) }),
    ]));
    expect(postJournal).toHaveBeenCalledTimes(1);
    const entry = postJournal.mock.calls[0][0] as any;
    expect(entry).toMatchObject({ referenceType: 'collateral_draw', referenceId: a.drawId, postedBy: 'ops' });
    expect(entry.lines).toEqual([
      expect.objectContaining({ accountCode: '1210', debitAmount: 100_000, creditAmount: 0 }),
      expect.objectContaining({ accountCode: '2400', debitAmount: 0, creditAmount: 100_000 }),
    ]);
    expect(await CollateralOsEngine.getDraw(a.drawId)).toMatchObject({ status: 'funded', journalEntryId: `JE-${a.drawId}` });
    expect(await CollateralOsEngine.getDraw(b.drawId)).toMatchObject({ status: 'cancelled', outstandingUsd: 0 });
    expect(out.facility).toMatchObject({ drawnUsd: 125_000, availableUsd: 575_000 });

    // idempotent: a second reconcile books nothing new
    await CollateralOsEngine.reconcile({ postedBy: 'ops' });
    expect(postJournal).toHaveBeenCalledTimes(1);
  });

  it('settles a funded draw to the bank through Spritz staging then execution, and repays with the reverse journal', async () => {
    await pledgeMillion();
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'proposed', requestId: 'CM-1', proposalId: 'P1', destination: POLICY } as any);
    const d = await CollateralOsEngine.draw({ amountUsd: 100_000, reference: 'DRAW-1', bucket: 'trust_operating', createdBy: 't' });
    db.t.canonical_money_requests.push({ id: 'CM-1', status: 'completed', amount: '100000' });
    await CollateralOsEngine.reconcile({ postedBy: 'ops' });

    const stage = vi.spyOn(SpritzTreasuryLegEngine, 'stagePayout').mockResolvedValue({ spritzQuoteId: 'q_1', distribution: { distributionId: 'DIST-1' }, settlementBank: { id: 'ba_dbnet', label: 'DB NET MGMT Operating' }, amountUsd: 100_000 } as any);
    const exec = vi.spyOn(SpritzTreasuryLegEngine, 'executePayout').mockResolvedValue({ status: 'executed', txHash: '0xabc', amountUsd: 100_000, feeUsd: 1.5 } as any);

    await expect(CollateralOsEngine.executeSettlement({ drawId: d.drawId, actor: 't' })).rejects.toMatchObject({ code: 'COLLATERAL_STATE' });
    await expect(CollateralOsEngine.settle({ drawId: d.drawId, purpose: 'medical', actor: 't' })).rejects.toMatchObject({ code: 'ALLOCATION_PURPOSE_MISMATCH' });
    expect(stage).not.toHaveBeenCalled();
    const settling = await CollateralOsEngine.settle({ drawId: d.drawId, actor: 't' });
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 100_000, purpose: 'operating', bucket: 'trust_operating', reference: 'DRAW-1:SETTLE' }));
    expect(settling).toMatchObject({ status: 'settling', spritzQuoteId: 'q_1', distributionId: 'DIST-1' });

    const settled = await CollateralOsEngine.executeSettlement({ drawId: d.drawId, actor: 't' });
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ distributionId: 'DIST-1', spritzQuoteId: 'q_1', amountUsd: 100_000 }));
    expect(settled).toMatchObject({ status: 'settled', settlement: { txHash: '0xabc' } });

    await expect(CollateralOsEngine.repay({ drawId: d.drawId, amountUsd: 200_000, actor: 't' })).rejects.toMatchObject({ code: 'COLLATERAL_INVALID' });
    const partial = await CollateralOsEngine.repay({ drawId: d.drawId, amountUsd: 40_000, reference: 'REPAY-1', actor: 't' });
    expect(partial).toMatchObject({ status: 'settled', outstandingUsd: 60_000, repaidUsd: 40_000 });
    const repayEntry = postJournal.mock.calls[1][0] as any;
    expect(repayEntry).toMatchObject({ referenceType: 'collateral_repayment', referenceId: 'REPAY-1' });
    expect(repayEntry.lines).toEqual([
      expect.objectContaining({ accountCode: '2400', debitAmount: 40_000 }),
      expect.objectContaining({ accountCode: '1210', creditAmount: 40_000 }),
    ]);
    const full = await CollateralOsEngine.repay({ drawId: d.drawId, actor: 't' });
    expect(full).toMatchObject({ status: 'repaid', outstandingUsd: 0, repaidUsd: 60_000 });
    expect(full.facility).toMatchObject({ drawnUsd: 0, availableUsd: 700_000 });
    expect(db.t.collateral_events.map(e => e.kind)).toEqual(['pledged', 'draw_proposed', 'draw_funded', 'draw_settling', 'draw_settled', 'draw_partially_repaid', 'draw_repaid']);
  });

  it('revalue flags a margin call when the base falls under the drawn amount and blocks new draws; release is refused while encumbered', async () => {
    const p = await pledgeMillion();
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'proposed', requestId: 'CM-1', proposalId: 'P1', destination: POLICY } as any);
    const d = await CollateralOsEngine.draw({ amountUsd: 600_000, positionId: p.positionId, reference: 'DRAW-1', bucket: 'coupon_income', createdBy: 't' });
    db.t.canonical_money_requests.push({ id: 'CM-1', status: 'completed', amount: '600000' });
    await CollateralOsEngine.reconcile({ postedBy: 'ops' });

    await expect(CollateralOsEngine.release({ positionId: p.positionId, actor: 't' })).rejects.toMatchObject({ code: 'COLLATERAL_ENCUMBERED' });

    (ThirdwebPriceOracle.getPrice as any).mockResolvedValue({ priceUsd: 0.9, decimals: 6, source: 'thirdweb' });
    const stressed = await CollateralOsEngine.revalue({ actor: 'ops' });
    expect(stressed).toMatchObject({ collateralUsd: 900_000, spendableUsd: 630_000, drawnUsd: 600_000, marginCall: true });
    expect(stressed.positions[0]).toMatchObject({ positionId: p.positionId, status: 'margin_call', previousValueUsd: 1_000_000, valueUsd: 900_000 });
    await expect(CollateralOsEngine.draw({ amountUsd: 1, reference: 'DRAW-2', bucket: 'coupon_income', createdBy: 't' })).rejects.toMatchObject({ code: 'COLLATERAL_MARGIN_CALL' });

    (ThirdwebPriceOracle.getPrice as any).mockResolvedValue({ priceUsd: 1, decimals: 6, source: 'thirdweb' });
    const recovered = await CollateralOsEngine.revalue({ actor: 'ops' });
    expect(recovered.marginCall).toBe(false);
    expect((await CollateralOsEngine.position(p.positionId)).status).toBe('pledged');

    await CollateralOsEngine.repay({ drawId: d.drawId, actor: 't' });
    const released = await CollateralOsEngine.release({ positionId: p.positionId, actor: 't', reason: 'done' });
    expect(released).toMatchObject({ status: 'released', facility: { positions: 0, drawnUsd: 0 } });
    await expect(CollateralOsEngine.release({ positionId: p.positionId, actor: 't' })).rejects.toMatchObject({ code: 'COLLATERAL_STATE' });
    expect(db.t.collateral_events.filter(e => e.subject_id === p.positionId).map(e => e.kind)).toEqual(['pledged', 'margin_call', 'margin_call_cleared', 'released']);
  });

  it('readiness reports the custody wallet, oracle, and treasury-leg posture without moving anything', async () => {
    vi.spyOn(SpritzTreasuryLegEngine, 'readiness').mockResolvedValue({ ready: true, issues: [], settlementBank: { id: 'ba_dbnet' }, fundingSource: { sourceToken: PRB } } as any);
    vi.spyOn(ThirdwebPriceOracle, 'readiness').mockReturnValue({ ready: true, issues: [] } as any);
    const r = await CollateralOsEngine.readiness();
    expect(r).toMatchObject({ provider: 'collateral-os', ready: true, issues: [], custodyWallet: CUSTODY, destination: POLICY, treasuryLeg: { ready: true, settlementBank: { id: 'ba_dbnet' } }, gl: { treasuryAccount: '1210', facilityAccount: '2400' } });
    expect(r.advanceRates.bond_token).toBe(7000);
  });
});

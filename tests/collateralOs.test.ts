import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const PRB = '0x3f3a354f76be6ad0e7fc9b6efe39727b39cbd160';
const TREASURY = '0x9682bef7fba219db0df7a52b5b7151484afceb64';
const CUSTODY = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';

process.env.DAPP_CHAIN_ID = '8453';
process.env.DAPP_OPERATOR_ADDRESS = CUSTODY;
process.env.DLB_PRB_TOKEN_ADDRESS = PRB;
process.env.DLB_TREASURY_TOKEN_ADDRESS = TREASURY;
process.env.COLLATERAL_CUSTODY_WALLET = CUSTODY;
process.env.COLLATERAL_ADVANCE_RATE_BPS = '7000';
process.env.COLLATERAL_MARGIN_CALL_BPS = '9000';
process.env.COLLATERAL_ADVANCE_RATES = 'DLB-TREASURY:9500';
process.env.COLLATERAL_GL_BOOKING_ENABLED = 'true';

const pool = require('../server/integrations/bonds/pgPool');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { ThirdwebPriceOracle } = require('../server/integrations/dapp/thirdwebPriceOracle');
const { ThirdwebServerWalletEngine } = require('../server/integrations/dapp/thirdwebServerWalletEngine');
const { BondTokenizationEngine } = require('../server/integrations/dapp/bondTokenizationEngine');
const { SpritzTreasuryLegEngine } = require('../server/integrations/spritz/spritzTreasuryLegEngine');
const { CollateralOsEngine, unitsToAmount, amountToUnits } = require('../server/integrations/os/collateralOsEngine');

type Row = Record<string, any>;

/** Minimal in-memory Postgres stand-in for the three collateral tables. */
function fakeDb() {
  const tables: Record<string, Row[]> = { collateral_positions: [], collateral_draws: [], collateral_events: [] };
  const erp: Record<string, Row> = {};
  const journals: Row[] = [];
  let eventSeq = 0;
  const q = async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^CREATE /i.test(s)) return { rows: [], rowCount: 0 };
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^INSERT INTO (\w+) \(([^)]+)\)/i))) {
      const cols = m[2].split(',').map((c) => c.trim());
      const row: Row = { created_at: new Date(eventSeq++).toISOString() };
      cols.forEach((c, i) => { row[c] = params[i]; });
      if (m[1] === 'collateral_events') row.id = eventSeq;
      tables[m[1]].push(row);
      return { rows: [row], rowCount: 1 };
    }
    if ((m = s.match(/^UPDATE (\w+) SET (.+) WHERE id = \$1$/i))) {
      const row = tables[m[1]].find((r) => r.id === params[0]);
      if (row) m[2].split(',').map((x) => x.trim()).forEach((assign) => {
        const [k, v] = assign.split('=').map((x) => x.trim());
        if (v.startsWith('$')) row[k] = params[Number(v.slice(1)) - 1];
      });
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('SELECT entry_id FROM trust_journal_entries')) {
      const hit = journals.find((j) => j.referenceType === params[0] && j.referenceId === params[1]);
      return { rows: hit ? [{ entry_id: hit.entry_id }] : [] };
    }
    if (s.startsWith('SELECT id, status, amount, result FROM canonical_money_requests')) {
      return { rows: erp[params[0]] ? [erp[params[0]]] : [] };
    }
    if ((m = s.match(/^SELECT \* FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY .+?)?(?: LIMIT \$\d+)?$/i))) {
      let rows = tables[m[1]].slice();
      if (m[2]) {
        for (const cond of m[2].split(' AND ')) {
          const c = cond.trim();
          let cm: RegExpMatchArray | null;
          if ((cm = c.match(/^(\w+) = ANY\(\$(\d+)\)$/))) { const set = params[Number(cm[2]) - 1]; rows = rows.filter((r) => set.includes(r[cm![1]])); }
          else if ((cm = c.match(/^(\w+) = \$(\d+)$/))) { const v = params[Number(cm[2]) - 1]; rows = rows.filter((r) => r[cm![1]] === v); }
        }
      }
      rows.reverse();
      return { rows, rowCount: rows.length };
    }
    throw new Error(`fakeDb: unhandled SQL ${s}`);
  };
  return { q, tables, erp, journals };
}

describe('Collateral OS engine', () => {
  let db: ReturnType<typeof fakeDb>;

  beforeEach(() => {
    vi.restoreAllMocks();
    db = fakeDb();
    vi.spyOn(pool, 'query').mockImplementation(db.q as any);
    vi.spyOn(BondTokenizationEngine, 'getTokenByAddress').mockResolvedValue(null);
    vi.spyOn(BondTokenizationEngine, 'getTokenBySymbol').mockResolvedValue(null);
    vi.spyOn(ThirdwebPriceOracle, 'quoteUsd').mockImplementation(async ({ tokenAddress, quantity }: any) => {
      const price = tokenAddress.toLowerCase() === PRB ? 1 : 2;
      return { priceUsd: price, amountUsd: Number(quantity) / 1e6 * price, source: 'pinned', decimals: 6, symbol: 'X' };
    });
    vi.spyOn(ThirdwebServerWalletEngine, 'balance').mockImplementation(async ({ tokenAddress }: any) => [
      { tokenAddress, value: tokenAddress.toLowerCase() === PRB ? '1000000000' : '500000000' }, // 1000 PRB, 500 TREASURY
    ]);
    vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockImplementation(async (e: any) => {
      const entry = { entry_id: `JE-${db.journals.length + 1}`, ...e };
      db.journals.push(entry);
      return entry;
    });
  });

  it('converts between token units and amounts', () => {
    expect(unitsToAmount('1500000', 6)).toBe(1.5);
    expect(amountToUnits('1.5', 6)).toBe(1_500_000n);
    expect(() => amountToUnits('-1', 6)).toThrow(/non-negative/);
  });

  it('values a pledge through the thirdweb price oracle and applies the advance rate', async () => {
    const quote = await CollateralOsEngine.quotePledge({ symbol: 'DLB-PRB', quantity: 1000 });
    expect(quote).toMatchObject({ tokenAddress: PRB, chainId: 8453, sourceModule: 'bond_portfolio', quantityUnits: '1000000000', valueUsd: 1000, advanceRateBps: 7000, spendableUsd: 700 });
    const treasury = await CollateralOsEngine.quotePledge({ symbol: 'DLB-TREASURY', quantity: 100 });
    expect(treasury).toMatchObject({ tokenAddress: TREASURY, valueUsd: 200, advanceRateBps: 9500, spendableUsd: 190 });
  });

  it('refuses to pledge more than the custody wallet holds on chain', async () => {
    await expect(CollateralOsEngine.pledge({ symbol: 'DLB-PRB', quantity: 1001, pledgedBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_INSUFFICIENT_HOLDING' });
    await CollateralOsEngine.pledge({ symbol: 'DLB-PRB', quantity: 600, pledgedBy: 'trustee' });
    await expect(CollateralOsEngine.pledge({ symbol: 'DLB-PRB', quantity: 500, pledgedBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_INSUFFICIENT_HOLDING' });
    (ThirdwebServerWalletEngine.balance as any).mockRejectedValue(new Error('rpc down'));
    await expect(CollateralOsEngine.pledge({ symbol: 'DLB-TREASURY', quantity: 1 })).rejects.toMatchObject({ code: 'COLLATERAL_HOLDING_UNVERIFIABLE' });
  });

  it('reports spendable value net of outstanding draws and blocks over-draws and margin-call breaches', async () => {
    const pos = await CollateralOsEngine.pledge({ symbol: 'DLB-PRB', quantity: 1000, pledgedBy: 'trustee' });
    expect(pos).toMatchObject({ status: 'active', valueUsd: 1000, spendableUsd: 700, verified: true, heldUnits: '1000000000' });

    const fund = vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'proposed', requestId: 'CM-1', proposalId: 'PROP-1' } as any);
    await expect(CollateralOsEngine.draw({ amountUsd: 701, reference: 'D-BIG', createdBy: 'ops' })).rejects.toMatchObject({ code: 'COLLATERAL_INSUFFICIENT_SPENDABLE' });
    await expect(CollateralOsEngine.draw({ amountUsd: 650, reference: 'D-MC', createdBy: 'ops' })).rejects.toMatchObject({ code: 'COLLATERAL_MARGIN_CALL' });
    expect(fund).not.toHaveBeenCalled();

    const draw = await CollateralOsEngine.draw({ amountUsd: 300, reference: 'D-1', createdBy: 'ops' });
    expect(fund).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: '300.00', sourceToken: PRB, sourceModule: 'bond_portfolio', reference: 'COLLATERAL:D-1', autoApprove: false }));
    expect(draw).toMatchObject({ status: 'proposed', erpRequestId: 'CM-1', positionId: pos.id, amountUsd: 300 });
    expect(draw.facility).toMatchObject({ spendableUsd: 700, drawnUsd: 300, availableUsd: 400, utilizationBps: 4286, marginCall: false });

    const again = await CollateralOsEngine.draw({ amountUsd: 300, reference: 'D-1', createdBy: 'ops' });
    expect(again).toMatchObject({ id: draw.id, idempotent: true });
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it('books a draw once the ERP request completes, settles it through Spritz and retires it on repayment', async () => {
    const pos = await CollateralOsEngine.pledge({ symbol: 'DLB-PRB', quantity: 1000, pledgedBy: 'trustee' });
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'proposed', requestId: 'CM-1', proposalId: 'PROP-1' } as any);
    const draw = await CollateralOsEngine.draw({ amountUsd: 250, reference: 'D-1', purpose: 'operating', createdBy: 'ops' });

    db.erp['CM-1'] = { id: 'CM-1', status: 'pending', amount: '250.00', result: null };
    let out = await CollateralOsEngine.reconcile({ postedBy: 'checker' });
    expect(out.reconciled[0]).toMatchObject({ drawId: draw.id, status: 'proposed', erpStatus: 'pending' });
    await expect(CollateralOsEngine.stageSettlement({ drawId: draw.id })).rejects.toMatchObject({ code: 'COLLATERAL_DRAW_NOT_FUNDED' });

    db.erp['CM-1'].status = 'completed';
    out = await CollateralOsEngine.reconcile({ postedBy: 'checker' });
    expect(out.reconciled[0]).toMatchObject({ drawId: draw.id, status: 'funded', journal: { status: 'booked', entryId: 'JE-1' } });
    expect(db.journals[0]).toMatchObject({ referenceType: 'collateral_draw', referenceId: draw.id, postToFineract: false });
    expect(db.journals[0].lines).toEqual([
      expect.objectContaining({ accountCode: '1210', debitAmount: 250, creditAmount: 0 }),
      expect.objectContaining({ accountCode: '2400', debitAmount: 0, creditAmount: 250 }),
    ]);
    // replay never double-books
    await CollateralOsEngine._updateDraw(draw.id, { status: 'proposed' });
    out = await CollateralOsEngine.reconcile({ postedBy: 'checker' });
    expect(out.reconciled[0].journal).toMatchObject({ status: 'already_booked', entryId: 'JE-1' });
    expect(db.journals).toHaveLength(1);

    const stage = vi.spyOn(SpritzTreasuryLegEngine, 'stagePayout').mockResolvedValue({ distribution: { distributionId: 'DIST-9' }, spritzQuoteId: 'SQ-9', settlementBank: { id: 'ba_dbnet' } } as any);
    const staged = await CollateralOsEngine.stageSettlement({ drawId: draw.id, rail: 'rtp' });
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 250, purpose: 'operating', reference: 'COLLATERAL:D-1', rail: 'rtp' }));
    expect(staged).toMatchObject({ status: 'settling', distributionId: 'DIST-9', spritzQuoteId: 'SQ-9' });

    const exec = vi.spyOn(SpritzTreasuryLegEngine, 'executePayout').mockResolvedValue({ txHash: '0xabc', amountUsd: '250.00', feeUsd: '1.00' } as any);
    const settled = await CollateralOsEngine.executeSettlement({ drawId: draw.id, createdBy: 'ops' });
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ distributionId: 'DIST-9', spritzQuoteId: 'SQ-9', amountUsd: 250 }));
    expect(settled.status).toBe('settled');

    // still outstanding: cannot release the collateral behind it
    await expect(CollateralOsEngine.release({ positionId: pos.id, actor: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_RELEASE_UNDERCOLLATERALISED' });
    await expect(CollateralOsEngine.repay({ drawId: draw.id, amountUsd: 300, createdBy: 'trustee' })).rejects.toMatchObject({ code: 'COLLATERAL_OVERPAYMENT' });

    const partial = await CollateralOsEngine.repay({ drawId: draw.id, amountUsd: 100, createdBy: 'trustee' });
    expect(partial).toMatchObject({ status: 'settled', repaidUsd: 100, outstandingUsd: 150 });
    expect(partial.facility).toMatchObject({ drawnUsd: 150, availableUsd: 550 });
    expect(db.journals[1].lines).toEqual([
      expect.objectContaining({ accountCode: '2400', debitAmount: 100, creditAmount: 0 }),
      expect.objectContaining({ accountCode: '1210', debitAmount: 0, creditAmount: 100 }),
    ]);

    const full = await CollateralOsEngine.repay({ drawId: draw.id, createdBy: 'trustee' });
    expect(full).toMatchObject({ status: 'repaid', repaidUsd: 250, outstandingUsd: 0 });
    expect(full.facility).toMatchObject({ drawnUsd: 0, availableUsd: 700, openDraws: 0 });

    const released = await CollateralOsEngine.release({ positionId: pos.id, actor: 'trustee' });
    expect(released.status).toBe('released');
    expect(released.facility).toMatchObject({ positions: 0, spendableUsd: 0 });

    const kinds = (await CollateralOsEngine.events({ subjectId: draw.id })).map((e: Row) => e.kind);
    expect(kinds).toEqual(['repaid', 'partial_repayment', 'settled', 'settlement_staged', 'funded', 'funded', 'drawn']);
  });

  it('revalues positions and raises a margin call when collateral falls', async () => {
    await CollateralOsEngine.pledge({ symbol: 'DLB-PRB', quantity: 1000, pledgedBy: 'trustee' });
    vi.spyOn(SpritzTreasuryLegEngine, 'fund').mockResolvedValue({ status: 'proposed', requestId: 'CM-1' } as any);
    await CollateralOsEngine.draw({ amountUsd: 600, reference: 'D-1', createdBy: 'ops' });

    (ThirdwebPriceOracle.quoteUsd as any).mockImplementation(async ({ quantity }: any) => ({ priceUsd: 0.8, amountUsd: Number(quantity) / 1e6 * 0.8, source: 'thirdweb', decimals: 6 }));
    (ThirdwebServerWalletEngine.balance as any).mockResolvedValue([{ tokenAddress: PRB, value: '900000000' }]);
    const out = await CollateralOsEngine.revalue({ actor: 'cron' });
    expect(out.revalued[0]).toMatchObject({ previousValueUsd: 1000, valueUsd: 800, holdingShortfall: true });
    expect(out.facility).toMatchObject({ spendableUsd: 560, drawnUsd: 600, availableUsd: 0, utilizationBps: 10714, marginCall: true });
    await expect(CollateralOsEngine.draw({ amountUsd: 1, reference: 'D-2', createdBy: 'ops' })).rejects.toMatchObject({ code: 'COLLATERAL_MARGIN_CALL' });
    const kinds = (await CollateralOsEngine.events({})).map((e: Row) => e.kind);
    expect(kinds).toContain('margin_call');
    expect(kinds).toContain('holding_shortfall');
  });

  it('reports readiness issues without throwing when nothing is configured', async () => {
    vi.spyOn(SpritzTreasuryLegEngine, 'readiness').mockResolvedValue({ ready: false, issues: ['SPRITZ_API_KEY not configured'] } as any);
    const r = await CollateralOsEngine.readiness();
    expect(r.provider).toBe('collateral-os');
    expect(r.ready).toBe(false);
    expect(r.issues).toContain('treasury leg: SPRITZ_API_KEY not configured');
    expect(r.facility).toMatchObject({ positions: 0, spendableUsd: 0 });
    expect(r.gl).toEqual({ treasuryAccount: '1210', facilityAccount: '2400', bookingEnabled: true });
  });
});

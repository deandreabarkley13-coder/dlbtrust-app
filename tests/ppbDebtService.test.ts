import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');
const { FixedIncomeDistributionEngine } = require('../server/integrations/os/fixedIncomeDistributionEngine');
const { BondRedemptionOsEngine } = require('../server/integrations/os/bondRedemptionOsEngine');
const { debtServiceSnapshot } = require('../server/integrations/os/debtServiceSnapshot');
const wire = require('../server/scripts/ppbDebtServiceWire');

type Row = Record<string, any>;

function stub({ couponDue = 1250000, couponCents = 513554621, ready = true } = {}) {
  vi.spyOn(DebtOsEngine, 'schedule').mockResolvedValue({
    horizonDays: 90,
    events: [
      { bondId: 1, bondName: 'DLB-PRB', type: 'coupon', date: '2026-10-15', amount: couponDue },
    ],
    totals: { coupon: couponDue, principal: 0, total: couponDue },
  });
  vi.spyOn(FixedIncomeDistributionEngine, 'readiness').mockResolvedValue({
    enabled: true, rail: 'bank', autoStage: false, autoExecute: false, ready, issues: ready ? [] : ['lili: not ready'],
    buckets: [
      { bucket: 'coupon_income', glAccountCode: '1020', payees: [{ bankId: 'lili', shareBps: 10000 }], funding: { accountCode: '1020', availableCents: couponCents, eligible: true } },
      { bucket: 'trust_operating', glAccountCode: '1030', payees: [], funding: { error: 'no position' } },
    ],
  });
  vi.spyOn(FixedIncomeDistributionEngine, 'summary').mockResolvedValue([
    { bucket: 'coupon_income', status: 'planned', count: 2, totalUsd: 2500 },
    { bucket: 'coupon_income', status: 'executed', count: 1, totalUsd: 1000 },
  ]);
  vi.spyOn(BondRedemptionOsEngine, 'status').mockResolvedValue({
    notices: {}, batches: {}, unpostedSettlements: 0,
    upcomingMaturities: [{ bondId: 1, bondName: 'DLB-PRB', maturityDate: '2026-12-01', principalBalanceCents: 10000000000, daysToMaturity: 62, noticeId: null }],
  });
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('PPB debt service snapshot', () => {
  it('reports schedule, coupon funding, distributions and principal maturities', async () => {
    stub();
    const s = await debtServiceSnapshot({ horizonDays: 90 });
    expect(s.schedule).toMatchObject({ coupon: 1250000, principal: 0 });
    expect(s.coupon.funding.coupon_income).toEqual({ glAccountCode: '1020', payees: 1, available: 5135546.21, eligible: true, reason: null });
    expect(s.coupon.funding.trust_operating).toMatchObject({ available: null, eligible: false, reason: 'no position' });
    expect(s.coupon.distributions.coupon_income).toEqual({ planned: { count: 2, total: 2500 }, executed: { count: 1, total: 1000 } });
    expect(s.principal.upcomingMaturities[0]).toMatchObject({ principal: 100000000, maturityDate: '2026-12-01' });
    expect(s.coverage).toEqual({ couponDue: 1250000, couponFunding: 5135546.21, couponCovered: true });
    expect(s.movesMoney).toBe(false);
  });

  it('flags coupons not covered by coupon income funding', async () => {
    stub({ couponDue: 6000000 });
    const s = await debtServiceSnapshot();
    expect(s.coverage.couponCovered).toBe(false);
  });

  it('reports an engine failure without throwing', async () => {
    stub();
    vi.spyOn(DebtOsEngine, 'schedule').mockRejectedValue(new Error('bonds table missing'));
    const s = await debtServiceSnapshot();
    expect(s.schedule).toEqual({ error: 'bonds table missing' });
    expect(s.coverage.couponCovered).toBe(false);
  });
});

describe('ppbDebtServiceWire CLI', () => {
  it('parses read-only, plan and dry-run modes', () => {
    expect(wire.parseArgs([])).toMatchObject({ plan: false, dryRun: false, horizonDays: 90 });
    expect(wire.parseArgs(['--plan', '--dry-run', '--actor', 'op', '--horizon', '30', '--strict'])).toMatchObject({ plan: true, dryRun: true, actor: 'op', horizonDays: 30, strict: true });
    expect(() => wire.parseArgs(['--plan'])).toThrow(/--actor/);
    expect(() => wire.parseArgs(['--dry-run'])).toThrow(/only applies to --plan/);
    expect(() => wire.parseArgs(['--horizon', '0'])).toThrow(/positive whole number/);
    expect(() => wire.parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('plans through Fixed Income Distribution OS and exits 2 under --strict when not covered', async () => {
    stub({ couponDue: 6000000 });
    const plan = vi.spyOn(FixedIncomeDistributionEngine, 'plan').mockResolvedValue({ dryRun: true, sources: 1, planned: 1, totalUsd: 2500, entries: [] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await wire.main(['--plan', '--dry-run', '--actor', 'op', '--json', '--strict'])).toBe(2);
    expect(plan).toHaveBeenCalledWith({ createdBy: 'op', dryRun: true });
    const out = JSON.parse(log.mock.calls[0][0]);
    expect(out.plan).toEqual({ dryRun: true, sources: 1, planned: 1, totalUsd: 2500 });
    expect((out as Row).coverage.couponCovered).toBe(false);
  });

  it('is read-only by default', async () => {
    stub();
    const plan = vi.spyOn(FixedIncomeDistributionEngine, 'plan');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await wire.main([])).toBe(0);
    expect(plan).not.toHaveBeenCalled();
  });
});

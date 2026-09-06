import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { FixedIncomeDataService, sumPositions } = require('../server/integrations/bonds/fixedIncomeDataService');
const { LiveBondEngine } = require('../server/integrations/bonds/liveEngine');
const { TrusteeAgent } = require('../server/integrations/agents/trusteeAgent');
const { AttestationOsEngine } = require('../server/integrations/os/attestationOsEngine');
const pool = require('../server/integrations/bonds/pgPool');
// Loaded eagerly so the platform readiness probes do not pull viem in mid-run.
require('../server/integrations/dapp/bondTokenizationEngine');
require('../server/integrations/dapp/thirdwebServerWalletEngine');

type Row = Record<string, any>;

// A $100M issue with $20M paid down and $500 accrued, plus a Treasury with no
// bond_balances row yet (COALESCE falls back to face value), plus a matured bond.
const BOND_ROWS: Row[] = [
  {
    id: 1, bond_name: 'DLB-PRB', isin: 'US-DLB-PRB-2024', bond_identifier: 'DLB-PRB', issuer: 'DLB Trust',
    currency: 'USD', status: 'active', coupon_rate: '0.01', issue_date: '2024-02-28', maturity_date: '2124-02-28',
    face_value: '100000000.00', principal_balance: '80000000.00', accrued_interest: '500.00',
    total_interest_paid: '1000.00', total_principal_paid: '20000000.00',
  },
  {
    id: 2, bond_name: 'UST 2030', isin: 'US912810TM09', bond_identifier: 'UST-2030', issuer: 'United States Treasury',
    currency: 'USD', status: 'active', coupon_rate: '0.04', issue_date: '2020-01-01', maturity_date: '2030-01-01',
    face_value: '250000.00', principal_balance: '250000.00', accrued_interest: '0',
    total_interest_paid: '0', total_principal_paid: '0',
  },
];

const TOKEN_ROWS: Row[] = [
  { id: 'tok-1', bond_id: 1, token_name: 'DLB-PRB Token', token_symbol: 'DLBPRB', token_address: '0xabc', total_supply: '40000000', tokenized_principal: '40000000', tokenized_interest: '0', status: 'active' },
  { id: 'tok-2', bond_id: 1, token_name: 'Shadow', token_symbol: 'SHDW', token_address: 'shadow-1', total_supply: '1', tokenized_principal: '1', tokenized_interest: '0', status: 'shadow' },
  { id: 'tok-3', bond_id: null, token_name: 'Unbacked', token_symbol: 'UNB', token_address: null, total_supply: '0', tokenized_principal: '0', tokenized_interest: '0', status: 'draft' },
];

function mockPool({ bondTokens = true }: { bondTokens?: boolean } = {}) {
  const query = vi.fn(async (text: string, params: any[] = []) => {
    if (/FROM bond_tokens/.test(text)) {
      if (!bondTokens) throw new Error('relation "bond_tokens" does not exist');
      return { rows: TOKEN_ROWS };
    }
    if (/FROM bonds b/.test(text)) {
      if (/WHERE b\.id = \$1/.test(text)) return { rows: BOND_ROWS.filter((b) => b.id === params[0]) };
      if (/WHERE COALESCE\(b\.status/.test(text)) return { rows: BOND_ROWS.filter((b) => b.status === params[0]) };
      return { rows: BOND_ROWS };
    }
    if (/FROM trust_accounts WHERE account_code = '3000'/.test(text)) return { rows: [{ balance: '90000000' }] };
    return { rows: [] };
  });
  vi.spyOn(pool, 'query').mockImplementation(query as any);
  return query;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FixedIncomeDataService', () => {
  it('normalizes positions to principal + accrued and totals them consistently', async () => {
    mockPool();
    const positions = await FixedIncomeDataService.listPositions();
    expect(positions).toHaveLength(2);
    expect(positions[0]).toMatchObject({
      id: 1, face_value: 100000000, principal_balance: 80000000, accrued_interest: 500, current_value: 80000500,
    });
    expect(positions[1].current_value).toBe(250000);

    const totals = await FixedIncomeDataService.getPortfolioTotals();
    expect(totals).toMatchObject({
      count: 2,
      total_face_value: 100250000,
      total_principal_balance: 80250000,
      total_accrued_interest: 500,
      total_current_value: 80250500,
    });
    expect(sumPositions(positions).total_current_value).toBe(totals.total_current_value);
  });

  it('resolves a position by id or by name/isin/identifier', async () => {
    const query = mockPool();
    expect((await FixedIncomeDataService.getPosition(1)).bond_name).toBe('DLB-PRB');
    await FixedIncomeDataService.getPosition('DLB-PRB');
    const byRef = query.mock.calls.find((c) => /b\.bond_name = \$1 OR b\.isin = \$1/.test(c[0]));
    expect(byRef?.[1]).toEqual(['DLB-PRB']);
  });

  it('builds a unified snapshot joining ledger, live metrics, tokenization and platforms', async () => {
    mockPool();
    vi.spyOn(LiveBondEngine, 'getPortfolioSnapshot').mockResolvedValue({
      bond_count: 2,
      total_market_value: 79000000,
      total_accrued_interest: 500,
      total_current_value: 79000500,
      total_daily_accrual: 2222.22,
      total_annual_income: 800000,
      weighted_avg_coupon_pct: 1.01,
      weighted_avg_ytm_pct: 1.5,
      weighted_avg_modified_duration: 40.1,
      total_dv01: 3000,
      bonds: [
        { bond_id: 1, face_value: 100000000, market_value: 78750000 },
        { bond_id: 2, face_value: 250000, market_value: 250000 },
      ],
      generated_at: '2026-09-06T00:00:00.000Z',
    });

    const snap = await FixedIncomeDataService.getUnifiedSnapshot();
    expect(snap.source_of_truth).toBe('postgres:bonds+bond_balances');
    expect(snap.totals.total_current_value).toBe(80250500);
    expect(snap.live.total_market_value).toBe(79000000);
    expect(snap.bonds[0].live.market_value).toBe(78750000);
    expect(snap.bonds[0].tokenization).toMatchObject({
      tokenized_principal: 40000001,
      untokenized_principal: 39999999,
      coverage_pct: 50,
    });
    expect(snap.bonds[0].tokenization.tokens.map((t: Row) => t.on_chain)).toEqual([true, false]);
    expect(snap.bonds[1].tokenization).toBeNull();
    expect(snap.tokenization).toMatchObject({ available: true, tokens: 3, total_tokenized_principal: 40000001 });
    expect(snap.tokenization.coverage_pct).toBeCloseTo(49.84, 2);
    expect(snap.discrepancies).toEqual([]);
    expect(snap.platforms.dlbtrust.ok).toBe(true);
    expect(snap.platforms.thirdweb).toHaveProperty('ready');
    expect(snap.platforms.tokenization).toHaveProperty('ready');
    expect(snap.platforms.northflank).toHaveProperty('deployed');
  });

  it('flags tokenized supply that exceeds ledger principal and live/ledger face drift', async () => {
    mockPool();
    vi.spyOn(LiveBondEngine, 'getPortfolioSnapshot').mockResolvedValue({
      bonds: [{ bond_id: 2, face_value: 300000, market_value: 300000 }],
    });
    vi.spyOn(FixedIncomeDataService, 'getTokenization').mockResolvedValue({
      available: true, tokens: 1,
      by_bond: { '1': { tokens: [], tokenized_principal: 90000000, tokenized_interest: 0, total_supply: 90000000 } },
    });
    const snap = await FixedIncomeDataService.getUnifiedSnapshot();
    expect(snap.discrepancies.map((d: Row) => d.type).sort()).toEqual(['live_face_value_mismatch', 'tokenized_exceeds_principal']);
  });

  it('degrades gracefully when tokenization or live engines are unavailable', async () => {
    mockPool({ bondTokens: false });
    vi.spyOn(LiveBondEngine, 'getPortfolioSnapshot').mockRejectedValue(new Error('live engine offline'));
    const snap = await FixedIncomeDataService.getUnifiedSnapshot();
    expect(snap.tokenization.available).toBe(false);
    expect(snap.tokenization.reason).toMatch(/bond_tokens/);
    expect(snap.live).toEqual({ error: 'live engine offline' });
    expect(snap.bonds[0].live).toBeNull();
    expect(snap.totals.count).toBe(2);
  });

  it('reports Northflank as deployed from its project/service env', async () => {
    process.env.NORTHFLANK_PROJECT_ID = 'proj-1';
    try {
      const platforms = FixedIncomeDataService.platformStatus();
      expect(platforms.northflank).toMatchObject({ deployed: true, project_id: 'proj-1' });
    } finally {
      delete process.env.NORTHFLANK_PROJECT_ID;
    }
    expect(FixedIncomeDataService.platformStatus().northflank.deployed).toBe(false);
  });
});

describe('consumers read through the canonical service', () => {
  it('TrusteeAgent asset review reports outstanding principal instead of a missing column', async () => {
    mockPool();
    const review = await TrusteeAgent.runAssetReview();
    expect(review.summary.bonds).toMatchObject({
      count: 2,
      totalFaceValue: 100250000,
      totalOutstanding: 80250000,
      totalAccrued: 500,
      totalCurrentValue: 80250500,
    });
  });

  it('TrusteeAgent corpus integrity compares corpus to current value, not face value', async () => {
    mockPool();
    const review = await TrusteeAgent.runComplianceCheck();
    const corpus = review.checks.find((c: Row) => c.check === 'corpus_integrity');
    expect(corpus.passed).toBe(true);
    expect(corpus.detail).toContain('80,250,500');
  });

  it('AttestationOs claims the bond ledger with principal + accrued from the joined balances', async () => {
    mockPool();
    const claims = await AttestationOsEngine._claimBondLedger();
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ domain: 'fixed_income', sourceKey: 'DLB-PRB', balanceCents: 8000050000 });
    expect(claims[0].detail).toMatchObject({ principalCents: 8000000000, interestCents: 50000 });
  });
});

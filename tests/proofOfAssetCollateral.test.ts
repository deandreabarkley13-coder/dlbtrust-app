import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const pool = require('../server/integrations/bonds/pgPool');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const { LiveBondEngine } = require('../server/integrations/bonds/liveEngine');
const { FixedIncomeDistributionEngine } = require('../server/integrations/os/fixedIncomeDistributionEngine');
const { BankSettlementEngine } = require('../server/integrations/payments/bankSettlementEngine');
const { AttestationOsEngine } = require('../server/integrations/os/attestationOsEngine');
const { CollateralOsEngine } = require('../server/integrations/os/collateralOsEngine');
const { ProofOfAssetOsEngine } = require('../server/integrations/os/proofOfAssetOsEngine');

type Row = Record<string, any>;

const HELD = 7709589.04;

function world() {
  const bonds: Row[] = [{ id: 1, bond_name: 'DLB-PRB', face_value: 100000000, coupon_rate: 1, payment_freq: 'semi-annual', issue_date: '2024-02-28', maturity_date: '2124-02-28', status: 'active', placement_type: 'private' }];
  const issuances: Row[] = [{ bond_id: 1, issuer_external_id: 'issuer:dlb-trust-company', holder_external_id: 'holder:dlb-irrevocable-trust', status: 'issued', issued_by: 'admin', issued_at: '2026-09-23' }];
  const parties: Row[] = [
    { role: 'issuer', fineract_client_id: 1, fineract_account_id: 1, fineract_account_no: '000000001' },
    { role: 'holder', fineract_client_id: 2, fineract_account_id: 2, fineract_account_no: '000000002' },
  ];
  const payments: Row[] = [
    { payment_id: 'BIP-C', bond_id: 1, kind: 'coupon', period_date: '2026-09-23', amount_usd: 2569863.01, status: 'held', fineract_withdrawal_id: '2', fineract_deposit_id: '3', holder_entry_id: 'JE-C', issuer_entry_ids: ['JE-A', 'JE-B'] },
    { payment_id: 'BIP-P', bond_id: 1, kind: 'principal', period_date: '2026-09-23', amount_usd: 5139726.03, status: 'held', fineract_withdrawal_id: '4', fineract_deposit_id: '5', holder_entry_id: null, issuer_entry_ids: [] },
  ];
  const journal: Row[] = [
    { entry_id: 'JE-C', status: 'posted', reference_id: 'BIP-C', account_code: '1020', debit_amount: 2569863.01, credit_amount: 0 },
    { entry_id: 'JE-C', status: 'posted', reference_id: 'BIP-C', account_code: '4100', debit_amount: 0, credit_amount: 2569863.01 },
  ];
  const proofs: Row[] = [];
  const fineract: Record<number, number> = { 1: 0, 2: HELD };

  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    if (/^SELECT b\.id, b\.bond_name/.test(text)) {
      const b = bonds.find((x) => x.id === params[0]); if (!b) return { rows: [] };
      const i = issuances.find((x) => x.bond_id === b.id) || {};
      return { rows: [{ ...b, bond_status: b.status, issuer_external_id: i.issuer_external_id, holder_external_id: i.holder_external_id, issuance_status: i.status, issued_by: i.issued_by, issued_at: i.issued_at }] };
    }
    if (/FROM bond_issuances/.test(text) && /bond_id/.test(text) && !/bond_issuance_payments/.test(text)) return { rows: issuances.map((i) => ({ bond_id: i.bond_id })) };
    if (/FROM bond_issuance_parties/.test(text)) return { rows: parties };
    if (/FROM bond_issuance_payments/.test(text)) return { rows: params.length ? payments.filter((p) => p.bond_id === params[0]) : payments };
    if (/FROM trust_journal_entries je JOIN trust_journal_lines/.test(text)) return { rows: journal.filter((j) => params[0].includes(j.entry_id)) };
    if (/^SELECT hash FROM proof_of_asset_proofs/.test(text)) return { rows: proofs.length ? [{ hash: proofs[proofs.length - 1].hash }] : [] };
    if (/^INSERT INTO proof_of_asset_proofs/.test(text)) {
      const row = { proof_id: params[0], scope: params[1], bond_id: params[2], as_of: params[3], verdict: params[4], contract_value_cents: params[5], record_of_value_cents: params[6], fineract_held_cents: params[7], fiat_settled_cents: params[8], custody_attested_cents: params[9], hash: params[10], previous_hash: params[11], evidence: params[12], created_by: params[13], created_at: new Date(Date.now() + proofs.length) };
      proofs.push(row); return { rows: [row] };
    }
    if (/^SELECT \* FROM proof_of_asset_proofs WHERE scope = 'portfolio'/.test(text)) return { rows: proofs.filter((p) => p.scope === 'portfolio').slice(-1) };
    if (/^SELECT verdict, COUNT/.test(text)) return { rows: [] };
    throw new Error('unexpected sql: ' + text.slice(0, 90));
  });
  return { bonds, payments, journal, proofs, fineract, query };
}

const POSITION = {
  positionId: 'CP-1', tokenSymbol: 'DLB-PRB-T', status: 'pledged', valueUsd: 1000000, advanceRateBps: 5000, spendableUsd: 500000,
  priceSource: 'fineract', verification: 'attested', valuedAt: '2026-09-23T00:00:00Z', metadata: { bondId: 1 },
};
const FACILITY = {
  positions: 1, collateralUsd: 1000000, spendableUsd: 500000, drawnUsd: 100000, availableUsd: 400000, utilizationBps: 2000, maxUtilizationBps: 8000, marginCall: false,
  byPosition: [{ positionId: 'CP-1', tokenSymbol: 'DLB-PRB-T', status: 'pledged', valueUsd: 1000000, advanceRateBps: 5000, spendableUsd: 500000, drawnUsd: 100000 }],
  openDraws: 1,
};

describe('ProofOfAssetOsEngine <-> CollateralOsEngine', () => {
  let w: ReturnType<typeof world>;

  beforeEach(() => {
    process.env.PROOF_OF_ASSET_ENABLED = 'true';
    w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query as any);
    vi.spyOn(FineractClient, 'getAccountBalance').mockImplementation(async (id: any) => ({ id: Number(id), accountNo: `00000000${id}`, status: { active: true }, summary: { accountBalance: w.fineract[Number(id)] } }));
    vi.spyOn(LiveBondEngine, 'getBondLiveMetrics').mockResolvedValue({ principal_balance: 100000000, accrued_interest_total: 0, coupon_per_period: 492623.14, next_coupon_date: '2027-02-28', days_to_maturity: 35000 } as any);
    vi.spyOn(FixedIncomeDistributionEngine, 'list').mockResolvedValue([] as any);
    vi.spyOn(BankSettlementEngine, 'list').mockResolvedValue([] as any);
    vi.spyOn(AttestationOsEngine, 'snapshot').mockResolvedValue({ observedAt: 'now', attestedCents: 0, claimedCents: 770958904, sourcesObserved: 1, domains: [] } as any);
  });
  afterEach(() => vi.restoreAllMocks());

  function mockCollateral({ positions = [POSITION], facility = FACILITY, ready = true } = {}) {
    vi.spyOn(CollateralOsEngine, 'readiness').mockResolvedValue({ ready, issues: ready ? [] : ['COLLATERAL_OS_ENABLED=false'] } as any);
    vi.spyOn(CollateralOsEngine, 'facility').mockResolvedValue(facility as any);
    vi.spyOn(CollateralOsEngine, 'positions').mockResolvedValue(positions as any);
  }

  it('carries the pledged positions and facility as collateral evidence without adding to the record of value', async () => {
    mockCollateral();
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    expect(proof.verdict).toBe('proven');
    expect(proof.recordOfValueCents).toBe(770958904);
    expect(proof.evidence.collateral).toMatchObject({ available: true, ready: true, pledgedCents: 100000000, spendableCents: 50000000, drawnCents: 10000000, positions: 1, marginCall: false });
    expect(proof.evidence.collateralDetail.positions[0]).toMatchObject({ positionId: 'CP-1', bondId: 1, valueCents: 100000000, drawnCents: 10000000 });
    const names = proof.evidence.recordOfValue.checks.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(['collateral_pledged_within_record', 'collateral_draws_within_borrowing_base']));
    expect(proof.evidence.recordOfValue.checks.every((c: any) => c.verdict === 'proven')).toBe(true);
  });

  it('scopes positions to the bond via metadata.bondId and adds no collateral checks when none match', async () => {
    mockCollateral({ positions: [{ ...POSITION, positionId: 'CP-9', metadata: { bondId: 9 } }] });
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    expect(proof.evidence.collateral.positions).toBe(0);
    expect(proof.evidence.collateral.pledgedCents).toBe(0);
    expect(proof.evidence.recordOfValue.checks.map((c: any) => c.name)).not.toContain('collateral_pledged_within_record');
    expect(proof.verdict).toBe('proven');
  });

  it('flags variance when the pledged value exceeds both the record and the contract', async () => {
    mockCollateral({ positions: [{ ...POSITION, valueUsd: 250000000, spendableUsd: 125000000 }] });
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    expect(proof.verdict).toBe('variance');
    const c = proof.evidence.recordOfValue.checks.find((x: any) => x.name === 'collateral_pledged_within_record');
    expect(c.verdict).toBe('variance');
    expect(c.actualCents).toBe(25000000000);
  });

  it('flags variance on a Collateral OS margin call', async () => {
    mockCollateral({ facility: { ...FACILITY, drawnUsd: 490000, utilizationBps: 9800, marginCall: true } });
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    expect(proof.verdict).toBe('variance');
    const c = proof.evidence.recordOfValue.checks.find((x: any) => x.name === 'collateral_draws_within_borrowing_base');
    expect(c.verdict).toBe('variance');
    expect(c.note).toMatch(/margin call/);
  });

  it('reports collateral unavailable (not zero) when Collateral OS cannot be read, and keeps the record verdict', async () => {
    vi.spyOn(CollateralOsEngine, 'readiness').mockRejectedValue(new Error('collateral db down'));
    vi.spyOn(CollateralOsEngine, 'facility').mockRejectedValue(new Error('collateral db down'));
    vi.spyOn(CollateralOsEngine, 'positions').mockRejectedValue(new Error('collateral db down'));
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    expect(proof.verdict).toBe('proven');
    expect(proof.evidence.collateral).toMatchObject({ available: false, pledgedCents: null, positions: null });
    expect(proof.evidence.collateralDetail.error).toMatch(/collateral db down/);
  });

  it('lists the collateral layer in readiness', async () => {
    mockCollateral();
    const r = await ProofOfAssetOsEngine.status();
    expect(r.layers.some((l: string) => /^collateral/.test(l))).toBe(true);
  });
});

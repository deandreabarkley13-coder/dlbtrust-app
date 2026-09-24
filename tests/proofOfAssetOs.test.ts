import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const pool = require('../server/integrations/bonds/pgPool');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const { LiveBondEngine } = require('../server/integrations/bonds/liveEngine');
const { FixedIncomeDistributionEngine } = require('../server/integrations/os/fixedIncomeDistributionEngine');
const { BankSettlementEngine } = require('../server/integrations/payments/bankSettlementEngine');
const { AttestationOsEngine } = require('../server/integrations/os/attestationOsEngine');
const { ProofOfAssetOsEngine } = require('../server/integrations/os/proofOfAssetOsEngine');

type Row = Record<string, any>;

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
  const fineract: Record<number, number> = { 1: 0, 2: 7709589.04 };

  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    if (/^SELECT b\.id, b\.bond_name/.test(text)) {
      const b = bonds.find((x) => x.id === params[0]); if (!b) return { rows: [] };
      const i = issuances.find((x) => x.bond_id === b.id) || {};
      return { rows: [{ ...b, bond_status: b.status, issuer_external_id: i.issuer_external_id, holder_external_id: i.holder_external_id, issuance_status: i.status, issued_by: i.issued_by, issued_at: i.issued_at }] };
    }
    if (/^SELECT bond_id FROM bond_issuances/.test(text)) return { rows: issuances };
    if (/FROM bond_issuance_payments/.test(text)) return { rows: params.length ? payments.filter((p) => p.bond_id === params[0]) : payments };
    if (/FROM bond_issuance_parties/.test(text)) return { rows: parties };
    if (/FROM trust_journal_entries je JOIN trust_journal_lines/.test(text)) return { rows: journal.filter((j) => params[0].includes(j.entry_id)) };
    if (/^SELECT hash FROM proof_of_asset_proofs/.test(text)) return { rows: proofs.length ? [{ hash: proofs[proofs.length - 1].hash }] : [] };
    if (/^INSERT INTO proof_of_asset_proofs/.test(text)) {
      const row = { proof_id: params[0], scope: params[1], bond_id: params[2], as_of: params[3], verdict: params[4], contract_value_cents: params[5], record_of_value_cents: params[6], fineract_held_cents: params[7], fiat_settled_cents: params[8], custody_attested_cents: params[9], hash: params[10], previous_hash: params[11], evidence: params[12], created_by: params[13], created_at: new Date(Date.now() + proofs.length) };
      proofs.push(row); return { rows: [row] };
    }
    if (/^SELECT \* FROM proof_of_asset_proofs WHERE proof_id/.test(text)) return { rows: proofs.filter((p) => p.proof_id === params[0]) };
    if (/^SELECT \* FROM proof_of_asset_proofs WHERE scope = 'portfolio'/.test(text)) return { rows: proofs.filter((p) => p.scope === 'portfolio').slice(-1) };
    if (/^SELECT \* FROM proof_of_asset_proofs WHERE bond_id/.test(text)) return { rows: proofs.filter((p) => p.bond_id === params[0]).slice(-1) };
    if (/^SELECT \* FROM proof_of_asset_proofs ORDER BY created_at ASC/.test(text)) return { rows: proofs.slice() };
    if (/^SELECT \* FROM proof_of_asset_proofs/.test(text)) return { rows: proofs.slice().reverse() };
    if (/^UPDATE proof_of_asset_proofs SET certified_by/.test(text)) { const p = proofs.find((x) => x.proof_id === params[0])!; Object.assign(p, { certified_by: params[1], certified_at: params[2], certification_signature: params[3] }); return { rows: [p] }; }
    if (/^SELECT verdict, COUNT/.test(text)) return { rows: [] };
    throw new Error('unexpected sql: ' + text.slice(0, 90));
  });
  return { bonds, payments, journal, proofs, fineract, query };
}

describe('ProofOfAssetOsEngine — private placement bond proven across contract, Fineract, GL, fiat, custody', () => {
  let w: ReturnType<typeof world>;

  beforeEach(() => {
    process.env.PROOF_OF_ASSET_ENABLED = 'true';
    w = world();
    vi.spyOn(pool, 'query').mockImplementation(w.query as any);
    vi.spyOn(FineractClient, 'getAccountBalance').mockImplementation(async (id: any) => ({ id: Number(id), accountNo: `00000000${id}`, status: { active: true }, summary: { accountBalance: w.fineract[Number(id)] } }));
    vi.spyOn(LiveBondEngine, 'getBondLiveMetrics').mockResolvedValue({ principal_balance: 100000000, accrued_interest_total: 0, coupon_per_period: 492623.14, next_coupon_date: '2027-02-28', days_to_maturity: 35000 } as any);
    vi.spyOn(FixedIncomeDistributionEngine, 'list').mockResolvedValue([] as any);
    vi.spyOn(BankSettlementEngine, 'list').mockResolvedValue([] as any);
    vi.spyOn(AttestationOsEngine, 'snapshot').mockResolvedValue({ observedAt: 'now', attestedCents: 29, claimedCents: 770958904, sourcesObserved: 3, domains: [{ domain: 'fixed_income', claimedCents: 770958904, attestedCents: 0 }] } as any);
  });
  afterEach(() => vi.restoreAllMocks());

  it('proves the bond when Fineract covers the held P&I and the GL agrees', async () => {
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1, createdBy: 'ops' });
    expect(proof.verdict).toBe('proven');
    expect(proof.scope).toBe('bond');
    expect(proof.contractValueCents).toBe(10000000000);
    expect(proof.recordOfValueCents).toBe(770958904);
    expect(proof.fineractHeldCents).toBe(770958904);
    expect(proof.fiatSettledCents).toBe(0);
    expect(proof.custodyAttestedCents).toBe(29);
    expect(proof.previousHash).toBeNull();
    expect(proof.hash).toMatch(/^[0-9a-f]{64}$/);
    const names = proof.evidence.recordOfValue.checks.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining(['issued:1', 'fineract_deposit_ids', 'fineract_holder_covers_held', 'ledger_holder_cash_matches_coupons']));
    expect(proof.evidence.fiatCustody.settledCents).toBe(0);
  });

  it('reports variance when the holder Fineract balance does not cover the held value', async () => {
    w.fineract[2] = 1000;
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    expect(proof.verdict).toBe('variance');
    const c = proof.evidence.recordOfValue.checks.find((x: any) => x.name === 'fineract_holder_covers_held');
    expect(c.verdict).toBe('variance');
    expect(c.varianceCents).toBe(100000 - 770958904);
  });

  it('reports variance when the holder journal is missing or does not match', async () => {
    w.journal.splice(0, w.journal.length);
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    expect(proof.verdict).toBe('variance');
    const c = proof.evidence.recordOfValue.checks.find((x: any) => x.name === 'ledger_holder_cash_matches_coupons');
    expect(c.note).toContain('JE-C');
  });

  it('is unproven, never zero, when Fineract cannot be read', async () => {
    (FineractClient.getAccountBalance as any).mockRejectedValue(new Error('fineract down'));
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    expect(proof.verdict).toBe('unproven');
    expect(proof.fineractHeldCents).toBeNull();
  });

  it('checks fiat settlement only for payments explicitly sent to bank', async () => {
    w.payments[0].status = 'sent_to_bank';
    (BankSettlementEngine.list as any).mockResolvedValue([{ settlementId: 'SBS-1', bankId: 'lili', rail: 'ach', status: 'failed', live: true, amountCents: 100, reference: 'BIP-C' }]);
    const proof = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    const c = proof.evidence.recordOfValue.checks.find((x: any) => x.name === 'fiat_settled_for_sent_to_bank');
    expect(c.verdict).toBe('variance');
    expect(c.expectedCents).toBe(256986301);
    expect(c.actualCents).toBe(0);
    expect(proof.evidence.fiat.settlements).toHaveLength(1);
  });

  it('chains proofs by hash, verifies the chain, and certifies only proven proofs', async () => {
    const all = await ProofOfAssetOsEngine.proveAll({ createdBy: 'scheduler' });
    expect(all.map((p: any) => p.scope)).toEqual(['bond', 'portfolio']);
    expect(all[1].previousHash).toBe(all[0].hash);
    expect(await ProofOfAssetOsEngine.verifyChain()).toMatchObject({ valid: true, proofs: 2, headHash: all[1].hash });

    const certified = await ProofOfAssetOsEngine.certify(all[1].proofId, { certifiedBy: 'trustee@dlb.trust', signerName: 'Trustee' });
    expect(certified.certifiedBy).toBe('Trustee <trustee@dlb.trust>');
    expect(certified.certificationSignature).toMatch(/^[0-9a-f]{64}$/);
    await expect(ProofOfAssetOsEngine.certify(all[1].proofId, { certifiedBy: 'x' })).rejects.toMatchObject({ code: 'ALREADY_CERTIFIED' });

    w.fineract[2] = 0;
    const bad = await ProofOfAssetOsEngine.prove({ bondId: 1 });
    await expect(ProofOfAssetOsEngine.certify(bad.proofId, { certifiedBy: 'x' })).rejects.toMatchObject({ code: 'NOT_PROVEN' });

    w.proofs[0].evidence = JSON.stringify({ tampered: true });
    expect(await ProofOfAssetOsEngine.verifyChain()).toMatchObject({ valid: false, brokenAt: all[0].proofId });
  });

  it('status surfaces the latest portfolio proof and readiness', async () => {
    let s = await ProofOfAssetOsEngine.status();
    expect(s.ready).toBe(false);
    expect(s.issues[0]).toContain('no portfolio proof');
    await ProofOfAssetOsEngine.prove({});
    s = await ProofOfAssetOsEngine.status();
    expect(s.ready).toBe(true);
    expect(s.latest.verdict).toBe('proven');
  });
});

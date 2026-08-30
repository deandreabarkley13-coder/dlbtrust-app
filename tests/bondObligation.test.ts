import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { BondObligationEngine } = require('../server/integrations/finops/bondObligationEngine');
const { PrincipalIncomeEngine } = require('../server/integrations/drawdown/principalIncomeEngine');
const { SeriesOsEngine } = require('../server/integrations/series/seriesOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

const CHECKER = 'deandreabarkley13@gmail.com';
const TRUST_NAMES = [
  'deandrea lavar barkley trust',
  'deandrea lavar barkley trust company',
  'dlb trust',
];

const SERIES = {
  series_id: 'SER-1',
  series_code: 'S-BEN-01',
  series_name: 'Beneficiary Series 01',
  purpose: 'beneficiary_support',
  beneficiary_ref: 'BEN-1',
  ring_fenced: true,
  status: 'active',
};

interface FakeState {
  bonds: Row[];
  subscriptions: Row[];
  contacts: Row[];
  capacities: Row[];
  movements: Row[];
  entries: Row[];
  events: Row[];
}

function baseState(): FakeState {
  return {
    // The trust's own $100M private placement, and a purchased Treasury.
    bonds: [
      {
        id: 1,
        bond_name: 'DLB Private Placement Bond',
        isin: null,
        bond_identifier: 'DLB-PRB',
        issuer: 'DeAndrea Lavar Barkley Trust',
        face_value: 100000000,
        principal_balance: 100000000,
        accrued_interest: 0,
      },
      {
        id: 2,
        bond_name: 'UST 2030',
        isin: 'US912810TM09',
        bond_identifier: 'UST-2030',
        issuer: 'United States Treasury',
        face_value: 250000,
        principal_balance: 250000,
        accrued_interest: 0,
      },
    ],
    subscriptions: [
      {
        subscription_id: 'SUB-DLB-PRB-001',
        contact_id: 'CRM-INV-001',
        bond_id: 1,
        subscription_amount: 100000000,
        offering_price: 1,
        settlement_date: '2024-02-28',
        status: 'active',
        cash_account_id: 'CA-BOND-PROCEEDS',
        notes: null,
      },
    ],
    contacts: [
      {
        contact_id: 'CRM-INV-001',
        first_name: 'DeAndrea',
        last_name: 'Barkley',
        company: 'DLB Trust',
        contact_type: 'investor',
        status: 'active',
      },
    ],
    capacities: [],
    movements: [],
    entries: [],
    events: [],
  };
}

function fakeDb(state: FakeState) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/i.test(text)) return { rows: [] };

    // ── bond_holder_capacity ─────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO bond_holder_capacity')) {
      const row = {
        subscription_id: params[0],
        capacity: params[1],
        holder_name: params[2],
        administered_by: params[3],
        evidence_reference: params[4],
        memo: params[5],
        recorded_by: params[6],
      };
      const existing = state.capacities.findIndex((c) => c.subscription_id === row.subscription_id);
      if (existing >= 0) state.capacities[existing] = row;
      else state.capacities.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM bond_holder_capacity')) return { rows: state.capacities };

    // ── subscriptions & contacts ─────────────────────────────────────────────
    if (text.includes('FROM crm_bond_subscriptions s') && text.includes('WHERE s.bond_id = $1')) {
      const rows = state.subscriptions
        .filter((s) => s.bond_id === params[0] && ['active', 'pending'].includes(s.status))
        .map((s) => ({ ...s, ...state.contacts.find((c) => c.contact_id === s.contact_id), ...s }));
      return { rows };
    }
    if (text.includes('FROM crm_bond_subscriptions s') && text.includes('LOWER(s.subscription_id)')) {
      const sub = state.subscriptions.find(
        (s) => s.subscription_id.toLowerCase() === params[0]
      );
      if (!sub) return { rows: [] };
      const contact = state.contacts.find((c) => c.contact_id === sub.contact_id) || {};
      return { rows: [{ subscription_id: sub.subscription_id, ...contact }] };
    }

    // ── cash movements: only external arrivals pay a subscription ────────────
    if (text.includes('FROM cash_movements')) {
      const paid = state.movements
        .filter((m) => m.status === 'settled' && m.from_account_id === null)
        .filter((m) => (params.length > 1 ? m.to_account_id === params[0] : true))
        .filter((m) => (params.length > 1
          ? m.reference_id === params[1] || (params[2] as string[]).includes(m.movement_type)
          : m.reference_id === params[0]))
        .reduce((sum, m) => sum + Number(m.amount_cents), 0);
      return { rows: [{ paid }] };
    }

    // ── bonds ────────────────────────────────────────────────────────────────
    if (text.includes('FROM bonds b') && text.includes('LOWER(COALESCE(b.isin')) {
      const row = state.bonds.find((b) => [b.isin, b.bond_identifier, b.bond_name]
        .filter(Boolean)
        .some((k) => String(k).toLowerCase() === params[0]));
      return { rows: row ? [row] : [] };
    }
    if (text.includes('FROM bonds b')) return { rows: state.bonds };

    // ── principal & income ledger ────────────────────────────────────────────
    if (text.startsWith('INSERT INTO pi_entries')) {
      const row = {
        entry_id: params[0], series_id: params[1], allocation: params[2], entry_type: params[3],
        basis: params[4], source_kind: params[5], source_ref: params[6], amount_cents: params[7],
        distributable: params[8], non_distributable_reason: params[9],
      };
      state.entries.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM pi_entries WHERE series_id')) {
      const grouped = new Map<string, Row>();
      for (const e of state.entries.filter((x) => x.series_id === params[0])) {
        const key = [e.allocation, e.entry_type, e.basis, e.distributable].join('|');
        const bucket = grouped.get(key)
          || { allocation: e.allocation, entry_type: e.entry_type, basis: e.basis, distributable: e.distributable, total: 0 };
        bucket.total += Number(e.amount_cents);
        grouped.set(key, bucket);
      }
      return { rows: [...grouped.values()] };
    }
    if (text.startsWith('INSERT INTO pi_events')) {
      state.events.push({ event_id: params[0], event_hash: params[7] });
      return { rows: [state.events[state.events.length - 1]] };
    }

    return { rows: [] };
  });
}

/** An external arrival: money from outside the trust's own cash accounts. */
function externalDeposit(state: FakeState, amountCents: number, overrides: Row = {}) {
  state.movements.push({
    movement_id: `MOV-${state.movements.length + 1}`,
    from_account_id: null,
    to_account_id: 'CA-BOND-PROCEEDS',
    amount_cents: amountCents,
    movement_type: 'bond_proceeds',
    reference_id: 'SUB-DLB-PRB-001',
    status: 'settled',
    ...overrides,
  });
}

async function assessDlbPrb(state: FakeState) {
  return BondObligationEngine.assess({
    bondId: 1,
    issuer: 'DeAndrea Lavar Barkley Trust',
    carryingCents: 10000000000,
    trustNames: TRUST_NAMES,
  });
}

describe('bond holder & obligation engine', () => {
  let state: FakeState;

  beforeEach(() => {
    state = baseState();
    vi.spyOn(pool, 'query').mockImplementation(fakeDb(state) as any);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('holder resolution', () => {
    it('treats a holder recorded under the trust’s own name as the trust holding its own paper', async () => {
      const assessment = await assessDlbPrb(state);
      expect(assessment.classification).toBe('self_issued_self_held');
      expect(assessment.holderKind).toBe('trust');
      expect(assessment.obligationCents).toBe(0);
    });

    it('makes the bond an obligation of the trust once the holder’s capacity is personal', async () => {
      await BondObligationEngine.declareCapacity({
        subscriptionId: 'SUB-DLB-PRB-001',
        capacity: 'personal',
        administeredBy: 'DLB Private Trust Company, as trustee and custodian',
        recordedBy: CHECKER,
      });

      const assessment = await assessDlbPrb(state);
      expect(assessment.classification).toBe('trust_obligation');
      expect(assessment.holderKind).toBe('external');
      expect(assessment.holders[0].holderName).toBe('DeAndrea Barkley');
      expect(assessment.holders[0].capacity).toBe('personal');
      expect(assessment.holders[0].administeredBy).toMatch(/trustee and custodian/);
      expect(assessment.couponsPayableToHolders).toBe(true);
      // The trust owes the carrying value; it does not own it.
      expect(assessment.obligation).toBe(100000000);
      expect(assessment.note).toMatch(/a liability of the trust, not trust corpus/);
    });

    it('classifies a bond issued by a third party as a trust asset', async () => {
      const assessment = await BondObligationEngine.assess({
        bondId: 2,
        issuer: 'United States Treasury',
        carryingCents: 25000000,
        trustNames: TRUST_NAMES,
      });
      expect(assessment.classification).toBe('third_party_asset');
      expect(assessment.obligationCents).toBe(0);
    });

    it('treats an unnamed issuer as the trust rather than an established third party', async () => {
      const assessment = await BondObligationEngine.assess({
        bondId: 2, issuer: null, carryingCents: 1000, trustNames: TRUST_NAMES,
      });
      expect(assessment.issuedByTrust).toBe(true);
    });

    it('refuses an unknown subscription and an invalid capacity', async () => {
      await expect(BondObligationEngine.declareCapacity({
        subscriptionId: 'SUB-NOPE', capacity: 'personal', recordedBy: CHECKER,
      })).rejects.toThrow(/not found/);

      await expect(BondObligationEngine.declareCapacity({
        subscriptionId: 'SUB-DLB-PRB-001', capacity: 'beneficial', recordedBy: CHECKER,
      })).rejects.toThrow(/capacity must be one of/);

      await expect(BondObligationEngine.declareCapacity({
        subscriptionId: 'SUB-DLB-PRB-001', capacity: 'personal', recordedBy: '',
      })).rejects.toThrow(/recordedBy is required/);
    });
  });

  describe('subscription funding', () => {
    beforeEach(async () => {
      await BondObligationEngine.declareCapacity({
        subscriptionId: 'SUB-DLB-PRB-001', capacity: 'personal', recordedBy: CHECKER,
      });
    });

    it('reports the whole $100,000,000 subscription as unpaid when no cash ever arrived', async () => {
      const assessment = await assessDlbPrb(state);
      expect(assessment.subscribed).toBe(100000000);
      expect(assessment.paidIn).toBe(0);
      expect(assessment.unpaidSubscription).toBe(100000000);
      // Nothing was paid in, so the instrument contributed no corpus at all.
      expect(assessment.corpus).toBe(0);
    });

    it('counts corpus only up to the cash the subscription actually settled', async () => {
      externalDeposit(state, 25000000); // $250,000 wired in by the holder
      const assessment = await assessDlbPrb(state);
      expect(assessment.paidIn).toBe(250000);
      expect(assessment.corpus).toBe(250000);
      expect(assessment.unpaidSubscription).toBe(100000000 - 250000);
    });

    it('does not count an internal transfer between trust accounts as payment', async () => {
      externalDeposit(state, 600000000, { from_account_id: 'CA-OPERATING' });
      const assessment = await assessDlbPrb(state);
      expect(assessment.paidIn).toBe(0);
      expect(assessment.corpus).toBe(0);
    });

    it('does not count an unsettled arrival as payment', async () => {
      externalDeposit(state, 600000000, { status: 'pending' });
      const assessment = await assessDlbPrb(state);
      expect(assessment.paidIn).toBe(0);
    });
  });

  describe('resolution by bond reference', () => {
    it('finds the instrument by identifier and reports its classification', async () => {
      await BondObligationEngine.declareCapacity({
        subscriptionId: 'SUB-DLB-PRB-001', capacity: 'personal', recordedBy: CHECKER,
      });
      const assessment = await BondObligationEngine.obligationFor('dlb-prb', TRUST_NAMES);
      expect(assessment.classification).toBe('trust_obligation');
      expect(assessment.obligation).toBe(100000000);
    });

    it('returns null for an unknown reference', async () => {
      expect(await BondObligationEngine.obligationFor('NOT-A-BOND', TRUST_NAMES)).toBeNull();
      expect(await BondObligationEngine.obligationFor('', TRUST_NAMES)).toBeNull();
    });
  });
});

describe('principal & income against a trust obligation', () => {
  let state: FakeState;
  const OBLIGATION_POSITION = {
    bondName: 'DLB Private Placement Bond',
    isin: null,
    bondIdentifier: 'DLB-PRB',
    selfIssued: true,
    selfHeld: false,
    holderKind: 'external',
    classification: 'trust_obligation',
    holders: [{ holderName: 'DeAndrea Barkley', holderKind: 'external', capacity: 'personal' }],
    custodyStatus: 'trust_obligation',
    carryingValueCents: 10000000000,
    obligationCents: 10000000000,
    obligation: 100000000,
    contributedCorpusCents: 25000000,
    eligibleCollateralCents: 0,
  };

  beforeEach(() => {
    state = baseState();
    process.env.PRINCIPAL_DRAWDOWN_RATE_BPS = '200';
    process.env.PRINCIPAL_DRAWDOWN_START = '2024-02-01';
    vi.spyOn(pool, 'query').mockImplementation(fakeDb(state) as any);
    vi.spyOn(SeriesOsEngine, 'getSeries').mockImplementation(async (ref: string) => (
      ref === SERIES.series_id || String(ref).toUpperCase() === SERIES.series_code ? { ...SERIES } : null
    ));
    vi.spyOn(SeriesOsEngine, 'balanceSheet').mockResolvedValue({
      seriesId: SERIES.series_id,
      seriesCode: SERIES.series_code,
      assets: [{
        assetKind: 'bond',
        assetRef: 'DLB-PRB',
        valueKind: 'internal_only',
        valueCents: OBLIGATION_POSITION.carryingValueCents,
      }],
      availableCents: 0,
      available: 0,
      spendableCents: 0,
      collateralCents: 0,
    });
    vi.spyOn(ReserveEngine, 'portfolio').mockResolvedValue({ positions: [OBLIGATION_POSITION] });
  });

  afterEach(() => vi.restoreAllMocks());

  it('refuses to post a coupon on the bond as a receipt, because the trust is the obligor', async () => {
    await expect(PrincipalIncomeEngine.recordEntry({
      seriesRef: 'S-BEN-01',
      sourceKind: 'bond_coupon',
      sourceRef: 'DLB-PRB',
      amountCents: 200000000,
      recordedBy: CHECKER,
    })).rejects.toThrow(/obligor on DLB-PRB and DeAndrea Barkley holds it/);
  });

  it('records the same coupon as an income disbursement the trust owes the holder', async () => {
    const entry = await PrincipalIncomeEngine.recordEntry({
      seriesRef: 'S-BEN-01',
      sourceKind: 'bond_coupon',
      entryType: 'disbursement',
      sourceRef: 'DLB-PRB',
      amountCents: 200000000,
      recordedBy: CHECKER,
    });
    expect(entry.entry_type).toBe('disbursement');
    expect(entry.allocation).toBe('income');
    expect(entry.distributable).toBe(false);
  });

  it('counts only paid-in subscription cash as corpus, not the $100,000,000 face value', async () => {
    const entitlement = await PrincipalIncomeEngine.entitlement('S-BEN-01');
    // $250,000 settled, so that is the corpus the allowance is written against.
    expect(entitlement.corpus).toBe(250000);
    expect(entitlement.obligationExcluded).toBe(100000000 - 250000);
    expect(entitlement.principal.allowance).toBe(5000 * entitlement.allowanceYears);
    expect(entitlement.obligationNote).toMatch(/obligation rather than corpus/);
  });

  it('still refuses to fund the allowance without attested cash', async () => {
    const entitlement = await PrincipalIncomeEngine.entitlement('S-BEN-01');
    expect(entitlement.principal.fundable).toBe(0);
    expect(entitlement.principal.unbacked).toBe(entitlement.principal.remaining);
  });
});

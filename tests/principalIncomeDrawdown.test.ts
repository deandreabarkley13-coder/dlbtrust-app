import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PrincipalIncomeEngine } = require('../server/integrations/drawdown/principalIncomeEngine');
const { SeriesOsEngine } = require('../server/integrations/series/seriesOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

const MAKER = 'AnnRobinson1117@gmail.com';
const CHECKER = 'deandreabarkley13@gmail.com';

const SERIES = {
  series_id: 'SER-1',
  series_code: 'S-BEN-01',
  series_name: 'Beneficiary Series 01',
  purpose: 'beneficiary_support',
  beneficiary_ref: 'BEN-1',
  ring_fenced: true,
  status: 'active',
};

/** The trust's own bond: corpus on the books, no attested cash behind it. */
const SELF_ISSUED_BOND = {
  bondName: 'DLB Private Placement Bond',
  isin: null,
  bondIdentifier: 'DLB-PRB',
  selfIssued: true,
  custodyStatus: 'self_issued_self_held',
  carryingValueCents: 10000000000,
  eligibleCollateralCents: 0,
};

interface FakeState {
  entries: Row[];
  drawdowns: Row[];
  events: Row[];
}

function fakeDb(state: FakeState) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/i.test(text)) return { rows: [] };

    // ── pi_entries ───────────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO pi_entries')) {
      const row = {
        entry_id: params[0],
        series_id: params[1],
        allocation: params[2],
        entry_type: params[3],
        basis: params[4],
        source_kind: params[5],
        source_ref: params[6],
        amount_cents: params[7],
        distributable: params[8],
        non_distributable_reason: params[9],
        drawdown_id: params[10],
        evidence_reference: params[11],
        memo: params[12],
        recorded_by: params[13],
        created_at: new Date().toISOString(),
      };
      state.entries.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM pi_entries WHERE series_id')) {
      // The grouped totals query.
      const grouped = new Map<string, Row>();
      for (const e of state.entries.filter((x) => x.series_id === params[0])) {
        const key = [e.allocation, e.entry_type, e.basis, e.distributable].join('|');
        const bucket = grouped.get(key) || {
          allocation: e.allocation,
          entry_type: e.entry_type,
          basis: e.basis,
          distributable: e.distributable,
          total: 0,
        };
        bucket.total += Number(e.amount_cents);
        grouped.set(key, bucket);
      }
      return { rows: [...grouped.values()] };
    }
    if (text.includes('FROM pi_entries')) {
      const rows = state.entries.filter(
        (e) => (!params[0] || e.series_id === params[0]) && (!params[1] || e.allocation === params[1])
      );
      return { rows: rows.slice().reverse() };
    }

    // ── pi_drawdowns ─────────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO pi_drawdowns')) {
      const row = {
        drawdown_id: params[0],
        series_id: params[1],
        allocation: params[2],
        requested_cents: params[3],
        entitlement_cents: params[4],
        purpose: params[5],
        beneficiary_ref: params[6],
        memo: params[7],
        required_signatures: params[8],
        proposed_by: params[9],
        funded_cents: 0,
        signatures: [],
        status: 'proposed',
        created_at: new Date(Date.now() + state.drawdowns.length).toISOString(),
      };
      state.drawdowns.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM pi_drawdowns WHERE drawdown_id')) {
      return { rows: state.drawdowns.filter((d) => d.drawdown_id === params[0]) };
    }
    if (text.includes('FROM pi_drawdowns WHERE series_id') && text.includes('GROUP BY allocation')) {
      const grouped = new Map<string, Row>();
      for (const d of state.drawdowns.filter((x) => x.series_id === params[0] && x.status !== 'cancelled')) {
        const bucket = grouped.get(d.allocation) || { allocation: d.allocation, committed: 0, funded: 0 };
        bucket.committed += Number(d.requested_cents);
        bucket.funded += Number(d.funded_cents);
        grouped.set(d.allocation, bucket);
      }
      return { rows: [...grouped.values()] };
    }
    if (text.includes('FROM pi_drawdowns')) {
      const rows = state.drawdowns.filter(
        (d) => (!params[0] || d.series_id === params[0]) && (!params[1] || d.status === params[1])
      );
      return { rows: rows.slice().reverse() };
    }
    if (text.startsWith('UPDATE pi_drawdowns')) {
      const row = state.drawdowns.find((d) => d.drawdown_id === params[0]);
      if (!row) return { rows: [] };
      if (text.includes('SET signatures')) {
        Object.assign(row, { signatures: JSON.parse(params[1]), status: params[2] });
      } else if (text.includes('SET funded_cents')) {
        Object.assign(row, {
          funded_cents: params[1], status: params[2], funding_note: params[3], payment_reference: params[4],
        });
      } else if (text.includes("status = 'cancelled'")) {
        Object.assign(row, { status: 'cancelled', cancel_reason: params[1] });
      } else {
        Object.assign(row, { funding_note: params[1] });
      }
      return { rows: [row] };
    }

    // ── pi_events ────────────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO pi_events')) {
      const row = {
        sequence: state.events.length + 1,
        event_id: params[0],
        event_type: params[1],
        drawdown_id: params[2],
        series_id: params[3],
        actor: params[4],
        payload: params[5],
        prev_hash: params[6],
        event_hash: params[7],
        created_at: params[8],
      };
      state.events.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM pi_events ORDER BY sequence DESC LIMIT 1')) {
      const tip = state.events[state.events.length - 1];
      return { rows: tip ? [tip] : [] };
    }
    if (text.includes('FROM pi_events ORDER BY sequence ASC')) return { rows: state.events };
    if (text.includes('FROM pi_events ORDER BY sequence DESC')) {
      return { rows: state.events.slice().reverse() };
    }

    return { rows: [] };
  });
}

const ENV_KEYS = ['DRAWDOWN_SIGNATURES', 'PRINCIPAL_DRAWDOWN_RATE_BPS', 'PRINCIPAL_DRAWDOWN_START'];

describe('principal & income drawdown OS', () => {
  let state: FakeState;
  let saved: Record<string, string | undefined>;
  /** The attested cash fenced into the series; $0 unless a test funds it. */
  let seriesAvailableCents: number;

  beforeEach(() => {
    state = { entries: [], drawdowns: [], events: [] };
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PRINCIPAL_DRAWDOWN_START = '2024-02-01';
    seriesAvailableCents = 0;

    vi.spyOn(pool, 'query').mockImplementation(fakeDb(state) as any);
    vi.spyOn(SeriesOsEngine, 'getSeries').mockImplementation(async (ref: string) => (
      ref === SERIES.series_id || String(ref).toUpperCase() === SERIES.series_code ? { ...SERIES } : null
    ));
    vi.spyOn(SeriesOsEngine, 'listSeries').mockResolvedValue([{ ...SERIES }]);
    vi.spyOn(SeriesOsEngine, 'balanceSheet').mockImplementation(async () => ({
      seriesId: SERIES.series_id,
      seriesCode: SERIES.series_code,
      // The $100M bond is fenced in as corpus; none of it is attested cash.
      assets: [{
        assetKind: 'bond',
        assetRef: 'DLB-PRB',
        valueKind: 'internal_only',
        valueCents: SELF_ISSUED_BOND.carryingValueCents,
      }],
      spendableCents: seriesAvailableCents,
      spendable: seriesAvailableCents / 100,
      availableCents: seriesAvailableCents,
      available: seriesAvailableCents / 100,
      collateralCents: 0,
      collateral: 0,
    }));
    vi.spyOn(ReserveEngine, 'portfolio').mockResolvedValue({ positions: [SELF_ISSUED_BOND] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('principal & income allocation', () => {
    it('allocates a contribution to principal and rent to income, both distributable', async () => {
      const contribution = await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01',
        sourceKind: 'contribution',
        amountCents: 500000,
        recordedBy: CHECKER,
      });
      const rent = await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01',
        sourceKind: 'rent',
        amountCents: 120000,
        recordedBy: CHECKER,
      });

      expect(contribution.allocation).toBe('principal');
      expect(contribution.distributable).toBe(true);
      expect(rent.allocation).toBe('income');
      expect(rent.distributable).toBe(true);
    });

    it('records accrued interest as income but never as distributable', async () => {
      const accrual = await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01',
        sourceKind: 'accrued_interest',
        // Even asked for on a cash basis, an accrual source stays an accrual.
        basis: 'cash',
        amountCents: 200000000,
        recordedBy: CHECKER,
      });

      expect(accrual.allocation).toBe('income');
      expect(accrual.basis).toBe('accrual');
      expect(accrual.distributable).toBe(false);
      expect(accrual.non_distributable_reason).toMatch(/receivable, not cash/);
    });

    it('refuses to treat a coupon on the trust\u2019s own bond as distributable income', async () => {
      const coupon = await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01',
        sourceKind: 'bond_coupon',
        sourceRef: 'DLB-PRB',
        amountCents: 200000000,
        recordedBy: CHECKER,
      });

      expect(coupon.distributable).toBe(false);
      expect(coupon.non_distributable_reason).toMatch(/both obligor and holder/);
    });

    it('treats a coupon on a third-party bond as distributable income', async () => {
      (ReserveEngine.portfolio as any).mockResolvedValue({
        positions: [{
          bondName: 'US Treasury 2030', isin: 'US912810TM09', bondIdentifier: null, selfIssued: false,
        }],
      });
      const coupon = await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01',
        sourceKind: 'bond_coupon',
        sourceRef: 'US912810TM09',
        amountCents: 300000,
        recordedBy: CHECKER,
      });
      expect(coupon.distributable).toBe(true);
    });

    it('rejects an unknown source and a non-positive amount', async () => {
      await expect(PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01', sourceKind: 'lottery', amountCents: 100, recordedBy: CHECKER,
      })).rejects.toThrow(/sourceKind must be one of/);

      await expect(PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01', sourceKind: 'contribution', amountCents: 0, recordedBy: CHECKER,
      })).rejects.toThrow(/positive amountCents/);
    });
  });

  describe('entitlement', () => {
    it('states the principal allowance against corpus separately from what is fundable', async () => {
      const entitlement = await PrincipalIncomeEngine.entitlement('S-BEN-01');

      // 2%/yr of the $100M corpus over the allowance years since 02/2024.
      const expected = (100000000 * 2 * entitlement.allowanceYears) / 100;
      expect(entitlement.corpus).toBe(100000000);
      expect(entitlement.principal.allowance).toBe(expected);
      expect(entitlement.principal.remaining).toBe(expected);
      // None of it can be paid: the corpus is a self-issued bond, not cash.
      expect(entitlement.principal.fundable).toBe(0);
      expect(entitlement.principal.unbacked).toBe(expected);
      expect(entitlement.note).toMatch(/no attested cash/);
    });

    it('counts three allowance years from 02/2024 and honours the configured rate', async () => {
      process.env.PRINCIPAL_DRAWDOWN_RATE_BPS = '200';
      const entitlement = await PrincipalIncomeEngine.entitlement('S-BEN-01');
      // The memo on the existing $6M allocation: 2% a year from 02/2024.
      expect(entitlement.allowanceYears).toBeGreaterThanOrEqual(3);
      expect(entitlement.principal.allowance).toBe(2000000 * entitlement.allowanceYears);
    });

    it('limits income entitlement to income actually received in cash', async () => {
      await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01', sourceKind: 'accrued_interest', amountCents: 200000000, recordedBy: CHECKER,
      });
      await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01', sourceKind: 'rent', amountCents: 150000, recordedBy: CHECKER,
      });

      const entitlement = await PrincipalIncomeEngine.entitlement('S-BEN-01');
      expect(entitlement.income.allowance).toBe(1500);
      expect(entitlement.accruedIncome).toBe(2000000);
    });

    it('reports fundable up to the attested cash fenced into the series', async () => {
      seriesAvailableCents = 40000;
      const entitlement = await PrincipalIncomeEngine.entitlement('S-BEN-01');
      expect(entitlement.seriesAvailable).toBe(400);
      expect(entitlement.principal.fundable).toBe(400);
    });

    it('refuses a series that does not exist', async () => {
      await expect(PrincipalIncomeEngine.entitlement('S-NOPE')).rejects.toThrow(/not found/);
    });
  });

  describe('drawdown lifecycle', () => {
    async function proposePrincipal(amountCents = 600000000) {
      return PrincipalIncomeEngine.propose({
        seriesRef: 'S-BEN-01',
        allocation: 'principal',
        amountCents,
        purpose: 'beneficiary support',
        proposedBy: MAKER,
      });
    }

    it('records a principal drawdown as an entitlement, not as money', async () => {
      const drawdown = await proposePrincipal();
      expect(drawdown.status).toBe('proposed');
      expect(Number(drawdown.requested_cents)).toBe(600000000);
      expect(Number(drawdown.funded_cents)).toBe(0);
      expect(drawdown.required_signatures).toBe(2);
    });

    it('refuses a drawdown above the entitlement', async () => {
      await expect(PrincipalIncomeEngine.propose({
        seriesRef: 'S-BEN-01',
        allocation: 'principal',
        amountCents: 5000000000,
        purpose: 'beneficiary support',
        proposedBy: MAKER,
      })).rejects.toThrow(/exceeds the \$\d[\d,.]* remaining entitlement/);
    });

    it('refuses an income drawdown with no income received', async () => {
      await expect(PrincipalIncomeEngine.propose({
        seriesRef: 'S-BEN-01',
        allocation: 'income',
        amountCents: 100000,
        purpose: 'beneficiary support',
        proposedBy: MAKER,
      })).rejects.toThrow(/income is drawable only to the extent it was received in cash/);
    });

    it('authorizes on two distinct trustee signatures and refuses a duplicate signer', async () => {
      const drawdown = await proposePrincipal();

      const first = await PrincipalIncomeEngine.authorize(drawdown.drawdown_id, MAKER);
      expect(first.status).toBe('proposed');
      expect(first.remainingSignatures).toBe(1);

      await expect(PrincipalIncomeEngine.authorize(drawdown.drawdown_id, MAKER))
        .rejects.toThrow(/has already signed/);

      const second = await PrincipalIncomeEngine.authorize(drawdown.drawdown_id, CHECKER);
      expect(second.status).toBe('authorized');
      expect(second.note).toMatch(/becomes money only when fund\(\) finds attested cash/);
    });

    it('refuses to fund a drawdown that is not authorized', async () => {
      const drawdown = await proposePrincipal();
      await expect(PrincipalIncomeEngine.fund(drawdown.drawdown_id, {
        paymentReference: 'ACH-1', fundedBy: CHECKER,
      })).rejects.toThrow(/must be authorized by 2 trustees/);
    });

    async function authorized(amountCents = 600000000) {
      const drawdown = await proposePrincipal(amountCents);
      await PrincipalIncomeEngine.authorize(drawdown.drawdown_id, MAKER);
      await PrincipalIncomeEngine.authorize(drawdown.drawdown_id, CHECKER);
      return drawdown;
    }

    it('leaves an authorized drawdown unfunded when the series holds no attested cash', async () => {
      const drawdown = await authorized();
      const result = await PrincipalIncomeEngine.fund(drawdown.drawdown_id, {
        paymentReference: 'ACH-1', fundedBy: CHECKER,
      });

      expect(result.fundedNow).toBe(0);
      expect(result.status).toBe('authorized');
      expect(result.funding_note).toMatch(/Authorized but unfunded/);
      // Nothing was disbursed, so no cash entry exists.
      expect(state.entries).toHaveLength(0);
    });

    it('funds only up to the attested cash and leaves the rest outstanding', async () => {
      seriesAvailableCents = 25000000;
      const drawdown = await authorized();
      const result = await PrincipalIncomeEngine.fund(drawdown.drawdown_id, {
        paymentReference: 'WIRE-8821', fundedBy: CHECKER,
      });

      expect(result.status).toBe('partially_funded');
      expect(result.fundedNow).toBe(250000);
      expect(result.note).toMatch(/remains outstanding for want of attested cash/);

      const entry = state.entries[0];
      expect(entry.entry_type).toBe('disbursement');
      expect(entry.allocation).toBe('principal');
      expect(Number(entry.amount_cents)).toBe(25000000);
      expect(entry.source_ref).toBe('WIRE-8821');
    });

    it('funds in full when the cash is there, and needs a payment reference to do it', async () => {
      seriesAvailableCents = 50000;
      const drawdown = await authorized(50000);

      await expect(PrincipalIncomeEngine.fund(drawdown.drawdown_id, { fundedBy: CHECKER }))
        .rejects.toThrow(/paymentReference is required/);

      const result = await PrincipalIncomeEngine.fund(drawdown.drawdown_id, {
        paymentReference: 'ACH-CREDIT-77', fundedBy: CHECKER,
      });
      expect(result.status).toBe('funded');
      expect(result.fundedNow).toBe(500);
    });

    it('refuses to fund more than the outstanding amount', async () => {
      seriesAvailableCents = 100000;
      const drawdown = await authorized(50000);
      await expect(PrincipalIncomeEngine.fund(drawdown.drawdown_id, {
        paymentReference: 'ACH-1', amountCents: 90000, fundedBy: CHECKER,
      })).rejects.toThrow(/exceeds the \$500 outstanding/);
    });

    it('cancels a proposal and refuses to cancel a funded drawdown', async () => {
      seriesAvailableCents = 50000;
      const proposal = await proposePrincipal(10000);
      const cancelled = await PrincipalIncomeEngine.cancel(proposal.drawdown_id, {
        reason: 'superseded', cancelledBy: CHECKER,
      });
      expect(cancelled.status).toBe('cancelled');

      const funded = await authorized(50000);
      await PrincipalIncomeEngine.fund(funded.drawdown_id, {
        paymentReference: 'ACH-2', fundedBy: CHECKER,
      });
      await expect(PrincipalIncomeEngine.cancel(funded.drawdown_id, {
        reason: 'changed my mind', cancelledBy: CHECKER,
      })).rejects.toThrow(/is funded/);
    });

    it('counts a cancelled drawdown back against the entitlement', async () => {
      const proposal = await proposePrincipal(600000000);
      const before = await PrincipalIncomeEngine.entitlement('S-BEN-01');
      expect(before.principal.committed).toBe(6000000);

      await PrincipalIncomeEngine.cancel(proposal.drawdown_id, {
        reason: 'superseded', cancelledBy: CHECKER,
      });
      const after = await PrincipalIncomeEngine.entitlement('S-BEN-01');
      expect(after.principal.committed).toBe(0);
    });
  });

  describe('statement', () => {
    it('reports the $6M principal drawdown as authorized and unfunded, with the reason', async () => {
      const drawdown = await PrincipalIncomeEngine.propose({
        seriesRef: 'S-BEN-01',
        allocation: 'principal',
        amountCents: 600000000,
        purpose: '2% allocation per year, beneficiary and trust support',
        proposedBy: MAKER,
      });
      await PrincipalIncomeEngine.authorize(drawdown.drawdown_id, MAKER);
      await PrincipalIncomeEngine.authorize(drawdown.drawdown_id, CHECKER);

      const statement = await PrincipalIncomeEngine.statement('S-BEN-01');
      expect(statement.authorized).toBe(6000000);
      expect(statement.funded).toBe(0);
      expect(statement.unfunded).toBe(6000000);
      expect(statement.note).toMatch(/recorded against corpus, but no attested cash/);
      expect(statement.principal.receipts).toBe(0);
    });

    it('separates distributable income from accrued income in the statement', async () => {
      await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01', sourceKind: 'accrued_interest', amountCents: 200000000, recordedBy: CHECKER,
      });
      await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01', sourceKind: 'rent', amountCents: 250000, recordedBy: CHECKER,
      });

      const statement = await PrincipalIncomeEngine.statement('S-BEN-01');
      expect(statement.income.receipts).toBe(2002500);
      expect(statement.income.distributable).toBe(2500);
      expect(statement.income.accrued).toBe(2000000);
    });

    it('rolls the series statements up into the engine status', async () => {
      const status = await PrincipalIncomeEngine.status();
      expect(status.requiredSignatures).toBe(2);
      expect(status.principalRateBps).toBe(200);
      expect(status.series).toHaveLength(1);
      expect(status.note).toMatch(/Authorizing one records what a beneficiary may receive/);
    });
  });

  describe('event chain', () => {
    it('records the lifecycle and verifies intact', async () => {
      const drawdown = await PrincipalIncomeEngine.propose({
        seriesRef: 'S-BEN-01',
        allocation: 'principal',
        amountCents: 100000,
        purpose: 'beneficiary support',
        proposedBy: MAKER,
      });
      await PrincipalIncomeEngine.authorize(drawdown.drawdown_id, MAKER);
      await PrincipalIncomeEngine.authorize(drawdown.drawdown_id, CHECKER);

      const chain = await PrincipalIncomeEngine.verifyChain();
      expect(chain.events).toBe(3);
      expect(chain.intact).toBe(true);

      const types = (await PrincipalIncomeEngine.events()).map((e: Row) => e.event_type);
      expect(types).toEqual(['drawdown_authorized', 'drawdown_signed', 'drawdown_proposed']);
    });

    it('detects a tampered event', async () => {
      await PrincipalIncomeEngine.recordEntry({
        seriesRef: 'S-BEN-01', sourceKind: 'contribution', amountCents: 100000, recordedBy: CHECKER,
      });
      state.events[0].actor = 'someone-else@example.com';

      const chain = await PrincipalIncomeEngine.verifyChain();
      expect(chain.intact).toBe(false);
      expect(chain.breaks).toHaveLength(1);
      expect(chain.note).toMatch(/has been altered/);
    });
  });
});

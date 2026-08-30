import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CapitalTransferOsEngine } = require('../server/integrations/capital/capitalTransferOsEngine');
const { SeriesOsEngine } = require('../server/integrations/series/seriesOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const { CustodyOsEngine } = require('../server/integrations/custody/custodyOsEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

interface FakeState {
  series: Row[];
  assignments: Row[];
  obligations: Row[];
  seriesEvents: Row[];
  transfers: Row[];
  transferEvents: Row[];
  recorded: Row[];
}

/**
 * In-memory stand-in for the series and capital transfer tables. The reserve,
 * custody and bond reads are stubbed per test, so only the statements these two
 * engines issue need to be recognised.
 */
function fakeDb(state: FakeState) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/i.test(text)) return { rows: [] };

    // ── trust_series ─────────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO trust_series')) {
      const row = {
        series_id: params[0],
        series_code: params[1],
        series_name: params[2],
        purpose: params[3],
        beneficiary_ref: params[4],
        mandate: params[5],
        ring_fenced: params[6],
        opened_by: params[7],
        status: 'active',
        created_at: new Date().toISOString(),
      };
      state.series.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM trust_series WHERE series_id')) {
      const ref = String(params[0] || '');
      return {
        rows: state.series.filter((s) => s.series_id === ref || s.series_code === ref.toUpperCase()),
      };
    }
    if (text.includes('FROM trust_series WHERE status')) {
      return { rows: state.series.filter((s) => s.status !== 'closed') };
    }

    // ── series_asset_assignments ─────────────────────────────────────────────
    if (text.startsWith('INSERT INTO series_asset_assignments')) {
      const row = {
        assignment_id: params[0],
        series_id: params[1],
        asset_kind: params[2],
        asset_ref: params[3],
        asset_class: params[4],
        value_kind: params[5],
        identification: params[6],
        identified_value_cents: params[7],
        evidence_reference: params[8],
        assigned_by: params[9],
        status: 'active',
        created_at: new Date().toISOString(),
      };
      state.assignments.push(row);
      return { rows: [withCode(state, row)] };
    }
    if (text.includes('FROM series_asset_assignments a') && text.includes('a.asset_kind = $1')) {
      const rows = state.assignments.filter(
        (a) => a.status === 'active'
          && a.asset_kind === params[0]
          && String(a.asset_ref).toLowerCase() === String(params[1]).toLowerCase()
      );
      return { rows: rows.map((a) => withCode(state, a)) };
    }
    if (text.includes('FROM series_asset_assignments a') && text.includes('WHERE a.series_id')) {
      const rows = state.assignments.filter((a) => a.status === 'active' && a.series_id === params[0]);
      return { rows: rows.map((a) => withCode(state, a)) };
    }
    if (text.includes('FROM series_asset_assignments a')) {
      const rows = state.assignments.filter((a) => a.status === 'active');
      return { rows: rows.map((a) => withCode(state, a)) };
    }

    // ── series_obligations ───────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO series_obligations')) {
      const row = {
        obligation_id: params[0],
        series_id: params[1],
        obligation_type: params[2],
        counterparty: params[3],
        amount_cents: params[4],
        memo: params[5],
        created_by: params[6],
        status: 'open',
        created_at: new Date().toISOString(),
      };
      state.obligations.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM series_obligations')) {
      const rows = state.obligations.filter(
        (o) => (!params[0] || o.series_id === params[0]) && (!params[1] || o.status === params[1])
      );
      return { rows };
    }

    // ── series_events ────────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO series_events')) {
      state.seriesEvents.push({ sequence: state.seriesEvents.length + 1, event_hash: params[7] });
      return { rows: [state.seriesEvents[state.seriesEvents.length - 1]] };
    }
    if (text.includes('FROM series_events')) {
      const tip = state.seriesEvents[state.seriesEvents.length - 1];
      return { rows: tip ? [tip] : [] };
    }

    // ── capital_transfers ────────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO capital_transfers')) {
      const row: Row = {
        transfer_id: params[0],
        route: params[1],
        series_id: params[2],
        source_asset_kind: params[3],
        source_asset_ref: params[4],
        source_label: params[5],
        source_value_cents: params[6],
        amount_cents: params[7],
        expected_proceeds_cents: params[8],
        counterparty: params[9],
        destination_ref: params[10],
        memo: params[11],
        required_signatures: params[12],
        proposed_by: params[13],
        origin: params[14],
        signatures: [],
        status: 'proposed',
        created_at: new Date(Date.now() + state.transfers.length).toISOString(),
      };
      state.transfers.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM capital_transfers WHERE transfer_id')) {
      return { rows: state.transfers.filter((t) => t.transfer_id === params[0]) };
    }
    if (text.includes('FROM capital_transfers WHERE source_asset_kind')) {
      return {
        rows: state.transfers.filter(
          (t) => t.source_asset_kind === params[0]
            && String(t.source_asset_ref).toLowerCase() === String(params[1]).toLowerCase()
            && ['proposed', 'authorized', 'instructed'].includes(t.status)
        ),
      };
    }
    if (text.includes('FROM capital_transfers')) {
      const rows = state.transfers.filter(
        (t) => (!params[0] || t.series_id === params[0]) && (!params[1] || t.status === params[1])
      );
      return { rows: rows.slice().reverse() };
    }
    if (text.startsWith('UPDATE capital_transfers')) {
      const row = state.transfers.find((t) => t.transfer_id === params[0]);
      if (!row) return { rows: [] };
      if (text.includes('SET signatures')) {
        Object.assign(row, { signatures: JSON.parse(params[1]), status: params[2] });
      } else if (text.includes("status = 'instructed'")) {
        Object.assign(row, {
          status: 'instructed', instruction_reference: params[1], instructed_by: params[2],
        });
      } else if (text.includes("status = 'confirmed'")) {
        Object.assign(row, {
          status: 'confirmed',
          settlement_reference: params[1],
          evidence_reference: params[2],
          settled_cents: params[3],
          confirmed_by: params[4],
          reserve_attestation_id: params[5],
          assignment_id: params[6],
          settlement_note: params[7],
          destination_ref: params[8],
        });
      } else {
        Object.assign(row, { status: params[1], failure_reason: params[2] });
      }
      return { rows: [row] };
    }

    // ── capital_transfer_events ──────────────────────────────────────────────
    if (text.startsWith('INSERT INTO capital_transfer_events')) {
      const row = {
        sequence: state.transferEvents.length + 1,
        event_id: params[0],
        event_type: params[1],
        transfer_id: params[2],
        series_id: params[3],
        actor: params[4],
        payload: params[5],
        prev_hash: params[6],
        event_hash: params[7],
        created_at: params[8],
      };
      state.transferEvents.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM capital_transfer_events ORDER BY sequence DESC LIMIT 1')) {
      const tip = state.transferEvents[state.transferEvents.length - 1];
      return { rows: tip ? [tip] : [] };
    }
    if (text.includes('FROM capital_transfer_events ORDER BY sequence ASC')) {
      return { rows: state.transferEvents };
    }
    if (text.includes('FROM capital_transfer_events ORDER BY sequence DESC')) {
      return { rows: state.transferEvents.slice().reverse() };
    }

    if (text.includes('FROM cash_accounts')) {
      return {
        rows: [{ account_id: 'CA-OPERATING', account_name: 'Operating Cash', balance_cents: 584259658 }],
      };
    }

    return { rows: [] };
  });
}

function withCode(state: FakeState, assignment: Row) {
  const series = state.series.find((s) => s.series_id === assignment.series_id) || {};
  return { ...assignment, series_code: series.series_code, series_name: series.series_name };
}

const MAKER = 'AnnRobinson1117@gmail.com';
const CHECKER = 'deandreabarkley13@gmail.com';

const ENV_KEYS = [
  'CAPITAL_TRANSFER_SIGNATURES', 'CAPITAL_TRANSFER_AUTOMATION', 'CAPITAL_PLEDGE_ADVANCE_BPS',
  'CAPITAL_TRANSFER_DESTINATION', 'SERIES_RING_FENCE_ENFORCEMENT', 'RESERVE_ENFORCEMENT',
];

/** A custodian-attested Treasury: $250k carrying value, $200k eligible collateral. */
const CUSTODIED_TREASURY = {
  bondName: 'US Treasury 2030',
  isin: 'US912810TM09',
  bondIdentifier: null,
  custodyStatus: 'custodian_attested',
  carryingValueCents: 25000000,
  eligibleCollateralCents: 20000000,
};

/** The trust's own bond: issued and held by the PTC, so nothing to sell. */
const SELF_ISSUED_BOND = {
  bondName: 'DLB Private Placement Bond',
  isin: null,
  bondIdentifier: 'DLB-PRB',
  custodyStatus: 'self_issued_self_held',
  carryingValueCents: 10000000000,
  eligibleCollateralCents: 0,
};

function attestation(sourceType: string, sourceKey: string, balanceCents: number) {
  return {
    source_type: sourceType,
    source_key: sourceKey,
    asset_class: 'cash',
    verification: 'live',
    balance_cents: balanceCents,
    balance: balanceCents / 100,
    evidence_reference: null,
    unverified_reason: null,
    stale: false,
    counted: true,
    collateralCents: 0,
  };
}

describe('capital transfer OS engine', () => {
  let state: FakeState;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    state = {
      series: [], assignments: [], obligations: [], seriesEvents: [],
      transfers: [], transferEvents: [], recorded: [],
    };
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(pool, 'query').mockImplementation(fakeDb(state) as any);
    // Whatever the engine attests becomes an identified asset, as it would in
    // production once record() has written it.
    vi.spyOn(ReserveEngine, 'latestAttestations').mockImplementation(async () => state.recorded);
    vi.spyOn(ReserveEngine, 'portfolio').mockResolvedValue({
      positions: [], carryingValueCents: 0, eligibleCollateralCents: 0,
    });
    vi.spyOn(CustodyOsEngine, 'listPositions').mockResolvedValue([]);
    vi.spyOn(ReserveEngine, 'record').mockImplementation(async (input: any) => {
      state.recorded.push(attestation(input.sourceType, input.sourceKey, input.balanceCents));
      return {
        attestation_id: 'RSV-1',
        source_type: input.sourceType,
        source_key: input.sourceKey,
        balance_cents: input.balanceCents,
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function openSeries(code: string, overrides: Row = {}) {
    return SeriesOsEngine.openSeries({
      seriesCode: code,
      seriesName: `${code} Series`,
      purpose: 'beneficiary_support',
      beneficiaryRef: 'BEN-1',
      openedBy: CHECKER,
      ...overrides,
    });
  }

  /** A series holding the custodian Treasury, which is convertible collateral. */
  async function seriesWithTreasury(code = 'S-BEN-01') {
    (ReserveEngine.portfolio as any).mockResolvedValue({ positions: [CUSTODIED_TREASURY] });
    const series = await openSeries(code);
    await SeriesOsEngine.assignAsset({
      seriesRef: series.series_id,
      assetKind: 'bond',
      assetRef: 'US912810TM09',
      assignedBy: CHECKER,
    });
    return series;
  }

  describe('planning', () => {
    it('offers a sale and a pledge against custodian-held collateral', async () => {
      const series = await seriesWithTreasury();
      const plan = await CapitalTransferOsEngine.plan({ seriesRef: series.series_id });

      const treasury = plan.eligible.find((a: Row) => a.assetRef === 'US912810TM09');
      const sale = treasury.routes.find((r: Row) => r.route === 'collateral_sale');
      const pledge = treasury.routes.find((r: Row) => r.route === 'collateral_pledge');

      // A sale realises the eligible collateral; a pledge advances half of it.
      expect(sale.expectedProceeds).toBe(200000);
      expect(pledge.expectedProceeds).toBe(100000);
      expect(pledge.createsObligation).toBe(true);
      // Capacity takes the best route once, not both: the position pays once.
      expect(plan.capacity).toBe(200000);
    });

    it('honours a configured pledge advance rate', async () => {
      process.env.CAPITAL_PLEDGE_ADVANCE_BPS = '7000';
      const series = await seriesWithTreasury();
      const plan = await CapitalTransferOsEngine.plan({ seriesRef: series.series_id });
      const pledge = plan.eligible[0].routes.find((r: Row) => r.route === 'collateral_pledge');
      expect(pledge.expectedProceeds).toBe(140000);
    });

    it('reports the self-issued bond as ineligible with the reason', async () => {
      (ReserveEngine.portfolio as any).mockResolvedValue({ positions: [SELF_ISSUED_BOND] });
      const plan = await CapitalTransferOsEngine.plan();

      const own = plan.ineligible.find((a: Row) => a.assetRef === 'DLB-PRB');
      expect(own.reason).toMatch(/no counterparty to buy or lend against it/);
      expect(plan.eligible).toHaveLength(0);
      expect(plan.capacity).toBe(0);
    });

    it('reports a ledger cash account as ineligible: a claim is not a convertible asset', async () => {
      const plan = await CapitalTransferOsEngine.plan();
      const ledger = plan.ineligible.find((a: Row) => a.assetRef === 'CA-OPERATING');
      expect(ledger.reason).toMatch(/ledger balance is a claim on the trust/);
    });

    it('reports a custody position as evidence rather than a second convertible asset', async () => {
      (CustodyOsEngine.listPositions as any).mockResolvedValue([{
        position_id: 'CPS-1',
        instrument_ref: 'Betterment Trust Checking',
        instrument_name: null,
        asset_class: 'cash',
        custody_type: 'third_party',
        custodian_name: 'Betterment',
        control_status: 'receipted',
        valuation_cents: 100000,
        last_receipt_id: 'CRC-1',
      }]);
      const plan = await CapitalTransferOsEngine.plan();
      const custody = plan.ineligible.find((a: Row) => a.assetKind === 'custody_position');
      expect(custody.reason).toMatch(/Evidence for another asset/);
    });

    it('routes on-chain USDC to redemption and custodian cash to a sweep', async () => {
      (ReserveEngine.latestAttestations as any).mockResolvedValue([
        attestation('onchain_wallet', '0x3e53', 25600),
        attestation('custodian_statement', 'schwab-8891', 500000),
      ]);
      const plan = await CapitalTransferOsEngine.plan();

      const onchain = plan.eligible.find((a: Row) => a.assetRef.startsWith('onchain_wallet'));
      const custodian = plan.eligible.find((a: Row) => a.assetRef.startsWith('custodian_statement'));
      expect(onchain.routes.map((r: Row) => r.route)).toEqual(['digital_asset_redemption']);
      expect(custodian.routes.map((r: Row) => r.route)).toEqual(['custodian_cash_sweep']);
      expect(plan.capacity).toBe(5256);
    });

    it('measures the gap against the series open obligations', async () => {
      const series = await seriesWithTreasury();
      await SeriesOsEngine.recordObligation({
        seriesRef: series.series_id,
        obligationType: 'beneficiary_distribution',
        amountCents: 15000000,
        createdBy: CHECKER,
      });

      const plan = await CapitalTransferOsEngine.plan({ seriesRef: series.series_id });
      expect(plan.target).toBe(150000);
      expect(plan.available).toBe(0);
      expect(plan.gap).toBe(150000);
      expect(plan.coversGap).toBe(true);
    });

    it('refuses to plan against a series that does not exist', async () => {
      await expect(CapitalTransferOsEngine.plan({ seriesRef: 'S-NOPE' })).rejects.toThrow(/not found/);
    });
  });

  describe('proposing a transfer', () => {
    it('raises a proposal needing two trustee signatures', async () => {
      const series = await seriesWithTreasury();
      const transfer = await CapitalTransferOsEngine.propose({
        route: 'collateral_sale',
        seriesRef: 'S-BEN-01',
        assetKind: 'bond',
        assetRef: 'US912810TM09',
        counterparty: 'Schwab Institutional',
        destinationRef: 'betterment-trust-checking',
        proposedBy: MAKER,
      });

      expect(transfer.status).toBe('proposed');
      expect(transfer.series_id).toBe(series.series_id);
      expect(transfer.required_signatures).toBe(2);
      // Defaults to the full expected proceeds of the route.
      expect(Number(transfer.amount_cents)).toBe(20000000);
    });

    it('refuses a route the asset cannot take', async () => {
      (ReserveEngine.portfolio as any).mockResolvedValue({ positions: [SELF_ISSUED_BOND] });
      await openSeries('S-BEN-01');
      await expect(CapitalTransferOsEngine.propose({
        route: 'collateral_sale',
        seriesRef: 'S-BEN-01',
        assetKind: 'bond',
        assetRef: 'DLB-PRB',
        counterparty: 'Schwab Institutional',
        proposedBy: MAKER,
      })).rejects.toThrow(/cannot be converted by collateral_sale/);
    });

    it('refuses to convert an asset fenced into another series', async () => {
      await seriesWithTreasury('S-BEN-01');
      await openSeries('S-BEN-02', { beneficiaryRef: 'BEN-2' });

      await expect(CapitalTransferOsEngine.propose({
        route: 'collateral_sale',
        seriesRef: 'S-BEN-02',
        assetKind: 'bond',
        assetRef: 'US912810TM09',
        counterparty: 'Schwab Institutional',
        proposedBy: MAKER,
      })).rejects.toThrow(/fenced into series S-BEN-01/);
    });

    it('refuses a second live transfer against the same asset', async () => {
      await seriesWithTreasury();
      const first = {
        route: 'collateral_sale',
        seriesRef: 'S-BEN-01',
        assetKind: 'bond',
        assetRef: 'US912810TM09',
        counterparty: 'Schwab Institutional',
        proposedBy: MAKER,
      };
      await CapitalTransferOsEngine.propose(first);
      await expect(CapitalTransferOsEngine.propose(first)).rejects.toThrow(/already being converted/);
    });

    it('refuses to request more than the route can raise', async () => {
      await seriesWithTreasury();
      await expect(CapitalTransferOsEngine.propose({
        route: 'collateral_pledge',
        seriesRef: 'S-BEN-01',
        assetKind: 'bond',
        assetRef: 'US912810TM09',
        amountCents: 20000000,
        counterparty: 'Lender',
        proposedBy: MAKER,
      })).rejects.toThrow(/raises at most \$100000/);
    });

    it('needs a counterparty and a positive amount for a contribution', async () => {
      await openSeries('S-BEN-01');
      await expect(CapitalTransferOsEngine.propose({
        route: 'external_contribution',
        seriesRef: 'S-BEN-01',
        amountCents: 500000,
        proposedBy: MAKER,
      })).rejects.toThrow(/needs the counterparty/);

      await expect(CapitalTransferOsEngine.propose({
        route: 'external_contribution',
        seriesRef: 'S-BEN-01',
        counterparty: 'DeAndrea Lavar Barkley',
        proposedBy: MAKER,
      })).rejects.toThrow(/positive amountCents/);
    });

    it('refuses a suspended series', async () => {
      const series = await openSeries('S-BEN-01');
      series.status = 'suspended';
      await expect(CapitalTransferOsEngine.propose({
        route: 'external_contribution',
        seriesRef: 'S-BEN-01',
        amountCents: 500000,
        counterparty: 'DeAndrea Lavar Barkley',
        proposedBy: MAKER,
      })).rejects.toThrow(/is suspended and cannot receive capital transfers/);
    });
  });

  describe('authorization and settlement', () => {
    async function proposeContribution(amountCents = 500000) {
      await openSeries('S-BEN-01');
      return CapitalTransferOsEngine.propose({
        route: 'external_contribution',
        seriesRef: 'S-BEN-01',
        amountCents,
        counterparty: 'DeAndrea Lavar Barkley',
        destinationRef: 'betterment-trust-checking',
        proposedBy: MAKER,
      });
    }

    it('authorizes only on two distinct trustee signatures', async () => {
      const transfer = await proposeContribution();

      const first = await CapitalTransferOsEngine.authorize(transfer.transfer_id, MAKER);
      expect(first.status).toBe('proposed');
      expect(first.remainingSignatures).toBe(1);

      await expect(CapitalTransferOsEngine.authorize(transfer.transfer_id, MAKER))
        .rejects.toThrow(/has already signed/);

      const second = await CapitalTransferOsEngine.authorize(transfer.transfer_id, CHECKER);
      expect(second.status).toBe('authorized');
      expect(second.remainingSignatures).toBe(0);
    });

    it('refuses to instruct before authorization and to settle before instruction', async () => {
      const transfer = await proposeContribution();
      await expect(CapitalTransferOsEngine.instruct(transfer.transfer_id, {
        instructionReference: 'WIRE-REQ-1',
        instructedBy: CHECKER,
      })).rejects.toThrow(/must be authorized by 2 trustees/);

      await CapitalTransferOsEngine.authorize(transfer.transfer_id, MAKER);
      await CapitalTransferOsEngine.authorize(transfer.transfer_id, CHECKER);

      await expect(CapitalTransferOsEngine.confirm(transfer.transfer_id, {
        settlementReference: 'ACH-1',
        evidenceReference: 'statement.pdf',
        confirmedBy: CHECKER,
      })).rejects.toThrow(/only an instructed transfer can settle/);
    });

    async function readyToSettle(route = 'external_contribution') {
      const transfer = route === 'external_contribution'
        ? await proposeContribution()
        : await (async () => {
          await seriesWithTreasury();
          return CapitalTransferOsEngine.propose({
            route,
            seriesRef: 'S-BEN-01',
            assetKind: 'bond',
            assetRef: 'US912810TM09',
            counterparty: 'Institutional Lender',
            destinationRef: 'betterment-trust-checking',
            proposedBy: MAKER,
          });
        })();
      await CapitalTransferOsEngine.authorize(transfer.transfer_id, MAKER);
      await CapitalTransferOsEngine.authorize(transfer.transfer_id, CHECKER);
      await CapitalTransferOsEngine.instruct(transfer.transfer_id, {
        instructionReference: 'CUSTODIAN-ORDER-77',
        instructedBy: CHECKER,
      });
      return transfer;
    }

    it('demands a settlement reference, evidence and a destination before proceeds exist', async () => {
      const transfer = await readyToSettle();

      await expect(CapitalTransferOsEngine.confirm(transfer.transfer_id, {
        evidenceReference: 'statement.pdf',
        confirmedBy: CHECKER,
      })).rejects.toThrow(/settlement reference from the counterparty is required/);

      await expect(CapitalTransferOsEngine.confirm(transfer.transfer_id, {
        settlementReference: 'ACH-1',
        confirmedBy: CHECKER,
      })).rejects.toThrow(/Documentary evidence is required/);

      // Nothing was attested by any of the refused attempts.
      expect(ReserveEngine.record).not.toHaveBeenCalled();
      expect((await CapitalTransferOsEngine.get(transfer.transfer_id)).status).toBe('instructed');
    });

    it('attests the settled proceeds as cash and fences them into the target series', async () => {
      const transfer = await readyToSettle();
      const confirmed = await CapitalTransferOsEngine.confirm(transfer.transfer_id, {
        settlementReference: 'ACH-CREDIT-4410',
        evidenceReference: 'betterment-statement-2026-08.pdf',
        confirmedBy: CHECKER,
      });

      expect(confirmed.status).toBe('confirmed');
      expect(ReserveEngine.record).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: 'partner_bank',
        sourceKey: 'betterment-trust-checking',
        verification: 'statement',
        assetClass: 'cash',
        balanceCents: 500000,
        evidenceReference: 'betterment-statement-2026-08.pdf',
        attestedBy: CHECKER,
      }));

      // The proceeds land inside the fence of the series that raised them.
      const fenced = state.assignments.find(
        (a) => a.asset_ref === 'partner_bank:betterment-trust-checking'
      );
      expect(fenced.series_id).toBe(confirmed.series_id);
      expect(confirmed.reserve.assignmentId).toBe(fenced.assignment_id);
      expect(confirmed.settlement_note).toMatch(/Fenced into the series that raised it/);
    });

    it('records a pledge advance as a series obligation, because the cash is owed', async () => {
      const transfer = await readyToSettle('collateral_pledge');
      const confirmed = await CapitalTransferOsEngine.confirm(transfer.transfer_id, {
        settlementReference: 'ADVANCE-9001',
        evidenceReference: 'loan-advice.pdf',
        confirmedBy: CHECKER,
      });

      const obligation = state.obligations.find((o) => o.obligation_type === 'collateral_advance');
      expect(Number(obligation.amount_cents)).toBe(10000000);
      expect(obligation.counterparty).toBe('Institutional Lender');
      expect(confirmed.reserve.obligationId).toBe(obligation.obligation_id);
    });

    it('does not report spendable funds when the reserve engine refuses the attestation', async () => {
      (ReserveEngine.record as any).mockRejectedValue(new Error('evidence reference required'));
      const transfer = await readyToSettle();
      const confirmed = await CapitalTransferOsEngine.confirm(transfer.transfer_id, {
        settlementReference: 'ACH-CREDIT-4410',
        evidenceReference: 'statement.pdf',
        confirmedBy: CHECKER,
      });

      expect(confirmed.reserve.attestationId).toBeNull();
      expect(confirmed.reserve.assignmentId).toBeNull();
      expect(confirmed.settlement_note).toMatch(/Reserve attestation refused/);
      expect(state.assignments).toHaveLength(0);
    });

    it('cancels a proposal and fails an instructed transfer', async () => {
      const proposal = await proposeContribution();
      const cancelled = await CapitalTransferOsEngine.fail(proposal.transfer_id, {
        reason: 'contributor withdrew',
        failedBy: CHECKER,
      });
      expect(cancelled.status).toBe('cancelled');

      const instructed = await readyToSettle();
      const failed = await CapitalTransferOsEngine.fail(instructed.transfer_id, {
        reason: 'custodian returned the order',
        failedBy: CHECKER,
      });
      expect(failed.status).toBe('failed');
      // A failed transfer raises nothing.
      expect(ReserveEngine.record).not.toHaveBeenCalled();
    });
  });

  describe('automation', () => {
    async function seriesWithGap() {
      const series = await seriesWithTreasury();
      await SeriesOsEngine.recordObligation({
        seriesRef: series.series_id,
        obligationType: 'beneficiary_distribution',
        amountCents: 5000000,
        createdBy: CHECKER,
      });
      return series;
    }

    it('proposes the best route for the gap and stops at proposed', async () => {
      await seriesWithGap();
      const run = await CapitalTransferOsEngine.automate({ actor: CHECKER });

      expect(run.proposed).toHaveLength(1);
      expect(run.proposed[0].route).toBe('collateral_sale');
      expect(run.proposed[0].origin).toBe('automation');
      expect(run.proposed[0].status).toBe('proposed');
      // Only the gap is raised, not the whole capacity.
      expect(Number(run.proposed[0].amount_cents)).toBe(5000000);
      expect(run.note).toMatch(/still needs 2 trustee signatures/);
    });

    it('reports gaps without writing proposals in a dry run', async () => {
      await seriesWithGap();
      const run = await CapitalTransferOsEngine.automate({ actor: CHECKER, dryRun: true });

      expect(run.mode).toBe('plan_only');
      expect(run.proposed).toHaveLength(0);
      expect(run.gaps[0].gap).toBe(50000);
      expect(state.transfers).toHaveLength(0);
    });

    it('does nothing when automation is switched off', async () => {
      process.env.CAPITAL_TRANSFER_AUTOMATION = 'off';
      await seriesWithGap();
      const run = await CapitalTransferOsEngine.automate({ actor: CHECKER });
      expect(run.mode).toBe('off');
      expect(state.transfers).toHaveLength(0);
    });

    it('skips a series whose gap has nothing convertible behind it', async () => {
      (ReserveEngine.portfolio as any).mockResolvedValue({ positions: [SELF_ISSUED_BOND] });
      const series = await openSeries('S-BEN-01');
      await SeriesOsEngine.assignAsset({
        seriesRef: series.series_id,
        assetKind: 'bond',
        assetRef: 'DLB-PRB',
        assignedBy: CHECKER,
      });
      await SeriesOsEngine.recordObligation({
        seriesRef: series.series_id,
        obligationType: 'beneficiary_distribution',
        amountCents: 5000000,
        createdBy: CHECKER,
      });

      const run = await CapitalTransferOsEngine.automate({ actor: CHECKER });
      expect(run.proposed).toHaveLength(0);
      expect(run.skipped[0].reason).toMatch(/no convertible asset fenced into the series/);
    });

    it('skips a funded series', async () => {
      await seriesWithTreasury();
      const run = await CapitalTransferOsEngine.automate({ actor: CHECKER });
      expect(run.skipped[0].reason).toBe('no funding gap');
    });
  });

  describe('event chain', () => {
    it('records the lifecycle and verifies intact', async () => {
      await openSeries('S-BEN-01');
      const transfer = await CapitalTransferOsEngine.propose({
        route: 'external_contribution',
        seriesRef: 'S-BEN-01',
        amountCents: 500000,
        counterparty: 'DeAndrea Lavar Barkley',
        destinationRef: 'betterment-trust-checking',
        proposedBy: MAKER,
      });
      await CapitalTransferOsEngine.authorize(transfer.transfer_id, MAKER);
      await CapitalTransferOsEngine.authorize(transfer.transfer_id, CHECKER);

      const chain = await CapitalTransferOsEngine.verifyChain();
      expect(chain.events).toBe(3);
      expect(chain.intact).toBe(true);

      const types = (await CapitalTransferOsEngine.events()).map((e: Row) => e.event_type);
      expect(types).toEqual(['transfer_authorized', 'transfer_signed', 'transfer_proposed']);
    });

    it('detects a tampered event', async () => {
      await openSeries('S-BEN-01');
      await CapitalTransferOsEngine.propose({
        route: 'external_contribution',
        seriesRef: 'S-BEN-01',
        amountCents: 500000,
        counterparty: 'DeAndrea Lavar Barkley',
        destinationRef: 'betterment-trust-checking',
        proposedBy: MAKER,
      });
      state.transferEvents[0].actor = 'someone-else@example.com';

      const chain = await CapitalTransferOsEngine.verifyChain();
      expect(chain.intact).toBe(false);
      expect(chain.breaks).toHaveLength(1);
      expect(chain.note).toMatch(/has been altered/);
    });
  });
});

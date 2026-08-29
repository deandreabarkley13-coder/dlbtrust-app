import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { SeriesOsEngine, SeriesRingFenceError } = require('../server/integrations/series/seriesOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const { CustodyOsEngine } = require('../server/integrations/custody/custodyOsEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

interface FakeState {
  series: Row[];
  assignments: Row[];
  obligations: Row[];
  events: Row[];
}

/**
 * In-memory stand-in for the series tables. The reserve and custody reads the
 * engine performs are stubbed per test, so only the series statements below need
 * to be recognised.
 */
function fakeDb(state: FakeState) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/i.test(text)) return { rows: [] };

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
        rows: state.series.filter(
          (s) => s.series_id === ref || s.series_code === ref.toUpperCase()
        ),
      };
    }

    if (text.includes('FROM trust_series WHERE status')) {
      return { rows: state.series.filter((s) => s.status !== 'closed') };
    }

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

    if (text.startsWith('UPDATE series_asset_assignments')) {
      const row = state.assignments.find((a) => a.assignment_id === params[0] && a.status === 'active');
      if (row) {
        Object.assign(row, {
          status: 'released',
          released_by: params[1],
          release_reason: params[2],
          released_at: new Date().toISOString(),
        });
      }
      return { rows: row ? [row] : [] };
    }

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

    if (text.startsWith('UPDATE series_obligations')) {
      const row = state.obligations.find((o) => o.obligation_id === params[0] && o.status === 'open');
      if (row) Object.assign(row, { status: params[1], settled_at: new Date().toISOString() });
      return { rows: row ? [row] : [] };
    }

    if (text.includes('FROM series_obligations')) {
      const rows = state.obligations.filter(
        (o) => (!params[0] || o.series_id === params[0]) && (!params[1] || o.status === params[1])
      );
      return { rows };
    }

    if (text.startsWith('INSERT INTO series_events')) {
      const row = {
        sequence: state.events.length + 1,
        event_id: params[0],
        event_type: params[1],
        series_id: params[2],
        asset_key: params[3],
        actor: params[4],
        payload: params[5],
        prev_hash: params[6],
        event_hash: params[7],
        created_at: params[8],
      };
      state.events.push(row);
      return { rows: [row] };
    }

    if (text.includes('FROM series_events ORDER BY sequence DESC LIMIT 1')) {
      const tip = state.events[state.events.length - 1];
      return { rows: tip ? [tip] : [] };
    }

    if (text.includes('FROM series_events ORDER BY sequence ASC')) {
      return { rows: state.events };
    }

    if (text.includes('FROM series_events ORDER BY sequence DESC')) {
      return { rows: state.events.slice().reverse() };
    }

    if (text.includes('FROM cash_accounts')) {
      return {
        rows: [
          { account_id: 'CA-OPERATING', account_name: 'Operating Cash', balance_cents: 584259658 },
        ],
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

const ENV_KEYS = ['SERIES_RING_FENCE_ENFORCEMENT', 'MASTER_TRUST_NAME', 'RESERVE_ENFORCEMENT'];

/** A live attested $1,000 of external cash, as `latestAttestations` reports it. */
function attestedCash(balanceCents: number) {
  return [{
    source_type: 'circle_custody',
    source_key: 'circle-mint-business-account',
    asset_class: 'cash',
    verification: 'live',
    balance_cents: balanceCents,
    balance: balanceCents / 100,
    evidence_reference: null,
    unverified_reason: null,
    stale: false,
    counted: true,
    collateralCents: 0,
  }];
}

describe('series OS engine', () => {
  let state: FakeState;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    state = { series: [], assignments: [], obligations: [], events: [] };
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(pool, 'query').mockImplementation(fakeDb(state) as any);
    vi.spyOn(ReserveEngine, 'latestAttestations').mockResolvedValue([]);
    vi.spyOn(ReserveEngine, 'portfolio').mockResolvedValue({
      positions: [],
      carryingValueCents: 0,
      eligibleCollateralCents: 0,
    });
    vi.spyOn(CustodyOsEngine, 'listPositions').mockResolvedValue([]);
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

  describe('series register', () => {
    it('requires a named beneficiary for a beneficiary support series', async () => {
      await expect(SeriesOsEngine.openSeries({
        seriesCode: 'S-A',
        seriesName: 'Support',
        purpose: 'beneficiary_support',
        openedBy: CHECKER,
      })).rejects.toThrow(/requires beneficiaryRef/);
    });

    it('refuses an unsupported purpose', async () => {
      await expect(SeriesOsEngine.openSeries({
        seriesCode: 'S-A',
        seriesName: 'Support',
        purpose: 'slush_fund',
        openedBy: CHECKER,
      })).rejects.toThrow(/purpose must be one of/);
    });

    it('finds a series by code as well as id', async () => {
      const series = await openSeries('S-ALPHA');
      expect((await SeriesOsEngine.getSeries('s-alpha')).series_id).toBe(series.series_id);
      expect((await SeriesOsEngine.getSeries(series.series_id)).series_code).toBe('S-ALPHA');
    });
  });

  describe('reserve asset identification', () => {
    it('classifies attested cash as spendable and a ledger balance as internal only', async () => {
      (ReserveEngine.latestAttestations as any).mockResolvedValue(attestedCash(100000));

      const inventory = await SeriesOsEngine.identify();
      const cash = inventory.assets.find((a: Row) => a.assetKind === 'reserve_attestation');
      const ledger = inventory.assets.find((a: Row) => a.assetRef === 'CA-OPERATING');

      expect(cash.valueKind).toBe('spendable');
      expect(cash.spendable).toBe(1000);
      // The $5.8M ledger balance is inventoried so it can be fenced, but it
      // contributes nothing spendable: the backing is the attestation, not the row.
      expect(ledger.valueKind).toBe('internal_only');
      expect(ledger.value).toBe(5842596.58);
      expect(inventory.spendable).toBe(1000);
      expect(inventory.counts.unassigned).toBe(2);
    });

    it('reads a self-issued bond as internal only and a custodian-held one as collateral', async () => {
      (ReserveEngine.portfolio as any).mockResolvedValue({
        positions: [
          {
            bondName: 'DLB Private Placement Bond',
            isin: null,
            bondIdentifier: 'DLB-PRB',
            custodyStatus: 'self_issued_self_held',
            carryingValueCents: 10000000000,
            eligibleCollateralCents: 0,
          },
          {
            bondName: 'US Treasury 2030',
            isin: 'US912810TM09',
            bondIdentifier: null,
            custodyStatus: 'custodian_attested',
            carryingValueCents: 25000000,
            eligibleCollateralCents: 20000000,
          },
        ],
      });

      const inventory = await SeriesOsEngine.identify();
      const own = inventory.assets.find((a: Row) => a.assetRef === 'DLB-PRB');
      const treasury = inventory.assets.find((a: Row) => a.assetRef === 'US912810TM09');

      expect(own.valueKind).toBe('internal_only');
      expect(own.collateral).toBe(0);
      expect(treasury.valueKind).toBe('collateral');
      expect(treasury.collateral).toBe(200000);
      expect(inventory.spendable).toBe(0);
    });

    it('treats a custody position as the evidence behind an attestation, not a second asset', async () => {
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
      (ReserveEngine.latestAttestations as any).mockResolvedValue(attestedCash(100000));

      const inventory = await SeriesOsEngine.identify();
      const custody = inventory.assets.find((a: Row) => a.assetKind === 'custody_position');
      expect(custody.valueKind).toBe('evidence');
      expect(custody.identification).toBe('receipted at Betterment');
      // Counted once, through the attestation.
      expect(inventory.spendable).toBe(1000);
    });
  });

  describe('ring fencing', () => {
    beforeEach(() => {
      (ReserveEngine.latestAttestations as any).mockResolvedValue(attestedCash(100000));
    });

    it('refuses to fence an asset that is not an identified trust asset', async () => {
      const series = await openSeries('S-ALPHA');
      await expect(SeriesOsEngine.assignAsset({
        seriesRef: series.series_id,
        assetKind: 'cash_account',
        assetRef: 'CA-IMAGINARY',
        assignedBy: MAKER,
      })).rejects.toThrow(/not an identified trust asset/);
    });

    it('refuses to fence the same asset into a second series', async () => {
      const alpha = await openSeries('S-ALPHA');
      const beta = await openSeries('S-BETA', { beneficiaryRef: 'BEN-2' });
      const asset = {
        assetKind: 'reserve_attestation',
        assetRef: 'circle_custody:circle-mint-business-account',
      };

      await SeriesOsEngine.assignAsset({ ...asset, seriesRef: alpha.series_id, assignedBy: MAKER });
      await expect(SeriesOsEngine.assignAsset({ ...asset, seriesRef: beta.series_id, assignedBy: MAKER }))
        .rejects.toThrow(SeriesRingFenceError);

      // Released from the first series, it can be fenced into the second.
      const held = (await SeriesOsEngine.listAssignments({ seriesRef: alpha.series_id }))[0];
      await SeriesOsEngine.releaseAsset(held.assignment_id, { releasedBy: CHECKER, reason: 'reallocated' });
      const moved = await SeriesOsEngine.assignAsset({
        ...asset, seriesRef: beta.series_id, assignedBy: MAKER,
      });
      expect(moved.series_id).toBe(beta.series_id);
    });

    it('is idempotent when the same series is assigned the same asset twice', async () => {
      const alpha = await openSeries('S-ALPHA');
      const asset = {
        seriesRef: alpha.series_id,
        assetKind: 'reserve_attestation',
        assetRef: 'circle_custody:circle-mint-business-account',
        assignedBy: MAKER,
      };
      const first = await SeriesOsEngine.assignAsset(asset);
      const second = await SeriesOsEngine.assignAsset(asset);
      expect(second.assignment_id).toBe(first.assignment_id);
      expect(state.assignments.filter((a) => a.status === 'active')).toHaveLength(1);
    });

    it('reports the balance sheet net of the series own obligations', async () => {
      const alpha = await openSeries('S-ALPHA');
      await SeriesOsEngine.assignAsset({
        seriesRef: alpha.series_id,
        assetKind: 'reserve_attestation',
        assetRef: 'circle_custody:circle-mint-business-account',
        assignedBy: MAKER,
      });
      await SeriesOsEngine.recordObligation({
        seriesRef: alpha.series_id,
        obligationType: 'beneficiary_distribution',
        amountCents: 40000,
        createdBy: MAKER,
      });

      const sheet = await SeriesOsEngine.balanceSheet('S-ALPHA');
      expect(sheet.spendable).toBe(1000);
      expect(sheet.openObligations).toBe(400);
      expect(sheet.available).toBe(600);
    });

    it('keeps unassigned assets out of every series and reports them as commingled', async () => {
      const alpha = await openSeries('S-ALPHA');
      const statement = await SeriesOsEngine.statement();
      expect(statement.series).toHaveLength(1);
      expect(statement.fencedSpendable).toBe(0);
      expect(statement.commingledSpendable).toBe(1000);
      expect(statement.commingled.map((a: Row) => a.assetRef)).toContain('CA-OPERATING');
      expect((await SeriesOsEngine.balanceSheet(alpha.series_id)).spendable).toBe(0);
    });
  });

  describe('ring fence enforcement', () => {
    beforeEach(() => {
      (ReserveEngine.latestAttestations as any).mockResolvedValue(attestedCash(100000));
    });

    async function fundedSeries(code: string) {
      const series = await openSeries(code);
      await SeriesOsEngine.assignAsset({
        seriesRef: series.series_id,
        assetKind: 'reserve_attestation',
        assetRef: 'circle_custody:circle-mint-business-account',
        assignedBy: MAKER,
      });
      return series;
    }

    it('allows a payment the series own assets cover', async () => {
      const series = await fundedSeries('S-ALPHA');
      const decision = await SeriesOsEngine.assertSeriesSpendable({
        seriesRef: series.series_id, amountCents: 50000, rail: 'wire',
      });
      expect(decision.allowed).toBe(true);
      expect(decision.shortfall).toBe(0);
    });

    it('blocks a series drawing on another series assets', async () => {
      await fundedSeries('S-ALPHA');
      const beta = await openSeries('S-BETA', { beneficiaryRef: 'BEN-2' });

      // The trust holds $1,000 of attested cash, but none of it is Beta's.
      await expect(SeriesOsEngine.assertSeriesSpendable({
        seriesRef: beta.series_id, amountCents: 50000, rail: 'wire',
      })).rejects.toThrow(/Ring-fence breach/);
    });

    it('permits the draw but reports the breach in warn mode', async () => {
      process.env.SERIES_RING_FENCE_ENFORCEMENT = 'warn';
      const beta = await openSeries('S-BETA', { beneficiaryRef: 'BEN-2' });
      const decision = await SeriesOsEngine.assertSeriesSpendable({
        seriesRef: beta.series_id, amountCents: 50000, rail: 'ach',
      });
      expect(decision.allowed).toBe(true);
      expect(decision.warning).toMatch(/Ring-fence breach/);
    });

    it('skips the check when enforcement is off', async () => {
      process.env.SERIES_RING_FENCE_ENFORCEMENT = 'off';
      const decision = await SeriesOsEngine.assertSeriesSpendable({
        seriesRef: 'S-NOT-A-SERIES', amountCents: 50000,
      });
      expect(decision.allowed).toBe(true);
      expect(decision.enforcement).toBe('off');
    });

    it('blocks a suspended series outright', async () => {
      const series = await fundedSeries('S-ALPHA');
      state.series[0].status = 'suspended';
      await expect(SeriesOsEngine.assertSeriesSpendable({
        seriesRef: series.series_id, amountCents: 100,
      })).rejects.toThrow(/suspended/);
    });

    it('runs the ring fence from the reserve gate a rail already calls', async () => {
      const alpha = await fundedSeries('S-ALPHA');
      const beta = await openSeries('S-BETA', { beneficiaryRef: 'BEN-2' });
      vi.spyOn(ReserveEngine, 'coverage').mockResolvedValue({
        status: 'partially_backed',
        attestedReserveCents: 100000,
        attestedReserve: 1000,
        pledgeableCollateralCents: 0,
        pledgeableCollateral: 0,
      });

      const allowed = await ReserveEngine.assertSpendable({
        amountCents: 50000, rail: 'wire', seriesId: alpha.series_id,
      });
      expect(allowed.allowed).toBe(true);
      expect(allowed.ringFence.seriesCode).toBe('S-ALPHA');

      // Trust-wide reserve covers it; Beta's own fence does not.
      await expect(ReserveEngine.assertSpendable({
        amountCents: 50000, rail: 'wire', seriesId: beta.series_id,
      })).rejects.toThrow(SeriesRingFenceError);
    });
  });

  describe('series event chain', () => {
    it('hash-chains structural actions and detects an altered one', async () => {
      (ReserveEngine.latestAttestations as any).mockResolvedValue(attestedCash(100000));
      const series = await openSeries('S-ALPHA');
      await SeriesOsEngine.assignAsset({
        seriesRef: series.series_id,
        assetKind: 'reserve_attestation',
        assetRef: 'circle_custody:circle-mint-business-account',
        assignedBy: MAKER,
      });

      const intact = await SeriesOsEngine.verifyChain();
      expect(intact.events).toBe(2);
      expect(intact.intact).toBe(true);

      state.events[1].series_id = 'SER-SOMEONE-ELSE';
      const tampered = await SeriesOsEngine.verifyChain();
      expect(tampered.intact).toBe(false);
      expect(tampered.breaks[0].sequence).toBe(2);
    });
  });
});

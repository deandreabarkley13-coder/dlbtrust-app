import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CustodyOsEngine } = require('../server/integrations/custody/custodyOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

interface FakeState {
  accounts: Row[];
  positions: Row[];
  receipts: Row[];
  events: Row[];
  attestations: Row[];
}

/**
 * In-memory stand-in for the custody tables. Only the statements the engine
 * issues are recognised; anything else returns no rows so an unhandled query
 * surfaces as a test failure rather than a false pass.
 */
function fakeDb(state: FakeState) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/i.test(text)) return { rows: [] };

    if (text.startsWith('INSERT INTO custody_accounts')) {
      const row = {
        custody_account_id: params[0],
        account_name: params[1],
        custody_type: params[2],
        custodian_name: params[3],
        custodian_account_ref: params[4],
        jurisdiction: params[5],
        notes: params[6],
        opened_by: params[7],
        status: 'active',
        created_at: new Date().toISOString(),
      };
      state.accounts.push(row);
      return { rows: [row] };
    }

    if (text.startsWith('SELECT * FROM custody_accounts WHERE')) {
      return { rows: state.accounts.filter((a) => a.custody_account_id === params[0]) };
    }

    if (text.includes('FROM custody_accounts WHERE status')) {
      return { rows: state.accounts.filter((a) => a.status === 'active') };
    }

    if (text.startsWith('INSERT INTO custody_positions')) {
      const existing = state.positions.find(
        (p) => p.custody_account_id === params[1] && p.instrument_ref === params[3]
      );
      if (existing) {
        Object.assign(existing, {
          asset_class: params[2],
          instrument_name: params[4] || existing.instrument_name,
          quantity: params[5],
          valuation_cents: params[6],
          control_status: 'unverified',
        });
        return { rows: [existing] };
      }
      const row = {
        position_id: params[0],
        custody_account_id: params[1],
        asset_class: params[2],
        instrument_ref: params[3],
        instrument_name: params[4],
        quantity: params[5],
        valuation_cents: params[6],
        control_status: 'unverified',
        last_receipt_id: null,
        created_at: new Date().toISOString(),
      };
      state.positions.push(row);
      return { rows: [row] };
    }

    if (text.includes('FROM custody_positions p') && text.includes('WHERE p.position_id')) {
      const position = state.positions.find((p) => p.position_id === params[0]);
      return { rows: position ? [join(state, position)] : [] };
    }

    if (text.includes('FROM custody_positions p')) {
      const rows = params.length
        ? state.positions.filter((p) => p.custody_account_id === params[0])
        : state.positions;
      return { rows: rows.map((p) => join(state, p)) };
    }

    if (text.startsWith('UPDATE custody_positions')) {
      const position = state.positions.find((p) => p.position_id === params[0]);
      if (position) {
        position.control_status = params[1];
        position.valuation_cents = params[2];
        position.last_receipt_id = params[3];
      }
      return { rows: position ? [position] : [] };
    }

    if (text.startsWith('INSERT INTO custody_receipts')) {
      const row = {
        receipt_id: params[0],
        position_id: params[1],
        action: params[2],
        valuation_cents: params[3],
        quantity: params[4],
        evidence_reference: params[5],
        proposed_by: params[6],
        required_signatures: params[7],
        signatures: [],
        status: 'pending',
        reserve_attestation_id: null,
        reserve_note: null,
        created_at: new Date().toISOString(),
        settled_at: null,
      };
      state.receipts.push(row);
      return { rows: [row] };
    }

    if (text.startsWith('SELECT * FROM custody_receipts WHERE')) {
      return { rows: state.receipts.filter((r) => r.receipt_id === params[0]) };
    }

    if (text.startsWith('UPDATE custody_receipts SET signatures')) {
      const receipt = state.receipts.find((r) => r.receipt_id === params[0]);
      if (receipt) receipt.signatures = JSON.parse(params[1]);
      return { rows: receipt ? [receipt] : [] };
    }

    if (text.startsWith("UPDATE custody_receipts SET status = 'countersigned'")) {
      const receipt = state.receipts.find((r) => r.receipt_id === params[0]);
      if (receipt) {
        Object.assign(receipt, {
          status: 'countersigned',
          signatures: JSON.parse(params[1]),
          reserve_attestation_id: params[2],
          reserve_note: params[3],
          settled_at: new Date().toISOString(),
        });
      }
      return { rows: receipt ? [receipt] : [] };
    }

    if (text.startsWith("UPDATE custody_receipts SET status = 'void'")) {
      const receipt = state.receipts.find((r) => r.receipt_id === params[0] && r.status === 'pending');
      if (receipt) Object.assign(receipt, { status: 'void', reserve_note: params[1] });
      return { rows: receipt ? [receipt] : [] };
    }

    if (text.includes('FROM custody_receipts r')) {
      const rows = text.includes('WHERE r.status')
        ? state.receipts.filter((r) => r.status === params[0])
        : state.receipts;
      return { rows: rows.map((r) => ({ ...r, ...positionFields(state, r.position_id) })) };
    }

    if (text.startsWith('INSERT INTO custody_events')) {
      const row = {
        sequence: state.events.length + 1,
        event_id: params[0],
        event_type: params[1],
        custody_account_id: params[2],
        position_id: params[3],
        receipt_id: params[4],
        actor: params[5],
        payload: params[6],
        prev_hash: params[7],
        event_hash: params[8],
        created_at: params[9],
      };
      state.events.push(row);
      return { rows: [row] };
    }

    if (text.includes('FROM custody_events ORDER BY sequence DESC LIMIT 1')) {
      const tip = state.events[state.events.length - 1];
      return { rows: tip ? [tip] : [] };
    }

    if (text.includes('FROM custody_events ORDER BY sequence ASC')) {
      return { rows: state.events };
    }

    if (text.includes('FROM custody_events ORDER BY sequence DESC')) {
      return { rows: state.events.slice().reverse() };
    }

    if (text.startsWith('INSERT INTO reserve_attestations')) {
      const row = {
        attestation_id: params[0],
        source_type: params[1],
        source_key: params[2],
        asset: params[3],
        balance_cents: params[4],
        verification: params[5],
        evidence_reference: params[7],
        attested_by: params[8],
        detail: params[9],
        asset_class: params[10],
        haircut_bps: params[11],
        observed_at: new Date().toISOString(),
      };
      state.attestations.push(row);
      return { rows: [row] };
    }

    if (text.includes('FROM reserve_attestations')) {
      const latest = new Map<string, Row>();
      for (const row of state.attestations) latest.set(`${row.source_type}:${row.source_key}`, row);
      return { rows: Array.from(latest.values()) };
    }

    return { rows: [] };
  });
}

function join(state: FakeState, position: Row) {
  const account = state.accounts.find((a) => a.custody_account_id === position.custody_account_id) || {};
  return {
    ...position,
    custody_type: account.custody_type,
    custodian_name: account.custodian_name,
    custodian_account_ref: account.custodian_account_ref,
    account_status: account.status,
  };
}

function positionFields(state: FakeState, positionId: string) {
  const position = state.positions.find((p) => p.position_id === positionId) || {};
  return {
    custody_account_id: position.custody_account_id,
    instrument_ref: position.instrument_ref,
    asset_class: position.asset_class,
  };
}

const MAKER = 'AnnRobinson1117@gmail.com';
const CHECKER = 'deandreabarkley13@gmail.com';

const ENV_KEYS = ['CUSTODY_REQUIRED_SIGNATURES', 'CUSTODY_RESERVE_SYNC', 'RESERVE_COLLATERAL_HAIRCUT_BPS'];

describe('custody OS engine', () => {
  let state: FakeState;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    state = { accounts: [], positions: [], receipts: [], events: [], attestations: [] };
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(pool, 'query').mockImplementation(fakeDb(state) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function selfCustodyAccount() {
    return CustodyOsEngine.openAccount({
      accountName: 'PTC Vault',
      custodyType: 'self_custody',
      openedBy: CHECKER,
    });
  }

  async function thirdPartyAccount() {
    return CustodyOsEngine.openAccount({
      accountName: 'Schwab Institutional',
      custodyType: 'third_party',
      custodianName: 'Charles Schwab & Co.',
      custodianAccountRef: 'SCHWAB-8842',
      openedBy: CHECKER,
    });
  }

  describe('custody accounts', () => {
    it('refuses a third-party account with no named custodian or account reference', async () => {
      await expect(CustodyOsEngine.openAccount({
        accountName: 'Somewhere',
        custodyType: 'third_party',
        openedBy: CHECKER,
      })).rejects.toThrow(/requires custodianName/);

      await expect(CustodyOsEngine.openAccount({
        accountName: 'Somewhere',
        custodyType: 'third_party',
        custodianName: 'Charles Schwab & Co.',
        openedBy: CHECKER,
      })).rejects.toThrow(/requires custodianAccountRef/);
    });

    it('refuses an unsupported custody type', async () => {
      await expect(CustodyOsEngine.openAccount({
        accountName: 'Ledger',
        custodyType: 'canonical',
        openedBy: CHECKER,
      })).rejects.toThrow(/custodyType must be one of/);
    });
  });

  describe('positions and receipts', () => {
    it('books a position as unverified until a receipt is countersigned', async () => {
      const account = await thirdPartyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'fixed_income',
        instrumentRef: 'US912810TM09',
        valuationCents: 25000000,
        recordedBy: MAKER,
      });
      expect(position.control_status).toBe('unverified');

      const statement = await CustodyOsEngine.statement();
      expect(statement.heldCents).toBe(25000000);
      expect(statement.thirdPartyReceiptedCents).toBe(0);
      expect(statement.unreceiptedCents).toBe(25000000);
    });

    it('refuses a receipt with no documentary evidence', async () => {
      const account = await thirdPartyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'cash',
        instrumentRef: 'Betterment Trust Checking',
        valuationCents: 100000,
        recordedBy: MAKER,
      });
      await expect(CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        proposedBy: MAKER,
      })).rejects.toThrow(/evidence reference/);
    });

    it('needs two distinct trustees and rejects a double signature', async () => {
      const account = await thirdPartyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'cash',
        instrumentRef: 'Betterment Trust Checking',
        valuationCents: 100000,
        recordedBy: MAKER,
      });
      const receipt = await CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        evidenceReference: 'BETTERMENT-STMT-2026-08',
        proposedBy: MAKER,
      });

      const first = await CustodyOsEngine.countersignReceipt(receipt.receipt_id, MAKER);
      expect(first.status).toBe('pending');
      expect(first.remainingSignatures).toBe(1);

      await expect(CustodyOsEngine.countersignReceipt(receipt.receipt_id, MAKER))
        .rejects.toThrow(/has already signed/);

      const settled = await CustodyOsEngine.countersignReceipt(receipt.receipt_id, CHECKER);
      expect(settled.status).toBe('countersigned');
      expect(settled.controlStatus).toBe('receipted');
    });
  });

  describe('reserve linkage', () => {
    it('records a reserve attestation for a countersigned third-party position', async () => {
      const account = await thirdPartyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'cash',
        instrumentRef: 'Betterment Trust Checking',
        valuationCents: 100000,
        recordedBy: MAKER,
      });
      const receipt = await CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        evidenceReference: 'BETTERMENT-STMT-2026-08',
        proposedBy: MAKER,
      });
      await CustodyOsEngine.countersignReceipt(receipt.receipt_id, MAKER);
      const settled = await CustodyOsEngine.countersignReceipt(receipt.receipt_id, CHECKER);

      expect(settled.reserve.attestationId).toBeTruthy();
      const attestation = state.attestations[0];
      expect(attestation.source_type).toBe('custodian_statement');
      expect(attestation.asset_class).toBe('cash');
      expect(attestation.balance_cents).toBe(100000);

      const coverage = await ReserveEngine.coverage();
      expect(coverage.attestedReserveCents).toBe(100000);
    });

    it('books a third-party bond as fixed income collateral, never as cash', async () => {
      const account = await thirdPartyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'fixed_income',
        instrumentRef: 'US912810TM09',
        valuationCents: 25000000,
        recordedBy: MAKER,
      });
      const receipt = await CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        evidenceReference: 'SCHWAB-STMT-2026-08',
        proposedBy: MAKER,
      });
      await CustodyOsEngine.countersignReceipt(receipt.receipt_id, MAKER);
      await CustodyOsEngine.countersignReceipt(receipt.receipt_id, CHECKER);

      expect(state.attestations[0].source_type).toBe('securities_custodian');
      expect(state.attestations[0].asset_class).toBe('fixed_income');
      const coverage = await ReserveEngine.coverage();
      expect(coverage.attestedReserveCents).toBe(0);
      expect(coverage.spendableCents).toBe(0);
    });

    it('never turns a self-custody receipt into a reserve', async () => {
      const account = await selfCustodyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'fixed_income',
        instrumentRef: 'DLB-PRB',
        instrumentName: 'DLB Private Placement Bond',
        valuationCents: 10000000000,
        recordedBy: MAKER,
      });
      const receipt = await CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        evidenceReference: 'TRUST-VAULT-LOG-14',
        proposedBy: MAKER,
      });
      await CustodyOsEngine.countersignReceipt(receipt.receipt_id, MAKER);
      const settled = await CustodyOsEngine.countersignReceipt(receipt.receipt_id, CHECKER);

      // Two trustees signed, the position is a custody record of the trust's own
      // instrument, and the reserve is untouched.
      expect(settled.controlStatus).toBe('receipted');
      expect(settled.reserve.attestationId).toBeNull();
      expect(settled.reserve.note).toMatch(/internal record/);
      expect(state.attestations).toHaveLength(0);

      const statement = await CustodyOsEngine.statement();
      expect(statement.selfCustodyCents).toBe(10000000000);
      expect(statement.thirdPartyReceiptedCents).toBe(0);
      expect(statement.note).toMatch(/backs an external payment/);
    });

    it('zeroes the reserve when custody of a position is released', async () => {
      const account = await thirdPartyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'cash',
        instrumentRef: 'Betterment Trust Checking',
        valuationCents: 100000,
        recordedBy: MAKER,
      });
      const safekeeping = await CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        evidenceReference: 'BETTERMENT-STMT-2026-08',
        proposedBy: MAKER,
      });
      await CustodyOsEngine.countersignReceipt(safekeeping.receipt_id, MAKER);
      await CustodyOsEngine.countersignReceipt(safekeeping.receipt_id, CHECKER);

      const release = await CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        action: 'release',
        evidenceReference: 'BETTERMENT-CLOSE-2026-09',
        proposedBy: MAKER,
      });
      await CustodyOsEngine.countersignReceipt(release.receipt_id, MAKER);
      const settled = await CustodyOsEngine.countersignReceipt(release.receipt_id, CHECKER);

      expect(settled.controlStatus).toBe('released');
      const coverage = await ReserveEngine.coverage();
      expect(coverage.attestedReserveCents).toBe(0);
    });

    it('keeps physical and digital holdings out of the USD reserve', async () => {
      const account = await thirdPartyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'physical',
        instrumentRef: 'DEED-CUY-2026-114',
        valuationCents: 45000000,
        recordedBy: MAKER,
      });
      const receipt = await CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        evidenceReference: 'TITLE-CO-STMT-9',
        proposedBy: MAKER,
      });
      await CustodyOsEngine.countersignReceipt(receipt.receipt_id, MAKER);
      const settled = await CustodyOsEngine.countersignReceipt(receipt.receipt_id, CHECKER);

      expect(settled.reserve.attestationId).toBeNull();
      expect(settled.reserve.note).toMatch(/not a USD reserve source/);
      expect(state.attestations).toHaveLength(0);
    });
  });

  describe('chain of title', () => {
    it('hash-chains every custody event and detects an altered one', async () => {
      const account = await thirdPartyAccount();
      const position = await CustodyOsEngine.recordPosition({
        custodyAccountId: account.custody_account_id,
        assetClass: 'cash',
        instrumentRef: 'Betterment Trust Checking',
        valuationCents: 100000,
        recordedBy: MAKER,
      });
      await CustodyOsEngine.proposeReceipt({
        positionId: position.position_id,
        evidenceReference: 'BETTERMENT-STMT-2026-08',
        proposedBy: MAKER,
      });

      const intact = await CustodyOsEngine.verifyChain();
      expect(intact.events).toBe(3);
      expect(intact.intact).toBe(true);

      state.events[1].payload = JSON.stringify({ valuationCents: 999999999 });
      const tampered = await CustodyOsEngine.verifyChain();
      expect(tampered.intact).toBe(false);
      expect(tampered.breaks[0].sequence).toBe(2);
    });
  });
});

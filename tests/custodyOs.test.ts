import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CustodyOsEngine } = require('../server/integrations/custody/custodyOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

interface FakeState {
  accounts: Row[];
  positions: Row[];
  receipts: Row[];
  events: Row[];
  attestations: Row[];
  trustAccounts: Row[];
  trustAccountCreationCashReady: boolean[];
  journalEntries: Row[];
  journalLines: Row[];
  cashAccounts: Row[];
  cashMovements: Row[];
  collateralPositions: Row[];
  bonds: Row[];
  distributions: Row[];
  tablesMissing: boolean;
}

/**
 * In-memory stand-in for the custody tables. Only the statements the engine
 * issues are recognised; anything else returns no rows so an unhandled query
 * surfaces as a test failure rather than a false pass.
 */
function fakeDb(state: FakeState) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };

    if (text.startsWith('SELECT * FROM trust_accounts WHERE account_code')) {
      const account = state.trustAccounts.find((row) => row.account_code === params[0]);
      return { rows: account ? [account] : [] };
    }

    if (text.startsWith('INSERT INTO trust_accounts')) {
      state.trustAccountCreationCashReady.push(state.cashAccounts.some(
        (row) => row.account_id === params[5]
      ));
      const row = {
        account_code: params[0],
        account_name: params[1],
        account_type: params[2],
        sub_type: params[3],
        linked_cash_account: params[5],
        linked_fineract_gl: params[6],
        description: params[7],
        balance: 0,
        is_active: true,
      };
      state.trustAccounts.push(row);
      return { rows: [row] };
    }

    if (text.startsWith('SELECT account_type FROM trust_accounts')) {
      const account = state.trustAccounts.find((row) => row.account_code === params[0]);
      return { rows: account ? [{ account_type: account.account_type }] : [] };
    }

    if (text.startsWith('UPDATE trust_accounts SET balance')) {
      const account = state.trustAccounts.find((row) => row.account_code === params[1]);
      if (account) account.balance += Number(params[0]);
      return { rows: [] };
    }

    if (text.startsWith('INSERT INTO trust_journal_entries')) {
      state.journalEntries.push({
        entry_id: params[0],
        entry_date: params[1],
        description: params[2],
        reference_type: params[3],
        reference_id: params[4],
        bond_id: params[5],
        posted_by: params[6],
        status: 'posted',
      });
      return { rows: [] };
    }

    if (text.startsWith('INSERT INTO trust_journal_lines')) {
      state.journalLines.push({
        id: state.journalLines.length + 1,
        entry_id: params[0],
        account_code: params[1],
        debit_amount: params[2],
        credit_amount: params[3],
        memo: params[4],
      });
      return { rows: [] };
    }

    if (text.startsWith('SELECT * FROM trust_journal_entries WHERE entry_id')) {
      const entry = state.journalEntries.find((row) => row.entry_id === params[0]);
      return { rows: entry ? [entry] : [] };
    }

    if (text.startsWith('SELECT * FROM trust_journal_lines WHERE entry_id')) {
      return { rows: state.journalLines.filter((row) => row.entry_id === params[0]) };
    }

    if (text.startsWith('SELECT entry_id FROM trust_journal_entries')) {
      const entry = state.journalEntries.find((row) => (
        row.reference_type === 'custody_receipt'
        && row.reference_id === String(params[0])
        && row.status === 'posted'
      ));
      return { rows: entry ? [{ entry_id: entry.entry_id }] : [] };
    }

    if (text.startsWith('SELECT * FROM cash_accounts WHERE account_id')) {
      const account = state.cashAccounts.find((row) => row.account_id === params[0]);
      return { rows: account ? [account] : [] };
    }

    if (text.startsWith('INSERT INTO cash_accounts')) {
      const row = {
        account_id: params[0],
        account_name: params[1],
        account_type: params[2],
        linked_fineract_account_id: params[3],
        notes: params[4],
        balance_cents: 0,
        status: 'active',
      };
      state.cashAccounts.push(row);
      return { rows: [row] };
    }

    if (text.startsWith('SELECT movement_id FROM cash_movements')) {
      const movement = state.cashMovements.find((row) => row.reference_id === String(params[0]));
      return { rows: movement ? [{ movement_id: movement.movement_id }] : [] };
    }

    if (text.startsWith('UPDATE cash_accounts SET balance_cents = balance_cents +')) {
      const account = state.cashAccounts.find((row) => row.account_id === params[1]);
      if (account) {
        account.balance_cents += Number(params[0]);
        return { rows: [account] };
      }
      return { rows: [] };
    }

    if (text.startsWith('INSERT INTO cash_movements')) {
      const row = {
        movement_id: params[0],
        to_account_id: params[1],
        amount_cents: params[2],
        movement_type: 'deposit',
        reference_id: params[3] === undefined || params[3] === null ? null : String(params[3]),
        memo: params[4],
        initiated_by: params[5],
      };
      state.cashMovements.push(row);
      return { rows: [row] };
    }

    if (text.includes('FROM bonds b')) {
      if (state.tablesMissing) {
        throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      }
      return { rows: state.bonds };
    }

    if (text.includes('FROM fixed_income_distributions')) {
      if (state.tablesMissing) {
        throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      }
      const groups = new Map<string, Row>();
      for (const row of state.distributions) {
        const key = `${row.bond_id || 'trust'}:${row.bucket}:${row.status}`;
        const current = groups.get(key) || {
          bond_id: row.bond_id || null,
          bucket: row.bucket,
          status: row.status,
          amount: 0,
          count: 0,
        };
        current.amount += Number(row.amount_usd || 0);
        current.count += 1;
        groups.set(key, current);
      }
      return { rows: Array.from(groups.values()) };
    }

    if (text.includes('FROM collateral_positions') && text.includes("status = 'pledged'")) {
      return { rows: state.collateralPositions };
    }

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

    if (text.includes("event_type = 'fixed_income_synced'")) {
      const matching = state.events.filter((event) => event.event_type === 'fixed_income_synced');
      return { rows: matching.length ? [matching[matching.length - 1]] : [] };
    }

    if (text.includes("event_type = 'collateral_synced'")) {
      const matching = state.events.filter((event) => event.event_type === 'collateral_synced');
      return { rows: matching.length ? [matching[matching.length - 1]] : [] };
    }

    if (text.startsWith('SELECT * FROM custody_events ORDER BY sequence ASC FOR UPDATE')) {
      return { rows: state.events };
    }

    if (text.startsWith('UPDATE custody_events SET prev_hash')) {
      const event = state.events.find((row) => row.sequence === params[0]);
      if (event) {
        event.prev_hash = params[1];
        event.event_hash = params[2];
      }
      return { rows: [] };
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
    state = {
      accounts: [],
      positions: [],
      receipts: [],
      events: [],
      attestations: [],
      trustAccounts: [],
      trustAccountCreationCashReady: [],
      journalEntries: [],
      journalLines: [],
      cashAccounts: [],
      cashMovements: [],
      collateralPositions: [],
      bonds: [],
      distributions: [],
      tablesMissing: false,
    };
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(pool, 'query').mockImplementation(fakeDb(state) as any);
    const query = (pool.query as any).getMockImplementation();
    vi.spyOn(pool, 'connect').mockResolvedValue({
      query,
      release: vi.fn(),
    } as any);
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

  describe('fixed income feed', () => {
    it('treats missing bond and distribution tables as empty', async () => {
      state.tablesMissing = true;

      const result = await CustodyOsEngine.syncFixedIncome();

      expect(result.bonds).toBe(0);
      expect(result.cashBuckets).toBe(0);
      expect(result.created).toEqual([]);
      expect(state.accounts).toHaveLength(1);
      expect(state.accounts[0].custody_account_id).toBe('CUS-ISSUER-FIXED-INCOME');
    });

    it('mirrors an active bond and open distributions into the issuer register as unverified self-custody positions', async () => {
      state.bonds = [{
        id: 1,
        bond_name: 'Series A',
        isin: null,
        issuer: 'X',
        face_value: '100000000.00',
        status: 'active',
        principal_balance: '98524627.51',
        accrued_interest: '2560209.60',
      }];
      state.distributions = [
        { bond_id: 1, bucket: 'coupon_income', status: 'planned', amount_usd: 500 },
        { bond_id: 1, bucket: 'coupon_income', status: 'planned', amount_usd: 250 },
        { bond_id: 1, bucket: 'trust_operating', status: 'executed', amount_usd: 100 },
      ];

      const result = await CustodyOsEngine.syncFixedIncome();

      expect(result.created).toEqual(['BOND-1', 'FID-1-coupon_income']);
      expect(state.positions.find((p) => p.instrument_ref === 'BOND-1')).toMatchObject({
        asset_class: 'fixed_income',
        valuation_cents: 10108483711,
        quantity: 100000000,
      });
      expect(state.positions.find((p) => p.instrument_ref === 'FID-1-coupon_income')).toMatchObject({
        asset_class: 'cash',
        valuation_cents: 75000,
        quantity: 2,
      });
      expect(state.positions.some((p) => p.instrument_ref === 'FID-1-trust_operating')).toBe(false);
      expect(state.accounts[0].custody_type).toBe('self_custody');
      expect(state.receipts).toHaveLength(2);
      expect(state.receipts.every((r) => r.status === 'pending')).toBe(true);
      expect(state.receipts.map((r) => r.evidence_reference)).toEqual([
        'bonds:1',
        'fixed_income_distributions:1:coupon_income',
      ]);
      expect(state.positions.every((p) => p.control_status === 'unverified')).toBe(true);
    });

    it('is idempotent and leaves a countersigned position alone', async () => {
      state.bonds = [{
        id: 1,
        bond_name: 'Series A',
        isin: null,
        face_value: '100000000.00',
        status: 'active',
        principal_balance: '98524627.51',
        accrued_interest: '2560209.60',
      }];
      state.distributions = [
        { bond_id: 1, bucket: 'coupon_income', status: 'planned', amount_usd: 500 },
      ];
      await CustodyOsEngine.syncFixedIncome();
      const bondReceipt = state.receipts.find((r) => r.evidence_reference === 'bonds:1');
      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, MAKER);
      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, CHECKER);
      const eventsAfterFirstSync = state.events.length;

      const result = await CustodyOsEngine.syncFixedIncome();

      expect(result.unchanged).toBe(2);
      expect(result.receiptsProposed).toBe(0);
      expect(state.events.length).toBe(eventsAfterFirstSync);
      expect(state.positions.find((p) => p.instrument_ref === 'BOND-1').control_status).toBe('receipted');
    });

    it('revalues when accrued interest moves and proposes a revaluation receipt', async () => {
      state.bonds = [{
        id: 1,
        bond_name: 'Series A',
        isin: null,
        face_value: '100000000.00',
        status: 'active',
        principal_balance: '98524627.51',
        accrued_interest: '2560209.60',
      }];
      await CustodyOsEngine.syncFixedIncome();
      const bondReceipt = state.receipts.find((r) => r.evidence_reference === 'bonds:1');
      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, MAKER);
      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, CHECKER);
      state.bonds[0].accrued_interest = '2600000.00';

      const result = await CustodyOsEngine.syncFixedIncome();

      expect(result.revalued).toEqual(['BOND-1']);
      expect(state.receipts.some((r) => r.action === 'revaluation')).toBe(true);
      expect(state.positions.find((p) => p.instrument_ref === 'BOND-1').valuation_cents).toBe(10112462751);
    });

    it('books the full valuation when a revaluation is the first countersigned receipt', async () => {
      state.bonds = [{
        id: 1,
        bond_name: 'Series A',
        isin: null,
        face_value: '100000000.00',
        status: 'active',
        principal_balance: '98524627.51',
        accrued_interest: '2560209.60',
      }];
      await CustodyOsEngine.syncFixedIncome({ proposeReceipts: false });
      state.bonds[0].accrued_interest = '2600000.00';
      const result = await CustodyOsEngine.syncFixedIncome();
      expect(result.revalued).toEqual(['BOND-1']);

      const receipt = state.receipts.find((r) => r.action === 'revaluation');
      await CustodyOsEngine.countersignReceipt(receipt.receipt_id, MAKER);
      const settled = await CustodyOsEngine.countersignReceipt(receipt.receipt_id, CHECKER);

      expect(settled.accounting.status).toBe('booked');
      expect(state.journalLines).toHaveLength(2);
      expect(state.journalLines.reduce((sum, line) => sum + Number(line.debit_amount), 0))
        .toBe(101124627.51);
      expect(state.journalLines.reduce((sum, line) => sum + Number(line.credit_amount), 0))
        .toBe(101124627.51);
    });

    it('does not stack receipts while one is pending', async () => {
      state.bonds = [{
        id: 1,
        bond_name: 'Series A',
        isin: null,
        face_value: '100000000.00',
        status: 'active',
        principal_balance: '98524627.51',
        accrued_interest: '2560209.60',
      }];
      await CustodyOsEngine.syncFixedIncome();

      state.bonds[0].accrued_interest = '2600000.00';
      const first = await CustodyOsEngine.syncFixedIncome();
      state.bonds[0].accrued_interest = '2700000.00';
      const second = await CustodyOsEngine.syncFixedIncome();

      expect(first.revalued).toEqual(['BOND-1']);
      expect(second.revalued).toEqual(['BOND-1']);
      expect(state.receipts.filter((r) => (
        r.position_id === state.positions.find((p) => p.instrument_ref === 'BOND-1').position_id
        && r.status === 'pending'
      ))).toHaveLength(1);
      expect(state.receipts.find((r) => r.evidence_reference === 'bonds:1').action).toBe('safekeeping');
      expect(state.positions.find((p) => p.instrument_ref === 'BOND-1').valuation_cents).toBe(10122462751);
    });

    it('proposes a release when a bond is called and does not re-record it', async () => {
      state.bonds = [{
        id: 1,
        bond_name: 'Series A',
        isin: null,
        face_value: '100000000.00',
        status: 'active',
        principal_balance: '98524627.51',
        accrued_interest: '2560209.60',
      }];
      await CustodyOsEngine.syncFixedIncome();
      const bondReceipt = state.receipts.find((r) => r.evidence_reference === 'bonds:1');
      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, MAKER);
      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, CHECKER);
      state.bonds[0].status = 'called';
      const valuation = state.positions.find((p) => p.instrument_ref === 'BOND-1').valuation_cents;

      const result = await CustodyOsEngine.syncFixedIncome();
      const third = await CustodyOsEngine.syncFixedIncome();

      expect(result.released).toEqual(['BOND-1']);
      expect(state.receipts.filter((r) => r.action === 'release')).toHaveLength(1);
      expect(state.positions.find((p) => p.instrument_ref === 'BOND-1').valuation_cents).toBe(valuation);
      expect(third.released).toEqual([]);
      expect(state.receipts.filter((r) => r.action === 'release')).toHaveLength(1);
    });

    it('never raises the reserve from the issuer register', async () => {
      state.bonds = [{
        id: 1,
        bond_name: 'Series A',
        isin: null,
        face_value: '100000000.00',
        status: 'active',
        principal_balance: '98524627.51',
        accrued_interest: '2560209.60',
      }];
      await CustodyOsEngine.syncFixedIncome();
      const bondReceipt = state.receipts.find((r) => r.evidence_reference === 'bonds:1');

      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, MAKER);
      const result = await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, CHECKER);

      expect(result.reserve.attestationId).toBeNull();
      expect(state.attestations).toHaveLength(0);
    });
  });

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

    it('provisions valid custody GL subtypes after creating the cash mirror', async () => {
      const result = await CustodyOsEngine.ensureAccountingAccounts();

      expect(result.status).toBe('ready');
      expect(state.cashAccounts).toHaveLength(1);
      expect(state.cashAccounts[0].account_id).toBe('CUS-THIRD-PARTY-CASH');
      expect(state.trustAccounts).toHaveLength(2);
      expect(state.trustAccounts[0]).toMatchObject({
        account_code: '1250',
        sub_type: 'investment',
        linked_cash_account: 'CUS-THIRD-PARTY-CASH',
      });
      expect(state.trustAccounts[1]).toMatchObject({
        account_code: '1251',
        sub_type: 'other',
      });
      expect(state.trustAccountCreationCashReady[0]).toBe(true);

      await CustodyOsEngine.ensureAccountingAccounts();
      expect(state.cashAccounts).toHaveLength(1);
      expect(state.trustAccounts).toHaveLength(2);
    });

    it('posts a balanced custody journal once when a receipt is countersigned', async () => {
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
      const settled = await CustodyOsEngine.countersignReceipt(receipt.receipt_id, CHECKER);

      expect(settled.accounting.status).toBe('booked');
      expect(state.journalEntries).toHaveLength(1);
      expect(state.journalEntries[0]).toMatchObject({
        reference_type: 'custody_receipt',
        reference_id: receipt.receipt_id,
      });
      expect(state.journalLines).toHaveLength(2);
      expect(state.journalLines.reduce((sum, line) => sum + Number(line.debit_amount), 0))
        .toBe(250000);
      expect(state.journalLines.reduce((sum, line) => sum + Number(line.credit_amount), 0))
        .toBe(250000);

      await expect(CustodyOsEngine.countersignReceipt(receipt.receipt_id, 'replay'))
        .rejects.toThrow(/already countersigned/);
      expect(state.journalEntries).toHaveLength(1);
    });

    it('still countersigns when accounting is unavailable', async () => {
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
      const original = TrustAccountingEngine.postJournalEntry;
      TrustAccountingEngine.postJournalEntry = undefined;
      try {
        await CustodyOsEngine.countersignReceipt(receipt.receipt_id, MAKER);
        const settled = await CustodyOsEngine.countersignReceipt(receipt.receipt_id, CHECKER);
        expect(settled.status).toBe('countersigned');
        expect(settled.accounting.status).toBe('accounting_unavailable');
      } finally {
        TrustAccountingEngine.postJournalEntry = original;
      }
    });

    it('syncs third-party cash to CashEngine but excludes self-custody cash', async () => {
      const thirdParty = await thirdPartyAccount();
      const externalPosition = await CustodyOsEngine.recordPosition({
        custodyAccountId: thirdParty.custody_account_id,
        assetClass: 'cash',
        instrumentRef: 'SCHWAB-CASH',
        valuationCents: 100000,
        recordedBy: MAKER,
      });
      const externalReceipt = await CustodyOsEngine.proposeReceipt({
        positionId: externalPosition.position_id,
        evidenceReference: 'SCHWAB-CASH-2026-08',
        proposedBy: MAKER,
      });
      await CustodyOsEngine.countersignReceipt(externalReceipt.receipt_id, MAKER);
      const externalSettled = await CustodyOsEngine.countersignReceipt(externalReceipt.receipt_id, CHECKER);

      expect(externalSettled.cash.status).toBe('synced');
      expect(state.cashAccounts[0].account_id).toBe('CUS-THIRD-PARTY-CASH');
      expect(state.cashMovements).toHaveLength(1);
      expect(state.cashMovements[0].amount_cents).toBe(100000);

      const self = await selfCustodyAccount();
      const selfPosition = await CustodyOsEngine.recordPosition({
        custodyAccountId: self.custody_account_id,
        assetClass: 'cash',
        instrumentRef: 'TRUST-CASH',
        valuationCents: 50000,
        recordedBy: MAKER,
      });
      const selfReceipt = await CustodyOsEngine.proposeReceipt({
        positionId: selfPosition.position_id,
        evidenceReference: 'TRUST-CASH-LOG',
        proposedBy: MAKER,
      });
      await CustodyOsEngine.countersignReceipt(selfReceipt.receipt_id, MAKER);
      const selfSettled = await CustodyOsEngine.countersignReceipt(selfReceipt.receipt_id, CHECKER);
      expect(selfSettled.cash.status).toBe('not_applicable');
      expect(state.cashMovements).toHaveLength(1);
    });
  });

  describe('collateral feed', () => {
    it('mirrors pledged collateral and proposes a release when it disappears', async () => {
      state.collateralPositions = [{
        position_id: 'COLL-1',
        token_symbol: 'DLB-PRB',
        token_address: '0xabc',
        chain_id: 8453,
        decimals: 6,
        quantity_units: '1250000',
        value_usd: '42.50',
        status: 'pledged',
        custody_wallet: '0xwallet',
      }];

      const result = await CustodyOsEngine.syncCollateral();
      expect(result.created).toEqual(['COL-COLL-1']);
      expect(state.positions[0]).toMatchObject({
        asset_class: 'digital_asset',
        quantity: 1.25,
        valuation_cents: 4250,
      });
      expect(state.receipts[0]).toMatchObject({
        action: 'safekeeping',
        evidence_reference: 'collateral_positions:COLL-1',
      });
      await CustodyOsEngine.countersignReceipt(state.receipts[0].receipt_id, MAKER);
      await CustodyOsEngine.countersignReceipt(state.receipts[0].receipt_id, CHECKER);

      state.collateralPositions = [];
      const released = await CustodyOsEngine.syncCollateral();
      expect(released.released).toEqual(['COL-COLL-1']);
      expect(state.receipts.filter((receipt) => receipt.action === 'release')).toHaveLength(1);
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
    it('verifies the chain when Postgres returns payload keys in a different order', async () => {
      state.bonds = [{
        id: 1,
        bond_name: 'Series A',
        isin: null,
        face_value: '100000000.00',
        status: 'active',
        principal_balance: '98524627.51',
        accrued_interest: '2560209.60',
      }];
      await CustodyOsEngine.syncFixedIncome();
      const bondReceipt = state.receipts.find((r) => r.evidence_reference === 'bonds:1');
      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, MAKER);
      await CustodyOsEngine.countersignReceipt(bondReceipt.receipt_id, CHECKER);

      for (const event of state.events) {
        const payload = typeof event.payload === 'string'
          ? JSON.parse(event.payload)
          : event.payload;
        event.payload = Object.fromEntries(Object.entries(payload).reverse());
      }

      const intact = await CustodyOsEngine.verifyChain();
      expect(intact.intact).toBe(true);
    });

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

    it('reseals hash-function changes and detects later payload edits', async () => {
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
      state.events[0].event_hash = 'old-hash-one';
      state.events[1].event_hash = 'old-hash-two';
      const broken = await CustodyOsEngine.verifyChain();
      expect(broken.intact).toBe(false);

      const resealed = await CustodyOsEngine.resealChain({
        actor: CHECKER,
        reason: 'Canonical JSONB hash migration',
      });
      expect(resealed.intact).toBe(true);
      expect(state.events.at(-1).event_type).toBe('chain_resealed');
      expect(JSON.parse(state.events.at(-1).payload)).toMatchObject({
        events: 3,
        rewritten: 2,
        reason: 'Canonical JSONB hash migration',
      });

      state.events[0].payload = JSON.stringify({ valuationCents: 999999999 });
      const tampered = await CustodyOsEngine.verifyChain();
      expect(tampered.intact).toBe(false);
    });
  });
});

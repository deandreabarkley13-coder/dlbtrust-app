import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { VenueDepositoryOsEngine } = require('../server/integrations/os/venueDepositoryOsEngine');
const { VenueAccountOsEngine } = require('../server/integrations/os/venueAccountOsEngine');
const { BankingAggregator } = require('../server/integrations/aggregator/bankingAggregator');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const { DataBridge } = require('../server/integrations/accounting/dataBridge');
const pool = require('../server/integrations/bonds/pgPool');

const VENUE = 'VENUE-DEPOSITORY-A1B2C3';
const CONN = 'AGG-CHASE-1';
const ACCT = 'chk-001';

function venueRow(overrides: any = {}) {
  return {
    venue_id: VENUE,
    provider: 'depository',
    kind: 'depository',
    label: 'Trust checking',
    status: 'approved',
    external_reference: null,
    registered_by: 'trustee-one@example.com',
    approved_by: 'trustee-two@example.com',
    evidence_reference: 'bank-welcome-letter',
    last_balance_cents: null,
    last_verification: null,
    last_probe_reason: null,
    last_probed_at: null,
    suspended_reason: null,
    metadata: {},
    ...overrides,
  };
}

function linkRow(overrides: any = {}) {
  return {
    venue_id: VENUE,
    connection_id: CONN,
    external_account_id: ACCT,
    gl_account_code: '1000',
    linked_by: 'trustee-one@example.com',
    last_reconciled_at: null,
    last_difference_cents: null,
    metadata: {},
    ...overrides,
  };
}

function aggregatorAccount(overrides: any = {}) {
  return {
    id: 'acct-row-1',
    connection_id: CONN,
    external_account_id: ACCT,
    name: 'Business Checking',
    account_type: 'checking',
    mask: '4321',
    currency: 'USD',
    balance_current: '12500.50',
    balance_available: '12000.00',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** A database that answers the engine's questions and keeps its writes. */
function database({ venues = [] as any[], links = [] as any[], glAccounts = [] as any[], discrepancies = [] as any[] } = {}) {
  const writes: any[] = [];
  const query = async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/CREATE (TABLE|INDEX)/.test(text)) return { rows: [] } as any;

    if (/INSERT INTO venue_depository_links/.test(text)) {
      const row = linkRow({ venue_id: params[0], connection_id: params[1], external_account_id: params[2], gl_account_code: params[3], linked_by: params[4] });
      writes.push({ op: 'link', row });
      return { rows: [row] } as any;
    }
    if (/DELETE FROM venue_depository_links/.test(text)) {
      const found = links.filter(l => l.venue_id === params[0]);
      writes.push({ op: 'unlink', params });
      return { rows: found } as any;
    }
    if (/UPDATE venue_depository_links/.test(text)) { writes.push({ op: 'reconciled', params }); return { rows: [] } as any; }
    if (/FROM venue_depository_links WHERE venue_id/.test(text)) return { rows: links.filter(l => l.venue_id === params[0]) } as any;
    if (/FROM venue_depository_links/.test(text)) return { rows: links } as any;

    if (/UPDATE venue_accounts/.test(text)) {
      writes.push({ op: 'venue_update', sql: text, params });
      return { rows: [venues[0] || venueRow()] } as any;
    }
    if (/FROM venue_accounts WHERE venue_id/.test(text)) return { rows: venues.filter(v => v.venue_id === params[0]) } as any;
    if (/FROM venue_accounts/.test(text)) return { rows: venues } as any;

    if (/FROM trust_accounts WHERE account_code/.test(text)) return { rows: glAccounts.filter(g => g.account_code === params[0]) } as any;

    if (/INSERT INTO data_bridge_sync_log/.test(text)) { writes.push({ op: 'sync_log', params }); return { rows: [] } as any; }
    if (/INSERT INTO data_bridge_discrepancies/.test(text)) { writes.push({ op: 'discrepancy', params }); return { rows: [] } as any; }
    if (/UPDATE data_bridge_discrepancies/.test(text)) { writes.push({ op: 'discrepancy_resolved', params }); return { rows: [] } as any; }
    if (/COUNT\(\*\) AS c FROM data_bridge_discrepancies/.test(text)) return { rows: [{ c: String(discrepancies.length) }] } as any;
    if (/FROM data_bridge_discrepancies/.test(text)) return { rows: discrepancies } as any;
    if (/COUNT\(\*\) AS c/.test(text)) return { rows: [{ c: '0' }] } as any;
    return { rows: [] } as any;
  };
  vi.spyOn(pool, 'query').mockImplementation(query);
  vi.spyOn(pool, 'connect').mockResolvedValue({ query, release: () => {} } as any);
  return writes;
}

function aggregator({ connection = { id: CONN, name: 'Chase', connector_type: 'plaid' } as any, accounts = [aggregatorAccount()] as any[] } = {}) {
  vi.spyOn(BankingAggregator, 'getConnection').mockImplementation(async (id: any) => (connection && id === connection.id ? connection : null));
  vi.spyOn(BankingAggregator, 'listAccounts').mockImplementation(async (id: any) => (connection && id === connection.id ? accounts : []));
  return vi.spyOn(BankingAggregator, 'pull').mockResolvedValue({ errors: [] });
}

const glCash = { account_code: '1000', account_name: 'Cash - Operating', account_type: 'asset', sub_type: 'cash', balance: '12500.50' };

describe('Venue Depository OS: the trust’s own bank accounts in the unified data workflow', () => {
  const saved = { ...process.env };
  let reserve: any;

  beforeEach(() => {
    reserve = vi.spyOn(ReserveEngine, 'record').mockResolvedValue({ attestation_id: 'RSV-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  describe('linking', () => {
    it('joins a depository venue to an aggregator account and a cash GL account', async () => {
      const writes = database({ venues: [venueRow()], glAccounts: [glCash] });
      aggregator();
      const link = await VenueDepositoryOsEngine.link({ venueId: VENUE, connectionId: CONN, externalAccountId: ACCT, linkedBy: 'trustee-one@example.com' });
      expect(link.gl_account_code).toBe('1000');
      expect(writes.find(w => w.op === 'link')).toBeTruthy();
      const ref = writes.find(w => w.op === 'venue_update');
      expect(ref.params.join(' ')).toContain('Chase:4321');
    });

    it('refuses a venue that is not a depository', async () => {
      database({ venues: [venueRow({ provider: 'coinbase', kind: 'exchange' })], glAccounts: [glCash] });
      aggregator();
      await expect(VenueDepositoryOsEngine.link({ venueId: VENUE, connectionId: CONN, externalAccountId: ACCT, linkedBy: 'x' }))
        .rejects.toThrow(/only a depository venue/);
    });

    it('refuses the trust’s own rails as an outside depository', async () => {
      database({ venues: [venueRow()], glAccounts: [glCash] });
      aggregator({ connection: { id: CONN, name: 'Rails', connector_type: 'internal_rails' } });
      await expect(VenueDepositoryOsEngine.link({ venueId: VENUE, connectionId: CONN, externalAccountId: ACCT, linkedBy: 'x' }))
        .rejects.toThrow(/own rails/);
    });

    it('refuses an aggregator account that has never been pulled', async () => {
      database({ venues: [venueRow()], glAccounts: [glCash] });
      aggregator({ accounts: [] });
      await expect(VenueDepositoryOsEngine.link({ venueId: VENUE, connectionId: CONN, externalAccountId: ACCT, linkedBy: 'x' }))
        .rejects.toThrow(/has no account chk-001/);
    });

    it('refuses a GL account that is not an asset', async () => {
      database({ venues: [venueRow()], glAccounts: [{ account_code: '4000', account_name: 'Fee income', account_type: 'revenue' }] });
      aggregator();
      await expect(VenueDepositoryOsEngine.link({ venueId: VENUE, connectionId: CONN, externalAccountId: ACCT, glAccountCode: '4000', linkedBy: 'x' }))
        .rejects.toThrow(/is revenue/);
    });
  });

  describe('reading the bank', () => {
    it('reports a fresh aggregator balance as live', async () => {
      database({ venues: [venueRow()], links: [linkRow()] });
      aggregator();
      const reading = await VenueDepositoryOsEngine.read(VENUE);
      expect(reading.verification).toBe('live');
      expect(reading.balanceCents).toBe(1250050);
      expect(reading.availableCents).toBe(1200000);
    });

    it('does not pass a stale balance off as current funds', async () => {
      database({ venues: [venueRow()], links: [linkRow()] });
      aggregator({ accounts: [aggregatorAccount({ updated_at: new Date(Date.now() - 3 * 86400000).toISOString() })] });
      const reading = await VenueDepositoryOsEngine.read(VENUE);
      expect(reading.verification).toBe('unverified');
      expect(reading.balanceCents).toBe(0);
      expect(reading.lastKnownCents).toBe(1250050);
      expect(reading.reason).toMatch(/pull the connection/);
    });

    it('refuses to read a venue that is not linked', async () => {
      database({ venues: [venueRow()] });
      aggregator();
      await expect(VenueDepositoryOsEngine.read(VENUE)).rejects.toThrow(/not linked/);
    });
  });

  describe('probing through Venue Account OS', () => {
    it('reads the bank through the aggregator and records the balance as custody evidence', async () => {
      const writes = database({ venues: [venueRow()], links: [linkRow()] });
      const pull = aggregator();
      const { reading } = await VenueDepositoryOsEngine.probe(VENUE, { refresh: true });
      expect(pull).toHaveBeenCalledWith(CONN, { kinds: ['accounts'] });
      expect(reading.verification).toBe('live');
      expect(reading.detail.source).toBe('banking_aggregator');
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(reserve.mock.calls[0][0]).toMatchObject({ sourceType: 'depository_account', balanceCents: 1250050, verification: 'live' });
      expect(writes.some(w => w.op === 'venue_update')).toBe(true);
    });

    it('an unlinked depository probed through Venue Account OS is unverified, not zero', async () => {
      database({ venues: [venueRow()] });
      aggregator();
      const { reading } = await VenueAccountOsEngine.probe(VENUE);
      expect(reading.verification).toBe('unverified');
      expect(reading.reason).toMatch(/not linked/);
      expect(reserve).not.toHaveBeenCalled();
    });

    it('a linked, live, funded depository counts as funded for the rails', async () => {
      database({ venues: [venueRow()], links: [linkRow()] });
      aggregator();
      const described = await VenueAccountOsEngine.describe(venueRow({ last_verification: 'live', last_balance_cents: 1250050, last_probed_at: new Date().toISOString() }));
      expect(described.funded).toBe(true);
    });
  });

  describe('the unified data workflow', () => {
    it('routes aggregator transactions to the linked GL account', async () => {
      database({ links: [linkRow({ gl_account_code: '1010' })] });
      expect(await VenueDepositoryOsEngine.glAccountFor(CONN, ACCT)).toBe('1010');
      expect(await VenueDepositoryOsEngine.glAccountFor(CONN, 'someone-else')).toBeNull();
    });

    it('reconciles the bank against the books and logs the sync', async () => {
      const writes = database({ venues: [venueRow()], links: [linkRow()], glAccounts: [glCash] });
      aggregator();
      const result = await VenueDepositoryOsEngine.reconcile();
      expect(result.isReconciled).toBe(true);
      expect(result.comparisons[0]).toMatchObject({ glAccountCode: '1000', bankCents: 1250050, booksCents: 1250050, differenceCents: 0 });
      expect(writes.some(w => w.op === 'sync_log')).toBe(true);
      expect(writes.some(w => w.op === 'discrepancy_resolved')).toBe(true);
      expect(writes.some(w => w.op === 'discrepancy')).toBe(false);
    });

    it('a gap between bank and books becomes a DataBridge discrepancy', async () => {
      const writes = database({ venues: [venueRow()], links: [linkRow()], glAccounts: [{ ...glCash, balance: '10000.00' }] });
      aggregator();
      const result = await VenueDepositoryOsEngine.reconcile();
      expect(result.isReconciled).toBe(false);
      expect(result.discrepancies).toHaveLength(1);
      expect(result.comparisons[0].differenceCents).toBe(250050);
      const disc = writes.find(w => w.op === 'discrepancy');
      expect(disc.params).toContain('depository_balance_mismatch');
    });

    it('an unread depository is excluded from the comparison, because a missing number is not a zero', async () => {
      database({ venues: [venueRow()], links: [linkRow()], glAccounts: [glCash] });
      aggregator({ accounts: [aggregatorAccount({ updated_at: new Date(Date.now() - 3 * 86400000).toISOString() })] });
      const result = await VenueDepositoryOsEngine.reconcile();
      expect(result.read).toBe(0);
      expect(result.unread).toHaveLength(1);
      expect(result.comparisons).toHaveLength(0);
      expect(result.isReconciled).toBe(false);
    });

    it('the DataBridge full sync and status carry the depositories', async () => {
      database({ venues: [venueRow()], links: [linkRow()], glAccounts: [glCash] });
      aggregator();
      vi.spyOn(DataBridge, '_tableExists').mockResolvedValue(true);
      const status = await DataBridge.getDataFlowStatus();
      expect(status.modules.venue_depositories).toMatchObject({ linked: 1, live: 1, totalLiveCents: 1250050 });
      const recon = await DataBridge.reconcileDepositories();
      expect(recon.isReconciled).toBe(true);
    });
  });
});

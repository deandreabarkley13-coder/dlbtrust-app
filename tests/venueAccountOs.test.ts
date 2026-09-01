import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { VenueAccountOsEngine } = require('../server/integrations/os/venueAccountOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const pool = require('../server/integrations/bonds/pgPool');

function venueRow(overrides: any = {}) {
  return {
    venue_id: 'VENUE-COINBASE-A1B2C3',
    provider: 'coinbase',
    kind: 'exchange',
    label: 'Coinbase',
    status: 'approved',
    external_reference: null,
    registered_by: 'trustee-one@example.com',
    approved_by: 'trustee-two@example.com',
    evidence_reference: 'approval-email-2026-03',
    last_balance_cents: null,
    last_verification: null,
    last_probe_reason: null,
    last_probed_at: null,
    suspended_reason: null,
    metadata: {},
    ...overrides,
  };
}

/** The register captured rather than performed. */
function register({ rows = [] as any[] } = {}) {
  const writes: any[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/CREATE (TABLE|INDEX)/.test(text)) return { rows: [] } as any;
    if (/INSERT INTO venue_accounts/.test(text)) {
      const inserted = venueRow({
        venue_id: params[0],
        provider: params[1],
        kind: params[2],
        label: params[3],
        status: 'prospective',
        external_reference: params[4],
        registered_by: params[5],
        approved_by: null,
        evidence_reference: null,
      });
      writes.push({ op: 'insert', inserted });
      return { rows: [inserted] } as any;
    }
    if (/UPDATE venue_accounts/.test(text)) {
      writes.push({ op: 'update', sql: text, params });
      return { rows: [{ ...(rows[0] || venueRow()), updated: params }] } as any;
    }
    if (/FROM venue_accounts WHERE venue_id/.test(text)) {
      return { rows: rows.filter(r => r.venue_id === params[0]) } as any;
    }
    if (/FROM venue_accounts/.test(text)) return { rows } as any;
    return { rows: [] } as any;
  });
  return writes;
}

describe('Venue Account OS: the trust’s accounts at other people’s institutions', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.COINBASE_CDP_KEY_NAME = 'organizations/x/apiKeys/y';
    process.env.COINBASE_CDP_PRIVATE_KEY = 'test-private-key';
    vi.spyOn(ReserveEngine, 'record').mockResolvedValue({ attestation_id: 'RSV-1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  describe('the register', () => {
    it('opens a file on an account that can do nothing yet', async () => {
      const writes = register();
      const row = await VenueAccountOsEngine.register({ provider: 'coinbase', registeredBy: 'trustee-one@example.com' });
      expect(row.status).toBe('prospective');
      expect(row.kind).toBe('exchange');
      expect(writes[0].inserted.label).toBe('Coinbase');
    });

    it('refuses a provider nothing here can talk to', async () => {
      register();
      await expect(VenueAccountOsEngine.register({ provider: 'some-bank', registeredBy: 'trustee-one@example.com' }))
        .rejects.toThrow(/no adapter here/);
    });

    it('will not let one trustee both register and approve an account', async () => {
      register({ rows: [venueRow({ status: 'under_review', approved_by: null })] });
      await expect(VenueAccountOsEngine.recordApproval('VENUE-COINBASE-A1B2C3', {
        approvedBy: 'trustee-one@example.com',
        evidenceReference: 'approval-email',
      })).rejects.toThrow(/cannot also record its approval/);
    });

    it('requires evidence that the venue actually approved the account', async () => {
      register({ rows: [venueRow({ status: 'under_review', approved_by: null })] });
      await expect(VenueAccountOsEngine.recordApproval('VENUE-COINBASE-A1B2C3', {
        approvedBy: 'trustee-two@example.com',
      })).rejects.toThrow(/evidence reference is required/);
    });

    it('records an application against the venue’s own case id', async () => {
      const writes = register({ rows: [venueRow({ status: 'prospective', approved_by: null })] });
      await VenueAccountOsEngine.recordApplication('VENUE-COINBASE-A1B2C3', { reference: 'CB-APP-771' });
      expect(writes.find(w => w.op === 'update').params).toContain('under_review');
      await expect(VenueAccountOsEngine.recordApplication('VENUE-COINBASE-A1B2C3', {}))
        .rejects.toThrow(/application reference is required/);
    });
  });

  describe('what a venue actually holds', () => {
    it('reads the exchange’s USD wallets and counts only dollars', async () => {
      register({ rows: [venueRow()] });
      vi.spyOn(VenueAccountOsEngine as any, '_readCoinbase').mockResolvedValue({
        verification: 'live',
        balanceCents: 2500,
        asset: 'USD',
        detail: { wallets: [{ currency: 'USD', amount: '25' }, { currency: 'BTC', amount: '0.4' }] },
      });
      const { reading } = await VenueAccountOsEngine.probe('VENUE-COINBASE-A1B2C3');
      expect(reading.balanceCents).toBe(2500);
      expect(ReserveEngine.record).toHaveBeenCalledWith(expect.objectContaining({
        sourceType: 'depository_account',
        verification: 'live',
        balanceCents: 2500,
      }));
    });

    it('records the reason it could not read, never a zero standing in for unknown', async () => {
      delete process.env.COINBASE_CDP_PRIVATE_KEY;
      const writes = register({ rows: [venueRow()] });
      const { reading } = await VenueAccountOsEngine.probe('VENUE-COINBASE-A1B2C3');
      expect(reading.verification).toBe('unverified');
      expect(reading.reason).toMatch(/COINBASE_CDP_PRIVATE_KEY unset/);
      expect(ReserveEngine.record).not.toHaveBeenCalled();
      const update = writes.find(w => w.op === 'update');
      expect(update.params).not.toContain('funded');
    });

    it('marks an approved account funded once a live read shows dollars', async () => {
      const writes = register({ rows: [venueRow()] });
      vi.spyOn(VenueAccountOsEngine as any, '_readCoinbase').mockResolvedValue({
        verification: 'live', balanceCents: 500, asset: 'USD', detail: {},
      });
      await VenueAccountOsEngine.probe('VENUE-COINBASE-A1B2C3');
      expect(writes.find(w => w.op === 'update').params).toContain('funded');
    });

    it('does not mark it funded when the venue reports zero', async () => {
      const writes = register({ rows: [venueRow()] });
      vi.spyOn(VenueAccountOsEngine as any, '_readCoinbase').mockResolvedValue({
        verification: 'live', balanceCents: 0, asset: 'USD', detail: {},
      });
      await VenueAccountOsEngine.probe('VENUE-COINBASE-A1B2C3');
      expect(writes.find(w => w.op === 'update').params).not.toContain('funded');
    });

    it('refuses a balance asserted without evidence and an attester', async () => {
      register({ rows: [venueRow()] });
      await expect(VenueAccountOsEngine.attestBalance('VENUE-COINBASE-A1B2C3', { balanceCents: 100000 }))
        .rejects.toThrow(/evidence reference and the attesting trustee/);
    });

    it('books an attested balance as a statement, not a live read', async () => {
      register({ rows: [venueRow()] });
      await VenueAccountOsEngine.attestBalance('VENUE-COINBASE-A1B2C3', {
        balanceCents: 100000,
        evidenceReference: 'statement-2026-03.pdf',
        attestedBy: 'trustee-two@example.com',
      });
      expect(ReserveEngine.record).toHaveBeenCalledWith(expect.objectContaining({
        verification: 'statement',
        evidenceReference: 'statement-2026-03.pdf',
        attestedBy: 'trustee-two@example.com',
      }));
    });
  });

  describe('which venue can do what today', () => {
    it('names the onboarding step when the account is not approved', async () => {
      register({ rows: [venueRow({ status: 'under_review', approved_by: null })] });
      const match = await VenueAccountOsEngine.forCapability('buy_xlm');
      expect(match.account).toBeNull();
      expect(match.issues.join(' ')).toMatch(/onboarding is under_review/);
    });

    it('names the missing key rather than reporting a generic failure', async () => {
      delete process.env.COINBASE_CDP_KEY_NAME;
      register({ rows: [venueRow()] });
      const match = await VenueAccountOsEngine.forCapability('buy_xlm');
      expect(match.issues.join(' ')).toMatch(/COINBASE_CDP_KEY_NAME unset/);
    });

    it('separates “cannot trade” from “nothing to trade with”', async () => {
      register({ rows: [venueRow({ last_verification: 'live', last_balance_cents: '0', last_probed_at: new Date().toISOString() })] });
      const permitted = await VenueAccountOsEngine.forCapability('buy_xlm');
      expect(permitted.account).not.toBeNull();
      const funded = await VenueAccountOsEngine.forCapability('buy_xlm', { requireFunds: true });
      expect(funded.account).toBeNull();
      expect(funded.issues.join(' ')).toMatch(/reports a zero USD balance/);
    });

    it('treats a balance read too long ago as no balance at all', async () => {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60000).toISOString();
      register({ rows: [venueRow({ last_verification: 'live', last_balance_cents: '50000', last_probed_at: old })] });
      const funded = await VenueAccountOsEngine.forCapability('buy_xlm', { requireFunds: true });
      expect(funded.account).toBeNull();
      const snapshot = await VenueAccountOsEngine.snapshot();
      expect(snapshot.accounts[0].balance.stale).toBe(true);
      expect(snapshot.funded).toBe(0);
    });

    it('suggests the provider to open when nothing is registered', async () => {
      register({ rows: [] });
      const match = await VenueAccountOsEngine.forCapability('buy_xlm');
      expect(match.issues[0]).toMatch(/no venue account is registered that can buy_xlm/);
      expect(match.issues[0]).toMatch(/coinbase/);
    });

    it('refuses a capability nothing here models', async () => {
      register({ rows: [] });
      await expect(VenueAccountOsEngine.forCapability('print_money')).rejects.toThrow(/not a venue capability/);
    });

    it('will not let a suspended account back a rail', async () => {
      register({ rows: [venueRow({ status: 'suspended', suspended_reason: 'venue froze the account' })] });
      const match = await VenueAccountOsEngine.forCapability('buy_xlm');
      expect(match.account).toBeNull();
      expect(match.issues.join(' ')).toMatch(/suspended: venue froze the account/);
    });
  });

  describe('the snapshot', () => {
    it('reports credentials as present or missing, never as values', async () => {
      register({ rows: [venueRow()] });
      const snapshot = await VenueAccountOsEngine.snapshot();
      const account = snapshot.accounts[0];
      expect(account.credentials).toEqual({
        required: ['COINBASE_CDP_KEY_NAME', 'COINBASE_CDP_PRIVATE_KEY'],
        missing: [],
        satisfied: true,
      });
      expect(JSON.stringify(snapshot)).not.toContain('test-private-key');
    });

    it('indexes usable accounts by capability', async () => {
      register({ rows: [venueRow()] });
      const snapshot = await VenueAccountOsEngine.snapshot();
      expect(snapshot.byCapability.buy_xlm).toEqual(['VENUE-COINBASE-A1B2C3']);
      expect(snapshot.byCapability.wire_out).toEqual([]);
      expect(snapshot.usable).toBe(1);
    });
  });
});

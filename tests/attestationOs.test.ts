import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { AttestationOsEngine } = require('../server/integrations/os/attestationOsEngine');
const { ReserveEngine } = require('../server/integrations/finops/reserveEngine');
const { StablecoinPayoutRail } = require('../server/integrations/os/stablecoinPayoutRail');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/**
 * The observation store, the cash accounts, the bond ledger and the token table
 * answered from memory, so a run can be taken and read back exactly as the
 * engine writes it. Balances are in the units each table really uses: cents in
 * cash_accounts, dollars in bonds and bond_tokens.
 */
function store({
  observations = [] as Row[],
  cashAccounts = [
    { account_id: 'CA-BOND-PROCEEDS', account_name: 'DLB-PRB Bond Proceeds', account_type: 'bond_proceeds', balance_cents: 10_000_000_000 },
    { account_id: 'CA-OPERATING', account_name: 'Trust Operating Account', account_type: 'operating', balance_cents: 250_000 },
  ] as Row[],
  bonds = [{
    id: 7,
    bond_name: 'DLB-PRB',
    bond_identifier: '19781443-DLB-PRB',
    principal_balance: 1_000_000,
    accrued_interest: 5_000,
  }] as Row[],
  tokens = [{ id: 'BT-1', token_symbol: 'DLB-PRB', total_supply: 10_000, bond_id: 7 }] as Row[],
  aggregator = [] as Row[],
} = {}) {
  const runs: Row[] = [];

  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };

    if (text.startsWith('INSERT INTO attestation_observations')) {
      observations.push({
        observation_id: params[0],
        run_id: params[1],
        domain: params[2],
        category: params[3],
        source_type: params[4],
        source_key: params[5],
        asset: params[6],
        balance_cents: Number(params[7]),
        verification: params[8],
        unverified_reason: params[9],
        detail: params[10],
        observed_at: new Date().toISOString(),
      });
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO attestation_runs')) {
      runs.push({ run_id: params[0], observations: params[1], custody_cents: params[2] });
      return { rows: [] };
    }
    if (/FROM attestation_observations/.test(text)) {
      const latest = new Map<string, Row>();
      observations.forEach((row) => {
        latest.set(`${row.source_type}|${row.source_key}|${row.domain}`, row);
      });
      return { rows: [...latest.values()] };
    }
    if (/FROM cash_accounts/.test(text)) return { rows: cashAccounts };
    if (/FROM bonds/.test(text)) return { rows: bonds };
    if (/FROM bond_tokens/.test(text)) return { rows: tokens };
    if (/banking_aggregator_accounts/.test(text)) return { rows: aggregator };
    return { rows: [] };
  });

  vi.spyOn(pool, 'query').mockImplementation(query as any);
  return { observations, runs, query };
}

/** No custody source is readable unless a test says otherwise. */
function silentCustody() {
  vi.spyOn(StablecoinPayoutRail, 'position').mockRejectedValue(
    new Error('STABLECOIN_DISTRIBUTOR_PUBLIC is required')
  );
  vi.spyOn(ReserveEngine, 'verifyLive').mockResolvedValue({ sources: [] });
  vi.spyOn(ReserveEngine, 'record').mockImplementation(async (input: any) => input);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ATTESTATION_ENFORCEMENT;
  delete process.env.ATTESTATION_FRESH_MINUTES;
});

describe('Attestation OS — what the books claim against what someone holds', () => {
  it('records a claim as a claim, never as custody', async () => {
    const db = store();
    silentCustody();

    const run = await AttestationOsEngine.attest({ runBy: 'ops@example.com' });

    const proceeds = db.observations.find((o) => o.source_key === 'CA-BOND-PROCEEDS');
    expect(proceeds.category).toBe('claim');
    expect(proceeds.balance_cents).toBe(10_000_000_000);
    // The whole point: $100M on the books adds nothing to what is attested.
    expect(run.custodyCents).toBe(0);
    expect(run.claimedCents).toBeGreaterThanOrEqual(10_000_000_000);
  });

  it('writes down why a source could not be read instead of a zero', async () => {
    const db = store();
    silentCustody();

    await AttestationOsEngine.attest({});

    const stellar = db.observations.find((o) => o.source_key === 'stellar-distributor');
    expect(stellar.verification).toBe('unverified');
    expect(stellar.unverified_reason).toMatch(/Stellar position unreadable/);
    expect(stellar.balance_cents).toBe(0);
  });

  it('counts a Horizon trustline as attested treasury custody', async () => {
    const db = store();
    silentCustody();
    vi.spyOn(StablecoinPayoutRail, 'position').mockResolvedValue({
      address: 'GDISTRIBUTOR', asset: 'USDC', issuer: 'GA5ZSEJ', network: 'public',
      balance: '1500.0000000', availableCents: 150_000,
    });

    const run = await AttestationOsEngine.attest({});

    expect(run.custodyCents).toBe(150_000);
    const stellar = db.observations.find((o) => o.source_key === 'GDISTRIBUTOR');
    expect(stellar).toMatchObject({ category: 'custody', verification: 'live', balance_cents: 150_000 });
    // Custody belongs in the reserve engine's ledger, not a second one here.
    expect(ReserveEngine.record).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'onchain_wallet', balanceCents: 150_000 })
    );
  });

  it('treats a balance pulled from the trust\'s own rails as a claim, not custody', async () => {
    const db = store({
      aggregator: [{
        external_account_id: 'ACC-1', name: 'Internal clearing', currency: 'USD',
        balance_current: '25000.00', updated_at: new Date().toISOString(),
        connection_name: 'In-house rails', connector_type: 'internal_rails', active: true,
      }],
    });
    silentCustody();

    const run = await AttestationOsEngine.attest({});

    const account = db.observations.find((o) => o.source_key === 'In-house rails:ACC-1');
    expect(account.category).toBe('claim');
    expect(run.custodyCents).toBe(0);
  });

  it('refuses to count an aggregator account nobody has synced lately', async () => {
    const stale = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const db = store({
      aggregator: [{
        external_account_id: 'ACC-9', name: 'Betterment Checking', currency: 'USD',
        balance_current: '4200.00', updated_at: stale,
        connection_name: 'Betterment', connector_type: 'generic_rest', active: true,
      }],
    });
    silentCustody();

    const run = await AttestationOsEngine.attest({});

    const account = db.observations.find((o) => o.source_key === 'Betterment:ACC-9');
    expect(account.verification).toBe('unverified');
    expect(account.unverified_reason).toMatch(/last synced/);
    expect(run.custodyCents).toBe(0);
  });

  it('names the variance per desk in the snapshot', async () => {
    store();
    silentCustody();
    vi.spyOn(StablecoinPayoutRail, 'position').mockResolvedValue({
      address: 'GDISTRIBUTOR', asset: 'USDC', issuer: 'GA5ZSEJ', network: 'public',
      balance: '1500.0000000', availableCents: 150_000,
    });

    await AttestationOsEngine.attest({});
    const snapshot = await AttestationOsEngine.snapshot();

    const treasury = snapshot.domains.find((d: Row) => d.domain === 'treasury');
    expect(treasury.attestedCents).toBe(150_000);
    const core = snapshot.domains.find((d: Row) => d.domain === 'core_banking');
    expect(core.claimedCents).toBe(10_000_250_000);
    expect(core.attestedCents).toBe(0);
    expect(core.varianceCents).toBe(10_000_250_000);
    expect(snapshot.uncovered.map((u: Row) => u.domain)).toContain('core_banking');
  });

  it('reports no coverage ratio where nothing is claimed, rather than 100%', async () => {
    store({ cashAccounts: [], bonds: [], tokens: [] });
    silentCustody();
    vi.spyOn(StablecoinPayoutRail, 'position').mockResolvedValue({
      address: 'GDISTRIBUTOR', asset: 'USDC', issuer: 'GA5ZSEJ', network: 'public',
      balance: '1.0000000', availableCents: 100,
    });

    await AttestationOsEngine.attest({});
    const snapshot = await AttestationOsEngine.snapshot();

    expect(snapshot.domains.find((d: Row) => d.domain === 'treasury').coverageRatio).toBeNull();
  });
});

describe('Attestation OS — the gate', () => {
  it('refuses a movement when the newest observation is past the freshness window', async () => {
    process.env.ATTESTATION_FRESH_MINUTES = '60';
    const observed = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    store({
      observations: [{
        observation_id: 'OBS-1', run_id: 'ATT-1', domain: 'treasury', category: 'custody',
        source_type: 'onchain_wallet', source_key: 'GDISTRIBUTOR', asset: 'USDC',
        balance_cents: 500_000, verification: 'live', unverified_reason: null,
        detail: {}, observed_at: observed,
      }],
    });
    const spendable = vi.spyOn(ReserveEngine, 'assertSpendable');

    await expect(AttestationOsEngine.assertLive({ amountCents: 10_000, domain: 'treasury' }))
      .rejects.toThrow(/past the 60 minute window/);
    expect(spendable).not.toHaveBeenCalled();
  });

  it('refuses more than the attested balance without asking the reserve engine', async () => {
    store({
      observations: [{
        observation_id: 'OBS-1', run_id: 'ATT-1', domain: 'treasury', category: 'custody',
        source_type: 'onchain_wallet', source_key: 'GDISTRIBUTOR', asset: 'USDC',
        balance_cents: 500_000, verification: 'live', unverified_reason: null,
        detail: {}, observed_at: new Date().toISOString(),
      }],
    });
    vi.spyOn(ReserveEngine, 'assertSpendable').mockResolvedValue({ allowed: true });

    await expect(AttestationOsEngine.assertLive({ amountCents: 900_000, domain: 'treasury' }))
      .rejects.toThrow(/\$9000\.00 exceeds the \$5000\.00 attested live/);
  });

  it('hands the sizing question to the reserve engine once freshness passes', async () => {
    store({
      observations: [{
        observation_id: 'OBS-1', run_id: 'ATT-1', domain: 'treasury', category: 'custody',
        source_type: 'onchain_wallet', source_key: 'GDISTRIBUTOR', asset: 'USDC',
        balance_cents: 500_000, verification: 'live', unverified_reason: null,
        detail: {}, observed_at: new Date().toISOString(),
      }],
    });
    const spendable = vi.spyOn(ReserveEngine, 'assertSpendable').mockResolvedValue({ allowed: true });

    const decision = await AttestationOsEngine.assertLive({ amountCents: 100_000, rail: 'wire' });

    expect(decision.allowed).toBe(true);
    expect(decision.liveCents).toBe(500_000);
    expect(spendable).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 100_000, rail: 'wire' }));
  });

  it('carries the series through, so ring-fencing is not lost in the delegation', async () => {
    store();
    const spendable = vi.spyOn(ReserveEngine, 'assertSpendable').mockResolvedValue({ allowed: true });

    await AttestationOsEngine.assertLive({ amountCents: 100_000, rail: 'wire', seriesId: 'SER-2' });

    expect(spendable).toHaveBeenCalledWith(expect.objectContaining({ seriesId: 'SER-2' }));
  });

  it('does not double-gate: with no run yet, the reserve engine still rules', async () => {
    store();
    const spendable = vi.spyOn(ReserveEngine, 'assertSpendable').mockResolvedValue({ allowed: true });

    const decision = await AttestationOsEngine.assertLive({ amountCents: 100_000 });

    expect(decision.note).toMatch(/No attestation run/);
    expect(spendable).toHaveBeenCalled();
  });

  it('surfaces a reserve refusal rather than swallowing it', async () => {
    store();
    vi.spyOn(ReserveEngine, 'assertSpendable').mockRejectedValue(new Error('No external reserve attested'));

    await expect(AttestationOsEngine.assertLive({ amountCents: 100_000 }))
      .rejects.toThrow(/No external reserve attested/);
  });

  it('warns instead of refusing when enforcement is relaxed', async () => {
    process.env.ATTESTATION_ENFORCEMENT = 'warn';
    store({
      observations: [{
        observation_id: 'OBS-1', run_id: 'ATT-1', domain: 'treasury', category: 'custody',
        source_type: 'onchain_wallet', source_key: 'GDISTRIBUTOR', asset: 'USDC',
        balance_cents: 100, verification: 'live', unverified_reason: null,
        detail: {}, observed_at: new Date().toISOString(),
      }],
    });

    const decision = await AttestationOsEngine.assertLive({ amountCents: 900_000 });

    expect(decision.allowed).toBe(true);
    expect(decision.warning).toMatch(/exceeds/);
  });

  it('rejects a nonsense amount before reading anything', async () => {
    store();
    await expect(AttestationOsEngine.assertLive({ amountCents: 0 })).rejects.toThrow(/positive integer/);
  });
});

describe('Attestation OS — statement attestations', () => {
  it('records a bank statement through the reserve engine with its evidence', async () => {
    store();
    const record = vi.spyOn(ReserveEngine, 'record').mockImplementation(async (input: any) => input);

    await AttestationOsEngine.statement({
      sourceType: 'partner_bank',
      sourceKey: 'Column operating',
      balanceCents: 250_000,
      evidenceReference: 'stmt-2026-08.pdf',
      attestedBy: 'trustee@example.com',
    });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      verification: 'statement',
      evidenceReference: 'stmt-2026-08.pdf',
      attestedBy: 'trustee@example.com',
    }));
  });

  it('refuses an unknown domain', async () => {
    store();
    await expect(AttestationOsEngine.statement({ domain: 'vibes', sourceType: 'partner_bank', sourceKey: 'x' }))
      .rejects.toThrow(/Unknown domain/);
  });
});

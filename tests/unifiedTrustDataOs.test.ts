import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pool = require('../server/integrations/bonds/pgPool');
const { resealEventChain } = require('../server/integrations/os/eventChainReseal');
const { PledgeOsEngine } = require('../server/integrations/os/pledgeOsEngine');
const { PrivateEquityHoldingsOsEngine } = require('../server/integrations/os/privateEquityHoldingsOsEngine');
const { EnterpriseCreditOsEngine } = require('../server/integrations/os/enterpriseCreditOsEngine');
const { CustodyOsEngine } = require('../server/integrations/custody/custodyOsEngine');
const { CollateralOsEngine } = require('../server/integrations/os/collateralOsEngine');
const { CreditOsEngine } = require('../server/integrations/os/creditOsEngine');
const { AttestationOsEngine } = require('../server/integrations/os/attestationOsEngine');
const { EgressOsEngine } = require('../server/integrations/os/egressOsEngine');
const { DataBridge } = require('../server/integrations/accounting/dataBridge');
const reconcile = require('../server/scripts/reconcileTrustBalances');
const { UnifiedTrustDataOsEngine } = require('../server/integrations/os/unifiedTrustDataOsEngine');
const workflow = require('../server/scripts/unifiedTrustDataWorkflow');

type Row = Record<string, any>;
const saved = { ...process.env };

function pledgeDb(events: Row[]) {
  const handler = async (sql: any, p: any[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
    if (s.startsWith('SELECT event_hash FROM pledge_os_events')) return { rows: events.slice(-1) };
    if (s.startsWith('INSERT INTO pledge_os_events')) {
      events.push({ sequence: events.length + 1, event_id: p[0], pledge_id: p[1], event_type: p[2], actor: p[3], payload: JSON.parse(p[4]), prev_hash: p[5], event_hash: p[6], created_at: p[7] });
      return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM pledge_os_events ORDER BY sequence ASC')) return { rows: events.map((e) => ({ ...e })) };
    if (s.startsWith('UPDATE pledge_os_events SET prev_hash')) {
      const e = events.find((x) => x.sequence === p[0])!;
      e.prev_hash = p[1];
      e.event_hash = p[2];
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${s}`);
  };
  vi.spyOn(pool, 'query').mockImplementation(handler as any);
  const client = { query: vi.fn(handler), release: vi.fn() };
  vi.spyOn(pool, 'connect').mockResolvedValue(client as any);
  return client;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

describe('event chain reseal', () => {
  it('requires a reason', async () => {
    await expect(resealEventChain({ db: {}, reason: ' ' })).rejects.toThrow(/reason is required/);
  });

  it('re-anchors broken Pledge OS events and keeps the replaced hashes on chain_resealed', async () => {
    const events: Row[] = [];
    const client = pledgeDb(events);
    await PledgeOsEngine._event('pledge_recorded', 'PLG-1', 'trustee', { reference: 'PLEDGE-1', lien: { jurisdiction: 'US-IA', filingNumber: 'P1' } });
    await PledgeOsEngine._event('pledge_evaluated', 'PLG-1', 'trustee', { status: 'not_counted' });
    const originalFirst = events[0].event_hash;
    events[0].event_hash = 'legacy-insertion-order-hash';
    expect((await PledgeOsEngine.verifyChain()).intact).toBe(false);

    const r = await PledgeOsEngine.resealChain({ actor: 'operator', reason: 'canonical payload hashing' });
    expect(r.chain.intact).toBe(true);
    expect(r.events).toBe(2);
    expect(r.rewritten).toBe(1);
    expect(r.repaired[0]).toMatchObject({ sequence: 1, previousHash: 'legacy-insertion-order-hash' });
    expect(events[0].event_hash).toBe(originalFirst);
    const sealed = events[events.length - 1];
    expect(sealed.event_type).toBe('chain_resealed');
    expect(sealed.payload).toMatchObject({ events: 2, reason: 'canonical payload hashing', previousTipHash: events[1].event_hash });
    expect(sealed.payload.rewritten[0].previousHash).toBe('legacy-insertion-order-hash');
    expect(client.query.mock.calls.map((c: any[]) => c[0])).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back when a row update fails', async () => {
    const events: Row[] = [];
    const client = pledgeDb(events);
    await PledgeOsEngine._event('pledge_recorded', 'PLG-1', 'trustee', {});
    events[0].event_hash = 'bad';
    const base = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql: any, p?: any[]) => {
      if (/^UPDATE/.test(String(sql))) throw new Error('disk full');
      return base(sql, p);
    });
    await expect(PledgeOsEngine.resealChain({ actor: 'operator', reason: 'x' })).rejects.toThrow('disk full');
    expect(client.query.mock.calls.map((c: any[]) => c[0])).toContain('ROLLBACK');
    expect(events).toHaveLength(1);
    expect(client.release).toHaveBeenCalled();
  });
});

function stubEngines(overrides: { pledgeChainIntact?: boolean; drift?: boolean; custodyFails?: boolean } = {}) {
  const snapshots: Row[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, p: any[] = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/i.test(s)) return { rows: [] };
    if (s.startsWith('INSERT INTO unified_trust_snapshots')) {
      snapshots.push({ snapshot_id: p[0], run_by: p[1], ledger_synced: p[2], checks_failed: p[3], steps_failed: p[4], snapshot: JSON.parse(p[5]), created_at: p[6] });
      return { rows: [] };
    }
    if (s.startsWith('SELECT * FROM unified_trust_snapshots')) return { rows: snapshots.slice(-1) };
    throw new Error(`unexpected SQL: ${s}`);
  });
  const chain = (intact = true) => ({ events: 3, intact, breaks: intact ? [] : [{ sequence: 1 }], tipHash: 'h' });
  if (overrides.custodyFails) vi.spyOn(CustodyOsEngine, 'verifyChain').mockRejectedValue(new Error('custody db down'));
  else vi.spyOn(CustodyOsEngine, 'verifyChain').mockResolvedValue(chain());
  vi.spyOn(CustodyOsEngine, 'statement').mockResolvedValue({ accounts: [{}, {}], held: '98546521.91', thirdPartyReceipted: '0.00', selfCustody: '98546521.91', unreceipted: '96046521.91', byAssetClass: {} });
  const peEval = vi.spyOn(PrivateEquityHoldingsOsEngine, 'evaluate').mockResolvedValue({ holdings: [], summary: {} });
  vi.spyOn(PrivateEquityHoldingsOsEngine, 'status').mockResolvedValue({ summary: { holdings: 0, eligibleCollateralCents: 0, intraTrust: { holdings: 1, bookCents: 9854652191, countsAsCollateral: false } }, chain: chain() });
  vi.spyOn(PledgeOsEngine, 'evaluate').mockResolvedValue({});
  vi.spyOn(PledgeOsEngine, 'status').mockResolvedValue({ summary: { pledges: 1, counted: 0, countedValue: '0.00', liens: ['P24000656-2'] }, chain: chain(overrides.pledgeChainIntact !== false) });
  vi.spyOn(PledgeOsEngine, 'coverage').mockResolvedValue({ unbackedCents: 0 });
  const revalue = vi.spyOn(CollateralOsEngine, 'revalue').mockResolvedValue({});
  vi.spyOn(CollateralOsEngine, 'facility').mockResolvedValue({ collateralUsd: 0, spendableUsd: 0, drawnUsd: 0, openDraws: 0 });
  vi.spyOn(EnterpriseCreditOsEngine, 'evaluate').mockResolvedValue({});
  vi.spyOn(EnterpriseCreditOsEngine, 'status').mockResolvedValue({ capacity: { capacityCents: 0, usedCents: 0, availableCents: 0 }, summary: { open: 0 }, chain: chain() });
  vi.spyOn(CreditOsEngine, 'status').mockResolvedValue({ mode: 'validation-only', realValueCapable: false, fundingSources: [], ledger: { valid: true } });
  vi.spyOn(AttestationOsEngine, 'snapshot').mockResolvedValue({ attestedCents: 0, claimedCents: 19960000000, varianceCents: -19960000000, enforcement: 'shadow' });
  vi.spyOn(EgressOsEngine, 'status').mockResolvedValue({ enforce: true, path: { vpcConnector: 'dlbtrust-run', nat: 'dlbtrust-egress', staticIp: '34.138.243.108' }, lastProbe: { matched: true, observedIp: '34.138.243.108', error: null, at: '2026-09-30T00:00:00Z' } });
  vi.spyOn(DataBridge, 'reconcileCashToAccounting').mockResolvedValue({ cashModuleTotal: 100, trustAccountingTotal: 100, difference: 0, isReconciled: true, discrepancies: [] });
  const balances = [
    { account_code: '1015', account_name: 'Funds In Transit', account_type: 'asset', derived_balance: 250000 },
    { account_code: '1030', account_name: 'Operating Cash', account_type: 'asset', derived_balance: 1000 },
  ];
  const drift = overrides.drift ? [{ account_code: '1030', stored_balance: 251000, derived_balance: 1000, drift: -250000 }] : [];
  const rec = vi.spyOn(reconcile, 'reconcileTrustBalances').mockImplementation(async ({ apply }: any) => ({ apply, balances, drift: apply ? drift : drift, applied: apply ? drift.length : 0 }));
  return { snapshots, rec, peEval, revalue };
}

describe('Unified Trust Data OS', () => {
  it('runs every engine in order and keeps book, collateral, credit and ledger values distinct', async () => {
    process.env.PRIVATE_ACCESS_VPN_ENABLED = 'false';
    const { snapshots, rec, revalue } = stubEngines();
    const s = await UnifiedTrustDataOsEngine.run({ actor: 'dlbtrust-unified-trust-data' });
    expect(s.steps.map((x: Row) => x.name)).toEqual(['custody', 'pe-holdings', 'pledge', 'collateral', 'enterprise-credit', 'credit', 'attestation', 'ledger', 'cash', 'network']);
    expect(s.steps.every((x: Row) => x.ok)).toBe(true);
    expect(revalue).toHaveBeenCalledWith({ actor: 'dlbtrust-unified-trust-data' });
    expect(s.ledger.accounts.inTransit).toEqual({ accountCode: '1015', balance: 250000 });
    expect(s.ledger.accounts.operatingCash).toEqual({ accountCode: '1030', balance: 1000 });
    expect(s.custody).toMatchObject({ held: '98546521.91', thirdPartyReceipted: '0.00', selfCustody: '98546521.91' });
    expect(s.backing.intraTrust).toEqual({ holdings: 1, book: '98546521.91', countsAsCollateral: false });
    expect(s.backing.peEligibleCollateral).toBe('0.00');
    expect(s.backing.pledges).toMatchObject({ counted: 0, countedValue: '0.00', liens: ['P24000656-2'] });
    expect(s.backing.enterpriseCredit).toMatchObject({ capacity: '0.00', available: '0.00' });
    expect(s.network.path.staticIp).toBe('34.138.243.108');
    const byName = Object.fromEntries(s.checks.map((c: Row) => [c.check, c]));
    expect(byName['intra-trust holdings excluded from collateral'].ok).toBe(true);
    expect(byName['trust_accounts match posted journal lines'].ok).toBe(true);
    expect(byName['egress on VPC connector + Cloud NAT static IP'].ok).toBe(true);
    expect(byName['Cloud VPN tunnels up']).toMatchObject({ ok: false, detail: expect.stringMatching(/not provisioned/) });
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rec).toHaveBeenCalledWith({ apply: false });
    expect(snapshots).toHaveLength(1);
    expect((await UnifiedTrustDataOsEngine.latest()).snapshotId).toBe(s.snapshotId);
  });

  it('reports ledger drift without syncing unless --sync-ledger, and syncs it when asked', async () => {
    let { rec } = stubEngines({ drift: true });
    let s = await UnifiedTrustDataOsEngine.run({ actor: 'op' });
    expect(rec).toHaveBeenCalledTimes(1);
    expect(s.checks.find((c: Row) => c.check === 'trust_accounts match posted journal lines')).toMatchObject({ ok: false, detail: 'drift on 1030' });

    vi.restoreAllMocks();
    ({ rec } = stubEngines({ drift: true }));
    s = await UnifiedTrustDataOsEngine.run({ actor: 'op', syncLedger: true });
    expect(rec.mock.calls.map((c: any[]) => c[0])).toEqual([{ apply: false }, { apply: true }]);
    expect(s.ledger.synced).toBe(true);
    expect(s.ledger.driftBefore).toEqual([{ accountCode: '1030', stored: 251000, derived: 1000, drift: -250000 }]);
    expect(s.checks.find((c: Row) => c.check === 'trust_accounts match posted journal lines').ok).toBe(true);
  });

  it('keeps going when a step fails and flags broken chains', async () => {
    stubEngines({ custodyFails: true, pledgeChainIntact: false });
    const s = await UnifiedTrustDataOsEngine.run({ actor: 'op' });
    expect(s.steps.find((x: Row) => x.name === 'custody')).toMatchObject({ ok: false, error: 'custody db down' });
    expect(s.steps.filter((x: Row) => x.ok)).toHaveLength(9);
    expect(s.custody).toBeNull();
    expect(s.checks.find((c: Row) => c.check === 'pledge event chain intact')).toMatchObject({ ok: false, detail: '1 break(s)' });
    const r = await UnifiedTrustDataOsEngine.readiness();
    expect(r.ready).toBe(true);
    expect(r.warnings).toEqual(expect.arrayContaining(['custody step failed: custody db down', 'pledge event chain intact: 1 break(s)']));
  });

  it('requires an actor to run', async () => {
    await expect(UnifiedTrustDataOsEngine.run({})).rejects.toThrow(/actor is required/);
  });

  it('reseals only broken chains', async () => {
    vi.spyOn(PrivateEquityHoldingsOsEngine, 'verifyChain').mockResolvedValue({ events: 1, intact: false, breaks: [{}] });
    const peReseal = vi.spyOn(PrivateEquityHoldingsOsEngine, 'resealChain').mockResolvedValue({ events: 1, rewritten: 1, chain: { intact: true } });
    vi.spyOn(PledgeOsEngine, 'verifyChain').mockResolvedValue({ events: 2, intact: false, breaks: [{}, {}] });
    const plReseal = vi.spyOn(PledgeOsEngine, 'resealChain').mockResolvedValue({ events: 2, rewritten: 2, chain: { intact: true } });
    vi.spyOn(EnterpriseCreditOsEngine, 'verifyChain').mockResolvedValue({ events: 0, intact: true, breaks: [] });
    const ecReseal = vi.spyOn(EnterpriseCreditOsEngine, 'resealChain');
    vi.spyOn(CustodyOsEngine, 'verifyChain').mockResolvedValue({ events: 40, intact: true, breaks: [] });
    const cuReseal = vi.spyOn(CustodyOsEngine, 'resealChain');
    const r = await UnifiedTrustDataOsEngine.resealChains({ actor: 'operator', reason: 'canonical hashing' });
    expect(peReseal).toHaveBeenCalledWith({ actor: 'operator', reason: 'canonical hashing' });
    expect(plReseal).toHaveBeenCalledWith({ actor: 'operator', reason: 'canonical hashing' });
    expect(ecReseal).not.toHaveBeenCalled();
    expect(cuReseal).not.toHaveBeenCalled();
    expect(r.enterpriseCredit).toEqual({ skipped: true, events: 0, intact: true });
    expect(r.pledge.rewritten).toBe(2);
    await expect(UnifiedTrustDataOsEngine.resealChains({ actor: 'operator' })).rejects.toThrow(/reason is required/);
  });
});

describe('unifiedTrustDataWorkflow CLI', () => {
  it('parses run, reseal and read-only modes', () => {
    expect(workflow.parseArgs([])).toMatchObject({ action: 'latest', syncLedger: false });
    expect(workflow.parseArgs(['--run', '--sync-ledger', '--actor', 'job', '--strict'])).toMatchObject({ action: 'run', syncLedger: true, strict: true, fields: { actor: 'job' } });
    expect(workflow.parseArgs(['--reseal-chains', '--reason', 'fix', '--actor', 'op'])).toMatchObject({ action: 'reseal', fields: { reason: 'fix', actor: 'op' } });
    expect(() => workflow.parseArgs(['--run'])).toThrow(/--actor is required/);
    expect(() => workflow.parseArgs(['--reseal-chains', '--actor', 'op'])).toThrow(/--reason/);
    expect(() => workflow.parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});

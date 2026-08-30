import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TrustAggregatorEngine } = require('../server/integrations/dapp/trustAggregatorEngine');

afterEach(() => {
  vi.restoreAllMocks();
});

function connection(sourceType: string, lastSyncAt: Date | null) {
  return {
    connection_id: `TAC-${sourceType}`,
    name: sourceType,
    source_type: sourceType,
    last_sync_at: lastSyncAt ? lastSyncAt.toISOString() : null,
  };
}

function stubAggregator(connections: unknown[]) {
  vi.spyOn(TrustAggregatorEngine, 'ensureTables').mockResolvedValue(undefined);
  vi.spyOn(TrustAggregatorEngine, 'autoConnectInternalSources').mockResolvedValue([]);
  vi.spyOn(TrustAggregatorEngine, 'listConnections').mockResolvedValue(connections);
  return vi.spyOn(TrustAggregatorEngine, 'sync').mockResolvedValue({ balances: 1, transactions: 0 });
}

describe('trust aggregator live refresh', () => {
  it('re-reads internal sources whose snapshot is older than the freshness window', async () => {
    const sync = stubAggregator([
      connection('cash', new Date(Date.now() - 5 * 60 * 1000)),
      connection('trust', new Date()),
      connection('trust_bank', null),
      connection('manual', null),
    ]);

    const result = await TrustAggregatorEngine.refreshInternalSources({ maxAgeMs: 60000 });

    expect(sync.mock.calls.map((c) => c[0])).toEqual(['TAC-cash', 'TAC-trust_bank']);
    expect(result.synced).toEqual(['TAC-cash', 'TAC-trust_bank']);
    expect(result.errors).toEqual([]);
  });

  it('re-reads every internal source when forced', async () => {
    const sync = stubAggregator([
      connection('cash', new Date()),
      connection('trust', new Date()),
      connection('external', null),
    ]);

    await TrustAggregatorEngine.refreshInternalSources({ maxAgeMs: 60000, force: true });

    expect(sync.mock.calls.map((c) => c[0])).toEqual(['TAC-cash', 'TAC-trust']);
  });

  it('reports a failing source instead of failing the whole refresh', async () => {
    stubAggregator([connection('cash', null), connection('trust', null)]);
    vi.spyOn(TrustAggregatorEngine, 'sync').mockImplementation(async (id: string) => {
      if (id === 'TAC-cash') throw new Error('cash ledger unavailable');
      return { balances: 1, transactions: 0 };
    });

    const result = await TrustAggregatorEngine.refreshInternalSources({ maxAgeMs: 0 });

    expect(result.synced).toEqual(['TAC-trust']);
    expect(result.errors).toEqual([{ connectionId: 'TAC-cash', error: 'cash ledger unavailable' }]);
  });

  it('collapses concurrent refreshes onto one sync pass', async () => {
    const sync = stubAggregator([connection('cash', null)]);

    await Promise.all([
      TrustAggregatorEngine.refreshInternalSources({ maxAgeMs: 0 }),
      TrustAggregatorEngine.refreshInternalSources({ maxAgeMs: 0 }),
    ]);

    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('net worth freshness', () => {
  it('refreshes before aggregating and reports how old the balances are', async () => {
    const asOf = new Date(Date.now() - 4000);
    const refresh = vi.spyOn(TrustAggregatorEngine, 'refreshInternalSources').mockResolvedValue({ synced: ['TAC-cash'], errors: [] });
    vi.spyOn(TrustAggregatorEngine, 'aggregateBalances').mockResolvedValue({
      total: 1234.56,
      by_source: { cash: { balance: 1234.56, accounts: 1 } },
      balances: [],
    });
    vi.spyOn(TrustAggregatorEngine, 'listConnections').mockResolvedValue([connection('cash', asOf)]);
    vi.spyOn(TrustAggregatorEngine, 'getFreshness').mockResolvedValue({
      as_of: asOf.toISOString(),
      oldest_synced_at: asOf.toISOString(),
      age_seconds: 4,
    });

    const nw = await TrustAggregatorEngine.getNetWorth({ live: true });

    expect(refresh).toHaveBeenCalled();
    expect(nw.total).toBe(1234.56);
    expect(nw.as_of).toBe(asOf.toISOString());
    expect(nw.age_seconds).toBe(4);
    expect(nw.live).toBe(true);
    expect(nw.sync_errors).toEqual([]);
  });

  it('serves the stored snapshot without syncing when not asked for live data', async () => {
    const refresh = vi.spyOn(TrustAggregatorEngine, 'refreshInternalSources').mockResolvedValue({ synced: [], errors: [] });
    vi.spyOn(TrustAggregatorEngine, 'aggregateBalances').mockResolvedValue({ total: 0, by_source: {}, balances: [] });
    vi.spyOn(TrustAggregatorEngine, 'listConnections').mockResolvedValue([]);
    vi.spyOn(TrustAggregatorEngine, 'getFreshness').mockResolvedValue({ as_of: null, oldest_synced_at: null, age_seconds: null });

    const nw = await TrustAggregatorEngine.getNetWorth();

    expect(refresh).not.toHaveBeenCalled();
    expect(nw.live).toBe(false);
    expect(nw.as_of).toBeNull();
  });
});

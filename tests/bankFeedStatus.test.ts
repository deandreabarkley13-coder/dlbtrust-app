import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { BankingAggregator } = require('../server/integrations/aggregator/bankingAggregator');
const pool = require('../server/integrations/bonds/pgPool');

describe('BankingAggregator.feedStatus', () => {
  let originalQuery: unknown;

  beforeEach(() => {
    originalQuery = pool.query;
    vi.spyOn(BankingAggregator, 'ensureTables').mockResolvedValue(undefined as never);
    pool.query = async (sql: string) => {
      if (/FROM banking_aggregator_connections c/.test(sql)) {
        return { rows: [
          {
            id: 'CONN-BETTERMENT', name: 'Betterment Trust Checking', connector_type: 'simplefin',
            last_pull_at: '2026-09-29T04:57:16Z', last_status: 'failed',
            last_error: 'SimpleFIN Access URL rejected (HTTP 403): the token was disabled or revoked in the Bridge',
            last_attempt_at: '2026-09-29T04:57:16Z', last_success_at: '2026-09-28T09:51:58Z',
          },
          {
            id: 'CONN-OK', name: 'Healthy Feed', connector_type: 'generic_rest',
            last_pull_at: '2026-09-29T04:57:00Z', last_status: 'processed', last_error: null,
            last_attempt_at: '2026-09-29T04:57:00Z', last_success_at: '2026-09-29T04:57:00Z',
          },
          {
            id: 'CONN-NEW', name: 'New Feed', connector_type: 'generic_rest',
            last_pull_at: null, last_status: null, last_error: null, last_attempt_at: null, last_success_at: null,
          },
        ] };
      }
      if (/FROM banking_aggregator_accounts/.test(sql)) {
        return { rows: [
          { connection_id: 'CONN-BETTERMENT', name: 'Checking (3054)', mask: '3054', account_type: 'checking', currency: 'USD', balance_current: '1234.56', balance_available: null, updated_at: '2026-09-28T09:51:58Z' },
          { connection_id: 'CONN-OK', name: 'Ops', mask: '0001', account_type: 'checking', currency: 'USD', balance_current: '10.00', balance_available: '9.00', updated_at: '2026-09-29T04:57:00Z' },
        ] };
      }
      throw new Error('unexpected query: ' + sql);
    };
  });

  afterEach(() => {
    pool.query = originalQuery;
    vi.restoreAllMocks();
  });

  it('reports a revoked feed as failing with its last good sync and stale balances', async () => {
    const feeds = await BankingAggregator.feedStatus();
    const betterment = feeds.find((f: { connectionId: string }) => f.connectionId === 'CONN-BETTERMENT');
    expect(betterment).toMatchObject({
      status: 'failing',
      error: expect.stringContaining('HTTP 403'),
      lastSuccessAt: '2026-09-28T09:51:58.000Z',
      accounts: [{ name: 'Checking (3054)', balanceCurrent: 1234.56, balanceAvailable: null, updatedAt: '2026-09-28T09:51:58.000Z' }],
    });
  });

  it('marks healthy and never-pulled feeds without an error', async () => {
    const feeds = await BankingAggregator.feedStatus();
    expect(feeds.find((f: { connectionId: string }) => f.connectionId === 'CONN-OK')).toMatchObject({ status: 'ok', error: null });
    expect(feeds.find((f: { connectionId: string }) => f.connectionId === 'CONN-NEW')).toMatchObject({ status: 'never_pulled', error: null, lastAttemptAt: null, accounts: [] });
  });
});

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import type { AddressInfo } from 'net';

const require = createRequire(import.meta.url);
const { finlynqConnector, normalizeAccount, normalizeTransaction } = require('../server/integrations/aggregator/connectors/finlynqConnector');
const { listConnectorTypes } = require('../server/integrations/aggregator/connectors');

const KEY = 'pf_test_secret_key';

type Call = { auth?: string; method: string; tool?: string; args?: any };

function toolResult(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify({ success: true, data }) }] };
}

async function startFinlynqMock(opts: { status?: number; tools?: string[]; toolError?: boolean; sse?: boolean } = {}) {
  const calls: Call[] = [];
  const tools = opts.tools || ['get_account_balances', 'search_transactions', 'execute_bulk_delete'];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msg = JSON.parse(body);
      const call: Call = { auth: req.headers['authorization'] as string, method: msg.method };
      if (msg.method === 'tools/call') { call.tool = msg.params.name; call.args = msg.params.arguments; }
      calls.push(call);
      if (opts.status) { res.writeHead(opts.status, { 'Content-Type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
      let result: any;
      if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'finlynq', version: '4.0.0' }, capabilities: { tools: {} } };
      else if (msg.method === 'tools/list') result = { tools: tools.map((name) => ({ name })) };
      else if (call.tool === 'get_account_balances') {
        result = opts.toolError ? { content: [{ type: 'text', text: 'Error: database unavailable' }], isError: true } : toolResult({
          accounts: [
            { id: 12, name: 'v1:ciphertext', type: 'A', group: 'Banking', currency: 'USD', balance: 12500.75, isInvestment: false, basis: 'ledger' },
            { id: 13, name: 'Visa', type: 'L', group: 'Credit', currency: 'USD', balance: -80, isInvestment: false, basis: 'ledger' },
          ],
          reportingCurrency: 'USD',
        });
      } else if (call.tool === 'search_transactions') {
        result = toolResult({ results: call.args.account_id === 12 ? [
          { id: 901, date: '2026-09-27', amount: -42.1, currency: 'USD', payee: 'Utility Co', category: 'Bills', source: 'connector' },
          { id: 902, date: '2026-09-28', amount: 1000, currency: 'USD', payee: 'v1:enc', note: 'Deposit', category: null },
        ] : [], count: 0 });
      } else result = {};
      const out = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (opts.sse) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(`event: message\ndata: ${out}\n\n`); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
  return { url, calls, close: () => server.close() };
}

describe('finlynq connector (read-only over the Finlynq MCP server)', () => {
  it('is registered and has no push', () => {
    expect(listConnectorTypes()).toContain('finlynq');
    expect(finlynqConnector.push).toBeUndefined();
  });

  it('rejects missing / non-pf_ keys and non-https or credentialed MCP URLs', async () => {
    const saved = process.env.FINLYNQ_API_KEY; delete process.env.FINLYNQ_API_KEY;
    try {
      await expect(finlynqConnector.handshake({ id: 'f', config: {} }, {})).rejects.toThrow(/API key missing/);
      await expect(finlynqConnector.handshake({ id: 'f', config: { apiKey: 'sk_nope' } }, {})).rejects.toThrow(/pf_ token/);
      await expect(finlynqConnector.handshake({ id: 'f', config: { apiKey: KEY, mcpUrl: 'http://finlynq.example.com/api/mcp' } }, {})).rejects.toThrow(/must use https/);
      await expect(finlynqConnector.handshake({ id: 'f', config: { apiKey: KEY, mcpUrl: 'https://u:p@finlynq.example.com/api/mcp' } }, {})).rejects.toThrow(/must not embed credentials/);
    } finally { if (saved) process.env.FINLYNQ_API_KEY = saved; }
  });

  it('handshakes with the bearer key (initialize + tools/list + balances), read-only capabilities, no key in output', async () => {
    const f = await startFinlynqMock();
    try {
      const hs = await finlynqConnector.handshake({ id: 'f1', config: { apiKey: KEY, mcpUrl: f.url, accountIds: [12] } }, {});
      expect(hs.externalConnectionId).toMatch(/^finlynq:127\.0\.0\.1:\d+$/);
      expect(hs.capabilities).toEqual({ pull: true, push: false, webhook: false });
      expect(hs.meta.server).toMatchObject({ name: 'finlynq' });
      expect(hs.meta.accounts).toEqual([{ id: 12, name: null, currency: 'USD' }]);
      expect(hs.meta.secretSource).toBe('connection');
      expect(JSON.stringify(hs)).not.toContain(KEY);
      expect(f.calls.map((c) => c.tool || c.method)).toEqual(['initialize', 'tools/list', 'get_account_balances']);
      expect(f.calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    } finally { f.close(); }
  });

  it('fails the handshake when a read tool is missing, the key is rejected, or no account matches', async () => {
    const noTools = await startFinlynqMock({ tools: ['get_account_balances'] });
    try {
      await expect(finlynqConnector.handshake({ id: 'f', config: { apiKey: KEY, mcpUrl: noTools.url } }, {})).rejects.toThrow(/does not expose search_transactions/);
    } finally { noTools.close(); }
    const denied = await startFinlynqMock({ status: 401 });
    try {
      const err = await finlynqConnector.handshake({ id: 'f', config: { apiKey: KEY, mcpUrl: denied.url } }, {}).catch((e: Error) => e);
      expect(err.message).toMatch(/API key rejected \(HTTP 401\)/);
      expect(err.message).not.toContain(KEY);
    } finally { denied.close(); }
    const f = await startFinlynqMock();
    try {
      await expect(finlynqConnector.handshake({ id: 'f', config: { apiKey: KEY, mcpUrl: f.url, accountIds: [99] } }, {})).rejects.toThrow(/no matching accounts/);
    } finally { f.close(); }
  });

  it('surfaces tool errors and parses SSE-framed responses', async () => {
    const bad = await startFinlynqMock({ toolError: true });
    try {
      await expect(finlynqConnector.pullAccounts({ id: 'f', config: { apiKey: KEY, mcpUrl: bad.url } }, {})).rejects.toThrow(/get_account_balances failed: database unavailable/);
    } finally { bad.close(); }
    const sse = await startFinlynqMock({ sse: true });
    try {
      const accts = await finlynqConnector.pullAccounts({ id: 'f', config: { apiKey: KEY, mcpUrl: sse.url } }, {});
      expect(accts).toHaveLength(2);
    } finally { sse.close(); }
  });

  it('pulls accounts and per-account transactions with the lookback/overlap window and only read tools', async () => {
    const saved = process.env.FINLYNQ_API_KEY; process.env.FINLYNQ_API_KEY = KEY;
    const f = await startFinlynqMock();
    try {
      const conn = { id: 'f1', handshake_state: 'verified', config: { mcpUrl: f.url, accountIds: ['12'] } };
      const accounts = await finlynqConnector.pullAccounts(conn, {});
      expect(accounts).toEqual([expect.objectContaining({ externalAccountId: '12', name: 'Finlynq account 12', accountType: 'depository', balanceCurrent: 12500.75, currency: 'USD' })]);
      const txns = await finlynqConnector.pullTransactions(conn, { since: '2026-09-20T00:00:00Z' });
      expect(txns.map((t: any) => [t.externalTxnId, t.externalAccountId, t.direction, t.amount, t.description, t.postedDate])).toEqual([
        ['901', '12', 'debit', 42.1, 'Utility Co', '2026-09-27'],
        ['902', '12', 'credit', 1000, 'Deposit', '2026-09-28'],
      ]);
      const search = f.calls.filter((c) => c.tool === 'search_transactions');
      expect(search).toEqual([expect.objectContaining({ args: { account_id: 12, start_date: '2026-09-15', limit: 500 } })]);
      expect(f.calls.every((c) => !c.tool || ['get_account_balances', 'search_transactions'].includes(c.tool))).toBe(true);
    } finally { f.close(); if (saved) process.env.FINLYNQ_API_KEY = saved; else delete process.env.FINLYNQ_API_KEY; }
  });

  it('normalizes liabilities, investments and encrypted names', () => {
    expect(normalizeAccount({ id: 13, name: 'Visa', type: 'L', currency: 'USD', balance: -80 })).toMatchObject({ name: 'Visa', accountType: 'credit', balanceCurrent: -80 });
    expect(normalizeAccount({ id: 14, name: 'v1:x', alias: 'Brokerage', isInvestment: true, balance: { amount: 5 } })).toMatchObject({ name: 'Brokerage', accountType: 'investment', balanceCurrent: 5 });
    expect(normalizeTransaction({ id: 1, date: '2026-09-01', amount: -5, payee: 'v1:x', category: 'v1:y' }, 12)).toMatchObject({ description: null, category: null, direction: 'debit', amount: 5 });
  });
});

async function startFinlynqBankMock(opts: { lastSyncAt?: string | null; connected?: boolean; syncErrors?: string[] } = {}) {
  const calls: Array<{ method: string; path: string; tool?: string; args?: any; auth?: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x');
      const auth = req.headers['authorization'] as string;
      const json = (code: number, v: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      if (url.pathname === '/api/mcp') {
        const msg = JSON.parse(body);
        const call = { method: 'MCP', path: url.pathname, tool: msg.params?.name, args: msg.params?.arguments, auth };
        calls.push(call);
        let result: any = {};
        if (msg.method === 'tools/list') result = { tools: ['get_account_balances', 'search_transactions', 'manage_bank_ledger'].map((name) => ({ name })) };
        else if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'finlynq' } };
        else if (call.tool === 'get_account_balances') result = toolResult({ accounts: [
          { id: 2760, name: 'Betterment Checking (3054)', type: 'A', currency: 'USD', balance: 0, isInvestment: false },
          { id: 2757, name: 'Betterment Cash Reserve (5739)', type: 'A', currency: 'USD', balance: 0, isInvestment: false },
        ] });
        else if (call.tool === 'manage_bank_ledger') result = toolResult(call.args.accountId === 2760 ? [
          { accountId: 2760, date: '2026-09-01', amount: 5, currency: 'USD' },
          { accountId: 2760, date: '2026-09-29', amount: 0.84, currency: 'USD' },
        ] : []);
        return json(200, { jsonrpc: '2.0', id: msg.id, result });
      }
      calls.push({ method: req.method || '', path: url.pathname + url.search, auth });
      if (url.pathname === '/api/settings/bank-feeds/simplefin/status') return json(200, { connected: opts.connected !== false, lastSyncAt: opts.lastSyncAt ?? null });
      if (url.pathname === '/api/settings/bank-feeds/simplefin/sync') return json(200, { staged: [{ accountId: 2760 }], skippedNoChoice: [], errors: opts.syncErrors || ['Requested date range exceeds limit of 90 days and was capped.'] });
      if (url.pathname === '/api/import/bank-ledger') {
        return json(200, { success: true, data: { latestAnchor: null, transactions: url.searchParams.get('accountId') === '2760' ? [
          { id: 'b-1', bankTransactionId: 'b-1', date: '2026-09-28', amount: -10, currency: 'USD', payee: 'Bill.com', note: null, category: null },
          { id: 'b-2', bankTransactionId: 'b-2', date: '2026-09-28', amount: 10, currency: 'USD', payee: 'Returned', note: 'R Insufficient Funds', category: null },
          { id: 'b-0', bankTransactionId: 'b-0', date: '2026-01-02', amount: 99, currency: 'USD', payee: 'Old', note: null, category: null },
        ] : [] } });
      }
      json(404, { error: 'Not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
  return { url, calls, close: () => server.close() };
}

describe('finlynq connector bank-side source', () => {
  it('reports the latest bank anchor as the balance (null without one) and syncs a stale bank feed first', async () => {
    const f = await startFinlynqBankMock({ lastSyncAt: '2026-01-01T00:00:00Z' });
    try {
      const conn = { id: 'f', config: { apiKey: KEY, mcpUrl: f.url, source: 'bank', syncBankFeed: true } };
      const accounts = await finlynqConnector.pullAccounts(conn, {});
      expect(accounts.map((a: any) => [a.externalAccountId, a.name, a.balanceCurrent, a.raw.balance_date, a.raw.basis])).toEqual([
        ['2760', 'Betterment Checking (3054)', 0.84, '2026-09-29', 'bank_anchor'],
        ['2757', 'Betterment Cash Reserve (5739)', null, null, 'bank_anchor'],
      ]);
      expect(accounts[0].raw.bank_feed_sync).toEqual({ synced: true, staged: 1, unmapped: [] });
      expect(f.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/settings/bank-feeds/simplefin/sync']);
      expect(f.calls.filter((c) => c.tool === 'manage_bank_ledger').every((c) => c.args.op === 'list_anchors')).toBe(true);
      expect(f.calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    } finally { f.close(); }
  });

  it('skips the sync while the bank feed is fresh, and fails when it is disconnected or reports errors', async () => {
    const fresh = await startFinlynqBankMock({ lastSyncAt: new Date().toISOString() });
    try {
      const accounts = await finlynqConnector.pullAccounts({ id: 'f', config: { apiKey: KEY, mcpUrl: fresh.url, source: 'bank', syncBankFeed: true } }, {});
      expect(accounts[0].raw.bank_feed_sync.skipped).toBe('fresh');
      expect(fresh.calls.some((c) => c.method === 'POST')).toBe(false);
    } finally { fresh.close(); }
    const off = await startFinlynqBankMock({ connected: false });
    try {
      await expect(finlynqConnector.pullAccounts({ id: 'f', config: { apiKey: KEY, mcpUrl: off.url, source: 'bank', syncBankFeed: true } }, {})).rejects.toThrow(/bank feed is not connected/);
    } finally { off.close(); }
    const bad = await startFinlynqBankMock({ syncErrors: ['Claim failed (HTTP 403)'] });
    try {
      await expect(finlynqConnector.pullAccounts({ id: 'f', config: { apiKey: KEY, mcpUrl: bad.url, source: 'bank', syncBankFeed: true } }, {})).rejects.toThrow(/bank-feed sync reported: Claim failed/);
    } finally { bad.close(); }
  });

  it('pulls bank-ledger rows inside the lookback window without syncing when syncBankFeed is off', async () => {
    const f = await startFinlynqBankMock();
    try {
      const conn = { id: 'f', config: { apiKey: KEY, mcpUrl: f.url, source: 'bank', accountIds: [2760] } };
      const txns = await finlynqConnector.pullTransactions(conn, { since: '2026-09-20T00:00:00Z' });
      expect(txns.map((t: any) => [t.externalTxnId, t.externalAccountId, t.direction, t.amount, t.description, t.postedDate])).toEqual([
        ['bank:b-1', '2760', 'debit', 10, 'Bill.com', '2026-09-28'],
        ['bank:b-2', '2760', 'credit', 10, 'Returned', '2026-09-28'],
      ]);
      expect(f.calls.map((c) => c.path).filter((p) => p !== '/api/mcp')).toEqual(['/api/import/bank-ledger?accountId=2760']);
    } finally { f.close(); }
  });

  it('refuses write ops of multi-op tools and requires manage_bank_ledger at handshake for the bank source', async () => {
    const f = await startFinlynqMock();
    try {
      await expect(finlynqConnector.handshake({ id: 'f', config: { apiKey: KEY, mcpUrl: f.url, source: 'bank' } }, {})).rejects.toThrow(/does not expose manage_bank_ledger/);
    } finally { f.close(); }
    const b = await startFinlynqBankMock();
    try {
      const hs = await finlynqConnector.handshake({ id: 'f', config: { apiKey: KEY, mcpUrl: b.url, source: 'bank' } }, {});
      expect(hs.meta.source).toBe('bank');
      expect(b.calls.some((c) => c.tool === 'manage_bank_ledger' && c.args.op !== 'list_anchors')).toBe(false);
    } finally { b.close(); }
  });
});

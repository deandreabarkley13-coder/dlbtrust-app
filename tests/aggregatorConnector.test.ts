import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import type { AddressInfo } from 'net';

// The aggregator connectors are CommonJS modules in the server tree.
const require = createRequire(import.meta.url);
const {
  genericRestConnector,
  getAccessToken,
  clearTokenCache,
} = require('../server/integrations/aggregator/connectors/genericRestConnector');
const { getConnector, listConnectorTypes } = require('../server/integrations/aggregator/connectors');
const { BankingAggregator } = require('../server/integrations/aggregator/bankingAggregator');

// A tiny in-process provider: a token endpoint + a transactions endpoint that
// records the Authorization header it receives.
function startProvider() {
  let tokenRequests = 0;
  let lastAuthHeader: string | undefined;
  let lastAcceptHeader: string | undefined;

  const server = http.createServer((req, res) => {
    if (req.url === '/mx/transactions' && req.method === 'GET') {
      lastAuthHeader = req.headers['authorization'] as string;
      lastAcceptHeader = req.headers['accept'] as string;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transactions: [
        { guid: 'TRN-1', account_guid: 'ACT-1', amount: 12.5, type: 'CREDIT', transacted_at: '2026-01-01' },
        { guid: 'TRN-2', account_guid: 'ACT-1', amount: 4.0, type: 'DEBIT', transacted_at: '2026-01-02' },
      ] }));
      return;
    }
    if (req.url === '/oauth/token' && req.method === 'POST') {
      tokenRequests++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'tok-' + tokenRequests, expires_in: 3600 }));
      });
      return;
    }
    if (req.url === '/v1/transactions' && req.method === 'GET') {
      lastAuthHeader = req.headers['authorization'] as string;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'x1', amount: 12.5 }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise<{
    baseUrl: string;
    tokenUrl: string;
    close: () => void;
    getTokenRequests: () => number;
    getLastAuthHeader: () => string | undefined;
    getLastAcceptHeader: () => string | undefined;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
        close: () => server.close(),
        getTokenRequests: () => tokenRequests,
        getLastAuthHeader: () => lastAuthHeader,
        getLastAcceptHeader: () => lastAcceptHeader,
      });
    });
  });
}

describe('generic_rest OAuth2 client-credentials', () => {
  let provider: Awaited<ReturnType<typeof startProvider>>;

  beforeAll(async () => {
    provider = await startProvider();
  });

  afterAll(() => {
    provider.close();
    clearTokenCache();
  });

  function connFor() {
    return {
      id: 'conn-oauth-1',
      name: 'Test Provider',
      config: {
        baseUrl: provider.baseUrl,
        endpoints: { transactions: '/v1/transactions' },
        allowPrivateNetwork: true, // permit loopback in tests
        listPaths: { transactions: 'data' },
        auth: {
          type: 'oauth2_client_credentials',
          tokenUrl: provider.tokenUrl,
          clientId: 'client-abc',
          clientSecret: 'secret-xyz',
          scope: 'transactions:read',
        },
      },
    };
  }

  it('fetches a token and sends it as a Bearer credential on pulls', async () => {
    clearTokenCache();
    const conn = connFor();
    const txns = await genericRestConnector.pullTransactions(conn, {});
    expect(txns).toHaveLength(1);
    expect(txns[0].externalTxnId).toBe('x1');
    expect(provider.getLastAuthHeader()).toBe('Bearer tok-1');
    expect(provider.getTokenRequests()).toBe(1);
  });

  it('reuses the cached token across requests (no re-fetch before expiry)', async () => {
    clearTokenCache();
    const conn = connFor();
    await genericRestConnector.pullTransactions(conn, {});
    const afterFirst = provider.getTokenRequests();
    await genericRestConnector.pullTransactions(conn, {});
    expect(provider.getTokenRequests()).toBe(afterFirst); // token endpoint not hit again
  });

  it('throws a clear error when required OAuth2 config is missing', async () => {
    await expect(
      getAccessToken({ id: 'c' }, { auth: { type: 'oauth2_client_credentials', tokenUrl: provider.tokenUrl } })
    ).rejects.toThrow(/tokenUrl|clientId|clientSecret/);
  });
});

describe('generic_rest MX-style basic auth + custom headers', () => {
  let provider: Awaited<ReturnType<typeof startProvider>>;

  beforeAll(async () => { provider = await startProvider(); });
  afterAll(() => { provider.close(); });

  it('sends the custom Accept header + Basic auth and normalizes DEBIT/CREDIT casing', async () => {
    const conn = {
      id: 'conn-mx-1',
      name: 'MX',
      config: {
        baseUrl: provider.baseUrl,
        endpoints: { transactions: '/mx/transactions' },
        headers: { Accept: 'application/vnd.mx.api.v1+json' },
        allowPrivateNetwork: true,
        listPaths: { transactions: 'transactions' },
        auth: { type: 'basic', username: 'mx-client', password: 'mx-key' },
        mapping: {
          transactions: {
            externalTxnId: 'guid', externalAccountId: 'account_guid',
            postedDate: 'transacted_at', amount: 'amount', direction: 'type',
          },
        },
      },
    };
    const txns = await genericRestConnector.pullTransactions(conn, {});
    expect(provider.getLastAcceptHeader()).toBe('application/vnd.mx.api.v1+json');
    const expectedBasic = 'Basic ' + Buffer.from('mx-client:mx-key').toString('base64');
    expect(provider.getLastAuthHeader()).toBe(expectedBasic);
    expect(txns.map((t: any) => [t.externalTxnId, t.direction])).toEqual([
      ['TRN-1', 'credit'],
      ['TRN-2', 'debit'],
    ]);
  });
});

describe('connector registry & internal rails', () => {
  it('registers both the generic REST and internal rails connectors', () => {
    expect(listConnectorTypes()).toEqual(expect.arrayContaining(['generic_rest', 'internal_rails']));
  });

  it('internal_rails rejects an unsupported rail before touching engines', async () => {
    const rails = getConnector('internal_rails');
    await expect(rails.push({ id: 'r1', config: {} }, { rail: 'carrier-pigeon', amount: 10, payeeName: 'X' }))
      .rejects.toThrow(/Unsupported rail/);
  });
});

describe('internal_rails pullTransactions direction', () => {
  const pgPool = require('../server/integrations/bonds/pgPool');
  const originalQuery = pgPool.query;

  afterAll(() => { pgPool.query = originalQuery; });

  it('labels deposits as credit and payments as debit', async () => {
    pgPool.query = async () => ({
      rows: [
        { settlement_id: 'S1', payment_method: 'ach', payment_type: 'deposit', amount: 100, status: 'settled' },
        { settlement_id: 'S2', payment_method: 'ach', payment_type: 'bill_cash_deposit', amount: 50, status: 'settled' },
        { settlement_id: 'S3', payment_method: 'wire', payment_type: 'vendor_payment', amount: 75, status: 'transmitted' },
      ],
    });

    const rails = getConnector('internal_rails');
    const txns = await rails.pullTransactions({ id: 'r1', config: {} }, {});
    const byId = Object.fromEntries(txns.map((t: any) => [t.externalTxnId, t.direction]));

    expect(byId.S1).toBe('credit');   // deposit → money in
    expect(byId.S2).toBe('credit');   // bill_cash_deposit → money in
    expect(byId.S3).toBe('debit');    // vendor_payment → money out
  });
});

describe('secret redaction', () => {
  it('redacts the OAuth2 clientSecret but keeps non-secret auth fields', () => {
    const redacted = BankingAggregator._redactConnection({
      id: 'c1',
      name: 'p',
      connector_type: 'generic_rest',
      config: {
        baseUrl: 'https://x',
        auth: { type: 'oauth2_client_credentials', tokenUrl: 'https://t', clientId: 'id', clientSecret: 'shh' },
      },
    });
    expect(redacted.config.auth.clientSecret).toBeUndefined();
    expect(redacted.config.auth.clientId).toBe('id');
    expect(redacted.config.auth.tokenUrl).toBe('https://t');
    expect(redacted.credentials.has_clientSecret).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Handshake + fail-closed push + read/write against a mock provider.
//  The BankingAggregator cases talk to the local Postgres the shared pool
//  points at (default fineract_tenants); they are skipped when it is not
//  reachable so the connector-level cases still run everywhere.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { vi } from 'vitest';
const pool = require('../server/integrations/bonds/pgPool');
const { handshakeSigningString } = require('../server/integrations/aggregator/connectors/genericRestConnector');

type HandshakeMode = 'ok' | 'tampered' | 'unsigned' | 'http500';

function startHandshakeProvider() {
  const secret = 'whsec-test-123';
  let mode: HandshakeMode = 'ok';
  let handshakes = 0;
  let pushes: any[] = [];
  let pulls = 0;
  let lastApiKey: string | undefined;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastApiKey = req.headers['x-api-key'] as string;
      if (req.url === '/connections/register' && req.method === 'POST') {
        handshakes++;
        if (mode === 'http500') { res.writeHead(500); res.end('boom'); return; }
        const challenge = JSON.parse(body);
        const caps = { pull: true, push: true, webhook: false };
        const ext = 'EXT-' + challenge.connection_id;
        let signature = crypto.createHmac('sha256', secret)
          .update(handshakeSigningString(challenge.nonce, ext, caps)).digest('hex');
        if (mode === 'tampered') signature = signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
        const reply: any = { external_connection_id: ext, nonce: challenge.nonce, capabilities: caps, provider: 'mock' };
        if (mode !== 'unsigned') reply.signature = signature;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
        return;
      }
      if (req.url === '/accounts' && req.method === 'GET') {
        pulls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'A-1', name: 'Operating', type: 'checking', currency: 'USD', mask: '1234', balanceCurrent: 100.25, balanceAvailable: 90 }]));
        return;
      }
      if (req.url === '/transactions' && req.method === 'GET') {
        pulls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 'T-1', account_id: 'A-1', amount: 50, direction: 'credit', posted_date: '2026-09-01', description: 'Wire in' },
          { id: 'T-2', account_id: 'A-1', amount: 7.5, direction: 'debit', posted_date: '2026-09-02', description: 'Fee' },
        ]));
        return;
      }
      if (req.url === '/statements' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      if (req.url === '/payments' && req.method === 'POST') {
        pushes.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'PAY-' + pushes.length, status: 'accepted' }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });

  return new Promise<{
    baseUrl: string; secret: string; close: () => void;
    setMode: (m: HandshakeMode) => void;
    counts: () => { handshakes: number; pushes: number; pulls: number };
    pushes: () => any[]; lastApiKey: () => string | undefined;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, secret, close: () => server.close(),
        setMode: (m) => { mode = m; },
        counts: () => ({ handshakes, pushes: pushes.length, pulls }),
        pushes: () => pushes, lastApiKey: () => lastApiKey,
      });
    });
  });
}

describe('generic_rest handshake (connector level)', () => {
  let provider: Awaited<ReturnType<typeof startHandshakeProvider>>;
  beforeAll(async () => { provider = await startHandshakeProvider(); });
  afterAll(() => provider.close());

  const conn = () => ({
    id: 'conn-hs-1', name: 'HS', direction: 'both',
    config: { baseUrl: provider.baseUrl, allowPrivateNetwork: true, webhookSecret: provider.secret },
  });

  it('verifies an HMAC-signed registration reply and returns capabilities', async () => {
    provider.setMode('ok');
    const r = await genericRestConnector.handshake(conn(), { timeoutMs: 5000 });
    expect(r.externalConnectionId).toBe('EXT-conn-hs-1');
    expect(r.capabilities).toEqual({ pull: true, push: true, webhook: false });
    expect(r.meta.secretSource).toBe('webhookSecret');
  });

  it('rejects a tampered signature', async () => {
    provider.setMode('tampered');
    await expect(genericRestConnector.handshake(conn(), {})).rejects.toThrow(/signature verification failed/);
  });

  it('rejects an unsigned reply and a provider failure', async () => {
    provider.setMode('unsigned');
    await expect(genericRestConnector.handshake(conn(), {})).rejects.toThrow(/unsigned/);
    provider.setMode('http500');
    await expect(genericRestConnector.handshake(conn(), {})).rejects.toThrow();
  });

  it('refuses to handshake without a verification secret', async () => {
    await expect(genericRestConnector.handshake({ id: 'x', config: { baseUrl: provider.baseUrl } }, {}))
      .rejects.toThrow(/webhookSecret or config.apiSecret/);
  });
});

let pgAvailable = false;
try {
  await pool.query('SELECT 1');
  pgAvailable = true;
} catch (e) {
  pgAvailable = false;
}

describe.skipIf(!pgAvailable)('BankingAggregator read/write with handshake + live/shadow gates (local Postgres)', () => {
  let provider: Awaited<ReturnType<typeof startHandshakeProvider>>;
  const ids: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ['AGGREGATOR_DEFAULT_MODE', 'AGGREGATOR_HANDSHAKE_TIMEOUT_MS', 'AGGREGATOR_HS_LIVE_API_KEY']) savedEnv[k] = process.env[k];
    delete process.env.AGGREGATOR_DEFAULT_MODE;
    process.env.AGGREGATOR_HANDSHAKE_TIMEOUT_MS = '5000';
    provider = await startHandshakeProvider();
    await BankingAggregator.ensureTables();
  });

  afterAll(async () => {
    provider.close();
    for (const id of ids) {
      await pool.query('DELETE FROM banking_aggregator_events WHERE connection_id = $1', [id]);
      await pool.query('DELETE FROM banking_aggregator_transactions WHERE connection_id = $1', [id]);
      await pool.query('DELETE FROM banking_aggregator_accounts WHERE connection_id = $1', [id]);
      await pool.query('DELETE FROM banking_aggregator_connections WHERE id = $1', [id]);
    }
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const uid = (p: string) => { const id = `${p}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`; ids.push(id); return id; };
  const baseConfig = () => ({ baseUrl: provider.baseUrl, allowPrivateNetwork: true, webhookSecret: provider.secret });

  it('migrates the handshake columns + constraint onto the connections table', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'banking_aggregator_connections'
          AND column_name IN ('handshake_state','handshake_at','handshake_meta','external_connection_id')`);
    expect(cols.rows.map((r: any) => r.column_name).sort())
      .toEqual(['external_connection_id', 'handshake_at', 'handshake_meta', 'handshake_state']);
    await expect(pool.query(
      `INSERT INTO banking_aggregator_connections (id, name, connector_type, direction, config, handshake_state)
       VALUES ($1,'bad','generic_rest','both','{}'::jsonb,'bogus')`, [uid('CONN-BAD')]))
      .rejects.toThrow(/handshake_state_check/);
  });

  it('auto-handshakes on create, persists external id + capabilities, and redacts secrets', async () => {
    provider.setMode('ok');
    const conn = await BankingAggregator.createConnection({
      id: uid('CONN-HS'), name: 'HS Provider', connectorType: 'generic_rest', direction: 'both', config: baseConfig(),
    });
    expect(conn.handshake_state).toBe('verified');
    expect(conn.external_connection_id).toBe('EXT-' + conn.id);
    expect(conn.capabilities).toEqual({ pull: true, push: true, webhook: false });
    expect(conn.mode).toBe('shadow');
    expect(conn.config.webhookSecret).toBeUndefined();
    expect(conn.credentials.has_webhookSecret).toBe(true);
    expect(JSON.stringify(conn)).not.toContain(provider.secret);

    const hs = await BankingAggregator.getHandshake(conn.id);
    expect(hs.handshake_state).toBe('verified');
    expect(JSON.stringify(hs)).not.toContain(provider.secret);
  });

  it('marks the connection failed on a tampered handshake and refuses pull/push until verified; retry recovers', async () => {
    provider.setMode('tampered');
    const conn = await BankingAggregator.createConnection({
      id: uid('CONN-TAMPER'), name: 'Tampered', connectorType: 'generic_rest', direction: 'both', config: baseConfig(),
    });
    expect(conn.handshake_state).toBe('failed');
    expect(conn.external_connection_id).toBeNull();

    await expect(BankingAggregator.pull(conn.id, { kinds: ['accounts'] })).rejects.toThrow(/handshake_state is failed/);
    await expect(BankingAggregator.push(conn.id, { type: 'payment', amount: 1 })).rejects.toThrow(/handshake_state is failed/);
    const before = provider.counts();
    expect(before.pulls).toBe(0);
    expect(before.pushes).toBe(0);

    provider.setMode('ok');
    const retried = await BankingAggregator.handshake(conn.id);
    expect(retried.handshake_state).toBe('verified');
    expect(retried.external_connection_id).toBe('EXT-' + conn.id);
  });

  it('re-handshakes when config changes on update (and not on non-config updates)', async () => {
    provider.setMode('ok');
    const conn = await BankingAggregator.createConnection({
      id: uid('CONN-UPD'), name: 'Upd', connectorType: 'generic_rest', direction: 'both', config: baseConfig(),
    });
    const n0 = provider.counts().handshakes;
    await BankingAggregator.updateConnection(conn.id, { name: 'Upd renamed' });
    expect(provider.counts().handshakes).toBe(n0);
    await BankingAggregator.updateConnection(conn.id, { config: Object.assign(baseConfig(), { pullKinds: ['accounts'] }) });
    expect(provider.counts().handshakes).toBe(n0 + 1);
  });

  it('READ: pulls accounts + transactions from the provider into aggregator tables', async () => {
    provider.setMode('ok');
    const conn = await BankingAggregator.createConnection({
      id: uid('CONN-READ'), name: 'Reader', connectorType: 'generic_rest', direction: 'inbound', config: baseConfig(),
    });
    const summary = await BankingAggregator.pull(conn.id, { kinds: ['accounts', 'transactions'] });
    expect(summary.errors).toEqual([]);
    expect(summary.accounts).toBe(1);
    expect(summary.transactions).toBe(2);

    const accts = await pool.query('SELECT * FROM banking_aggregator_accounts WHERE connection_id = $1', [conn.id]);
    expect(accts.rows).toHaveLength(1);
    expect(Number(accts.rows[0].balance_current)).toBe(100.25);
    const txns = await pool.query('SELECT external_txn_id, amount, direction FROM banking_aggregator_transactions WHERE connection_id = $1 ORDER BY external_txn_id', [conn.id]);
    expect(txns.rows.map((r: any) => [r.external_txn_id, Number(r.amount), r.direction]))
      .toEqual([['T-1', 50, 'credit'], ['T-2', 7.5, 'debit']]);

    // idempotent re-pull
    const again = await BankingAggregator.pull(conn.id, { kinds: ['transactions'] });
    expect(again.transactions).toBe(2);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM banking_aggregator_transactions WHERE connection_id = $1', [conn.id]);
    expect(count.rows[0].n).toBe(2);
    const evt = await pool.query(`SELECT status FROM banking_aggregator_events WHERE connection_id = $1 AND event_type = 'pull'`, [conn.id]);
    expect(evt.rows.length).toBeGreaterThanOrEqual(2);
    expect(evt.rows.every((r: any) => r.status === 'processed')).toBe(true);
  });

  it('WRITE (shadow): journals the redacted event and never calls the provider', async () => {
    provider.setMode('ok');
    const conn = await BankingAggregator.createConnection({
      id: uid('CONN-SHADOW'), name: 'Shadow', connectorType: 'generic_rest', direction: 'outbound', config: baseConfig(),
    });
    const pushSpy = vi.spyOn(genericRestConnector, 'push');
    const before = provider.counts().pushes;
    const r = await BankingAggregator.push(conn.id, { type: 'payment', amount: 25, apiKey: 'leak-me', password: 'pw' });
    expect(r.shadow).toBe(true);
    expect(r.mode).toBe('shadow');
    expect(r.eventId).toMatch(/^EVT-/);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(provider.counts().pushes).toBe(before);
    pushSpy.mockRestore();

    const evt = await pool.query('SELECT payload, status FROM banking_aggregator_events WHERE id = $1', [r.eventId]);
    expect(evt.rows[0].status).toBe('processed');
    expect(evt.rows[0].payload.mode).toBe('shadow');
    expect(evt.rows[0].payload.payload.amount).toBe(25);
    expect(evt.rows[0].payload.payload.apiKey).toBeUndefined();
    expect(evt.rows[0].payload.payload.password).toBeUndefined();
  });

  it('WRITE (live): refuses without approvalRef / screeningRef (409, provider untouched) and transmits with both', async () => {
    provider.setMode('ok');
    process.env.AGGREGATOR_HS_LIVE_API_KEY = 'sm-projected-key'; // Secret Manager → env → connection config
    const conn = await BankingAggregator.createConnection({
      id: uid('CONN-LIVE'), name: 'HS Live', connectorType: 'generic_rest', direction: 'outbound',
      config: Object.assign(baseConfig(), { mode: 'live' }),
    });
    expect(conn.mode).toBe('live');
    expect(conn.credentials.env_prefix).toBe('AGGREGATOR_HS_LIVE');
    expect(conn.credentials.has_apiKey).toBe(true);
    expect(conn.config.apiKey).toBeUndefined();
    const stored = await pool.query('SELECT config FROM banking_aggregator_connections WHERE id = $1', [conn.id]);
    expect(stored.rows[0].config.apiKey).toBeUndefined(); // never persisted

    const before = provider.counts().pushes;
    await expect(BankingAggregator.push(conn.id, { type: 'payment', amount: 10, screeningRef: 'SCR-1' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/approvalRef/) });
    await expect(BankingAggregator.push(conn.id, { type: 'payment', amount: 10, approvalRef: 'APR-1' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/screeningRef/) });
    expect(provider.counts().pushes).toBe(before);

    const r = await BankingAggregator.push(conn.id, { type: 'payment', amount: 10, approvalRef: 'APR-1', screeningRef: 'SCR-1' });
    expect(r.mode).toBe('live');
    expect(r.shadow).toBe(false);
    expect(r.providerRef).toBe('PAY-1');
    expect(provider.counts().pushes).toBe(before + 1);
    expect(provider.pushes()[0].amount).toBe(10);
    expect(provider.lastApiKey()).toBe('sm-projected-key');

    const evt = await pool.query(`SELECT status, provider_ref, payload FROM banking_aggregator_events WHERE connection_id = $1 AND event_type = 'payment' ORDER BY created_at DESC LIMIT 1`, [conn.id]);
    expect(evt.rows[0].status).toBe('sent');
    expect(evt.rows[0].provider_ref).toBe('PAY-1');
    expect(evt.rows[0].payload.approvalRef).toBe('APR-1');
    expect(evt.rows[0].payload.screeningRef).toBe('SCR-1');
    const row = await pool.query('SELECT last_push_at FROM banking_aggregator_connections WHERE id = $1', [conn.id]);
    expect(row.rows[0].last_push_at).not.toBeNull();
  });

  it('status() reports a handshake summary', async () => {
    const s = await BankingAggregator.status();
    expect(s.handshake).toBeDefined();
    expect(s.handshake.by_state.verified).toBeGreaterThanOrEqual(1);
    expect(s.handshake.by_mode.live).toBeGreaterThanOrEqual(1);
    expect(['live', 'shadow']).toContain(s.default_mode);
  });
});

// ─── Data-aggregator connectors (BankSync / Orange Rails) for API-less banks
// such as the trust's Betterment Trust Checking account ──────────────────────
const { bankSyncConnector } = require('../server/integrations/aggregator/connectors/bankSyncConnector');
const { orangeRailsConnector, encryptPayload } = require('../server/integrations/aggregator/connectors/orangeRailsConnector');
const { DataBridge } = require('../server/integrations/accounting/dataBridge');

function startBankSyncMock(opts: { planBlocked?: boolean } = {}) {
  const calls: string[] = [];
  let lastKey: string | undefined;
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    lastKey = req.headers['x-api-key'] as string;
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (lastKey !== 'bs-key') return json(401, { message: 'Invalid API key' });
    if (opts.planBlocked) return json(403, { message: 'API access is not included on this plan. Upgrade to Standard or above at /settings/billing.' });
    const url = req.url || '';
    if (url === '/whoami') return json(200, { success: true, data: { workspaceId: 'ws_1', workspaceName: 'DLB Trust' } });
    if (url === '/banks') return json(200, { success: true, data: [
      { id: 'bnk_lili', name: 'Lili', provider: 'lili', status: 'connected' },
      { id: 'bnk_bett', name: 'Betterment Checking', provider: 'betterment', status: 'connected' },
    ] });
    if (url === '/banks/bnk_bett/accounts') return json(200, { success: true, data: [
      { id: 'acc_trust', name: 'Betterment Trust Checking', type: 'depository', subtype: 'checking', currency: 'USD', mask: '3054', balance: { current: 12500.75, available: 12400 } },
    ] });
    if (url.startsWith('/banks/bnk_bett/accounts/acc_trust/transactions')) {
      const u = new URL(url, 'http://x');
      if (!u.searchParams.get('cursor')) {
        return json(200, { success: true, data: [
          { id: 'bstx_1', amount: -42.1, currency: 'USD', description: 'ACH DEBIT VENDOR', date: '2026-09-01', pending: false, category: 'transfer' },
        ], nextCursor: 'c2' });
      }
      return json(200, { success: true, data: [
        { id: 'bstx_2', amount: 1000, currency: 'USD', description: 'ACH CREDIT DISTRIBUTION', date: '2026-09-02', pending: true },
      ] });
    }
    return json(404, { message: 'not found' });
  });
  return new Promise<{ baseUrl: string; calls: string[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, calls, close: () => server.close() });
    });
  });
}


const OR_TXN_KEY = Buffer.alloc(32, 7).toString('base64');
const OR_CRED_KEY = Buffer.alloc(32, 9).toString('base64');

function startOrangeRailsMock(opts: { linked?: boolean } = {}) {
  const bodies: Record<string, any[]> = {};
  const keys: string[] = [];
  const linked = opts.linked !== false;
  const enc = (o: unknown) => encryptPayload(o, OR_TXN_KEY);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      (bodies[req.url || ''] ||= []).push(body);
      keys.push(String(req.headers['x-platform-api-key']));
      const json = (code: number, out: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); };
      if (req.headers['x-platform-api-key'] !== 'or-platform-key') return json(401, { error: 'Invalid platform API key' });
      if (req.url === '/v1/platforms/provision') {
        if (body.external_user_id !== 'dlb-family-trust') return json(400, { error: 'external_user_id required' });
        return json(200, { subaccount_id: 'sub-dlb-1', created: false });
      }
      if (req.url === '/v1/connections/list') {
        if (body.subaccount_id !== 'sub-dlb-1') return json(404, { error: 'unknown subaccount' });
        return json(200, { connections: linked ? [{ id: 'orc-bett', provider_type: 'quiltt', status: 'active', last_sync_at: '2026-09-26T00:00:00Z' }] : [] });
      }
      if (req.url === '/v1/quiltt/session') return json(200, { session_token: 'quiltt-session-jwt', connector_id: 'conn-link', expires_at: '2026-09-28T16:00:00Z' });
      if (req.url === '/v1/quiltt/accounts') return json(200, { accounts: [
        { id: 'qa_bett', name: 'Betterment Checking', institution_name: 'Betterment', kind: 'CHECKING', mask: '3054', currency: 'USD', state: 'OPEN', balance_current: 12500.75, balance_available: 12400, connection: { id: 'orc-bett', status: 'SYNCED' } },
        { id: 'qa_other', name: 'Chase Savings', institution_name: 'Chase', kind: 'SAVINGS', mask: '1111', currency: 'USD', state: 'OPEN', balance_current: 5, balance_available: 5, connection: null },
      ] });
      if (req.url === '/v1/connections/sync') {
        if (body.credentials_key !== OR_CRED_KEY || body.transactions_key !== OR_TXN_KEY) return json(400, { error: 'credentials_key required' });
        return json(200, { synced: 3, connections: [{ connection_id: 'orc-bett', synced: 3, next_cursor: null }] });
      }
      if (req.url === '/v1/transactions/list') {
        const page1 = [
          { id: 'row3', connection_id: 'orc-bett', external_id: 'qtx_3', occurred_at: '2026-09-03T00:00:00Z', encrypted_payload: enc({ amount: 250, currency: 'USD', description: 'BOND COUPON PAYMENT SERIES A', entry_type: 'CREDIT', upstream_status: 'POSTED', account_id: 'qa_bett' }) },
          { id: 'row2', connection_id: 'orc-bett', external_id: 'qtx_2', occurred_at: '2026-09-02T00:00:00Z', encrypted_payload: enc({ amount: 1000, currency: 'USD', description: 'TRUST CONTRIBUTION', entry_type: 'CREDIT', upstream_status: 'PENDING', account_id: 'qa_bett' }) },
        ];
        const page2 = [
          { id: 'row1', connection_id: 'orc-bett', external_id: 'qtx_1', occurred_at: '2026-09-01T00:00:00Z', encrypted_payload: enc({ amount: 42.1, currency: 'USD', description: 'ACH DEBIT VENDOR', entry_type: 'DEBIT', upstream_status: 'POSTED', account_id: 'qa_bett' }) },
          { id: 'row0', connection_id: 'orc-bett', external_id: 'qtx_0', occurred_at: '2026-07-01T00:00:00Z', encrypted_payload: enc({ amount: 1, currency: 'USD', description: 'OLD', entry_type: 'DEBIT', upstream_status: 'POSTED', account_id: 'qa_bett' }) },
        ];
        return json(200, { transactions: !body.before ? page1 : body.before > '2026-08-01' ? page2 : [] });
      }
      return json(404, { error: 'no route' });
    });
  });
  return new Promise<{ baseUrl: string; bodies: Record<string, any[]>; keys: string[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, bodies, keys, close: () => server.close() });
    });
  });
}

describe('banksync connector (Betterment via open-banking feed)', () => {
  it('is registered alongside orangerails', () => {
    expect(listConnectorTypes()).toEqual(expect.arrayContaining(['banksync', 'orangerails']));
  });

  it('handshakes: whoami + resolves the Betterment bank by name, read-only capabilities', async () => {
    const bs = await startBankSyncMock();
    try {
      const conn = { id: 'c1', config: { baseUrl: bs.baseUrl, apiKey: 'bs-key', bankName: 'Betterment' } };
      const hs = await bankSyncConnector.handshake(conn, {});
      expect(hs.externalConnectionId).toBe('bnk_bett');
      expect(hs.capabilities).toEqual({ pull: true, push: false, webhook: false });
      expect(hs.meta.bank.name).toBe('Betterment Checking');
      expect(hs.meta.workspace).toBe('DLB Trust');
      expect(bankSyncConnector.push).toBeUndefined();
    } finally { bs.close(); }
  });

  it('fails the handshake with the provider message when the plan blocks API access', async () => {
    const bs = await startBankSyncMock({ planBlocked: true });
    try {
      await expect(bankSyncConnector.handshake({ id: 'c1', config: { baseUrl: bs.baseUrl, apiKey: 'bs-key', bankName: 'Betterment' } }, {}))
        .rejects.toThrow(/API access is not included on this plan/);
    } finally { bs.close(); }
  });

  it('fails the handshake when Betterment is not linked, listing what is', async () => {
    const bs = await startBankSyncMock();
    try {
      await expect(bankSyncConnector.handshake({ id: 'c1', config: { baseUrl: bs.baseUrl, apiKey: 'bs-key', bankName: 'Chase' } }, {}))
        .rejects.toThrow(/no linked bank matching "Chase" \(linked: Lili, Betterment Checking\)/);
    } finally { bs.close(); }
  });

  it('pulls normalized accounts and paginated transactions with direction from sign/pending', async () => {
    const bs = await startBankSyncMock();
    try {
      const conn = { id: 'c1', handshake_state: 'verified', external_connection_id: 'bnk_bett', config: { baseUrl: bs.baseUrl, apiKey: 'bs-key', bankName: 'Betterment' } };
      const accounts = await bankSyncConnector.pullAccounts(conn, {});
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ externalAccountId: 'acc_trust', accountType: 'depository/checking', mask: '3054', balanceCurrent: 12500.75, balanceAvailable: 12400 });
      const txns = await bankSyncConnector.pullTransactions(conn, { since: '2026-08-01T00:00:00Z' });
      expect(txns.map((t: any) => [t.externalTxnId, t.direction, t.amount, t.status])).toEqual([
        ['bstx_1', 'debit', 42.1, 'posted'],
        ['bstx_2', 'credit', 1000, 'pending'],
      ]);
      expect(bs.calls.some((c) => c.includes('from=2026-08-01'))).toBe(true);
      expect(bs.calls.some((c) => c.includes('cursor=c2'))).toBe(true);
      expect(bs.calls.some((c) => c.startsWith('GET /banks') && c === 'GET /banks')).toBe(false);
    } finally { bs.close(); }
  });
});

describe('orangerails connector (Betterment via Orange Rails → Quiltt)', () => {
  const cfg = (o: any, extra: any = {}) => ({ id: 'o1', config: { baseUrl: o.baseUrl, apiKey: 'or-platform-key', credentialsKey: OR_CRED_KEY, transactionsKey: OR_TXN_KEY, institutionName: 'Betterment', ...extra } });

  it('handshakes: provisions the trust subaccount, requires a linked Quiltt bank connection, read-only', async () => {
    const or = await startOrangeRailsMock();
    try {
      const hs = await orangeRailsConnector.handshake(cfg(or), {});
      expect(hs.externalConnectionId).toBe('sub-dlb-1');
      expect(hs.capabilities).toEqual({ pull: true, push: false, webhook: false });
      expect(hs.meta.bankConnections).toEqual([{ id: 'orc-bett', status: 'active', lastSyncAt: '2026-09-26T00:00:00Z' }]);
      expect(or.bodies['/v1/platforms/provision'][0]).toEqual({ external_user_id: 'dlb-family-trust' });
      expect(JSON.stringify(hs)).not.toContain('or-platform-key');
      expect(JSON.stringify(hs)).not.toContain(OR_TXN_KEY);
      expect(orangeRailsConnector.push).toBeUndefined();

      await expect(orangeRailsConnector.handshake({ id: 'o1', config: { baseUrl: or.baseUrl, apiKey: 'wrong', credentialsKey: OR_CRED_KEY, transactionsKey: OR_TXN_KEY } }, {}))
        .rejects.toThrow(/Invalid platform API key/);
      await expect(orangeRailsConnector.handshake({ id: 'o1', config: { baseUrl: or.baseUrl, apiKey: 'or-platform-key' } }, {}))
        .rejects.toThrow(/vault keys missing/);
    } finally { or.close(); }
  });

  it('fails the handshake until the bank is linked in the widget, and reports link status', async () => {
    const or = await startOrangeRailsMock({ linked: false });
    try {
      await expect(orangeRailsConnector.handshake(cfg(or), {})).rejects.toThrow(/no linked bank connection.*link Betterment in the Quiltt widget/);
      const link = await orangeRailsConnector.createLinkToken(cfg(or), {});
      expect(link).toMatchObject({ linkToken: 'quiltt-session-jwt', connectorId: 'conn-link' });
      expect(await orangeRailsConnector.linkStatus(cfg(or), {})).toMatchObject({ subaccountId: 'sub-dlb-1', linked: false, connections: [] });
    } finally { or.close(); }
  });

  it('pulls Betterment accounts only, syncs, then lists + decrypts paginated transactions in-process', async () => {
    const or = await startOrangeRailsMock();
    try {
      const conn = { ...cfg(or), external_connection_id: 'sub-dlb-1' };
      const accounts = await orangeRailsConnector.pullAccounts(conn, {});
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ externalAccountId: 'qa_bett', name: 'Betterment Checking', accountType: 'checking', mask: '3054', balanceCurrent: 12500.75, balanceAvailable: 12400 });

      const txns = await orangeRailsConnector.pullTransactions(conn, { since: '2026-08-01T00:00:00Z' });
      expect(txns.map((t: any) => [t.externalTxnId, t.direction, t.amount, t.status, t.description])).toEqual([
        ['qtx_3', 'credit', 250, 'posted', 'BOND COUPON PAYMENT SERIES A'],
        ['qtx_2', 'credit', 1000, 'pending', 'TRUST CONTRIBUTION'],
        ['qtx_1', 'debit', 42.1, 'posted', 'ACH DEBIT VENDOR'],
      ]);
      expect(or.bodies['/v1/connections/sync'][0]).toMatchObject({ subaccount_id: 'sub-dlb-1' });
      expect(or.bodies['/v1/transactions/list']).toHaveLength(2);
      expect(or.bodies['/v1/transactions/list'][1].before).toBe('2026-09-02T00:00:00Z');
      // Cleartext never leaves the process: the wire only carries ciphertext.
      expect(JSON.stringify(or.bodies)).not.toContain('BOND COUPON');

      await expect(orangeRailsConnector.pullTransactions({ ...conn, config: { ...conn.config, transactionsKey: Buffer.alloc(32, 1).toString('base64') } }, {}))
        .rejects.toThrow();
    } finally { or.close(); }
  });
});

describe('DataBridge.classifyAggregatorTxn keeps trust principal and coupon/interest income apart', () => {
  const principal = { creditDefault: 'principal' };
  it('routes coupon and interest credits to 1020 coupon cash + income, other credits to corpus on a principal account', () => {
    expect(DataBridge.classifyAggregatorTxn({ direction: 'credit', description: 'BOND COUPON PAYMENT SERIES A' }, principal))
      .toEqual({ classification: 'coupon_income', debit: '1020', credit: '4100' });
    expect(DataBridge.classifyAggregatorTxn({ direction: 'credit', description: 'Betterment APY interest' }, principal))
      .toEqual({ classification: 'interest_income', debit: '1020', credit: '4000' });
    expect(DataBridge.classifyAggregatorTxn({ direction: 'credit', description: 'TRUST CONTRIBUTION' }, principal))
      .toEqual({ classification: 'principal', debit: '1000', credit: '3000' });
    expect(DataBridge.classifyAggregatorTxn({ direction: 'credit', description: 'ACH CREDIT' }, {}))
      .toEqual({ classification: 'fee_income', debit: '1000', credit: '4200' });
    expect(DataBridge.classifyAggregatorTxn({ direction: 'credit', description: 'Bond maturity redemption' }, {}))
      .toEqual({ classification: 'principal', debit: '1000', credit: '3000' });
  });
  it('routes debits to fee / distribution / operating expense with cash as the credit side', () => {
    expect(DataBridge.classifyAggregatorTxn({ direction: 'debit', description: 'Monthly service fee' }, principal)).toMatchObject({ classification: 'fee_expense', debit: '5000', credit: '1000' });
    expect(DataBridge.classifyAggregatorTxn({ direction: 'debit', description: 'Beneficiary distribution Q3' }, principal)).toMatchObject({ classification: 'distribution', debit: '2000', credit: '1000' });
    expect(DataBridge.classifyAggregatorTxn({ direction: 'debit', description: 'ACH DEBIT VENDOR' }, principal)).toMatchObject({ classification: 'operating_expense', debit: '5300', credit: '1000' });
    expect(DataBridge.classifyAggregatorTxn({ amount: -5, description: 'x' }, {}).classification).toBe('operating_expense');
  });
});

describe.skipIf(!pgAvailable)('Betterment Trust Checking read path through BankingAggregator (local Postgres)', () => {
  const ids: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};
  let bs: Awaited<ReturnType<typeof startBankSyncMock>>;
  let or: Awaited<ReturnType<typeof startOrangeRailsMock>>;

  beforeAll(async () => {
    for (const k of ['AGGREGATOR_DEFAULT_MODE', 'AGGREGATOR_BETTERMENT_TRUST_CHECKING_API_KEY', 'AGGREGATOR_BETTERMENT_ORANGERAILS_API_KEY', 'AGGREGATOR_BETTERMENT_ORANGERAILS_CREDENTIALS_KEY', 'AGGREGATOR_BETTERMENT_ORANGERAILS_TRANSACTIONS_KEY', 'BANKSYNC_API_KEY', 'ORANGERAILS_PLATFORM_API_KEY']) savedEnv[k] = process.env[k];
    delete process.env.AGGREGATOR_DEFAULT_MODE;
    delete process.env.BANKSYNC_API_KEY;
    delete process.env.ORANGERAILS_PLATFORM_API_KEY;
    bs = await startBankSyncMock();
    or = await startOrangeRailsMock();
    await BankingAggregator.ensureTables();
  });

  afterAll(async () => {
    bs.close(); or.close();
    for (const id of ids) {
      await pool.query(`DELETE FROM trust_journal_entries WHERE reference_type = 'aggregator_txn' AND reference_id IN (SELECT id FROM banking_aggregator_transactions WHERE connection_id = $1)`, [id]).catch(() => {});
      await pool.query('DELETE FROM banking_aggregator_events WHERE connection_id = $1', [id]);
      await pool.query('DELETE FROM banking_aggregator_transactions WHERE connection_id = $1', [id]);
      await pool.query('DELETE FROM banking_aggregator_accounts WHERE connection_id = $1', [id]);
      await pool.query('DELETE FROM banking_aggregator_connections WHERE id = $1', [id]);
    }
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('banksync: handshake fails closed without a key, verifies with the Secret-Manager-projected key, then pulls accounts + transactions idempotently', async () => {
    const id = `CONN-BETTERMENT-TRUST-CHECKING-T${Date.now()}`; ids.push(id);
    const conn = await BankingAggregator.createConnection({
      id, name: 'Betterment Trust Checking', connectorType: 'banksync', direction: 'inbound',
      config: { mode: 'live', bankName: 'Betterment', baseUrl: bs.baseUrl, pullKinds: ['accounts', 'transactions'], credentialsEnvPrefix: 'AGGREGATOR_BETTERMENT_TRUST_CHECKING' },
    });
    expect(conn.handshake_state).toBe('failed');
    expect(conn.mode).toBe('live');
    await expect(BankingAggregator.pull(id)).rejects.toMatchObject({ status: 409 });
    expect(bs.calls.filter((c) => c.includes('/accounts'))).toHaveLength(0);

    process.env.AGGREGATOR_BETTERMENT_TRUST_CHECKING_API_KEY = 'bs-key';
    const hs = await BankingAggregator.handshake(id);
    expect(hs.handshake_state).toBe('verified');
    expect(hs.external_connection_id).toBe('bnk_bett');
    expect(hs.capabilities).toEqual({ pull: true, push: false, webhook: false });
    const view = await BankingAggregator.getConnection(id);
    expect(view.credentials.has_apiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('bs-key');

    const s1 = await BankingAggregator.pull(id);
    expect(s1).toMatchObject({ accounts: 1, transactions: 2, errors: [] });
    const s2 = await BankingAggregator.pull(id);
    expect(s2).toMatchObject({ accounts: 1, transactions: 2, errors: [] });
    const acct = await pool.query('SELECT * FROM banking_aggregator_accounts WHERE connection_id = $1', [id]);
    expect(acct.rows).toHaveLength(1);
    expect(Number(acct.rows[0].balance_current)).toBe(12500.75);
    const txns = await pool.query('SELECT external_txn_id, direction, amount FROM banking_aggregator_transactions WHERE connection_id = $1 ORDER BY external_txn_id', [id]);
    expect(txns.rows.map((r: any) => [r.external_txn_id, r.direction, Number(r.amount)])).toEqual([['bstx_1', 'debit', 42.1], ['bstx_2', 'credit', 1000]]);

    // Read-only feed: a live push is refused before any gate because the connector cannot push.
    await expect(BankingAggregator.push(id, { type: 'payment', amount: 1, approvalRef: 'A', screeningRef: 'S' })).rejects.toThrow();
  });

  it('orangerails: verifies with projected platform + vault keys, pulls the same account shape, redacts keys, and posts principal vs coupon income to the trust GL', async () => {
    const id = `CONN-BETTERMENT-ORANGERAILS-T${Date.now()}`; ids.push(id);
    process.env.AGGREGATOR_BETTERMENT_ORANGERAILS_API_KEY = 'or-platform-key';
    process.env.AGGREGATOR_BETTERMENT_ORANGERAILS_CREDENTIALS_KEY = OR_CRED_KEY;
    process.env.AGGREGATOR_BETTERMENT_ORANGERAILS_TRANSACTIONS_KEY = OR_TXN_KEY;
    const conn = await BankingAggregator.createConnection({
      id, name: 'Betterment OrangeRails', connectorType: 'orangerails', direction: 'inbound',
      config: { mode: 'live', baseUrl: or.baseUrl, institutionName: 'Betterment', lookbackDays: 45, pullKinds: ['accounts', 'transactions'], accounting: { creditDefault: 'principal' } },
    });
    expect(conn.handshake_state).toBe('verified');
    expect(conn.external_connection_id).toBe('sub-dlb-1');
    expect(conn.credentials.has_transactionsKey).toBe(true);
    expect(conn.config.transactionsKey).toBeUndefined();
    expect(JSON.stringify(conn)).not.toContain(OR_TXN_KEY);
    expect(JSON.stringify(conn)).not.toContain('or-platform-key');

    const s = await BankingAggregator.pull(id);
    expect(s).toMatchObject({ accounts: 1, transactions: 3, errors: [] });
    const row = await pool.query('SELECT config FROM banking_aggregator_connections WHERE id = $1', [id]);
    expect(JSON.stringify(row.rows[0].config)).not.toContain(OR_TXN_KEY);

    const link = await BankingAggregator.createLinkToken(id, {});
    expect(link.linkToken).toBe('quiltt-session-jwt');
    expect((await BankingAggregator.linkStatus(id)).linked).toBe(true);

    let je: any = null;
    try { je = await pool.query(`SELECT 1 FROM trust_journal_entries LIMIT 0`); } catch (e) { je = null; }
    if (je) {
      const sync = await DataBridge.syncAggregatorToAccounting();
      expect(sync.errors.filter((e: any) => String(e.txnId || '').length && ids.some((i) => String(e.txnId).includes(i)))).toEqual([]);
      const entries = await pool.query(`
        SELECT je.description, l.account_code, l.debit_amount, l.credit_amount
        FROM trust_journal_entries je
        JOIN trust_journal_lines l ON l.entry_id = je.entry_id
        JOIN banking_aggregator_transactions t ON t.id = je.reference_id
        WHERE je.reference_type = 'aggregator_txn' AND t.connection_id = $1
        ORDER BY t.external_txn_id, l.account_code`, [id]);
      const byDesc = (needle: string) => entries.rows.filter((r: any) => r.description.includes(needle)).map((r: any) => [r.account_code, Number(r.debit_amount), Number(r.credit_amount)]);
      expect(byDesc('[coupon_income]')).toEqual([['1020', 250, 0], ['4100', 0, 250]]);
      expect(byDesc('[principal]')).toEqual([['1000', 1000, 0], ['3000', 0, 1000]]);
      expect(byDesc('[operating_expense]')).toEqual([['1000', 0, 42.1], ['5300', 42.1, 0]]);
    }
  });
});

// ─── SimpleFIN (Alderfi's read-only feed) + Alderfi MCP surface ──────────────
const { simpleFinConnector, claimSetupToken, normalizeTransaction } = require('../server/integrations/aggregator/connectors/simpleFinConnector');
const alderfiMcp = require('../server/integrations/aggregator/alderfiMcp');

const SF_DEMO = {
  errors: ['Connection to Chase may need attention'],
  accounts: [
    { id: 'bett-chk', name: 'Betterment Checking', currency: 'USD', balance: '12500.75', 'available-balance': '12400.00', 'balance-date': 1790553600,
      org: { domain: 'betterment.com', name: 'Betterment', 'sfin-url': 'https://beta-bridge.simplefin.org/simplefin', id: 'CON-BETT' },
      transactions: [
        { id: 't1', posted: 1790496000, amount: '-42.10', description: 'ACH DEBIT VENDOR', mcc: '5812' },
        { id: 't2', posted: 1790409600, amount: '1000.00', description: 'TRUST CONTRIBUTION' },
        { id: 't3', posted: 0, transacted_at: 1790500000, amount: '250.00', description: 'BOND COUPON PAYMENT', pending: true },
        { id: 't4', posted: 1790300000, amount: '-0.00', description: 'Zero-dollar auth' },
      ] },
    { id: 'chase-sav', name: 'Chase Savings', currency: 'USD', balance: '5', 'available-balance': '5', 'balance-date': 1790553600,
      org: { domain: 'chase.com', name: 'Chase', 'sfin-url': 'https://beta-bridge.simplefin.org/simplefin', id: 'CON-CHASE' }, transactions: [] },
  ],
};

function startSimpleFinMock(opts: { revoked?: boolean } = {}) {
  const calls: { url: string; auth: string; method: string }[] = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url || '', auth: String(req.headers.authorization || ''), method: req.method || '' });
    if (req.url === '/claim/abc' && req.method === 'POST') { res.writeHead(200); return res.end(`http://demo:secretpw@127.0.0.1:${(server.address() as AddressInfo).port}/simplefin`); }
    if (req.headers.authorization !== 'Basic ' + Buffer.from('demo:secretpw').toString('base64')) { res.writeHead(403); return res.end('Forbidden'); }
    if (opts.revoked) { res.writeHead(403); return res.end('Access URL disabled'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SF_DEMO));
  });
  return new Promise<{ accessUrl: string; claimToken: string; calls: typeof calls; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        accessUrl: `http://demo:secretpw@127.0.0.1:${port}/simplefin`,
        claimToken: Buffer.from(`http://127.0.0.1:${port}/claim/abc`).toString('base64'),
        calls, close: () => server.close(),
      });
    });
  });
}

describe('simplefin connector (Betterment via SimpleFIN Bridge, read-only)', () => {
  it('is registered and has no push (outbound stays on the Private Electronic Payment Network)', () => {
    expect(listConnectorTypes()).toContain('simplefin');
    expect(simpleFinConnector.push).toBeUndefined();
  });

  it('rejects missing / malformed / non-https / credential-less Access URLs without echoing them', async () => {
    const saved = process.env.SIMPLEFIN_ACCESS_URL; delete process.env.SIMPLEFIN_ACCESS_URL;
    try {
      await expect(simpleFinConnector.handshake({ id: 's', config: {} }, {})).rejects.toThrow(/Access URL missing/);
      await expect(simpleFinConnector.handshake({ id: 's', config: { accessUrl: 'not a url' } }, {})).rejects.toThrow(/not a valid URL/);
      await expect(simpleFinConnector.handshake({ id: 's', config: { accessUrl: 'http://u:p@bridge.example.com/simplefin' } }, {})).rejects.toThrow(/must use https/);
      await expect(simpleFinConnector.handshake({ id: 's', config: { accessUrl: 'https://bridge.example.com/simplefin' } }, {})).rejects.toThrow(/Basic-Auth credentials/);
      await expect(simpleFinConnector.handshake({ id: 's', config: { accessUrl: 'https://u:topsecret@bridge.example.com/simplefin' } }, { timeoutMs: 200 })).rejects.not.toThrow(/topsecret/);
    } finally { if (saved) process.env.SIMPLEFIN_ACCESS_URL = saved; }
  });

  it('claims a one-time Setup Token (base64 claim URL, POST) and returns the Access URL', async () => {
    const sf = await startSimpleFinMock();
    try {
      expect(await claimSetupToken(sf.claimToken)).toBe(sf.accessUrl);
      expect(sf.calls[0]).toMatchObject({ url: '/claim/abc', method: 'POST' });
      await expect(claimSetupToken('%%%not-base64-url')).rejects.toThrow(/not a base64-encoded claim URL/);
    } finally { sf.close(); }
  });

  it('handshakes with Basic auth from the Access URL, resolves Betterment by orgName, read-only capabilities', async () => {
    const sf = await startSimpleFinMock();
    try {
      const hs = await simpleFinConnector.handshake({ id: 's1', config: { accessUrl: sf.accessUrl, orgName: 'Betterment' } }, {});
      expect(hs.externalConnectionId).toBe('CON-BETT');
      expect(hs.capabilities).toEqual({ pull: true, push: false, webhook: false });
      expect(hs.meta.institution).toMatchObject({ id: 'CON-BETT', name: 'Betterment' });
      expect(hs.meta.accounts.map((a: any) => a.id)).toEqual(['bett-chk']);
      expect(hs.meta.bridgeErrors).toEqual(['Connection to Chase may need attention']);
      expect(JSON.stringify(hs)).not.toMatch(/secretpw/);
      expect(sf.calls[0].auth).toBe('Basic ' + Buffer.from('demo:secretpw').toString('base64'));
      expect(sf.calls[0].url).toMatch(/^\/simplefin\/accounts\?.*balances-only=1/);
    } finally { sf.close(); }
  });

  it('fails the handshake when the institution is not linked or the Access URL was revoked', async () => {
    const sf = await startSimpleFinMock();
    try {
      await expect(simpleFinConnector.handshake({ id: 's1', config: { accessUrl: sf.accessUrl, orgName: 'Fidelity' } }, {}))
        .rejects.toThrow(/no linked institution matching "Fidelity" \(linked: Betterment, Chase\)/);
    } finally { sf.close(); }
    const revoked = await startSimpleFinMock({ revoked: true });
    try {
      await expect(simpleFinConnector.handshake({ id: 's1', config: { accessUrl: revoked.accessUrl, orgName: 'Betterment' } }, {}))
        .rejects.toThrow(/HTTP 403.*disabled or revoked/);
    } finally { revoked.close(); }
  });

  it('pulls only the Betterment accounts/transactions, signed amount → direction, 90-day window with overlap', async () => {
    const sf = await startSimpleFinMock();
    try {
      const conn = { id: 's1', handshake_state: 'verified', external_connection_id: 'CON-BETT', config: { accessUrl: sf.accessUrl, orgName: 'Betterment' } };
      const accounts = await simpleFinConnector.pullAccounts(conn, {});
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ externalAccountId: 'bett-chk', name: 'Betterment Checking', balanceCurrent: 12500.75, balanceAvailable: 12400, currency: 'USD' });
      const txns = await simpleFinConnector.pullTransactions(conn, { since: '2026-09-01T00:00:00Z' });
      expect(txns.map((t: any) => [t.externalTxnId, t.externalAccountId, t.direction, t.amount, t.status])).toEqual([
        ['t1', 'bett-chk', 'debit', 42.1, 'posted'],
        ['t2', 'bett-chk', 'credit', 1000, 'posted'],
        ['t3', 'bett-chk', 'credit', 250, 'pending'],
        ['t4', 'bett-chk', 'debit', 0, 'posted'],
      ]);
      const last = sf.calls[sf.calls.length - 1].url;
      const start = Number(new URL('http://x' + last).searchParams.get('start-date'));
      expect(start).toBe(Math.floor((Date.parse('2026-09-01T00:00:00Z') - 5 * 86400000) / 1000));
      expect(last).toMatch(/pending=1/);
      // 90-day cap when since is ancient
      await simpleFinConnector.pullTransactions(conn, { since: '2020-01-01T00:00:00Z' });
      const capped = Number(new URL('http://x' + sf.calls[sf.calls.length - 1].url).searchParams.get('start-date'));
      expect(Date.now() / 1000 - capped).toBeLessThanOrEqual(90 * 86400 + 60);
      // accountIds filter
      const none = await simpleFinConnector.pullAccounts({ ...conn, config: { ...conn.config, accountIds: ['nope'] } }, {});
      expect(none).toEqual([]);
    } finally { sf.close(); }
  });

  it('normalizeTransaction: MCC → category, payee/memo fallback', () => {
    const t = normalizeTransaction({ id: 'x', posted: 1790496000, amount: '-5', payee: 'Shop', memo: 'SHOP', mcc: '5411' }, 'acct');
    expect(t).toMatchObject({ externalTxnId: 'x', externalAccountId: 'acct', direction: 'debit', amount: 5, description: 'Shop', category: 'mcc:5411', postedDate: '2026-09-27' });
  });

  it('BankingAggregator redacts accessUrl/setupToken and projects AGGREGATOR_*_ACCESS_URL from env', () => {
    const red = BankingAggregator._redactConnection({ id: 'x', config: { accessUrl: 'https://u:p@bridge/simplefin', setupToken: 'abc', orgName: 'Betterment' } });
    expect(JSON.stringify(red)).not.toMatch(/u:p@|abc/);
    expect(red.config).toEqual({ orgName: 'Betterment' });
    expect(red.credentials).toMatchObject({ has_accessUrl: true, has_setupToken: true });
    process.env.AGGREGATOR_SF_TEST_ACCESS_URL = 'https://u:p@bridge/simplefin';
    try {
      const cfg = BankingAggregator._withEnvCredentials({ id: 'SF-TEST', name: 'SF Test', config: { orgName: 'Betterment' } }).config;
      expect(cfg.accessUrl).toBe('https://u:p@bridge/simplefin');
    } finally { delete process.env.AGGREGATOR_SF_TEST_ACCESS_URL; }
  });
});

describe('Alderfi MCP surface (JSON-RPC 2.0, read-only over the existing aggregator + trust GL)', () => {
  const rpc = (method: string, params?: unknown, id: number | string = 1) => alderfiMcp.handleMessage({ jsonrpc: '2.0', id, method, params });

  it('initialize / ping / tools-list follow the MCP shape and expose only read tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'alderfi-dlbtrust' }, capabilities: { tools: {} } });
    expect((await rpc('ping')).result).toEqual({});
    const tools = (await rpc('tools/list')).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual(['list_accounts', 'list_transactions', 'list_connections', 'trust_balance_summary', 'list_journal_entries', 'aggregator_status']);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(JSON.stringify(tools)).toMatch(/principal.*coupon_income.*interest_income/);
  });

  it('returns JSON-RPC errors for invalid requests, unknown methods and unknown tools; notifications yield no reply', async () => {
    expect((await alderfiMcp.handleMessage({ id: 1, method: 'ping' })).error.code).toBe(-32600);
    expect((await alderfiMcp.handleMessage(null)).error.code).toBe(-32600);
    expect((await rpc('resources/list')).error).toMatchObject({ code: -32601 });
    expect((await rpc('tools/call', { name: 'transfer_funds', arguments: {} })).error).toMatchObject({ code: -32602, message: expect.stringMatching(/Unknown tool/) });
    expect((await rpc('tools/call', { name: 'list_transactions', arguments: { limit: 'x' } })).result).toMatchObject({ isError: true });
    expect(await alderfiMcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await alderfiMcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).toBeNull();
  });

  it('maps aggregator rows to Alderfi accounts/transactions with signed amounts + trust GL classification', () => {
    const acct = alderfiMcp.toAlderfiAccount({ connection_id: 'C1', external_account_id: 'a1', name: 'Betterment Checking', account_type: 'depository', currency: 'USD', balance_current: '12500.75', balance_available: '12400', mask: '3054', raw: {} }, { name: 'Betterment Trust Checking', connector_type: 'simplefin' });
    expect(acct).toMatchObject({ id: 'C1:a1', institution: 'Betterment Trust Checking', connector: 'simplefin', balance: 12500.75, available_balance: 12400, mask: '3054' });
    const accounting = { creditDefault: 'principal' };
    const debit = alderfiMcp.toAlderfiTransaction({ connection_id: 'C1', external_txn_id: 't1', external_account_id: 'a1', posted_date: '2026-09-01', amount: '42.10', direction: 'debit', description: 'Management fee', status: 'posted', currency: 'USD' }, accounting);
    expect(debit).toMatchObject({ amount: -42.1, trust_classification: 'fee_expense', gl: { debit: '5000', credit: '1000' } });
    const coupon = alderfiMcp.toAlderfiTransaction({ connection_id: 'C1', external_txn_id: 't2', external_account_id: 'a1', posted_date: '2026-09-02', amount: '250', direction: 'credit', description: 'BOND COUPON PAYMENT', status: 'posted' }, accounting);
    expect(coupon).toMatchObject({ amount: 250, trust_classification: 'coupon_income', gl: { debit: '1020', credit: '4100' } });
    const principal = alderfiMcp.toAlderfiTransaction({ connection_id: 'C1', external_txn_id: 't3', external_account_id: 'a1', posted_date: '2026-09-03', amount: '1000', direction: 'credit', description: 'TRUST CONTRIBUTION', status: 'pending' }, accounting);
    expect(principal).toMatchObject({ amount: 1000, pending: true, trust_classification: 'principal', gl: { debit: '1000', credit: '3000' } });
  });

  it('stdio transport: newline-delimited JSON-RPC, parse errors reported, notifications silent', async () => {
    const { PassThrough } = await import('stream');
    const input = new PassThrough(); const output = new PassThrough();
    let out = ''; output.on('data', (c) => { out += c; });
    const done = alderfiMcp.serveStdio(input, output);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n{bad json\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.end();
    await done;
    await new Promise((r) => setTimeout(r, 20));
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.id === 7).result).toEqual({});
    expect(lines.find((l) => l.id === null).error.code).toBe(-32700);
  });
});

describe.skipIf(!pgAvailable)('SimpleFIN → BankingAggregator → DataBridge → Alderfi MCP (local Postgres)', () => {
  const ID = 'CONN-SF-TEST';
  let sf: Awaited<ReturnType<typeof startSimpleFinMock>>;
  beforeAll(async () => {
    delete process.env.AGGREGATOR_DEFAULT_MODE;
    sf = await startSimpleFinMock();
    await BankingAggregator.ensureTables();
    await pool.query('DELETE FROM banking_aggregator_transactions WHERE connection_id = $1', [ID]);
    await pool.query('DELETE FROM banking_aggregator_accounts WHERE connection_id = $1', [ID]);
    await pool.query('DELETE FROM banking_aggregator_connections WHERE id = $1', [ID]);
  });
  afterAll(() => sf?.close());

  it('creates + auto-handshakes the connection via env-projected Access URL, pulls, and MCP lists it without leaking the secret', async () => {
    process.env.AGGREGATOR_SF_TEST_ACCESS_URL = sf.accessUrl;
    try {
      const conn = await BankingAggregator.createConnection({ id: ID, name: 'SF Test', connectorType: 'simplefin', direction: 'inbound', config: { orgName: 'Betterment', mode: 'live', accounting: { creditDefault: 'principal' } } });
      expect(conn.handshake_state).toBe('verified');
      expect(conn.external_connection_id).toBe('CON-BETT');
      expect(JSON.stringify(conn)).not.toMatch(/secretpw/);
      const pulled = await BankingAggregator.pull(ID, { kinds: ['accounts', 'transactions'] });
      expect(pulled.accounts).toBe(1);
      expect(pulled.transactions).toBe(4);
      const accounts = (await alderfiMcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_accounts', arguments: { connection_id: ID } } })).result.structuredContent.accounts;
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ id: `${ID}:bett-chk`, connector: 'simplefin', balance: 12500.75 });
      const txns = (await alderfiMcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_transactions', arguments: { connection_id: ID, classification: 'coupon_income' } } })).result.structuredContent.transactions;
      expect(txns.map((t: any) => [t.id, t.amount, t.gl.credit])).toEqual([[`${ID}:t3`, 250, '4100']]);
      const conns = (await alderfiMcp.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_connections', arguments: {} } })).result;
      expect(JSON.stringify(conns)).not.toMatch(/secretpw/);
      expect(conns.structuredContent.connections.find((c: any) => c.id === ID)).toMatchObject({ connector: 'simplefin', handshake_state: 'verified', capabilities: { pull: true, push: false, webhook: false } });
      await expect(BankingAggregator.push(ID, { amount: 1 })).rejects.toThrow(/does not support push|only|inbound/);
    } finally { delete process.env.AGGREGATOR_SF_TEST_ACCESS_URL; }
  });
});

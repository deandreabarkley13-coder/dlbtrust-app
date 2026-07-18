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

  const server = http.createServer((req, res) => {
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
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
        close: () => server.close(),
        getTokenRequests: () => tokenRequests,
        getLastAuthHeader: () => lastAuthHeader,
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

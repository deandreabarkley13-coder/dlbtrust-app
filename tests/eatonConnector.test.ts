import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import type { AddressInfo } from 'net';

// CommonJS server modules.
const require = createRequire(import.meta.url);
const { eatonConnector } = require('../server/integrations/aggregator/connectors/eatonConnector');
const { getConnector, listConnectorTypes } = require('../server/integrations/aggregator/connectors');
const { clearTokenCache } = require('../server/integrations/aggregator/connectors/genericRestConnector');

// A mock Eaton REST API: OAuth2 token + file intake (records the received
// envelope), file status, returns, and transactions.
function startEaton() {
  let lastAuth: string | undefined;
  let lastEnvelope: any = null;

  const server = http.createServer((req, res) => {
    if (req.url === '/oauth/token' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'eaton-tok', expires_in: 3600 }));
      });
      return;
    }
    if (req.url === '/ach/files' && req.method === 'POST') {
      lastAuth = req.headers['authorization'] as string;
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { lastEnvelope = JSON.parse(body); } catch { lastEnvelope = null; }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ submission_id: 'SUB-123', status: 'received' }));
      });
      return;
    }
    if (req.url === '/ach/files/SUB-123' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ submission_id: 'SUB-123', status: 'accepted' }));
      return;
    }
    if (req.url && req.url.startsWith('/ach/returns') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'RET-1', submission_id: 'SUB-123', return_code: 'R01', reason: 'Insufficient funds', amount: 100 },
      ] }));
      return;
    }
    res.writeHead(404); res.end();
  });

  return new Promise<{
    baseUrl: string; tokenUrl: string; close: () => void;
    getLastAuth: () => string | undefined; getLastEnvelope: () => any;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
        close: () => server.close(),
        getLastAuth: () => lastAuth,
        getLastEnvelope: () => lastEnvelope,
      });
    });
  });
}

describe('eaton connector registration', () => {
  it('is registered as a built-in connector type', () => {
    expect(listConnectorTypes()).toContain('eaton');
    expect(getConnector('eaton')).toBe(eatonConnector);
  });
});

describe('eaton connector outbound payment-file transmit (REST, M2M OAuth2)', () => {
  let eaton: Awaited<ReturnType<typeof startEaton>>;
  beforeAll(async () => { eaton = await startEaton(); });
  afterAll(() => { eaton.close(); clearTokenCache(); });

  function conn() {
    return {
      id: 'conn-eaton-test',
      name: 'Eaton',
      config: {
        baseUrl: eaton.baseUrl,
        allowPrivateNetwork: true,
        endpoints: { fileIntake: '/ach/files', fileStatus: '/ach/files', returns: '/ach/returns' },
        auth: {
          type: 'oauth2_client_credentials',
          tokenUrl: eaton.tokenUrl,
          clientId: 'cid', clientSecret: 'csecret',
        },
      },
    };
  }

  it('transmits inline NACHA content as a base64 envelope with a Bearer token', async () => {
    clearTokenCache();
    const nacha = '101 0410000...\n9000001...';
    const result = await eatonConnector.push(conn(), { kind: 'ach_file', content: nacha, filename: 'batch-1.ach' });
    expect(result.ok).toBe(true);
    expect(result.providerRef).toBe('SUB-123');
    expect(eaton.getLastAuth()).toBe('Bearer eaton-tok');
    const env = eaton.getLastEnvelope();
    expect(env.filename).toBe('batch-1.ach');
    expect(env.format).toBe('nacha');
    expect(env.encoding).toBe('base64');
    expect(Buffer.from(env.content, 'base64').toString('utf8')).toBe(nacha); // exact round-trip
  });

  it('requires content or ach_batch_id for a file push', async () => {
    await expect(eatonConnector.push(conn(), { kind: 'ach_file' })).rejects.toThrow(/content or ach_batch_id/);
  });

  it('pulls the status of a submitted file', async () => {
    const status = await eatonConnector.pullFileStatus(conn(), { submissionId: 'SUB-123' });
    expect(status.status).toBe('accepted');
  });

  it('requires a submissionId for file status', async () => {
    await expect(eatonConnector.pullFileStatus(conn(), {})).rejects.toThrow(/submissionId/);
  });

  it('pulls and normalizes ACH returns (ACK/NACK)', async () => {
    const returns = await eatonConnector.pullReturns(conn(), {});
    expect(returns).toHaveLength(1);
    expect(returns[0].returnCode).toBe('R01');
    expect(returns[0].submissionId).toBe('SUB-123');
    expect(returns[0].amount).toBe(100);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import type { AddressInfo } from 'net';

const require = createRequire(import.meta.url);
const { MoneyGramAdapter, adapterFromEndpoint, mapMoneyGramStatus } = require('../server/integrations/payments/moneyGramAdapter');
const { LiveFinTechEndpointEngine } = require('../server/integrations/dapp/liveFintechEndpointEngine');

type Call = { method: string; url: string; auth?: string; headers: http.IncomingHttpHeaders; body: string };

function startMoneyGram() {
  const calls: Call[] = [];
  let tokenRequests = 0;
  let failStep: string | null = null;
  let commitStatus = 'SENT';
  let pollStatus = 'RECEIVED';

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const fullUrl = req.url || '';
      const url = fullUrl.split('?')[0];
      const send = (code: number, payload: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url === '/oauth/accesstoken') {
        tokenRequests++;
        calls.push({ method: req.method || '', url: fullUrl, auth: req.headers.authorization, headers: req.headers, body });
        if (failStep === 'token') return send(401, { error: 'invalid_client', error_description: 'bad credentials' });
        return send(200, { access_token: 'tok-' + tokenRequests, expires_in: 3600, token_type: 'BearerToken' });
      }
      calls.push({ method: req.method || '', url, auth: req.headers.authorization, headers: req.headers, body });
      if (url === '/transfer/v1/transactions/quote' && req.method === 'POST') {
        if (failStep === 'quote') return send(400, { errors: [{ code: '1002', message: 'Amount exceeds limit' }] });
        return send(200, { transactions: [
          { transactionId: 'MG-TXN-0', serviceOptionCode: 'WILL_CALL', sendAmount: { value: 100 } },
          { transactionId: 'MG-TXN-1', serviceOptionCode: 'BANK_DEPOSIT', sendAmount: { value: 100 }, receiveAmount: { value: 100 } },
        ] });
      }
      if (url === '/transfer/v1/transactions/MG-TXN-1' && req.method === 'PUT') {
        if (failStep === 'send') return send(400, { errors: [{ code: '3011', message: 'Receiver name invalid' }] });
        if (failStep === 'notready') return send(200, { transactionId: 'MG-TXN-1', readyForCommit: false });
        return send(200, { transactionId: 'MG-TXN-1', readyForCommit: true });
      }
      if (url === '/transfer/v1/transactions/MG-TXN-1/commit' && req.method === 'PUT') {
        if (failStep === 'commit') return send(500, { error: { code: 'E500', message: 'Downstream unavailable' } });
        return send(200, { transactionId: 'MG-TXN-1', referenceNumber: 'REF12345678', expectedPayoutDate: '2026-09-16', transactionStatus: commitStatus });
      }
      if (url === '/status/v1/transactions/MG-TXN-1' && req.method === 'GET') {
        return send(200, { transactionId: 'MG-TXN-1', referenceNumber: 'REF12345678', transactionStatus: pollStatus });
      }
      send(404, { message: 'not found' });
    });
  });

  return new Promise<{
    baseUrl: string;
    close: () => void;
    calls: Call[];
    reset: () => void;
    setFailStep: (s: string | null) => void;
    setCommitStatus: (s: string) => void;
    setPollStatus: (s: string) => void;
    tokenRequests: () => number;
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        calls,
        reset: () => { calls.length = 0; tokenRequests = 0; failStep = null; commitStatus = 'SENT'; pollStatus = 'RECEIVED'; },
        setFailStep: (s) => { failStep = s; },
        setCommitStatus: (s) => { commitStatus = s; },
        setPollStatus: (s) => { pollStatus = s; },
        tokenRequests: () => tokenRequests,
      });
    });
  });
}

const sendArgs = {
  amount: 100,
  sourceCurrency: 'USD',
  receiveCountry: 'USA',
  deliveryOption: 'BANK_DEPOSIT',
  sender: { name: { firstName: 'Dee', lastName: 'Barkley' }, address: { line1: '1 Main St', city: 'Dallas', countryCode: 'USA' } },
  receiver: { name: { firstName: 'Jane', lastName: 'Doe' } },
  targetAccount: { accountNumber: '123456', routingNumber: '021000021' },
  reference: 'FTP-TEST-1',
};
const isTokenCall = (c: Call) => c.url.startsWith('/oauth/accesstoken');

describe('MoneyGramAdapter', () => {
  let mg: Awaited<ReturnType<typeof startMoneyGram>>;

  beforeAll(async () => { mg = await startMoneyGram(); });
  afterAll(() => mg.close());
  beforeEach(() => mg.reset());

  function adapter(extra: Record<string, unknown> = {}) {
    return new MoneyGramAdapter({
      baseUrl: mg.baseUrl,
      clientId: 'client-abc',
      clientSecret: 'secret-xyz',
      agentPartnerId: 'AGENT-1',
      ...extra,
    });
  }

  it('defaults the token URL to {baseUrl}/oauth/accesstoken and uses GET + Basic auth (MoneyGram contract)', async () => {
    const a = adapter();
    expect(a.tokenUrl).toBe(`${mg.baseUrl}/oauth/accesstoken`);
    const tok = await a.getAccessToken();
    expect(tok).toBe('tok-1');
    const tokenCall = mg.calls[0];
    expect(tokenCall.method).toBe('GET');
    expect(tokenCall.url).toBe('/oauth/accesstoken?grant_type=client_credentials');
    expect(tokenCall.auth).toBe('Basic ' + Buffer.from('client-abc:secret-xyz').toString('base64'));
    expect(tokenCall.body).toBe('');
  });

  it('POSTs a form body when tokenMethod is POST', async () => {
    await adapter({ tokenMethod: 'POST' }).getAccessToken();
    const tokenCall = mg.calls[0];
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.auth).toMatch(/^Basic /);
    expect(tokenCall.body).toBe('grant_type=client_credentials');
  });

  it('sends client_id/client_secret in the body when tokenMethod is POST and credentialsInBody is set', async () => {
    await adapter({ tokenMethod: 'POST', credentialsInBody: true }).getAccessToken();
    const tokenCall = mg.calls[0];
    expect(tokenCall.auth).toBeUndefined();
    expect(tokenCall.body).toContain('client_id=client-abc');
    expect(tokenCall.body).toContain('client_secret=secret-xyz');
  });

  it('fetches the token once, caches it, and attaches Bearer + X-MG headers to every step', async () => {
    const a = adapter({ headers: { 'X-MG-Version': '1' } });
    const result = await a.disburse(sendArgs);

    expect(mg.tokenRequests()).toBe(1);
    expect(result.status).toBe('completed');
    expect(result.externalId).toBe('REF12345678');
    expect(result.transactionId).toBe('MG-TXN-1');
    expect(result.errorMessage).toBeNull();

    expect(result.expectedPayoutDate).toBe('2026-09-16');

    const apiCalls = mg.calls.filter((c) => !isTokenCall(c));
    expect(apiCalls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/transfer/v1/transactions/quote'],
      ['PUT', '/transfer/v1/transactions/MG-TXN-1'],
      ['PUT', '/transfer/v1/transactions/MG-TXN-1/commit'],
    ]);
    for (const c of apiCalls) {
      expect(c.auth).toBe('Bearer tok-1');
      expect(c.headers['x-mg-version']).toBe('1');
      expect(c.headers['x-mg-agentpartnerid']).toBe('AGENT-1');
      expect(c.headers['x-mg-clientrequestid']).toMatch(/^FTP-TEST-1-/);
    }
    const quoteBody = JSON.parse(apiCalls[0].body);
    expect(quoteBody).toMatchObject({ targetAudience: 'AGENT_FACING', userLanguage: 'en-US', agentPartnerId: 'AGENT-1', destinationCountryCode: 'USA', serviceOptionCode: 'BANK_DEPOSIT', receiveCurrencyCode: 'USD' });
    expect(quoteBody.sendAmount).toEqual({ currencyCode: 'USD', value: 100 });
    // Picks the quote matching the requested service option, then re-sends the quote fields on Update.
    const sendBody = JSON.parse(apiCalls[1].body);
    expect(sendBody).toMatchObject({ targetAudience: 'AGENT_FACING', serviceOptionCode: 'BANK_DEPOSIT', destinationCountryCode: 'USA' });
    expect(sendBody.sendAmount).toEqual({ currencyCode: 'USD', value: 100 });
    expect(sendBody.transactionInformation.partnerTransactionId).toBe('FTP-TEST-1');
    expect(sendBody.receiver.name.lastName).toBe('Doe');
    expect(sendBody.sender.name.firstName).toBe('Dee');
    expect(sendBody.targetAccount.accountNumber).toBe('123456');
    expect(JSON.parse(apiCalls[2].body)).toEqual({ targetAudience: 'AGENT_FACING', userLanguage: 'en-US' });

    // Second flow reuses the cached token.
    await a.status({ transactionId: 'MG-TXN-1' });
    expect(mg.tokenRequests()).toBe(1);
    const statusCall = mg.calls[mg.calls.length - 1];
    expect(statusCall.method).toBe('GET');
    expect(statusCall.url).toBe('/status/v1/transactions/MG-TXN-1');
    expect(JSON.parse(result.rawResponse).steps.map((s: any) => s.step)).toEqual(['quote', 'send', 'commit']);
  });

  it.each(['quote', 'send', 'commit'])('yields failed with an error_message when %s fails', async (step) => {
    mg.setFailStep(step);
    const result = await adapter().disburse(sendArgs);
    expect(result.status).toBe('failed');
    expect(result.externalId).toBeNull();
    expect(result.failedStep).toBe(step);
    expect(result.errorMessage).toMatch(new RegExp(`MoneyGram ${step} failed`));
    expect(result.errorMessage).toMatch(/Amount exceeds limit|Receiver name invalid|Downstream unavailable/);
  });

  it('refuses to commit when Update does not return readyForCommit: true', async () => {
    mg.setFailStep('notready');
    const result = await adapter().disburse(sendArgs);
    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('send');
    expect(result.errorMessage).toMatch(/readyForCommit/);
    expect(mg.calls.some((c) => c.url.endsWith('/commit'))).toBe(false);
  });

  it('yields failed with a clear error when the token endpoint rejects the client', async () => {
    mg.setFailStep('token');
    const result = await adapter().disburse(sendArgs);
    expect(result.status).toBe('failed');
    expect(result.failedStep).toBe('token');
    expect(result.errorMessage).toMatch(/MoneyGram token failed: 401 bad credentials/);
    expect(mg.calls.filter((c) => !isTokenCall(c))).toHaveLength(0);
  });

  it('polls status and maps MoneyGram states onto the engine enum', async () => {
    const a = adapter();
    mg.setPollStatus('RECEIVED');
    expect((await a.status({ transactionId: 'MG-TXN-1' })).status).toBe('completed');
    mg.setPollStatus('IN_PROCESS');
    expect((await a.status({ transactionId: 'MG-TXN-1' })).status).toBe('manual_pending');
    mg.setPollStatus('REJECTED');
    const rejected = await a.status({ transactionId: 'MG-TXN-1' });
    expect(rejected.status).toBe('failed');
    expect(rejected.mgStatus).toBe('REJECTED');
    expect(rejected.referenceNumber).toBe('REF12345678');
    const statusCall = mg.calls[mg.calls.length - 1];
    expect(statusCall.url).toBe('/status/v1/transactions/MG-TXN-1');
  });

  it('maps a non-terminal commit status to manual_pending', async () => {
    mg.setCommitStatus('IN_PROCESS');
    const result = await adapter().disburse(sendArgs);
    expect(result.status).toBe('manual_pending');
    expect(result.externalId).toBe('REF12345678');
  });

  it('masks secrets in describe()', () => {
    const d = adapter().describe();
    expect(d.clientSecret).not.toContain('secret-xyz');
    expect(d.clientId).not.toBe('client-abc');
  });
});

describe('MoneyGram engine wiring', () => {
  it('registers the moneygram provider', () => {
    expect(LiveFinTechEndpointEngine.providers.moneygram).toEqual({ label: 'MoneyGram', method: 'POST' });
  });

  it('builds an adapter from a live_fintech_endpoints row (api_key/api_secret as client credentials)', () => {
    const a = adapterFromEndpoint({
      base_url: 'https://api.moneygram.com/',
      auth_type: 'oauth2_client_credentials',
      api_key: 'cid',
      api_secret: 'csec',
      extra_headers: { 'X-MG-Version': '2' },
      config: { tokenUrl: 'https://auth.moneygram.com/oauth/accesstoken', agentPartnerId: 'P1', tokenMethod: 'POST', credentialsInBody: true, targetAudience: 'CONSUMER_FACING' },
    });
    expect(a.baseUrl).toBe('https://api.moneygram.com');
    expect(a.tokenUrl).toBe('https://auth.moneygram.com/oauth/accesstoken');
    expect(a.clientId).toBe('cid');
    expect(a.tokenMethod).toBe('POST');
    expect(a.credentialsInBody).toBe(true);
    expect(a.targetAudience).toBe('CONSUMER_FACING');
    expect(a.quotePath).toBe('/transfer/v1/transactions/quote');
    expect(a.agentPartnerId).toBe('P1');
    expect(a.headers['X-MG-Version']).toBe('2');
    expect(() => adapterFromEndpoint({ base_url: 'https://x', config: {} })).toThrow(/clientId and clientSecret/);
  });

  it('mapMoneyGramStatus covers completed/failed/pending buckets', () => {
    expect(mapMoneyGramStatus('SENT')).toBe('completed');
    expect(mapMoneyGramStatus('cancelled')).toBe('failed');
    expect(mapMoneyGramStatus('IN_PROCESS')).toBe('manual_pending');
    expect(mapMoneyGramStatus(undefined)).toBe('manual_pending');
  });
});

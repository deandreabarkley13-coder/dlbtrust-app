import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import http from 'http';
import type { AddressInfo } from 'net';

const require = createRequire(import.meta.url);
const { PDCflowEngine } = require('../server/integrations/payments/pdcflowEngine');

type Capture = { path: string; auth: string; body: any } | null;

let server: http.Server;
let baseUrl = '';
let captured: Capture = null;
let respondWith: { status: number; body: any } = { status: 200, body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      captured = {
        path: req.url || '',
        auth: req.headers.authorization || '',
        body: raw ? JSON.parse(raw) : {},
      };
      res.writeHead(respondWith.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(respondWith.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const env = { ...process.env };

function configure(overrides: Record<string, string> = {}) {
  Object.assign(process.env, {
    PDCFLOW_BASE_URL: baseUrl,
    PDCFLOW_USERNAME: 'trust-api',
    PDCFLOW_PASSWORD: 'trust-password',
    PDCFLOW_ACH_PATH: '/transaction/ach',
    PDCFLOW_DEBIT_DIRECTIVE: 'ABC-1',
    PDCFLOW_CREDIT_DIRECTIVE: 'ABC-2',
    ...overrides,
  });
}

const creditInstruction = {
  reference: 'PPS-CREDIT-1',
  amountCents: 25,
  counterpartyName: 'Db Net Mgmt LLC',
  routingNumber: '084106768',
  accountNumber: '112233445566',
  accountType: 'checking',
  description: 'Trust distribution',
};

afterEach(() => {
  process.env = { ...env };
  captured = null;
  respondWith = { status: 200, body: {} };
});

describe('PDCflow engine configuration', () => {
  it('refuses to transmit when unconfigured and names what is missing', async () => {
    delete process.env.PDCFLOW_BASE_URL;
    delete process.env.PDCFLOW_USERNAME;
    delete process.env.PDCFLOW_PASSWORD;
    delete process.env.PDCFLOW_ACH_PATH;
    const status = PDCflowEngine.status();
    expect(status.ready).toBe(false);
    expect(status.missingConfiguration).toContain('PDCFLOW_BASE_URL');
    await expect(PDCflowEngine.originateAch('credit', creditInstruction)).rejects.toThrow(/not configured/);
    expect(captured).toBeNull();
  });

  it('never exposes the password or postback secret in status', () => {
    configure({ PDCFLOW_POSTBACK_AUTH: 'Bearer postback-secret' });
    const status = JSON.stringify(PDCflowEngine.status());
    expect(status).not.toContain('trust-password');
    expect(status).not.toContain('postback-secret');
  });

  it('refuses a direction with no account directive', async () => {
    configure({ PDCFLOW_CREDIT_DIRECTIVE: '' });
    await expect(PDCflowEngine.originateAch('credit', creditInstruction))
      .rejects.toThrow(/credit account directive/);
    expect(captured).toBeNull();
  });

  it('rejects a non-positive amount and a missing destination', async () => {
    configure();
    await expect(PDCflowEngine.originateAch('credit', { ...creditInstruction, amountCents: 0 }))
      .rejects.toThrow(/positive integer/);
    await expect(PDCflowEngine.originateAch('credit', {
      ...creditInstruction, routingNumber: '', accountNumber: '',
    })).rejects.toThrow(/bankAccountToken or a routing and account number/);
    expect(captured).toBeNull();
  });

  it('redacts the account number in a dry run and sends nothing', () => {
    configure();
    const prepared = PDCflowEngine.prepareAch('credit', creditInstruction);
    expect(prepared.body.bankAccountNumber).toBe('****5566');
    expect(prepared.body.transactionType).toBe('CREDIT');
    expect(captured).toBeNull();
  });
});

describe('PDCflow ACH origination', () => {
  it('sends an ACH CREDIT with the credit directive, basic auth and the canonical reference', async () => {
    configure();
    respondWith = { status: 200, body: { transactionId: '9911', arrivalId: '55', currentStatus: 'PENDING' } };

    const accepted = await PDCflowEngine.originateAch('credit', creditInstruction);

    expect(captured!.path).toBe('/transaction/ach');
    expect(captured!.auth).toBe(`Basic ${Buffer.from('trust-api:trust-password').toString('base64')}`);
    expect(captured!.body.transactionType).toBe('CREDIT');
    expect(captured!.body.accountDirective).toBe('ABC-2');
    expect(captured!.body.paymentAmount).toBe('0.25');
    expect(captured!.body.bankRoutingNumber).toBe('084106768');
    expect(captured!.body.uniqueRequestId).toBe('PPS-CREDIT-1');
    expect(captured!.body.firstName).toBe('Db');
    expect(accepted.providerReference).toBe('9911');
    // Acceptance is not settlement.
    expect(accepted.settled).toBe(false);
    expect(accepted.providerStatus).toBe('PENDING');
  });

  it('sends an ACH DEBIT with the debit directive and a reusable token', async () => {
    configure();
    respondWith = { status: 200, body: { transactionId: '1234', currentStatus: 'PENDING' } };

    await PDCflowEngine.originateAch('debit', {
      reference: 'PPS-DEBIT-1',
      amountCents: 500000,
      counterpartyName: 'Family Contribution',
      bankAccountToken: 'TOKEN123',
    });

    expect(captured!.body.transactionType).toBe('DEBIT');
    expect(captured!.body.accountDirective).toBe('ABC-1');
    expect(captured!.body.bankAccountToken).toBe('TOKEN123');
    expect(captured!.body.bankAccountNumber).toBeUndefined();
    expect(captured!.body.paymentAmount).toBe('5000.00');
  });

  it('treats a settled status as settled', async () => {
    configure();
    respondWith = { status: 200, body: { transactionId: '77', currentStatus: 'SETTLED' } };
    const accepted = await PDCflowEngine.originateAch('credit', creditInstruction);
    expect(accepted.settled).toBe(true);
  });

  it('throws when PDCflow returns request errors', async () => {
    configure();
    respondWith = {
      status: 200,
      body: { requestErrorList: [{ message: 'accountDirective not authorized for CREDIT' }] },
    };
    await expect(PDCflowEngine.originateAch('credit', creditInstruction))
      .rejects.toThrow(/not authorized for CREDIT/);
  });

  it('throws on a declined status and on an acceptance with no transactionId', async () => {
    configure();
    respondWith = { status: 200, body: { transactionId: '5', currentStatus: 'DECLINED' } };
    await expect(PDCflowEngine.originateAch('credit', creditInstruction)).rejects.toThrow(/not accepted/);
    respondWith = { status: 200, body: { currentStatus: 'PENDING' } };
    await expect(PDCflowEngine.originateAch('credit', creditInstruction)).rejects.toThrow(/without returning a transactionId/);
  });

  it('throws on an HTTP error without leaking the password', async () => {
    configure();
    respondWith = { status: 403, body: { error: 'forbidden' } };
    await expect(PDCflowEngine.originateAch('credit', creditInstruction))
      .rejects.toThrow(/PDCflow returned 403/);
    await PDCflowEngine.originateAch('credit', creditInstruction).catch((e: Error) => {
      expect(e.message).not.toContain('trust-password');
    });
  });
});

describe('PDCflow postback', () => {
  it('reports settlement only for a settled status', () => {
    expect(PDCflowEngine.interpretPostback({ transactionId: '9911', currentStatus: 'SETTLED' }))
      .toMatchObject({ providerReference: '9911', settled: true, failed: false });
    expect(PDCflowEngine.interpretPostback({ transactionId: '9911', transactionStatus: 'PENDING' }))
      .toMatchObject({ settled: false, failed: false });
    expect(PDCflowEngine.interpretPostback({ transactionId: '9911', transactionStatus: 'RETURNED' }))
      .toMatchObject({ settled: false, failed: true });
  });
});

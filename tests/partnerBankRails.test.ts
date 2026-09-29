import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { PartnerBankRails } = require('../server/integrations/rails/partnerBankRails');

const ENV_KEYS = [
  'PARTNER_BANK_PROVIDER',
  'PARTNER_BANK_API_KEY',
  'PARTNER_BANK_ACCOUNT_ID',
  'PARTNER_BANK_BASE_URL',
  'PARTNER_BANK_ACCOUNT_LABEL',
  'UNIT_API_TOKEN',
  'UNIT_ACCOUNT_ID',
  'PARTNER_BANK_LIVE',
];

const INSTRUCTION = {
  reference: 'WIRE-20260827-TEST01',
  amountCents: 25,
  currency: 'USD',
  beneficiaryName: 'Db Net Mgmt LLC',
  beneficiaryRouting: '091017138',
  beneficiaryAccount: '692101092959',
  description: 'Micro deposit validation',
};

describe('Partner bank rails', () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('reports every rail unavailable and refuses origination when unconfigured', async () => {
    const status = PartnerBankRails.status();
    expect(status.configured).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.rails).toEqual({ wire: false, ach: false, rtp: false });
    expect(status.missingConfiguration).toContain('PARTNER_BANK_PROVIDER');
    await expect(PartnerBankRails.originate('wire', INSTRUCTION))
      .rejects.toThrow(/not configured/);
  });

  it('lists the rails a configured provider supports', () => {
    process.env.PARTNER_BANK_PROVIDER = 'column';
    process.env.PARTNER_BANK_API_KEY = 'test_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'bacc_test';
    const column = PartnerBankRails.status();
    expect(column.ready).toBe(true);
    expect(column.baseUrl).toBe('https://api.column.com');
    expect(column.rails).toEqual({ wire: true, ach: true, rtp: false });

    process.env.PARTNER_BANK_PROVIDER = 'increase';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'account_test';
    expect(PartnerBankRails.status().rails).toEqual({ wire: true, ach: true, rtp: true });
  });

  it('builds a Column form-encoded wire request', () => {
    process.env.PARTNER_BANK_PROVIDER = 'column';
    process.env.PARTNER_BANK_API_KEY = 'test_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'bacc_test';

    const prepared = PartnerBankRails.prepare('wire', {
      ...INSTRUCTION,
      counterpartyId: 'cpty_test',
    });
    expect(prepared.url).toBe('https://api.column.com/transfers/wire');
    expect(prepared.contentType).toBe('application/x-www-form-urlencoded');
    expect(prepared.body).toContain('amount=25');
    expect(prepared.body).toContain('bank_account_id=bacc_test');
    expect(prepared.body).toContain('counterparty_id=cpty_test');
    expect(prepared.body).not.toContain('test_key');
  });

  it('requires a Column counterparty rather than silently dropping the beneficiary', () => {
    process.env.PARTNER_BANK_PROVIDER = 'column';
    process.env.PARTNER_BANK_API_KEY = 'test_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'bacc_test';
    expect(() => PartnerBankRails.prepare('wire', INSTRUCTION)).toThrow(/counterparty_id/);
  });

  it('builds Increase JSON requests for wire, ach and rtp', () => {
    process.env.PARTNER_BANK_PROVIDER = 'increase';
    process.env.PARTNER_BANK_API_KEY = 'test_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'account_test';

    const wire = JSON.parse(PartnerBankRails.prepare('wire', INSTRUCTION).body);
    expect(wire).toMatchObject({
      account_id: 'account_test',
      amount: 25,
      beneficiary_name: 'Db Net Mgmt LLC',
      routing_number: '091017138',
      account_number: '692101092959',
    });

    const ach = PartnerBankRails.prepare('ach', INSTRUCTION);
    expect(ach.url).toBe('https://api.increase.com/ach_transfers');
    expect(JSON.parse(ach.body).standard_entry_class_code).toBe('corporate_credit_or_debit');

    const rtp = PartnerBankRails.prepare('rtp', INSTRUCTION);
    expect(rtp.url).toBe('https://api.increase.com/real_time_payments_transfers');
    expect(JSON.parse(rtp.body).creditor_name).toBe('Db Net Mgmt LLC');
  });

  it('refuses a rail the provider does not support', () => {
    process.env.PARTNER_BANK_PROVIDER = 'column';
    process.env.PARTNER_BANK_API_KEY = 'test_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'bacc_test';
    expect(() => PartnerBankRails.prepare('rtp', INSTRUCTION)).toThrow(/does not support the rtp rail/);
  });

  it('rejects instructions with no amount, beneficiary or destination', () => {
    process.env.PARTNER_BANK_PROVIDER = 'increase';
    process.env.PARTNER_BANK_API_KEY = 'test_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'account_test';

    expect(() => PartnerBankRails.prepare('wire', { ...INSTRUCTION, amountCents: 0 }))
      .toThrow(/positive integer amountCents/);
    expect(() => PartnerBankRails.prepare('wire', { ...INSTRUCTION, beneficiaryName: '' }))
      .toThrow(/beneficiary name/);
    expect(() => PartnerBankRails.prepare('wire', {
      ...INSTRUCTION,
      beneficiaryRouting: '',
      beneficiaryAccount: '',
    })).toThrow(/routing and account numbers/);
  });

  it('originates against a partner bank, requiring an external reference', async () => {
    const http = require('http');
    const seen: any[] = [];
    let reply: { code: number; body: string } = { code: 200, body: '{}' };
    const server = http.createServer((req: any, res: any) => {
      let data = '';
      req.on('data', (c: any) => { data += c; });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, headers: req.headers, body: data });
        res.writeHead(reply.code, { 'Content-Type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    process.env.PARTNER_BANK_PROVIDER = 'generic';
    process.env.PARTNER_BANK_API_KEY = 'test_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'trust-settlement';
    process.env.PARTNER_BANK_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PARTNER_BANK_LIVE = 'true';

    try {
      reply = {
        code: 200,
        body: JSON.stringify({ provider_reference: 'ext-1', status: 'accepted', imad: 'IMAD1' }),
      };
      const accepted = await PartnerBankRails.originate('wire', INSTRUCTION);
      expect(accepted).toMatchObject({
        provider: 'generic',
        rail: 'wire',
        providerReference: 'ext-1',
        providerStatus: 'accepted',
        imad: 'IMAD1',
      });
      expect(seen[0].url).toBe('/wire');
      expect(seen[0].headers['idempotency-key']).toBe(INSTRUCTION.reference);
      expect(seen[0].headers.authorization).toBe('Bearer test_key');
      expect(JSON.parse(seen[0].body).amount_cents).toBe(25);

      reply = { code: 200, body: JSON.stringify({ id: 'ext-2', status: 'rejected' }) };
      await expect(PartnerBankRails.originate('wire', INSTRUCTION)).rejects.toThrow(/rejected/);

      reply = { code: 200, body: JSON.stringify({ status: 'accepted' }) };
      await expect(PartnerBankRails.originate('wire', INSTRUCTION))
        .rejects.toThrow(/did not include an external reference/);

      reply = { code: 500, body: 'boom' };
      await expect(PartnerBankRails.originate('wire', INSTRUCTION)).rejects.toThrow(/returned 500/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back to UNIT_API_TOKEN / UNIT_ACCOUNT_ID only for the unit provider', () => {
    process.env.PARTNER_BANK_PROVIDER = 'unit';
    process.env.UNIT_API_TOKEN = 'unit_token';
    process.env.UNIT_ACCOUNT_ID = '10001';
    const cfg = PartnerBankRails.config();
    expect(cfg.apiKey).toBe('unit_token');
    expect(cfg.accountId).toBe('10001');
    const status = PartnerBankRails.status();
    expect(status.ready).toBe(true);
    expect(status.providerLabel).toBe('Unit');
    expect(status.baseUrl).toBe('https://api.s.unit.sh');
    expect(status.rails).toEqual({ wire: true, ach: true, rtp: false });
    expect(JSON.stringify(status)).not.toContain('unit_token');

    process.env.PARTNER_BANK_API_KEY = 'shared_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = '20002';
    expect(PartnerBankRails.config()).toMatchObject({ apiKey: 'shared_key', accountId: '20002' });

    delete process.env.PARTNER_BANK_API_KEY;
    delete process.env.PARTNER_BANK_ACCOUNT_ID;
    process.env.PARTNER_BANK_PROVIDER = 'increase';
    expect(PartnerBankRails.config()).toMatchObject({ apiKey: '', accountId: '' });

    process.env.PARTNER_BANK_PROVIDER = 'unit';
    delete process.env.UNIT_API_TOKEN;
    delete process.env.UNIT_ACCOUNT_ID;
    expect(PartnerBankRails.status().missingConfiguration).toEqual([
      'PARTNER_BANK_API_KEY (or UNIT_API_TOKEN)',
      'PARTNER_BANK_ACCOUNT_ID (or UNIT_ACCOUNT_ID)',
    ]);
  });

  it('builds Unit JSON:API achPayment / wirePayment / bookPayment envelopes', () => {
    process.env.PARTNER_BANK_PROVIDER = 'unit';
    process.env.UNIT_API_TOKEN = 'unit_token';
    process.env.UNIT_ACCOUNT_ID = '10001';
    const account = { data: { type: 'depositAccount', id: '10001' } };

    const ach = PartnerBankRails.prepare('ach', { ...INSTRUCTION, counterpartyId: '555' });
    expect(ach.url).toBe('https://api.s.unit.sh/payments');
    expect(ach.method).toBe('POST');
    expect(ach.contentType).toBe('application/vnd.api+json');
    const achBody = JSON.parse(ach.body);
    expect(achBody.data.type).toBe('achPayment');
    expect(achBody.data.attributes).toMatchObject({ amount: 25, direction: 'Credit', idempotencyKey: INSTRUCTION.reference });
    expect(achBody.data.attributes.description.length).toBeLessThanOrEqual(10);
    expect(achBody.data.relationships).toEqual({
      account,
      counterparty: { data: { type: 'counterparty', id: '555' } },
    });
    expect(ach.body).not.toContain('unit_token');

    const inlineAch = JSON.parse(PartnerBankRails.prepare('ach', INSTRUCTION).body);
    expect(inlineAch.data.type).toBe('achPayment');
    expect(inlineAch.data.attributes.counterparty).toEqual({
      name: 'Db Net Mgmt LLC',
      routingNumber: '091017138',
      accountNumber: '692101092959',
      accountType: 'Checking',
    });
    expect(inlineAch.data.relationships).toEqual({ account });

    const wire = JSON.parse(PartnerBankRails.prepare('wire', INSTRUCTION).body);
    expect(wire.data.type).toBe('wirePayment');
    expect(wire.data.attributes).toMatchObject({
      amount: 25,
      direction: 'Credit',
      description: 'Micro deposit validation',
      counterparty: { name: 'Db Net Mgmt LLC', routingNumber: '091017138', accountNumber: '692101092959' },
    });
    expect(wire.data.relationships).toEqual({ account });

    const book = JSON.parse(PartnerBankRails.prepare('ach', {
      ...INSTRUCTION,
      beneficiaryRouting: '',
      beneficiaryAccount: '',
      receivingAccountId: '10002',
    }).body);
    expect(book.data.type).toBe('bookPayment');
    expect(book.data.attributes).toMatchObject({ amount: 25, description: 'Micro deposit validation' });
    expect(book.data.attributes.direction).toBeUndefined();
    expect(book.data.relationships).toEqual({
      account,
      counterpartyAccount: { data: { type: 'depositAccount', id: '10002' } },
    });
  });

  it('requires an inline beneficiary for Unit wires', () => {
    process.env.PARTNER_BANK_PROVIDER = 'unit';
    process.env.UNIT_API_TOKEN = 'unit_token';
    process.env.UNIT_ACCOUNT_ID = '10001';
    expect(() => PartnerBankRails.prepare('wire', {
      ...INSTRUCTION,
      beneficiaryRouting: '',
      beneficiaryAccount: '',
      counterpartyId: '555',
    })).toThrow(/Unit wire payments take the beneficiary inline/);
    expect(() => PartnerBankRails.prepare('rtp', INSTRUCTION)).toThrow(/Unit does not support the rtp rail/);
  });

  it('originates against Unit with bearer auth and parses JSON:API responses', async () => {
    const http = require('http');
    const seen: any[] = [];
    let reply: { code: number; body: string } = { code: 200, body: '{}' };
    const server = http.createServer((req: any, res: any) => {
      let data = '';
      req.on('data', (c: any) => { data += c; });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, headers: req.headers, body: data });
        res.writeHead(reply.code, { 'Content-Type': 'application/vnd.api+json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as any).port;

    process.env.PARTNER_BANK_PROVIDER = 'unit';
    process.env.UNIT_API_TOKEN = 'unit_token';
    process.env.UNIT_ACCOUNT_ID = '10001';
    process.env.PARTNER_BANK_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.PARTNER_BANK_LIVE = 'true';

    try {
      reply = {
        code: 201,
        body: JSON.stringify({
          data: {
            type: 'wirePayment',
            id: '9001',
            attributes: { status: 'Sent', imadOmad: { imad: 'IMAD-U1', omad: 'OMAD-U1' } },
          },
        }),
      };
      const wire = await PartnerBankRails.originate('wire', INSTRUCTION);
      expect(wire).toMatchObject({
        provider: 'unit',
        rail: 'wire',
        providerReference: '9001',
        providerStatus: 'Sent',
        imad: 'IMAD-U1',
        omad: 'OMAD-U1',
        fedReference: 'IMAD-U1',
        confirmationNumber: 'IMAD-U1',
      });
      expect(seen[0].url).toBe('/payments');
      expect(seen[0].method).toBe('POST');
      expect(seen[0].headers.authorization).toBe('Bearer unit_token');
      expect(seen[0].headers['content-type']).toBe('application/vnd.api+json');
      expect(seen[0].headers.accept).toBe('application/vnd.api+json');
      expect(JSON.parse(seen[0].body).data.type).toBe('wirePayment');

      reply = {
        code: 201,
        body: JSON.stringify({
          data: { type: 'achPayment', id: '9002', attributes: { status: 'Pending', traceNumber: '123456780000001' } },
        }),
      };
      const ach = await PartnerBankRails.originate('ach', { ...INSTRUCTION, counterpartyId: '555' });
      expect(ach).toMatchObject({
        providerReference: '9002',
        providerStatus: 'Pending',
        fedReference: '123456780000001',
        confirmationNumber: '123456780000001',
      });

      reply = {
        code: 201,
        body: JSON.stringify({ data: { type: 'achPayment', id: '9003', attributes: { status: 'Rejected' } } }),
      };
      await expect(PartnerBankRails.originate('ach', { ...INSTRUCTION, counterpartyId: '555' }))
        .rejects.toThrow(/Unit rejected the ach origination with status Rejected/);

      reply = { code: 201, body: JSON.stringify({ data: { type: 'achPayment', attributes: { status: 'Pending' } } }) };
      await expect(PartnerBankRails.originate('ach', { ...INSTRUCTION, counterpartyId: '555' }))
        .rejects.toThrow(/Unit response did not include an external reference/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stays in shadow mode and refuses origination until PARTNER_BANK_LIVE=true', async () => {
    process.env.PARTNER_BANK_PROVIDER = 'unit';
    process.env.UNIT_API_TOKEN = 'unit_token';
    process.env.UNIT_ACCOUNT_ID = '10001';
    process.env.PARTNER_BANK_BASE_URL = 'http://127.0.0.1:1';

    const shadow = PartnerBankRails.status();
    expect(shadow).toMatchObject({ ready: true, live: false, mode: 'shadow' });
    expect(shadow.note).toMatch(/PARTNER_BANK_LIVE/);
    expect(PartnerBankRails.isLive()).toBe(false);
    expect(PartnerBankRails.prepare('ach', { ...INSTRUCTION, counterpartyId: '555' }).url).toBe('http://127.0.0.1:1/payments');
    await expect(PartnerBankRails.originate('ach', { ...INSTRUCTION, counterpartyId: '555' }))
      .rejects.toThrow(/Unit is in shadow mode \(PARTNER_BANK_LIVE is not true\)/);

    process.env.PARTNER_BANK_LIVE = 'true';
    expect(PartnerBankRails.status()).toMatchObject({ live: true, mode: 'live' });

    delete process.env.UNIT_API_TOKEN;
    expect(PartnerBankRails.status()).toMatchObject({ ready: false, live: false });
  });

  it('never exposes the API key in status output', () => {
    process.env.PARTNER_BANK_PROVIDER = 'increase';
    process.env.PARTNER_BANK_API_KEY = 'super_secret_key';
    process.env.PARTNER_BANK_ACCOUNT_ID = 'account_test';
    process.env.PARTNER_BANK_ACCOUNT_LABEL = 'DLB Trust Checking';
    const status = PartnerBankRails.status();
    expect(JSON.stringify(status)).not.toContain('super_secret_key');
    expect(status.accountLabel).toBe('DLB Trust Checking');
  });
});

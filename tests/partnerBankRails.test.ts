import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { PartnerBankRails } = require('../server/integrations/rails/partnerBankRails');

const ENV_KEYS = [
  'PARTNER_BANK_PROVIDER',
  'PARTNER_BANK_API_KEY',
  'PARTNER_BANK_ACCOUNT_ID',
  'PARTNER_BANK_BASE_URL',
  'PARTNER_BANK_ACCOUNT_LABEL',
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

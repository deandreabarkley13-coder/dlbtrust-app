import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { SettlementBankRegistry } = require('../server/integrations/payments/settlementBankRegistry');
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

describe('SettlementBankRegistry', () => {
  let rows: Record<string, any>;

  beforeEach(() => {
    rows = {};
    process.env.LILI_CLEARING_LIVE = 'true';
    process.env.LILI_DD_ROUTING_NUMBER = '121145307';
    process.env.LILI_DD_ACCOUNT_NUMBER = '692101092959';
    process.env.LILI_DD_ACCOUNT_NAME = 'DB NET MGMT LLC';
    vi.spyOn(SystemSettings, 'get').mockResolvedValue(null);
    vi.spyOn(pool, 'query').mockImplementation(async (text: any, params: any[] = []) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      if (t.startsWith('CREATE TABLE')) return { rows: [] } as any;
      if (t.startsWith('INSERT INTO settlement_banks')) {
        rows[params[0]] = {
          bank_id: params[0], provider: params[1], name: params[2], routing_number: params[3], account_number: params[4],
          account_last4: params[5], account_name: params[6], default_rail: params[7], endpoint_id: params[8], enabled: params[9],
          metadata: JSON.parse(params[10]), created_at: 'now', updated_at: 'now',
        };
        return { rows: [rows[params[0]]] } as any;
      }
      if (t.startsWith('SELECT * FROM settlement_banks WHERE bank_id = $1')) return { rows: rows[params[0]] ? [rows[params[0]]] : [] } as any;
      if (t.startsWith('SELECT * FROM settlement_banks WHERE bank_id <> $1')) return { rows: Object.values(rows).filter((r: any) => r.bank_id !== params[0]) } as any;
      return { rows: [] } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('auto-registers lili from LILI_DD_* env via LiliDirectDepositEngine.getDestination', async () => {
    const lili = await SettlementBankRegistry.resolve('lili');
    expect(lili).toMatchObject({
      bankId: 'lili', provider: 'lili', configured: true,
      routingNumber: '121145307', accountNumberMasked: '****2959', accountName: 'DB NET MGMT LLC', rail: 'ach',
    });
    expect(lili._account).toBe('692101092959');
    expect(lili.metadata.direction).toBe('treasury_to_lili');

    const list = await SettlementBankRegistry.list();
    expect(list.map((b: any) => b.bankId)).toEqual(['lili']);
    expect(list[0]).not.toHaveProperty('_account');
  });

  it('accepts the registered Lili account (full or masked) and refuses any other destination', async () => {
    await expect(SettlementBankRegistry.assertLiliDestination({ routingNumber: '121145307', accountNumber: '692101092959' })).resolves.toMatchObject({ bankId: 'lili' });
    await expect(SettlementBankRegistry.assertLiliDestination({ routingNumber: '121145307', accountNumber: '****2959' })).resolves.toMatchObject({ bankId: 'lili' });
    await expect(SettlementBankRegistry.assertLiliDestination({ routingNumber: '121145307', accountNumber: '000000001' })).rejects.toMatchObject({ status: 400 });
    await expect(SettlementBankRegistry.assertLiliDestination({ routingNumber: '091000019', accountNumber: '692101092959' })).rejects.toMatchObject({ status: 400 });
  });

  it('register(lili) pins the destination to the registered account and rejects other provider/id combos', async () => {
    const bank = await SettlementBankRegistry.register({ bankId: 'lili', provider: 'lili' });
    expect(bank).toMatchObject({ bankId: 'lili', provider: 'lili', routingNumber: '121145307', accountNumberMasked: '****2959' });
    await expect(SettlementBankRegistry.register({ bankId: 'lili', provider: 'lili', routingNumber: '121145307', accountNumber: '111' })).rejects.toMatchObject({ status: 400 });
    await expect(SettlementBankRegistry.register({ bankId: 'lili2', provider: 'lili' })).rejects.toMatchObject({ status: 400 });
    await expect(SettlementBankRegistry.register({ bankId: 'lili', provider: 'column' })).rejects.toMatchObject({ status: 400 });
  });

  it('only registered banks resolve; other providers need routing/account or endpoint', async () => {
    await expect(SettlementBankRegistry.resolve('acme')).rejects.toMatchObject({ status: 404 });
    await expect(SettlementBankRegistry.register({ bankId: 'acme', provider: 'column', name: 'Acme' })).rejects.toMatchObject({ status: 400 });
    await expect(SettlementBankRegistry.register({ bankId: 'h2h', provider: 'host_to_host', name: 'Partner' })).rejects.toMatchObject({ status: 400 });
    const acme = await SettlementBankRegistry.register({ bankId: 'acme', provider: 'column', name: 'Acme', routingNumber: '091000019', accountNumber: '5555' });
    expect(await SettlementBankRegistry.resolve('acme')).toMatchObject({ bankId: 'acme', provider: 'column', accountNumberMasked: '****5555' });
    expect(acme.accountNumberMasked).toBe('****5555');
    await expect(SettlementBankRegistry.register({ bankId: 'bad id!', provider: 'generic', name: 'x', routingNumber: '1', accountNumber: '2' })).rejects.toMatchObject({ status: 400 });
  });
});

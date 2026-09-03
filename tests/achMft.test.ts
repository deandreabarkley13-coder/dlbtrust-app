import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ACHEngine } = require('../server/integrations/ach/achEngine');
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const { AS2Partners } = require('../server/integrations/ach/as2Partners');
const { MftOsEngine } = require('../server/integrations/os/mftOsEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

function batch(over: Record<string, any> = {}) {
  return {
    batch_id: 'ACH-1', status: 'pending', nacha_content: '101 ...', filename: 'ACH-1.ach',
    created_by: 'trustee-one', entry_description: 'VENDOR PAY', partner_id: null, total_amount_cents: 250_000, ...over,
  };
}

describe('ACHEngine transmitting through the MFT register', () => {
  let sql: string[];

  beforeEach(() => {
    sql = [];
    vi.spyOn(pool, 'query').mockImplementation(async (text: any) => { sql.push(String(text).replace(/\s+/g, ' ').trim()); return { rows: [] } as any; });
    vi.spyOn(SystemSettings, 'getMode').mockResolvedValue('production' as any);
    vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue({ partnerId: 'BANK', partnerName: 'Bank', protocol: 'rest_api', apiBaseUrl: 'https://bank.test' } as any);
    vi.spyOn(SystemSettings, 'get').mockResolvedValue('false' as any);
    vi.spyOn(AS2Partners, 'getDefaultPartnerConfig').mockResolvedValue(null as any);
    vi.spyOn(ACHEngine, 'getBatch').mockResolvedValue(batch() as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('hands the rendered NACHA bytes and both signatures to the register, and marks the batch transmitted only when it is', async () => {
    process.env.ACH_MFT_CHANNEL = 'default';
    const deliver = vi.spyOn(MftOsEngine, 'deliver').mockResolvedValue({
      transmitted: true, replay: false,
      file: { fileId: 'MFT-1', filename: 'ACH-1.ach', remotePath: '/payments/outbound/ACH-1.ach', transport: 'sftp', contentHash: 'abc' },
    } as any);

    const result = await ACHEngine.transmitBatch('ACH-1', { approvedBy: 'trustee-two' });
    expect(result).toMatchObject({ success: true, mode: 'mft', message_id: 'MFT-1', batch_status: 'transmitted', awaiting_confirmation: true });
    expect(deliver).toHaveBeenCalledWith({
      channelId: 'default', format: 'nacha', content: '101 ...', filename: 'ACH-1.ach', sourceRef: 'ach:ACH-1',
      builtBy: 'trustee-one', approvedBy: 'trustee-two', memo: 'VENDOR PAY', actor: 'trustee-two',
    });
    expect(sql.some(s => s.startsWith('INSERT INTO ach_transmissions'))).toBe(true);
    expect(sql.some(s => /UPDATE ach_batches SET status = \$1, transmitted_at/.test(s))).toBe(true);
    expect(sql.some(s => /SET status = 'accepted'/.test(s))).toBe(false);
  });

  it('a refusal by the register fails the batch and surfaces the register\'s reason', async () => {
    process.env.ACH_MFT_CHANNEL = 'default';
    vi.spyOn(MftOsEngine, 'deliver').mockRejectedValue(Object.assign(new Error('the builder cannot release the file'), { code: 'MFT_FOUR_EYES' }));
    await expect(ACHEngine.transmitBatch('ACH-1', { approvedBy: 'trustee-one' })).rejects.toThrow(/cannot release/);
    expect(sql.some(s => /UPDATE ach_batches SET status = 'failed'/.test(s))).toBe(true);
  });

  it('leaves the configured bank endpoint alone when no MFT channel is named', async () => {
    delete process.env.ACH_MFT_CHANNEL;
    const deliver = vi.spyOn(MftOsEngine, 'deliver');
    const { OpenBankApi } = require('../server/integrations/ach/openBankApi');
    vi.spyOn(OpenBankApi, 'transmit').mockResolvedValue({ success: true, mode: 'remote', message_id: 'X', status_code: 200, mdn_received: true } as any);
    await ACHEngine.transmitBatch('ACH-1');
    expect(deliver).not.toHaveBeenCalled();
  });
});

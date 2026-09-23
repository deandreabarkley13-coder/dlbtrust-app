import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ACHEngine } = require('../server/integrations/ach/achEngine');
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const { AS2Partners } = require('../server/integrations/ach/as2Partners');
const { MftOsEngine } = require('../server/integrations/os/mftOsEngine');
const { MftGatewayClient } = require('../server/integrations/edi/mftGatewayClient');
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

  it('routes the NACHA file to the bank partner on MFT Gateway when a partner AS2 ID (other than our station) is set', async () => {
    delete process.env.ACH_MFT_CHANNEL;
    Object.assign(process.env, {
      MFTGATEWAY_API_TOKEN_ID: 'tok-id', MFTGATEWAY_API_TOKEN_SECRET: 'tok-secret',
      MFTGATEWAY_STATION_AS2_ID: 'DLBTRUST-AS2', MFTGATEWAY_PARTNER_AS2_ID: 'BANK-ODFI-AS2',
    });
    const submit = vi.spyOn(MftGatewayClient, 'submit').mockResolvedValue({
      success: true, status_code: 202, message_id: 'MSG-1', as2_from: 'DLBTRUST-AS2', as2_to: 'BANK-ODFI-AS2', link: 'https://console.mftgateway.com/m/1', response_body: '{}',
    } as any);
    const deliver = vi.spyOn(MftOsEngine, 'deliver');

    const result = await ACHEngine.transmitBatch('ACH-1', { approvedBy: 'trustee-two' });
    expect(result).toMatchObject({ success: true, mode: 'mftgateway', message_id: 'MSG-1', batch_status: 'transmitted' });
    expect(submit).toHaveBeenCalledWith('101 ...', 'ACH-1.ach', expect.objectContaining({ stationAs2Id: 'DLBTRUST-AS2', partnerAs2Id: 'BANK-ODFI-AS2', contentType: 'text/plain' }));
    expect(deliver).not.toHaveBeenCalled();
    expect(sql.some(s => s.startsWith('INSERT INTO ach_transmissions'))).toBe(true);

    submit.mockClear();
    (SystemSettings.getMode as any).mockResolvedValue('sandbox');
    (SystemSettings.getProductionPartnerConfig as any).mockResolvedValue(null);
    const sandbox = await ACHEngine.transmitBatch('ACH-1').catch((e: Error) => ({ mode: 'error', error: e.message }));
    expect(submit).not.toHaveBeenCalled();
    expect(sandbox.mode).not.toBe('mftgateway');
    (SystemSettings.getMode as any).mockResolvedValue('production');

    process.env.MFTGATEWAY_PARTNER_AS2_ID = 'dlbtrust-as2';
    expect(ACHEngine.mftGatewayPartnerConfig()).toBeNull();
    delete process.env.MFTGATEWAY_PARTNER_AS2_ID;
    expect(ACHEngine.mftGatewayPartnerConfig()).toBeNull();
  });

  it('fails the batch when MFT Gateway rejects the submission', async () => {
    delete process.env.ACH_MFT_CHANNEL;
    Object.assign(process.env, { MFTGATEWAY_API_TOKEN_ID: 'a', MFTGATEWAY_API_TOKEN_SECRET: 'b', MFTGATEWAY_PARTNER_AS2_ID: 'BANK-ODFI-AS2' });
    vi.spyOn(MftGatewayClient, 'submit').mockResolvedValue({ success: false, status_code: 403, response_body: 'partner not linked' } as any);
    await expect(ACHEngine.transmitBatch('ACH-1')).rejects.toThrow(/MFT Gateway submit failed \(403\)/);
    expect(sql.some(s => /UPDATE ach_batches SET status = 'failed'/.test(s))).toBe(true);
  });

  it('leaves the configured bank endpoint alone when no MFT channel is named', async () => {
    delete process.env.ACH_MFT_CHANNEL;
    delete process.env.MFTGATEWAY_PARTNER_AS2_ID;
    const deliver = vi.spyOn(MftOsEngine, 'deliver');
    const { OpenBankApi } = require('../server/integrations/ach/openBankApi');
    vi.spyOn(OpenBankApi, 'transmit').mockResolvedValue({ success: true, mode: 'remote', message_id: 'X', status_code: 200, mdn_received: true } as any);
    await ACHEngine.transmitBatch('ACH-1');
    expect(deliver).not.toHaveBeenCalled();
  });
});

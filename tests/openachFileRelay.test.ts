import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { OpenAchFileRelay } = require('../server/integrations/openach/openachFileRelay');
const { MftGatewayClient } = require('../server/integrations/edi/mftGatewayClient');
const google = require('../server/integrations/google/googleServiceAccount');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

function liveEnv() {
  process.env.OPENACH_ACH_FILES_BUCKET = 'dlb-treasury-management-openach-ach-files';
  process.env.MFTGATEWAY_API_TOKEN_ID = 'tok';
  process.env.MFTGATEWAY_API_TOKEN_SECRET = 'sec';
  process.env.MFTGATEWAY_STATION_AS2_ID = 'DLBTRUST-AS2';
  process.env.MFTGATEWAY_PARTNER_AS2_ID = 'SUNRISE-ACH';
}

describe('OpenAchFileRelay', () => {
  let sql: any[];

  beforeEach(() => {
    sql = [];
    for (const k of Object.keys(process.env)) if (/^(OPENACH_ACH_FILES|MFTGATEWAY_|EDI_820_)/.test(k)) delete process.env[k];
    vi.spyOn(pool, 'query').mockImplementation(async (text: any, params: any) => { sql.push([String(text).replace(/\s+/g, ' ').trim(), params]); return { rows: [] } as any; });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('fails closed without the bucket or an MFT Gateway partner', async () => {
    const status = OpenAchFileRelay.status();
    expect(status.ready).toBe(false);
    expect(status.issues.join(' ')).toMatch(/OPENACH_ACH_FILES_BUCKET/);
    expect(status.issues.join(' ')).toMatch(/MFTGATEWAY_PARTNER_AS2_ID/);

    const result = await OpenAchFileRelay.run();
    expect(result.ready).toBe(false);
    expect(result.files).toEqual([]);
  });

  it('is ready when the bucket and the DLBTRUST-AS2 → partner pair are configured', () => {
    liveEnv();
    const status = OpenAchFileRelay.status();
    expect(status.ready).toBe(true);
    expect(status.stationAs2Id).toBe('DLBTRUST-AS2');
    expect(status.partnerAs2Id).toBe('SUNRISE-ACH');
  });

  it('submits each export/*.ach to MFT Gateway, moves it to sent/ and journals the message id', async () => {
    liveEnv();
    vi.spyOn(google, 'getAccessToken').mockResolvedValue('gcs-token' as any);
    const fetchMock = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('/o?')) return new Response(JSON.stringify({ items: [{ name: 'export/', size: '0' }, { name: 'export/DLB-20260923.ach', size: '940' }] }), { status: 200 });
      if (u.includes('alt=media')) return new Response('101 021000021 1211453072609230000A094101', { status: 200 });
      if (u.includes('/rewriteTo/')) return new Response(JSON.stringify({ done: true }), { status: 200 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${u}`);
    });
    const submit = vi.spyOn(MftGatewayClient, 'submit').mockResolvedValue({ success: true, message_id: 'mft-1', status_code: 200 } as any);

    const result = await OpenAchFileRelay.run();

    expect(result.ready).toBe(true);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect(submit).toHaveBeenCalledTimes(1);
    const [payload, filename, opts] = submit.mock.calls[0];
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect(filename).toBe('DLB-20260923.ach');
    expect(opts).toMatchObject({ stationAs2Id: 'DLBTRUST-AS2', partnerAs2Id: 'SUNRISE-ACH', contentType: 'text/plain' });

    const rewrite = fetchMock.mock.calls.find(([u]) => String(u).includes('/rewriteTo/'));
    expect(String(rewrite![0])).toMatch(/rewriteTo\/b\/[^/]+\/o\/sent%2F.*DLB-20260923\.ach/);
    const journal = sql.find(([t]) => t.startsWith('INSERT INTO openach_file_relays'));
    expect(journal[1]).toEqual(expect.arrayContaining(['export/DLB-20260923.ach', 'SUNRISE-ACH', 'sent', 'mft-1']));
  });

  it('moves a rejected file to failed/ and records the error without throwing', async () => {
    liveEnv();
    vi.spyOn(google, 'getAccessToken').mockResolvedValue('gcs-token' as any);
    vi.spyOn(globalThis, 'fetch' as any).mockImplementation(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('/o?')) return new Response(JSON.stringify({ items: [{ name: 'export/BAD.ach', size: '10' }] }), { status: 200 });
      if (u.includes('alt=media')) return new Response('junk', { status: 200 });
      if (u.includes('/rewriteTo/')) return new Response(JSON.stringify({ done: true }), { status: 200 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error(`unexpected fetch ${u}`);
    });
    vi.spyOn(MftGatewayClient, 'submit').mockRejectedValue(new Error('MFT Gateway submit failed (404): partner not found'));

    const result = await OpenAchFileRelay.run();

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.files[0]).toMatchObject({ object: 'export/BAD.ach', status: 'failed' });
    const journal = sql.find(([t]) => t.startsWith('INSERT INTO openach_file_relays'));
    expect(journal[1]).toEqual(expect.arrayContaining(['failed']));
    expect(journal[1].join(' ')).toMatch(/partner not found/);
  });
});

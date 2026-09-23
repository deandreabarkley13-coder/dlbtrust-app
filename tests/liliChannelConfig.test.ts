import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import path from 'path';

const require = createRequire(import.meta.url);
const { LiliSettlementBankEngine } = require('../server/integrations/payments/liliSettlementBankEngine');
const { LiliDirectDepositEngine } = require('../server/integrations/payments/liliDirectDepositEngine');
const { LiliMcpEngine } = require('../server/integrations/payments/liliMcpEngine');
const { validateReadiness, destinationFromEnv } = require('../server/scripts/configureLiliChannels');

const saved = { ...process.env };
const SCRIPT = path.resolve(__dirname, '../server/scripts/configureLiliChannels.js');

const LIVE_ENV = {
  LILI_CLEARING_LIVE: 'true',
  LILI_CLEARING_SEC_CODE: 'CCD',
  LILI_MCP_ENABLED: 'true',
  LILI_MCP_URL: 'https://mcp.lili.co/mcp',
  LILI_OAUTH_BASE_URL: 'https://mcp.lili.co',
  LILI_BUSINESS_USER_ID: 'bu-123',
  LILI_DD_ROUTING_NUMBER: '121145307',
  LILI_DD_ACCOUNT_NUMBER: '692101092959',
  LILI_DD_ACCOUNT_NAME: 'DB NET MGMT LLC',
  ACH_ODFI_ROUTING: '121145307',
  CLEARING_FUNDING_OPERATING_ACCOUNT: 'OPS-001',
  ACH_ORIGINATOR_NAME: 'DB NET MGMT LLC',
  TRUST_NAME: 'DLB Trust',
  API_GATEWAY_PROVIDER: 'lili',
  GCP_PROJECT: 'dlb-treasury-management',
  ACH_SFTP_URL: 'sftp://odfi.example.com/inbound',
};

describe('Lili live channel configuration', () => {
  beforeEach(() => {
    for (const k of Object.keys(LIVE_ENV)) delete process.env[k];
    Object.assign(process.env, LIVE_ENV);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('_cfg() picks up the live env set', () => {
    const cfg = LiliSettlementBankEngine._cfg();
    expect(cfg).toMatchObject({
      provider: 'lili',
      direction: 'treasury_to_lili',
      live: true,
      mcpUrl: 'https://mcp.lili.co/mcp',
      businessUserId: 'bu-123',
      secCode: 'CCD',
      sourceRouting: '121145307',
      sourceAccount: 'OPS-001',
      sourceName: 'DB NET MGMT LLC',
      gcpProject: 'dlb-treasury-management',
    });
  });

  it('status() reports originationReady + mode live when destination and ODFI channel are set', async () => {
    vi.spyOn(LiliDirectDepositEngine, 'getDestination').mockResolvedValue({
      configured: true, routingNumber: '121145307', accountNumberMasked: '****2959', accountName: 'DB NET MGMT LLC', _account: '692101092959',
    });
    vi.spyOn(LiliDirectDepositEngine, 'odfiStatus').mockResolvedValue({ ready: true, channels: ['sftp'], loopback: [], blocker: null });
    vi.spyOn(LiliMcpEngine, 'getPublicConfig').mockResolvedValue({ configured: true });

    const status = await LiliSettlementBankEngine.status();
    expect(status.mode).toBe('live');
    expect(status.originationReady).toBe(true);
    expect(status.healthy).toBe(true);
    expect(status.destination.configured).toBe(true);
    expect(status.odfi.ready).toBe(true);
    expect(status.mcp.configured).toBe(true);
    expect(status.issues).toEqual([]);
    expect(validateReadiness(status)).toEqual([]);
  });

  it('status() fails closed without an ODFI channel', async () => {
    vi.spyOn(LiliDirectDepositEngine, 'getDestination').mockResolvedValue({ configured: true, routingNumber: '121145307', accountNumberMasked: '****2959', accountName: 'DB NET MGMT LLC', _account: '692101092959' });
    vi.spyOn(LiliDirectDepositEngine, 'odfiStatus').mockResolvedValue({ ready: false, channels: [], loopback: [], blocker: 'No ODFI channel configured (OpenACH/AS2/MFT/REST/SFTP)' });
    vi.spyOn(LiliMcpEngine, 'getPublicConfig').mockResolvedValue({ configured: true });

    const status = await LiliSettlementBankEngine.status();
    expect(status.mode).toBe('live');
    expect(status.originationReady).toBe(false);
    expect(status.healthy).toBe(false);
    expect(validateReadiness(status).map((f: any) => f.field)).toEqual(['odfi.ready']);
  });

  it('configureLiliChannels.js dry-run validates the readiness fields and the keyed destination', () => {
    expect(destinationFromEnv()).toEqual({ routingNumber: '121145307', accountNumber: '692101092959', accountName: 'DB NET MGMT LLC' });
    expect(validateReadiness({ mode: 'shadow', destination: { configured: false }, odfi: { ready: false }, mcp: { configured: false } }).map((f: any) => f.field))
      .toEqual(['mode', 'destination.configured', 'odfi.ready', 'mcp.configured']);

    const out = execFileSync(process.execPath, [SCRIPT, '--dry-run'], {
      env: { ...LIVE_ENV, PATH: process.env.PATH, ADMIN_TOKEN: '' },
      encoding: 'utf8',
    });
    expect(out).toContain('(dry run)');
    expect(out).toContain('****2959');
    expect(out).not.toContain('692101092959');
    expect(out).toContain('skipping remote readiness');

    let code = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, '--dry-run'], { env: { PATH: process.env.PATH, LILI_DD_ROUTING_NUMBER: '121145307' }, encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) { code = e.status; }
    expect(code).toBe(2);
  });
});

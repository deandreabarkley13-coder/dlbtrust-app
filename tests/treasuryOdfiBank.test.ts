import { describe, it, expect, vi } from 'vitest';

vi.mock('../server/integrations/openach/openachFileRelay', () => ({
  OpenAchFileRelay: { status: () => ({ ready: true, transport: 'mftgateway', stationAs2Id: 'DLBTRUST-AS2', partnerAs2Id: 'BETTERMENT-AS2', issues: [] }) },
}));

const { TreasuryOdfiBank } = require('../server/integrations/ach/treasuryOdfiBank');

const ROUTING = '011000015';
const ACCOUNT = '9876543210';

function env(extra: Record<string, string> = {}) {
  return {
    ACH_ODFI_BANK: 'betterment',
    BETTERMENT_ROUTING_NUMBER: ROUTING,
    BETTERMENT_ACCOUNT_NUMBER: ACCOUNT,
    INCOME_OBLIGOR_NAME: 'DEANDREA LAVAR BARKLEY TRUST COMPANY',
    INCOME_OBLIGOR_EIN: '99-6411566',
    PAYMENT_SERVER_SERVICE_TOKEN: 'tok',
    ...extra,
  } as Record<string, string>;
}

describe('TreasuryOdfiBank', () => {
  it('is a no-op without ACH_ODFI_BANK', () => {
    const e: Record<string, string> = { BETTERMENT_ROUTING_NUMBER: ROUTING };
    expect(TreasuryOdfiBank.apply(e)).toEqual([]);
    expect(e.ACH_ODFI_ROUTING).toBeUndefined();
    const st = TreasuryOdfiBank.status(e);
    expect(st.enabled).toBe(false);
    expect(st.ready).toBe(false);
  });

  it('projects the secret-backed Betterment account onto every NACHA originator variable', () => {
    const e = env();
    const written = TreasuryOdfiBank.apply(e);
    expect(written).toContain('ACH_ODFI_ROUTING');
    expect(e.ACH_ODFI_ROUTING).toBe(ROUTING);
    expect(e.NACHA_ODFI_ROUTING).toBe(ROUTING);
    expect(e.ACH_IMMEDIATE_ORIGIN).toBe('1' + ROUTING);
    expect(e.ACH_COMPANY_ID).toBe('1996411566');
    expect(e.ACH_ODFI_NAME).toBe('BETTERMENT');
    expect(e.ACH_ORIGINATOR_NAME).toBe('DEANDREA LAVAR BARKLEY TRUST COMPANY');
    expect(e.ACH_COMPANY_NAME.length).toBeLessThanOrEqual(16);
    expect(e.CLEARING_FUNDING_OPERATING_ACCOUNT).toBe(ACCOUNT);
    expect(e.LILI_ODFI_ROUTING).toBe(ROUTING);
    expect(e.LILI_ODFI_ACCOUNT).toBe(ACCOUNT);
    expect(e.EDI_820_ODFI_ACCOUNT).toBe(ACCOUNT);
  });

  it('honours a bank-assigned company id and explicit immediate origin', () => {
    const e = env({ ACH_ODFI_COMPANY_ID: 'B123456789', ACH_ODFI_IMMEDIATE_ORIGIN: '0123456789' });
    TreasuryOdfiBank.apply(e);
    expect(e.ACH_COMPANY_ID).toBe('B123456789');
    expect(e.ACH_IMMEDIATE_ORIGIN).toBe('0123456789');
  });

  it('reports ready with a file channel and never leaks the routing/account', () => {
    const st = TreasuryOdfiBank.status(env({ ACH_SFTP_URL: 'sftp://trust@files.betterment.example:22/incoming', ACH_SFTP_KEY: '/k' }));
    expect(st.ready).toBe(true);
    expect(st.role).toBe('odfi');
    expect(st.bank).toBe('betterment');
    expect(st.routingLast4).toBe(ROUTING.slice(-4));
    expect(st.accountLast4).toBe(ACCOUNT.slice(-4));
    expect(st.channels.map((c: any) => c.channel)).toEqual(['openach_mft_relay', 'sftp', 'server_to_server']);
    expect(st.channels.find((c: any) => c.channel === 'sftp').url).not.toContain('trust@');
    const json = JSON.stringify(st);
    expect(json).not.toContain(ROUTING);
    expect(json).not.toContain(ACCOUNT);
  });

  it('fails closed when the account secrets are missing', () => {
    const st = TreasuryOdfiBank.status(env({ BETTERMENT_ROUTING_NUMBER: '', BETTERMENT_ACCOUNT_NUMBER: '' }));
    expect(st.ready).toBe(false);
    expect(st.issues.join(' ')).toMatch(/BETTERMENT_ROUTING_NUMBER/);
    expect(st.issues.join(' ')).toMatch(/BETTERMENT_ACCOUNT_NUMBER/);
    expect(TreasuryOdfiBank.apply(env({ BETTERMENT_ROUTING_NUMBER: '' }))).toEqual([]);
  });
});

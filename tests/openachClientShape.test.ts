import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.OPENACH_BASE_URL = 'https://openach.internal/api';
process.env.OPENACH_API_TOKEN = 't';
process.env.OPENACH_API_KEY = 'k';

const { OpenACHClient, OpenACHSession, idField } = require('../server/integrations/openach/openachClient');

describe('OpenACH client — response shape', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reads record ids from the `data` envelope OpenACH returns (top-level still accepted)', () => {
    expect(idField({ success: true, data: { payment_profile_id: 'p1' } }, 'payment_profile_id')).toBe('p1');
    expect(idField({ success: true, payment_profile_id: 'p2' }, 'payment_profile_id')).toBe('p2');
    expect(idField({ success: false, error: 'nope' }, 'payment_profile_id')).toBeNull();
  });

  it('disburseToBeneficiary chains profile -> external account -> schedule using enveloped ids', async () => {
    const calls: Array<[string, any]> = [];
    vi.spyOn(OpenACHSession.prototype, 'connect').mockResolvedValue(undefined as any);
    vi.spyOn(OpenACHSession.prototype, 'disconnect').mockResolvedValue(undefined as any);
    vi.spyOn(OpenACHSession.prototype, 'request').mockImplementation(async (endpoint: string, params: any) => {
      calls.push([endpoint, params]);
      switch (endpoint) {
        case 'getPaymentProfileByExtId': return { success: false, error: 'Unable to find the specified payment profile.' };
        case 'savePaymentProfile': return { success: true, data: { payment_profile_id: 'pp-1', payment_profile_external_id: params.payment_profile_external_id } };
        case 'saveExternalAccount': return { success: true, data: { external_account_id: 'ea-1' } };
        case 'savePaymentSchedule': return { success: true, data: { payment_schedule_id: 'ps-1' } };
        default: throw new Error(`unexpected ${endpoint}`);
      }
    });
    const out = await OpenACHClient.disburseToBeneficiary({
      first_name: 'DB NET MGMT', last_name: 'LLC', email: 'ops@example.test', external_id: 'ACH-1:1',
      bank_name: 'Lili', routing_number: '121145307', account_number: '000000002959', account_type: 'Checking',
      amount: '1.00', send_date: '2026-09-23', payment_type_id: 'pt-credit',
    });
    expect(out).toMatchObject({ success: true, payment_profile_id: 'pp-1', external_account_id: 'ea-1', payment_schedule_id: 'ps-1' });
    expect(calls.map(c => c[0])).toEqual(['getPaymentProfileByExtId', 'savePaymentProfile', 'saveExternalAccount', 'savePaymentSchedule']);
    expect(calls[2][1]).toMatchObject({ external_account_payment_profile_id: 'pp-1', external_account_dfi_id: '121145307', external_account_type: 'checking' });
    expect(calls[3][1]).toMatchObject({ payment_schedule_external_account_id: 'ea-1', payment_schedule_payment_type_id: 'pt-credit', payment_schedule_amount: '1.00', payment_schedule_next_date: '2026-09-23', payment_schedule_end_date: '2026-09-30' });
  });

  it('renders OpenACH field-validation errors (objects) in the thrown message', async () => {
    vi.spyOn(OpenACHSession.prototype, 'connect').mockResolvedValue(undefined as any);
    vi.spyOn(OpenACHSession.prototype, 'disconnect').mockResolvedValue(undefined as any);
    vi.spyOn(OpenACHSession.prototype, 'request').mockImplementation(async (endpoint: string) => {
      if (endpoint === 'getPaymentProfileByExtId') return { success: true, data: { payment_profile_id: 'pp-1' } };
      if (endpoint === 'saveExternalAccount') return { success: false, error: { external_account_type: ['External account type must be one of ("checking","savings")'] } };
      throw new Error(`should not reach ${endpoint}`);
    });
    await expect(OpenACHClient.disburseToBeneficiary({ first_name: 'A', last_name: 'B', email: 'a@b.test', external_id: 'x', bank_name: 'L', routing_number: '1', account_number: '2', account_type: 'Checking', amount: '1', send_date: '2026-09-23', payment_type_id: 'pt' }))
      .rejects.toThrow(/external_account_type.*must be one of/);
  });

  it('fails loudly instead of passing an undefined profile id downstream', async () => {
    vi.spyOn(OpenACHSession.prototype, 'connect').mockResolvedValue(undefined as any);
    vi.spyOn(OpenACHSession.prototype, 'disconnect').mockResolvedValue(undefined as any);
    vi.spyOn(OpenACHSession.prototype, 'request').mockImplementation(async (endpoint: string) => {
      if (endpoint === 'getPaymentProfileByExtId') return { success: false };
      if (endpoint === 'savePaymentProfile') return { success: true, data: {} };
      throw new Error(`should not reach ${endpoint}`);
    });
    await expect(OpenACHClient.disburseToBeneficiary({ first_name: 'A', last_name: 'B', email: 'a@b.test', external_id: 'x', bank_name: 'L', routing_number: '1', account_number: '2', account_type: 'Checking', amount: '1', send_date: '2026-09-23', payment_type_id: 'pt' }))
      .rejects.toThrow(/no payment_profile_id/);
  });
});

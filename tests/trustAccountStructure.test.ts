import { describe, it, expect, vi, afterEach } from 'vitest';

const pool = require('../server/integrations/bonds/pgPool');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const { TrustAccountStructure } = require('../server/integrations/fineract/trustAccountStructure');
const { DebtOsEngine } = require('../server/integrations/os/debtOsEngine');

const env = { FINERACT_URL: 'https://dlbtrust-fineract.internal', CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID: '2' };
const trustee = { contact_id: 'CRM-T1', contact_type: 'trustee', first_name: 'Ada', last_name: 'Trustee', email: null, fineract_client_id: null };
const beneficiary = { contact_id: 'CRM-B1', contact_type: 'beneficiary', first_name: 'Ben', last_name: 'Heir', email: 'ben@example.com', fineract_client_id: null };

function active(id: number, externalId: string, balance = 0) {
  return { id, accountNo: String(id).padStart(9, '0'), externalId, clientId: 2, clientName: 'Trust', savingsProductName: 'Trust Account of Record (USD)', status: { active: true, value: 'Active' }, summary: { accountBalance: balance, availableBalance: balance } };
}

function stubCrm(rows: any[]) {
  vi.spyOn(pool, 'query').mockImplementation(async (text: string) => {
    if (/FROM crm_contacts/i.test(text)) return { rows } as any;
    return { rows: [] } as any;
  });
}

afterEach(() => vi.restoreAllMocks());

describe('TrustAccountStructure', () => {
  it('declares principal, interest-income, account of record and one sub-account per active trustee/beneficiary with the right GL codes', async () => {
    stubCrm([trustee, beneficiary]);
    const expected = await TrustAccountStructure.expected(env);
    expect(expected.map((e: any) => [e.role, e.externalId, e.glCode])).toEqual([
      ['account-of-record', 'holder:dlb-irrevocable-trust:savings', '1000'],
      ['principal', 'holder:dlb-irrevocable-trust:principal', '3000'],
      ['interest-income', 'holder:dlb-irrevocable-trust:interest-income', '4000'],
      ['trustee', 'trustee:CRM-T1:savings', '1030'],
      ['beneficiary', 'beneficiary:CRM-B1:savings', '1020'],
    ]);
  });

  it('inventory resolves by externalId and reports missing / inactive accounts as blockers without touching balances', async () => {
    stubCrm([trustee, beneficiary]);
    const find = vi.spyOn(FineractClient, 'findSavingsAccountByExternalId').mockImplementation(async (ext: string) => {
      if (ext === 'holder:dlb-irrevocable-trust:savings') return active(2, ext, 7709589.04);
      if (ext === 'trustee:CRM-T1:savings') return { ...active(7, ext), status: { active: false, value: 'Submitted and pending approval' } };
      return null;
    });
    const deposit = vi.spyOn(FineractClient, 'depositSavings');
    const inv = await TrustAccountStructure.inventory({ fresh: true, env });
    expect(inv.accountOfRecord).toMatchObject({ found: true, active: true, id: 2, balance: 7709589.04 });
    expect(inv.principal).toMatchObject({ found: false, active: false });
    expect(inv.interestIncome.blocker).toMatch(/not in Fineract/);
    expect(inv.trustees[0].blocker).toMatch(/pending approval/);
    expect(inv.counts).toMatchObject({ expected: 5, found: 2, active: 1 });
    expect(inv.complete).toBe(false);
    expect(inv.blockers.length).toBe(4);
    expect(find).toHaveBeenCalledTimes(5);
    expect(deposit).not.toHaveBeenCalled();
    expect(await TrustAccountStructure.resolveAccountId('interest-income', { env })).toBeNull();
    expect(await TrustAccountStructure.resolveAccountId('account-of-record', { env })).toBe('2');
  });

  it('provision creates only the missing accounts (client -> savings -> approve -> activate), reuses existing clients and never creates the account of record', async () => {
    stubCrm([trustee]);
    const existing: Record<string, any> = { 'holder:dlb-irrevocable-trust:savings': active(2, 'holder:dlb-irrevocable-trust:savings') };
    vi.spyOn(FineractClient, 'findSavingsAccountByExternalId').mockImplementation(async (ext: string) => existing[ext] || null);
    vi.spyOn(FineractClient, 'findClientByExternalId').mockImplementation(async (ext: string) => (ext === 'holder:dlb-irrevocable-trust' ? { id: 2, externalId: ext } : null));
    const { BondIssuanceEngine } = require('../server/integrations/bonds/bondIssuanceEngine');
    vi.spyOn(BondIssuanceEngine, 'ensureSavingsProduct').mockResolvedValue({ id: 1, name: 'Trust Account of Record (USD)' });
    const createClient = vi.spyOn(FineractClient, 'createClient').mockResolvedValue({ clientId: 9 });
    let nextId = 10;
    const createSavings = vi.spyOn(FineractClient, 'createSavingsAccount').mockImplementation(async ({ externalId }: any) => {
      const id = nextId++;
      existing[externalId] = active(id, externalId);
      return { savingsId: id, resourceId: id };
    });
    const command = vi.spyOn(FineractClient, 'commandSavingsAccount').mockResolvedValue({});
    vi.spyOn(FineractClient, 'getAccountBalance').mockImplementation(async (id: number) => Object.values(existing).find((a: any) => a.id === Number(id)));

    const dry = await TrustAccountStructure.provision({ dryRun: true, env });
    expect(dry.results.map((r: any) => r.action)).toEqual(['exists', 'would-create', 'would-create', 'would-create']);
    expect(createSavings).not.toHaveBeenCalled();

    const result = await TrustAccountStructure.provision({ actor: 'admin', env });
    expect(result.created).toBe(3);
    expect(result.failed).toBe(0);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'CRM-T1', firstName: 'Ada', lastName: 'Trustee' }));
    expect(createSavings.mock.calls.map((c: any) => c[0])).toEqual([
      { clientId: 2, productId: 1, externalId: 'holder:dlb-irrevocable-trust:principal' },
      { clientId: 2, productId: 1, externalId: 'holder:dlb-irrevocable-trust:interest-income' },
      { clientId: 9, productId: 1, externalId: 'trustee:CRM-T1:savings' },
    ]);
    expect(command.mock.calls.map((c: any) => c[1])).toEqual(['approve', 'activate', 'approve', 'activate', 'approve', 'activate']);
    expect(result.inventory.complete).toBe(true);
    expect(result.inventory.interestIncome.id).toBe(11);
  });
});

describe('coupon settlement destination', () => {
  it('prefers the active interest-income savings account, else the linked / canonical account of record', () => {
    const linked = { account_id: 'CA-BOND-PROCEEDS', linked_fineract_account_id: '2' };
    expect(DebtOsEngine._couponCoreBanking(linked, env, '11')).toMatchObject({ savingsAccountId: '11', destination: 'interest-income', glIncomeCode: '4000', blocker: null });
    expect(DebtOsEngine._couponCoreBanking(linked, env, null)).toMatchObject({ savingsAccountId: '2', destination: 'linked-cash-account' });
    expect(DebtOsEngine._couponCoreBanking({ account_id: 'CA-X' }, env, null)).toMatchObject({ savingsAccountId: '2', destination: 'canonical-account-of-record' });
    expect(DebtOsEngine._couponCoreBanking({ account_id: 'CA-X' }, { FINERACT_URL: env.FINERACT_URL }, null).blocker).toMatch(/no linked_fineract_account_id/);
  });
});

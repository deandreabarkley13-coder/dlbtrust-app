import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PtcPortalEngine, SUB_LEDGER_PLAN, isTrusteeSubLedger } = require('../server/integrations/dapp/ptcPortalEngine');
const { SubLedgerEngine } = require('../server/integrations/accounting/subLedgerEngine');
const pool = require('../server/integrations/bonds/pgPool');

const MEMBERS = [
  { email: 'malissa1130@gmail.com', name: 'Malissa Robinson', type: 'trustee,beneficiary', role: 'maker', roles: ['trustee_maker', 'beneficiary'], crmContactId: 'CRM-BEN-1782927155850' },
  { email: 'deandreabarkley13@gmail.com', name: 'DeAndrea L Barkley', type: 'trustee,beneficiary', role: 'checker', roles: ['trustee_checker', 'beneficiary'], crmContactId: 'CRM-BEN-1782927036064' },
  { email: 'annrobinson9800@yahoo.com', name: 'Malissa A Robinson', type: 'beneficiary', role: 'beneficiary', roles: ['beneficiary'], crmContactId: 'CRM-BEN-1782927155850' },
  { email: 'robinsonjeremy22a@gmail.com', name: 'Jeremy N Robinson', type: 'beneficiary', role: 'beneficiary', roles: ['beneficiary'], crmContactId: 'CRM-BEN-1782927793173' },
];

describe('PtcPortalEngine.ensureSubLedgerAccounts — beneficiary + trustee sub-ledger provisioning', () => {
  let ledgers: any[];
  let contacts: Record<string, any>;
  let sql: { text: string; params: any[] }[];

  beforeEach(() => {
    ledgers = [];
    contacts = {};
    sql = [];
    vi.spyOn(SubLedgerEngine, 'listSubLedgers').mockImplementation(async (f: any = {}) =>
      ledgers.filter(l =>
        (!f.contactId || l.contact_id === f.contactId)
        && (!f.parentAccountCode || l.parent_account_code === f.parentAccountCode)
        && (!f.subAccountType || l.sub_account_type === f.subAccountType)
        && (!f.status || l.status === f.status)));
    vi.spyOn(SubLedgerEngine, 'createSubLedger').mockImplementation(async (a: any) => {
      const row = {
        sub_ledger_id: `SL-${ledgers.length + 1}`, contact_id: a.contactId, parent_account_code: a.parentAccountCode,
        sub_account_name: a.subAccountName, sub_account_type: a.subAccountType, balance: 0, status: 'active', notes: a.notes,
      };
      ledgers.push(row);
      return row;
    });
    vi.spyOn(pool, 'query').mockImplementation(async (text: any, params: any[] = []) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      sql.push({ text: t, params });
      if (t.startsWith('SELECT contact_id, contact_type FROM crm_contacts')) {
        return { rows: contacts[params[0]] ? [contacts[params[0]]] : [] } as any;
      }
      if (t.startsWith('INSERT INTO crm_contacts')) {
        contacts[params[0]] = { contact_id: params[0], contact_type: params[1], first_name: params[2], last_name: params[3], email: params[4] };
        return { rows: [] } as any;
      }
      if (t.startsWith('UPDATE crm_contacts SET contact_type')) {
        contacts[params[1]].contact_type = params[0];
        return { rows: [] } as any;
      }
      return { rows: [] } as any;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates one Trust Sub-Ledger per beneficiary contact and compensation + fee ledgers per trustee, with the right parent GL codes and types', async () => {
    const out = await PtcPortalEngine.ensureSubLedgerAccounts(MEMBERS);

    // 3 beneficiary contacts + 2 trustees × 2 = 7 accounts
    expect(out.created).toHaveLength(7);
    expect(out.existing).toHaveLength(1); // Malissa's beneficiary ledger already existed via her trustee row
    expect(ledgers).toHaveLength(7);

    const beneficiary = ledgers.filter(l => l.parent_account_code === '2000');
    expect(beneficiary.map(l => l.sub_account_type)).toEqual(['distribution', 'distribution', 'distribution']);
    expect(new Set(beneficiary.map(l => l.contact_id))).toEqual(new Set(['CRM-BEN-1782927155850', 'CRM-BEN-1782927036064', 'CRM-BEN-1782927793173']));
    expect(beneficiary.map(l => l.sub_account_name)).toEqual(expect.arrayContaining([
      'Malissa Robinson — Beneficiary Trust Sub-Ledger',
      'DeAndrea L Barkley — Beneficiary Trust Sub-Ledger',
      'Jeremy N Robinson — Beneficiary Trust Sub-Ledger',
    ]));

    const comp = ledgers.filter(l => l.parent_account_code === '5100');
    expect(comp).toHaveLength(2);
    expect(comp.every(l => l.sub_account_type === 'trustee_fee')).toBe(true);
    expect(comp.map(l => l.sub_account_name)).toEqual(expect.arrayContaining(['Malissa Robinson — Trustee Compensation', 'DeAndrea L Barkley — Trustee Compensation']));

    const fees = ledgers.filter(l => l.parent_account_code === '2100');
    expect(fees).toHaveLength(2);
    expect(fees.every(l => l.sub_account_type === 'fee')).toBe(true);
    expect(fees.map(l => l.sub_account_name)).toEqual(expect.arrayContaining(['Malissa Robinson — Trustee Fees', 'DeAndrea L Barkley — Trustee Fees']));

    expect(comp.every(isTrusteeSubLedger)).toBe(true);
    expect(fees.every(isTrusteeSubLedger)).toBe(true);
    expect(beneficiary.some(isTrusteeSubLedger)).toBe(false);
    expect(Object.keys(SUB_LEDGER_PLAN)).toEqual(['beneficiaryTrust', 'trusteeCompensation', 'trusteeFees']);
  });

  it('is idempotent — a second run creates nothing and reports every account as existing', async () => {
    await PtcPortalEngine.ensureSubLedgerAccounts(MEMBERS);
    const create = SubLedgerEngine.createSubLedger as any;
    create.mockClear();

    const second = await PtcPortalEngine.ensureSubLedgerAccounts(MEMBERS);
    expect(create).not.toHaveBeenCalled();
    expect(second.created).toHaveLength(0);
    expect(second.existing).toHaveLength(8); // 4 members: 1+2, 1+2, 1, 1 plan matches
    expect(ledgers).toHaveLength(7);
  });

  it('seeds CRM contacts as trustee / beneficiary so SubLedgerEngine can auto-post Fineract journal entries', async () => {
    contacts['CRM-BEN-1782927793173'] = { contact_id: 'CRM-BEN-1782927793173', contact_type: 'investor' };
    await PtcPortalEngine.ensureSubLedgerAccounts(MEMBERS);

    expect(contacts['CRM-BEN-1782927155850'].contact_type).toBe('trustee');
    expect(contacts['CRM-BEN-1782927036064'].contact_type).toBe('trustee');
    expect(contacts['CRM-BEN-1782927036064']).toMatchObject({ first_name: 'DeAndrea', last_name: 'L Barkley', email: 'deandreabarkley13@gmail.com' });
    // Existing non-trustee/beneficiary contact is corrected to beneficiary
    expect(contacts['CRM-BEN-1782927793173'].contact_type).toBe('beneficiary');
    // A trustee contact is never downgraded by the beneficiary-only row sharing the same CRM id
    const downgrade = sql.find(s => s.text.startsWith('UPDATE crm_contacts') && s.params[0] === 'beneficiary' && s.params[1] === 'CRM-BEN-1782927155850');
    expect(downgrade).toBeUndefined();
  });

  it('scopes the dashboard sub-ledger view by role', async () => {
    await PtcPortalEngine.ensureSubLedgerAccounts(MEMBERS);
    const jeremy = { crm_contact_id: 'CRM-BEN-1782927793173' };
    const malissa = { crm_contact_id: 'CRM-BEN-1782927155850' };

    const beneficiaryView = await PtcPortalEngine.getSubLedgerView(jeremy, { isTrustee: false, isAdmin: false });
    expect(beneficiaryView.scope).toBe('self');
    expect(beneficiaryView.mine.map((l: any) => l.contact_id)).toEqual(['CRM-BEN-1782927793173']);
    expect(beneficiaryView.trustee).toEqual([]);
    expect(beneficiaryView.all).toEqual([]);

    const trusteeView = await PtcPortalEngine.getSubLedgerView(malissa, { isTrustee: true, isAdmin: false });
    expect(trusteeView.scope).toBe('trustee');
    expect(trusteeView.mine).toHaveLength(3);
    expect(trusteeView.trustee).toHaveLength(4);
    expect(trusteeView.trustee.every(isTrusteeSubLedger)).toBe(true);
    expect(trusteeView.all).toEqual([]);

    const adminView = await PtcPortalEngine.getSubLedgerView(null, { isTrustee: true, isAdmin: true });
    expect(adminView.scope).toBe('admin');
    expect(adminView.all).toHaveLength(7);
  });
});

describe('SubLedgerEngine sub-account types', () => {
  it('accepts trustee_fee and rejects unknown types before touching the database', async () => {
    expect(SubLedgerEngine.SUB_ACCOUNT_TYPES).toContain('trustee_fee');
    expect(SubLedgerEngine.SUB_ACCOUNT_TYPES).toContain('distribution');
    expect(SubLedgerEngine.SUB_ACCOUNT_TYPES).toContain('fee');
    const q = vi.spyOn(pool, 'query');
    await expect(SubLedgerEngine.createSubLedger({ contactId: 'CRM-X', parentAccountCode: '5100', subAccountName: 'x', subAccountType: 'nope' }))
      .rejects.toThrow(/Invalid subAccountType/);
    expect(q).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

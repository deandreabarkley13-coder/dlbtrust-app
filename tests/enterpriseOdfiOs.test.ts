import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { EnterpriseOdfiOsEngine, rulesPlan, acceptProposal, encrypt, decrypt, getEnterpriseOdfiConfig, RAILS } = require('../server/integrations/os/enterpriseOdfiOsEngine');
const { ClearingAgentOsEngine } = require('../server/integrations/os/clearingAgentOsEngine');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };

const FAMILY_NET = { network_id: 'PPN-FAMILY', kind: 'private_payment_network', country: 'US', handshake_state: 'verified' };
const ODFI_NET = { network_id: 'SPONSOR-ODFI', kind: 'ach_operator', country: 'US', handshake_state: 'verified' };
const RTP_NET = { network_id: 'RTP-PART', kind: 'rtp_participant', country: 'US', handshake_state: 'registered' };

const IX = {
  amountCents: 125000,
  purpose: 'Beneficiary income support',
  debtor: { name: 'DEANDREA LAVAR BARKLEY TRUST', routingNumber: '021000021', accountNumber: '000000002', fineractAccountId: '4' },
  creditor: { name: 'Jeremy N Robinson', routingNumber: '011000015', accountNumber: '9876543210', accountType: 'savings', participantId: 'CRM-BEN-1', fineractAccountId: '5' },
};
const VENDOR_IX = {
  amountCents: 48000,
  purpose: 'Vendor invoice 1182',
  secCode: 'CCD',
  debtor: { name: 'DEANDREA LAVAR BARKLEY TRUST', routingNumber: '021000021', accountNumber: '000000002', fineractAccountId: '2' },
  creditor: { name: 'Acme Roofing LLC', routingNumber: '011000015', accountNumber: '5551234567', accountType: 'checking' },
};

/** In-memory Cloud SQL for the four enterprise_odfi tables. */
function memPool() {
  const tables: Record<string, Map<string, any>> = { enterprise_odfi_profiles: new Map(), enterprise_odfi_batches: new Map(), enterprise_odfi_items: new Map(), enterprise_odfi_events: new Map() };
  const pk: Record<string, string> = { enterprise_odfi_profiles: 'originator_id', enterprise_odfi_batches: 'batch_id', enterprise_odfi_items: 'item_id', enterprise_odfi_events: 'event_id' };
  const parseInsert = (s: string, params: any[]) => {
    const cols = s.match(/\(([^)]+)\)\s*VALUES/)![1].split(',').map((c) => c.trim());
    const vals = s.match(/VALUES\s*\((.+?)\)\s*(ON CONFLICT|$)/s)![1].split(',').map((v) => v.trim());
    const row: any = {};
    cols.forEach((c, i) => { const v = vals[i]; row[c] = v.startsWith('$') ? params[Number(v.slice(1)) - 1] : v === 'NULL' ? null : v.replace(/'/g, ''); });
    if (typeof row.sec_codes === 'string') row.sec_codes = JSON.parse(row.sec_codes);
    row.created_at = new Date();
    return row;
  };
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any[] = []) => {
    const s = String(sql).trim();
    const t = (s.match(/(?:INTO|FROM|UPDATE)\s+(enterprise_odfi_\w+)/) || [])[1];
    if (!t) return { rows: [] };
    const store = tables[t];
    if (/^INSERT/.test(s)) { const row = parseInsert(s, params); store.set(row[pk[t]], row); return { rows: [] }; }
    if (/^UPDATE/.test(s)) {
      const row = store.get(params[0]);
      for (const [, col, idx] of s.matchAll(/(\w+) = \$(\d+)/g)) row[col] = params[Number(idx) - 1];
      return { rows: [row] };
    }
    if (/GROUP BY status/.test(s)) {
      const agg: Record<string, { n: number; cents: number }> = {};
      for (const r of store.values()) { agg[r.status] = agg[r.status] || { n: 0, cents: 0 }; agg[r.status].n += 1; agg[r.status].cents += Number(r.amount_cents); }
      return { rows: Object.entries(agg).map(([status, v]) => ({ status, ...v })) };
    }
    if (/WHERE originator_id = \$1/.test(s)) { const r = store.get(params[0]); return { rows: r ? [r] : [] }; }
    if (/WHERE batch_id = \$1/.test(s)) { const r = t === 'enterprise_odfi_batches' ? [store.get(params[0])].filter(Boolean) : [...store.values()].filter((x) => x.batch_id === params[0]); return { rows: r }; }
    if (/WHERE item_id = \$1/.test(s)) { const r = store.get(params[0]); return { rows: r ? [r] : [] }; }
    if (/WHERE idempotency_key = \$1/.test(s)) return { rows: [...store.values()].filter((x) => x.idempotency_key === params[0]) };
    return { rows: [...store.values()] };
  });
  return tables;
}

function item(key: string, ix: any = IX, extra: any = {}) {
  return { idempotencyKey: key, approvalRef: `APR-${key}`, screeningRef: `OFAC-${key}`, instruction: ix, ...extra };
}

async function countersignedProfile() {
  await EnterpriseOdfiOsEngine.profile({ companyName: 'DLB Family Trust Company', companyId: '34-1234567', actor: 'Trustee.A@f' });
  return EnterpriseOdfiOsEngine.countersign({ actor: 'trustee.b@f' });
}

let networks: any[];
let tables: Record<string, Map<string, any>>;

beforeEach(() => {
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = 'unit-test-data-key';
  process.env.ENTERPRISE_ODFI_LIVE = 'true';
  process.env.ENTERPRISE_ODFI_AI_ENABLED = 'false';
  process.env.CLEARING_AGENT_LIVE = 'true';
  networks = [FAMILY_NET];
  tables = memPool();
  vi.spyOn(ClearingAgentOsEngine, 'networks').mockImplementation(async () => networks);
  vi.spyOn(ClearingAgentOsEngine, 'readiness').mockImplementation(async () => ({ ready: true, mode: 'live', blockers: [] }));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('Enterprise ODFI OS — planner (pure)', () => {
  it('routes family creditors over the PPN and external items to the fastest verified rail within limits', () => {
    const cfg = getEnterpriseOdfiConfig();
    const fam = { itemId: 'a', purposeClass: 'distribution', urgency: 'standard', instruction: { amountCents: 1000, creditor: { fineractAccountId: '5' } } };
    expect(rulesPlan(fam, [FAMILY_NET, ODFI_NET], cfg)).toMatchObject({ rail: 'family_book', networkId: 'PPN-FAMILY' });
    const vendor = { itemId: 'b', purposeClass: 'vendor_payout', urgency: 'instant', instruction: { amountCents: 1000, creditor: {} } };
    expect(rulesPlan(vendor, [FAMILY_NET], cfg)).toMatchObject({ networkId: null });
    expect(rulesPlan(vendor, [FAMILY_NET, ODFI_NET], cfg)).toMatchObject({ rail: 'ach_same_day', networkId: 'SPONSOR-ODFI' });
    expect(rulesPlan(vendor, [{ ...RTP_NET, handshake_state: 'verified' }, ODFI_NET], cfg)).toMatchObject({ rail: 'rtp', networkId: 'RTP-PART' });
    expect(rulesPlan({ ...vendor, instruction: { amountCents: cfg.sameDayLimitCents + 1, creditor: {} } }, [ODFI_NET], cfg)).toMatchObject({ rail: 'ach_standard' });
  });

  it('never accepts an advisory proposal that breaks a hard rule', () => {
    const cfg = getEnterpriseOdfiConfig();
    const vendor = { itemId: 'b', purposeClass: 'vendor_payout', urgency: 'standard', instruction: { amountCents: 1000, creditor: {} } };
    expect(acceptProposal({ rail: 'wire', networkId: 'SPONSOR-ODFI' }, vendor, [ODFI_NET], cfg).advisor).toMatch(/unknown rail/);
    expect(acceptProposal({ rail: 'rtp', networkId: 'RTP-PART' }, vendor, [ODFI_NET, RTP_NET], cfg).advisor).toMatch(/not verified/);
    expect(acceptProposal({ rail: 'family_book', networkId: 'PPN-FAMILY' }, vendor, [FAMILY_NET, ODFI_NET], cfg).advisor).toMatch(/Fineract/);
    expect(acceptProposal({ rail: 'ach_same_day', networkId: 'SPONSOR-ODFI', rationale: 'ok' }, vendor, [ODFI_NET], cfg)).toMatchObject({ advisor: 'accepted', rail: 'ach_same_day' });
    expect(RAILS).toEqual(['family_book', 'rtp', 'fednow', 'ach_same_day', 'ach_standard']);
  });

  it('encrypts instructions at rest and fails closed without the data key', () => {
    const enc = encrypt(IX);
    expect(enc).not.toContain('9876543210');
    expect(decrypt(enc)).toEqual(IX);
    delete process.env.PAYMENT_DATA_ENCRYPTION_KEY;
    expect(() => encrypt(IX)).toThrow(/PAYMENT_DATA_ENCRYPTION_KEY/);
  });
});

describe('Enterprise ODFI OS — originator profile (maker/checker)', () => {
  it('stores only company-ID last-4 and requires a distinct countersigner', async () => {
    const p = await EnterpriseOdfiOsEngine.profile({ companyName: 'DLB Family Trust Company', companyId: '34-1234567', actor: 'trustee.a@f' });
    expect(p.company_id_last4).toBe('*****4567');
    expect(p.countersigned_by).toBeNull();
    await expect(EnterpriseOdfiOsEngine.countersign({ actor: 'TRUSTEE.A@F' })).rejects.toThrow(/must differ/);
    const c = await EnterpriseOdfiOsEngine.countersign({ actor: 'trustee.b@f' });
    expect(c.countersigned_by).toBe('trustee.b@f');
    await expect(EnterpriseOdfiOsEngine.profile({ companyName: 'XY Trust Co', sponsorNetworkId: 'NOPE', actor: 'trustee.a@f' })).rejects.toThrow(/not a registered/);
  });
});

describe('Enterprise ODFI OS — originate / release / returns', () => {
  it('originate plans only: encrypted instruction, no clearing call, approval+screening enforced', async () => {
    await countersignedProfile();
    const submit = vi.spyOn(ClearingAgentOsEngine, 'submit');
    await expect(EnterpriseOdfiOsEngine.originate({ purposeClass: 'distribution', items: [{ idempotencyKey: 'k1', instruction: IX }], actor: 'trustee.a@f' })).rejects.toThrow(/approvalRef and screeningRef/);
    const b = await EnterpriseOdfiOsEngine.originate({ purposeClass: 'distribution', items: [item('k1')], actor: 'trustee.a@f' });
    expect(b.status).toBe('planned');
    expect(b.planner).toBe('rules');
    expect(b.items[0]).toMatchObject({ rail: 'family_book', network_id: 'PPN-FAMILY', creditor_last4: '******3210', instruction: 'encrypted' });
    expect(JSON.stringify(b)).not.toContain('9876543210');
    expect(submit).not.toHaveBeenCalled();
    await expect(EnterpriseOdfiOsEngine.originate({ purposeClass: 'distribution', items: [item('k1')], actor: 'trustee.a@f' })).rejects.toThrow(/already originated/);
  });

  it('blocks release for the same trustee, in shadow mode, and when no verified network carries the rail', async () => {
    await countersignedProfile();
    const b = await EnterpriseOdfiOsEngine.originate({ purposeClass: 'vendor_payout', items: [item('v1', VENDOR_IX)], actor: 'trustee.a@f' });
    expect(b.items[0].network_id).toBeNull();
    await expect(EnterpriseOdfiOsEngine.release({ batchId: b.batch_id, actor: 'trustee.a@f' })).rejects.toThrow(/must differ/);
    process.env.ENTERPRISE_ODFI_LIVE = 'false';
    await expect(EnterpriseOdfiOsEngine.release({ batchId: b.batch_id, actor: 'trustee.b@f' })).rejects.toThrow(/shadow/);
    process.env.ENTERPRISE_ODFI_LIVE = 'true';
    await expect(EnterpriseOdfiOsEngine.release({ batchId: b.batch_id, actor: 'trustee.b@f' })).rejects.toThrow(/no verified network/);
    networks = [FAMILY_NET, ODFI_NET];
    const r = await EnterpriseOdfiOsEngine.replan({ batchId: b.batch_id, actor: 'trustee.a@f' });
    expect(r.items[0]).toMatchObject({ rail: 'ach_standard', network_id: 'SPONSOR-ODFI' });
  });

  it('release clears+posts each item through the Clearing Agent with the decrypted instruction; return re-deposits', async () => {
    await countersignedProfile();
    networks = [FAMILY_NET, ODFI_NET];
    const submit = vi.spyOn(ClearingAgentOsEngine, 'submit').mockImplementation(async ({ idempotencyKey }: any) => ({ instruction_id: `CAI-${idempotencyKey}`, status: 'cleared' }));
    const post = vi.spyOn(ClearingAgentOsEngine, 'post').mockImplementation(async () => ({ status: 'posted' }));
    const deposit = vi.spyOn(FineractClient, 'depositSavings').mockResolvedValue({ resourceId: 901 } as any);
    const b = await EnterpriseOdfiOsEngine.originate({ purposeClass: 'disbursement', items: [item('d1'), item('d2', VENDOR_IX)], actor: 'trustee.a@f' });
    const rel = await EnterpriseOdfiOsEngine.release({ batchId: b.batch_id, actor: 'trustee.b@f' });
    expect(rel.status).toBe('originated');
    expect(rel.released_by).toBe('trustee.b@f');
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0]).toMatchObject({ networkId: 'PPN-FAMILY', approvalRef: 'APR-d1', screeningRef: 'OFAC-d1', actor: 'trustee.b@f' });
    expect(submit.mock.calls[0][0].instruction.creditor.accountNumber).toBe('9876543210');
    expect(submit.mock.calls[1][0].networkId).toBe('SPONSOR-ODFI');
    expect(post).toHaveBeenCalledTimes(2);
    expect(rel.items.every((i: any) => i.status === 'posted')).toBe(true);
    await expect(EnterpriseOdfiOsEngine.release({ batchId: b.batch_id, actor: 'trustee.b@f' })).rejects.toThrow(/only planned/);

    const rec = await EnterpriseOdfiOsEngine.reconcile();
    expect(rec).toMatchObject({ postedCents: 173000, outstandingCents: 0 });

    const it0 = rel.items[0];
    await expect(EnterpriseOdfiOsEngine.exception({ itemId: it0.item_id, code: 'X99', actor: 'trustee.a@f' })).rejects.toThrow(/Rxx/);
    const ret = await EnterpriseOdfiOsEngine.exception({ itemId: it0.item_id, code: 'r03', reason: 'no account', actor: 'trustee.a@f' });
    expect(ret).toMatchObject({ status: 'returned', return_code: 'R03', fineract_redeposit_id: '901' });
    expect(deposit).toHaveBeenCalledWith(expect.objectContaining({ accountId: '4', amount: 1250 }));
    const again = await EnterpriseOdfiOsEngine.exception({ itemId: it0.item_id, code: 'R03', actor: 'trustee.a@f' });
    expect(again.idempotent).toBe(true);
    expect(deposit).toHaveBeenCalledTimes(1);
    const noc = await EnterpriseOdfiOsEngine.exception({ itemId: rel.items[1].item_id, code: 'C01', reason: 'account number', actor: 'trustee.a@f' });
    expect(noc.status).toBe('noc');
    expect((await EnterpriseOdfiOsEngine.reconcile()).returnedCents).toBe(125000);
  });

  it('records failures per item and marks the batch partially_failed', async () => {
    await countersignedProfile();
    vi.spyOn(ClearingAgentOsEngine, 'submit').mockRejectedValue(new Error('network SPONSOR is registered; only verified networks clear'));
    const b = await EnterpriseOdfiOsEngine.originate({ purposeClass: 'trustee_expense', items: [item('t1')], actor: 'trustee.a@f' });
    const rel = await EnterpriseOdfiOsEngine.release({ batchId: b.batch_id, actor: 'trustee.b@f' });
    expect(rel.status).toBe('partially_failed');
    expect(rel.items[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/only verified/) });
  });

  it('enforces the exposure limit across planned batches', async () => {
    process.env.ENTERPRISE_ODFI_EXPOSURE_LIMIT_CENTS = '200000';
    await countersignedProfile();
    await EnterpriseOdfiOsEngine.originate({ purposeClass: 'distribution', items: [item('e1')], actor: 'trustee.a@f' });
    await expect(EnterpriseOdfiOsEngine.originate({ purposeClass: 'distribution', items: [item('e2')], actor: 'trustee.a@f' })).rejects.toThrow(/exposure limit/);
  });
});

describe('Enterprise ODFI OS — readiness', () => {
  it('is shadow without a countersigned profile and a verified external sponsor network; live once both exist', async () => {
    let r = await EnterpriseOdfiOsEngine.readiness();
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/profile not declared/), expect.stringMatching(/no verified external sponsor ODFI network/)]));
    expect(r.status.policy.isBank).toBe(false);
    expect(r.status.planner).toMatchObject({ provider: 'rules', advisory: true });
    await countersignedProfile();
    networks = [FAMILY_NET, ODFI_NET];
    r = await EnterpriseOdfiOsEngine.readiness();
    expect(r).toMatchObject({ ready: true, mode: 'live', blockers: [] });
    expect(r.status.rails.external).toEqual([{ networkId: 'SPONSOR-ODFI', kind: 'ach_operator' }]);
    process.env.ENTERPRISE_ODFI_LIVE = 'false';
    r = await EnterpriseOdfiOsEngine.readiness();
    expect(r.blockers).toEqual(['ENTERPRISE_ODFI_LIVE not true']);
  });
});

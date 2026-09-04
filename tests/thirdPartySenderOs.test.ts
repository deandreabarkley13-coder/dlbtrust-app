import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pool = require('../server/integrations/bonds/pgPool');
const { ComplianceEngine } = require('../server/integrations/compliance/complianceEngine');
const { TpsOsEngine, returnCategory, nextDue, RETURN_THRESHOLDS_BPS, DEFAULT_OBLIGATIONS } = require('../server/integrations/os/thirdPartySenderOsEngine');

type Row = Record<string, any>;

/** In-memory register answering exactly the SQL shapes the engine emits. */
function store() {
  const t: Record<string, Row[]> = { tps_odfi_agreements: [], tps_originators: [], tps_obligations: [], tps_exposure: [], tps_returns: [], tps_events: [] };
  const cols = /\(([^)]+)\)\s+VALUES/i;
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    let m: RegExpExecArray | null;
    if ((m = /^INSERT INTO (\w+)/.exec(text))) {
      const table = m[1];
      const names = cols.exec(text)![1].split(',').map(s => s.trim());
      const values = /VALUES \((.+?)\)( RETURNING)?/.exec(text)![1].split(',').map(s => s.trim());
      const row: Row = { created_at: new Date().toISOString(), recorded_at: new Date().toISOString() };
      names.forEach((n, i) => {
        const v = values[i];
        if (/^\$\d+/.test(v)) row[n] = params[Number(v.replace(/\D/g, '')) - 1];
        else if (/^'.*'$/.test(v)) row[n] = v.slice(1, -1);
        else row[n] = v;
      });
      if (table === 'tps_originators') { row.approved_by = null; row.approved_at = null; row.next_review_at = null; }
      if (table === 'tps_odfi_agreements') { row.executed_at = null; }
      if (table === 'tps_obligations') { row.completed_at = null; row.completed_by = null; row.evidence = null; }
      t[table].push(row);
      return { rows: [row] };
    }
    if ((m = /^UPDATE (\w+) SET (.+) WHERE (\w+) = \$1$/.exec(text))) {
      const [, table, set, key] = m;
      t[table].filter(r => r[key] === params[0]).forEach(r => {
        set.split(', ').forEach(pair => {
          const [col, value] = pair.split(' = ');
          if (value === 'NOW()') r[col] = new Date().toISOString();
          else if (/^'.*'$/.test(value)) r[col] = value.slice(1, -1);
          else r[col] = params[Number(value.replace(/\$|::jsonb/g, '')) - 1];
        });
      });
      return { rows: [] };
    }
    if ((m = /^SELECT \* FROM (\w+) WHERE (\w+) = \$1( ORDER BY .+)?( LIMIT \$2)?$/.exec(text))) {
      return { rows: t[m[1]].filter(r => r[m![2]] === params[0]) };
    }
    if (/^SELECT \* FROM tps_originators WHERE is_default = TRUE/.test(text)) return { rows: t.tps_originators.filter(r => r.is_default === true).slice(-1) };
    if (/^SELECT \* FROM tps_obligations WHERE status = \$1/.test(text)) return { rows: t.tps_obligations.filter(r => r.status === params[0]) };
    if (/^SELECT key FROM tps_obligations WHERE status = \$1/.test(text)) return { rows: t.tps_obligations.filter(r => r.status === params[0]) };
    if ((m = /^SELECT \* FROM (\w+) ORDER BY/.exec(text))) return { rows: [...t[m[1]]] };
    if (/^SELECT effective_date, SUM\(amount_cents\)/.test(text)) {
      const by: Record<string, number> = {};
      t.tps_exposure.filter(r => r.originator_id === params[0] && r.effective_date >= params[1]).forEach(r => { by[r.effective_date] = (by[r.effective_date] || 0) + Number(r.amount_cents); });
      return { rows: Object.entries(by).map(([effective_date, total]) => ({ effective_date, total })) };
    }
    if (/^SELECT COALESCE\(SUM\(entry_count\), 0\) AS entries FROM tps_exposure/.test(text)) {
      return { rows: [{ entries: t.tps_exposure.filter(r => r.originator_id === params[0] && r.direction === 'debit').reduce((s, r) => s + Number(r.entry_count), 0) }] };
    }
    if (/^SELECT category, COUNT\(\*\) AS n FROM tps_returns/.test(text)) {
      const by: Record<string, number> = {};
      t.tps_returns.filter(r => r.originator_id === params[0]).forEach(r => { by[r.category] = (by[r.category] || 0) + 1; });
      return { rows: Object.entries(by).map(([category, n]) => ({ category, n })) };
    }
    throw new Error(`unhandled SQL in test store: ${text}`);
  });
  return { t, query };
}

const KYB = { controlPersons: [{ name: 'DeAndre Barkley', role: 'Managing Trustee' }, { name: 'Melissa Robinson', role: 'Co-Trustee' }], beneficialOwners: [{ name: 'DeAndrea Lavar Barkley Irrevocable Trust', pct: 100 }] };

describe('Third-Party Sender OS', () => {
  let s: ReturnType<typeof store>;
  beforeEach(() => {
    s = store();
    vi.spyOn(pool, 'query').mockImplementation(s.query as any);
    vi.spyOn(ComplianceEngine, 'screen').mockResolvedValue({ screening_id: 'SCR-1', status: 'cleared' });
    delete process.env.TPS_OS_ENFORCE;
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.TPS_OS_ENFORCE; });

  async function executedAgreement() {
    const a = await TpsOsEngine.createAgreement({ odfiName: 'Choice Financial Group', odfiRouting: '091311229', transport: 'sftp', secCodes: ['PPD', 'CCD'], dailyLimitCents: 50_000_000, exposureLimitCents: 100_000_000, createdBy: 'ops' });
    return TpsOsEngine.executeAgreement(a.agreementId, { agreementRef: 'ODFI-AGR-2026-01', nachaRegistrationRef: 'NACHA-TPS-REG-77', actor: 'admin' });
  }

  it('an agreement cannot be executed without the signed reference and the Nacha TPS registration', async () => {
    const a = await TpsOsEngine.createAgreement({ odfiName: 'Bank', createdBy: 'ops' });
    expect(a.status).toBe('draft');
    await expect(TpsOsEngine.executeAgreement(a.agreementId, { agreementRef: 'X' })).rejects.toThrow(/nachaRegistrationRef/);
    await expect(TpsOsEngine.executeAgreement(a.agreementId, { nachaRegistrationRef: 'R' })).rejects.toThrow(/agreementRef/);
    const executed = await TpsOsEngine.executeAgreement(a.agreementId, { agreementRef: 'X', nachaRegistrationRef: 'R' });
    expect(executed).toMatchObject({ status: 'executed', tpsRegistered: true });
  });

  it('onboards an Originator through sanctions screening, masks the tax id, and enforces four-eyes + due-diligence on approval', async () => {
    const agreement = await executedAgreement();
    const o = await TpsOsEngine.onboardOriginator({ legalName: 'DB Net Mgmt LLC', entityType: 'llc', taxId: '12-3456789', agreementId: agreement.agreementId, onboardedBy: 'ops', isDefault: true });
    expect(ComplianceEngine.screen).toHaveBeenCalledWith(expect.objectContaining({ businessName: 'DB Net Mgmt LLC', type: 'sanctions' }));
    expect(o).toMatchObject({ status: 'onboarding', sanctionsStatus: 'cleared', sanctionsScreeningId: 'SCR-1', taxIdMasked: '***-**-6789' });

    await expect(TpsOsEngine.approveOriginator(o.originatorId, { approvedBy: 'ops' })).rejects.toThrow(/four-eyes/);
    await expect(TpsOsEngine.approveOriginator(o.originatorId, { approvedBy: 'trustee2' })).rejects.toMatchObject({
      code: 'TPS_APPROVAL_BLOCKED',
      details: { blockers: expect.arrayContaining([expect.stringMatching(/Originator agreement reference/), expect.stringMatching(/risk rating/), expect.stringMatching(/control persons/), expect.stringMatching(/beneficial owners/)]) },
    });

    await TpsOsEngine.updateOriginator(o.originatorId, { originatorAgreementRef: 'ORIG-AGR-1', riskRating: 'low', kyb: KYB, actor: 'ops' });
    const approved = await TpsOsEngine.approveOriginator(o.originatorId, { approvedBy: 'trustee2' });
    expect(approved.status).toBe('approved');
    expect(approved.nextReviewAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // touching the diligence record re-opens approval
    const reopened = await TpsOsEngine.updateOriginator(o.originatorId, { sanctionsStatus: 'review', actor: 'ops' });
    expect(reopened.status).toBe('onboarding');
  });

  it('nested Third-Party Senders must disclose downstream Originators', async () => {
    await expect(TpsOsEngine.onboardOriginator({ legalName: 'Payroll Co', entityType: 'nested_third_party_sender' })).rejects.toMatchObject({ code: 'TPS_NESTED_DISCLOSURE' });
    const ok = await TpsOsEngine.onboardOriginator({ legalName: 'Payroll Co', entityType: 'nested_third_party_sender', nestedDisclosure: { originators: [{ legalName: 'Client A' }] } });
    expect(ok.isNestedTps).toBe(true);
  });

  it('preflight blocks until agreement + approved default Originator exist, then enforces SEC codes, exposure limits and return rates', async () => {
    let pf = await TpsOsEngine.preflight({ secCode: 'CCD', amountCents: 100 });
    expect(pf.allowed).toBe(false);
    expect(pf.blockers).toContain('no default Originator designated');

    const agreement = await executedAgreement();
    const o = await TpsOsEngine.onboardOriginator({ legalName: 'DeAndrea Lavar Barkley Irrevocable Trust', entityType: 'trust', fiduciaryCapacity: 'Originator via PTC as Third-Party Sender', agreementId: agreement.agreementId, originatorAgreementRef: 'ORIG-AGR-1', riskRating: 'low', kyb: KYB, secCodes: ['CCD'], dailyLimitCents: 1_000_000, onboardedBy: 'ops', isDefault: true });
    pf = await TpsOsEngine.preflight({ secCode: 'CCD', amountCents: 100 });
    expect(pf.blockers).toEqual([expect.stringMatching(/is onboarding, not approved/)]);

    await TpsOsEngine.approveOriginator(o.originatorId, { approvedBy: 'trustee2' });
    pf = await TpsOsEngine.preflight({ secCode: 'CCD', amountCents: 100 });
    expect(pf).toMatchObject({ allowed: true, blockers: [], originator: { legalName: 'DeAndrea Lavar Barkley Irrevocable Trust' }, agreement: { odfiName: 'Choice Financial Group', tpsRegistered: true } });

    expect((await TpsOsEngine.preflight({ secCode: 'WEB', amountCents: 100 })).blockers).toEqual(expect.arrayContaining([expect.stringMatching(/SEC code WEB not permitted under ODFI agreement/)]));
    expect((await TpsOsEngine.preflight({ secCode: 'CCD', sameDay: true, amountCents: 100 })).blockers).toContain('Same Day ACH not permitted under ODFI agreement');

    await TpsOsEngine.recordExposure({ originatorId: o.originatorId, batchRef: 'ACH-1', direction: 'credit', secCode: 'CCD', amountCents: 900_000 });
    const snap = await TpsOsEngine.exposureSnapshot(o.originatorId);
    expect(snap).toMatchObject({ todayCents: 900_000, dailyLimitCents: 1_000_000, dailyRemainingCents: 100_000 });
    expect((await TpsOsEngine.preflight({ secCode: 'CCD', amountCents: 100_001 })).blockers).toEqual([expect.stringMatching(/daily limit 1000000 exceeded \(projected 1000001\)/)]);
    expect((await TpsOsEngine.preflight({ secCode: 'CCD', amountCents: 100_000 })).allowed).toBe(true);

    // return rates: 100 debit entries, 1 unauthorized return = 100 bps > 50 bps threshold
    await TpsOsEngine.recordExposure({ originatorId: o.originatorId, direction: 'debit', amountCents: 0, entryCount: 100, effectiveDate: '2020-01-01' });
    await TpsOsEngine.recordReturn({ originatorId: o.originatorId, returnCode: 'R10' });
    const rates = await TpsOsEngine.returnRates(o.originatorId);
    expect(rates.rates.unauthorized).toMatchObject({ count: 1, bps: 100, thresholdBps: RETURN_THRESHOLDS_BPS.unauthorized });
    expect(rates.breaches).toEqual(['unauthorized']);
    expect((await TpsOsEngine.preflight({ secCode: 'CCD', amountCents: 1 })).blockers).toEqual([expect.stringMatching(/return-rate threshold breached: unauthorized/)]);
  });

  it('seeds the Nacha compliance calendar, flags overdue mandatory items in preflight, and rolls completed items forward', async () => {
    const obligations = await TpsOsEngine.seedObligations({ owner: 'Managing Trustee', actor: 'admin' });
    expect(obligations.map((o: any) => o.key).sort()).toEqual(DEFAULT_OBLIGATIONS.map((d: any) => d.key).sort());
    expect(obligations.find((o: any) => o.key === 'rules_compliance_audit').ruleRef).toBe('Nacha Art. 1 §1.2.2');
    // idempotent
    expect((await TpsOsEngine.seedObligations()).length).toBe(DEFAULT_OBLIGATIONS.length);

    const audit = s.t.tps_obligations.find(r => r.key === 'rules_compliance_audit')!;
    audit.due_at = '2000-12-31';
    const pf = await TpsOsEngine.preflight({ secCode: 'CCD', amountCents: 1 });
    expect(pf.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/overdue mandatory obligation: Annual ACH Rules Compliance Audit/)]));

    const done = await TpsOsEngine.completeObligation(audit.obligation_id, { completedBy: 'auditor', evidence: { report: 'audit-2026.pdf' } });
    expect(done.next).toBeTruthy();
    const next = s.t.tps_obligations.find(r => r.obligation_id === done.next)!;
    expect(next).toMatchObject({ key: 'rules_compliance_audit', status: 'open', due_at: '2001-12-31' });
    expect(audit.status).toBe('completed');
    const openAudits = (await TpsOsEngine.obligations({ status: 'open' })).filter((o: any) => o.key === 'rules_compliance_audit');
    expect(openAudits.map((o: any) => o.obligationId)).toEqual([done.next]);
  });

  it('gateTransmission is advisory by default and refuses only when TPS_OS_ENFORCE=true', async () => {
    const batch = { batch_id: 'ACH-9', sec_code: 'CCD', total_amount_cents: 500, entry_count: 1 };
    const advisory = await TpsOsEngine.gateTransmission(batch, { actor: 'ops' });
    expect(advisory).toMatchObject({ allowed: false, enforced: false });
    process.env.TPS_OS_ENFORCE = 'true';
    await expect(TpsOsEngine.gateTransmission(batch, { actor: 'ops' })).rejects.toMatchObject({ code: 'TPS_PREFLIGHT_BLOCKED', details: { blockers: ['no default Originator designated'] } });
    expect(s.t.tps_events.filter(e => e.event_type === 'preflight_blocked')).toHaveLength(2);
  });

  it('status reports readiness blockers for the PTC-as-TPS setup', async () => {
    const st = await TpsOsEngine.status();
    expect(st.readiness.ready).toBe(false);
    expect(st.readiness.blockers).toEqual(expect.arrayContaining(['no executed ODFI origination agreement', 'no approved Originator', 'compliance calendar not seeded']));
    expect(st.role.thirdPartySender).toMatch(/Private Trust Company/);
  });

  it('helpers: return categories and next due dates', () => {
    expect(returnCategory('R10')).toBe('unauthorized');
    expect(returnCategory('r02')).toBe('administrative');
    expect(returnCategory('R01')).toBe('overall');
    expect(nextDue('12-31', new Date('2026-09-04T00:00:00Z'))).toBe('2026-12-31');
    expect(nextDue('01-31', new Date('2026-09-04T00:00:00Z'))).toBe('2027-01-31');
  });
});

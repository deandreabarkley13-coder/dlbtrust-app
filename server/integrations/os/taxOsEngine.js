'use strict';

/**
 * Tax OS — Form 1041 and Schedule K-1 *reports* for the trust, with exports.
 *
 * The arithmetic lives in ../tax/taxEngine (computeForm1041, generateK1s);
 * this engine turns a stored return and its K-1 schedules into reviewable
 * report documents and exports them as JSON, CSV or PDF, adding the two views
 * the trust's structure demands and the 1041 alone does not show:
 *
 *   • principal (corpus, GL 3000 / Fineract principal account) vs. interest
 *     income (GL 4000 / Fineract interest-income account, fed by coupons),
 *     because the trust agreement supports income only — corpus is never sold
 *     or distributed;
 *   • per-beneficiary distribution allocation on the K-1 (allocation %,
 *     income items, distributions paid).
 *
 * Reports only: TAX_OS_FILING_MODE is fixed to `reports_only`. Nothing here
 * transmits to the IRS or a state, and nothing moves money. Every export is
 * hashed and recorded in tax_report_exports so a filed copy can be tied back
 * to the exact numbers the trustees reviewed.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { TaxEngine } = require('../tax/taxEngine');
const { buildTextPdf } = require('../tax/taxReportPdf');
const { EgressOsEngine } = require('./egressOsEngine');
const { getAccessToken, googleFetch, loadServiceAccount, onGoogleRuntime } = require('../google/googleServiceAccount');

const FILING_MODE = 'reports_only';
const REPORT_TYPES = ['form_1041', 'schedule_k1', 'principal_income', 'package'];
const FORMATS = ['json', 'csv', 'pdf'];
const GCS_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const GCS_UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b';

const GL = { principal: '3000', interestIncome: '4000', couponIncome: '4100', distributionsPayable: '2000' };

class TaxOsError extends Error {
  constructor(message, code = 'TAX_OS_ERROR', status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isTrue(v, dflt = false) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  return s === 'true' || s === '1' || s === 'yes';
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function money(v) { return num(v).toFixed(2); }
function newId(prefix) { return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }

function getTaxOsConfig(env = process.env) {
  return {
    enabled: isTrue(env.TAX_OS_ENABLED, true),
    live: isTrue(env.TAX_OS_LIVE),
    filingMode: FILING_MODE,
    exportBucket: String(env.TAX_OS_EXPORT_BUCKET || '').trim() || null,
    exportPrefix: String(env.TAX_OS_EXPORT_PREFIX || 'tax/exports').replace(/\/+$/, ''),
    declaredState: String(env.TAX_OS_DECLARED_STATE || 'OH').trim().toUpperCase(),
    formats: FORMATS,
    reportTypes: REPORT_TYPES,
  };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function kv(obj) {
  return Object.entries(obj).map(([line_item, value]) => ({ line_item, value }));
}

// ─── Report builders ─────────────────────────────────────────────────────────

const TaxOsEngine = {
  Error: TaxOsError,
  getConfig: getTaxOsConfig,
  toCsv,
  FILING_MODE,
  REPORT_TYPES,
  FORMATS,

  async ensureTables() {
    if (!pool) return;
    await TaxEngine.ensureTables();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tax_report_exports (
        export_id     VARCHAR(64) PRIMARY KEY,
        report_type   VARCHAR(32) NOT NULL,
        format        VARCHAR(8) NOT NULL,
        tax_year      INTEGER,
        return_id     TEXT,
        k1_id         TEXT,
        filename      TEXT NOT NULL,
        byte_size     BIGINT NOT NULL,
        sha256        CHAR(64) NOT NULL,
        storage_uri   TEXT,
        actor         VARCHAR(128),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tax_report_exports_year ON tax_report_exports(tax_year, created_at DESC)');
  },

  async _latestReturn(taxYear) {
    const rows = await TaxEngine.listReturns({ taxYear });
    return rows[0] || null;
  },

  async _resolveReturn({ returnId = null, taxYear = null } = {}) {
    if (returnId) {
      const r = await TaxEngine.getReturn(returnId);
      if (!r) throw new TaxOsError(`return ${returnId} not found`, 'TAX_OS_NOT_FOUND', 404);
      return r;
    }
    if (!taxYear) throw new TaxOsError('returnId or taxYear is required', 'TAX_OS_BAD_REQUEST', 400);
    const latest = await this._latestReturn(Number(taxYear));
    if (!latest) throw new TaxOsError(`no computed Form 1041 for ${taxYear}; run action=compute first`, 'TAX_OS_NOT_FOUND', 404);
    return TaxEngine.getReturn(latest.return_id);
  },

  /**
   * Principal vs. interest-income view for a tax year from the posted trust
   * journal (GL 3000 corpus, 4000/4100 interest & coupon income, 2000
   * distributions payable) and the Fineract account structure.
   */
  async principalIncomeReport(taxYear) {
    const year = Number(taxYear);
    if (!year) throw new TaxOsError('taxYear is required', 'TAX_OS_BAD_REQUEST', 400);
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    const q = await pool.query(`
      SELECT jl.account_code,
             COALESCE(SUM(jl.debit_amount), 0)  AS debits,
             COALESCE(SUM(jl.credit_amount), 0) AS credits
      FROM trust_journal_lines jl
      JOIN trust_journal_entries je ON je.entry_id = jl.entry_id
      WHERE je.status = 'posted' AND je.entry_date >= $1 AND je.entry_date <= $2
        AND jl.account_code IN ($3, $4, $5, $6)
      GROUP BY jl.account_code`, [start, end, GL.principal, GL.interestIncome, GL.couponIncome, GL.distributionsPayable]);
    const by = Object.fromEntries(q.rows.map((r) => [r.account_code, { debits: num(r.debits), credits: num(r.credits) }]));
    const g = (code) => by[code] || { debits: 0, credits: 0 };

    const coupons = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS n FROM coupon_payments WHERE status = 'paid' AND coupon_date >= $1 AND coupon_date <= $2`,
      [start, end]
    ).catch(() => ({ rows: [{ total: 0, n: 0 }] }));

    const fineract = await pool.query(
      `SELECT role, party_name, gl_code, fineract_account_no, status FROM fineract_trust_accounts ORDER BY role, party_name`
    ).catch(() => ({ rows: [] }));

    const principalCredits = g(GL.principal).credits;
    const principalDebits = g(GL.principal).debits;
    const interestIncome = num(g(GL.interestIncome).credits - g(GL.interestIncome).debits + g(GL.couponIncome).credits - g(GL.couponIncome).debits);
    const distributionsDeclared = g(GL.distributionsPayable).credits;
    const distributionsPaid = g(GL.distributionsPayable).debits;

    return {
      report_type: 'principal_income',
      tax_year: year,
      period: { start, end },
      principal: {
        gl_code: GL.principal,
        additions_to_corpus: principalCredits,
        reductions_of_corpus: principalDebits,
        net_change: num(principalCredits - principalDebits),
        asset_sales: 0,
        note: 'Corpus is held for income support only; no asset sales under the trust agreement.',
      },
      income: {
        gl_codes: [GL.interestIncome, GL.couponIncome],
        interest_and_coupon_income: interestIncome,
        coupon_receipts_paid: num(coupons.rows[0].total),
        coupon_receipt_count: coupons.rows[0].n,
      },
      distributions: {
        gl_code: GL.distributionsPayable,
        declared: distributionsDeclared,
        paid: distributionsPaid,
        payable_at_year_end: num(distributionsDeclared - distributionsPaid),
        distributed_from: 'income',
      },
      fineract_accounts: fineract.rows.map((r) => ({ role: r.role, party: r.party_name || null, gl_code: r.gl_code, account_no: r.fineract_account_no, status: r.status })),
    };
  },

  async form1041Report({ returnId = null, taxYear = null } = {}) {
    const ret = await this._resolveReturn({ returnId, taxYear });
    const config = await TaxEngine.getAllConfig();
    const pi = await this.principalIncomeReport(ret.tax_year);
    const payments = await TaxEngine.listPayments(ret.tax_year);
    const lines = {
      '1 Interest income': num(ret.interest_income),
      '2a Total ordinary dividends': num(ret.dividend_income),
      '4 Capital gain or (loss)': num(ret.capital_gains),
      '5 Rents, royalties, partnerships': num(ret.rental_income),
      '8 Other income': num(ret.other_income),
      '9 Total income': num(ret.total_income),
      '12 Fiduciary fees': num(ret.trustee_fees),
      '14 Attorney, accountant, and return preparer fees': num(ret.legal_fees + ret.tax_prep_fees),
      '15a Other deductions': num(ret.other_deductions),
      '16 Total deductions': num(ret.total_deductions),
      '17 Adjusted total income': num(ret.adjusted_total_income),
      '18 Income distribution deduction (Schedule B)': num(ret.income_distribution_deduction),
      '20 Exemption': num(ret.personal_exemption),
      '22 Taxable income': num(ret.taxable_income),
      '23 Total tax': num(ret.tax_liability),
      '25 Total payments': num(ret.estimated_payments),
      '27 Tax due / (28 overpayment)': num(ret.tax_due),
      'Schedule B line 7 Distributable net income': num(ret.distributable_net_income),
    };
    return {
      report_type: 'form_1041',
      filing_mode: FILING_MODE,
      return_id: ret.return_id,
      status: ret.status,
      tax_year: ret.tax_year,
      computed_at: ret.computed_at,
      entity: {
        trust_name: ret.trust_name || config.config.trust_name,
        ein: ret.ein || config.config.ein,
        trust_type: config.config.trust_type || 'complex',
        fiscal_year_end: config.config.fiscal_year_end || '12-31',
        state: config.config.state || null,
      },
      lines,
      principal_vs_income: pi,
      k1_count: Array.isArray(ret.k1s) ? ret.k1s.length : 0,
      beneficiaries: (ret.k1s || []).map((k) => ({ k1_id: k.k1_id, beneficiary: k.beneficiary_name, allocation_percentage: num(k.allocation_percentage), total_income: num(k.total_income), distributions_paid: num(k.distributions_paid) })),
      payments: payments.map((p) => ({ payment_id: p.payment_id, quarter: p.quarter, type: p.payment_type, amount: num(p.amount), date: p.payment_date, reference: p.reference })),
      notes: ret.notes || null,
    };
  },

  async k1Report({ returnId = null, taxYear = null, k1Id = null } = {}) {
    let k1s;
    let ret;
    if (k1Id) {
      const one = await TaxEngine.getK1(k1Id);
      if (!one) throw new TaxOsError(`K-1 ${k1Id} not found`, 'TAX_OS_NOT_FOUND', 404);
      ret = await TaxEngine.getReturn(one.return_id);
      k1s = [one];
    } else {
      ret = await this._resolveReturn({ returnId, taxYear });
      k1s = await TaxEngine.getK1sForReturn(ret.return_id);
    }
    const config = await TaxEngine.getAllConfig();
    return {
      report_type: 'schedule_k1',
      filing_mode: FILING_MODE,
      return_id: ret.return_id,
      tax_year: ret.tax_year,
      entity: { trust_name: ret.trust_name || config.config.trust_name, ein: ret.ein || config.config.ein, trust_type: config.config.trust_type || 'complex' },
      distributable_net_income: num(ret.distributable_net_income),
      income_distribution_deduction: num(ret.income_distribution_deduction),
      schedules: k1s.map((k) => ({
        k1_id: k.k1_id,
        status: k.status,
        beneficiary: { contact_id: k.beneficiary_contact_id, name: k.beneficiary_name, tin_last4: k.beneficiary_tin_last4 || null, mailing_address: k.mailing_address || null },
        allocation_percentage: num(k.allocation_percentage),
        part_iii: {
          '1 Interest income': num(k.interest_income),
          '2a Ordinary dividends': num(k.dividend_income),
          '4a Net long-term capital gain': num(k.capital_gains),
          '5 Other portfolio and nonbusiness income': num(k.rental_income + k.other_income),
          '9 Directly apportioned deductions': num(k.deductions),
          'Total income': num(k.total_income),
        },
        distributions_paid: num(k.distributions_paid),
        distributed_from: 'income (no corpus distributions)',
        issued_at: k.issued_at || null,
      })),
    };
  },

  async packageReport(args) {
    const form1041 = await this.form1041Report(args);
    const k1 = await this.k1Report({ returnId: form1041.return_id });
    return { report_type: 'package', filing_mode: FILING_MODE, tax_year: form1041.tax_year, return_id: form1041.return_id, form_1041: form1041, schedule_k1: k1, generated_at: new Date().toISOString() };
  },

  async report({ reportType, ...args }) {
    switch (reportType) {
      case 'form_1041': return this.form1041Report(args);
      case 'schedule_k1': return this.k1Report(args);
      case 'principal_income': return this.principalIncomeReport(args.taxYear);
      case 'package': return this.packageReport(args);
      default: throw new TaxOsError(`reportType must be one of ${REPORT_TYPES.join(', ')}`, 'TAX_OS_BAD_REQUEST', 400);
    }
  },

  // ─── Renderers ──────────────────────────────────────────────────────────────

  _csv(report) {
    switch (report.report_type) {
      case 'form_1041':
        return toCsv([
          ...kv({ trust_name: report.entity.trust_name, ein: report.entity.ein, tax_year: report.tax_year, return_id: report.return_id, filing_mode: report.filing_mode }),
          ...kv(report.lines),
          ...kv({ 'principal: net change in corpus': report.principal_vs_income.principal.net_change, 'income: interest and coupon income': report.principal_vs_income.income.interest_and_coupon_income, 'distributions paid from income': report.principal_vs_income.distributions.paid }),
        ], ['line_item', 'value']);
      case 'schedule_k1':
        return toCsv(report.schedules.map((s) => ({
          tax_year: report.tax_year, return_id: report.return_id, k1_id: s.k1_id, beneficiary: s.beneficiary.name, tin_last4: s.beneficiary.tin_last4,
          allocation_percentage: s.allocation_percentage, interest_income: s.part_iii['1 Interest income'], ordinary_dividends: s.part_iii['2a Ordinary dividends'],
          capital_gain: s.part_iii['4a Net long-term capital gain'], other_income: s.part_iii['5 Other portfolio and nonbusiness income'],
          deductions: s.part_iii['9 Directly apportioned deductions'], total_income: s.part_iii['Total income'], distributions_paid: s.distributions_paid, status: s.status,
        })));
      case 'principal_income':
        return toCsv([
          ...kv({ tax_year: report.tax_year }),
          ...kv(Object.fromEntries(Object.entries(report.principal).filter(([, v]) => typeof v === 'number').map(([k, v]) => [`principal.${k}`, v]))),
          ...kv(Object.fromEntries(Object.entries(report.income).filter(([, v]) => typeof v === 'number').map(([k, v]) => [`income.${k}`, v]))),
          ...kv(Object.fromEntries(Object.entries(report.distributions).filter(([, v]) => typeof v === 'number').map(([k, v]) => [`distributions.${k}`, v]))),
        ], ['line_item', 'value']);
      case 'package':
        return `${this._csv(report.form_1041)}\r\n${this._csv(report.schedule_k1)}`;
      default: throw new TaxOsError('unrenderable report', 'TAX_OS_BAD_REQUEST', 400);
    }
  },

  _pdfLines(report) {
    const L = [];
    const h = (t) => L.push({ text: t, font: 'F2', size: 14, gap: 4 });
    const p = (t) => L.push({ text: t, size: 10 });
    const f = (k, v) => L.push({ field: k, value: v });
    const disclaimer = () => p('Report generated by the trust platform for trustee review. It is not a filed return and was not transmitted to any tax authority.');
    if (report.report_type === 'form_1041') {
      L.push({ text: `Form 1041 Report - Tax Year ${report.tax_year}`, font: 'F2', size: 18, gap: 6 });
      f('Trust', report.entity.trust_name); f('EIN', report.entity.ein); f('Trust type', report.entity.trust_type); f('Return', `${report.return_id} (${report.status})`);
      L.push({ rule: true });
      h('Income, deductions and tax');
      for (const [k, v] of Object.entries(report.lines)) f(k, money(v));
      L.push({ rule: true });
      h('Principal vs. income');
      const pi = report.principal_vs_income;
      f('Additions to corpus (GL 3000)', money(pi.principal.additions_to_corpus));
      f('Reductions of corpus', money(pi.principal.reductions_of_corpus));
      f('Asset sales', money(0));
      f('Interest and coupon income (GL 4000/4100)', money(pi.income.interest_and_coupon_income));
      f('Distributions declared / paid (GL 2000)', `${money(pi.distributions.declared)} / ${money(pi.distributions.paid)}`);
      p(pi.principal.note);
      L.push({ rule: true });
      h('Beneficiary allocations');
      for (const b of report.beneficiaries) f(`${b.beneficiary} (${b.allocation_percentage}%)`, `income ${money(b.total_income)}, distributions ${money(b.distributions_paid)}`);
      if (!report.beneficiaries.length) p('No K-1 schedules generated for this return.');
      L.push({ rule: true });
      disclaimer();
    } else if (report.report_type === 'schedule_k1') {
      L.push({ text: `Schedule K-1 (Form 1041) Report - Tax Year ${report.tax_year}`, font: 'F2', size: 18, gap: 6 });
      f('Trust', report.entity.trust_name); f('EIN', report.entity.ein); f('Return', report.return_id); f('Distributable net income', money(report.distributable_net_income));
      for (const s of report.schedules) {
        L.push({ rule: true });
        h(`Beneficiary: ${s.beneficiary.name}`);
        f('K-1', `${s.k1_id} (${s.status})`); f('TIN (last 4)', s.beneficiary.tin_last4 || 'n/a'); f('Allocation', `${s.allocation_percentage}%`);
        for (const [k, v] of Object.entries(s.part_iii)) f(k, money(v));
        f('Distributions paid', money(s.distributions_paid)); f('Distributed from', s.distributed_from);
      }
      L.push({ rule: true });
      disclaimer();
    } else if (report.report_type === 'principal_income') {
      L.push({ text: `Principal vs. Income Report - ${report.tax_year}`, font: 'F2', size: 18, gap: 6 });
      for (const [k, v] of Object.entries(report.principal)) if (typeof v === 'number') f(`Principal: ${k}`, money(v));
      for (const [k, v] of Object.entries(report.income)) if (typeof v === 'number') f(`Income: ${k}`, k.endsWith('count') ? String(v) : money(v));
      for (const [k, v] of Object.entries(report.distributions)) if (typeof v === 'number') f(`Distributions: ${k}`, money(v));
      L.push({ rule: true });
      h('Fineract accounts');
      for (const a of report.fineract_accounts) f(`${a.role}${a.party ? ` - ${a.party}` : ''}`, `#${a.account_no || '?'} GL ${a.gl_code || '-'} ${a.status || ''}`);
      L.push({ rule: true });
      p(report.principal.note);
    } else if (report.report_type === 'package') {
      return [...this._pdfLines(report.form_1041), { rule: true }, ...this._pdfLines(report.schedule_k1)];
    }
    return L;
  },

  render(report, format) {
    if (!FORMATS.includes(format)) throw new TaxOsError(`format must be one of ${FORMATS.join(', ')}`, 'TAX_OS_BAD_REQUEST', 400);
    const base = `${report.report_type}-${report.tax_year}${report.return_id ? `-${report.return_id}` : ''}`;
    if (format === 'json') return { filename: `${base}.json`, mimeType: 'application/json', body: Buffer.from(JSON.stringify(report, null, 2), 'utf8') };
    if (format === 'csv') return { filename: `${base}.csv`, mimeType: 'text/csv', body: Buffer.from(this._csv(report), 'utf8') };
    return { filename: `${base}.pdf`, mimeType: 'application/pdf', body: buildTextPdf(this._pdfLines(report), { title: `${report.report_type} ${report.tax_year}` }) };
  },

  // ─── Export ─────────────────────────────────────────────────────────────────

  storage(cfg = getTaxOsConfig()) {
    if (!cfg.exportBucket) return { enabled: false, bucket: null, ready: false, reason: 'TAX_OS_EXPORT_BUCKET not set (exports download only)' };
    let sa = null;
    let error = null;
    try { sa = loadServiceAccount({ keyEnv: 'TAX_OS_SERVICE_ACCOUNT_KEY' }); } catch (e) { error = e.message; }
    const credentialed = Boolean(sa) || onGoogleRuntime();
    return { enabled: true, bucket: cfg.exportBucket, prefix: cfg.exportPrefix, credential: sa ? sa.source : (onGoogleRuntime() ? 'runtime_identity' : null), ready: credentialed && !error, reason: error || (credentialed ? null : 'not running on Cloud Run and no TAX_OS_SERVICE_ACCOUNT_KEY') };
  },

  async _archive(filename, body, mimeType, cfg) {
    const store = this.storage(cfg);
    if (!store.enabled || !store.ready) return null;
    const objectName = `${store.prefix}/${filename}`;
    const url = `${GCS_UPLOAD}/${encodeURIComponent(store.bucket)}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    await EgressOsEngine.authorize(url, { caller: 'tax-os', record: false });
    let sa = null;
    try { sa = loadServiceAccount({ keyEnv: 'TAX_OS_SERVICE_ACCOUNT_KEY' }); } catch { sa = null; }
    const token = await getAccessToken(sa, GCS_SCOPE);
    const res = await googleFetch('POST', url, token, body, { headers: { 'Content-Type': mimeType } });
    if (!res.ok) throw new TaxOsError(`export archive upload failed: HTTP ${res.statusCode}`, 'TAX_OS_STORE', 502);
    return `gs://${store.bucket}/${objectName}`;
  },

  /**
   * Build + render + record an export. Returns the file (Buffer) and its record;
   * the route streams the body, `process` returns it base64-encoded.
   */
  async exportReport({ reportType, format = 'json', returnId = null, taxYear = null, k1Id = null, actor = null, archive = true } = {}) {
    const cfg = getTaxOsConfig();
    if (!cfg.enabled) throw new TaxOsError('TAX_OS_ENABLED=false', 'TAX_OS_DISABLED', 503);
    const report = await this.report({ reportType, returnId, taxYear, k1Id });
    const file = this.render(report, format);
    const sha256 = crypto.createHash('sha256').update(file.body).digest('hex');
    const exportId = newId('TAXX');
    const stamped = `${exportId}-${file.filename}`;
    const storageUri = archive ? await this._archive(stamped, file.body, file.mimeType, cfg) : null;
    if (pool) {
      await pool.query(
        `INSERT INTO tax_report_exports (export_id, report_type, format, tax_year, return_id, k1_id, filename, byte_size, sha256, storage_uri, actor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [exportId, reportType, format, report.tax_year || null, report.return_id || null, k1Id, stamped, file.body.length, sha256, storageUri, actor]
      );
    }
    return { exportId, reportType, format, taxYear: report.tax_year, returnId: report.return_id || null, filename: stamped, mimeType: file.mimeType, byteSize: file.body.length, sha256, storageUri, body: file.body, report };
  },

  // ─── Status / readiness ─────────────────────────────────────────────────────

  async status() {
    const cfg = getTaxOsConfig();
    const config = await TaxEngine.getAllConfig().catch(() => ({ config: {} }));
    const returns = await TaxEngine.listReturns().catch(() => []);
    const exportsQ = pool ? await pool.query('SELECT report_type, format, COUNT(*)::int AS n FROM tax_report_exports GROUP BY report_type, format').catch(() => ({ rows: [] })) : { rows: [] };
    const bens = pool ? await pool.query(`SELECT COUNT(*)::int AS n FROM crm_contacts WHERE contact_type = 'beneficiary' AND status = 'active'`).catch(() => ({ rows: [{ n: 0 }] })) : { rows: [{ n: 0 }] };
    const fa = pool ? await pool.query(`SELECT role, COUNT(*)::int AS n FROM fineract_trust_accounts WHERE status IN ('active','Active') GROUP BY role`).catch(() => ({ rows: [] })) : { rows: [] };
    const roles = Object.fromEntries(fa.rows.map((r) => [r.role, r.n]));
    return {
      engine: 'tax-os',
      enabled: cfg.enabled,
      live: cfg.live,
      filingMode: cfg.filingMode,
      efile: 'not offered (reports and exports only)',
      formats: FORMATS,
      reportTypes: REPORT_TYPES,
      entity: { trustName: config.config.trust_name || null, einConfigured: Boolean(config.config.ein), trustType: config.config.trust_type || null, fiscalYearEnd: config.config.fiscal_year_end || null, state: config.config.state || null, declaredState: cfg.declaredState },
      returns: returns.map((r) => ({ returnId: r.return_id, taxYear: r.tax_year, status: r.status, computedAt: r.computed_at })),
      beneficiaries: bens.rows[0].n,
      fineractAccounts: { principal: roles.principal || 0, interestIncome: roles['interest-income'] || 0, trustee: roles.trustee || 0, beneficiary: roles.beneficiary || 0 },
      exports: exportsQ.rows,
      storage: this.storage(cfg),
      movesMoney: false,
    };
  },

  async health() {
    const s = await this.status();
    return { ok: s.enabled, engine: 'tax-os', filingMode: s.filingMode, returns: s.returns.length };
  },

  async readiness() {
    const s = await this.status();
    const blockers = [];
    if (!s.enabled) blockers.push('TAX_OS_ENABLED=false');
    if (!s.entity.einConfigured) blockers.push('trust_config.ein not set (PUT /api/tax/config/ein)');
    if (!s.entity.trustName) blockers.push('trust_config.trust_name not set');
    if (s.entity.state && s.entity.state !== s.entity.declaredState) blockers.push(`trust_config.state=${s.entity.state} but TAX_OS_DECLARED_STATE=${s.entity.declaredState} (PUT /api/tax/config/state)`);
    if (!s.beneficiaries) blockers.push('no active beneficiary contacts: K-1 schedules cannot be allocated');
    if (!s.fineractAccounts.principal) blockers.push('Fineract principal account not provisioned (principal vs income view incomplete)');
    if (!s.fineractAccounts.interestIncome) blockers.push('Fineract interest-income account not provisioned');
    if (!s.live) blockers.push('TAX_OS_LIVE not true');
    const live = blockers.length === 0;
    return { ready: live, mode: live ? 'live' : 'shadow', blockers, status: s };
  },

  async list({ limit = 50 } = {}) {
    if (!pool) return [];
    const r = await pool.query('SELECT * FROM tax_report_exports ORDER BY created_at DESC LIMIT $1', [Math.min(500, Math.max(1, Number(limit) || 50))]);
    return r.rows;
  },

  async get(exportId) {
    if (!pool) return null;
    const r = await pool.query('SELECT * FROM tax_report_exports WHERE export_id = $1', [exportId]);
    return r.rows[0] || null;
  },

  async process({ action, actor = null, ...body } = {}) {
    switch (action) {
      case 'compute': {
        if (!body.taxYear) throw new TaxOsError('taxYear is required', 'TAX_OS_BAD_REQUEST', 400);
        return TaxEngine.computeForm1041(Number(body.taxYear));
      }
      case 'generate-k1': {
        const ret = await this._resolveReturn(body);
        return TaxEngine.generateK1s(ret.return_id);
      }
      case 'report': return this.report(body);
      case 'export': {
        const x = await this.exportReport({ ...body, actor });
        const { body: buf, report: _report, ...meta } = x;
        return { ...meta, contentBase64: buf.toString('base64') };
      }
      default: throw new TaxOsError(`Unknown action: ${action}`, 'TAX_OS_BAD_ACTION', 400);
    }
  },
};

module.exports = { TaxOsEngine, TaxOsError, getTaxOsConfig, toCsv, FILING_MODE, REPORT_TYPES, FORMATS };

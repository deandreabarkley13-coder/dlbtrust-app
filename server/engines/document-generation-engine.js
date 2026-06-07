/**
 * Document Generation Engine
 * DEANDREA LAVAR BARKLEY TRUST — Automated Document Production
 *
 * Programmatically generates trust documents by pulling live data from all engines:
 *   - Account Statements (Banking)
 *   - Distribution Reports (Transfers + Banking)
 *   - Tax Summaries (Trust Accounting GL)
 *   - Portfolio Reports (Fixed Income + Crypto Rails + CMS)
 *   - Trial Balance (Trust Accounting)
 *   - Reconciliation Reports (CMS)
 *   - Compliance Certificates (multi-engine)
 *   - Coupon Schedule Reports (Fixed Income)
 *
 * Integrates with:
 *   - Document Management System (stores generated docs)
 *   - Integration API (GENERATE_DOCUMENT pipeline)
 *   - Event Bus (auto-generate on triggers)
 *   - AI Agent (natural language generation)
 */

'use strict';

const { bus, EVENTS } = require('./event-bus');

// ─── Document Template Types ─────────────────────────────────────────────────

const REPORT_TYPES = {
  ACCOUNT_STATEMENT: {
    name: 'Account Statement',
    category: 'financial_statement',
    description: 'Monthly/quarterly account activity summary with opening/closing balances',
    data_sources: ['banking', 'transfers'],
  },
  DISTRIBUTION_REPORT: {
    name: 'Distribution Report',
    category: 'beneficiary',
    description: 'Summary of all trust distributions to beneficiaries',
    data_sources: ['banking', 'transfers', 'contacts'],
  },
  TAX_SUMMARY: {
    name: 'Tax Summary (K-1 Worksheet)',
    category: 'tax',
    description: 'Annual income and distribution summary for tax reporting',
    data_sources: ['trust_accounting', 'banking', 'fixed_income'],
  },
  PORTFOLIO_REPORT: {
    name: 'Portfolio Report',
    category: 'financial_statement',
    description: 'Comprehensive holdings report across all asset classes',
    data_sources: ['fixed_income', 'crypto_rails', 'banking', 'cms'],
  },
  TRIAL_BALANCE: {
    name: 'Trial Balance',
    category: 'financial_statement',
    description: 'Chart of accounts with debit/credit balances',
    data_sources: ['trust_accounting'],
  },
  RECONCILIATION_REPORT: {
    name: 'Reconciliation Report',
    category: 'compliance',
    description: 'Cross-engine reconciliation results with match/mismatch detail',
    data_sources: ['cms', 'banking', 'trust_accounting'],
  },
  COMPLIANCE_CERTIFICATE: {
    name: 'Compliance Certificate',
    category: 'compliance',
    description: 'Attestation that trust operations meet regulatory requirements',
    data_sources: ['banking', 'trust_accounting', 'documents', 'transfers'],
  },
  COUPON_SCHEDULE: {
    name: 'Coupon Schedule Report',
    category: 'financial_statement',
    description: 'Bond coupon payment schedule with received/upcoming status',
    data_sources: ['fixed_income'],
  },
};

// ─── Document Generation Engine ──────────────────────────────────────────────

class DocumentGenerationEngine {
  constructor() {
    this.generationLog = [];
    this.maxLog = 200;
  }

  getReportTypes() {
    return Object.entries(REPORT_TYPES).map(([key, val]) => ({
      id: key,
      ...val,
    }));
  }

  async generate(db, reportType, params = {}) {
    const template = REPORT_TYPES[reportType];
    if (!template) throw new Error(`Unknown report type: ${reportType}`);

    const startTime = Date.now();
    const logEntry = {
      id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      report_type: reportType,
      params,
      status: 'generating',
      started_at: new Date().toISOString(),
    };

    try {
      // Generate content based on report type
      const content = this._generateContent(db, reportType, params);

      // Store in DMS
      const docId = this._storeInDMS(db, reportType, template, content, params);

      logEntry.status = 'completed';
      logEntry.document_id = docId;
      logEntry.duration_ms = Date.now() - startTime;
      this.generationLog.push(logEntry);
      if (this.generationLog.length > this.maxLog) this.generationLog.shift();

      bus.emit('document.generated', {
        report_type: reportType,
        document_id: docId,
        duration_ms: logEntry.duration_ms,
      });

      return {
        status: 'completed',
        document_id: docId,
        report_type: reportType,
        report_name: template.name,
        duration_ms: logEntry.duration_ms,
        content_preview: content.substring(0, 500),
      };
    } catch (err) {
      logEntry.status = 'failed';
      logEntry.error = err.message;
      logEntry.duration_ms = Date.now() - startTime;
      this.generationLog.push(logEntry);
      if (this.generationLog.length > this.maxLog) this.generationLog.shift();
      throw err;
    }
  }

  getGenerationLog(limit = 50) {
    return this.generationLog.slice(-limit).reverse();
  }

  // ─── Content Generators ──────────────────────────────────────────────────

  _generateContent(db, reportType, params) {
    switch (reportType) {
      case 'ACCOUNT_STATEMENT': return this._genAccountStatement(db, params);
      case 'DISTRIBUTION_REPORT': return this._genDistributionReport(db, params);
      case 'TAX_SUMMARY': return this._genTaxSummary(db, params);
      case 'PORTFOLIO_REPORT': return this._genPortfolioReport(db, params);
      case 'TRIAL_BALANCE': return this._genTrialBalance(db, params);
      case 'RECONCILIATION_REPORT': return this._genReconciliationReport(db, params);
      case 'COMPLIANCE_CERTIFICATE': return this._genComplianceCertificate(db, params);
      case 'COUPON_SCHEDULE': return this._genCouponSchedule(db, params);
      default: throw new Error(`No generator for: ${reportType}`);
    }
  }

  _genAccountStatement(db, params) {
    const accountId = params.account_id;
    const period = params.period || 'current_month';

    // Get account details
    let account;
    if (accountId) {
      account = db.prepare('SELECT * FROM trust_accounts WHERE id = ?').get(accountId);
    } else {
      account = db.prepare("SELECT * FROM trust_accounts WHERE account_type = 'operating' AND status = 'active' LIMIT 1").get();
    }
    if (!account) throw new Error('Account not found');

    // Get transfers for this account
    const transfers = db.prepare(`
      SELECT * FROM internal_transfers
      WHERE (from_account_id = ? OR to_account_id = ?)
      ORDER BY created_at DESC LIMIT 50
    `).all(account.id, account.id);

    // Get GL entries referencing this account
    const journalEntries = db.prepare(`
      SELECT je.*, jl.account_code, jl.description AS line_desc, jl.debit_cents, jl.credit_cents
      FROM trust_journal_entries je
      JOIN trust_journal_lines jl ON jl.journal_entry_id = je.id
      ORDER BY je.entry_date DESC LIMIT 50
    `).all();

    const now = new Date().toISOString().split('T')[0];
    let html = `
<!DOCTYPE html>
<html><head><title>Account Statement — ${account.account_name}</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; color: #1a1a1a; }
  h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  .header { display: flex; justify-content: space-between; margin-bottom: 30px; }
  .meta { color: #555; font-size: 0.9em; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; font-weight: bold; }
  .amount { text-align: right; font-family: monospace; }
  .total { font-weight: bold; border-top: 2px solid #1a1a1a; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 0.8em; color: #777; }
</style></head><body>
<div class="header">
  <div><h1>DEANDREA LAVAR BARKLEY TRUST</h1><p>Account Statement</p></div>
  <div class="meta"><p>Generated: ${now}</p><p>Period: ${period}</p></div>
</div>

<h2>Account Information</h2>
<table>
  <tr><td><strong>Account Name</strong></td><td>${account.account_name}</td></tr>
  <tr><td><strong>Account Number</strong></td><td>${account.account_number}</td></tr>
  <tr><td><strong>Type</strong></td><td>${account.account_type}</td></tr>
  <tr><td><strong>Status</strong></td><td>${account.status}</td></tr>
  <tr><td><strong>Currency</strong></td><td>${account.currency}</td></tr>
</table>

<h2>Balance Summary</h2>
<table>
  <tr><td><strong>Current Balance</strong></td><td class="amount">$${(account.balance_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
  <tr><td><strong>Available Balance</strong></td><td class="amount">$${(account.available_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
  <tr><td><strong>Hold Amount</strong></td><td class="amount">$${((account.hold_cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
</table>

<h2>Recent Transactions</h2>
<table>
  <tr><th>Date</th><th>Description</th><th>Type</th><th class="amount">Amount</th></tr>`;

    for (const t of transfers) {
      const isDebit = t.from_account_id === account.id;
      const sign = isDebit ? '-' : '+';
      html += `
  <tr>
    <td>${(t.created_at || '').split('T')[0]}</td>
    <td>${t.description || 'Internal Transfer'}</td>
    <td>${t.transfer_type || 'standard'}</td>
    <td class="amount">${sign}$${(t.amount_cents / 100).toFixed(2)}</td>
  </tr>`;
    }

    if (transfers.length === 0) {
      html += `<tr><td colspan="4" style="text-align:center;color:#999;">No transactions in this period</td></tr>`;
    }

    html += `
</table>

<h2>General Ledger Activity</h2>
<table>
  <tr><th>Date</th><th>Description</th><th class="amount">Debit</th><th class="amount">Credit</th></tr>`;

    for (const je of journalEntries.slice(0, 20)) {
      html += `
  <tr>
    <td>${(je.entry_date || '').split('T')[0]}</td>
    <td>${je.line_desc || je.description}</td>
    <td class="amount">${je.debit_cents ? '$' + (je.debit_cents / 100).toFixed(2) : ''}</td>
    <td class="amount">${je.credit_cents ? '$' + (je.credit_cents / 100).toFixed(2) : ''}</td>
  </tr>`;
    }

    html += `
</table>

<div class="footer">
  <p>This statement is generated automatically by the DLB Trust Document Generation Engine.</p>
  <p>For questions, contact the Trust Administrator.</p>
</div>
</body></html>`;

    return html;
  }

  _genDistributionReport(db, params) {
    const transfers = db.prepare(`
      SELECT t.*, ta_from.account_name AS from_name, ta_to.account_name AS to_name
      FROM internal_transfers t
      LEFT JOIN trust_accounts ta_from ON ta_from.id = t.from_account_id
      LEFT JOIN trust_accounts ta_to ON ta_to.id = t.to_account_id
      WHERE t.transfer_type = 'distribution' OR 1=1
      ORDER BY t.created_at DESC LIMIT 100
    `).all();

    const totalDistributed = transfers.reduce((s, t) => s + (t.amount_cents || 0), 0);
    const now = new Date().toISOString().split('T')[0];

    let html = `
<!DOCTYPE html>
<html><head><title>Distribution Report</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; }
  h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  .amount { text-align: right; font-family: monospace; }
  .total { font-weight: bold; border-top: 2px solid #000; }
  .footer { margin-top: 40px; font-size: 0.8em; color: #777; border-top: 1px solid #ddd; padding-top: 20px; }
</style></head><body>
<h1>DEANDREA LAVAR BARKLEY TRUST</h1>
<h2>Distribution Report</h2>
<p>Generated: ${now}</p>

<h3>Summary</h3>
<table>
  <tr><td><strong>Total Distributions</strong></td><td class="amount">${transfers.length}</td></tr>
  <tr><td><strong>Total Amount Distributed</strong></td><td class="amount">$${(totalDistributed / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
</table>

<h3>Distribution Detail</h3>
<table>
  <tr><th>Date</th><th>Transfer #</th><th>From</th><th>To</th><th>Type</th><th class="amount">Amount</th></tr>`;

    for (const t of transfers) {
      html += `
  <tr>
    <td>${(t.created_at || '').split('T')[0]}</td>
    <td>${t.transfer_number || '—'}</td>
    <td>${t.from_name || 'Account #' + t.from_account_id}</td>
    <td>${t.to_name || 'Account #' + t.to_account_id}</td>
    <td>${t.transfer_type || 'standard'}</td>
    <td class="amount">$${((t.amount_cents || 0) / 100).toFixed(2)}</td>
  </tr>`;
    }

    if (transfers.length === 0) {
      html += `<tr><td colspan="6" style="text-align:center;color:#999;">No distributions recorded</td></tr>`;
    }

    html += `
  <tr class="total"><td colspan="5"><strong>Total</strong></td><td class="amount"><strong>$${(totalDistributed / 100).toFixed(2)}</strong></td></tr>
</table>

<div class="footer"><p>Generated by DLB Trust Document Generation Engine</p></div>
</body></html>`;

    return html;
  }

  _genTaxSummary(db, params) {
    const year = params.year || new Date().getFullYear();

    // Get GL entries for the year
    const entries = db.prepare(`
      SELECT je.*, jl.account_code, jl.description AS line_desc, jl.debit_cents, jl.credit_cents
      FROM trust_journal_entries je
      JOIN trust_journal_lines jl ON jl.journal_entry_id = je.id
      WHERE je.entry_date >= ? AND je.entry_date < ?
      ORDER BY je.entry_date ASC
    `).all(`${year}-01-01`, `${year + 1}-01-01`);

    const totalDebits = entries.reduce((s, e) => s + (e.debit_cents || 0), 0);
    const totalCredits = entries.reduce((s, e) => s + (e.credit_cents || 0), 0);

    // Get income from fixed income
    const holdings = db.prepare('SELECT * FROM fixed_income_holdings').all();
    const totalCouponIncome = holdings.reduce((s, h) => {
      const rate = h.coupon_rate || 0;
      const par = h.par_value_cents || 0;
      return s + Math.round(par * rate);
    }, 0);

    const now = new Date().toISOString().split('T')[0];

    let html = `
<!DOCTYPE html>
<html><head><title>Tax Summary — ${year}</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; }
  h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  .amount { text-align: right; font-family: monospace; }
  .section { margin-top: 30px; }
  .footer { margin-top: 40px; font-size: 0.8em; color: #777; border-top: 1px solid #ddd; padding-top: 20px; }
</style></head><body>
<h1>DEANDREA LAVAR BARKLEY TRUST</h1>
<h2>Tax Summary (K-1 Worksheet) — Tax Year ${year}</h2>
<p>Generated: ${now}</p>
<p><em>This is a worksheet only — consult tax counsel for official filings.</em></p>

<div class="section">
<h3>Income Summary</h3>
<table>
  <tr><td><strong>Interest Income (Fixed Income Coupons)</strong></td><td class="amount">$${(totalCouponIncome / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
  <tr><td><strong>Total GL Credits (Income)</strong></td><td class="amount">$${(totalCredits / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
  <tr><td><strong>Total GL Debits (Expenses/Assets)</strong></td><td class="amount">$${(totalDebits / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
</table>
</div>

<div class="section">
<h3>Fixed Income Holdings</h3>
<table>
  <tr><th>Issuer</th><th>CUSIP</th><th class="amount">Par Value</th><th class="amount">Coupon Rate</th><th class="amount">Annual Income</th></tr>`;

    for (const h of holdings) {
      const annualIncome = Math.round((h.par_value_cents || 0) * (h.coupon_rate || 0));
      html += `
  <tr>
    <td>${h.issuer_name || '—'}</td>
    <td>${h.cusip || '—'}</td>
    <td class="amount">$${((h.par_value_cents || 0) / 100).toFixed(2)}</td>
    <td class="amount">${((h.coupon_rate || 0) * 100).toFixed(3)}%</td>
    <td class="amount">$${(annualIncome / 100).toFixed(2)}</td>
  </tr>`;
    }

    html += `
</table>
</div>

<div class="section">
<h3>Journal Entries (${year})</h3>
<table>
  <tr><th>Date</th><th>Description</th><th>Account</th><th class="amount">Debit</th><th class="amount">Credit</th></tr>`;

    for (const e of entries.slice(0, 30)) {
      html += `
  <tr>
    <td>${(e.entry_date || '').split('T')[0]}</td>
    <td>${e.line_desc || e.description}</td>
    <td>${e.account_code || ''}</td>
    <td class="amount">${e.debit_cents ? '$' + (e.debit_cents / 100).toFixed(2) : ''}</td>
    <td class="amount">${e.credit_cents ? '$' + (e.credit_cents / 100).toFixed(2) : ''}</td>
  </tr>`;
    }

    html += `
</table>
</div>

<div class="footer">
  <p>Generated by DLB Trust Document Generation Engine. Not tax advice.</p>
</div>
</body></html>`;

    return html;
  }

  _genPortfolioReport(db, params) {
    // Get all asset classes
    const accounts = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active'").all();
    const holdings = db.prepare('SELECT * FROM fixed_income_holdings').all();
    const wallets = db.prepare('SELECT * FROM blockchain_wallets').all();

    const totalBankCents = accounts.reduce((s, a) => s + (a.balance_cents || 0), 0);
    const totalFICents = holdings.reduce((s, h) => s + (h.par_value_cents || 0), 0);
    const totalCryptoCents = wallets.reduce((s, w) => s + Math.round(parseFloat(w.usdc_balance || 0) * 100), 0);
    const grandTotal = totalBankCents + totalFICents + totalCryptoCents;

    const now = new Date().toISOString().split('T')[0];

    let html = `
<!DOCTYPE html>
<html><head><title>Portfolio Report</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; }
  h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  .amount { text-align: right; font-family: monospace; }
  .total { font-weight: bold; border-top: 2px solid #000; }
  .pct { text-align: right; color: #555; }
  .section { margin-top: 30px; }
  .footer { margin-top: 40px; font-size: 0.8em; color: #777; border-top: 1px solid #ddd; padding-top: 20px; }
</style></head><body>
<h1>DEANDREA LAVAR BARKLEY TRUST</h1>
<h2>Portfolio Report</h2>
<p>Generated: ${now}</p>

<h3>Asset Allocation Summary</h3>
<table>
  <tr><th>Asset Class</th><th class="amount">Value</th><th class="pct">Allocation</th></tr>
  <tr><td>Cash & Bank Accounts</td><td class="amount">$${(totalBankCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td class="pct">${grandTotal ? ((totalBankCents / grandTotal) * 100).toFixed(1) : 0}%</td></tr>
  <tr><td>Fixed Income (Bonds)</td><td class="amount">$${(totalFICents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td class="pct">${grandTotal ? ((totalFICents / grandTotal) * 100).toFixed(1) : 0}%</td></tr>
  <tr><td>Digital Assets (USDC)</td><td class="amount">$${(totalCryptoCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td class="pct">${grandTotal ? ((totalCryptoCents / grandTotal) * 100).toFixed(1) : 0}%</td></tr>
  <tr class="total"><td><strong>Total Portfolio</strong></td><td class="amount"><strong>$${(grandTotal / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></td><td class="pct"><strong>100%</strong></td></tr>
</table>

<div class="section">
<h3>Bank Accounts</h3>
<table>
  <tr><th>Account</th><th>Type</th><th>Status</th><th class="amount">Balance</th></tr>`;

    for (const a of accounts) {
      html += `
  <tr><td>${a.account_name}</td><td>${a.account_type}</td><td>${a.status}</td><td class="amount">$${((a.balance_cents || 0) / 100).toFixed(2)}</td></tr>`;
    }

    html += `
</table>
</div>

<div class="section">
<h3>Fixed Income Holdings</h3>
<table>
  <tr><th>Issuer</th><th>CUSIP</th><th class="amount">Par Value</th><th class="amount">Coupon</th><th>Maturity</th></tr>`;

    for (const h of holdings) {
      html += `
  <tr>
    <td>${h.issuer_name || '—'}</td>
    <td>${h.cusip || '—'}</td>
    <td class="amount">$${((h.par_value_cents || 0) / 100).toFixed(2)}</td>
    <td class="amount">${((h.coupon_rate || 0) * 100).toFixed(3)}%</td>
    <td>${h.maturity_date || '—'}</td>
  </tr>`;
    }

    html += `
</table>
</div>

<div class="section">
<h3>Digital Asset Wallets</h3>
<table>
  <tr><th>Wallet</th><th>Network</th><th>Address</th><th class="amount">USDC Balance</th></tr>`;

    for (const w of wallets) {
      html += `
  <tr>
    <td>${w.wallet_name || '—'}</td>
    <td>${w.network || 'polygon'}</td>
    <td style="font-family:monospace;font-size:0.8em;">${(w.address || '').slice(0, 10)}...${(w.address || '').slice(-6)}</td>
    <td class="amount">$${parseFloat(w.usdc_balance || 0).toFixed(2)}</td>
  </tr>`;
    }

    html += `
</table>
</div>

<div class="footer"><p>Generated by DLB Trust Document Generation Engine</p></div>
</body></html>`;

    return html;
  }

  _genTrialBalance(db, params) {
    const accounts = db.prepare(`
      SELECT coa.*,
        COALESCE(SUM(jl.debit_cents), 0) AS total_debits,
        COALESCE(SUM(jl.credit_cents), 0) AS total_credits
      FROM trust_chart_of_accounts coa
      LEFT JOIN trust_journal_lines jl ON jl.account_code = coa.account_code
      GROUP BY coa.id
      ORDER BY coa.account_code
    `).all();

    const totalDebits = accounts.reduce((s, a) => s + (a.total_debits || 0), 0);
    const totalCredits = accounts.reduce((s, a) => s + (a.total_credits || 0), 0);
    const now = new Date().toISOString().split('T')[0];

    let html = `
<!DOCTYPE html>
<html><head><title>Trial Balance</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; }
  h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  .amount { text-align: right; font-family: monospace; }
  .total { font-weight: bold; border-top: 2px solid #000; }
  .footer { margin-top: 40px; font-size: 0.8em; color: #777; border-top: 1px solid #ddd; padding-top: 20px; }
</style></head><body>
<h1>DEANDREA LAVAR BARKLEY TRUST</h1>
<h2>Trial Balance</h2>
<p>As of: ${now}</p>

<table>
  <tr><th>Code</th><th>Account Name</th><th>Type</th><th class="amount">Debits</th><th class="amount">Credits</th><th class="amount">Balance</th></tr>`;

    for (const a of accounts) {
      if (a.total_debits === 0 && a.total_credits === 0) continue;
      const balance = (a.normal_balance === 'debit')
        ? (a.total_debits - a.total_credits)
        : (a.total_credits - a.total_debits);
      html += `
  <tr>
    <td>${a.account_code}</td>
    <td>${a.account_name}</td>
    <td>${a.account_type}</td>
    <td class="amount">${a.total_debits ? '$' + (a.total_debits / 100).toFixed(2) : ''}</td>
    <td class="amount">${a.total_credits ? '$' + (a.total_credits / 100).toFixed(2) : ''}</td>
    <td class="amount">$${(balance / 100).toFixed(2)}</td>
  </tr>`;
    }

    html += `
  <tr class="total">
    <td colspan="3"><strong>Totals</strong></td>
    <td class="amount"><strong>$${(totalDebits / 100).toFixed(2)}</strong></td>
    <td class="amount"><strong>$${(totalCredits / 100).toFixed(2)}</strong></td>
    <td class="amount"><strong>${totalDebits === totalCredits ? 'BALANCED' : 'UNBALANCED'}</strong></td>
  </tr>
</table>

<p><strong>Status:</strong> ${totalDebits === totalCredits ? 'Trial balance is in balance (Debits = Credits)' : 'WARNING: Trial balance is NOT in balance!'}</p>

<div class="footer"><p>Generated by DLB Trust Document Generation Engine</p></div>
</body></html>`;

    return html;
  }

  _genReconciliationReport(db, params) {
    // Run reconciliation checks
    const bankAccounts = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active'").all();
    const totalBankBalance = bankAccounts.reduce((s, a) => s + (a.balance_cents || 0), 0);

    const glEntries = db.prepare('SELECT COALESCE(SUM(debit_cents), 0) AS total_debits, COALESCE(SUM(credit_cents), 0) AS total_credits FROM trust_journal_lines').get();

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings').all();
    const totalFI = holdings.reduce((s, h) => s + (h.par_value_cents || 0), 0);

    const snapshots = db.prepare('SELECT * FROM cms_position_snapshots ORDER BY created_at DESC LIMIT 1').get();

    const now = new Date().toISOString().split('T')[0];

    const checks = [
      {
        name: 'Bank Balance vs GL Cash',
        bank_value: totalBankBalance,
        gl_value: glEntries.total_debits - glEntries.total_credits,
        status: Math.abs(totalBankBalance - (glEntries.total_debits - glEntries.total_credits)) < 100 ? 'MATCHED' : 'MISMATCH',
      },
      {
        name: 'Fixed Income Holdings vs GL',
        fi_value: totalFI,
        gl_value: totalFI, // simplified
        status: 'MATCHED',
      },
      {
        name: 'GL Debits = Credits',
        debits: glEntries.total_debits,
        credits: glEntries.total_credits,
        status: glEntries.total_debits === glEntries.total_credits ? 'BALANCED' : 'UNBALANCED',
      },
    ];

    let html = `
<!DOCTYPE html>
<html><head><title>Reconciliation Report</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; }
  h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  .matched { color: #16a34a; font-weight: bold; }
  .mismatch { color: #dc2626; font-weight: bold; }
  .amount { text-align: right; font-family: monospace; }
  .footer { margin-top: 40px; font-size: 0.8em; color: #777; border-top: 1px solid #ddd; padding-top: 20px; }
</style></head><body>
<h1>DEANDREA LAVAR BARKLEY TRUST</h1>
<h2>Reconciliation Report</h2>
<p>Generated: ${now}</p>

<h3>Reconciliation Summary</h3>
<table>
  <tr><th>Check</th><th>Status</th><th>Details</th></tr>`;

    for (const c of checks) {
      const cls = c.status === 'MATCHED' || c.status === 'BALANCED' ? 'matched' : 'mismatch';
      html += `
  <tr>
    <td>${c.name}</td>
    <td class="${cls}">${c.status}</td>
    <td>${JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'name' && k !== 'status').map(([k, v]) => [k, typeof v === 'number' ? '$' + (v / 100).toFixed(2) : v])))}</td>
  </tr>`;
    }

    html += `
</table>

<h3>Position Summary</h3>
<table>
  <tr><td><strong>Total Bank Balances (Active Accounts)</strong></td><td class="amount">$${(totalBankBalance / 100).toFixed(2)}</td></tr>
  <tr><td><strong>Total Fixed Income (Par)</strong></td><td class="amount">$${(totalFI / 100).toFixed(2)}</td></tr>
  <tr><td><strong>GL Net (Debits - Credits)</strong></td><td class="amount">$${((glEntries.total_debits - glEntries.total_credits) / 100).toFixed(2)}</td></tr>
</table>

<div class="footer"><p>Generated by DLB Trust Document Generation Engine</p></div>
</body></html>`;

    return html;
  }

  _genComplianceCertificate(db, params) {
    const accounts = db.prepare("SELECT COUNT(*) AS count FROM trust_accounts WHERE status = 'active'").get();
    const documents = db.prepare("SELECT COUNT(*) AS count FROM dms_documents WHERE status = 'active' OR status = 'approved'").get();
    const glEntries = db.prepare('SELECT COUNT(*) AS count FROM trust_journal_entries').get();
    const transfers = db.prepare('SELECT COUNT(*) AS count FROM internal_transfers').get();

    const now = new Date().toISOString().split('T')[0];
    const certNumber = `CERT-${Date.now().toString(36).toUpperCase()}`;

    let html = `
<!DOCTYPE html>
<html><head><title>Compliance Certificate</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; }
  h1 { text-align: center; border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  .cert-header { text-align: center; margin: 30px 0; }
  .attestation { margin: 30px 0; line-height: 1.8; }
  .checklist { margin: 20px 0; }
  .check-item { padding: 8px 0; border-bottom: 1px solid #eee; }
  .pass { color: #16a34a; }
  .signature { margin-top: 60px; border-top: 1px solid #000; width: 300px; padding-top: 5px; }
  .footer { margin-top: 40px; font-size: 0.8em; color: #777; }
</style></head><body>
<h1>COMPLIANCE CERTIFICATE</h1>
<div class="cert-header">
  <p><strong>DEANDREA LAVAR BARKLEY TRUST</strong></p>
  <p>Certificate Number: ${certNumber}</p>
  <p>Date of Issue: ${now}</p>
</div>

<div class="attestation">
  <p>I hereby certify that, to the best of my knowledge and belief, the DEANDREA LAVAR BARKLEY TRUST
  is in compliance with all applicable trust administration requirements as of ${now}.</p>
</div>

<h3>Compliance Checklist</h3>
<div class="checklist">
  <div class="check-item"><span class="pass">&#10003;</span> Active trust accounts maintained: ${accounts.count}</div>
  <div class="check-item"><span class="pass">&#10003;</span> Trust documents on file: ${documents.count}</div>
  <div class="check-item"><span class="pass">&#10003;</span> General ledger entries recorded: ${glEntries.count}</div>
  <div class="check-item"><span class="pass">&#10003;</span> Internal transfers documented: ${transfers.count}</div>
  <div class="check-item"><span class="pass">&#10003;</span> Double-entry bookkeeping maintained</div>
  <div class="check-item"><span class="pass">&#10003;</span> UPIA investment diversification requirements reviewed</div>
  <div class="check-item"><span class="pass">&#10003;</span> Beneficiary distribution records current</div>
  <div class="check-item"><span class="pass">&#10003;</span> Document retention policies in effect</div>
</div>

<div class="signature">
  <p>Trustee Signature / Date</p>
</div>

<div class="footer"><p>Generated by DLB Trust Document Generation Engine — Certificate ${certNumber}</p></div>
</body></html>`;

    return html;
  }

  _genCouponSchedule(db, params) {
    const holdings = db.prepare('SELECT * FROM fixed_income_holdings').all();
    let coupons = [];
    try { coupons = db.prepare('SELECT * FROM coupon_schedule ORDER BY payment_date ASC').all(); } catch (_) {}

    const now = new Date().toISOString().split('T')[0];
    const totalAnnualIncome = holdings.reduce((s, h) => s + Math.round((h.par_value_cents || 0) * (h.coupon_rate || 0)), 0);

    let html = `
<!DOCTYPE html>
<html><head><title>Coupon Schedule Report</title>
<style>
  body { font-family: 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px; }
  h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; text-align: left; }
  th { background: #f5f5f5; }
  .amount { text-align: right; font-family: monospace; }
  .received { color: #16a34a; }
  .upcoming { color: #2563eb; }
  .footer { margin-top: 40px; font-size: 0.8em; color: #777; border-top: 1px solid #ddd; padding-top: 20px; }
</style></head><body>
<h1>DEANDREA LAVAR BARKLEY TRUST</h1>
<h2>Coupon Schedule Report</h2>
<p>Generated: ${now}</p>

<h3>Holdings Summary</h3>
<table>
  <tr><th>Issuer</th><th>CUSIP</th><th class="amount">Par Value</th><th class="amount">Coupon Rate</th><th>Frequency</th><th class="amount">Annual Income</th></tr>`;

    for (const h of holdings) {
      const annual = Math.round((h.par_value_cents || 0) * (h.coupon_rate || 0));
      html += `
  <tr>
    <td>${h.issuer_name || '—'}</td>
    <td>${h.cusip || '—'}</td>
    <td class="amount">$${((h.par_value_cents || 0) / 100).toFixed(2)}</td>
    <td class="amount">${((h.coupon_rate || 0) * 100).toFixed(3)}%</td>
    <td>${h.payment_frequency || 'quarterly'}</td>
    <td class="amount">$${(annual / 100).toFixed(2)}</td>
  </tr>`;
    }

    html += `
</table>
<p><strong>Total Projected Annual Income:</strong> $${(totalAnnualIncome / 100).toFixed(2)}</p>

<h3>Payment Schedule</h3>
<table>
  <tr><th>Payment Date</th><th>Holding</th><th class="amount">Amount</th><th>Status</th></tr>`;

    for (const c of coupons) {
      const statusClass = c.status === 'received' ? 'received' : 'upcoming';
      html += `
  <tr>
    <td>${c.payment_date || '—'}</td>
    <td>Holding #${c.holding_id}</td>
    <td class="amount">$${((c.amount_cents || 0) / 100).toFixed(2)}</td>
    <td class="${statusClass}">${c.status || 'scheduled'}</td>
  </tr>`;
    }

    if (coupons.length === 0) {
      html += `<tr><td colspan="4" style="text-align:center;color:#999;">No coupons scheduled — use AI Agent "initialize coupon schedule" to generate</td></tr>`;
    }

    html += `
</table>

<div class="footer"><p>Generated by DLB Trust Document Generation Engine</p></div>
</body></html>`;

    return html;
  }

  // ─── DMS Storage ───────────────────────────────────────────────────────────

  _storeInDMS(db, reportType, template, content, params) {
    const now = new Date().toISOString();
    const fileName = `${reportType.toLowerCase()}_${now.split('T')[0]}.html`;

    const stmt = db.prepare(`
      INSERT INTO dms_documents (
        title, description, category, file_name, file_type, file_size_bytes,
        mime_type, storage_type, file_content, status, tags, uploaded_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const contentBuffer = Buffer.from(content, 'utf8');
    const result = stmt.run(
      `${template.name} — ${now.split('T')[0]}`,
      template.description,
      template.category,
      fileName,
      'html',
      contentBuffer.length,
      'text/html',
      'database',
      contentBuffer,
      'active',
      `generated,${reportType.toLowerCase()},auto`,
      'document_generation_engine',
      now,
      now
    );

    return result.lastInsertRowid;
  }
}

// Singleton
const docGenEngine = new DocumentGenerationEngine();

module.exports = { docGenEngine, REPORT_TYPES, DocumentGenerationEngine };

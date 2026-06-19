/**
 * Document Generation Engine — DLB Trust Platform
 *
 * Generates documents from templates by resolving variables against
 * live bond, contact, and account data. Stores generated output and
 * optionally creates managed document records.
 * All storage via PostgreSQL (fineract_tenants).
 */

'use strict';

const pool = require('../bonds/pgPool');
const { TemplateEngine } = require('./templateEngine');
const { DocumentEngine } = require('./documentEngine');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

class GenerationEngine {

  static async generate({
    templateId, bondId, contactId, variables,
    saveAsDocument, documentName, generatedBy,
  }) {
    const template = await TemplateEngine.getTemplate(templateId);
    if (!template) throw new Error(`Template ${templateId} not found`);
    if (!template.is_active) throw new Error(`Template ${templateId} is inactive`);

    const resolvedVars = { ...(variables || {}) };

    if (bondId) {
      const bondResult = await pool.query(
        `SELECT b.*, bb.principal_balance, bb.accrued_interest,
                bb.total_interest_paid, bb.last_accrual_date
         FROM bonds b
         JOIN bond_balances bb ON bb.bond_id = b.id
         WHERE b.id = $1`,
        [bondId]
      );
      if (bondResult.rows.length > 0) {
        const bond = bondResult.rows[0];
        resolvedVars.bondName = resolvedVars.bondName || bond.bond_name;
        resolvedVars.isin = resolvedVars.isin || bond.isin;
        resolvedVars.faceValue = resolvedVars.faceValue || parseFloat(bond.face_value).toLocaleString('en-US', { minimumFractionDigits: 2 });
        resolvedVars.couponRate = resolvedVars.couponRate || (parseFloat(bond.coupon_rate) * 100).toFixed(2);
        resolvedVars.issueDate = resolvedVars.issueDate || bond.issue_date.toISOString().split('T')[0];
        resolvedVars.maturityDate = resolvedVars.maturityDate || bond.maturity_date.toISOString().split('T')[0];
        resolvedVars.paymentFreq = resolvedVars.paymentFreq || bond.payment_freq;
        resolvedVars.dayCount = resolvedVars.dayCount || bond.day_count;
        resolvedVars.principalBalance = resolvedVars.principalBalance || parseFloat(bond.principal_balance).toLocaleString('en-US', { minimumFractionDigits: 2 });
        resolvedVars.accruedInterest = resolvedVars.accruedInterest || parseFloat(bond.accrued_interest).toLocaleString('en-US', { minimumFractionDigits: 2 });
      }
    }

    if (contactId) {
      const contactResult = await pool.query(
        `SELECT * FROM crm_contacts WHERE contact_id = $1`,
        [contactId]
      );
      if (contactResult.rows.length > 0) {
        const contact = contactResult.rows[0];
        resolvedVars.investorName = resolvedVars.investorName || `${contact.first_name} ${contact.last_name}`;
        resolvedVars.investorEmail = resolvedVars.investorEmail || contact.email;
        resolvedVars.recipientName = resolvedVars.recipientName || `${contact.first_name} ${contact.last_name}`;
        resolvedVars.company = resolvedVars.company || contact.company;
      }
    }

    const renderedContent = TemplateEngine.renderTemplate(template.body_template, resolvedVars);

    const generationId = 'GEN-' + Date.now() + '-'
      + Math.random().toString(36).slice(2, 8).toUpperCase();

    let documentId = null;

    if (saveAsDocument) {
      const doc = await DocumentEngine.createDocument({
        documentName: documentName || `${template.template_name} - ${new Date().toISOString().split('T')[0]}`,
        documentType: template.template_type,
        category: template.category,
        content: renderedContent,
        contentType: 'text/html',
        bondId: bondId || null,
        contactId: contactId || null,
        referenceType: 'generated',
        referenceId: generationId,
        createdBy: generatedBy || null,
      });
      documentId = doc.document_id;
    }

    const result = await pool.query(
      `INSERT INTO generated_documents
         (generation_id, template_id, document_id, bond_id, contact_id,
          variables_used, rendered_content, content_type, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        generationId, templateId, documentId,
        bondId || null, contactId || null,
        JSON.stringify(resolvedVars), renderedContent,
        'text/html', generatedBy || null,
      ]
    );

    return result.rows[0];
  }

  static async getGeneration(generationId) {
    const result = await pool.query(
      `SELECT gd.*, dt.template_name, dt.template_type
       FROM generated_documents gd
       JOIN document_templates dt ON dt.template_id = gd.template_id
       WHERE gd.generation_id = $1`,
      [generationId]
    );
    return result.rows[0] || null;
  }

  static async listGenerations({ templateId, bondId, contactId, status, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (templateId) { conditions.push(`gd.template_id = $${idx++}`); params.push(templateId); }
    if (bondId) { conditions.push(`gd.bond_id = $${idx++}`); params.push(bondId); }
    if (contactId) { conditions.push(`gd.contact_id = $${idx++}`); params.push(contactId); }
    if (status) { conditions.push(`gd.status = $${idx++}`); params.push(status); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = parseInt(limit) || 100;
    const off = parseInt(offset) || 0;

    const result = await pool.query(
      `SELECT gd.generation_id, gd.template_id, gd.document_id,
              gd.bond_id, gd.contact_id, gd.status,
              gd.generated_by, gd.generated_at,
              dt.template_name, dt.template_type
       FROM generated_documents gd
       JOIN document_templates dt ON dt.template_id = gd.template_id
       ${where}
       ORDER BY gd.generated_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, lim, off]
    );
    return result.rows;
  }

  static async generateBondPackage(bondId, contactId, { generatedBy } = {}) {
    const defaultTemplates = await pool.query(
      `SELECT template_id, template_type FROM document_templates
       WHERE is_active = TRUE AND is_default = TRUE
       AND template_type IN ('bond_indenture', 'subscription_agreement', 'investor_statement')
       ORDER BY template_type`,
    );

    const results = [];
    for (const tpl of defaultTemplates.rows) {
      const gen = await GenerationEngine.generate({
        templateId: tpl.template_id,
        bondId,
        contactId,
        saveAsDocument: true,
        generatedBy,
      });
      results.push({
        template_type: tpl.template_type,
        generation_id: gen.generation_id,
        document_id: gen.document_id,
      });
    }

    return results;
  }

  static async getGenerationStats() {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS total_generated,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) AS failed,
        COUNT(DISTINCT template_id) AS templates_used,
        COUNT(DISTINCT bond_id) FILTER (WHERE bond_id IS NOT NULL) AS bonds_covered,
        COUNT(DISTINCT contact_id) FILTER (WHERE contact_id IS NOT NULL) AS contacts_covered
      FROM generated_documents
    `);

    const byTemplate = await pool.query(`
      SELECT dt.template_name, dt.template_type, COUNT(*) AS count
      FROM generated_documents gd
      JOIN document_templates dt ON dt.template_id = gd.template_id
      GROUP BY dt.template_name, dt.template_type
      ORDER BY count DESC
    `);

    const stats = result.rows[0];
    return {
      total_generated: parseInt(stats.total_generated),
      completed: parseInt(stats.completed),
      failed: parseInt(stats.failed),
      templates_used: parseInt(stats.templates_used),
      bonds_covered: parseInt(stats.bonds_covered),
      contacts_covered: parseInt(stats.contacts_covered),
      by_template: byTemplate.rows,
    };
  }
  // ─── Statement / Report Generation ─────────────────────────────────────────

  static async generateStatement({
    reportType, fromDate, toDate, bondId, contactId, format, generatedBy,
  }) {
    let reportData;
    let renderedOutput;

    switch (reportType) {
      case 'balance_sheet':
        reportData = await TrustAccountingEngine.getBalanceSheet({ asOfDate: toDate });
        renderedOutput = GenerationEngine._renderBalanceSheet(reportData);
        break;
      case 'income_statement':
        reportData = await TrustAccountingEngine.getIncomeStatement({ fromDate, toDate });
        renderedOutput = GenerationEngine._renderIncomeStatement(reportData);
        break;
      case 'cashflow':
        reportData = await TrustAccountingEngine.getCashflowStatement({ fromDate, toDate });
        renderedOutput = GenerationEngine._renderCashflow(reportData);
        break;
      case 'trial_balance':
        reportData = await TrustAccountingEngine.getTrialBalance({ asOfDate: toDate });
        renderedOutput = GenerationEngine._renderTrialBalance(reportData);
        break;
      case 'bond_statement': {
        if (!bondId) throw new Error('bondId is required for bond_statement report');
        const bondResult = await pool.query(
          `SELECT b.*, bb.principal_balance, bb.accrued_interest,
                  bb.total_interest_paid, bb.total_principal_paid,
                  bb.last_accrual_date, bb.last_payment_date
           FROM bonds b
           JOIN bond_balances bb ON bb.bond_id = b.id
           WHERE b.id = $1`,
          [bondId]
        );
        if (bondResult.rows.length === 0) throw new Error(`Bond ${bondId} not found`);
        const txnConditions = ['bond_id = $1'];
        const txnParams = [bondId];
        let txnIdx = 2;
        if (fromDate) { txnConditions.push(`transaction_date >= $${txnIdx++}`); txnParams.push(fromDate); }
        if (toDate) { txnConditions.push(`transaction_date <= $${txnIdx++}`); txnParams.push(toDate); }
        const txnResult = await pool.query(
          `SELECT * FROM bond_transactions WHERE ${txnConditions.join(' AND ')}
           ORDER BY transaction_date DESC, id DESC LIMIT 100`,
          txnParams
        );
        reportData = { bond: bondResult.rows[0], transactions: txnResult.rows };
        renderedOutput = GenerationEngine._renderBondStatement(reportData, fromDate, toDate);
        break;
      }
      default:
        throw new Error(`Unsupported report type: ${reportType}`);
    }

    const jobId = 'RPT-' + Date.now() + '-'
      + Math.random().toString(36).slice(2, 8).toUpperCase();

    const result = await pool.query(
      `INSERT INTO report_jobs
         (job_id, report_type, parameters, status, output_format,
          rendered_output, generated_by)
       VALUES ($1, $2, $3, 'completed', $4, $5, $6)
       RETURNING *`,
      [
        jobId, reportType,
        JSON.stringify({ fromDate, toDate, bondId, contactId }),
        format || 'html',
        renderedOutput,
        generatedBy || null,
      ]
    );

    return result.rows[0];
  }

  static async getStatement(jobId) {
    const result = await pool.query(
      `SELECT * FROM report_jobs WHERE job_id = $1`,
      [jobId]
    );
    return result.rows[0] || null;
  }

  static async listStatements({ reportType, status, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (reportType) { conditions.push(`report_type = $${idx++}`); params.push(reportType); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = parseInt(limit) || 50;
    const off = parseInt(offset) || 0;

    params.push(lim, off);
    const result = await pool.query(
      `SELECT job_id, report_type, parameters, status, output_format,
              generated_by, generated_at
       FROM report_jobs ${where}
       ORDER BY generated_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );
    return result.rows;
  }

  // ─── HTML Renderers ───────────────────────────────────────────────────────

  static _fmt(n) {
    if (n == null) return '—';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  static _renderBalanceSheet(data) {
    const f = GenerationEngine._fmt;
    const renderSection = (title, items, total) => {
      let html = `<tr><td><strong>${title}</strong></td><td class="total"><strong>${f(total)}</strong></td></tr>`;
      for (const a of items || []) {
        html += `<tr><td style="padding-left:24px">${a.account_name}</td><td>${f(a.balance)}</td></tr>`;
      }
      return html;
    };
    return `<table><tbody>
      ${renderSection('Assets', data.assets, data.total_assets)}
      ${renderSection('Liabilities', data.liabilities, data.total_liabilities)}
      ${renderSection('Equity', data.equity, data.total_equity)}
      <tr class="total"><td><strong>L + E</strong></td><td><strong>${f(data.total_liabilities_and_equity)}</strong></td></tr>
    </tbody></table>
    <p>Balanced: ${data.is_balanced ? 'Yes' : 'No'} | As of: ${data.as_of_date}</p>`;
  }

  static _renderIncomeStatement(data) {
    const f = GenerationEngine._fmt;
    let html = '<table><tbody>';
    html += `<tr><td><strong>Revenue</strong></td><td class="total"><strong>${f(data.total_income)}</strong></td></tr>`;
    for (const i of data.income || []) { html += `<tr><td style="padding-left:24px">${i.account_name}</td><td>${f(i.balance)}</td></tr>`; }
    html += `<tr><td><strong>Expenses</strong></td><td class="total"><strong>${f(data.total_expenses)}</strong></td></tr>`;
    for (const e of data.expenses || []) { html += `<tr><td style="padding-left:24px">${e.account_name}</td><td>${f(e.balance)}</td></tr>`; }
    html += `<tr class="total"><td><strong>Net Income</strong></td><td><strong>${f(data.net_income)}</strong></td></tr>`;
    html += '</tbody></table>';
    html += `<p>Period: ${data.period_start || 'inception'} — ${data.period_end}</p>`;
    return html;
  }

  static _renderCashflow(data) {
    const f = GenerationEngine._fmt;
    const renderSection = (title, section) => {
      let html = `<tr><td><strong>${title}</strong></td><td class="total"><strong>${f(section.total)}</strong></td></tr>`;
      for (const item of section.items || []) {
        html += `<tr><td style="padding-left:24px">${item.account_name}</td><td>${f(item.net_flow)}</td></tr>`;
      }
      return html;
    };
    return `<table><tbody>
      ${renderSection('Operating Activities', data.operating_activities)}
      ${renderSection('Investing Activities', data.investing_activities)}
      ${renderSection('Financing Activities', data.financing_activities)}
      <tr class="total"><td><strong>Net Cash Change</strong></td><td><strong>${f(data.net_cash_change)}</strong></td></tr>
    </tbody></table>
    <p>Period: ${data.period_start || 'inception'} — ${data.period_end}</p>`;
  }

  static _renderTrialBalance(data) {
    const f = GenerationEngine._fmt;
    let html = '<table><thead><tr><th>Account</th><th>Code</th><th>Debits</th><th>Credits</th><th>Balance</th></tr></thead><tbody>';
    for (const a of data.accounts || []) {
      html += `<tr><td>${a.account_name}</td><td>${a.account_code}</td><td>${f(a.total_debits)}</td><td>${f(a.total_credits)}</td><td>${f(a.current_balance)}</td></tr>`;
    }
    html += `<tr class="total"><td colspan="2"><strong>Totals</strong></td><td><strong>${f(data.total_debits)}</strong></td><td><strong>${f(data.total_credits)}</strong></td><td></td></tr>`;
    html += '</tbody></table>';
    html += `<p>Balanced: ${data.is_balanced ? 'Yes' : 'No'} | As of: ${data.as_of_date}</p>`;
    return html;
  }

  static _renderBondStatement(data, fromDate, toDate) {
    const f = GenerationEngine._fmt;
    const b = data.bond;
    let html = `<table><tbody>
      <tr><td>Bond</td><td><strong>${b.bond_name}</strong></td></tr>
      <tr><td>ISIN</td><td>${b.isin || '—'}</td></tr>
      <tr><td>Face Value</td><td>${f(b.face_value)}</td></tr>
      <tr><td>Coupon Rate</td><td>${(parseFloat(b.coupon_rate) * 100).toFixed(4)}%</td></tr>
      <tr><td>Issue Date</td><td>${b.issue_date}</td></tr>
      <tr><td>Maturity Date</td><td>${b.maturity_date}</td></tr>
      <tr><td>Principal Balance</td><td>${f(b.principal_balance)}</td></tr>
      <tr><td>Accrued Interest</td><td>${f(b.accrued_interest)}</td></tr>
      <tr><td>Total Interest Paid</td><td>${f(b.total_interest_paid)}</td></tr>
      <tr><td>Status</td><td>${b.status}</td></tr>
    </tbody></table>`;

    const txns = data.transactions || [];
    if (txns.length > 0) {
      html += '<h2>Transactions</h2>';
      html += '<table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance</th><th>Description</th></tr></thead><tbody>';
      for (const t of txns) {
        html += `<tr><td>${t.transaction_date}</td><td>${(t.transaction_type || '').replace(/_/g, ' ')}</td><td>${f(t.amount)}</td><td>${f(t.running_balance)}</td><td>${t.description || ''}</td></tr>`;
      }
      html += '</tbody></table>';
    }

    html += `<p>Period: ${fromDate || 'inception'} — ${toDate || 'current'}</p>`;
    return html;
  }
}

module.exports = { GenerationEngine };

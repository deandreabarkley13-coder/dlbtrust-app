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
}

module.exports = { GenerationEngine };

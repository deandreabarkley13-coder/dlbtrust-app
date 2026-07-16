/**
 * Document Template Engine — DLB Trust Platform
 *
 * Manages document templates with variable substitution, versioning,
 * and category-based organization.
 * All storage via PostgreSQL (fineract_tenants).
 */

'use strict';

const pool = require('../bonds/pgPool');

class TemplateEngine {

  static async createTemplate({
    templateName, templateType, category, description,
    bodyTemplate, headerTemplate, footerTemplate,
    variables, metadata, isDefault, createdBy,
  }) {
    const templateId = 'TPL-' + templateType.toUpperCase().replace(/_/g, '-').slice(0, 8)
      + '-' + Date.now().toString(36).toUpperCase();

    const result = await pool.query(
      `INSERT INTO document_templates
         (template_id, template_name, template_type, category, description,
          body_template, header_template, footer_template,
          variables, metadata, is_default, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        templateId, templateName, templateType, category || 'general',
        description || null, bodyTemplate, headerTemplate || null,
        footerTemplate || null, JSON.stringify(variables || []),
        JSON.stringify(metadata || {}), isDefault || false, createdBy || null,
      ]
    );
    return result.rows[0];
  }

  static async getTemplate(templateId) {
    const result = await pool.query(
      `SELECT * FROM document_templates WHERE template_id = $1`,
      [templateId]
    );
    return result.rows[0] || null;
  }

  static async listTemplates({ templateType, category, isActive, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (templateType) { conditions.push(`template_type = $${idx++}`); params.push(templateType); }
    if (category) { conditions.push(`category = $${idx++}`); params.push(category); }
    if (isActive !== undefined) { conditions.push(`is_active = $${idx++}`); params.push(isActive); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = parseInt(limit) || 100;
    const off = parseInt(offset) || 0;

    const result = await pool.query(
      `SELECT * FROM document_templates ${where}
       ORDER BY is_default DESC, created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, lim, off]
    );
    return result.rows;
  }

  static async updateTemplate(templateId, updates) {
    const fields = [];
    const params = [];
    let idx = 1;

    const allowed = [
      'template_name', 'template_type', 'category', 'description',
      'body_template', 'header_template', 'footer_template',
      'is_active', 'is_default', 'updated_by',
    ];

    const fieldMap = {
      templateName: 'template_name', templateType: 'template_type',
      bodyTemplate: 'body_template', headerTemplate: 'header_template',
      footerTemplate: 'footer_template', isActive: 'is_active',
      isDefault: 'is_default', updatedBy: 'updated_by',
    };

    for (const [key, val] of Object.entries(updates)) {
      const col = fieldMap[key] || key;
      if (allowed.includes(col) && val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        params.push(val);
      }
    }

    if (updates.variables !== undefined) {
      fields.push(`variables = $${idx++}`);
      params.push(JSON.stringify(updates.variables));
    }
    if (updates.metadata !== undefined) {
      fields.push(`metadata = $${idx++}`);
      params.push(JSON.stringify(updates.metadata));
    }

    if (fields.length === 0) throw new Error('No valid fields to update');

    fields.push(`version = version + 1`);
    fields.push(`updated_at = NOW()`);
    params.push(templateId);

    const result = await pool.query(
      `UPDATE document_templates SET ${fields.join(', ')}
       WHERE template_id = $${idx}
       RETURNING *`,
      params
    );
    if (result.rows.length === 0) throw new Error(`Template ${templateId} not found`);
    return result.rows[0];
  }

  static async deleteTemplate(templateId) {
    const result = await pool.query(
      `UPDATE document_templates SET is_active = FALSE, updated_at = NOW()
       WHERE template_id = $1 RETURNING *`,
      [templateId]
    );
    if (result.rows.length === 0) throw new Error(`Template ${templateId} not found`);
    return result.rows[0];
  }

  static renderTemplate(bodyTemplate, variables) {
    let rendered = bodyTemplate;
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      rendered = rendered.replace(pattern, String(value));
    }
    return rendered;
  }

  static async previewTemplate(templateId, variables) {
    const template = await TemplateEngine.getTemplate(templateId);
    if (!template) throw new Error(`Template ${templateId} not found`);

    const rendered = TemplateEngine.renderTemplate(template.body_template, variables || {});

    let header = '';
    if (template.header_template) {
      header = TemplateEngine.renderTemplate(template.header_template, variables || {});
    }
    let footer = '';
    if (template.footer_template) {
      footer = TemplateEngine.renderTemplate(template.footer_template, variables || {});
    }

    return {
      template_id: template.template_id,
      template_name: template.template_name,
      rendered_header: header || null,
      rendered_body: rendered,
      rendered_footer: footer || null,
      variables_used: variables || {},
      generated_at: new Date().toISOString(),
    };
  }

  static extractVariables(bodyTemplate) {
    const matches = bodyTemplate.match(/\{\{(\w+)\}\}/g) || [];
    return [...new Set(matches.map(m => m.replace(/[{}]/g, '')))];
  }

  static async cloneTemplate(templateId, { newName, createdBy } = {}) {
    const original = await TemplateEngine.getTemplate(templateId);
    if (!original) throw new Error(`Template ${templateId} not found`);

    return TemplateEngine.createTemplate({
      templateName: newName || `${original.template_name} (Copy)`,
      templateType: original.template_type,
      category: original.category,
      description: original.description,
      bodyTemplate: original.body_template,
      headerTemplate: original.header_template,
      footerTemplate: original.footer_template,
      variables: original.variables,
      metadata: original.metadata,
      isDefault: false,
      createdBy: createdBy || null,
    });
  }
}

module.exports = { TemplateEngine };

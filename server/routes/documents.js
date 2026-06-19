/**
 * Document Management Routes — dlbtrust.cloud
 * Mounts at: /api/documents
 *
 * Document templates, document management, and document generation.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { TemplateEngine } = require('../integrations/documents/templateEngine');
const { DocumentEngine } = require('../integrations/documents/documentEngine');
const { GenerationEngine } = require('../integrations/documents/generationEngine');

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/documents/templates ─────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  try {
    const templates = await TemplateEngine.listTemplates({
      templateType: req.query.type,
      category: req.query.category,
      isActive: req.query.active !== undefined ? req.query.active === 'true' : undefined,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: templates.length, data: templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/documents/templates ────────────────────────────────────────────
router.post('/templates', async (req, res) => {
  const { templateName, templateType, bodyTemplate } = req.body;
  if (!templateName || !templateType || !bodyTemplate) {
    return res.status(400).json({ error: 'Required: templateName, templateType, bodyTemplate' });
  }
  try {
    const template = await TemplateEngine.createTemplate(req.body);
    res.json({ success: true, data: template });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/documents/templates/:id ─────────────────────────────────────────
router.get('/templates/:id', async (req, res) => {
  try {
    const template = await TemplateEngine.getTemplate(req.params.id);
    if (!template) return res.status(404).json({ success: false, error: `Template ${req.params.id} not found` });
    res.json({ success: true, data: template });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /api/documents/templates/:id ─────────────────────────────────────────
router.put('/templates/:id', async (req, res) => {
  try {
    const template = await TemplateEngine.updateTemplate(req.params.id, req.body);
    res.json({ success: true, data: template });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/documents/templates/:id ──────────────────────────────────────
router.delete('/templates/:id', async (req, res) => {
  try {
    const template = await TemplateEngine.deleteTemplate(req.params.id);
    res.json({ success: true, data: template });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/documents/templates/:id/preview ────────────────────────────────
router.post('/templates/:id/preview', async (req, res) => {
  try {
    const preview = await TemplateEngine.previewTemplate(req.params.id, req.body.variables || {});
    res.json({ success: true, data: preview });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/documents/templates/:id/clone ──────────────────────────────────
router.post('/templates/:id/clone', async (req, res) => {
  try {
    const clone = await TemplateEngine.cloneTemplate(req.params.id, req.body);
    res.json({ success: true, data: clone });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/documents/stats ─────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const stats = await DocumentEngine.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/documents ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const docs = await DocumentEngine.listDocuments({
      documentType: req.query.type,
      category: req.query.category,
      bondId: req.query.bondId,
      contactId: req.query.contactId,
      status: req.query.status,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: docs.length, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/documents ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { documentName, documentType } = req.body;
  if (!documentName || !documentType) {
    return res.status(400).json({ error: 'Required: documentName, documentType' });
  }
  try {
    const doc = await DocumentEngine.createDocument(req.body);
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/documents/:id ──────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const doc = await DocumentEngine.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: `Document ${req.params.id} not found` });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /api/documents/:id ──────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const doc = await DocumentEngine.updateDocument(req.params.id, req.body);
    res.json({ success: true, data: doc });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/documents/:id/archive ─────────────────────────────────────────
router.post('/:id/archive', async (req, res) => {
  try {
    const doc = await DocumentEngine.archiveDocument(req.params.id);
    res.json({ success: true, data: doc });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /api/documents/generation/stats ──────────────────────────────────────
router.get('/generation/stats', async (req, res) => {
  try {
    const stats = await GenerationEngine.getGenerationStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/documents/generate ────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  const { templateId } = req.body;
  if (!templateId) {
    return res.status(400).json({ error: 'Required: templateId' });
  }
  try {
    const gen = await GenerationEngine.generate(req.body);
    res.json({ success: true, data: gen });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/documents/generate/bond-package ───────────────────────────────
router.post('/generate/bond-package', async (req, res) => {
  const { bondId } = req.body;
  if (!bondId) {
    return res.status(400).json({ error: 'Required: bondId' });
  }
  try {
    const results = await GenerationEngine.generateBondPackage(
      req.body.bondId, req.body.contactId, { generatedBy: req.body.generatedBy }
    );
    res.json({ success: true, count: results.length, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/documents/generations ──────────────────────────────────────────
router.get('/generations', async (req, res) => {
  try {
    const gens = await GenerationEngine.listGenerations({
      templateId: req.query.templateId,
      bondId: req.query.bondId,
      contactId: req.query.contactId,
      status: req.query.status,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: gens.length, data: gens });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/documents/generations/:id ──────────────────────────────────────
router.get('/generations/:id', async (req, res) => {
  try {
    const gen = await GenerationEngine.getGeneration(req.params.id);
    if (!gen) return res.status(404).json({ success: false, error: `Generation ${req.params.id} not found` });
    res.json({ success: true, data: gen });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

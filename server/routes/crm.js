/**
 * CRM Routes — dlbtrust.cloud
 * Mounts at: /api/crm
 *
 * Contact management, KYC/AML tracking, interactions, and bond subscriptions.
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { CrmEngine } = require('../integrations/crm/crmEngine');

// ─── GET /api/crm/dashboard ──────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await CrmEngine.getDashboard();
    res.json({ success: true, data: dashboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/crm/contacts ───────────────────────────────────────────────────
router.get('/contacts', async (req, res) => {
  try {
    const contacts = await CrmEngine.listContacts({
      contactType: req.query.type,
      kycStatus: req.query.kycStatus,
      amlStatus: req.query.amlStatus,
      status: req.query.status,
      search: req.query.search,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: contacts.length, data: contacts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/crm/contacts ──────────────────────────────────────────────────
router.post('/contacts', async (req, res) => {
  const contactType = req.body.contactType || req.body.contact_type;
  const firstName   = req.body.firstName   || req.body.first_name;
  const lastName    = req.body.lastName    || req.body.last_name;
  if (!contactType || !firstName || !lastName) {
    return res.status(400).json({ error: 'Required: contactType, firstName, lastName' });
  }
  req.body.contactType = contactType;
  req.body.firstName   = firstName;
  req.body.lastName    = lastName;
  try {
    const contact = await CrmEngine.createContact(req.body);
    res.json({ success: true, data: contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/crm/contacts/:id ───────────────────────────────────────────────
router.get('/contacts/:id', async (req, res) => {
  try {
    const contact = await CrmEngine.getContact(req.params.id);
    if (!contact) return res.status(404).json({ success: false, error: `Contact ${req.params.id} not found` });
    res.json({ success: true, data: contact });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /api/crm/contacts/:id ───────────────────────────────────────────────
router.put('/contacts/:id', async (req, res) => {
  try {
    const contact = await CrmEngine.updateContact(req.params.id, req.body);
    res.json({ success: true, data: contact });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/crm/contacts/:id/approve ──────────────────────────────────────
router.post('/contacts/:id/approve', async (req, res) => {
  try {
    const contact = await CrmEngine.approveContact(req.params.id, req.body.approvedBy || 'admin');
    res.json({ success: true, data: contact });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/crm/contacts/:id/reject ───────────────────────────────────────
router.post('/contacts/:id/reject', async (req, res) => {
  try {
    const contact = await CrmEngine.rejectContact(req.params.id, req.body.rejectedBy || 'admin', req.body.reason);
    res.json({ success: true, data: contact });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/crm/contacts/:id/kyc ──────────────────────────────────────────
router.post('/contacts/:id/kyc', async (req, res) => {
  const { kycStatus } = req.body;
  if (!kycStatus) return res.status(400).json({ error: 'Required: kycStatus' });
  try {
    const contact = await CrmEngine.updateKycStatus(req.params.id, kycStatus);
    res.json({ success: true, data: contact });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── POST /api/crm/contacts/:id/interactions ──────────────────────────────────
router.post('/contacts/:id/interactions', async (req, res) => {
  const { interactionType } = req.body;
  if (!interactionType) return res.status(400).json({ error: 'Required: interactionType' });
  try {
    const interaction = await CrmEngine.logInteraction({ ...req.body, contactId: req.params.id });
    res.json({ success: true, data: interaction });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/crm/contacts/:id/interactions ───────────────────────────────────
router.get('/contacts/:id/interactions', async (req, res) => {
  try {
    const interactions = await CrmEngine.getInteractions(req.params.id, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, count: interactions.length, data: interactions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/crm/subscriptions ──────────────────────────────────────────────
router.get('/subscriptions', async (req, res) => {
  try {
    const subs = await CrmEngine.getBondSubscriptions({
      contactId: req.query.contactId,
      bondId: req.query.bondId,
      status: req.query.status,
    });
    res.json({ success: true, count: subs.length, data: subs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/crm/subscriptions ─────────────────────────────────────────────
router.post('/subscriptions', async (req, res) => {
  const { contactId, bondId, subscriptionAmount, settlementDate } = req.body;
  if (!contactId || !bondId || !subscriptionAmount || !settlementDate) {
    return res.status(400).json({ error: 'Required: contactId, bondId, subscriptionAmount, settlementDate' });
  }
  try {
    const sub = await CrmEngine.createBondSubscription(req.body);
    res.json({ success: true, data: sub });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/crm/sync-fineract ─────────────────────────────────────────────
// Bulk-sync all trustee/beneficiary contacts to Fineract
router.post('/sync-fineract', async (req, res) => {
  try {
    var result = await CrmEngine.syncToFineract();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/crm/fineract-linkage ───────────────────────────────────────────
// Show Fineract linkage status for trustees/beneficiaries
router.get('/fineract-linkage', async (req, res) => {
  try {
    var status = await CrmEngine.getFineractLinkageStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

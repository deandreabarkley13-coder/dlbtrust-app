/**
 * Vendor Routes — DLB Trust
 * Mounts at: /api/vendors
 *
 * Vendor registry, payment initiation, approval workflow, and execution.
 */

'use strict';

var express = require('express');
var router  = express.Router();
var { VendorEngine } = require('../integrations/vendors/vendorEngine');

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/dashboard', async function(req, res) {
  try {
    var dashboard = await VendorEngine.getDashboard();
    res.json({ success: true, data: dashboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VENDOR CRUD
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/', async function(req, res) {
  try {
    var vendors = await VendorEngine.listVendors({
      status: req.query.status,
      vendor_type: req.query.type,
      search: req.query.search,
    });
    res.json({ success: true, count: vendors.length, data: vendors });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:vendorId', async function(req, res) {
  try {
    var vendor = await VendorEngine.getVendor(req.params.vendorId);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    res.json({ success: true, data: vendor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/', async function(req, res) {
  try {
    if (!req.body.vendor_name) return res.status(400).json({ success: false, error: 'vendor_name is required' });
    var vendor = await VendorEngine.createVendor(req.body);
    res.json({ success: true, data: vendor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/:vendorId', async function(req, res) {
  try {
    var vendor = await VendorEngine.updateVendor(req.params.vendorId, req.body);
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    res.json({ success: true, data: vendor });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:vendorId', async function(req, res) {
  try {
    var deleted = await VendorEngine.deleteVendor(req.params.vendorId);
    if (!deleted) return res.status(404).json({ success: false, error: 'Vendor not found' });
    res.json({ success: true, message: 'Vendor deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/payments/list', async function(req, res) {
  try {
    var payments = await VendorEngine.listPayments({
      vendor_id: req.query.vendor_id,
      status: req.query.status,
      payment_method: req.query.method,
      limit: req.query.limit,
    });
    res.json({ success: true, count: payments.length, data: payments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/payments/:paymentId', async function(req, res) {
  try {
    var payment = await VendorEngine.getPayment(req.params.paymentId);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.json({ success: true, data: payment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/initiate', async function(req, res) {
  try {
    if (!req.body.vendor_id) return res.status(400).json({ success: false, error: 'vendor_id is required' });
    if (!req.body.amount || parseFloat(req.body.amount) <= 0) return res.status(400).json({ success: false, error: 'Valid amount is required' });
    var result = await VendorEngine.initiatePayment(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:paymentId/approve', async function(req, res) {
  try {
    var payment = await VendorEngine.approvePayment(req.params.paymentId, req.body.approved_by || 'admin');
    res.json({ success: true, data: payment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:paymentId/reject', async function(req, res) {
  try {
    var payment = await VendorEngine.rejectPayment(req.params.paymentId, req.body.rejected_by || 'admin', req.body.reason);
    res.json({ success: true, data: payment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:paymentId/execute', async function(req, res) {
  try {
    var result = await VendorEngine.executePayment(req.params.paymentId, req.body.executed_by || 'admin');
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

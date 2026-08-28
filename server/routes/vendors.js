/**
 * Vendor Routes — dlbtrust.cloud
 * Mounts at: /api/vendors
 *
 * Vendor registry, payment initiation, approval workflow, and execution.
 */

'use strict';

var express = require('express');
var router  = express.Router();
var pool = require('../integrations/bonds/pgPool');
var { VendorEngine } = require('../integrations/vendors/vendorEngine');
var { MelioEngine } = require('../integrations/os/osEngine');
var { CanonicalConsensusEngine } = require('../integrations/dapp/canonicalConsensusEngine');
var { requireAuth } = require('../integrations/auth/securityMiddleware');
var operatorAuth = requireAuth({ role: 'operator' });

router.use(operatorAuth);

function authenticatedActor(req) {
  var user = req.user || {};
  return user.email || user.username || user.userId || user.sub || 'authenticated-user';
}

function authenticatedTrustee(req) {
  var user = req.user || {};
  var activeRole = String(user.role || '').toLowerCase();
  var role = activeRole === 'trustee_maker'
    ? 'maker'
    : (activeRole === 'trustee_checker' ? 'checker' : '');
  if (!role || !user.email) {
    var error = new Error('An authenticated maker or checker role is required');
    error.status = 403;
    throw error;
  }
  return { role: role, approverEmail: user.email };
}

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
    var result = await VendorEngine.initiatePayment({
      ...req.body,
      initiated_by: authenticatedActor(req),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:paymentId/approve', async function(req, res) {
  try {
    var trustee = authenticatedTrustee(req);
    var payment = await VendorEngine.approvePayment(req.params.paymentId, {
      ...trustee,
      signature: req.body.signature,
    });
    res.json({ success: true, data: payment });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:paymentId/reject', async function(req, res) {
  try {
    var payment = await VendorEngine.rejectPayment(req.params.paymentId, authenticatedActor(req), req.body.reason);
    res.json({ success: true, data: payment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:paymentId/execute', async function(req, res) {
  try {
    var result = await VendorEngine.executePayment(req.params.paymentId, authenticatedActor(req));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:paymentId/process', async function(req, res) {
  try {
    var result = await VendorEngine.processPayment(req.params.paymentId, {
      executedBy: authenticatedActor(req),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.post('/payments/:paymentId/settle', async function(req, res) {
  try {
    var result = await VendorEngine.settlePayment(req.params.paymentId, {
      settlementReference: req.body.settlement_reference
        || req.body.settlementReference
        || req.body.reference,
      settledBy: authenticatedActor(req),
      settlementDate: req.body.settlement_date,
      buyerEmail: req.body.buyer_email,
      sellerEmail: req.body.seller_email,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/melio/export-batch', async function(req, res) {
  try {
    var result = await CanonicalConsensusEngine.createProposal({
      title: req.body.title || 'Melio vendor bill batch',
      description: req.body.description,
      category: 'vendor_bill',
      createdBy: authenticatedActor(req),
      payload: {
        ...req.body,
        action: undefined,
        payables: req.body.payables || req.body.items || req.body.rows,
      },
    });
    res.status(202).json({
      success: true,
      data: result,
      requiresApprovals: ['maker', 'checker'],
      paymentMode: 'manual_upload',
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message, invalidRows: err.invalidRows || undefined });
  }
});

router.get('/payments/melio/exports', operatorAuth, async function(req, res) {
  try {
    var data = await MelioEngine.listExports({ status: req.query.status, limit: req.query.limit });
    res.json({ success: true, count: data.length, data: data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.post('/payments/melio/:identifier/mark-submitted', operatorAuth, async function(req, res) {
  try {
    var result = await MelioEngine.process({
      action: 'markSubmitted',
      identifier: req.params.identifier,
      portalSubmissionReference: req.body.portal_submission_reference
        || req.body.portalSubmissionReference
        || req.body.reference,
      submittedAt: req.body.submitted_at || req.body.submittedAt,
      submittedBy: authenticatedActor(req),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.post('/payments/melio/:identifier/mark-paid', operatorAuth, async function(req, res) {
  try {
    var result = await MelioEngine.process({
      action: 'markPaid',
      identifier: req.params.identifier,
      settlementReference: req.body.settlement_reference || req.body.reference,
      settlementDate: req.body.settlement_date,
      settledBy: authenticatedActor(req),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.get('/payments/melio/:identifier/download', operatorAuth, async function(req, res) {
  try {
    var record = await MelioEngine.getExportFile(req.params.identifier);
    if (!record) return res.status(404).json({ success: false, error: 'Melio export not found' });
    var result = record.result || {};
    var filePath = result.csvPath;
    var fileName = result.fileName;
    var resolvedPath = MelioEngine._resolveExportPath(filePath, fileName);
    if (!resolvedPath) {
      return res.status(400).json({ success: false, error: 'Invalid Melio export file' });
    }
    var fs = require('fs');
    if (!fs.existsSync(resolvedPath)) return res.status(404).json({ success: false, error: 'Melio export file not found' });
    res.type('text/csv');
    res.attachment(fileName);
    fs.createReadStream(resolvedPath).on('error', function(err) {
      if (!res.headersSent) res.status(404).json({ success: false, error: err.message });
      else res.destroy(err);
    }).pipe(res);
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.post('/payments/melio/sync', async function(req, res) {
  try {
    var results = await VendorEngine.syncMelioPayments({
      autoSettle: req.body.auto_settle,
      max: req.body.max,
      executedBy: authenticatedActor(req),
      settledBy: authenticatedActor(req),
      settlementReference: req.body.settlement_reference,
      buyerEmail: req.body.buyer_email,
      sellerEmail: req.body.seller_email,
    });
    res.json({ success: true, count: results.length, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/melio/confirm-settlement', async function(req, res) {
  try {
    if (!req.body.melio_export_id && !req.body.payment_id) {
      return res.status(400).json({ success: false, error: 'melio_export_id or payment_id required' });
    }
    var result;
    if (req.body.melio_export_id) {
      result = await VendorEngine.settleByMelioExportId(req.body.melio_export_id, {
        settlementReference: req.body.settlement_reference || req.body.reference,
        settledBy: authenticatedActor(req),
        settlementDate: req.body.settlement_date,
        buyerEmail: req.body.buyer_email,
        sellerEmail: req.body.seller_email,
      });
    } else {
      result = await VendorEngine.settleMelioPayment(req.body.payment_id, {
        settlementReference: req.body.settlement_reference || req.body.reference,
        settledBy: authenticatedActor(req),
        settlementDate: req.body.settlement_date,
        buyerEmail: req.body.buyer_email,
        sellerEmail: req.body.seller_email,
      });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/melio/submit-invoice', async function(req, res) {
  try {
    var vendorPayload = req.body.vendor || {};
    var paymentPayload = req.body.payment || {};

    if (!vendorPayload.vendor_name && !paymentPayload.vendor_id) {
      return res.status(400).json({ success: false, error: 'vendor.vendor_name or payment.vendor_id required' });
    }
    if (!paymentPayload.amount || parseFloat(paymentPayload.amount) <= 0) {
      return res.status(400).json({ success: false, error: 'payment.amount required' });
    }

    var vendor;
    if (paymentPayload.vendor_id) {
      vendor = await VendorEngine.getVendor(paymentPayload.vendor_id);
      if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    } else {
      var existing = await VendorEngine.listVendors({ search: vendorPayload.vendor_name });
      vendor = existing.find(function(v) { return v.vendor_name.toUpperCase() === vendorPayload.vendor_name.toUpperCase(); });
      if (!vendor) {
        vendor = await VendorEngine.createVendor({
          vendor_name: vendorPayload.vendor_name,
          vendor_type: vendorPayload.vendor_type || 'consultant',
          contact_name: vendorPayload.contact_name || vendorPayload.vendor_name,
          contact_email: vendorPayload.contact_email || null,
          address: vendorPayload.address || null,
          tax_id: vendorPayload.tax_id || null,
          bank_name: vendorPayload.bank_name || null,
          routing_number: vendorPayload.routing_number || null,
          account_number: vendorPayload.account_number || null,
          account_type: vendorPayload.account_type || 'checking',
          payment_method: 'melio',
          auto_approve: false,
          notes: vendorPayload.notes || null,
        });
      }
    }

    var initiated = await VendorEngine.initiatePayment({
      vendor_id: vendor.vendor_id,
      amount: parseFloat(paymentPayload.amount),
      source_type: paymentPayload.source_type || 'trust',
      source_account_code: paymentPayload.source_account_code || '1000',
      payment_method: 'melio',
      payment_type: paymentPayload.payment_type || 'trust_expense',
      description: paymentPayload.description || `Invoice from ${vendor.vendor_name}`,
      invoice_number: paymentPayload.invoice_number || `INV-${Date.now()}`,
      invoice_date: paymentPayload.invoice_date || new Date().toISOString().slice(0, 10),
      due_date: paymentPayload.due_date || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      initiated_by: authenticatedActor(req),
    });

    res.status(202).json({
      success: true,
      data: {
        vendor,
        initiated,
        requiresApprovals: ['maker', 'checker'],
        paymentMode: 'manual_export',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/nickel/submit-invoice', async function(req, res) {
  try {
    var vendorPayload = req.body.vendor || {};
    var paymentPayload = req.body.payment || {};

    if (!vendorPayload.vendor_name && !paymentPayload.vendor_id) {
      return res.status(400).json({ success: false, error: 'vendor.vendor_name or payment.vendor_id required' });
    }
    if (!paymentPayload.amount || parseFloat(paymentPayload.amount) <= 0) {
      return res.status(400).json({ success: false, error: 'payment.amount required' });
    }

    var vendor;
    if (paymentPayload.vendor_id) {
      vendor = await VendorEngine.getVendor(paymentPayload.vendor_id);
      if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });
    } else {
      var existing = await VendorEngine.listVendors({ search: vendorPayload.vendor_name });
      vendor = existing.find(function(v) { return v.vendor_name.toUpperCase() === vendorPayload.vendor_name.toUpperCase(); });
      if (!vendor) {
        vendor = await VendorEngine.createVendor({
          vendor_name: vendorPayload.vendor_name,
          vendor_type: vendorPayload.vendor_type || 'consultant',
          contact_name: vendorPayload.contact_name || vendorPayload.vendor_name,
          contact_email: vendorPayload.contact_email || null,
          address: vendorPayload.address || null,
          tax_id: vendorPayload.tax_id || null,
          bank_name: vendorPayload.bank_name || null,
          routing_number: vendorPayload.routing_number || null,
          account_number: vendorPayload.account_number || null,
          account_type: vendorPayload.account_type || 'checking',
          payment_method: 'nickel',
          auto_approve: false,
          notes: vendorPayload.notes || null,
        });
      }
    }

    var initiated = await VendorEngine.initiatePayment({
      vendor_id: vendor.vendor_id,
      amount: parseFloat(paymentPayload.amount),
      source_type: paymentPayload.source_type || 'trust',
      source_account_code: paymentPayload.source_account_code || '4000',
      payment_method: 'nickel',
      payment_type: paymentPayload.payment_type || 'fee_payment',
      description: paymentPayload.description || `Invoice from ${vendor.vendor_name}`,
      invoice_number: paymentPayload.invoice_number || `INV-${Date.now()}`,
      invoice_date: paymentPayload.invoice_date || new Date().toISOString().slice(0, 10),
      due_date: paymentPayload.due_date || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      initiated_by: authenticatedActor(req),
    });

    res.status(202).json({
      success: true,
      data: {
        vendor,
        initiated,
        requiresApprovals: ['maker', 'checker'],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/payments/nickel/confirm-settlement', async function(req, res) {
  try {
    if (!req.body.payment_id && !req.body.nickel_payment_id && !req.body.bill_payment_id) {
      return res.status(400).json({ success: false, error: 'payment_id, nickel_payment_id, or bill_payment_id required' });
    }
    var paymentId = req.body.payment_id;
    if (!paymentId && req.body.bill_payment_id) {
      var matched = await pool.query(`SELECT payment_id FROM vendor_payments WHERE bill_payment_id = $1 AND payment_method = 'nickel' LIMIT 1`, [req.body.bill_payment_id]);
      if (matched.rowCount === 0) throw new Error('No nickel vendor payment found for bill_payment_id ' + req.body.bill_payment_id);
      paymentId = matched.rows[0].payment_id;
    }
    if (!paymentId && req.body.nickel_payment_id) {
      var matched2 = await pool.query(`SELECT payment_id FROM vendor_payments WHERE bill_payment_id = $1 AND payment_method = 'nickel' LIMIT 1`, [req.body.nickel_payment_id]);
      if (matched2.rowCount === 0) throw new Error('No nickel vendor payment found for nickel_payment_id ' + req.body.nickel_payment_id);
      paymentId = matched2.rows[0].payment_id;
    }
    var result = await VendorEngine.settleNickelPayment(paymentId, {
      settlementReference: req.body.settlement_reference || req.body.reference,
      settledBy: authenticatedActor(req),
      settlementDate: req.body.settlement_date,
      buyerEmail: req.body.buyer_email,
      sellerEmail: req.body.seller_email,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

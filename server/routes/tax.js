/**
 * Tax Engine Routes — DLB Trust Platform
 * Mounts at: /api/tax
 *
 * Form 1041 computation, K-1 generation, tax payments, and trust config.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { TaxEngine } = require('../integrations/tax/taxEngine');

// ─── Dashboard ──────────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await TaxEngine.getDashboard(req.query.year ? parseInt(req.query.year, 10) : undefined);
    res.json({ success: true, data: dashboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Trust Configuration ────────────────────────────────────────────────────

router.get('/config', async (req, res) => {
  try {
    const config = await TaxEngine.getAllConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/config/:key', async (req, res) => {
  try {
    const { value, description } = req.body;
    if (!value) return res.status(400).json({ success: false, error: 'value is required' });
    await TaxEngine.setConfig(req.params.key, value, description);
    res.json({ success: true, data: { key: req.params.key, value } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Form 1041 ──────────────────────────────────────────────────────────────

router.post('/1041/compute', async (req, res) => {
  try {
    const { taxYear } = req.body;
    if (!taxYear) return res.status(400).json({ success: false, error: 'taxYear is required' });
    const result = await TaxEngine.computeForm1041(parseInt(taxYear, 10));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/1041/returns', async (req, res) => {
  try {
    const returns = await TaxEngine.listReturns({
      taxYear: req.query.year ? parseInt(req.query.year, 10) : undefined,
      status: req.query.status,
    });
    res.json({ success: true, count: returns.length, data: returns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/1041/returns/:returnId', async (req, res) => {
  try {
    const taxReturn = await TaxEngine.getReturn(req.params.returnId);
    if (!taxReturn) return res.status(404).json({ success: false, error: 'Return not found' });
    res.json({ success: true, data: taxReturn });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── K-1 Schedules ──────────────────────────────────────────────────────────

router.post('/k1/generate', async (req, res) => {
  try {
    const { returnId } = req.body;
    if (!returnId) return res.status(400).json({ success: false, error: 'returnId is required' });
    const result = await TaxEngine.generateK1s(returnId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/k1/:returnId', async (req, res) => {
  try {
    const k1s = await TaxEngine.getK1sForReturn(req.params.returnId);
    res.json({ success: true, count: k1s.length, data: k1s });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/k1/detail/:k1Id', async (req, res) => {
  try {
    const k1 = await TaxEngine.getK1(req.params.k1Id);
    if (!k1) return res.status(404).json({ success: false, error: 'K-1 not found' });
    res.json({ success: true, data: k1 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/k1/:k1Id/allocation', async (req, res) => {
  try {
    const { allocationPercentage } = req.body;
    if (allocationPercentage === undefined) {
      return res.status(400).json({ success: false, error: 'allocationPercentage is required' });
    }
    const k1 = await TaxEngine.updateK1Allocation(req.params.k1Id, parseFloat(allocationPercentage));
    res.json({ success: true, data: k1 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Tax Payments ───────────────────────────────────────────────────────────

router.post('/payments', async (req, res) => {
  try {
    const { taxYear, quarter, paymentType, amount, paymentDate } = req.body;
    if (!taxYear || !paymentType || !amount || !paymentDate) {
      return res.status(400).json({ success: false, error: 'Required: taxYear, paymentType, amount, paymentDate' });
    }
    const payment = await TaxEngine.recordPayment(req.body);
    res.json({ success: true, data: payment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/payments/:year', async (req, res) => {
  try {
    const payments = await TaxEngine.listPayments(parseInt(req.params.year, 10));
    res.json({ success: true, count: payments.length, data: payments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Income Aggregation (preview) ───────────────────────────────────────────

router.get('/income/:year', async (req, res) => {
  try {
    const result = await TaxEngine.aggregateIncome(parseInt(req.params.year, 10));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

/**
 * Virtual Account Routes
 * 
 * Mounts at: /api/virtual-accounts
 * 
 * Manages virtual bank accounts that map to platform trust accounts.
 * Each virtual account has its own routing/account number and can
 * send/receive external ACH and wire payments.
 * 
 * Endpoints:
 *   GET    /api/virtual-accounts              - List all virtual accounts
 *   GET    /api/virtual-accounts/:id          - Get virtual account detail
 *   POST   /api/virtual-accounts/backfill     - Generate VAs for existing accounts
 *   POST   /api/virtual-accounts/:id/send     - Send external payment from VA
 *   GET    /api/virtual-accounts/:id/transactions - Transaction history
 *   GET    /api/virtual-accounts/lookup/:number   - Lookup VA by account number
 *   GET    /api/virtual-accounts/summary      - Summary stats
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const {
  initVirtualAccountSchema,
  listVirtualAccounts,
  getVirtualAccountByPlatformId,
  getVirtualAccountByNumber,
  backfillVirtualAccounts,
  sendExternalPayment,
  getTransactionHistory,
  PLATFORM_BANK_NAME,
  PLATFORM_ROUTING,
  SETTLEMENT_BANK_NAME,
  SETTLEMENT_ROUTING,
  SETTLEMENT_ACCOUNT,
  ORIGINATOR_NAME,
} = require('../engines/virtual-account-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

// --- Middleware: DB per-request ---------------------------------------------

router.use((req, res, next) => {
  try {
    req.db = getDb();
    initVirtualAccountSchema(req.db);
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// ─── GET / — List all virtual accounts ────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const { status, account_type } = req.query;
    const accounts = listVirtualAccounts(req.db, { status, account_type });
    
    res.json({
      accounts,
      count: accounts.length,
      platform_bank: PLATFORM_BANK_NAME,
      platform_routing: PLATFORM_ROUTING,
      settlement_bank: SETTLEMENT_BANK_NAME,
      settlement_routing: SETTLEMENT_ROUTING,
      originator: ORIGINATOR_NAME,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /summary — Virtual account statistics ────────────────────────────────

router.get('/summary', (req, res) => {
  try {
    const accounts = listVirtualAccounts(req.db, { status: 'active' });
    const totalSent = accounts.reduce((sum, a) => sum + a.total_sent_cents, 0);
    const totalReceived = accounts.reduce((sum, a) => sum + a.total_received_cents, 0);
    const totalTx = accounts.reduce((sum, a) => sum + a.transaction_count, 0);

    res.json({
      active_accounts: accounts.length,
      total_sent_usd: (totalSent / 100).toFixed(2),
      total_received_usd: (totalReceived / 100).toFixed(2),
      total_transactions: totalTx,
      platform_bank: PLATFORM_BANK_NAME,
      platform_routing: PLATFORM_ROUTING,
      settlement_bank: SETTLEMENT_BANK_NAME,
      settlement_routing: SETTLEMENT_ROUTING,
      originator: ORIGINATOR_NAME,
      capabilities: ['ach_send', 'ach_receive', 'wire_send', 'wire_receive', 'internal_transfer'],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /backfill — Generate VAs for all existing accounts ──────────────────

router.post('/backfill', (req, res) => {
  try {
    const result = backfillVirtualAccounts(req.db);
    res.json({
      success: true,
      message: `Generated ${result.backfilled} virtual accounts for existing platform accounts`,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /lookup/:number — Find VA by account number ──────────────────────────

router.get('/lookup/:number', (req, res) => {
  try {
    const va = getVirtualAccountByNumber(req.db, req.params.number);
    if (!va) return res.status(404).json({ error: 'Virtual account not found' });
    res.json(va);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /:id — Virtual account detail ────────────────────────────────────────

router.get('/:id', (req, res) => {
  try {
    const va = req.db.prepare('SELECT * FROM virtual_accounts WHERE id = ?').get(req.params.id);
    if (!va) return res.status(404).json({ error: 'Virtual account not found' });
    
    va.capabilities = JSON.parse(va.capabilities || '[]');
    va.payment_details = {
      bank_name: va.bank_name,
      routing_number: va.routing_number,
      account_number: va.account_number,
      account_type: va.account_type,
      beneficiary_name: va.owner_name,
    };

    // Get recent transactions
    const transactions = getTransactionHistory(req.db, va.id, 20);
    
    res.json({ ...va, recent_transactions: transactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /:id/send — Send external payment from virtual account ──────────────

/**
 * Body: {
 *   recipient_name: "John Smith",
 *   routing_number: "021000021",
 *   account_number: "123456789",
 *   account_type: "checking",
 *   amount: "500.00",           // or amount_cents: 50000
 *   type: "ach",                // ach or wire
 *   description: "Vendor payment",
 *   reference: "INV-2026-001"
 * }
 */
router.post('/:id/send', async (req, res) => {
  try {
    const { recipient_name, routing_number, account_number, amount, amount_cents } = req.body;

    // Validate
    if (!recipient_name) return res.status(400).json({ error: 'recipient_name is required' });
    if (!routing_number || !/^\d{9}$/.test(routing_number)) {
      return res.status(400).json({ error: 'routing_number must be 9 digits' });
    }
    if (!account_number) return res.status(400).json({ error: 'account_number is required' });
    if (!amount && !amount_cents) return res.status(400).json({ error: 'amount or amount_cents required' });

    const result = await sendExternalPayment(req.db, req.params.id, req.body);
    
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /:id/transactions — Transaction history ──────────────────────────────

router.get('/:id/transactions', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50');
    const transactions = getTransactionHistory(req.db, req.params.id, limit);
    res.json({ transactions, count: transactions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

/**
 * Banking ↔ Crypto Bridge Routes
 * DEANDREA LAVAR BARKLEY TRUST — Real Money Movement via MoonPay + Polygon
 *
 * Endpoints:
 *   GET    /api/bridge/dashboard              - Bridge metrics and status
 *   GET    /api/bridge/orders                 - List bridge orders
 *   GET    /api/bridge/orders/:id             - Order detail
 *   POST   /api/bridge/bank-to-crypto         - Initiate bank → crypto conversion
 *   POST   /api/bridge/crypto-to-bank         - Initiate crypto → bank sweep
 *   POST   /api/bridge/orders/:id/approve     - Approve a pending order
 *   POST   /api/bridge/orders/:id/cancel      - Cancel an order
 *   GET    /api/bridge/quote                  - Get conversion quote
 *   GET    /api/bridge/moonpay-status         - MoonPay configuration status
 *   POST   /api/bridge/webhook/moonpay        - MoonPay webhook receiver
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const { MoonPayClient, BridgeOrderManager, logWebhookEvent, MOONPAY_STATUS_MAP } = require('../engines/moonpay-engine');
const { engine, PIPELINES, TRIGGER_TYPES } = require('../engines/integration-engine');
const { bus } = require('../engines/event-bus');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

router.use((req, res, next) => {
  try {
    req.db = getDb();
    req.db.pragma('journal_mode = WAL');
    if (!schemaInitialized) {
      // Run bridge schema
      const bridgeSchema = path.join(__dirname, '..', 'db', 'migrations', 'banking-crypto-bridge-schema.sql');
      if (fs.existsSync(bridgeSchema)) {
        try { req.db.exec(fs.readFileSync(bridgeSchema, 'utf8')); } catch (_) {}
      }
      // Also ensure dependent schemas exist
      const deps = ['banking-schema.sql', 'blockchain-schema.sql', 'trust-accounting-schema.sql'];
      for (const file of deps) {
        const p = path.join(__dirname, '..', 'db', 'migrations', file);
        if (fs.existsSync(p)) { try { req.db.exec(fs.readFileSync(p, 'utf8')); } catch (_) {} }
      }
      schemaInitialized = true;
    }
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close', () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed: ' + err.message });
  }
});

// --- GET /dashboard -- Bridge overview metrics ------------------------------

router.get('/dashboard', (req, res) => {
  try {
    const bridgeMgr = new BridgeOrderManager(req.db);
    const moonpay = new MoonPayClient();
    const stats = bridgeMgr.getStats();

    // Get accounts available for bridging
    let accounts = [];
    try {
      accounts = req.db.prepare("SELECT id, account_name, account_type, balance_cents, available_cents FROM trust_accounts WHERE status = 'active'").all();
    } catch (_) {}

    // Get wallets available as destinations
    let wallets = [];
    try {
      wallets = req.db.prepare("SELECT id, wallet_name, wallet_type, address, usdc_balance, blockchain, status FROM blockchain_wallets WHERE status = 'active'").all();
    } catch (_) {}

    res.json({
      bridge: stats,
      moonpay_configured: moonpay.isConfigured(),
      accounts: accounts.map(a => ({
        ...a,
        balance_usd: (a.balance_cents / 100).toFixed(2),
        available_usd: (a.available_cents / 100).toFixed(2),
      })),
      wallets: wallets.map(w => ({
        ...w,
        usdc_balance: parseFloat(w.usdc_balance || '0').toFixed(2),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /orders -- List bridge orders --------------------------------------

router.get('/orders', (req, res) => {
  try {
    const bridgeMgr = new BridgeOrderManager(req.db);
    const filters = {};
    if (req.query.direction) filters.direction = req.query.direction;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.limit) filters.limit = req.query.limit;
    const orders = bridgeMgr.listOrders(filters);
    res.json({ count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /orders/:id -- Order detail ----------------------------------------

router.get('/orders/:id', (req, res) => {
  try {
    const bridgeMgr = new BridgeOrderManager(req.db);
    const order = bridgeMgr.getOrder(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /bank-to-crypto -- Fund wallet from banking balance ---------------

router.post('/bank-to-crypto', async (req, res) => {
  try {
    const { source_account_id, destination_wallet_id, amount, destination_address, notes } = req.body;
    if (!source_account_id) return res.status(400).json({ error: 'source_account_id required' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Valid amount required' });
    if (!destination_wallet_id && !destination_address) {
      return res.status(400).json({ error: 'destination_wallet_id or destination_address required' });
    }

    const amountCents = Math.round(parseFloat(amount) * 100);

    const trigger = { type: TRIGGER_TYPES.UI, source: 'bridge_api' };
    const result = await engine.executePipeline('BANK_TO_CRYPTO', req.db, {
      source_account_id: parseInt(source_account_id),
      destination_wallet_id: destination_wallet_id ? parseInt(destination_wallet_id) : null,
      amount_cents: amountCents,
      destination_address: destination_address || null,
      notes,
    }, trigger);

    if (result.status === 'failed') {
      return res.status(400).json({ error: result.error, execution: result.toJSON() });
    }

    res.status(201).json({
      success: true,
      message: `$${amount} conversion initiated from banking to crypto`,
      execution: result.toJSON(),
      order: result.results.order,
    });
  } catch (err) {
    res.status(500).json({ error: 'Bridge execution failed: ' + err.message });
  }
});

// --- POST /crypto-to-bank -- Sweep crypto to banking balance ----------------

router.post('/crypto-to-bank', async (req, res) => {
  try {
    const { source_wallet_id, destination_account_id, amount, notes } = req.body;
    if (!source_wallet_id) return res.status(400).json({ error: 'source_wallet_id required' });
    if (!destination_account_id) return res.status(400).json({ error: 'destination_account_id required' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Valid amount required' });

    const trigger = { type: TRIGGER_TYPES.UI, source: 'bridge_api' };
    const result = await engine.executePipeline('CRYPTO_TO_BANK', req.db, {
      source_wallet_id: parseInt(source_wallet_id),
      destination_account_id: parseInt(destination_account_id),
      amount_usdc: amount.toString(),
      notes,
    }, trigger);

    if (result.status === 'failed') {
      return res.status(400).json({ error: result.error, execution: result.toJSON() });
    }

    res.status(201).json({
      success: true,
      message: `$${amount} USDC sweep to banking initiated`,
      execution: result.toJSON(),
      order: result.results.order,
    });
  } catch (err) {
    res.status(500).json({ error: 'Bridge execution failed: ' + err.message });
  }
});

// --- POST /orders/:id/approve -- Approve a pending order --------------------

router.post('/orders/:id/approve', (req, res) => {
  try {
    const bridgeMgr = new BridgeOrderManager(req.db);
    const order = bridgeMgr.getOrder(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending_approval') {
      return res.status(400).json({ error: `Cannot approve order in status: ${order.status}` });
    }

    const updated = bridgeMgr.updateStatus(order.id, 'approved', {
      approvedBy: req.body.approved_by || 'trustee',
    });

    bus.emit('bridge.order.approved', { order_id: order.id, order_number: order.order_number });
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /orders/:id/cancel -- Cancel an order -----------------------------

router.post('/orders/:id/cancel', (req, res) => {
  try {
    const bridgeMgr = new BridgeOrderManager(req.db);
    const order = bridgeMgr.getOrder(parseInt(req.params.id));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['completed', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot cancel order in status: ${order.status}` });
    }

    // Reverse the debit if bank_to_crypto
    if (order.direction === 'bank_to_crypto' && order.source_account_id) {
      req.db.prepare(`
        UPDATE trust_accounts SET
          balance_cents = balance_cents + ?, available_cents = available_cents + ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(order.fiat_amount_cents, order.fiat_amount_cents, order.source_account_id);
    }

    // Reverse wallet debit if crypto_to_bank
    if (order.direction === 'crypto_to_bank' && order.source_wallet_id && order.crypto_amount) {
      req.db.prepare(`
        UPDATE blockchain_wallets SET usdc_balance = CAST(CAST(usdc_balance AS REAL) + ? AS TEXT), updated_at = datetime('now') WHERE id = ?
      `).run(parseFloat(order.crypto_amount || order.fiat_amount_cents / 100), order.source_wallet_id);
    }

    const updated = bridgeMgr.updateStatus(order.id, 'cancelled', {
      errorMessage: req.body.reason || 'Cancelled by user',
    });

    bus.emit('bridge.order.cancelled', { order_id: order.id });
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /quote -- Get conversion quote ------------------------------------

router.get('/quote', async (req, res) => {
  try {
    const { amount, direction } = req.query;
    if (!amount) return res.status(400).json({ error: 'amount required' });

    const moonpay = new MoonPayClient();
    const amountNum = parseFloat(amount);

    // USDC is pegged 1:1 to USD, so the conversion rate is always 1.00
    // MoonPay charges a small fee (~1-4.5% depending on payment method)
    const quote = {
      input_amount: amountNum.toFixed(2),
      output_amount: amountNum.toFixed(2), // 1:1 peg
      exchange_rate: '1.000000',
      direction: direction || 'bank_to_crypto',
      currency_in: direction === 'crypto_to_bank' ? 'USDC' : 'USD',
      currency_out: direction === 'crypto_to_bank' ? 'USD' : 'USDC',
      network: 'Polygon',
      estimated_fee_pct: moonpay.isConfigured() ? '3.25' : '0.00',
      estimated_fee_usd: moonpay.isConfigured() ? (amountNum * 0.0325).toFixed(2) : '0.00',
      moonpay_configured: moonpay.isConfigured(),
      note: moonpay.isConfigured()
        ? 'MoonPay processes the conversion. Fee varies by payment method (1-4.5%).'
        : 'Ledger-only mode: 1:1 conversion between bank balance and crypto wallet (no fees, no on-chain movement).',
    };

    // If MoonPay is configured, try to get a real quote
    if (moonpay.isConfigured() && direction !== 'crypto_to_bank') {
      try {
        const mpQuote = await moonpay.getBuyQuote({ baseCurrencyAmount: amountNum });
        if (mpQuote && mpQuote.quoteCurrencyAmount) {
          quote.output_amount = mpQuote.quoteCurrencyAmount.toFixed(2);
          quote.estimated_fee_usd = (mpQuote.feeAmount || 0).toFixed(2);
          quote.moonpay_quote = mpQuote;
        }
      } catch (_) {
        // Fall back to estimate
      }
    }

    res.json({ quote });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /moonpay-status -- MoonPay configuration status --------------------

router.get('/moonpay-status', (req, res) => {
  const moonpay = new MoonPayClient();
  res.json({
    configured: moonpay.isConfigured(),
    has_api_key: !!(process.env.MOONPAY_API_KEY),
    has_secret_key: !!(process.env.MOONPAY_SECRET_KEY),
    mode: moonpay.isConfigured() ? 'live' : 'ledger_only',
    note: moonpay.isConfigured()
      ? 'MoonPay is configured. Real USD→USDC conversions will be processed through MoonPay.'
      : 'MoonPay not configured. Operating in ledger-only mode (1:1 balance transfer between bank and crypto).',
  });
});

// --- POST /webhook/moonpay -- MoonPay webhook handler -----------------------

router.post('/webhook/moonpay', (req, res) => {
  try {
    const moonpay = new MoonPayClient();
    const signature = req.headers['moonpay-signature-v2'] || req.headers['moonpay-signature'];

    // Verify webhook signature if secret is configured
    if (process.env.MOONPAY_WEBHOOK_SECRET && signature) {
      const rawBody = JSON.stringify(req.body);
      if (!moonpay.verifyWebhookSignature(rawBody, signature)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const { type, data } = req.body;
    const txn = data || req.body;

    // Log the webhook event
    logWebhookEvent(req.db, {
      eventType: type || 'transaction_updated',
      transactionId: txn.id || txn.transactionId,
      status: txn.status,
      cryptoAmount: txn.cryptoTransactionId ? txn.quoteCurrencyAmount : null,
      fiatAmount: txn.baseCurrencyAmount ? txn.baseCurrencyAmount.toString() : null,
      walletAddress: txn.walletAddress,
      txHash: txn.cryptoTransactionId,
      rawPayload: req.body,
    });

    // Find matching bridge order
    const bridgeMgr = new BridgeOrderManager(req.db);
    const externalId = txn.externalTransactionId || txn.externalCustomerId;
    let order = null;
    if (txn.id) order = bridgeMgr.getOrderByMoonPayTxn(txn.id);
    if (!order && externalId) order = bridgeMgr.getOrderByNumber(externalId);

    if (order) {
      const mappedStatus = MOONPAY_STATUS_MAP[txn.status] || txn.status;
      bridgeMgr.updateStatus(order.id, mappedStatus, {
        moonpayTransactionId: txn.id,
        moonpayStatus: txn.status,
        moonpayCryptoTxHash: txn.cryptoTransactionId || null,
        cryptoAmount: txn.quoteCurrencyAmount ? txn.quoteCurrencyAmount.toString() : null,
      });

      // If completed and bank_to_crypto, update wallet balance
      if (txn.status === 'completed' && order.direction === 'bank_to_crypto' && order.destination_wallet_id) {
        const cryptoAmt = txn.quoteCurrencyAmount || (order.fiat_amount_cents / 100);
        req.db.prepare(`
          UPDATE blockchain_wallets SET usdc_balance = CAST(CAST(usdc_balance AS REAL) + ? AS TEXT), updated_at = datetime('now') WHERE id = ?
        `).run(cryptoAmt, order.destination_wallet_id);
      }

      bus.emit('bridge.moonpay.webhook', { order_id: order.id, status: txn.status });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Bridge Webhook] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

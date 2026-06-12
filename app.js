/**
 * dlbtrust-app — Express Application Entry Point
 * DEANDREA LAVAR BARKLEY TRUST — Secure Wealth Management Portal
 *
 * Production entry point for Fly.io deployment.
 * All routes, DB init, and middleware configured here.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const app     = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS for API consumers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Database ─────────────────────────────────────────────────────────────────
const db = require('./server/db');
app.locals.db = db;

// ─── Core API Routes ──────────────────────────────────────────────────────────

// Dashboard
app.get('/api/dashboard', (req, res) => {
  try {
    const profile = db.prepare('SELECT * FROM trust_profile LIMIT 1').get() || {};
    const wallets = db.prepare('SELECT * FROM wallets').all();
    const distributions = db.prepare('SELECT * FROM distributions').all();
    const recentTransactions = db.prepare('SELECT * FROM ledger_entries ORDER BY created_at DESC LIMIT 10').all();
    const bonds = db.prepare('SELECT * FROM bonds').all();
    res.json({ profile, wallets, distributions, recentTransactions, bonds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trust profile
app.get('/api/trust-profile', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM trust_profile LIMIT 1').get() || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wallets
app.get('/api/wallets', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM wallets').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallets/transfer', (req, res) => {
  const { from_wallet_id, to_wallet_id, amount, description } = req.body;
  if (!from_wallet_id || !to_wallet_id || !amount) {
    return res.status(400).json({ error: 'from_wallet_id, to_wallet_id, and amount are required' });
  }
  const amountCents = Math.round(parseFloat(amount) * 100);
  if (isNaN(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  try {
    const fromWallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(from_wallet_id);
    const toWallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(to_wallet_id);
    if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
    if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
    if (fromWallet.fiat_balance < amountCents) {
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const transfer = db.transaction(() => {
      const fromBefore = fromWallet.fiat_balance;
      const fromAfter = fromBefore - amountCents;
      const toBefore = toWallet.fiat_balance;
      const toAfter = toBefore + amountCents;

      db.prepare('UPDATE wallets SET fiat_balance = ?, updated_at = datetime(\'now\') WHERE id = ?').run(fromAfter, from_wallet_id);
      db.prepare('UPDATE wallets SET fiat_balance = ?, updated_at = datetime(\'now\') WHERE id = ?').run(toAfter, to_wallet_id);

      db.prepare(`
        INSERT INTO transactions (wallet_id, from_wallet_id, to_wallet_id, type, category, method, amount, balance_before, balance_after, description, status, created_at)
        VALUES (?, ?, ?, 'transfer_out', 'transfer', 'internal', ?, ?, ?, ?, 'completed', datetime('now'))
      `).run(from_wallet_id, fromWallet.wallet_id, toWallet.wallet_id, amountCents, fromBefore, fromAfter, description || 'Internal transfer');

      db.prepare(`
        INSERT INTO transactions (wallet_id, from_wallet_id, to_wallet_id, type, category, method, amount, balance_before, balance_after, description, status, created_at)
        VALUES (?, ?, ?, 'transfer_in', 'transfer', 'internal', ?, ?, ?, ?, 'completed', datetime('now'))
      `).run(to_wallet_id, fromWallet.wallet_id, toWallet.wallet_id, amountCents, toBefore, toAfter, description || 'Internal transfer');

      db.prepare(`
        INSERT INTO ledger_entries (entry_type, amount, description, wallet_id, status, created_at)
        VALUES ('transfer', ?, ?, ?, 'completed', datetime('now'))
      `).run(amountCents, description || `Transfer from ${fromWallet.name} to ${toWallet.name}`, from_wallet_id);

      return { fromAfter, toAfter };
    });

    const result = transfer();
    res.json({
      success: true,
      message: 'Transfer completed',
      from_balance: result.fromAfter,
      to_balance: result.toAfter,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Distributions
app.get('/api/distributions', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM distributions').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/distributions/:id', (req, res) => {
  try {
    const dist = db.prepare('SELECT * FROM distributions WHERE id = ?').get(req.params.id);
    const items = db.prepare('SELECT * FROM distribution_items WHERE distribution_id = ?').all(req.params.id);
    res.json({ ...dist, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Expenses
app.get('/api/expenses', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM expenses').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Transactions & Ledger
app.get('/api/transactions', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM transactions ORDER BY created_at DESC').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ledger', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM ledger_entries ORDER BY created_at DESC').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bonds
app.get('/api/bonds', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM bonds').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bank transfers
app.get('/api/bank-transfers', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM bank_transfers').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disbursements
app.get('/api/disbursements', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM disbursements ORDER BY created_at DESC').all());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OpenACH Integration ──────────────────────────────────────────────────────
require('./server/openach-patch')(app, db);

// ─── Payment Routes ───────────────────────────────────────────────────────────
app.use('/api/payments', require('./server/routes/payments'));

// ─── Analytics Routes ─────────────────────────────────────────────────────────
app.use('/api/analytics', require('./server/routes/analytics'));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  try {
    const walletCount = db.prepare('SELECT COUNT(*) AS count FROM wallets').get();
    const profile = db.prepare('SELECT trust_name, total_corpus FROM trust_profile LIMIT 1').get();
    res.json({
      status: 'ok',
      service: 'dlbtrust-app',
      database: 'connected',
      wallets: walletCount.count,
      trust: profile ? profile.trust_name : null,
      corpus_cents: profile ? profile.total_corpus : 0,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ─── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    res.sendFile(indexPath);
  } catch (_) {
    res.status(404).json({ error: 'Not found' });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
  console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;

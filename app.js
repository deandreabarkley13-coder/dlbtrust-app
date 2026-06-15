/**
 * DEANDREA LAVAR BARKLEY TRUST — Treasury Management System
 * 
 * Full trust administration platform with:
 * - PostgreSQL for production-grade transactions
 * - Private Placement Bond income tracking
 * - Automated distribution scheduling
 * - Multi-rail payment processing (ACH, wire)
 * - Double-entry general ledger
 * - Beneficiary management
 * - Approval workflows
 * - Audit trail
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

// ─── Database Initialization ──────────────────────────────────────────────────
const pgDb = require('./server/db-postgres');

let dbReady = false;
let dbError = null;

async function startApp() {
  try {
    await pgDb.initializeDatabase();
    dbReady = true;
    console.log('[DB] PostgreSQL ready');
  } catch (err) {
    dbError = err;
    console.error('[DB] PostgreSQL initialization failed:', err.message);
    console.error('[DB] Ensure DATABASE_URL is set correctly');
  }

  // ─── Database readiness middleware ────────────────────────────────────────
  app.use('/api', (req, res, next) => {
    if (!dbReady) {
      return res.status(503).json({
        error: 'Database not ready',
        details: dbError ? dbError.message : 'Initializing...',
      });
    }
    next();
  });

  // ─── Treasury Management System Routes ────────────────────────────────────
  app.use('/api/treasury', require('./server/routes/treasury'));

  // ─── Legacy compatibility routes ──────────────────────────────────────────
  // These map old endpoints to the new treasury system

  app.get('/api/dashboard', async (req, res) => {
    try {
      const trust = await pgDb.queryOne('SELECT * FROM trusts LIMIT 1');
      const wallets = await pgDb.queryAll('SELECT * FROM wallets WHERE trust_id = $1', [trust.id]);
      const bonds = await pgDb.queryAll('SELECT * FROM bonds WHERE trust_id = $1', [trust.id]);
      const distributions = await pgDb.queryAll('SELECT * FROM distributions WHERE trust_id = $1 ORDER BY created_at DESC LIMIT 10', [trust.id]);
      const recentLedger = await pgDb.queryAll('SELECT * FROM ledger_entries WHERE trust_id = $1 ORDER BY created_at DESC LIMIT 10', [trust.id]);

      // Map to legacy format
      const profile = {
        trust_name: trust.trust_name,
        ein: trust.ein,
        formation_date: trust.formation_date,
        jurisdiction: trust.jurisdiction,
        total_corpus: trust.total_corpus,
        currency: trust.currency,
        status: trust.status,
      };

      res.json({ profile, wallets, distributions, recentTransactions: recentLedger, bonds });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/trust-profile', async (req, res) => {
    try {
      const trust = await pgDb.queryOne('SELECT * FROM trusts LIMIT 1');
      res.json(trust || {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/wallets', async (req, res) => {
    try {
      const trust = await pgDb.queryOne('SELECT id FROM trusts LIMIT 1');
      const wallets = await pgDb.queryAll('SELECT * FROM wallets WHERE trust_id = $1 ORDER BY wallet_type, name', [trust.id]);
      res.json(wallets);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/wallets/transfer', async (req, res) => {
    try {
      // Forward to treasury wallet transfer
      const { from_wallet_id, to_wallet_id, amount, description } = req.body;
      if (!from_wallet_id || !to_wallet_id || !amount) {
        return res.status(400).json({ error: 'from_wallet_id, to_wallet_id, and amount are required' });
      }
      const amountCents = Math.round(parseFloat(amount) * 100);
      if (isNaN(amountCents) || amountCents <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }

      const trust = await pgDb.queryOne('SELECT id FROM trusts LIMIT 1');
      const fromWallet = await pgDb.queryOne('SELECT * FROM wallets WHERE id = $1', [from_wallet_id]);
      const toWallet = await pgDb.queryOne('SELECT * FROM wallets WHERE id = $1', [to_wallet_id]);

      if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
      if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
      if (fromWallet.balance < amountCents) {
        return res.status(400).json({ error: 'Insufficient funds' });
      }

      await pgDb.transaction(async (client) => {
        await client.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [amountCents, from_wallet_id]);
        await client.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [amountCents, to_wallet_id]);

        await client.query(`
          INSERT INTO ledger_entries (trust_id, entry_date, entry_type, debit_wallet_id, credit_wallet_id, amount, description, status, posted_by)
          VALUES ($1, CURRENT_DATE, 'transfer', $2, $3, $4, $5, 'posted', 'trustee')
        `, [trust.id, from_wallet_id, to_wallet_id, amountCents, description || `Transfer: ${fromWallet.name} → ${toWallet.name}`]);

        await client.query(`
          INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
          VALUES ($1, 'trustee', 'wallet_transfer', 'wallet', $2, $3)
        `, [trust.id, from_wallet_id, JSON.stringify({ from: fromWallet.wallet_code, to: toWallet.wallet_code, amount: amountCents })]);
      });

      const updatedFrom = await pgDb.queryOne('SELECT balance FROM wallets WHERE id = $1', [from_wallet_id]);
      const updatedTo = await pgDb.queryOne('SELECT balance FROM wallets WHERE id = $1', [to_wallet_id]);

      res.json({
        success: true,
        message: 'Transfer completed',
        from_balance: updatedFrom.balance,
        to_balance: updatedTo.balance,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/distributions', async (req, res) => {
    try {
      const trust = await pgDb.queryOne('SELECT id FROM trusts LIMIT 1');
      const distributions = await pgDb.queryAll('SELECT * FROM distributions WHERE trust_id = $1 ORDER BY distribution_date DESC', [trust.id]);
      res.json(distributions);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/transactions', async (req, res) => {
    try {
      const trust = await pgDb.queryOne('SELECT id FROM trusts LIMIT 1');
      const entries = await pgDb.queryAll('SELECT * FROM ledger_entries WHERE trust_id = $1 ORDER BY created_at DESC', [trust.id]);
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/ledger', async (req, res) => {
    try {
      const trust = await pgDb.queryOne('SELECT id FROM trusts LIMIT 1');
      const entries = await pgDb.queryAll('SELECT * FROM ledger_entries WHERE trust_id = $1 ORDER BY created_at DESC', [trust.id]);
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/bonds', async (req, res) => {
    try {
      const trust = await pgDb.queryOne('SELECT id FROM trusts LIMIT 1');
      const bonds = await pgDb.queryAll('SELECT * FROM bonds WHERE trust_id = $1', [trust.id]);
      res.json(bonds);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── OpenACH Integration ────────────────────────────────────────────────────
  require('./server/openach-patch')(app, null);

  // ─── Analytics Routes ───────────────────────────────────────────────────────
  app.use('/api/analytics', require('./server/routes/analytics-pg'));

  // ─── Health Check ───────────────────────────────────────────────────────────
  app.get('/api/health', async (req, res) => {
    try {
      const trust = await pgDb.queryOne('SELECT trust_name, total_corpus FROM trusts LIMIT 1');
      const walletCount = await pgDb.queryOne('SELECT COUNT(*) as count FROM wallets');
      res.json({
        status: 'ok',
        service: 'dlbtrust-treasury',
        database: dbReady ? 'postgresql_connected' : 'error',
        database_error: dbError ? dbError.message : null,
        wallets: parseInt(walletCount?.count || 0),
        trust: trust?.trust_name || null,
        corpus_cents: trust?.total_corpus || 0,
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        version: '2.0.0',
        features: ['treasury_management', 'bond_income_tracking', 'distribution_scheduling', 'multi_rail_payments', 'approval_workflows'],
      });
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message, database: 'disconnected' });
    }
  });

  // ─── SPA Fallback ─────────────────────────────────────────────────────────
  app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) res.status(404).json({ error: 'Not found' });
    });
  });

  // ─── Start Server ─────────────────────────────────────────────────────────
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[dlbtrust] Treasury Management System running on port ${PORT}`);
    console.log(`[dlbtrust] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[dlbtrust] Database: PostgreSQL ${dbReady ? '✓' : '✗'}`);
  });
}

startApp().catch(err => {
  console.error('[FATAL] Failed to start:', err);
  process.exit(1);
});

module.exports = app;

/**
 * Bond Ladder Strategy Routes
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Ladder Management
 *
 * Endpoints:
 *   GET    /api/ladder/strategies            — List all ladder strategies
 *   GET    /api/ladder/strategies/:id         — Single strategy with rung analysis
 *   POST   /api/ladder/strategies             — Create a new ladder strategy
 *   PUT    /api/ladder/strategies/:id         — Update a strategy
 *   DELETE /api/ladder/strategies/:id         — Archive a strategy
 *   GET    /api/ladder/strategies/:id/rungs   — Detailed rung breakdown
 *   GET    /api/ladder/strategies/:id/reinvest — Reinvestment recommendations
 *   GET    /api/ladder/strategies/:id/fit      — Ladder fit analysis
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const { buildLadder, recommendReinvestments, analyzeLadderFit } = require('../engines/ladder-engine');

// ─── Database Setup ───────────────────────────────────────────────────────────

function getDb() {
  const dbPaths = [
    path.join(__dirname, '..', '..', 'data', 'dlbtrust.db'),
    path.join(__dirname, '..', 'trust.db'),
    path.join(__dirname, '..', '..', 'trust.db'),
    '/app/trust.db',
  ];
  for (const p of dbPaths) {
    try { return new Database(p); } catch (_) {}
  }
  const memDb = new Database(':memory:');
  initSchema(memDb);
  return memDb;
}

function initSchema(db) {
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'fixed-income-schema.sql');
  try {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  } catch (err) {
    console.warn('[ladder] Schema init warning:', err.message);
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    req.fiDb = req.app.locals.db || getDb();
    initSchema(req.fiDb);
    next();
  } catch (err) {
    res.status(500).json({ error: 'Ladder DB connection failed', detail: err.message });
  }
});

const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

// ─── GET /strategies ──────────────────────────────────────────────────────────

router.get('/strategies', (req, res) => {
  try {
    const db = req.fiDb;
    const { status } = req.query;

    let sql = 'SELECT * FROM ladder_strategies WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    else { sql += " AND status != 'archived'"; }

    sql += ' ORDER BY created_at DESC';

    const strategies = db.prepare(sql).all(...params);

    res.json({
      generated_at: new Date().toISOString(),
      count: strategies.length,
      strategies: strategies.map(s => ({
        ...s,
        target_total_usd: toDollars(s.target_total_cents),
        min_rung_usd: toDollars(s.min_rung_cents),
        max_rung_usd: toDollars(s.max_rung_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch strategies', detail: err.message });
  }
});

// ─── GET /strategies/:id ──────────────────────────────────────────────────────

router.get('/strategies/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const strategy = db.prepare('SELECT * FROM ladder_strategies WHERE id = ?').get(req.params.id);

    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const ladder = buildLadder(strategy, holdings);

    res.json({
      ...strategy,
      target_total_usd: toDollars(strategy.target_total_cents),
      ladder,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch strategy', detail: err.message });
  }
});

// ─── POST /strategies ─────────────────────────────────────────────────────────

router.post('/strategies', (req, res) => {
  try {
    const db = req.fiDb;
    const {
      name, target_total_cents, min_rung_cents, max_rung_cents,
      ladder_start_year, ladder_end_year, rung_interval_months = 12,
      target_yield, reinvest_at_maturity = 1, status = 'active', notes,
    } = req.body;

    const required = { name, target_total_cents, ladder_start_year, ladder_end_year };
    const missing = Object.entries(required).filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    if (ladder_end_year <= ladder_start_year) {
      return res.status(400).json({ error: 'ladder_end_year must be after ladder_start_year' });
    }

    const result = db.prepare(`
      INSERT INTO ladder_strategies (
        name, target_total_cents, min_rung_cents, max_rung_cents,
        ladder_start_year, ladder_end_year, rung_interval_months,
        target_yield, reinvest_at_maturity, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name, target_total_cents, min_rung_cents || null, max_rung_cents || null,
      ladder_start_year, ladder_end_year, rung_interval_months,
      target_yield || null, reinvest_at_maturity, status, notes || null
    );

    const newStrategy = db.prepare('SELECT * FROM ladder_strategies WHERE id = ?').get(result.lastInsertRowid);
    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const ladder = buildLadder(newStrategy, holdings);

    res.status(201).json({
      success: true,
      strategy: {
        ...newStrategy,
        target_total_usd: toDollars(newStrategy.target_total_cents),
      },
      ladder,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create strategy', detail: err.message });
  }
});

// ─── PUT /strategies/:id ──────────────────────────────────────────────────────

router.put('/strategies/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const existing = db.prepare('SELECT * FROM ladder_strategies WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    const updatable = [
      'name', 'target_total_cents', 'min_rung_cents', 'max_rung_cents',
      'ladder_start_year', 'ladder_end_year', 'rung_interval_months',
      'target_yield', 'reinvest_at_maturity', 'status', 'notes',
    ];

    const sets = [];
    const params = [];

    for (const field of updatable) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    sets.push("updated_at = datetime('now')");
    params.push(req.params.id);

    db.prepare(`UPDATE ladder_strategies SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM ladder_strategies WHERE id = ?').get(req.params.id);

    res.json({
      success: true,
      strategy: {
        ...updated,
        target_total_usd: toDollars(updated.target_total_cents),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update strategy', detail: err.message });
  }
});

// ─── DELETE /strategies/:id ───────────────────────────────────────────────────

router.delete('/strategies/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const existing = db.prepare('SELECT * FROM ladder_strategies WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    db.prepare(`
      UPDATE ladder_strategies SET status = 'archived', updated_at = datetime('now') WHERE id = ?
    `).run(req.params.id);

    res.json({ success: true, message: `Strategy ${req.params.id} archived` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to archive strategy', detail: err.message });
  }
});

// ─── GET /strategies/:id/rungs ────────────────────────────────────────────────

router.get('/strategies/:id/rungs', (req, res) => {
  try {
    const db = req.fiDb;
    const strategy = db.prepare('SELECT * FROM ladder_strategies WHERE id = ?').get(req.params.id);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const ladder = buildLadder(strategy, holdings);

    res.json({
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      ...ladder,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to analyze rungs', detail: err.message });
  }
});

// ─── GET /strategies/:id/reinvest ─────────────────────────────────────────────

router.get('/strategies/:id/reinvest', (req, res) => {
  try {
    const db = req.fiDb;
    const strategy = db.prepare('SELECT * FROM ladder_strategies WHERE id = ?').get(req.params.id);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    const { months = 12 } = req.query;
    const horizon = new Date();
    horizon.setMonth(horizon.getMonth() + parseInt(months, 10));
    const horizonStr = horizon.toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const maturing = holdings.filter(h => h.maturity_date >= todayStr && h.maturity_date <= horizonStr);

    const recommendations = recommendReinvestments(maturing, strategy, holdings);

    res.json({
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      reinvestment_horizon_months: parseInt(months, 10),
      ...recommendations,
    });
  } catch (err) {
    res.status(500).json({ error: 'Reinvestment analysis failed', detail: err.message });
  }
});

// ─── GET /strategies/:id/fit ──────────────────────────────────────────────────

router.get('/strategies/:id/fit', (req, res) => {
  try {
    const db = req.fiDb;
    const strategy = db.prepare('SELECT * FROM ladder_strategies WHERE id = ?').get(req.params.id);
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const analysis = analyzeLadderFit(strategy, holdings);

    res.json({
      strategy_id: strategy.id,
      strategy_name: strategy.name,
      ...analysis,
    });
  } catch (err) {
    res.status(500).json({ error: 'Ladder fit analysis failed', detail: err.message });
  }
});

module.exports = router;

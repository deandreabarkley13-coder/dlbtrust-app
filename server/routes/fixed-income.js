/**
 * Fixed Income API Routes
 * DEANDREA LAVAR BARKLEY TRUST — Private Trust Fixed Income Management
 *
 * Endpoints:
 *   GET    /api/fixed-income/holdings          — List all holdings (filterable)
 *   GET    /api/fixed-income/holdings/:id      — Single holding with full analytics
 *   POST   /api/fixed-income/holdings          — Add a new holding
 *   PUT    /api/fixed-income/holdings/:id      — Update a holding
 *   DELETE /api/fixed-income/holdings/:id      — Soft-delete (mark as sold)
 *   GET    /api/fixed-income/portfolio          — Portfolio-level analytics
 *   GET    /api/fixed-income/coupons            — Coupon schedule & income tracking
 *   POST   /api/fixed-income/coupons/:id/receive — Mark coupon as received
 *   GET    /api/fixed-income/cashflows          — Projected cash flows
 *   GET    /api/fixed-income/income-forecast    — Multi-year income forecast
 *   GET    /api/fixed-income/maturities         — Upcoming maturities
 *   POST   /api/fixed-income/analyze            — Ad-hoc bond analysis
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { analyzeBond, analyzePortfolio, calcYieldToMaturity, calcPriceFromYield, generateCouponDates, periodsPerYear } = require('../engines/fixed-income-engine');
const { projectPortfolioCashFlows, forecastIncome } = require('../engines/cashflow-engine');

// ─── Database Setup ───────────────────────────────────────────────────────────

const Database = require('better-sqlite3');

function getDb() {
  const dbPaths = [
    path.join(__dirname, '..', '..', 'data', 'dlbtrust.db'),
    path.join(__dirname, '..', 'trust.db'),
    path.join(__dirname, '..', '..', 'trust.db'),
    '/app/trust.db',
  ];
  for (const p of dbPaths) {
    try {
      return new Database(p);
    } catch (_) {}
  }
  // Fallback: create in-memory for dev/testing
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
    console.warn('[fixed-income] Schema init warning:', err.message);
  }
}

// ─── Middleware: DB connection ─────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    req.fiDb = req.app.locals.db || getDb();
    initSchema(req.fiDb);
    next();
  } catch (err) {
    res.status(500).json({ error: 'Fixed income DB connection failed', detail: err.message });
  }
});

const toDollars = (cents) => (cents !== null && cents !== undefined) ? Math.round(cents) / 100 : null;

// ─── GET /holdings ────────────────────────────────────────────────────────────

router.get('/holdings', (req, res) => {
  try {
    const db = req.fiDb;
    const { status, type, rating, sector, tax_status, sort_by, order } = req.query;

    let sql = 'SELECT * FROM fixed_income_holdings WHERE 1=1';
    const params = [];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    else { sql += ' AND status = ?'; params.push('active'); }

    if (type)       { sql += ' AND security_type = ?'; params.push(type); }
    if (rating)     { sql += ' AND credit_rating = ?'; params.push(rating); }
    if (sector)     { sql += ' AND sector = ?';        params.push(sector); }
    if (tax_status) { sql += ' AND tax_status = ?';    params.push(tax_status); }

    const validSorts = ['maturity_date', 'coupon_rate', 'par_value_cents', 'purchase_date', 'security_name', 'credit_rating'];
    const sortCol = validSorts.includes(sort_by) ? sort_by : 'maturity_date';
    const sortOrder = order === 'desc' ? 'DESC' : 'ASC';
    sql += ` ORDER BY ${sortCol} ${sortOrder}`;

    const holdings = db.prepare(sql).all(...params);

    const enriched = holdings.map(h => ({
      ...h,
      par_value_usd: toDollars(h.par_value_cents),
      purchase_price_usd: toDollars(h.purchase_price_cents),
      market_value_usd: toDollars(h.market_value_cents),
      book_value_usd: toDollars(h.book_value_cents),
      analytics: analyzeBond(h),
    }));

    res.json({
      generated_at: new Date().toISOString(),
      count: enriched.length,
      holdings: enriched,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch holdings', detail: err.message });
  }
});

// ─── GET /holdings/:id ────────────────────────────────────────────────────────

router.get('/holdings/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const holding = db.prepare('SELECT * FROM fixed_income_holdings WHERE id = ?').get(req.params.id);

    if (!holding) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    const analytics = analyzeBond(holding);

    // Get coupon payment history
    const coupons = db.prepare(
      'SELECT * FROM coupon_payments WHERE holding_id = ? ORDER BY payment_date'
    ).all(holding.id);

    // Get maturity events
    const events = db.prepare(
      'SELECT * FROM maturity_events WHERE holding_id = ? ORDER BY event_date'
    ).all(holding.id);

    res.json({
      ...holding,
      par_value_usd: toDollars(holding.par_value_cents),
      purchase_price_usd: toDollars(holding.purchase_price_cents),
      market_value_usd: toDollars(holding.market_value_cents),
      book_value_usd: toDollars(holding.book_value_cents),
      analytics,
      coupon_history: coupons,
      maturity_events: events,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch holding', detail: err.message });
  }
});

// ─── POST /holdings ───────────────────────────────────────────────────────────

router.post('/holdings', (req, res) => {
  try {
    const db = req.fiDb;
    const {
      cusip, isin, security_name, security_type, issuer,
      par_value_cents, purchase_price_cents, purchase_date, settlement_date,
      coupon_rate, coupon_frequency = 'semi-annual',
      maturity_date, call_date, call_price_cents,
      day_count_convention = '30/360',
      credit_rating, credit_rating_agency,
      book_value_cents, market_value_cents,
      wallet_id, tax_status = 'taxable', sector, notes,
    } = req.body;

    // Validate required fields
    const required = { security_name, security_type, par_value_cents, purchase_price_cents, purchase_date, coupon_rate, maturity_date };
    const missing = Object.entries(required).filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    // Validate security type
    const validTypes = ['treasury', 'corporate', 'municipal', 'agency', 'cd', 'mbs', 'tips'];
    if (!validTypes.includes(security_type)) {
      return res.status(400).json({ error: `Invalid security_type. Must be one of: ${validTypes.join(', ')}` });
    }

    // Calculate YTM at purchase
    const now = new Date();
    const maturity = new Date(maturity_date);
    const yearsToMaturity = (maturity - now) / (365.25 * 86400000);
    const ytm = calcYieldToMaturity(purchase_price_cents, par_value_cents, coupon_rate, yearsToMaturity, coupon_frequency);
    const currentYield = par_value_cents * coupon_rate / purchase_price_cents;

    const result = db.prepare(`
      INSERT INTO fixed_income_holdings (
        cusip, isin, security_name, security_type, issuer,
        par_value_cents, purchase_price_cents, purchase_date, settlement_date,
        coupon_rate, coupon_frequency, maturity_date, call_date, call_price_cents,
        day_count_convention, credit_rating, credit_rating_agency,
        yield_to_maturity, current_yield,
        book_value_cents, market_value_cents,
        wallet_id, tax_status, sector, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cusip || null, isin || null, security_name, security_type, issuer || null,
      par_value_cents, purchase_price_cents, purchase_date, settlement_date || null,
      coupon_rate, coupon_frequency, maturity_date, call_date || null, call_price_cents || null,
      day_count_convention, credit_rating || null, credit_rating_agency || null,
      ytm, currentYield,
      book_value_cents || purchase_price_cents, market_value_cents || purchase_price_cents,
      wallet_id || null, tax_status, sector || null, notes || null
    );

    const holdingId = result.lastInsertRowid;

    // Auto-generate coupon schedule
    const ppy = periodsPerYear(coupon_frequency);
    if (ppy > 0) {
      const couponDates = generateCouponDates(purchase_date, maturity_date, coupon_frequency);
      const couponAmount = Math.round((par_value_cents * coupon_rate) / ppy);

      const insertCoupon = db.prepare(`
        INSERT INTO coupon_payments (holding_id, payment_date, amount_cents, status)
        VALUES (?, ?, ?, ?)
      `);

      const todayStr = now.toISOString().split('T')[0];
      for (const date of couponDates) {
        const status = date <= todayStr ? 'accrued' : 'scheduled';
        insertCoupon.run(holdingId, date, couponAmount, status);
      }
    }

    // Create maturity event
    db.prepare(`
      INSERT INTO maturity_events (holding_id, event_type, event_date, par_amount_cents)
      VALUES (?, 'maturity', ?, ?)
    `).run(holdingId, maturity_date, par_value_cents);

    // Create call event if callable
    if (call_date) {
      db.prepare(`
        INSERT INTO maturity_events (holding_id, event_type, event_date, par_amount_cents)
        VALUES (?, 'call', ?, ?)
      `).run(holdingId, call_date, call_price_cents || par_value_cents);
    }

    const newHolding = db.prepare('SELECT * FROM fixed_income_holdings WHERE id = ?').get(holdingId);

    res.status(201).json({
      success: true,
      holding: {
        ...newHolding,
        par_value_usd: toDollars(newHolding.par_value_cents),
        purchase_price_usd: toDollars(newHolding.purchase_price_cents),
        analytics: analyzeBond(newHolding),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create holding', detail: err.message });
  }
});

// ─── PUT /holdings/:id ────────────────────────────────────────────────────────

router.put('/holdings/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const existing = db.prepare('SELECT * FROM fixed_income_holdings WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    const updatable = [
      'cusip', 'isin', 'security_name', 'issuer', 'market_value_cents',
      'book_value_cents', 'credit_rating', 'credit_rating_agency',
      'status', 'sector', 'tax_status', 'notes',
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

    db.prepare(`UPDATE fixed_income_holdings SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM fixed_income_holdings WHERE id = ?').get(req.params.id);

    res.json({
      success: true,
      holding: {
        ...updated,
        par_value_usd: toDollars(updated.par_value_cents),
        purchase_price_usd: toDollars(updated.purchase_price_cents),
        market_value_usd: toDollars(updated.market_value_cents),
        analytics: analyzeBond(updated),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update holding', detail: err.message });
  }
});

// ─── DELETE /holdings/:id ─────────────────────────────────────────────────────

router.delete('/holdings/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const existing = db.prepare('SELECT * FROM fixed_income_holdings WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Holding not found' });
    }

    db.prepare(`
      UPDATE fixed_income_holdings SET status = 'sold', updated_at = datetime('now') WHERE id = ?
    `).run(req.params.id);

    res.json({ success: true, message: `Holding ${req.params.id} marked as sold` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete holding', detail: err.message });
  }
});

// ─── GET /portfolio ───────────────────────────────────────────────────────────

router.get('/portfolio', (req, res) => {
  try {
    const db = req.fiDb;
    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const portfolio = analyzePortfolio(holdings);

    res.json({
      generated_at: new Date().toISOString(),
      trust_name: 'DeAndrea Lavar Barkley Trust',
      ...portfolio,
    });
  } catch (err) {
    res.status(500).json({ error: 'Portfolio analysis failed', detail: err.message });
  }
});

// ─── GET /coupons ─────────────────────────────────────────────────────────────

router.get('/coupons', (req, res) => {
  try {
    const db = req.fiDb;
    const { status, from, to, holding_id } = req.query;

    let sql = `
      SELECT cp.*, fih.security_name, fih.cusip, fih.coupon_rate, fih.par_value_cents
      FROM coupon_payments cp
      JOIN fixed_income_holdings fih ON cp.holding_id = fih.id
      WHERE 1=1
    `;
    const params = [];

    if (status)     { sql += ' AND cp.status = ?';       params.push(status); }
    if (from)       { sql += ' AND cp.payment_date >= ?'; params.push(from); }
    if (to)         { sql += ' AND cp.payment_date <= ?'; params.push(to); }
    if (holding_id) { sql += ' AND cp.holding_id = ?';    params.push(holding_id); }

    sql += ' ORDER BY cp.payment_date ASC';

    const coupons = db.prepare(sql).all(...params);

    const totalScheduled = coupons.filter(c => c.status === 'scheduled').reduce((s, c) => s + c.amount_cents, 0);
    const totalReceived = coupons.filter(c => c.status === 'received').reduce((s, c) => s + c.amount_cents, 0);

    res.json({
      generated_at: new Date().toISOString(),
      count: coupons.length,
      total_scheduled_cents: totalScheduled,
      total_scheduled_usd: toDollars(totalScheduled),
      total_received_cents: totalReceived,
      total_received_usd: toDollars(totalReceived),
      coupons: coupons.map(c => ({
        ...c,
        amount_usd: toDollars(c.amount_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch coupons', detail: err.message });
  }
});

// ─── POST /coupons/:id/receive ────────────────────────────────────────────────

router.post('/coupons/:id/receive', (req, res) => {
  try {
    const db = req.fiDb;
    const coupon = db.prepare('SELECT * FROM coupon_payments WHERE id = ?').get(req.params.id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon payment not found' });
    }

    db.prepare(`
      UPDATE coupon_payments 
      SET status = 'received', received_at = datetime('now')
      WHERE id = ?
    `).run(req.params.id);

    res.json({ success: true, message: `Coupon ${req.params.id} marked as received` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update coupon', detail: err.message });
  }
});

// ─── GET /cashflows ───────────────────────────────────────────────────────────

router.get('/cashflows', (req, res) => {
  try {
    const db = req.fiDb;
    const { months = 60, group_by = 'month', include_calls = 'true' } = req.query;

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');

    const cashflows = projectPortfolioCashFlows(holdings, {
      horizon_months: parseInt(months, 10),
      group_by,
      include_calls: include_calls === 'true',
    });

    res.json({
      generated_at: new Date().toISOString(),
      trust_name: 'DeAndrea Lavar Barkley Trust',
      horizon_months: parseInt(months, 10),
      ...cashflows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Cash flow projection failed', detail: err.message });
  }
});

// ─── GET /income-forecast ─────────────────────────────────────────────────────

router.get('/income-forecast', (req, res) => {
  try {
    const db = req.fiDb;
    const { years = 5 } = req.query;

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const forecast = forecastIncome(holdings, parseInt(years, 10));

    res.json({
      generated_at: new Date().toISOString(),
      trust_name: 'DeAndrea Lavar Barkley Trust',
      forecast_years: parseInt(years, 10),
      forecast,
    });
  } catch (err) {
    res.status(500).json({ error: 'Income forecast failed', detail: err.message });
  }
});

// ─── GET /maturities ──────────────────────────────────────────────────────────

router.get('/maturities', (req, res) => {
  try {
    const db = req.fiDb;
    const { months = 24 } = req.query;

    const horizon = new Date();
    horizon.setMonth(horizon.getMonth() + parseInt(months, 10));
    const horizonStr = horizon.toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];

    const upcoming = db.prepare(`
      SELECT me.*, fih.security_name, fih.cusip, fih.coupon_rate, fih.security_type
      FROM maturity_events me
      JOIN fixed_income_holdings fih ON me.holding_id = fih.id
      WHERE me.event_date >= ? AND me.event_date <= ? AND fih.status = 'active'
      ORDER BY me.event_date ASC
    `).all(todayStr, horizonStr);

    const totalMaturingCents = upcoming
      .filter(e => e.event_type === 'maturity')
      .reduce((s, e) => s + e.par_amount_cents, 0);

    res.json({
      generated_at: new Date().toISOString(),
      horizon_months: parseInt(months, 10),
      count: upcoming.length,
      total_maturing_cents: totalMaturingCents,
      total_maturing_usd: toDollars(totalMaturingCents),
      events: upcoming.map(e => ({
        ...e,
        par_amount_usd: toDollars(e.par_amount_cents),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch maturities', detail: err.message });
  }
});

// ─── POST /analyze ────────────────────────────────────────────────────────────
// Ad-hoc bond analysis without persisting

router.post('/analyze', (req, res) => {
  try {
    const {
      par_value_cents, purchase_price_cents, coupon_rate,
      maturity_date, purchase_date, coupon_frequency = 'semi-annual',
      day_count_convention = '30/360', call_date, call_price_cents,
    } = req.body;

    const required = { par_value_cents, purchase_price_cents, coupon_rate, maturity_date };
    const missing = Object.entries(required).filter(([, v]) => v === undefined || v === null).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const holding = {
      par_value_cents,
      purchase_price_cents,
      market_value_cents: purchase_price_cents,
      coupon_rate,
      maturity_date,
      purchase_date: purchase_date || new Date().toISOString().split('T')[0],
      coupon_frequency,
      day_count_convention,
      call_date: call_date || null,
      call_price_cents: call_price_cents || null,
      status: 'active',
    };

    const analytics = analyzeBond(holding);

    // Price sensitivity (basis point shift)
    const bpShifts = [-100, -50, -25, 25, 50, 100];
    const sensitivity = {};
    if (analytics.ytm !== null) {
      for (const bp of bpShifts) {
        const shiftedYtm = analytics.ytm + bp / 10000;
        const shiftedPrice = calcPriceFromYield(
          par_value_cents, coupon_rate, shiftedYtm,
          analytics.years_to_maturity, coupon_frequency
        );
        sensitivity[`${bp > 0 ? '+' : ''}${bp}bp`] = {
          yield: Math.round(shiftedYtm * 10000) / 10000,
          price_cents: shiftedPrice,
          price_usd: toDollars(shiftedPrice),
          price_change_pct: Math.round(((shiftedPrice - purchase_price_cents) / purchase_price_cents) * 10000) / 100,
        };
      }
    }

    res.json({
      input: holding,
      analytics,
      price_sensitivity: sensitivity,
    });
  } catch (err) {
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

module.exports = router;

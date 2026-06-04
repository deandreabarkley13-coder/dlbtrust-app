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
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

function initSchema(db) {
  if (schemaInitialized) return;
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'fixed-income-schema.sql');
  try {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
    schemaInitialized = true;
  } catch (err) {
    console.warn('[fixed-income] Schema init warning:', err.message);
  }
}

// ─── Middleware: DB connection ─────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    req.fiDb = req.app.locals.db || getDb();
    initSchema(req.fiDb);
    if (!req.app.locals.db) {
      res.on('finish', () => { try { req.fiDb.close(); } catch (_) {} });
      res.on('close',  () => { try { req.fiDb.close(); } catch (_) {} });
    }
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
// Cross-engine coupon processing: FI → Banking → Trust Accounting → Event Bus

router.post('/coupons/:id/receive', (req, res) => {
  try {
    const db = req.fiDb;
    const coupon = db.prepare('SELECT * FROM coupon_payments WHERE id = ?').get(req.params.id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon payment not found' });
    }
    if (coupon.status === 'received') {
      return res.status(400).json({ error: 'Coupon already received' });
    }

    const holding = db.prepare('SELECT * FROM fixed_income_holdings WHERE id = ?').get(coupon.holding_id);
    const targetAccountId = req.body.account_id || null;

    // 1. Mark coupon as received in Fixed Income
    db.prepare(`
      UPDATE coupon_payments 
      SET status = 'received', received_at = datetime('now')
      WHERE id = ?
    `).run(req.params.id);

    // 2. Credit the target bank account (or first operating account)
    let creditedAccount = null;
    let account;
    if (targetAccountId) {
      account = db.prepare('SELECT * FROM trust_accounts WHERE id = ? AND status = ?').get(targetAccountId, 'active');
    } else {
      account = db.prepare("SELECT * FROM trust_accounts WHERE account_type = 'operating' AND status = 'active' ORDER BY id LIMIT 1").get();
    }
    if (account) {
      db.prepare('UPDATE trust_accounts SET balance_cents = balance_cents + ?, available_cents = available_cents + ?, last_activity_date = date(?) WHERE id = ?')
        .run(coupon.amount_cents, coupon.amount_cents, new Date().toISOString(), account.id);
      creditedAccount = { id: account.id, name: account.account_name, amount_cents: coupon.amount_cents };

      // Log activity event
      try {
        db.prepare("INSERT INTO cms_event_log (event_name, source_engine, event_data) VALUES ('coupon_received', 'fixed_income', ?)")
          .run(JSON.stringify({ coupon_id: coupon.id, account_id: account.id, amount_cents: coupon.amount_cents, security_name: holding ? holding.security_name : null }));
      } catch (_) { /* event log optional */ }
    }

    // 3. Post journal entry in Trust Accounting (Debit Cash, Credit Interest Income)
    let journalEntryId = null;
    const cashAccount = db.prepare("SELECT id FROM trust_chart_of_accounts WHERE account_code = '1010' AND is_active = 1").get();
    const incomeAccount = db.prepare("SELECT id FROM trust_chart_of_accounts WHERE account_code = '4000' AND is_active = 1").get();
    if (cashAccount && incomeAccount) {
      const entryNumber = `CPN-${Date.now()}`;
      const entryDate = new Date().toISOString().split('T')[0];
      const desc = `Coupon income — ${holding ? holding.security_name : 'Bond'} (${coupon.payment_date})`;

      const result = db.prepare(`
        INSERT INTO trust_journal_entries (entry_number, entry_date, entry_type, description, source_engine, is_posted, total_debit_cents, total_credit_cents, created_by)
        VALUES (?, ?, 'coupon_income', ?, 'fixed_income', 1, ?, ?, 'system')
      `).run(entryNumber, entryDate, desc, coupon.amount_cents, coupon.amount_cents);

      journalEntryId = result.lastInsertRowid;

      db.prepare('INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description) VALUES (?, 1, ?, ?, ?, 0, ?)')
        .run(journalEntryId, cashAccount.id, '1010', coupon.amount_cents, 'Cash received — coupon income');
      db.prepare('INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description) VALUES (?, 2, ?, ?, 0, ?, ?)')
        .run(journalEntryId, incomeAccount.id, '4000', coupon.amount_cents, 'Interest income — bond coupon');
    }

    // 4. Update PP bond total_interest_paid if applicable
    const ppBond = db.prepare('SELECT * FROM private_placement_bonds WHERE holding_id = ?').get(coupon.holding_id);
    if (ppBond) {
      db.prepare('UPDATE private_placement_bonds SET total_interest_paid_cents = total_interest_paid_cents + ?, total_payments_made_cents = total_payments_made_cents + 1 WHERE id = ?')
        .run(coupon.amount_cents, ppBond.id);
    }

    // 5. Emit event on bus
    try {
      const { bus, EVENTS } = require('../engines/event-bus');
      bus.emit(EVENTS.COUPON_RECEIVED, {
        coupon_id: coupon.id,
        holding_id: coupon.holding_id,
        amount_cents: coupon.amount_cents,
        account_id: account ? account.id : null,
        journal_entry_id: journalEntryId,
      });
    } catch (_) { /* event bus optional */ }

    res.json({
      success: true,
      message: `Coupon processed: $${(coupon.amount_cents / 100).toFixed(2)} from ${holding ? holding.security_name : 'bond'}`,
      coupon_id: coupon.id,
      amount_cents: coupon.amount_cents,
      amount_usd: (coupon.amount_cents / 100).toFixed(2),
      credited_account: creditedAccount,
      journal_entry_id: journalEntryId,
      security_name: holding ? holding.security_name : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process coupon', detail: err.message });
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

// ═══════════════════════════════════════════════════════════════════════════════
// Private Placement Bonds — issued by private trust company, held in trust
// ═══════════════════════════════════════════════════════════════════════════════

// ─── GET /private-placements ──────────────────────────────────────────────────

router.get('/private-placements', (req, res) => {
  try {
    const db = req.fiDb;
    const { status, series, trust } = req.query;
    let sql = `SELECT pp.*, h.security_name, h.par_value_cents, h.coupon_rate, h.maturity_date, h.status as holding_status, h.purchase_date, h.purchase_price_cents
               FROM private_placement_bonds pp
               JOIN fixed_income_holdings h ON pp.holding_id = h.id
               WHERE 1=1`;
    const params = [];
    if (status === 'active') { sql += ' AND pp.is_active = 1'; }
    else if (status === 'redeemed') { sql += ' AND pp.is_active = 0'; }
    if (series) { sql += ' AND pp.bond_series = ?'; params.push(series); }
    if (trust) { sql += ' AND pp.issuing_trust LIKE ?'; params.push(`%${trust}%`); }
    sql += ' ORDER BY pp.created_at DESC';
    const bonds = db.prepare(sql).all(...params);
    const formatted = bonds.map(b => ({
      ...b,
      par_value: (b.par_value_cents / 100).toFixed(2),
      purchase_price: (b.purchase_price_cents / 100).toFixed(2),
      last_valuation: b.last_valuation_cents ? (b.last_valuation_cents / 100).toFixed(2) : null,
      total_payments_made: (b.total_payments_made_cents / 100).toFixed(2),
      total_interest_paid: (b.total_interest_paid_cents / 100).toFixed(2),
    }));
    res.json({ bonds: formatted, total: formatted.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch private placements', detail: err.message });
  }
});

// ─── GET /private-placements/summary ──────────────────────────────────────────

router.get('/private-placements/summary', (req, res) => {
  try {
    const db = req.fiDb;
    const active = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(h.par_value_cents), 0) as total_par
      FROM private_placement_bonds pp JOIN fixed_income_holdings h ON pp.holding_id = h.id
      WHERE pp.is_active = 1`).get();
    const totalInterest = db.prepare('SELECT COALESCE(SUM(total_interest_paid_cents), 0) as total FROM private_placement_bonds').get();
    const bySeries = db.prepare(`SELECT pp.bond_series, COUNT(*) as count, SUM(h.par_value_cents) as total_par
      FROM private_placement_bonds pp JOIN fixed_income_holdings h ON pp.holding_id = h.id
      WHERE pp.is_active = 1 GROUP BY pp.bond_series`).all();

    res.json({
      active_bonds: active.count,
      total_par_value: (active.total_par / 100).toFixed(2),
      total_interest_paid: (totalInterest.total / 100).toFixed(2),
      by_series: bySeries.map(s => ({ series: s.bond_series, count: s.count, par_value: (s.total_par / 100).toFixed(2) })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get summary', detail: err.message });
  }
});

// ─── GET /private-placements/:id ──────────────────────────────────────────────

router.get('/private-placements/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const bond = db.prepare(`SELECT pp.*, h.security_name, h.par_value_cents, h.coupon_rate, h.coupon_frequency, h.maturity_date, h.status as holding_status, h.purchase_date, h.purchase_price_cents, h.yield_to_maturity, h.credit_rating, h.day_count_convention
      FROM private_placement_bonds pp
      JOIN fixed_income_holdings h ON pp.holding_id = h.id
      WHERE pp.id = ?`).get(req.params.id);
    if (!bond) return res.status(404).json({ error: 'Private placement bond not found' });
    bond.par_value = (bond.par_value_cents / 100).toFixed(2);
    bond.purchase_price = (bond.purchase_price_cents / 100).toFixed(2);
    bond.last_valuation = bond.last_valuation_cents ? (bond.last_valuation_cents / 100).toFixed(2) : null;
    res.json({ bond });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch private placement', detail: err.message });
  }
});

// ─── POST /private-placements ─────────────────────────────────────────────────

router.post('/private-placements', (req, res) => {
  try {
    const db = req.fiDb;
    const b = req.body;

    // Validate required fields
    const required = ['security_name', 'par_value', 'coupon_rate', 'maturity_date', 'purchase_date', 'bond_series', 'issuing_trust', 'trustee_name'];
    for (const field of required) {
      if (!b[field] && b[field] !== 0) return res.status(400).json({ error: `${field} is required` });
    }

    const parCents = Math.round(parseFloat(b.par_value) * 100);
    const purchaseCents = b.purchase_price ? Math.round(parseFloat(b.purchase_price) * 100) : parCents;

    // Insert into fixed_income_holdings first
    const holdingResult = db.prepare(`INSERT INTO fixed_income_holdings
      (security_name, security_type, issuer, par_value_cents, purchase_price_cents, purchase_date, settlement_date, coupon_rate, coupon_frequency, maturity_date, day_count_convention, credit_rating, tax_status, sector, notes)
      VALUES (?, 'private_placement', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      b.security_name,
      b.issuing_trust,
      parCents,
      purchaseCents,
      b.purchase_date,
      b.settlement_date || b.purchase_date,
      parseFloat(b.coupon_rate) / 100,
      b.coupon_frequency || 'semi-annual',
      b.maturity_date,
      b.day_count_convention || '30/360',
      b.credit_rating || 'NR',
      b.tax_status || 'taxable',
      'Private Placement',
      b.notes || null,
    );

    const holdingId = holdingResult.lastInsertRowid;

    // Insert private placement details
    const ppResult = db.prepare(`INSERT INTO private_placement_bonds
      (holding_id, bond_series, offering_type, offering_memorandum_ref, issuing_trust, trustee_name, beneficiary_class, trust_ein, interest_payment_method, principal_source, subordination_level, secured, collateral_description, accredited_investors_only, max_investors, current_investor_count, restricted_transfer, ohio_trust_code_section, fiduciary_duty_acknowledgment, prudent_investor_compliant, valuation_method, next_payment_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      holdingId,
      b.bond_series,
      b.offering_type || 'rule_506b',
      b.offering_memorandum_ref || null,
      b.issuing_trust,
      b.trustee_name,
      b.beneficiary_class || null,
      b.trust_ein || null,
      b.interest_payment_method || 'direct_deposit',
      b.principal_source || 'trust_income',
      b.subordination_level || 'senior',
      b.secured ? 1 : 0,
      b.collateral_description || null,
      b.accredited_investors_only !== false ? 1 : 0,
      b.max_investors || 35,
      b.current_investor_count || 1,
      b.restricted_transfer !== false ? 1 : 0,
      b.ohio_trust_code_section || null,
      b.fiduciary_duty_acknowledgment !== false ? 1 : 0,
      b.prudent_investor_compliant !== false ? 1 : 0,
      b.valuation_method || 'amortized_cost',
      b.next_payment_date || null,
    );

    // Auto-generate coupon schedule (same as POST /holdings)
    const couponRate = parseFloat(b.coupon_rate) / 100;
    const freq = b.coupon_frequency || 'semi-annual';
    const couponDates = generateCouponDates(b.purchase_date, b.maturity_date, freq);
    const ppy = periodsPerYear(freq);
    if (ppy > 0 && couponDates.length > 0) {
      const couponAmount = Math.round((parCents * couponRate) / ppy);
      const insertCoupon = db.prepare(
        'INSERT INTO coupon_payments (holding_id, payment_date, amount_cents, status) VALUES (?, ?, ?, ?)'
      );
      const todayStr = new Date().toISOString().split('T')[0];
      for (const date of couponDates) {
        const status = date <= todayStr ? 'accrued' : 'scheduled';
        insertCoupon.run(holdingId, date, couponAmount, status);
      }
    }

    // Create maturity event
    db.prepare(
      'INSERT INTO maturity_events (holding_id, event_type, event_date, par_amount_cents) VALUES (?, ?, ?, ?)'
    ).run(holdingId, 'maturity', b.maturity_date, parCents);

    res.status(201).json({
      message: `Private placement bond "${b.security_name}" (Series ${b.bond_series}) recorded`,
      holding_id: holdingId,
      private_placement_id: ppResult.lastInsertRowid,
      coupon_schedule_count: couponDates.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create private placement', detail: err.message });
  }
});

// ─── PUT /private-placements/:id ──────────────────────────────────────────────

router.put('/private-placements/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const b = req.body;
    const existing = db.prepare('SELECT * FROM private_placement_bonds WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Private placement bond not found' });

    // Update private placement fields
    const ppFields = [];
    const ppValues = [];
    const updatable = ['bond_series', 'offering_type', 'offering_memorandum_ref', 'issuing_trust', 'trustee_name', 'beneficiary_class', 'trust_ein', 'interest_payment_method', 'principal_source', 'subordination_level', 'collateral_description', 'ohio_trust_code_section', 'valuation_method', 'next_payment_date', 'redemption_date', 'redemption_reason'];
    for (const f of updatable) {
      if (b[f] !== undefined) { ppFields.push(`${f} = ?`); ppValues.push(b[f]); }
    }
    const boolFields = ['secured', 'accredited_investors_only', 'restricted_transfer', 'fiduciary_duty_acknowledgment', 'prudent_investor_compliant', 'is_active'];
    for (const f of boolFields) {
      if (b[f] !== undefined) { ppFields.push(`${f} = ?`); ppValues.push(b[f] ? 1 : 0); }
    }
    const intFields = ['max_investors', 'current_investor_count', 'last_valuation_cents', 'total_payments_made_cents', 'total_interest_paid_cents'];
    for (const f of intFields) {
      if (b[f] !== undefined) { ppFields.push(`${f} = ?`); ppValues.push(parseInt(b[f])); }
    }
    if (b.last_valuation !== undefined) { ppFields.push('last_valuation_cents = ?'); ppValues.push(Math.round(parseFloat(b.last_valuation) * 100)); }
    if (b.last_valuation_date !== undefined) { ppFields.push('last_valuation_date = ?'); ppValues.push(b.last_valuation_date); }

    if (ppFields.length > 0) {
      ppFields.push("updated_at = datetime('now')");
      ppValues.push(req.params.id);
      db.prepare(`UPDATE private_placement_bonds SET ${ppFields.join(', ')} WHERE id = ?`).run(...ppValues);
    }

    // Update holding fields if provided
    const holdingFields = [];
    const holdingValues = [];
    if (b.security_name) { holdingFields.push('security_name = ?'); holdingValues.push(b.security_name); }
    if (b.coupon_rate !== undefined) { holdingFields.push('coupon_rate = ?'); holdingValues.push(parseFloat(b.coupon_rate)); }
    if (b.credit_rating) { holdingFields.push('credit_rating = ?'); holdingValues.push(b.credit_rating); }
    if (b.status) { holdingFields.push('status = ?'); holdingValues.push(b.status); }
    if (holdingFields.length > 0) {
      holdingFields.push("updated_at = datetime('now')");
      holdingValues.push(existing.holding_id);
      db.prepare(`UPDATE fixed_income_holdings SET ${holdingFields.join(', ')} WHERE id = ?`).run(...holdingValues);
    }

    res.json({ message: 'Private placement bond updated', id: parseInt(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update private placement', detail: err.message });
  }
});

// ─── POST /private-placements/:id/record-payment ──────────────────────────────

router.post('/private-placements/:id/record-payment', (req, res) => {
  try {
    const db = req.fiDb;
    const { amount, payment_date, payment_type } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount is required' });

    const bond = db.prepare('SELECT * FROM private_placement_bonds WHERE id = ?').get(req.params.id);
    if (!bond) return res.status(404).json({ error: 'Private placement bond not found' });

    const amountCents = Math.round(parseFloat(amount) * 100);
    const date = payment_date || new Date().toISOString().split('T')[0];
    const type = payment_type || 'interest';

    // Record in coupon_payments
    db.prepare(`INSERT INTO coupon_payments (holding_id, payment_date, amount_cents, status, received_at)
      VALUES (?, ?, ?, 'received', datetime('now'))`).run(bond.holding_id, date, amountCents);

    // Update totals
    if (type === 'interest') {
      db.prepare('UPDATE private_placement_bonds SET total_interest_paid_cents = total_interest_paid_cents + ?, updated_at = datetime(\'now\') WHERE id = ?').run(amountCents, req.params.id);
    }
    db.prepare('UPDATE private_placement_bonds SET total_payments_made_cents = total_payments_made_cents + ?, updated_at = datetime(\'now\') WHERE id = ?').run(amountCents, req.params.id);

    res.json({ message: `Payment of $${(amountCents / 100).toFixed(2)} recorded`, payment_type: type, date });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record payment', detail: err.message });
  }
});

// ─── POST /private-placements/:id/redeem ──────────────────────────────────────

router.post('/private-placements/:id/redeem', (req, res) => {
  try {
    const db = req.fiDb;
    const { reason, redemption_date } = req.body;
    const bond = db.prepare('SELECT * FROM private_placement_bonds WHERE id = ?').get(req.params.id);
    if (!bond) return res.status(404).json({ error: 'Private placement bond not found' });

    const date = redemption_date || new Date().toISOString().split('T')[0];
    db.prepare(`UPDATE private_placement_bonds SET is_active = 0, redemption_date = ?, redemption_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(date, reason || 'Maturity', req.params.id);
    db.prepare(`UPDATE fixed_income_holdings SET status = 'matured', updated_at = datetime('now') WHERE id = ?`).run(bond.holding_id);

    res.json({ message: 'Bond redeemed', redemption_date: date, reason: reason || 'Maturity' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to redeem bond', detail: err.message });
  }
});

module.exports = router;

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
const {
  getSigner, CDKConfigManager, ContractManager, TokenOperationsManager, LiquidityPoolManager, USDC_POLYGON,
} = require('../engines/cdk-engine');
const { ethers } = require('ethers');
const { generateEntryNumber } = require('../engines/trust-accounting-engine');

// ─── Cross-Engine Sync: posts journal entries, activity, CMS events ───────────

function postCouponToAllEngines(db, coupon, txHash) {
  const amountCents = coupon.amount_cents;
  const securityName = coupon.security_name || 'DLBT-REGISTERED BOND';
  const paymentDate = coupon.payment_date;

  // 1. Trust Accounting — GL Journal Entry
  //    Debit 1000 (Cash/Bank) | Credit 4000 (Interest Income)
  try {
    const entryNumber = generateEntryNumber();
    const entryResult = db.prepare(`
      INSERT INTO trust_journal_entries
        (entry_number, entry_date, entry_type, description, source_engine, is_posted,
         total_debit_cents, total_credit_cents, created_by, reference_type, reference_id)
      VALUES (?, ?, 'standard', ?, 'fixed_income', 1, ?, ?, 'system', 'coupon', ?)
    `).run(
      entryNumber, paymentDate,
      `Bond coupon received: ${securityName} — $${(amountCents / 100).toLocaleString()}`,
      amountCents, amountCents, String(coupon.id)
    );
    const entryId = entryResult.lastInsertRowid;

    // Line 1: Debit Cash (1000)
    db.prepare(`
      INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description)
      VALUES (?, 1, (SELECT id FROM trust_chart_of_accounts WHERE account_code = '1000'), '1000', ?, 0, ?)
    `).run(entryId, amountCents, `Coupon received: ${securityName}`);

    // Line 2: Credit Interest Income (4000)
    db.prepare(`
      INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, debit_cents, credit_cents, description)
      VALUES (?, 2, (SELECT id FROM trust_chart_of_accounts WHERE account_code = '4000'), '4000', 0, ?, ?)
    `).run(entryId, amountCents, `Interest income: ${securityName}`);
  } catch (e) {
    console.warn('[cross-engine] GL journal posting failed:', e.message);
  }

  // 2. CMS Event Log — record the cashflow event
  try {
    db.prepare(`
      INSERT INTO cms_event_log (event_name, source_engine, event_data)
      VALUES ('coupon_received', 'fixed_income', ?)
    `).run(JSON.stringify({
      coupon_id: coupon.id,
      holding_id: coupon.holding_id,
      amount_cents: amountCents,
      security_name: securityName,
      payment_date: paymentDate,
      tx_hash: txHash || null,
    }));
  } catch (e) {
    console.warn('[cross-engine] CMS event log failed:', e.message);
  }

  // 3. Banking Audit Log — record the income event
  try {
    db.prepare(`
      INSERT INTO banking_audit_log (event_type, entity_type, entity_id, actor, action, details, created_at)
      VALUES ('coupon_received', 'fixed_income', ?, 'system', 'receive_coupon', ?, datetime('now'))
    `).run(String(coupon.id), JSON.stringify({
      security_name: securityName,
      amount_usd: (amountCents / 100).toFixed(2),
      payment_date: paymentDate,
      tx_hash: txHash || null,
      on_chain: !!txHash,
    }));
  } catch (e) {
    console.warn('[cross-engine] Banking audit log failed:', e.message);
  }
}

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

    // Data fix: sync purchase_price_cents and market_value_cents with par_value_cents
    try {
      db.prepare(`
        UPDATE fixed_income_holdings
        SET purchase_price_cents = par_value_cents
        WHERE par_value_cents > 0 AND (purchase_price_cents IS NULL OR purchase_price_cents < par_value_cents * 0.01)
      `).run();
      db.prepare(`
        UPDATE fixed_income_holdings
        SET market_value_cents = par_value_cents
        WHERE par_value_cents > 0 AND (market_value_cents IS NULL OR market_value_cents = 0)
      `).run();
    } catch (_) { /* data fix is best-effort */ }

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

// ─── POST /coupons/generate — Generate missing coupon schedules ───────────────
// For bonds that exist but have no coupon_payments rows (e.g., created before
// the auto-generation was added), this creates all scheduled and past-due coupons.

router.post('/coupons/generate', (req, res) => {
  try {
    const db = req.fiDb;
    const holdings = db.prepare("SELECT * FROM fixed_income_holdings WHERE status = 'active'").all();
    const todayStr = new Date().toISOString().split('T')[0];
    let totalGenerated = 0;
    const results = [];

    for (const holding of holdings) {
      // Check if coupons already exist for this holding
      const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM coupon_payments WHERE holding_id = ?').get(holding.id).cnt;
      if (existingCount > 0) {
        results.push({ holding_id: holding.id, security: holding.security_name, status: 'already_has_coupons', count: existingCount });
        continue;
      }

      const ppy = periodsPerYear(holding.coupon_frequency || 'semi-annual');
      if (ppy <= 0 || !holding.coupon_rate || holding.coupon_rate <= 0) {
        results.push({ holding_id: holding.id, security: holding.security_name, status: 'no_coupon' });
        continue;
      }

      // Limit maturity to 5 years from now for practical coupon generation
      const maxDate = new Date();
      maxDate.setFullYear(maxDate.getFullYear() + 5);
      const effectiveMaturity = holding.maturity_date < maxDate.toISOString().split('T')[0] ? holding.maturity_date : maxDate.toISOString().split('T')[0];

      const couponDates = generateCouponDates(holding.purchase_date, effectiveMaturity, holding.coupon_frequency || 'semi-annual');
      const couponAmount = Math.round((holding.par_value_cents * holding.coupon_rate) / ppy);

      const insertCoupon = db.prepare('INSERT INTO coupon_payments (holding_id, payment_date, amount_cents, status) VALUES (?, ?, ?, ?)');

      let generated = 0;
      for (const date of couponDates) {
        const status = date <= todayStr ? 'scheduled' : 'scheduled';
        insertCoupon.run(holding.id, date, couponAmount, status);
        generated++;
      }
      totalGenerated += generated;
      results.push({ holding_id: holding.id, security: holding.security_name, status: 'generated', coupons_created: generated, coupon_amount_usd: (couponAmount / 100).toFixed(2) });
    }

    res.json({ success: true, total_generated: totalGenerated, holdings: results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate coupons', detail: err.message });
  }
});

// ─── POST /coupons/sync-totals — Recalculate interest totals from received coupons
router.post('/coupons/sync-totals', (req, res) => {
  try {
    const db = req.fiDb;
    const received = db.prepare(`
      SELECT cp.holding_id, SUM(cp.amount_cents) as total_interest
      FROM coupon_payments cp WHERE cp.status = 'received'
      GROUP BY cp.holding_id
    `).all();

    let updated = 0;
    for (const row of received) {
      const ppBond = db.prepare('SELECT id FROM private_placement_bonds WHERE holding_id = ?').get(row.holding_id);
      if (ppBond) {
        db.prepare("UPDATE private_placement_bonds SET total_interest_paid_cents = ?, total_payments_made_cents = ?, updated_at = datetime('now') WHERE id = ?")
          .run(row.total_interest, row.total_interest, ppBond.id);
        updated++;
      }
    }

    // Also post GL entries for received coupons that don't have them yet
    const receivedCoupons = db.prepare(`
      SELECT cp.*, fih.security_name
      FROM coupon_payments cp
      JOIN fixed_income_holdings fih ON cp.holding_id = fih.id
      WHERE cp.status = 'received'
    `).all();

    let journalsPosted = 0;
    for (const coupon of receivedCoupons) {
      // Check if GL entry already exists for this coupon
      const existing = db.prepare("SELECT id FROM trust_journal_entries WHERE reference_type = 'coupon' AND reference_id = ?").get(String(coupon.id));
      if (!existing) {
        postCouponToAllEngines(db, coupon, null);
        journalsPosted++;
      }
    }

    res.json({ success: true, bonds_updated: updated, journals_posted: journalsPosted, totals: received });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /coupons/:id/receive ────────────────────────────────────────────────
// When a coupon is received, automatically:
// 1. Mark coupon as received
// 2. Credit the trust account
// 3. Mint DLBT tokens on-chain (tokenize the cashflow)
// 4. If USDC available in wallet, add both to the liquidity pool

router.post('/coupons/:id/receive', async (req, res) => {
  try {
    const db = req.fiDb;
    const coupon = db.prepare('SELECT * FROM coupon_payments WHERE id = ?').get(req.params.id);
    if (!coupon) {
      return res.status(404).json({ error: 'Coupon payment not found' });
    }

    // Mark coupon as received
    db.prepare(`
      UPDATE coupon_payments 
      SET status = 'received', received_at = datetime('now')
      WHERE id = ?
    `).run(req.params.id);

    // Credit the holding's linked account (or first trust account) with the coupon income
    const holding = db.prepare('SELECT * FROM fixed_income_holdings WHERE id = ?').get(coupon.holding_id);
    const couponAmountDollars = (coupon.amount_cents / 100).toFixed(2);
    const couponAmountCents = coupon.amount_cents;

    // Find a trust account to credit (use the first active operating account)
    const creditAccount = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active' ORDER BY id ASC LIMIT 1").get();
    if (creditAccount) {
      db.prepare("UPDATE trust_accounts SET balance_cents = balance_cents + ?, available_cents = available_cents + ?, updated_at = datetime('now') WHERE id = ?")
        .run(couponAmountCents, couponAmountCents, creditAccount.id);
    }

    // --- Auto-tokenize: Mint DLBT tokens for the coupon amount ---
    let mintResult = null;
    let poolResult = null;
    let tokenizationError = null;

    try {
      const mgr = new ContractManager(db);
      const token = mgr.getDeployedToken();

      if (token) {
        const cfg = new CDKConfigManager(db);
        const deployerWalletId = cfg.get('deployer_wallet_id');
        const network = cfg.get('network') || 'MATIC';

        if (deployerWalletId) {
          // Get the deployer wallet to mint to
          const deployerWallet = db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(parseInt(deployerWalletId));
          if (deployerWallet) {
            const signer = getSigner(db, parseInt(deployerWalletId), network);
            const ops = new TokenOperationsManager(db);

            // Mint DLBT equal to coupon amount
            mintResult = await ops.mint(
              signer,
              token.contract_address,
              deployerWallet.address,
              couponAmountDollars,
              creditAccount ? creditAccount.id : null,
              parseInt(deployerWalletId)
            );

            // --- Auto-fund liquidity pool ---
            // First check if USDC is available, if not auto-swap POL→USDC
            try {
              const poolMgr = new LiquidityPoolManager(db);
              const poolRow = db.prepare("SELECT * FROM cdk_liquidity_pools WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();

              if (poolRow) {
                const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
                const usdcContract = new ethers.Contract(USDC_POLYGON, ['function balanceOf(address) view returns (uint256)'], provider);
                const usdcBalance = await usdcContract.balanceOf(deployerWallet.address);
                const usdcAvailable = parseFloat(ethers.formatUnits(usdcBalance, 6));
                const couponAmount = parseFloat(couponAmountDollars);

                if (usdcAvailable >= couponAmount && couponAmount > 0) {
                  // Enough USDC already — just add liquidity directly
                  poolResult = await poolMgr.addLiquidity(signer, token.contract_address, couponAmount, couponAmount);
                } else if (couponAmount > 0) {
                  // Not enough USDC — auto-swap POL → USDC → fund pool
                  const autoResult = await poolMgr.autoFundFromPOL(signer, token.contract_address, couponAmount);
                  if (autoResult.poolFunded) {
                    poolResult = { autoFunded: true, steps: autoResult.steps, totalUSDC: autoResult.totalUSDC };
                  }
                }
              }
            } catch (poolErr) {
              // Pool funding is best-effort; don't fail the coupon processing
              console.warn('[fixed-income] Auto pool funding skipped:', poolErr.message);
            }
          }
        }
      }
    } catch (err) {
      tokenizationError = err.message;
      console.warn('[fixed-income] Auto-tokenization skipped:', err.message);
    }

    // Cross-engine sync: GL journal, CMS event, activity log
    postCouponToAllEngines(db, coupon, mintResult ? mintResult.txHash : null);

    res.json({
      success: true,
      message: `Coupon ${req.params.id} received and processed`,
      coupon_amount_usd: couponAmountDollars,
      account_credited: creditAccount ? creditAccount.account_name : null,
      tokenization: mintResult ? {
        status: 'minted',
        dlbt_minted: couponAmountDollars,
        tx_hash: mintResult.txHash,
        explorer_url: `https://polygonscan.com/tx/${mintResult.txHash}`,
      } : {
        status: 'skipped',
        reason: tokenizationError || 'DLBT token not deployed or no deployer wallet configured',
      },
      pool_funding: poolResult ? {
        status: 'funded',
        dlbt_added: couponAmountDollars,
        usdc_added: couponAmountDollars,
        tx_hash: poolResult.txHash,
      } : {
        status: 'skipped',
        reason: 'No pool exists or insufficient USDC balance in wallet',
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process coupon', detail: err.message });
  }
});

// ─── POST /coupons/process-all — Auto-tokenize all due coupons ───────────────
// Finds all scheduled coupons with payment_date <= today, marks them received,
// mints DLBT, and funds the pool. This is the automated cashflow→token pipeline.

router.post('/coupons/process-all', async (req, res) => {
  try {
    const db = req.fiDb;
    const today = new Date().toISOString().split('T')[0];

    // Find all scheduled coupons due on or before today
    const dueCoupons = db.prepare(`
      SELECT cp.*, fih.security_name, fih.par_value_cents, fih.coupon_rate
      FROM coupon_payments cp
      JOIN fixed_income_holdings fih ON cp.holding_id = fih.id
      WHERE cp.status = 'scheduled' AND cp.payment_date <= ?
      ORDER BY cp.payment_date ASC
    `).all(today);

    if (dueCoupons.length === 0) {
      return res.json({ message: 'No coupons due for processing', processed: 0, total_minted: '0.00' });
    }

    // Get CDK infrastructure
    const mgr = new ContractManager(db);
    const token = mgr.getDeployedToken();
    const cfg = new CDKConfigManager(db);
    const deployerWalletId = cfg.get('deployer_wallet_id');
    const network = cfg.get('network') || 'MATIC';

    let signer = null;
    let deployerWallet = null;
    if (token && deployerWalletId) {
      deployerWallet = db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(parseInt(deployerWalletId));
      if (deployerWallet) {
        signer = getSigner(db, parseInt(deployerWalletId), network);
      }
    }

    const creditAccount = db.prepare("SELECT * FROM trust_accounts WHERE status = 'active' ORDER BY id ASC LIMIT 1").get();
    const results = [];
    let totalMintedCents = 0;

    for (const coupon of dueCoupons) {
      const amountDollars = (coupon.amount_cents / 100).toFixed(2);

      // Mark as received
      db.prepare("UPDATE coupon_payments SET status = 'received', received_at = datetime('now') WHERE id = ?").run(coupon.id);

      // Credit trust account
      if (creditAccount) {
        db.prepare("UPDATE trust_accounts SET balance_cents = balance_cents + ?, available_cents = available_cents + ?, updated_at = datetime('now') WHERE id = ?")
          .run(coupon.amount_cents, coupon.amount_cents, creditAccount.id);
      }

      // Update bond interest totals
      const ppBond = db.prepare('SELECT id FROM private_placement_bonds WHERE holding_id = ?').get(coupon.holding_id);
      if (ppBond) {
        db.prepare("UPDATE private_placement_bonds SET total_interest_paid_cents = total_interest_paid_cents + ?, total_payments_made_cents = total_payments_made_cents + ?, updated_at = datetime('now') WHERE id = ?")
          .run(coupon.amount_cents, coupon.amount_cents, ppBond.id);
      }

      // Mint DLBT
      let mintResult = null;
      if (signer && token && deployerWallet) {
        try {
          const ops = new TokenOperationsManager(db);
          mintResult = await ops.mint(
            signer, token.contract_address, deployerWallet.address,
            amountDollars, creditAccount ? creditAccount.id : null, parseInt(deployerWalletId)
          );
          totalMintedCents += coupon.amount_cents;
        } catch (mintErr) {
          console.warn(`[fixed-income] Mint failed for coupon ${coupon.id}:`, mintErr.message);
        }
      }

      // Cross-engine sync: GL journal, CMS event, activity log
      postCouponToAllEngines(db, coupon, mintResult ? mintResult.txHash : null);

      results.push({
        coupon_id: coupon.id,
        security: coupon.security_name,
        payment_date: coupon.payment_date,
        amount_usd: amountDollars,
        minted: mintResult ? true : false,
        tx_hash: mintResult ? mintResult.txHash : null,
      });
    }

    // After all minting, try to add liquidity to pool
    // Auto-swap available POL → USDC, then pair with minted DLBT
    let poolFunded = null;
    let poolError = null;
    if (signer && token && deployerWallet && totalMintedCents > 0) {
      try {
        const poolRow = db.prepare("SELECT * FROM cdk_liquidity_pools WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
        if (poolRow) {
          const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
          const usdcContract = new ethers.Contract(USDC_POLYGON, ['function balanceOf(address) view returns (uint256)'], provider);
          const usdcBalance = await usdcContract.balanceOf(deployerWallet.address);
          const usdcAvailable = parseFloat(ethers.formatUnits(usdcBalance, 6));
          const totalMintedDollars = totalMintedCents / 100;

          const poolMgr = new LiquidityPoolManager(db);
          if (usdcAvailable >= 1.0) {
            // Use existing USDC (up to what's available)
            const amountToAdd = Math.min(usdcAvailable, totalMintedDollars);
            poolFunded = await poolMgr.addLiquidity(signer, token.contract_address, amountToAdd, amountToAdd);
          } else {
            // Auto-swap available POL → USDC → fund pool (uses whatever POL is available)
            const autoResult = await poolMgr.autoFundFromPOL(signer, token.contract_address, totalMintedDollars);
            poolFunded = { autoFunded: true, steps: autoResult.steps, totalUSDC: autoResult.totalUSDC, poolFunded: autoResult.poolFunded };
          }
        } else {
          poolError = 'No active liquidity pool found';
        }
      } catch (poolErr) {
        poolError = poolErr.message;
        console.warn('[fixed-income] Pool funding after batch processing failed:', poolErr.message);
      }
    }

    res.json({
      message: `Processed ${results.length} coupon payments`,
      processed: results.length,
      total_minted: (totalMintedCents / 100).toFixed(2),
      account_credited: creditAccount ? creditAccount.account_name : null,
      pool_funded: poolFunded || null,
      pool_error: poolError || null,
      coupons: results,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process coupons', detail: err.message });
  }
});

// ─── POST /coupons/fund-pool — Use coupon interest to auto-fund liquidity pool
// Swaps available POL → USDC and pairs with minted DLBT in pool
router.post('/coupons/fund-pool', async (req, res) => {
  try {
    const db = req.fiDb;

    // Get CDK config
    const config = new CDKConfigManager(db);
    const chain = config.getChain();
    const deployerWalletId = chain.deployer_wallet_id;
    const deployerWallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(parseInt(deployerWalletId));
    const token = db.prepare("SELECT * FROM cdk_contracts WHERE contract_type = 'token' AND blockchain = 'MATIC' ORDER BY id DESC LIMIT 1").get();
    const poolRow = db.prepare("SELECT * FROM cdk_liquidity_pools WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();

    if (!deployerWallet || !token) {
      return res.status(400).json({ error: 'DLBT token or deployer wallet not configured' });
    }
    if (!poolRow) {
      return res.status(400).json({ error: 'No active liquidity pool. Create one first in Polygon CDK.' });
    }

    const signer = getSigner(db, deployerWallet);
    if (!signer) {
      return res.status(400).json({ error: 'Cannot create signer for deployer wallet' });
    }

    // Calculate total interest received (this is what backs the DLBT in the pool)
    const totalReceived = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) as total FROM coupon_payments WHERE status = 'received'").get();
    const totalInterestUSD = totalReceived.total / 100;

    // Execute auto-fund from POL
    const poolMgr = new LiquidityPoolManager(db);
    const autoResult = await poolMgr.autoFundFromPOL(signer, token.contract_address, totalInterestUSD);

    res.json({
      success: true,
      message: autoResult.poolFunded
        ? `Pool funded with ${autoResult.totalUSDC} USDC (swapped from POL)`
        : 'Auto-fund attempted but could not complete — check POL balance',
      total_interest_backing: totalInterestUSD.toFixed(2),
      auto_fund_result: autoResult,
    });
  } catch (err) {
    res.status(500).json({ error: 'Pool funding failed', detail: err.message });
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

    res.status(201).json({
      message: `Private placement bond "${b.security_name}" (Series ${b.bond_series}) recorded`,
      holding_id: holdingId,
      private_placement_id: ppResult.lastInsertRowid,
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

/**
 * Trust Investment Policy Routes
 * DEANDREA LAVAR BARKLEY TRUST — IPS Constraint Management & Compliance
 *
 * Endpoints:
 *   GET    /api/trust-policy                    — List all policies
 *   GET    /api/trust-policy/:id                — Single policy details
 *   POST   /api/trust-policy                    — Create a new policy
 *   PUT    /api/trust-policy/:id                — Update a policy
 *   DELETE /api/trust-policy/:id                — Remove a policy
 *   GET    /api/trust-policy/compliance         — Run compliance check against active policy
 *   POST   /api/trust-policy/check-trade        — Pre-trade compliance check
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const Database = require('better-sqlite3');
const { analyzePortfolio, analyzeBond } = require('../engines/fixed-income-engine');

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
    console.warn('[trust-policy] Schema init warning:', err.message);
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────

router.use((req, res, next) => {
  try {
    req.fiDb = req.app.locals.db || getDb();
    initSchema(req.fiDb);
    next();
  } catch (err) {
    res.status(500).json({ error: 'Trust policy DB connection failed', detail: err.message });
  }
});

// ─── Credit Rating Helpers ────────────────────────────────────────────────────

const RATING_ORDER = [
  'AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-',
  'BBB+', 'BBB', 'BBB-',
  'BB+', 'BB', 'BB-', 'B+', 'B', 'B-',
  'CCC+', 'CCC', 'CCC-', 'CC', 'C', 'D', 'NR',
];

function ratingRank(rating) {
  const idx = RATING_ORDER.indexOf(rating);
  return idx >= 0 ? idx : RATING_ORDER.length;
}

function isInvestmentGrade(rating) {
  if (!rating || rating === 'NR') return true; // assume IG if not rated
  return ratingRank(rating) <= ratingRank('BBB-');
}

function meetsMinRating(rating, minRating) {
  if (!minRating) return true;
  return ratingRank(rating || 'NR') <= ratingRank(minRating);
}

// ─── GET / ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const db = req.fiDb;
    const policies = db.prepare('SELECT * FROM trust_investment_policy ORDER BY effective_date DESC').all();

    res.json({
      generated_at: new Date().toISOString(),
      count: policies.length,
      policies,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch policies', detail: err.message });
  }
});

// ─── Named routes MUST be registered before /:id ──────────────────────────────

// ─── POST / ───────────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  try {
    const db = req.fiDb;
    const {
      policy_name, effective_date,
      max_single_issuer_pct = 0.05,
      max_sector_pct = 0.25,
      min_credit_rating = 'BBB',
      max_maturity_years = 30,
      min_portfolio_yield,
      max_portfolio_duration,
      allowed_security_types = 'treasury,corporate,municipal,agency,cd',
      require_tax_exempt_pct = 0,
      max_below_investment_grade_pct = 0,
      income_distribution_pct = 1.0,
      principal_preservation = 1,
      notes,
    } = req.body;

    if (!policy_name || !effective_date) {
      return res.status(400).json({ error: 'policy_name and effective_date are required' });
    }

    const result = db.prepare(`
      INSERT INTO trust_investment_policy (
        policy_name, effective_date,
        max_single_issuer_pct, max_sector_pct, min_credit_rating,
        max_maturity_years, min_portfolio_yield, max_portfolio_duration,
        allowed_security_types, require_tax_exempt_pct,
        max_below_investment_grade_pct, income_distribution_pct,
        principal_preservation, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      policy_name, effective_date,
      max_single_issuer_pct, max_sector_pct, min_credit_rating,
      max_maturity_years, min_portfolio_yield || null, max_portfolio_duration || null,
      allowed_security_types, require_tax_exempt_pct,
      max_below_investment_grade_pct, income_distribution_pct,
      principal_preservation, notes || null
    );

    const newPolicy = db.prepare('SELECT * FROM trust_investment_policy WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({ success: true, policy: newPolicy });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create policy', detail: err.message });
  }
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

router.put('/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const existing = db.prepare('SELECT * FROM trust_investment_policy WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    const updatable = [
      'policy_name', 'effective_date',
      'max_single_issuer_pct', 'max_sector_pct', 'min_credit_rating',
      'max_maturity_years', 'min_portfolio_yield', 'max_portfolio_duration',
      'allowed_security_types', 'require_tax_exempt_pct',
      'max_below_investment_grade_pct', 'income_distribution_pct',
      'principal_preservation', 'notes',
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

    db.prepare(`UPDATE trust_investment_policy SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM trust_investment_policy WHERE id = ?').get(req.params.id);

    res.json({ success: true, policy: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update policy', detail: err.message });
  }
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const existing = db.prepare('SELECT * FROM trust_investment_policy WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    db.prepare('DELETE FROM trust_investment_policy WHERE id = ?').run(req.params.id);

    res.json({ success: true, message: `Policy ${req.params.id} deleted` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete policy', detail: err.message });
  }
});

// ─── GET /compliance ──────────────────────────────────────────────────────────

router.get('/compliance', (req, res) => {
  try {
    const db = req.fiDb;

    // Get the most recent active policy
    const policy = db.prepare(`
      SELECT * FROM trust_investment_policy 
      WHERE effective_date <= date('now')
      ORDER BY effective_date DESC LIMIT 1
    `).get();

    if (!policy) {
      return res.json({
        generated_at: new Date().toISOString(),
        compliant: true,
        message: 'No active investment policy found — all holdings pass by default',
        violations: [],
      });
    }

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const portfolio = analyzePortfolio(holdings);

    const violations = [];
    const warnings = [];

    // 1. Check single-issuer concentration
    const issuerTotals = {};
    for (const h of holdings) {
      const issuer = h.issuer || h.security_name;
      issuerTotals[issuer] = (issuerTotals[issuer] || 0) + (h.market_value_cents || h.purchase_price_cents);
    }
    for (const [issuer, total] of Object.entries(issuerTotals)) {
      const pct = portfolio.total_market_cents > 0 ? total / portfolio.total_market_cents : 0;
      if (pct > policy.max_single_issuer_pct) {
        violations.push({
          type: 'issuer_concentration',
          severity: 'violation',
          issuer,
          current_pct: Math.round(pct * 10000) / 100,
          limit_pct: Math.round(policy.max_single_issuer_pct * 10000) / 100,
          detail: `${issuer} is ${Math.round(pct * 100)}% of portfolio (limit: ${Math.round(policy.max_single_issuer_pct * 100)}%)`,
        });
      }
    }

    // 2. Check sector concentration
    for (const [sector, data] of Object.entries(portfolio.by_sector)) {
      const pct = data.pct_of_portfolio / 100;
      if (pct > policy.max_sector_pct) {
        violations.push({
          type: 'sector_concentration',
          severity: 'violation',
          sector,
          current_pct: Math.round(pct * 10000) / 100,
          limit_pct: Math.round(policy.max_sector_pct * 10000) / 100,
          detail: `${sector} sector is ${Math.round(pct * 100)}% of portfolio (limit: ${Math.round(policy.max_sector_pct * 100)}%)`,
        });
      }
    }

    // 3. Check credit rating minimums
    const allowedTypes = (policy.allowed_security_types || '').split(',').map(t => t.trim());
    for (const h of holdings) {
      if (!meetsMinRating(h.credit_rating, policy.min_credit_rating)) {
        violations.push({
          type: 'credit_rating',
          severity: 'violation',
          holding_id: h.id,
          security_name: h.security_name,
          current_rating: h.credit_rating || 'NR',
          min_required: policy.min_credit_rating,
          detail: `${h.security_name} rated ${h.credit_rating || 'NR'} (minimum: ${policy.min_credit_rating})`,
        });
      }

      // 4. Check allowed security types
      if (allowedTypes.length > 0 && !allowedTypes.includes(h.security_type)) {
        violations.push({
          type: 'security_type',
          severity: 'violation',
          holding_id: h.id,
          security_name: h.security_name,
          security_type: h.security_type,
          allowed_types: allowedTypes,
          detail: `${h.security_name} type '${h.security_type}' not in allowed types: ${allowedTypes.join(', ')}`,
        });
      }

      // 5. Check max maturity
      const analytics = analyzeBond(h);
      if (analytics.years_to_maturity > policy.max_maturity_years) {
        violations.push({
          type: 'maturity_limit',
          severity: 'violation',
          holding_id: h.id,
          security_name: h.security_name,
          years_to_maturity: analytics.years_to_maturity,
          max_years: policy.max_maturity_years,
          detail: `${h.security_name} matures in ${analytics.years_to_maturity} years (max: ${policy.max_maturity_years})`,
        });
      }
    }

    // 6. Check below-investment-grade concentration
    const bigHoldings = holdings.filter(h => !isInvestmentGrade(h.credit_rating));
    const bigTotal = bigHoldings.reduce((s, h) => s + (h.market_value_cents || h.purchase_price_cents), 0);
    const bigPct = portfolio.total_market_cents > 0 ? bigTotal / portfolio.total_market_cents : 0;
    if (bigPct > policy.max_below_investment_grade_pct) {
      violations.push({
        type: 'below_investment_grade',
        severity: 'violation',
        current_pct: Math.round(bigPct * 10000) / 100,
        limit_pct: Math.round(policy.max_below_investment_grade_pct * 10000) / 100,
        detail: `Below-IG holdings are ${Math.round(bigPct * 100)}% of portfolio (limit: ${Math.round(policy.max_below_investment_grade_pct * 100)}%)`,
      });
    }

    // 7. Check portfolio duration
    if (policy.max_portfolio_duration && portfolio.weighted_avg_duration > policy.max_portfolio_duration) {
      violations.push({
        type: 'duration_limit',
        severity: 'warning',
        current_duration: portfolio.weighted_avg_duration,
        max_duration: policy.max_portfolio_duration,
        detail: `Portfolio duration ${portfolio.weighted_avg_duration} exceeds limit of ${policy.max_portfolio_duration}`,
      });
    }

    // 8. Check minimum yield
    if (policy.min_portfolio_yield && portfolio.weighted_avg_ytm !== null && portfolio.weighted_avg_ytm < policy.min_portfolio_yield) {
      warnings.push({
        type: 'yield_floor',
        severity: 'warning',
        current_yield: portfolio.weighted_avg_ytm,
        min_yield: policy.min_portfolio_yield,
        detail: `Portfolio yield ${Math.round(portfolio.weighted_avg_ytm * 10000) / 100}% below minimum ${Math.round(policy.min_portfolio_yield * 10000) / 100}%`,
      });
    }

    // 9. Check tax-exempt requirement
    const taxExemptMV = holdings
      .filter(h => h.tax_status === 'tax_exempt')
      .reduce((s, h) => s + (h.market_value_cents || h.purchase_price_cents), 0);
    const taxExemptPct = portfolio.total_market_cents > 0 ? taxExemptMV / portfolio.total_market_cents : 0;
    if (policy.require_tax_exempt_pct > 0 && taxExemptPct < policy.require_tax_exempt_pct) {
      warnings.push({
        type: 'tax_exempt_minimum',
        severity: 'warning',
        current_pct: Math.round(taxExemptPct * 10000) / 100,
        required_pct: Math.round(policy.require_tax_exempt_pct * 10000) / 100,
        detail: `Tax-exempt holdings at ${Math.round(taxExemptPct * 100)}% (target: ${Math.round(policy.require_tax_exempt_pct * 100)}%)`,
      });
    }

    res.json({
      generated_at: new Date().toISOString(),
      policy_name: policy.policy_name,
      policy_id: policy.id,
      compliant: violations.length === 0,
      violation_count: violations.length,
      warning_count: warnings.length,
      violations,
      warnings,
      portfolio_summary: {
        holding_count: portfolio.holding_count,
        total_market_usd: portfolio.total_market_usd,
        weighted_avg_ytm: portfolio.weighted_avg_ytm,
        weighted_avg_duration: portfolio.weighted_avg_duration,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Compliance check failed', detail: err.message });
  }
});

// ─── POST /check-trade ───────────────────────────────────────────────────────
// Pre-trade compliance: check if a proposed purchase would violate IPS

router.post('/check-trade', (req, res) => {
  try {
    const db = req.fiDb;
    const {
      security_name, security_type, issuer, sector,
      par_value_cents, purchase_price_cents, coupon_rate,
      maturity_date, credit_rating, tax_status = 'taxable',
    } = req.body;

    if (!security_name || !par_value_cents || !purchase_price_cents) {
      return res.status(400).json({ error: 'security_name, par_value_cents, and purchase_price_cents are required' });
    }

    const policy = db.prepare(`
      SELECT * FROM trust_investment_policy 
      WHERE effective_date <= date('now')
      ORDER BY effective_date DESC LIMIT 1
    `).get();

    if (!policy) {
      return res.json({
        pass: true,
        message: 'No active policy — trade passes by default',
        issues: [],
      });
    }

    const holdings = db.prepare('SELECT * FROM fixed_income_holdings WHERE status = ?').all('active');
    const portfolio = analyzePortfolio(holdings);
    const issues = [];

    // Check security type
    const allowedTypes = (policy.allowed_security_types || '').split(',').map(t => t.trim());
    if (security_type && allowedTypes.length > 0 && !allowedTypes.includes(security_type)) {
      issues.push({
        type: 'security_type',
        detail: `${security_type} is not an allowed security type`,
      });
    }

    // Check credit rating
    if (credit_rating && !meetsMinRating(credit_rating, policy.min_credit_rating)) {
      issues.push({
        type: 'credit_rating',
        detail: `Rating ${credit_rating} is below minimum ${policy.min_credit_rating}`,
      });
    }

    // Check maturity
    if (maturity_date) {
      const yearsToMat = (new Date(maturity_date) - new Date()) / (365.25 * 86400000);
      if (yearsToMat > policy.max_maturity_years) {
        issues.push({
          type: 'maturity_limit',
          detail: `Maturity in ${Math.round(yearsToMat * 10) / 10} years exceeds ${policy.max_maturity_years} year limit`,
        });
      }
    }

    // Check issuer concentration post-trade
    if (issuer) {
      const currentIssuerTotal = holdings
        .filter(h => (h.issuer || h.security_name) === issuer)
        .reduce((s, h) => s + (h.market_value_cents || h.purchase_price_cents), 0);
      const newTotal = currentIssuerTotal + purchase_price_cents;
      const newPortTotal = portfolio.total_market_cents + purchase_price_cents;
      const pct = newPortTotal > 0 ? newTotal / newPortTotal : 0;

      if (pct > policy.max_single_issuer_pct) {
        issues.push({
          type: 'issuer_concentration',
          detail: `Post-trade ${issuer} would be ${Math.round(pct * 100)}% of portfolio (limit: ${Math.round(policy.max_single_issuer_pct * 100)}%)`,
        });
      }
    }

    // Check sector concentration post-trade
    if (sector) {
      const currentSectorTotal = holdings
        .filter(h => h.sector === sector)
        .reduce((s, h) => s + (h.market_value_cents || h.purchase_price_cents), 0);
      const newTotal = currentSectorTotal + purchase_price_cents;
      const newPortTotal = portfolio.total_market_cents + purchase_price_cents;
      const pct = newPortTotal > 0 ? newTotal / newPortTotal : 0;

      if (pct > policy.max_sector_pct) {
        issues.push({
          type: 'sector_concentration',
          detail: `Post-trade ${sector} sector would be ${Math.round(pct * 100)}% of portfolio (limit: ${Math.round(policy.max_sector_pct * 100)}%)`,
        });
      }
    }

    res.json({
      pass: issues.length === 0,
      issue_count: issues.length,
      issues,
      proposed_trade: {
        security_name,
        security_type,
        issuer,
        par_value_cents,
        purchase_price_cents,
        par_value_usd: Math.round(par_value_cents) / 100,
        purchase_price_usd: Math.round(purchase_price_cents) / 100,
      },
      policy_name: policy.policy_name,
    });
  } catch (err) {
    res.status(500).json({ error: 'Pre-trade check failed', detail: err.message });
  }
});

// ─── GET /:id ─────────────────────────────────────────────────────────────────
// Registered AFTER /compliance and /check-trade to avoid param shadowing

router.get('/:id', (req, res) => {
  try {
    const db = req.fiDb;
    const policy = db.prepare('SELECT * FROM trust_investment_policy WHERE id = ?').get(req.params.id);

    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }

    res.json(policy);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch policy', detail: err.message });
  }
});

module.exports = router;

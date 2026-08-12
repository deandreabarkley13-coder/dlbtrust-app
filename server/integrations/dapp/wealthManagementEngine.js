'use strict';

/**
 * Wealth Management Engine
 *
 * Open-finance portfolio construction, asset allocation, goal-based planning,
 * and automated rebalancing across trust cash accounts, issuer assets, bank
 * accounts, virtual accounts, and external connections.
 */

const pool = require('../bonds/pgPool');

let CashEngine, TrustAccountingEngine, IssuerEngine, VirtualAccountEngine, TrustBankEngine, BankTransferEngine;
function loadDeps() {
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
  try { ({ IssuerEngine } = require('./issuerEngine')); } catch (e) { IssuerEngine = null; }
  try { ({ VirtualAccountEngine } = require('./virtualAccountEngine')); } catch (e) { VirtualAccountEngine = null; }
  try { ({ TrustBankEngine } = require('./trustBankEngine')); } catch (e) { TrustBankEngine = null; }
  try { ({ BankTransferEngine } = require('./bankTransferEngine')); } catch (e) { BankTransferEngine = null; }
}

function generateId(prefix = 'WM') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

class WealthManagementEngine {
  static async ensureTables() {
    loadDeps();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wealth_portfolios (
        portfolio_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        owner_id TEXT,
        strategy TEXT DEFAULT 'balanced',
        target_allocation JSONB DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
        total_value_cents BIGINT NOT NULL DEFAULT 0,
        unrealized_gain_cents BIGINT NOT NULL DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wealth_holdings (
        holding_id TEXT PRIMARY KEY,
        portfolio_id TEXT NOT NULL REFERENCES wealth_portfolios(portfolio_id),
        asset_code TEXT NOT NULL,
        asset_name TEXT,
        asset_class TEXT DEFAULT 'cash',
        quantity NUMERIC(24,8) NOT NULL DEFAULT 0,
        price_cents BIGINT NOT NULL DEFAULT 0,
        market_value_cents BIGINT NOT NULL DEFAULT 0,
        cost_basis_cents BIGINT NOT NULL DEFAULT 0,
        source_type TEXT,
        source_account_id TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wealth_goals (
        goal_id TEXT PRIMARY KEY,
        portfolio_id TEXT NOT NULL REFERENCES wealth_portfolios(portfolio_id),
        name TEXT NOT NULL,
        target_cents BIGINT NOT NULL,
        deadline DATE,
        priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
        status TEXT DEFAULT 'active' CHECK (status IN ('active','met','missed','cancelled')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wealth_rebalances (
        rebalance_id TEXT PRIMARY KEY,
        portfolio_id TEXT NOT NULL REFERENCES wealth_portfolios(portfolio_id),
        target_allocation JSONB NOT NULL,
        current_allocation JSONB NOT NULL,
        drift_percent NUMERIC(10,4),
        orders JSONB DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','executed','cancelled')),
        executed_at TIMESTAMPTZ,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wealth_holdings_portfolio ON wealth_holdings(portfolio_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_wealth_goals_portfolio ON wealth_goals(portfolio_id)`);
  }

  static async createPortfolio({ name, currency = 'USD', ownerId, strategy = 'balanced', targetAllocation, metadata } = {}) {
    if (!name) throw new Error('name required');
    await this.ensureTables();
    const portfolioId = generateId('WP');
    await pool.query(
      `INSERT INTO wealth_portfolios (portfolio_id, name, currency, owner_id, strategy, target_allocation, status, total_value_cents, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, $7)`,
      [portfolioId, name, currency, ownerId || null, strategy, JSON.stringify(targetAllocation || {}), JSON.stringify(metadata || {})]
    );
    return this.getPortfolio(portfolioId);
  }

  static async getPortfolio(portfolioId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM wealth_portfolios WHERE portfolio_id = $1`, [portfolioId]);
    const portfolio = result.rows[0] || null;
    if (!portfolio) return null;
    const holdings = await this.listHoldings(portfolioId);
    const goals = await this.listGoals(portfolioId);
    const rebalances = await this.listRebalances(portfolioId);
    return { ...portfolio, holdings, goals, rebalances, total_value: round2(portfolio.total_value_cents / 100) };
  }

  static async listPortfolios({ ownerId, limit = 100 } = {}) {
    await this.ensureTables();
    const conditions = [];
    const params = [];
    if (ownerId) { conditions.push(`owner_id = $${params.length + 1}`); params.push(ownerId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const result = await pool.query(`SELECT * FROM wealth_portfolios ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows;
  }

  static async addHolding({ portfolioId, assetCode, assetName, assetClass = 'cash', quantity, price, costBasis, sourceType, sourceAccountId, metadata } = {}) {
    if (!portfolioId || !assetCode || quantity == null) throw new Error('portfolioId, assetCode, quantity required');
    await this.ensureTables();
    const qty = Number(quantity) || 0;
    const priceCents = toCents(price || 0);
    const costCents = toCents(costBasis || (qty * priceCents / 100));
    const marketValueCents = toCents(qty * priceCents / 100);
    const holdingId = generateId('WMH');
    await pool.query(
      `INSERT INTO wealth_holdings (holding_id, portfolio_id, asset_code, asset_name, asset_class, quantity, price_cents, market_value_cents, cost_basis_cents, source_type, source_account_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [holdingId, portfolioId, assetCode, assetName || assetCode, assetClass, qty, priceCents, marketValueCents, costCents, sourceType || null, sourceAccountId || null, JSON.stringify(metadata || {})]
    );
    await this._recalcPortfolio(portfolioId);
    return this.getHolding(holdingId);
  }

  static async getHolding(holdingId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM wealth_holdings WHERE holding_id = $1`, [holdingId]);
    return result.rows[0] || null;
  }

  static async listHoldings(portfolioId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM wealth_holdings WHERE portfolio_id = $1 ORDER BY market_value_cents DESC`, [portfolioId]);
    return result.rows;
  }

  static async updateHoldingPrice(holdingId, price) {
    await this.ensureTables();
    const priceCents = toCents(price);
    const result = await pool.query(
      `UPDATE wealth_holdings SET price_cents = $1, market_value_cents = ROUND((quantity * $1 / 100)::numeric) * 100, updated_at = NOW()
       WHERE holding_id = $2 RETURNING *`,
      [priceCents, holdingId]
    );
    if (result.rows.length) await this._recalcPortfolio(result.rows[0].portfolio_id);
    return result.rows[0] || null;
  }

  static async _recalcPortfolio(portfolioId) {
    await pool.query(
      `UPDATE wealth_portfolios SET total_value_cents = COALESCE((SELECT SUM(market_value_cents) FROM wealth_holdings WHERE portfolio_id = $1), 0), updated_at = NOW() WHERE portfolio_id = $1`,
      [portfolioId]
    );
  }

  static async createGoal({ portfolioId, name, targetAmount, deadline, priority = 'medium', metadata } = {}) {
    if (!portfolioId || !name || !targetAmount) throw new Error('portfolioId, name, targetAmount required');
    await this.ensureTables();
    const goalId = generateId('WMG');
    const targetCents = toCents(targetAmount);
    await pool.query(
      `INSERT INTO wealth_goals (goal_id, portfolio_id, name, target_cents, deadline, priority, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [goalId, portfolioId, name, targetCents, deadline || null, priority, JSON.stringify(metadata || {})]
    );
    return this.getGoal(goalId);
  }

  static async getGoal(goalId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM wealth_goals WHERE goal_id = $1`, [goalId]);
    return result.rows[0] || null;
  }

  static async listGoals(portfolioId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM wealth_goals WHERE portfolio_id = $1 ORDER BY created_at DESC`, [portfolioId]);
    return result.rows;
  }

  static async trackGoal(goalId) {
    await this.ensureTables();
    const goal = await this.getGoal(goalId);
    if (!goal) throw new Error('Goal not found');
    const portfolio = await this.getPortfolio(goal.portfolio_id);
    const currentValue = portfolio.total_value_cents || 0;
    const percent = goal.target_cents > 0 ? round2(currentValue / goal.target_cents * 100) : 0;
    let status = goal.status;
    if (status === 'active') {
      if (currentValue >= goal.target_cents) status = 'met';
      else if (goal.deadline && new Date(goal.deadline) < new Date()) status = 'missed';
    }
    return { goal: { ...goal, current_value_cents: currentValue, percent_of_target: percent, status } };
  }

  static async computeAllocation(portfolioId) {
    await this.ensureTables();
    const portfolio = await this.getPortfolio(portfolioId);
    if (!portfolio) throw new Error('Portfolio not found');
    const total = portfolio.total_value_cents || 1;
    const allocation = {};
    for (const h of portfolio.holdings) {
      allocation[h.asset_code] = {
        asset_name: h.asset_name,
        asset_class: h.asset_class,
        market_value_cents: h.market_value_cents,
        percent: round2((h.market_value_cents / total) * 100),
      };
    }
    return { portfolio_id: portfolioId, total_value_cents: total, target: portfolio.target_allocation, current: allocation };
  }

  static async generateRebalance(portfolioId, driftThreshold = 5) {
    await this.ensureTables();
    const { total_value_cents, target, current } = await this.computeAllocation(portfolioId);
    const targetAlloc = target || {};
    const orders = [];
    let maxDrift = 0;
    const totalNum = Number(total_value_cents) || 1;
    for (const [code, info] of Object.entries(current)) {
      const targetPct = parseFloat(targetAlloc[code]) || 0;
      const currentPct = info.percent || 0;
      const diff = currentPct - targetPct;
      if (Math.abs(diff) > maxDrift) maxDrift = Math.abs(diff);
      if (Math.abs(diff) >= driftThreshold) {
        const targetValueCents = Math.round(totalNum * targetPct / 100);
        const diffCents = targetValueCents - Number(info.market_value_cents);
        orders.push({ asset_code: code, action: diffCents > 0 ? 'buy' : 'sell', amount_cents: Math.abs(diffCents), target_percent: targetPct, current_percent: currentPct });
      }
    }
    // Add missing target assets as buys if not held
    for (const [code, targetPct] of Object.entries(targetAlloc)) {
      if (!current[code] && parseFloat(targetPct) > 0) {
        const targetValueCents = Math.round(totalNum * parseFloat(targetPct) / 100);
        if (targetValueCents > 0) orders.push({ asset_code: code, action: 'buy', amount_cents: targetValueCents, target_percent: parseFloat(targetPct), current_percent: 0 });
      }
    }
    const rebalanceId = generateId('WMR');
    await pool.query(
      `INSERT INTO wealth_rebalances (rebalance_id, portfolio_id, target_allocation, current_allocation, drift_percent, orders, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')`,
      [rebalanceId, portfolioId, JSON.stringify(targetAlloc), JSON.stringify(current), round2(maxDrift), JSON.stringify(orders)]
    );
    return { rebalanceId, portfolioId, drift: round2(maxDrift), orders, status: 'draft' };
  }

  static async approveRebalance(rebalanceId) {
    await this.ensureTables();
    const result = await pool.query(`UPDATE wealth_rebalances SET status = 'approved', updated_at = NOW() WHERE rebalance_id = $1 AND status = 'draft' RETURNING *`, [rebalanceId]);
    if (!result.rows.length) throw new Error('Rebalance not found or not draft');
    return result.rows[0];
  }

  static async executeRebalance(rebalanceId, executer = 'system') {
    await this.ensureTables();
    const res = await pool.query(`SELECT * FROM wealth_rebalances WHERE rebalance_id = $1`, [rebalanceId]);
    const rebalance = res.rows[0];
    if (!rebalance) throw new Error('Rebalance not found');
    if (rebalance.status !== 'approved') throw new Error('Rebalance must be approved first');

    const portfolio = await this.getPortfolio(rebalance.portfolio_id);
    const cashHolding = portfolio.holdings.find(h => h.asset_class === 'cash' || h.asset_code === 'USD' || h.asset_code === 'CASH');
    if (!cashHolding) throw new Error('No cash holding available for rebalancing');

    const orders = Array.isArray(rebalance.orders) ? rebalance.orders : [];
    for (const order of orders) {
      // Move notional cash in/out of target holding; real execution would call engines
      let holding = portfolio.holdings.find(h => h.asset_code === order.asset_code);
      if (order.action === 'buy') {
        if (holding) {
          const newQty = Number(holding.quantity || 0) + Number(order.amount_cents || 0) / 100;
          const newPriceCents = 100;
          await pool.query(
            `UPDATE wealth_holdings SET quantity = $1, price_cents = $2, market_value_cents = $3, updated_at = NOW() WHERE holding_id = $4`,
            [newQty, newPriceCents, toCents(newQty * newPriceCents / 100), holding.holding_id]
          );
        } else {
          await this.addHolding({ portfolioId: rebalance.portfolio_id, assetCode: order.asset_code, assetName: order.asset_code, assetClass: 'synthetic', quantity: Number(order.amount_cents || 0) / 100, price: 1, costBasis: Number(order.amount_cents || 0) / 100, sourceType: 'rebalance', sourceAccountId: cashHolding.holding_id });
        }
      } else if (order.action === 'sell' && holding) {
        const newQty = Math.max(0, Number(holding.quantity || 0) - Number(order.amount_cents || 0) / 100);
        const newPriceCents = holding.price_cents || 100;
        await pool.query(
          `UPDATE wealth_holdings SET quantity = $1, market_value_cents = $2, updated_at = NOW() WHERE holding_id = $3`,
          [newQty, toCents(newQty * newPriceCents / 100), holding.holding_id]
        );
      }
    }
    await this._recalcPortfolio(rebalance.portfolio_id);
    await pool.query(`UPDATE wealth_rebalances SET status = 'executed', executed_at = NOW(), updated_at = NOW() WHERE rebalance_id = $1`, [rebalanceId]);
    return this.getPortfolio(rebalance.portfolio_id);
  }

  static async listRebalances(portfolioId) {
    await this.ensureTables();
    const result = await pool.query(`SELECT * FROM wealth_rebalances WHERE portfolio_id = $1 ORDER BY created_at DESC`, [portfolioId]);
    return result.rows;
  }

  static async snapshotPortfolio(portfolioId) {
    const portfolio = await this.getPortfolio(portfolioId);
    const allocation = await this.computeAllocation(portfolioId);
    return { portfolio, allocation };
  }

  static async aggregateFromTrust(portfolioId, ownerIdentifier) {
    loadDeps();
    await this.ensureTables();
    // Remove prior auto-aggregated holdings to avoid duplication
    await pool.query(`DELETE FROM wealth_holdings WHERE portfolio_id = $1 AND source_type IS NOT NULL`, [portfolioId]);
    const sources = [];
    if (CashEngine) {
      try {
        const cashAccounts = await CashEngine.listAccounts ? CashEngine.listAccounts() : [];
        for (const a of cashAccounts) {
          sources.push({ asset_code: a.account_id, asset_name: a.account_name, asset_class: 'cash', quantity: Number(a.balance_cents || 0) / 100, price: 1, market_value_cents: Number(a.balance_cents || 0), source_type: 'cash', source_account_id: a.account_id });
        }
      } catch (e) { /* ignore */ }
    }
    if (TrustAccountingEngine && TrustAccountingEngine.listAccounts) {
      try {
        const trustAccounts = await TrustAccountingEngine.listAccounts({ limit: 1000 });
        for (const a of trustAccounts) {
          if (a.currency === 'USD') sources.push({ asset_code: a.account_code, asset_name: a.account_name, asset_class: 'trust', quantity: Number(a.balance || 0), price: 1, market_value_cents: toCents(a.balance), source_type: 'trust', source_account_id: a.account_code });
        }
      } catch (e) { /* ignore */ }
    }
    if (IssuerEngine && IssuerEngine.listBalances) {
      try {
        const balances = await IssuerEngine.listBalances();
        for (const b of balances) {
          sources.push({ asset_code: b.asset_code, asset_name: `Issuer ${b.asset_code}`, asset_class: 'issuer', quantity: Number(b.balance || 0), price: 1, market_value_cents: toCents(b.balance), source_type: 'issuer', source_account_id: b.account_id });
        }
      } catch (e) { /* ignore */ }
    }
    if (VirtualAccountEngine && VirtualAccountEngine.listAccounts) {
      try {
        const vas = await VirtualAccountEngine.listAccounts();
        for (const a of vas) sources.push({ asset_code: a.accountNumber, asset_name: a.name, asset_class: 'virtual', quantity: Number(a.balance || 0), price: 1, market_value_cents: toCents(a.balance), source_type: 'virtual', source_account_id: a.id });
      } catch (e) { /* ignore */ }
    }
    if (TrustBankEngine && TrustBankEngine.listAccounts) {
      try {
        const tbas = await TrustBankEngine.listAccounts();
        for (const a of tbas) sources.push({ asset_code: a.account_id, asset_name: a.account_name, asset_class: 'trust_bank', quantity: Number(a.balance_cents || 0) / 100, price: 1, market_value_cents: Number(a.balance_cents || 0), source_type: 'trust_bank', source_account_id: a.account_id });
      } catch (e) { /* ignore */ }
    }

    for (const s of sources) {
      if (s.market_value_cents === 0) continue;
      await this.addHolding({ portfolioId, assetCode: s.asset_code, assetName: s.asset_name, assetClass: s.asset_class, quantity: s.quantity, price: s.price, costBasis: s.quantity * s.price, sourceType: s.source_type, sourceAccountId: s.source_account_id });
    }
    return this.getPortfolio(portfolioId);
  }
}

module.exports = { WealthManagementEngine };

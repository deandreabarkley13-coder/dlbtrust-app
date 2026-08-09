'use strict';

/**
 * Corporate Treasury Management System Engine
 *
 * Upgrades the legacy Treasury Management card into a full corporate treasury
 * workstation: multi-bank cash positioning, cash pools and sweeps, liquidity
 * forecasting, short-term investments, treasury policies/limits, and payment
 * workflow approvals.
 */

const pool = require('../bonds/pgPool');

let SourceOfFundsAdapter;
try { SourceOfFundsAdapter = require('../stablecoin/sourceOfFundsAdapter').SourceOfFundsAdapter; } catch (e) { SourceOfFundsAdapter = null; }

let CashEngine;
try { CashEngine = require('../cash/cashEngine').CashEngine; } catch (e) { CashEngine = null; }

let SettlementEngine;
try { SettlementEngine = require('../dapp/settlementEngine').SettlementEngine; } catch (e) { SettlementEngine = null; }

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function dollars(cents) {
  return Number(cents || 0) / 100;
}

async function query(sql, params) {
  return pool.query(sql, params);
}

class CorporateTreasuryEngine {
  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS corporate_treasury_accounts (
        account_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('bank','ledger','crypto','investment','internal')),
        category TEXT NOT NULL DEFAULT 'operating' CHECK (category IN ('operating','reserve','payroll','tax','capital','investment','escrow','custodian','issuer','trust_corpus','beneficiary','general_reserve')),
        bank_name TEXT DEFAULT '',
        account_number TEXT DEFAULT '',
        routing_number TEXT DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'USD',
        balance_cents BIGINT NOT NULL DEFAULT 0,
        available_cents BIGINT NOT NULL DEFAULT 0,
        hold_cents BIGINT NOT NULL DEFAULT 0,
        target_balance_cents BIGINT DEFAULT 0,
        linked_source_type TEXT DEFAULT '',
        linked_source_id TEXT DEFAULT '',
        ptc_entity_id TEXT DEFAULT '',
        trust_id TEXT DEFAULT '',
        custodian BOOLEAN DEFAULT false,
        issuer BOOLEAN DEFAULT false,
        issuer_asset_code TEXT DEFAULT '',
        reserve_ratio_bps INTEGER DEFAULT 0,
        segregation_level TEXT DEFAULT '',
        metadata JSONB DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS corporate_treasury_cash_pools (
        pool_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        master_account_id TEXT REFERENCES corporate_treasury_accounts(account_id),
        target_balance_cents BIGINT DEFAULT 0,
        sweep_threshold_cents BIGINT DEFAULT 0,
        sweep_direction TEXT DEFAULT 'pull' CHECK (sweep_direction IN ('pull','push','net')),
        participants JSONB DEFAULT '[]',
        rules JSONB DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS corporate_treasury_cash_flows (
        flow_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('inflow','outflow')),
        account_id TEXT REFERENCES corporate_treasury_accounts(account_id),
        counterparty TEXT DEFAULT '',
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        expected_date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'projected' CHECK (status IN ('projected','confirmed','completed','cancelled')),
        category TEXT DEFAULT '',
        source_id TEXT DEFAULT '',
        description TEXT DEFAULT '',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS corporate_treasury_investments (
        investment_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('t_bill','repo','mmf','term_deposit','intercompany','other')),
        account_id TEXT REFERENCES corporate_treasury_accounts(account_id),
        counterparty TEXT DEFAULT '',
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        yield_bps INTEGER DEFAULT 0,
        purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
        maturity_date DATE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed','matured','defaulted')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS corporate_treasury_transactions (
        transaction_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('sweep','transfer','deposit','withdrawal','fx','investment','payment')),
        from_account_id TEXT,
        to_account_id TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','cancelled')),
        reference_id TEXT DEFAULT '',
        related_settlement_id TEXT DEFAULT '',
        description TEXT DEFAULT '',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS corporate_treasury_policies (
        policy_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('payment_limit','daily_limit','counterparty_limit','concentration','approval_threshold','investment_maturity')),
        threshold_cents BIGINT,
        max_amount_cents BIGINT,
        currency TEXT NOT NULL DEFAULT 'USD',
        scope TEXT DEFAULT '',
        approvers JSONB DEFAULT '[]',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS corporate_treasury_workflows (
        workflow_id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'payment' CHECK (type IN ('payment','sweep','investment','policy_override')),
        reference_type TEXT DEFAULT '',
        reference_id TEXT DEFAULT '',
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        required_approvals INTEGER NOT NULL DEFAULT 1,
        approvals JSONB DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','cancelled')),
        policy_id TEXT,
        description TEXT DEFAULT '',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_ct_accounts_enabled ON corporate_treasury_accounts(enabled)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ct_flows_date ON corporate_treasury_cash_flows(expected_date)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ct_flows_status ON corporate_treasury_cash_flows(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ct_txns_status ON corporate_treasury_transactions(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ct_investments_maturity ON corporate_treasury_investments(maturity_date)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ct_workflows_status ON corporate_treasury_workflows(status)`);
  }

  static async syncBalances() {
    const accounts = await this.listAccounts({ enabled: true });
    let updated = 0;
    for (const a of accounts) {
      if (!a.linked_source_type || !a.linked_source_id) continue;
      let cents = 0;
      try {
        if (SourceOfFundsAdapter && SourceOfFundsAdapter.getBalance) {
          cents = await SourceOfFundsAdapter.getBalance({ sourceType: a.linked_source_type, sourceAccountId: a.linked_source_id });
        }
      } catch (e) { console.warn('[corporate-treasury] sync balance failed for', a.account_id, e.message); continue; }
      await query(`
        UPDATE corporate_treasury_accounts
        SET balance_cents = $2, available_cents = $2 - hold_cents, updated_at = NOW()
        WHERE account_id = $1
      `, [a.account_id, cents]);
      updated++;
    }
    return { updated };
  }

  static async getDashboard() {
    await this.syncBalances().catch(() => {});
    const accounts = await this.listAccounts({ enabled: true });
    const pools = await this.listCashPools({ enabled: true });
    const flows = await this.listCashFlows({ status: 'confirmed', fromDate: new Date().toISOString().slice(0,10), toDate: this._addDays(30) });
    const investments = await this.listInvestments({ status: 'active' });
    const workflows = await this.listWorkflows({ status: 'pending' });

    const byCurrency = {};
    let totalCents = 0;
    for (const a of accounts) {
      const c = a.currency || 'USD';
      byCurrency[c] = (byCurrency[c] || 0) + Number(a.available_cents || 0);
      totalCents += Number(a.available_cents || 0);
    }

    const investCents = investments.filter(i => i.status === 'active').reduce((s, i) => s + Number(i.amount_cents || 0), 0);
    const forecast = await this.getLiquidityForecast({ days: 30 });

    const custodianCents = accounts.filter(a => a.custodian || ['custodian','beneficiary','escrow'].includes(a.category)).reduce((s, a) => s + Number(a.available_cents || 0), 0);
    const issuerCents = accounts.filter(a => a.issuer || a.category === 'issuer').reduce((s, a) => s + Number(a.available_cents || 0), 0);
    const trustCorpusCents = accounts.filter(a => a.category === 'trust_corpus').reduce((s, a) => s + Number(a.available_cents || 0), 0);
    const reserveRatio = totalCents ? Math.round((custodianCents / totalCents) * 10000) : 0;

    return {
      totalCashCents: totalCents,
      totalInvestmentsCents: investCents,
      custodianCashCents: custodianCents,
      issuerCashCents: issuerCents,
      trustCorpusCents,
      ptcReserveRatioBps: reserveRatio,
      availableByCurrency: byCurrency,
      accounts: accounts.map(a => ({ ...a, balance: dollars(a.balance_cents), available: dollars(a.available_cents), hold: dollars(a.hold_cents) })),
      pools: pools.map(p => ({ ...p, targetBalance: dollars(p.target_balance_cents), sweepThreshold: dollars(p.sweep_threshold_cents) })),
      upcomingInflowsCents: flows.filter(f => f.type === 'inflow' && f.status !== 'completed').reduce((s, f) => s + Number(f.amount_cents || 0), 0),
      upcomingOutflowsCents: flows.filter(f => f.type === 'outflow' && f.status !== 'completed').reduce((s, f) => s + Number(f.amount_cents || 0), 0),
      investments,
      pendingWorkflows: workflows.length,
      forecastSummary: forecast.slice(0, 8),
    };
  }

  static _addDays(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  static async getLiquidityForecast({ days = 30 } = {}) {
    const accounts = await this.listAccounts({ enabled: true });
    const opening = accounts.reduce((s, a) => s + Number(a.available_cents || 0), 0);
    const from = new Date().toISOString().slice(0, 10);
    const to = this._addDays(days);
    const flows = await this.listCashFlows({ fromDate: from, toDate: to });

    const byDay = {};
    for (const f of flows) {
      if (f.status === 'cancelled') continue;
      const sign = f.type === 'inflow' ? 1 : -1;
      byDay[f.expected_date] = (byDay[f.expected_date] || 0) + sign * Number(f.amount_cents || 0);
    }

    const result = [];
    let running = opening;
    const d = new Date();
    for (let i = 0; i <= days; i++) {
      const date = d.toISOString().slice(0, 10);
      running += (byDay[date] || 0);
      result.push({ date, projectedCents: running, projected: dollars(running), dayChange: byDay[date] || 0 });
      d.setDate(d.getDate() + 1);
    }
    return result;
  }

  // ─── Accounts ───────────────────────────────────────────────────────────────
  static async createAccount(opts = {}) {
    const accountId = opts.accountId || id('CTA');
    const name = opts.name || 'Treasury Account';
    const type = opts.type || 'bank';
    const category = opts.category || 'operating';
    await query(`
      INSERT INTO corporate_treasury_accounts
        (account_id, name, type, category, bank_name, account_number, routing_number, currency, target_balance_cents, linked_source_type, linked_source_id,
         ptc_entity_id, trust_id, custodian, issuer, issuer_asset_code, reserve_ratio_bps, segregation_level, metadata, enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING *
    `, [
      accountId, name, type, category,
      opts.bankName || '', opts.accountNumber || '', opts.routingNumber || '',
      opts.currency || 'USD', toCents(opts.targetBalance || 0),
      opts.linkedSourceType || '', opts.linkedSourceId || '',
      opts.ptcEntityId || '', opts.trustId || '',
      opts.custodian === true, opts.issuer === true, opts.issuerAssetCode || '',
      opts.reserveRatioBps || 0, opts.segregationLevel || '',
      opts.metadata ? JSON.stringify(opts.metadata) : '{}', opts.enabled !== false
    ]);
    const rows = await query('SELECT * FROM corporate_treasury_accounts WHERE account_id = $1', [accountId]);
    return rows.rows[0];
  }

  static async listAccounts({ enabled, type, category } = {}) {
    const conditions = []; const params = []; let i = 1;
    if (enabled !== undefined) { conditions.push(`enabled = $${i++}`); params.push(enabled); }
    if (type) { conditions.push(`type = $${i++}`); params.push(type); }
    if (category) { conditions.push(`category = $${i++}`); params.push(category); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await query(`SELECT * FROM corporate_treasury_accounts ${where} ORDER BY name`, params);
    return rows.rows;
  }

  static async getAccount(accountId) {
    const rows = await query('SELECT * FROM corporate_treasury_accounts WHERE account_id = $1', [accountId]);
    return rows.rows[0] || null;
  }

  static async updateAccount(accountId, updates = {}) {
    const allowed = ['name','type','category','bank_name','account_number','routing_number','currency','target_balance_cents','linked_source_type','linked_source_id','ptc_entity_id','trust_id','custodian','issuer','issuer_asset_code','reserve_ratio_bps','segregation_level','metadata','enabled','balance_cents','available_cents','hold_cents'];
    const sets = []; const params = []; let i = 1;
    for (const k of allowed) {
      if (updates[k] !== undefined) { sets.push(`${k} = $${i++}`); params.push(updates[k]); }
    }
    if (!sets.length) return this.getAccount(accountId);
    params.push(accountId);
    await query(`UPDATE corporate_treasury_accounts SET ${sets.join(', ')}, updated_at = NOW() WHERE account_id = $${i}`, params);
    return this.getAccount(accountId);
  }

  static async deleteAccount(accountId) {
    await query('DELETE FROM corporate_treasury_accounts WHERE account_id = $1', [accountId]);
    return { deleted: accountId };
  }

  // ─── Cash Pools ─────────────────────────────────────────────────────────────
  static async createCashPool(opts = {}) {
    const poolId = opts.poolId || id('CTP');
    await query(`
      INSERT INTO corporate_treasury_cash_pools
        (pool_id, name, currency, master_account_id, target_balance_cents, sweep_threshold_cents, sweep_direction, participants, rules, enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      poolId, opts.name || 'Cash Pool', opts.currency || 'USD', opts.masterAccountId || null,
      toCents(opts.targetBalance || 0), toCents(opts.sweepThreshold || 0),
      opts.sweepDirection || 'pull',
      JSON.stringify(opts.participants || []),
      JSON.stringify(opts.rules || {}),
      opts.enabled !== false
    ]);
    const rows = await query('SELECT * FROM corporate_treasury_cash_pools WHERE pool_id = $1', [poolId]);
    return rows.rows[0];
  }

  static async listCashPools({ enabled } = {}) {
    const where = enabled !== undefined ? 'WHERE enabled = $1' : '';
    const params = enabled !== undefined ? [enabled] : [];
    const rows = await query(`SELECT * FROM corporate_treasury_cash_pools ${where} ORDER BY name`, params);
    return rows.rows;
  }

  static async getCashPool(poolId) {
    const rows = await query('SELECT * FROM corporate_treasury_cash_pools WHERE pool_id = $1', [poolId]);
    return rows.rows[0] || null;
  }

  static async sweepCashPool(poolId) {
    const pool = await this.getCashPool(poolId);
    if (!pool) throw new Error('Pool not found');
    if (!pool.master_account_id) throw new Error('Pool has no master account');
    const participants = Array.isArray(pool.participants) ? pool.participants : (pool.participants || []);
    const master = await this.getAccount(pool.master_account_id);
    if (!master) throw new Error('Master account not found');

    const transactions = [];
    for (const p of participants) {
      if (!p.account_id) continue;
      const acct = await this.getAccount(p.account_id);
      if (!acct || !acct.enabled) continue;
      const available = Number(acct.available_cents || 0);
      const target = Number(pool.target_balance_cents || 0);
      const threshold = Number(pool.sweep_threshold_cents || 0);
      let amountCents = 0;

      if (pool.sweep_direction === 'pull') {
        if (threshold && available > threshold) amountCents = available - target;
        else if (available > target) amountCents = available - target;
      } else if (pool.sweep_direction === 'push') {
        if (available < target) amountCents = Math.min(target - available, Number(master.available_cents || 0));
      } else {
        // net: move toward target
        if (available > target + threshold) amountCents = available - target;
        else if (available < target - threshold) amountCents = Math.min(target - available, Number(master.available_cents || 0));
      }

      if (amountCents <= 0) continue;
      if (pool.sweep_direction === 'push' || (pool.sweep_direction === 'net' && available < target)) {
        // from master to participant
        if (Number(master.available_cents || 0) < amountCents) continue;
      } else {
        // from participant to master
        if (Number(acct.available_cents || 0) < amountCents) continue;
      }

      const fromId = (pool.sweep_direction === 'push' || (pool.sweep_direction === 'net' && available < target)) ? master.account_id : acct.account_id;
      const toId = (pool.sweep_direction === 'push' || (pool.sweep_direction === 'net' && available < target)) ? acct.account_id : master.account_id;

      const txn = await this.createTransaction({
        type: 'sweep',
        fromAccountId: fromId,
        toAccountId: toId,
        amountCents,
        currency: pool.currency || 'USD',
        referenceId: poolId,
        description: `Cash pool sweep ${pool.name}`,
      });

      // If internal cash engine can move the linked ledger, execute immediately
      await this._executeInternalTransfer(txn);
      transactions.push(txn);
    }
    return { poolId, transactions };
  }

  static async _executeInternalTransfer(txn) {
    try {
      if (!CashEngine || !CashEngine.transfer) return;
      const from = await this.getAccount(txn.from_account_id);
      const to = await this.getAccount(txn.to_account_id);
      if (!from || !to) return;
      // Only auto-execute if both accounts are linked to cash source-of-funds
      if (from.linked_source_type === 'cash' && to.linked_source_type === 'cash') {
        await CashEngine.transfer({
          fromAccountId: from.linked_source_id,
          toAccountId: to.linked_source_id,
          amountCents: Number(txn.amount_cents),
          movementType: 'corporate_treasury_sweep',
          memo: txn.description,
          referenceId: txn.transaction_id,
          referenceType: 'corporate_treasury',
        });
        await this.updateTransaction(txn.transaction_id, { status: 'completed', metadata: { executed: true } });
      }
    } catch (e) {
      console.warn('[corporate-treasury] internal sweep execution failed:', e.message);
    }
  }

  // ─── Cash Flows ─────────────────────────────────────────────────────────────
  static async createCashFlow(opts = {}) {
    const flowId = opts.flowId || id('CTF');
    await query(`
      INSERT INTO corporate_treasury_cash_flows
        (flow_id, type, account_id, counterparty, amount_cents, currency, expected_date, status, category, source_id, description, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      flowId, opts.type, opts.accountId || null, opts.counterparty || '',
      toCents(opts.amount), opts.currency || 'USD', opts.expectedDate || new Date().toISOString().slice(0,10),
      opts.status || 'projected', opts.category || '', opts.sourceId || '', opts.description || '',
      JSON.stringify(opts.metadata || {})
    ]);
    const rows = await query('SELECT * FROM corporate_treasury_cash_flows WHERE flow_id = $1', [flowId]);
    return rows.rows[0];
  }

  static async listCashFlows({ accountId, status, fromDate, toDate, type } = {}) {
    const conditions = []; const params = []; let i = 1;
    if (accountId) { conditions.push(`account_id = $${i++}`); params.push(accountId); }
    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    if (type) { conditions.push(`type = $${i++}`); params.push(type); }
    if (fromDate) { conditions.push(`expected_date >= $${i++}`); params.push(fromDate); }
    if (toDate) { conditions.push(`expected_date <= $${i++}`); params.push(toDate); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await query(`SELECT * FROM corporate_treasury_cash_flows ${where} ORDER BY expected_date, type`, params);
    return rows.rows;
  }

  static async updateCashFlow(flowId, updates = {}) {
    const allowed = ['type','account_id','counterparty','amount_cents','currency','expected_date','status','category','source_id','description','metadata'];
    const sets = []; const params = []; let i = 1;
    for (const k of allowed) {
      if (updates[k] !== undefined) { sets.push(`${k} = $${i++}`); params.push(updates[k]); }
    }
    if (!sets.length) return this.getCashFlow(flowId);
    params.push(flowId);
    await query(`UPDATE corporate_treasury_cash_flows SET ${sets.join(', ')}, updated_at = NOW() WHERE flow_id = $${i}`, params);
    return this.getCashFlow(flowId);
  }

  static async getCashFlow(flowId) {
    const rows = await query('SELECT * FROM corporate_treasury_cash_flows WHERE flow_id = $1', [flowId]);
    return rows.rows[0] || null;
  }

  static async deleteCashFlow(flowId) {
    await query('DELETE FROM corporate_treasury_cash_flows WHERE flow_id = $1', [flowId]);
    return { deleted: flowId };
  }

  // ─── Investments ──────────────────────────────────────────────────────────────
  static async createInvestment(opts = {}) {
    const investmentId = opts.investmentId || id('CTI');
    await query(`
      INSERT INTO corporate_treasury_investments
        (investment_id, type, account_id, counterparty, amount_cents, currency, yield_bps, purchase_date, maturity_date, status, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      investmentId, opts.type || 't_bill', opts.accountId || null, opts.counterparty || '',
      toCents(opts.amount), opts.currency || 'USD', opts.yieldBps || 0,
      opts.purchaseDate || new Date().toISOString().slice(0,10),
      opts.maturityDate || null, opts.status || 'active',
      JSON.stringify(opts.metadata || {})
    ]);
    const rows = await query('SELECT * FROM corporate_treasury_investments WHERE investment_id = $1', [investmentId]);
    return rows.rows[0];
  }

  static async listInvestments({ status, type, maturityBefore } = {}) {
    const conditions = []; const params = []; let i = 1;
    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    if (type) { conditions.push(`type = $${i++}`); params.push(type); }
    if (maturityBefore) { conditions.push(`maturity_date <= $${i++}`); params.push(maturityBefore); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await query(`SELECT * FROM corporate_treasury_investments ${where} ORDER BY maturity_date NULLS LAST`, params);
    return rows.rows;
  }

  static async getInvestment(investmentId) {
    const rows = await query('SELECT * FROM corporate_treasury_investments WHERE investment_id = $1', [investmentId]);
    return rows.rows[0] || null;
  }

  static async redeemInvestment(investmentId) {
    const inv = await this.getInvestment(investmentId);
    if (!inv) throw new Error('Investment not found');
    await query(`UPDATE corporate_treasury_investments SET status = 'redeemed', updated_at = NOW() WHERE investment_id = $1`, [investmentId]);
    return this.getInvestment(investmentId);
  }

  // ─── Transactions ─────────────────────────────────────────────────────────────
  static async createTransaction(opts = {}) {
    const txnId = opts.transactionId || id('CTT');
    await query(`
      INSERT INTO corporate_treasury_transactions
        (transaction_id, type, from_account_id, to_account_id, amount_cents, currency, status, reference_id, related_settlement_id, description, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      txnId, opts.type || 'transfer', opts.fromAccountId || null, opts.toAccountId || null,
      opts.amountCents !== undefined ? Number(opts.amountCents) : toCents(opts.amount), opts.currency || 'USD', opts.status || 'pending',
      opts.referenceId || '', opts.relatedSettlementId || '', opts.description || '',
      JSON.stringify(opts.metadata || {})
    ]);
    const rows = await query('SELECT * FROM corporate_treasury_transactions WHERE transaction_id = $1', [txnId]);
    return rows.rows[0];
  }

  static async listTransactions({ status, type, accountId, limit = 100 } = {}) {
    const conditions = []; const params = []; let i = 1;
    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    if (type) { conditions.push(`type = $${i++}`); params.push(type); }
    if (accountId) { conditions.push(`(from_account_id = $${i} OR to_account_id = $${i})`); params.push(accountId); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await query(`SELECT * FROM corporate_treasury_transactions ${where} ORDER BY created_at DESC LIMIT $${i}`, [...params, Number(limit) || 100]);
    return rows.rows;
  }

  static async getTransaction(transactionId) {
    const rows = await query('SELECT * FROM corporate_treasury_transactions WHERE transaction_id = $1', [transactionId]);
    return rows.rows[0] || null;
  }

  static async updateTransaction(transactionId, updates = {}) {
    const allowed = ['status','reference_id','related_settlement_id','metadata'];
    const sets = []; const params = []; let i = 1;
    for (const k of allowed) {
      if (updates[k] !== undefined) { sets.push(`${k} = $${i++}`); params.push(updates[k]); }
    }
    if (!sets.length) return this.getTransaction(transactionId);
    params.push(transactionId);
    await query(`UPDATE corporate_treasury_transactions SET ${sets.join(', ')}, updated_at = NOW() WHERE transaction_id = $${i}`, params);
    return this.getTransaction(transactionId);
  }

  // ─── Policies & Workflows ─────────────────────────────────────────────────────
  static async createPolicy(opts = {}) {
    const policyId = opts.policyId || id('CTY');
    await query(`
      INSERT INTO corporate_treasury_policies
        (policy_id, name, type, threshold_cents, max_amount_cents, currency, scope, approvers, enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      policyId, opts.name, opts.type, toCents(opts.threshold || 0), toCents(opts.maxAmount || 0),
      opts.currency || 'USD', opts.scope || '',
      JSON.stringify(opts.approvers || []), opts.enabled !== false
    ]);
    const rows = await query('SELECT * FROM corporate_treasury_policies WHERE policy_id = $1', [policyId]);
    return rows.rows[0];
  }

  static async listPolicies({ enabled } = {}) {
    const where = enabled !== undefined ? 'WHERE enabled = $1' : '';
    const params = enabled !== undefined ? [enabled] : [];
    const rows = await query(`SELECT * FROM corporate_treasury_policies ${where} ORDER BY name`, params);
    return rows.rows;
  }

  static async deletePolicy(policyId) {
    await query('DELETE FROM corporate_treasury_policies WHERE policy_id = $1', [policyId]);
    return { deleted: policyId };
  }

  static async evaluatePayment({ amountCents, currency = 'USD', accountId, counterparty = '', userRole = '' } = {}) {
    const policies = await this.listPolicies({ enabled: true });
    const reasons = [];
    let requiresApproval = false;
    let maxApproval = 0;

    for (const p of policies) {
      if (p.currency !== currency) continue;
      const scope = p.scope || '';
      if (scope && accountId && scope !== accountId) continue;
      const threshold = Number(p.threshold_cents || 0);
      const maxAmount = Number(p.max_amount_cents || 0);

      if (p.type === 'payment_limit' && maxAmount && amountCents > maxAmount) {
        reasons.push(`Exceeds payment limit ${dollars(maxAmount)}`);
      }
      if (p.type === 'approval_threshold' && threshold && amountCents >= threshold) {
        requiresApproval = true;
        if (amountCents > maxApproval) maxApproval = amountCents;
      }
      if (p.type === 'daily_limit' && maxAmount) {
        const today = await query(`SELECT COALESCE(SUM(amount_cents),0) AS total FROM corporate_treasury_transactions WHERE created_at::date = CURRENT_DATE AND from_account_id = $1`, [accountId || '']);
        const spent = Number(today.rows[0].total || 0);
        if (spent + amountCents > maxAmount) reasons.push(`Exceeds daily limit ${dollars(maxAmount)}`);
      }
      if (p.type === 'counterparty_limit' && maxAmount && counterparty && (p.scope || '').toLowerCase() === counterparty.toLowerCase()) {
        if (amountCents > maxAmount) reasons.push(`Exceeds counterparty limit ${counterparty} ${dollars(maxAmount)}`);
      }
      if (p.type === 'concentration' && maxAmount && accountId) {
        const acct = await this.getAccount(accountId);
        const total = (await this.listAccounts({ enabled: true })).reduce((s, a) => s + Number(a.available_cents || 0), 0);
        if (total && acct) {
          const pct = Number(acct.available_cents || 0) / total;
          if (pct * 100 > maxAmount) reasons.push(`Concentration exceeds ${maxAmount}%`);
        }
      }
    }

    return { allowed: reasons.length === 0, requiresApproval, reasons };
  }

  static async createWorkflow(opts = {}) {
    const workflowId = opts.workflowId || id('CTW');
    const evalResult = await this.evaluatePayment({
      amountCents: toCents(opts.amount),
      currency: opts.currency || 'USD',
      accountId: opts.accountId,
      counterparty: opts.counterparty || '',
    });
    const requiredApprovals = evalResult.requiresApproval ? Math.max(1, opts.requiredApprovals || 1) : 0;
    await query(`
      INSERT INTO corporate_treasury_workflows
        (workflow_id, type, reference_type, reference_id, amount_cents, currency, required_approvals, approvals, status, policy_id, description, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      workflowId, opts.type || 'payment', opts.referenceType || '', opts.referenceId || '',
      toCents(opts.amount), opts.currency || 'USD', requiredApprovals, '[]',
      requiredApprovals ? 'pending' : 'approved', opts.policyId || null, opts.description || '',
      JSON.stringify({ ...opts.metadata || {}, evaluation: evalResult })
    ]);
    const rows = await query('SELECT * FROM corporate_treasury_workflows WHERE workflow_id = $1', [workflowId]);
    return rows.rows[0];
  }

  static async listWorkflows({ status, limit = 50 } = {}) {
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status, Number(limit)] : [Number(limit)];
    const limitSql = status ? 'LIMIT $2' : 'LIMIT $1';
    const rows = await query(`SELECT * FROM corporate_treasury_workflows ${where} ORDER BY created_at DESC ${limitSql}`, params);
    return rows.rows;
  }

  static async getWorkflow(workflowId) {
    const rows = await query('SELECT * FROM corporate_treasury_workflows WHERE workflow_id = $1', [workflowId]);
    return rows.rows[0] || null;
  }

  static async approveWorkflow(workflowId, { approver = 'operator' } = {}) {
    const wf = await this.getWorkflow(workflowId);
    if (!wf) throw new Error('Workflow not found');
    const approvals = Array.isArray(wf.approvals) ? wf.approvals : (wf.approvals || []);
    approvals.push({ approver, at: new Date().toISOString() });
    const status = approvals.length >= wf.required_approvals ? 'approved' : 'pending';
    await query(`UPDATE corporate_treasury_workflows SET approvals = $2, status = $3, updated_at = NOW() WHERE workflow_id = $1`, [workflowId, JSON.stringify(approvals), status]);
    return this.getWorkflow(workflowId);
  }

  static async executeWorkflow(workflowId) {
    const wf = await this.getWorkflow(workflowId);
    if (!wf) throw new Error('Workflow not found');
    if (wf.status !== 'approved') throw new Error('Workflow not approved');
    // If tied to a settlement, execute it
    if (SettlementEngine && wf.reference_type === 'settlement' && wf.reference_id) {
      await SettlementEngine.executeSettlement(wf.reference_id);
    }
    await query(`UPDATE corporate_treasury_workflows SET status = 'executed', updated_at = NOW() WHERE workflow_id = $1`, [workflowId]);
    return this.getWorkflow(workflowId);
  }

  // ─── PTC Custodian / Issuer utilities ─────────────────────────────────────────

  static async setupPTCDefaultAccounts(opts = {}) {
    const ptcEntityId = opts.ptcEntityId || 'PTC-DLB-TRUST';
    const trustId = opts.trustId || 'TRUST-DLB-001';
    const existing = await this.listAccounts({});
    const byName = new Map(existing.map(a => [a.name, a]));
    const ensure = async (name, category, extra = {}) => {
      if (byName.has(name)) return byName.get(name);
      return this.createAccount({ name, category, ptcEntityId, trustId, ...extra });
    };

    const operating = await ensure('PTC Operating Account', 'operating', { type: 'bank', targetBalance: 500000 });
    const custodianReserve = await ensure('PTC Custodian Reserve', 'custodian', { type: 'internal', custodian: true, targetBalance: 1000000 });
    const issuerBacking = await ensure('PTC Issuer Backing', 'issuer', { type: 'internal', issuer: true, issuerAssetCode: 'DLB-PTCUSD', reserveRatioBps: 10000 });
    const trustCorpus = await ensure('PTC Trust Corpus Reserve', 'trust_corpus', { type: 'internal' });
    const beneficiaryEscrow = await ensure('PTC Beneficiary Escrow', 'beneficiary', { type: 'internal', custodian: true, segregationLevel: 'legal' });
    const payroll = await ensure('PTC Payroll / Distributions', 'payroll', { type: 'bank' });
    const tax = await ensure('PTC Tax Reserve', 'tax', { type: 'internal' });
    const generalReserve = await ensure('PTC General Reserve', 'general_reserve', { type: 'internal' });

    // Link to existing source-of-funds where known
    if (!operating.linked_source_type) await this.updateAccount(operating.account_id, { linked_source_type: 'cash', linked_source_id: 'CA-OPERATING' });
    if (!custodianReserve.linked_source_type) await this.updateAccount(custodianReserve.account_id, { linked_source_type: 'treasury', linked_source_id: 'TREASURY_HOT' });
    if (!issuerBacking.linked_source_type) await this.updateAccount(issuerBacking.account_id, { linked_source_type: 'treasury', linked_source_id: 'TREASURY_HOT' });
    if (!trustCorpus.linked_source_type) await this.updateAccount(trustCorpus.account_id, { linked_source_type: 'trust', linked_source_id: '3000' });

    await this.syncBalances();
    return {
      operating, custodianReserve, issuerBacking, trustCorpus,
      beneficiaryEscrow, payroll, tax, generalReserve,
    };
  }

  static async getPTCReport({ ptcEntityId } = {}) {
    const where = ptcEntityId ? 'WHERE ptc_entity_id = $1' : '';
    const params = ptcEntityId ? [ptcEntityId] : [];
    const accounts = (await query(`SELECT * FROM corporate_treasury_accounts ${where}`, params)).rows;
    const total = accounts.reduce((s, a) => s + Number(a.available_cents || 0), 0);
    const custodian = accounts.filter(a => a.custodian || ['custodian','beneficiary','escrow'].includes(a.category)).reduce((s, a) => s + Number(a.available_cents || 0), 0);
    const issuer = accounts.filter(a => a.issuer || a.category === 'issuer').reduce((s, a) => s + Number(a.available_cents || 0), 0);
    const corpus = accounts.filter(a => a.category === 'trust_corpus').reduce((s, a) => s + Number(a.available_cents || 0), 0);
    const issued = accounts.filter(a => a.issuer).reduce((s, a) => {
      const reserved = Math.round(Number(a.available_cents || 0) * (Number(a.reserve_ratio_bps || 0) / 10000));
      return s + reserved;
    }, 0);
    return {
      ptcEntityId,
      totalCashCents: total,
      custodianReserveCents: custodian,
      issuerBackingCents: issuer,
      trustCorpusCents: corpus,
      issuedLiabilityCents: issued,
      reserveRatioBps: issued ? Math.round((issuer / issued) * 10000) : 10000,
      accounts,
    };
  }

  static async segregateBeneficiaryFunds({ trustId, beneficiaryId, amountCents, sourceAccountId, description = '' } = {}) {
    if (!beneficiaryId) throw new Error('beneficiaryId required');
    if (!amountCents || amountCents <= 0) throw new Error('amountCents must be positive');
    const escrowName = `PTC Beneficiary Escrow - ${beneficiaryId}`;
    let escrow = (await this.listAccounts({ category: 'beneficiary' })).find(a => a.name === escrowName && a.trust_id === (trustId || ''));
    if (!escrow) {
      escrow = await this.createAccount({ name: escrowName, category: 'beneficiary', type: 'internal', custodian: true, trustId, segregationLevel: 'legal' });
    }
    const source = sourceAccountId ? await this.getAccount(sourceAccountId) : null;
    const fromId = source ? source.account_id : (await this.listAccounts({ category: 'custodian' }))[0]?.account_id;
    if (!fromId) throw new Error('No source custodian account found');
    const txn = await this.createTransaction({
      type: 'transfer',
      fromAccountId: fromId,
      toAccountId: escrow.account_id,
      amountCents,
      description: description || `Segregate beneficiary ${beneficiaryId}`,
      referenceId: beneficiaryId,
    });
    await this._executeInternalTransfer(txn);
    return { escrow, transaction: txn };
  }

  static async allocateCapitalCall({ trustId, amountCents, targetAccountId } = {}) {
    if (!amountCents || amountCents <= 0) throw new Error('amountCents must be positive');
    const reserve = (await this.listAccounts({ category: 'capital' }))[0] || (await this.listAccounts({ category: 'general_reserve' }))[0];
    if (!reserve) throw new Error('No capital or general reserve account found');
    const target = targetAccountId ? await this.getAccount(targetAccountId) : (await this.listAccounts({ category: 'operating' }))[0];
    if (!target) throw new Error('No target account found');
    const txn = await this.createTransaction({
      type: 'transfer',
      fromAccountId: reserve.account_id,
      toAccountId: target.account_id,
      amountCents,
      description: `Capital call allocation ${trustId || ''}`,
    });
    await this._executeInternalTransfer(txn);
    return { transaction: txn };
  }
}

module.exports = { CorporateTreasuryEngine };

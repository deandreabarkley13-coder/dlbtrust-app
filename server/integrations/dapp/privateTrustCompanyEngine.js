'use strict';

/**
 * PrivateTrustCompanyEngine (PTC Family Support)
 *
 * Treats the Wealth Management / Trust Aggregator dashboard as the single
 * source of truth and lets the Private Trust Company act as custodian/issuer
 * of family support obligations backed by bond/fixed-income principal and
 * interest. Supports ledger credits and IssuerEngine token issuance.
 */

const pool = require('../bonds/pgPool');

let WealthManagementEngine, TrustAggregatorEngine, TrustAccountingEngine, CashEngine, IssuerEngine, LiveBondEngine, BondEngine;
function loadDeps() {
  try { ({ WealthManagementEngine } = require('./wealthManagementEngine')); } catch (e) { WealthManagementEngine = null; }
  try { ({ TrustAggregatorEngine } = require('./trustAggregatorEngine')); } catch (e) { TrustAggregatorEngine = null; }
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
  try { ({ IssuerEngine } = require('./issuerEngine')); } catch (e) { IssuerEngine = null; }
  try { ({ LiveBondEngine } = require('../bonds/liveEngine')); } catch (e) { LiveBondEngine = null; }
  try { ({ BondEngine } = require('../bonds/bondEngine')); } catch (e) { BondEngine = null; }
}

function generateId(prefix = 'PTC') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

async function query(text, params) {
  return pool.query(text, params);
}

class PrivateTrustCompanyEngine {
  static async ensureTables() {
    loadDeps();
    await query(`
      CREATE TABLE IF NOT EXISTS ptc_support_pools (
        pool_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        capacity_cents BIGINT NOT NULL DEFAULT 0,
        issued_cents BIGINT NOT NULL DEFAULT 0,
        redeemed_cents BIGINT NOT NULL DEFAULT 0,
        source_account_codes JSONB DEFAULT '[]',
        asset_code TEXT DEFAULT 'DLB-PTC-SUPPORT',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS ptc_beneficiaries (
        beneficiary_id TEXT PRIMARY KEY,
        pool_id TEXT,
        first_name TEXT,
        last_name TEXT,
        email TEXT,
        contact_id TEXT,
        allocation_percent NUMERIC(5,2) NOT NULL DEFAULT 100,
        support_account_id TEXT,
        token_account_id TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS ptc_support_balances (
        balance_id TEXT PRIMARY KEY,
        beneficiary_id TEXT NOT NULL,
        form TEXT NOT NULL CHECK (form IN ('ledger','token')),
        balance_cents BIGINT NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        asset_code TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ptc_support_balances_beneficiary_form
      ON ptc_support_balances(beneficiary_id, form, asset_code)
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS ptc_distributions (
        distribution_id TEXT PRIMARY KEY,
        pool_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('interest','principal','support')),
        total_cents BIGINT NOT NULL,
        form TEXT NOT NULL CHECK (form IN ('ledger','token','both')),
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('draft','completed','reversed')),
        memo TEXT,
        journal_entry_id TEXT,
        operation_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS ptc_distribution_lines (
        line_id TEXT PRIMARY KEY,
        distribution_id TEXT,
        beneficiary_id TEXT,
        amount_cents BIGINT NOT NULL,
        form TEXT NOT NULL,
        token_operation_id TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  static async ensureDefaultAccounts() {
    if (!TrustAccountingEngine) return;
    const accounts = [
      { code: 'PTC-SUPPORT-PAYABLE', name: 'PTC Family Support Payable', type: 'liability' },
      { code: 'PTC-INTEREST-RECEIVED', name: 'PTC Interest Received', type: 'income' },
      { code: 'PTC-FAMILY-SUPPORT', name: 'PTC Family Support Distribution', type: 'expense' },
    ];
    for (const a of accounts) {
      try {
        await TrustAccountingEngine.createAccount({ accountCode: a.code, accountName: a.name, accountType: a.type, description: `Auto-created for ${a.name}` });
      } catch (e) { /* may already exist */ }
    }
  }

  static async seedPoolAndBeneficiary() {
    loadDeps();
    await this.ensureTables();
    await this.ensureDefaultAccounts();

    let pool = (await query("SELECT * FROM ptc_support_pools WHERE status = 'active' ORDER BY created_at DESC LIMIT 1")).rows[0];
    if (!pool) {
      const poolId = generateId('POOL');
      await query(`
        INSERT INTO ptc_support_pools (pool_id, name, currency, source_account_codes, asset_code, status)
        VALUES ($1, $2, 'USD', $3, 'DLB-PTC-SUPPORT', 'active')
      `, [poolId, 'Family Support Pool', JSON.stringify(['fixed_income:4000', '1100 Bond Investments', '3000 Trust Corpus'])]);
      pool = (await query('SELECT * FROM ptc_support_pools WHERE pool_id = $1', [poolId])).rows[0];
    }

    let beneficiary = (await query("SELECT * FROM ptc_beneficiaries WHERE pool_id = $1 ORDER BY created_at DESC LIMIT 1", [pool.pool_id])).rows[0];
    if (!beneficiary) {
      const beneficiaryId = 'PTC-BEN-DEANDREA-BARKLEY';
      const supportAccountId = `PTC-SUPPORT-${beneficiaryId}`;
      const tokenAccountId = `PTC-TOKEN-${beneficiaryId}`;
      await query(`
        INSERT INTO ptc_beneficiaries (beneficiary_id, pool_id, first_name, last_name, email, contact_id, allocation_percent, support_account_id, token_account_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (beneficiary_id) DO NOTHING
      `, [beneficiaryId, pool.pool_id, 'Deandrea-Lavar', 'Barkley', 'deandreabarkley13@gmail.com', 'CRM-INV-001', 100, supportAccountId, tokenAccountId]);
      beneficiary = (await query('SELECT * FROM ptc_beneficiaries WHERE beneficiary_id = $1', [beneficiaryId])).rows[0];
    }

    if (CashEngine) {
      try { await CashEngine.createAccount({ accountId: 'CA-PTC-RESERVE', accountName: 'PTC Support Reserve', accountType: 'escrow' }); } catch (e) {}
      try { await CashEngine.createAccount({ accountId: 'CA-PTC-DISTRIBUTION', accountName: 'PTC Distribution Clearing', accountType: 'clearing' }); } catch (e) {}
    }

    return { pool, beneficiary };
  }

  static async getSourceOfTruth() {
    loadDeps();
    const result = { netWorth: 0, principal: 0, interest: 0, bonds: [], trustAccounts: [] };
    try {
      if (TrustAggregatorEngine) {
        const nw = await TrustAggregatorEngine.getNetWorth();
        result.netWorth = round2(nw.total || 0);
      }
    } catch (e) {}
    try {
      if (TrustAccountingEngine) {
        const accts = await TrustAccountingEngine.listAccounts({ currency: 'USD' });
        for (const a of accts) {
          const code = a.account_code || '';
          const bal = Number(a.balance || 0);
          if (code.startsWith('1100') || code.startsWith('1210')) result.principal += bal;
          if (code.startsWith('4000') || code.startsWith('4100')) result.interest += bal;
          result.trustAccounts.push({
            code,
            name: a.account_name,
            accountType: a.account_type,
            subType: a.sub_type,
            balance: bal,
            balanceCents: a.current_balance_cents,
            availableBalanceCents: a.available_balance_cents,
            fundingEligible: a.funding_eligible,
            segregationStatus: a.segregation_status,
            segregationReason: a.segregation_reason,
            sourceOfTruth: a.source_of_truth,
          });
        }
      }
    } catch (e) {}
    try {
      if (BondEngine && LiveBondEngine) {
        const bonds = await BondEngine.listBonds();
        for (const b of bonds) {
          const m = await LiveBondEngine.getBondLiveMetrics(b.id);
          result.principal += m.principal_balance || 0;
          result.interest += m.accrued_interest_total || 0;
          result.bonds.push({ id: b.id, name: m.bond_name, principal: m.principal_balance, accruedInterest: m.accrued_interest_total, couponPerPeriod: m.coupon_per_period });
        }
      }
    } catch (e) {}
    return result;
  }

  static async refreshPoolCapacity() {
    loadDeps();
    await this.ensureTables();
    const { pool } = await this.seedPoolAndBeneficiary();
    const sot = await this.getSourceOfTruth();
    const capacityCents = toCents(sot.netWorth > 0 ? sot.netWorth : (sot.principal + sot.interest));
    await query('UPDATE ptc_support_pools SET capacity_cents = $1, updated_at = NOW() WHERE pool_id = $2', [capacityCents, pool.pool_id]);
    return { poolId: pool.pool_id, capacityCents, sourceOfTruth: sot };
  }

  static async listBeneficiaries() {
    await this.ensureTables();
    return (await query('SELECT * FROM ptc_beneficiaries ORDER BY created_at DESC')).rows;
  }

  static async getBeneficiaryStatement(beneficiaryId) {
    await this.ensureTables();
    const beneficiary = (await query('SELECT * FROM ptc_beneficiaries WHERE beneficiary_id = $1', [beneficiaryId])).rows[0];
    if (!beneficiary) throw new Error('Beneficiary not found');
    const balances = (await query('SELECT * FROM ptc_support_balances WHERE beneficiary_id = $1', [beneficiaryId])).rows;
    const distributions = (await query('SELECT d.* FROM ptc_distribution_lines l JOIN ptc_distributions d ON d.distribution_id = l.distribution_id WHERE l.beneficiary_id = $1 ORDER BY d.created_at DESC', [beneficiaryId])).rows;
    return { beneficiary, balances, distributions };
  }

  static async createDistribution({ poolId, type = 'support', totalCents, form = 'ledger', memo, sourceAccountCode, beneficiaryAllocations } = {}) {
    loadDeps();
    if (!totalCents || totalCents <= 0) throw new Error('totalCents must be positive');
    await this.ensureTables();
    const { pool: poolRow } = await this.seedPoolAndBeneficiary();
    const targetPoolId = poolId || poolRow.pool_id;
    const distributionId = generateId('DIST');

    const benRows = beneficiaryAllocations && beneficiaryAllocations.length
      ? beneficiaryAllocations
      : (await query('SELECT * FROM ptc_beneficiaries WHERE pool_id = $1', [targetPoolId])).rows;
    if (!benRows.length) throw new Error('No beneficiaries for distribution');

    const totalPct = benRows.reduce((sum, b) => sum + Number(b.allocation_percent || 0), 0);
    const lines = [];
    let remaining = totalCents;
    for (let i = 0; i < benRows.length; i++) {
      const b = benRows[i];
      const pct = Number(b.allocation_percent || 0) / (totalPct || 100);
      const amountCents = i === benRows.length - 1 ? remaining : Math.floor(totalCents * pct);
      remaining -= amountCents;
      lines.push({ beneficiaryId: b.beneficiary_id, supportAccountId: b.support_account_id, tokenAccountId: b.token_account_id, allocationPercent: Number(b.allocation_percent || 0), amountCents });
    }

    const sourceCode = sourceAccountCode || (type === 'interest' ? '4000' : (type === 'principal' ? '1100' : '3000'));
    const journalResult = { id: null };
    const tokenResults = [];

    if (TrustAccountingEngine && form !== 'token') {
      try {
        const linesJournal = [
          { accountCode: sourceCode, debitAmount: round2(totalCents / 100) },
          { accountCode: 'PTC-SUPPORT-PAYABLE', creditAmount: round2(totalCents / 100) },
        ];
        const je = await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: memo || `PTC ${type} distribution ${distributionId}`,
          referenceType: 'ptc_distribution',
          referenceId: distributionId,
          postedBy: 'PrivateTrustCompanyEngine',
          lines: linesJournal,
        });
        journalResult.id = je.entry_id || je.id || null;
      } catch (e) { journalResult.error = e.message; }
    }

    if (IssuerEngine && form !== 'ledger') {
      try {
        await IssuerEngine.createAsset({ assetCode: 'DLB-PTC-SUPPORT', name: 'PTC Family Support Token', reserveAccountId: 'CA-PTC-RESERVE' });
      } catch (e) { /* asset may exist */ }
      for (const line of lines) {
        if (line.amountCents <= 0) continue;
        try {
          const op = await IssuerEngine.issue({ assetCode: 'DLB-PTC-SUPPORT', amount: round2(line.amountCents / 100), toAccountId: line.tokenAccountId, sourceCashAccountId: 'CA-PTC-DISTRIBUTION', memo: memo || `PTC ${type} token`, createdBy: 'PrivateTrustCompanyEngine' });
          tokenResults.push({ beneficiaryId: line.beneficiaryId, operation: op.operation });
        } catch (e) { tokenResults.push({ beneficiaryId: line.beneficiaryId, error: e.message }); }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO ptc_distributions (distribution_id, pool_id, type, total_cents, form, status, memo, journal_entry_id)
        VALUES ($1,$2,$3,$4,$5,'completed',$6,$7)
      `, [distributionId, targetPoolId, type, totalCents, form, memo || `${type} family support`, journalResult.id]);
      for (const line of lines) {
        const lineId = generateId('LINE');
        const tokenOp = tokenResults.find(t => t.beneficiaryId === line.beneficiaryId);
        await client.query(`
          INSERT INTO ptc_distribution_lines (line_id, distribution_id, beneficiary_id, amount_cents, form, token_operation_id, status)
          VALUES ($1,$2,$3,$4,$5,$6,'completed')
        `, [lineId, distributionId, line.beneficiaryId, line.amountCents, form, tokenOp?.operation?.operation_id || null]);

        if (form !== 'token') {
          await client.query(`
            INSERT INTO ptc_support_balances (balance_id, beneficiary_id, form, balance_cents, currency, asset_code)
            VALUES ($1,$2,'ledger',$3,'USD',NULL)
            ON CONFLICT (beneficiary_id, form, asset_code) DO UPDATE SET balance_cents = ptc_support_balances.balance_cents + EXCLUDED.balance_cents, updated_at = NOW()
          `, [generateId('BAL'), line.beneficiaryId, line.amountCents]);
        }
        if (form !== 'ledger') {
          await client.query(`
            INSERT INTO ptc_support_balances (balance_id, beneficiary_id, form, balance_cents, currency, asset_code)
            VALUES ($1,$2,'token',$3,'USD','DLB-PTC-SUPPORT')
            ON CONFLICT (beneficiary_id, form, asset_code) DO UPDATE SET balance_cents = ptc_support_balances.balance_cents + EXCLUDED.balance_cents, updated_at = NOW()
          `, [generateId('BAL'), line.beneficiaryId, line.amountCents]);
        }
      }
      await client.query('UPDATE ptc_support_pools SET issued_cents = issued_cents + $1, updated_at = NOW() WHERE pool_id = $2', [totalCents, targetPoolId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return { distributionId, poolId: targetPoolId, type, totalCents, form, journalEntryId: journalResult.id, tokenResults, lines };
  }

  static async distributeFromBonds({ bondId, type = 'interest', form = 'ledger', memo } = {}) {
    loadDeps();
    await this.ensureTables();
    const { pool, beneficiary } = await this.seedPoolAndBeneficiary();
    if (!BondEngine || !LiveBondEngine) throw new Error('Bond engines not available');
    const bond = await BondEngine.getBond(bondId);
    if (!bond) throw new Error(`Bond ${bondId} not found`);
    const metrics = await LiveBondEngine.getBondLiveMetrics(bondId);
    const amountDollars = type === 'interest' ? (metrics.accrued_interest_total || 0) : (metrics.principal_balance || 0);
    if (amountDollars <= 0) throw new Error(`No ${type} available for bond ${bondId}`);
    const sourceAccountCode = type === 'interest' ? '4000' : '1100';
    return this.createDistribution({ poolId: pool.pool_id, type, totalCents: toCents(amountDollars), form, memo: memo || `PTC ${type} from ${metrics.bond_name}`, sourceAccountCode });
  }

  static async distributeAllBondInterest({ form = 'ledger' } = {}) {
    loadDeps();
    if (!BondEngine) throw new Error('BondEngine not available');
    const bonds = await BondEngine.listBonds();
    const results = [];
    for (const b of bonds) {
      try { results.push(await this.distributeFromBonds({ bondId: b.id, type: 'interest', form, memo: `Auto interest distribution for ${b.bond_name}` })); }
      catch (e) { results.push({ bondId: b.id, error: e.message }); }
    }
    return results;
  }

  static async redeemSupport({ beneficiaryId, amount, targetCashAccountId, form = 'ledger' } = {}) {
    loadDeps();
    if (!beneficiaryId) throw new Error('beneficiaryId required');
    if (!amount || amount <= 0) throw new Error('amount must be positive');
    const cents = toCents(amount);
    await this.ensureTables();
    const balanceRows = (await query('SELECT * FROM ptc_support_balances WHERE beneficiary_id = $1 AND form = $2 AND asset_code IS NULL ORDER BY balance_cents DESC', [beneficiaryId, form])).rows;
    const totalCents = balanceRows.reduce((sum, r) => sum + Number(r.balance_cents || 0), 0);
    if (totalCents < cents) throw new Error('Insufficient support balance');

    let targetTrustAccountCode = targetCashAccountId || '1000';
    if (targetCashAccountId && targetCashAccountId.startsWith('CA-')) {
      const linked = (await query('SELECT account_code FROM trust_accounts WHERE linked_cash_account = $1 LIMIT 1', [targetCashAccountId])).rows[0];
      targetTrustAccountCode = linked ? linked.account_code : '1000';
    }

    const journalResult = { id: null };
    if (TrustAccountingEngine && form === 'ledger') {
      try {
        const je = await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: `PTC support redemption for ${beneficiaryId}`,
          referenceType: 'ptc_redemption',
          referenceId: beneficiaryId,
          postedBy: 'PrivateTrustCompanyEngine',
          lines: [
            { accountCode: 'PTC-SUPPORT-PAYABLE', debitAmount: round2(cents / 100) },
            { accountCode: targetTrustAccountCode, creditAmount: round2(cents / 100) },
          ],
        });
        journalResult.id = je.entry_id || je.id || null;
      } catch (e) { journalResult.error = e.message; }
    }

    if (IssuerEngine && form === 'token') {
      try {
        const op = await IssuerEngine.redeem({ assetCode: 'DLB-PTC-SUPPORT', amount: round2(cents / 100), fromAccountId: `PTC-TOKEN-${beneficiaryId}`, targetCashAccountId: targetCashAccountId || 'CA-PTC-RESERVE', memo: 'PTC token redemption', createdBy: 'PrivateTrustCompanyEngine' });
        journalResult.tokenOperation = op.operation;
      } catch (e) { journalResult.error = e.message; }
    }

    if (journalResult.error) throw new Error(journalResult.error);

    let remaining = cents;
    for (const row of balanceRows) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, Number(row.balance_cents || 0));
      await query('UPDATE ptc_support_balances SET balance_cents = balance_cents - $1, updated_at = NOW() WHERE balance_id = $2', [deduct, row.balance_id]);
      remaining -= deduct;
    }
    await query('UPDATE ptc_support_pools SET redeemed_cents = redeemed_cents + $1, updated_at = NOW() WHERE pool_id = (SELECT pool_id FROM ptc_beneficiaries WHERE beneficiary_id = $2 LIMIT 1)', [cents, beneficiaryId]);
    return { beneficiaryId, amount, cents, form, journalEntryId: journalResult.id, tokenOperation: journalResult.tokenOperation };
  }
}

module.exports = { PrivateTrustCompanyEngine };

'use strict';

/**
 * Deposit and Settlement Engine
 *
 * Closes the fiat gap for the PTC by recording real-money deposits into the
 * custodial Stripe Treasury cash account and initiating outbound settlements.
 *
 * Responsibilities:
 *   - recordDeposit: credit a cash account and post the matching trust GL entry
 *   - initiateSettlement: validate CIP, reserve ledger cash, prefund the Stripe
 *     Treasury account, and submit an outbound clearing instruction
 *   - reconcile: update order status from external settlement events and
 *     reverse ledger entries on failed/returned settlements
 *
 * The engine delegates the actual external clearing to ClearingApiEngine and
 * StripeTreasuryEngine, while keeping the PTC trust ledger as source of truth.
 */

const pg = require('../bonds/pgPool');

function id(prefix = 'DS') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

function safeJson(obj) {
  try { return JSON.stringify(obj || {}, (k, v) => typeof v === 'bigint' ? String(v) : v); } catch { return '{}'; }
}

let CashEngine;
let TrustAccountingEngine;
let ClearingApiEngine;
let CustomerIdentificationEngine;
let StripeTreasuryEngine;

function loadDeps() {
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch {}
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch {}
  try { ({ ClearingApiEngine } = require('./clearingApiEngine')); } catch {}
  try { ({ CustomerIdentificationEngine } = require('../compliance/customerIdentificationEngine')); } catch {}
  try { ({ StripeTreasuryEngine } = require('./stripeTreasuryEngine')); } catch {}
}

function accountTypeForCode(code) {
  if (String(code).startsWith('1')) return 'asset';
  if (String(code).startsWith('2')) return 'liability';
  if (String(code).startsWith('3')) return 'equity';
  if (String(code).startsWith('4')) return 'income';
  if (String(code).startsWith('5')) return 'expense';
  return 'liability';
}

function trustAccountName(code) {
  if (code === '1100') return 'Cash';
  if (code === '3000') return 'Trust Corpus';
  if (code === '4000') return 'Interest Income';
  if (code === 'PTC-DEPOSIT-CLEARING') return 'Deposit Clearing';
  if (code === 'PTC-SETTLEMENT-CLEARING') return 'Settlement Clearing';
  return code;
}

class DepositAndSettlementEngine {
  static async ensureTables() {
    if (!pg || !pg.query) return;
    await pg.query(`
      CREATE TABLE IF NOT EXISTS deposit_settlement_orders (
        id SERIAL PRIMARY KEY,
        order_id TEXT UNIQUE NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('deposit','settlement')),
        rail TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','completed','failed','returned','manual')),
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        source_cash_account_id TEXT,
        source_trust_account_code TEXT,
        destination_cash_account_id TEXT,
        destination_trust_account_code TEXT,
        destination JSONB DEFAULT '{}',
        member_id TEXT,
        external_reference TEXT,
        clearing_id TEXT,
        ledger_entry_id TEXT,
        ledger_reversal_id TEXT,
        raw_request JSONB DEFAULT '{}',
        raw_response JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        initiated_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_ds_orders_status ON deposit_settlement_orders(status)`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_ds_orders_external ON deposit_settlement_orders(external_reference)`);
  }

  static async ensureTrustAccount(code, name, type) {
    if (!TrustAccountingEngine) return null;
    const existing = await TrustAccountingEngine.getAccount(code).catch(() => null);
    if (existing) return existing;
    return TrustAccountingEngine.createAccount({
      accountCode: code,
      accountName: name || trustAccountName(code),
      accountType: type || accountTypeForCode(code),
      description: 'Auto-created by Deposit & Settlement Engine',
    }).catch(() => null);
  }

  static async ensureCashAccount(accountId, name, type) {
    if (!CashEngine) return null;
    const existing = await CashEngine.getAccount(accountId).catch(() => null);
    if (existing) return existing;
    return CashEngine.createAccount({
      accountId,
      accountName: name || accountId,
      accountType: type || 'escrow',
      notes: 'Auto-created by Deposit & Settlement Engine',
    }).catch(() => null);
  }

  static async recordDeposit({
    amount,
    rail = 'stripe_treasury',
    source,
    cashAccountId = 'CA-STRIPE-TREASURY',
    trustAccountCode = 'PTC-DEPOSIT-CLEARING',
    externalReference,
    description,
    initiatedBy,
    metadata = {},
  } = {}) {
    loadDeps();
    const amountCents = toCents(amount);
    if (!amountCents || amountCents <= 0) throw new Error('amount must be positive');
    const orderId = id('DEP');

    await this.ensureCashAccount(cashAccountId, 'Stripe Treasury Custodial Cash', 'escrow');
    await this.ensureTrustAccount('1100', 'Cash', 'asset');
    await this.ensureTrustAccount(trustAccountCode, trustAccountName(trustAccountCode), accountTypeForCode(trustAccountCode));

    let cashMovement = null;
    if (CashEngine) {
      cashMovement = await CashEngine.deposit({
        toAccountId: cashAccountId,
        amountCents,
        memo: description || `Deposit ${orderId}`,
        referenceId: externalReference || orderId,
        initiatedBy,
      });
    }

    let journalEntry = null;
    if (TrustAccountingEngine) {
      journalEntry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: description || `Deposit ${orderId} from ${rail}`,
        referenceType: 'deposit_settlement',
        referenceId: orderId,
        postedBy: initiatedBy || 'DepositAndSettlementEngine',
        lines: [
          { accountCode: '1100', debitAmount: (amountCents / 100).toFixed(2) },
          { accountCode: trustAccountCode, creditAmount: (amountCents / 100).toFixed(2) },
        ],
      });
    }

    const row = {
      order_id: orderId,
      direction: 'deposit',
      rail,
      status: 'posted',
      amount_cents: amountCents,
      currency: 'USD',
      source_cash_account_id: cashAccountId,
      destination_trust_account_code: trustAccountCode,
      destination: safeJson({ source, rail }),
      external_reference: externalReference || null,
      clearing_id: null,
      ledger_entry_id: journalEntry ? journalEntry.entry_id : (cashMovement ? cashMovement.movement_id : null),
      raw_request: safeJson({ amount, rail, source, cashAccountId, trustAccountCode, externalReference, description, metadata, initiatedBy }),
      raw_response: safeJson({ cashMovement, journalEntry }),
      metadata: safeJson(metadata || {}),
      initiated_by: initiatedBy || 'system',
    };
    if (pg && pg.query) {
      const cols = Object.keys(row).join(',');
      const vals = Object.keys(row).map((_, i) => `$${i + 1}`).join(',');
      await pg.query(`INSERT INTO deposit_settlement_orders (${cols}) VALUES (${vals})`, Object.values(row));
    }

    return { orderId, status: 'posted', cashMovement, journalEntry };
  }

  static async initiateSettlement({
    amount,
    rail = 'stripe_ach',
    sourceCashAccountId = 'CA-OPERATING',
    sourceTrustAccountCode = '1100',
    clearingTrustAccountCode = 'PTC-SETTLEMENT-CLEARING',
    destination,
    memberId,
    description,
    initiatedBy,
    requireCip = true,
    prefund = true,
    metadata = {},
  } = {}) {
    loadDeps();
    const amountCents = toCents(amount);
    if (!amountCents || amountCents <= 0) throw new Error('amount must be positive');
    if (!destination || !destination.accountNumber) throw new Error('destination.accountNumber required');
    const orderId = id('SET');
    const railNorm = String(rail).toLowerCase();

    if (requireCip && railNorm.startsWith('stripe_')) {
      if (!CustomerIdentificationEngine) throw new Error('CustomerIdentificationEngine not available');
      const cip = await CustomerIdentificationEngine.validatePayoutRecipient({
        fullName: destination.accountHolderName || destination.recipientName || destination.fullName,
        email: destination.email,
        requireClear: true,
      });
      if (!cip.valid) throw new Error(`CIP required for settlement: ${cip.reason}`);
    }

    await this.ensureCashAccount(sourceCashAccountId, 'PTC Operating Cash', 'operating');
    if (CashEngine) {
      const acct = await CashEngine.getAccount(sourceCashAccountId);
      if (!acct) throw new Error(`Source cash account not found: ${sourceCashAccountId}`);
      if (parseInt(acct.balance_cents || 0, 10) < amountCents) throw new Error(`Insufficient balance in ${sourceCashAccountId}`);
    }

    let prefundResult = { prefunded: true, mode: 'skipped' };
    if (prefund && railNorm.startsWith('stripe_')) {
      if (!StripeTreasuryEngine) throw new Error('StripeTreasuryEngine not available');
      prefundResult = await StripeTreasuryEngine.prefundFromPtc({
        amount,
        sourceCashAccountId,
        description: `Prefund for ${orderId}`,
      });
      if (!prefundResult.prefunded) {
        const manualRow = {
          order_id: orderId,
          direction: 'settlement',
          rail,
          status: 'manual',
          amount_cents: amountCents,
          source_cash_account_id: sourceCashAccountId,
          source_trust_account_code: sourceTrustAccountCode,
          destination: safeJson(destination),
          member_id: memberId || null,
          external_reference: null,
          clearing_id: null,
          ledger_entry_id: null,
          raw_request: safeJson({ amount, rail, sourceCashAccountId, sourceTrustAccountCode, clearingTrustAccountCode, destination, memberId, description, requireCip, prefund, metadata, initiatedBy }),
          raw_response: safeJson({ prefundResult }),
          metadata: safeJson(metadata || {}),
          initiated_by: initiatedBy || 'system',
        };
        if (pg && pg.query) {
          const cols = Object.keys(manualRow).join(',');
          const vals = Object.keys(manualRow).map((_, i) => `$${i + 1}`).join(',');
          await pg.query(`INSERT INTO deposit_settlement_orders (${cols}) VALUES (${vals})`, Object.values(manualRow));
        }
        return { orderId, status: 'manual', instruction: prefundResult.instruction, prefundResult };
      }
    }

    await this.ensureTrustAccount(sourceTrustAccountCode, trustAccountName(sourceTrustAccountCode), accountTypeForCode(sourceTrustAccountCode));
    await this.ensureTrustAccount(clearingTrustAccountCode, 'Settlement Clearing', 'expense');

    let journalEntry = null;
    if (TrustAccountingEngine) {
      journalEntry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: description || `Settlement ${orderId} via ${rail}`,
        referenceType: 'deposit_settlement',
        referenceId: orderId,
        postedBy: initiatedBy || 'DepositAndSettlementEngine',
        lines: [
          { accountCode: clearingTrustAccountCode, debitAmount: (amountCents / 100).toFixed(2) },
          { accountCode: sourceTrustAccountCode, creditAmount: (amountCents / 100).toFixed(2) },
        ],
      });
    }

    let destinationCashAccountId = sourceCashAccountId;
    let cashMovement = null;
    if (railNorm.startsWith('stripe_')) {
      destinationCashAccountId = 'CA-STRIPE-TREASURY';
      await this.ensureCashAccount(destinationCashAccountId, 'Stripe Treasury Custodial Cash', 'escrow');
      if (CashEngine && prefundResult.prefunded) {
        cashMovement = await CashEngine.transfer({
          fromAccountId: sourceCashAccountId,
          toAccountId: destinationCashAccountId,
          amountCents,
          movementType: 'settlement_prefund',
          memo: `Prefund ${orderId}`,
          referenceId: orderId,
          initiatedBy,
        }).catch((e) => ({ error: e.message }));
      }
    }

    const clearingResult = await ClearingApiEngine.submit({
      direction: 'outbound',
      rail,
      amount,
      sourceAccountId: destinationCashAccountId,
      destination,
      reference: orderId,
      metadata: { ...metadata, orderId, memberId },
      initiatedBy,
    });

    const status = clearingResult.status === 'completed' ? 'completed' : (clearingResult.status === 'failed' ? 'failed' : (clearingResult.status === 'manual_pending' ? 'manual' : 'pending'));
    const row = {
      order_id: orderId,
      direction: 'settlement',
      rail,
      status,
      amount_cents: amountCents,
      source_cash_account_id: sourceCashAccountId,
      source_trust_account_code: sourceTrustAccountCode,
      destination_cash_account_id: destinationCashAccountId,
      destination_trust_account_code: clearingTrustAccountCode,
      destination: safeJson(destination),
      member_id: memberId || null,
      external_reference: clearingResult.externalReference,
      clearing_id: clearingResult.clearingId,
      ledger_entry_id: journalEntry ? journalEntry.entry_id : null,
      raw_request: safeJson({ amount, rail, sourceCashAccountId, sourceTrustAccountCode, clearingTrustAccountCode, destination, memberId, description, requireCip, prefund, metadata, initiatedBy }),
      raw_response: safeJson({ prefundResult, clearingResult, journalEntry, cashMovement }),
      metadata: safeJson(metadata || {}),
      initiated_by: initiatedBy || 'system',
    };
    if (pg && pg.query) {
      const cols = Object.keys(row).join(',');
      const vals = Object.keys(row).map((_, i) => `$${i + 1}`).join(',');
      await pg.query(`INSERT INTO deposit_settlement_orders (${cols}) VALUES (${vals})`, Object.values(row));
    }

    return {
      orderId,
      status,
      clearingId: clearingResult.clearingId,
      externalReference: clearingResult.externalReference,
      prefundResult,
      clearingResult,
      journalEntry,
      cashMovement,
    };
  }

  static async reconcile({ orderId, externalReference, status, rawResponse, initiatedBy } = {}) {
    loadDeps();
    if (!orderId && !externalReference) throw new Error('orderId or externalReference required');
    let row;
    if (orderId) {
      const res = await pg.query('SELECT * FROM deposit_settlement_orders WHERE order_id=$1', [orderId]);
      row = res.rows[0];
    } else {
      const res = await pg.query('SELECT * FROM deposit_settlement_orders WHERE external_reference=$1 ORDER BY created_at DESC LIMIT 1', [externalReference]);
      row = res.rows[0];
    }
    if (!row) throw new Error('Order not found');

    const newStatus = status === 'posted' ? 'completed' : (['failed', 'returned'].includes(status) ? status : (status || row.status));
    if (newStatus === row.status && !rawResponse) return { orderId: row.order_id, status: row.status, row };

    let reversalEntry = null;
    if ((newStatus === 'failed' || newStatus === 'returned') && TrustAccountingEngine && row.ledger_entry_id && !row.ledger_reversal_id) {
      const original = await TrustAccountingEngine.getJournalEntry(row.ledger_entry_id).catch(() => null);
      if (original && original.lines && original.lines.length) {
        const reversalLines = original.lines.map(l => ({
          accountCode: l.account_code,
          debitAmount: parseFloat(l.credit_amount || 0).toFixed(2),
          creditAmount: parseFloat(l.debit_amount || 0).toFixed(2),
        }));
        reversalEntry = await TrustAccountingEngine.postJournalEntry({
          entryDate: new Date(),
          description: `Reversal of ${row.order_id}`,
          referenceType: 'deposit_settlement_reversal',
          referenceId: row.order_id,
          postedBy: initiatedBy || 'DepositAndSettlementEngine',
          lines: reversalLines,
        });
      }
    }

    await pg.query(
      `UPDATE deposit_settlement_orders SET status=$1, raw_response=$2::jsonb, ledger_reversal_id=$3, updated_at=NOW() WHERE order_id=$4`,
      [newStatus, safeJson(rawResponse || {}), reversalEntry ? reversalEntry.entry_id : null, row.order_id]
    );

    return { orderId: row.order_id, status: newStatus, reversalEntry, row };
  }

  static async list({ direction, status, limit = 50 } = {}) {
    if (!pg || !pg.query) return [];
    const conditions = [];
    const params = [];
    if (direction) { conditions.push(`direction=$${params.length + 1}`); params.push(direction); }
    if (status) { conditions.push(`status=$${params.length + 1}`); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const res = await pg.query(`SELECT * FROM deposit_settlement_orders ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return res.rows;
  }

  static async get(orderId) {
    if (!pg || !pg.query) return null;
    const res = await pg.query('SELECT * FROM deposit_settlement_orders WHERE order_id=$1', [orderId]);
    return res.rows[0] || null;
  }
}

module.exports = { DepositAndSettlementEngine };

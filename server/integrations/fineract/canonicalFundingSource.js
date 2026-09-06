'use strict';

/**
 * Canonical funding source — the treasury core-banking ERP (Apache Fineract)
 * as the authority on whether trust money exists before any rail spends it.
 *
 * The local trust ledger (`trust_accounts`) is a sub-ledger. Fineract's GL is
 * the system of record, and the two can drift (a sync that has not run, an
 * entry posted in one book only). Every earlier rail asked the sub-ledger for
 * a balance, so a drifted book could authorize funding the canonical GL does
 * not support. This engine inverts that:
 *
 *   availableCents = min(canonical GL, sub-ledger) − reserve buffer
 *   drift > tolerance  →  restricted (funding refused, not silently netted)
 *
 * Movement is symmetrical. A commit posts ONE double-entry through
 * TrustAccountingEngine with `postToFineract`, so the sub-ledger and the
 * canonical GL move in the same call — resolving each line's `fineractGlId`
 * from the `fineract_gl_mappings` table (or CANONICAL_GL_MAP). When an
 * operating savings account is configured, the cash actually leaves it via a
 * Fineract withdrawal; reversal deposits it back and reverses the journal.
 *
 * Gating: CANONICAL_FUNDING_LIVE must be true to move money in Fineract.
 * Otherwise commit() returns a plan (what it *would* post) and touches
 * nothing — the same shadow discipline the on-chain rails use.
 */

const { FineractClient } = require('./fineractClient');

let TrustAccountingEngine = null;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { /* optional */ }

let pool = null;
try { pool = require('../bonds/pgPool'); } catch (e) { /* no DB in tests */ }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }
function toCents(usd) { return Math.round((Number(usd) || 0) * 100); }
function fromCents(cents) { return (Number(cents) || 0) / 100; }
function reject(message, code, status = 422) { return Object.assign(new Error(message), { code, status }); }

/** Fineract savings payloads nest balances under `summary` in most versions. */
function savingsBalances(account) {
  const summary = (account && account.summary) || account || {};
  const balance = Number(summary.accountBalance ?? summary.balance ?? 0);
  const available = Number(summary.availableBalance ?? balance);
  const onHold = Number(summary.onHoldFunds ?? 0);
  return {
    balanceCents: toCents(balance),
    availableCents: Math.max(0, toCents(Math.min(balance, available)) - toCents(onHold)),
    currency: (account && account.currency && account.currency.code) || 'USD',
    status: (account && account.status && account.status.value) || null,
    active: !account || !account.status || account.status.active !== false,
  };
}

class CanonicalFundingSource {
  static getConfig() {
    return {
      sourceType: 'canonical',
      system: 'fineract',
      fineractUrl: str('FINERACT_URL', 'https://localhost:8443/fineract-provider/api/v1'),
      tenantId: str('FINERACT_TENANT_ID', 'default'),
      // Trust chart-of-accounts codes this rail funds from / into.
      cashAccountCode: str('CANONICAL_FUNDING_CASH_ACCOUNT_CODE') || str('TREASURY_TOPUP_CASH_ACCOUNT_CODE', '1000'),
      assetAccountCode: str('CANONICAL_FUNDING_ASSET_ACCOUNT_CODE') || str('TREASURY_TOPUP_CRYPTO_ACCOUNT_CODE', '1210'),
      // Optional operating savings account the cash physically leaves.
      savingsAccountId: str('CANONICAL_FUNDING_SAVINGS_ACCOUNT_ID') || null,
      paymentTypeId: num('CANONICAL_FUNDING_PAYMENT_TYPE_ID', 1),
      officeId: num('CANONICAL_FUNDING_OFFICE_ID', 1),
      // Cash that must remain behind after any funding draw.
      reserveCents: toCents(num('CANONICAL_FUNDING_MIN_RESERVE_USD', 0)),
      driftToleranceCents: toCents(num('CANONICAL_FUNDING_DRIFT_TOLERANCE_USD', 1)),
      allowDrift: str('CANONICAL_FUNDING_ALLOW_DRIFT') === 'true',
      // "1000:12,1210:15" — fallback when fineract_gl_mappings is unavailable.
      glMapOverride: str('CANONICAL_GL_MAP'),
      live: str('CANONICAL_FUNDING_LIVE') === 'true',
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!TrustAccountingEngine) issues.push('TrustAccountingEngine not available');
    if (!cfg.cashAccountCode) issues.push('CANONICAL_FUNDING_CASH_ACCOUNT_CODE not configured');
    if (!cfg.assetAccountCode) issues.push('CANONICAL_FUNDING_ASSET_ACCOUNT_CODE not configured');
    if (/localhost/.test(cfg.fineractUrl)) issues.push(`FINERACT_URL still points at ${cfg.fineractUrl}`);
    return {
      sourceType: cfg.sourceType,
      system: cfg.system,
      fineractUrl: cfg.fineractUrl,
      tenantId: cfg.tenantId,
      cashAccountCode: cfg.cashAccountCode,
      assetAccountCode: cfg.assetAccountCode,
      savingsAccountId: cfg.savingsAccountId,
      reserveUsd: fromCents(cfg.reserveCents),
      driftToleranceUsd: fromCents(cfg.driftToleranceCents),
      allowDrift: cfg.allowDrift,
      live: cfg.live,
      resilience: FineractClient.getResilienceStatus(),
      ready: issues.length === 0,
      issues,
    };
  }

  /** trust account code → Fineract GL account id. */
  static async glMap() {
    const cfg = this.getConfig();
    const map = {};
    if (pool && pool.query) {
      const { rows } = await pool.query(
        `SELECT trust_account_code, fineract_gl_id FROM fineract_gl_mappings WHERE mapping_type = 'trust_journal'`
      ).catch(() => ({ rows: [] }));
      for (const row of rows) map[String(row.trust_account_code)] = Number(row.fineract_gl_id);
    }
    for (const pair of cfg.glMapOverride.split(',').map((p) => p.trim()).filter(Boolean)) {
      const [code, glId] = pair.split(':').map((p) => p.trim());
      if (code && Number.isFinite(Number(glId))) map[code] = Number(glId);
    }
    return map;
  }

  static async resolveGlId(accountCode, map) {
    const resolved = (map || await this.glMap())[String(accountCode)];
    return Number.isFinite(resolved) ? resolved : null;
  }

  /** Balance of a GL account as computed by Fineract from its journal entries. */
  static async canonicalGlBalanceCents({ accountCode, glAccountId }) {
    const summary = await FineractClient.getGLSummary();
    const groups = (summary && summary.accounts) || {};
    for (const group of Object.values(groups)) {
      for (const account of group || []) {
        const matches = (glAccountId && Number(account.id) === Number(glAccountId))
          || (accountCode && String(account.glCode) === String(accountCode));
        if (matches) return { balanceCents: toCents(account.balance), glAccount: account };
      }
    }
    return { balanceCents: null, glAccount: null };
  }

  /**
   * Canonical availability. The ERP wins: funding is capped by the lower of
   * the canonical GL and the sub-ledger, and a drift beyond tolerance
   * restricts the source instead of being netted away.
   */
  static async position({ accountCode, purpose = 'treasury funding', savingsAccountId } = {}) {
    const cfg = this.getConfig();
    const code = String(accountCode || cfg.cashAccountCode);
    const map = await this.glMap();
    const glAccountId = await this.resolveGlId(code, map);

    let canonical = { balanceCents: null, glAccount: null };
    let degraded = null;
    try {
      canonical = await this.canonicalGlBalanceCents({ accountCode: code, glAccountId });
    } catch (err) {
      degraded = `fineract unavailable: ${err.message}`;
    }

    let savings = null;
    const savingsId = savingsAccountId || cfg.savingsAccountId;
    if (savingsId) {
      try {
        savings = savingsBalances(await FineractClient.getAccountBalance(savingsId));
      } catch (err) {
        degraded = degraded || `savings account ${savingsId} unavailable: ${err.message}`;
      }
    }

    let ledgerCents = null;
    if (TrustAccountingEngine) {
      const ledger = await TrustAccountingEngine.getFundingPosition(code, { purpose }).catch(() => null);
      if (ledger) {
        ledgerCents = Number(ledger.available_balance_cents ?? ledger.current_balance_cents ?? 0);
        if (!ledger.funding_eligible) {
          return this._restricted({ code, glAccountId, canonical, savings, ledgerCents, reason: ledger.segregation_reason || 'sub-ledger restricted', degraded });
        }
      }
    }

    if (canonical.balanceCents === null) {
      return this._restricted({ code, glAccountId, canonical, savings, ledgerCents, reason: degraded || `no canonical GL balance for account ${code}`, degraded });
    }
    if (savings && !savings.active) {
      return this._restricted({ code, glAccountId, canonical, savings, ledgerCents, reason: `savings account ${savingsId} is ${savings.status || 'inactive'}`, degraded });
    }

    const driftCents = ledgerCents === null ? 0 : ledgerCents - canonical.balanceCents;
    if (!cfg.allowDrift && Math.abs(driftCents) > cfg.driftToleranceCents) {
      return this._restricted({
        code, glAccountId, canonical, savings, ledgerCents, driftCents, degraded,
        reason: `sub-ledger and canonical GL differ by $${fromCents(Math.abs(driftCents))} — reconcile before funding`,
      });
    }

    const candidates = [canonical.balanceCents, ledgerCents, savings ? savings.availableCents : null]
      .filter((c) => c !== null && c !== undefined);
    const availableCents = Math.max(0, Math.min(...candidates) - cfg.reserveCents);
    return {
      sourceType: cfg.sourceType,
      sourceOfTruth: 'fineract',
      accountCode: code,
      glAccountId,
      glAccount: canonical.glAccount,
      canonicalBalanceCents: canonical.balanceCents,
      ledgerBalanceCents: ledgerCents,
      driftCents,
      savingsAccountId: savingsId || null,
      savings,
      reserveCents: cfg.reserveCents,
      availableBalanceCents: availableCents,
      fundingEligible: availableCents > 0,
      segregationStatus: availableCents > 0 ? 'available' : 'restricted',
      segregationReason: availableCents > 0 ? null : 'no canonical cash available after reserve',
      degraded,
      live: cfg.live,
    };
  }

  static _restricted({ code, glAccountId, canonical, savings, ledgerCents, driftCents = null, reason, degraded }) {
    const cfg = this.getConfig();
    return {
      sourceType: cfg.sourceType,
      sourceOfTruth: 'fineract',
      accountCode: code,
      glAccountId,
      glAccount: (canonical && canonical.glAccount) || null,
      canonicalBalanceCents: canonical ? canonical.balanceCents : null,
      ledgerBalanceCents: ledgerCents,
      driftCents,
      savingsAccountId: (savings && savings.savingsAccountId) || cfg.savingsAccountId || null,
      savings,
      reserveCents: cfg.reserveCents,
      availableBalanceCents: 0,
      fundingEligible: false,
      segregationStatus: 'restricted',
      segregationReason: reason,
      degraded,
      live: cfg.live,
    };
  }

  static async assertAvailable({ amountUsd, accountCode, purpose } = {}) {
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw reject('amountUsd must be a positive number', 'INVALID_AMOUNT');
    const position = await this.position({ accountCode, purpose });
    if (!position.fundingEligible) {
      throw reject(
        `canonical account ${position.accountCode} cannot fund this draw (${position.segregationReason})`,
        'CANONICAL_SOURCE_RESTRICTED'
      );
    }
    const needed = toCents(amount);
    if (position.availableBalanceCents < needed) {
      throw reject(
        `canonical account ${position.accountCode} has $${fromCents(position.availableBalanceCents)} available, needs $${fromCents(needed)}`,
        'INSUFFICIENT_CANONICAL_FUNDS'
      );
    }
    return position;
  }

  /**
   * Move canonical cash into the digital-asset account: withdraw from the
   * operating savings account (when configured) and post one double-entry to
   * both the sub-ledger and the Fineract GL. Shadow unless CANONICAL_FUNDING_LIVE.
   */
  static async commit({
    amountUsd, reference, referenceType = 'canonical_funding', memo,
    cashAccountCode, assetAccountCode, postedBy = 'canonical-funding-source', purpose,
  } = {}) {
    const cfg = this.getConfig();
    const cashCode = String(cashAccountCode || cfg.cashAccountCode);
    const assetCode = String(assetAccountCode || cfg.assetAccountCode);
    const position = await this.assertAvailable({ amountUsd, accountCode: cashCode, purpose });
    const amount = Number(amountUsd);
    const map = await this.glMap();
    const cashGlId = await this.resolveGlId(cashCode, map);
    const assetGlId = await this.resolveGlId(assetCode, map);
    const postToFineract = Boolean(cashGlId && assetGlId);

    const plan = {
      sourceType: cfg.sourceType,
      accountCode: cashCode,
      assetAccountCode: assetCode,
      amountUsd: amount,
      reference: reference || null,
      savingsAccountId: cfg.savingsAccountId,
      postToFineract,
      glAccountIds: { cash: cashGlId, asset: assetGlId },
      lines: [
        { accountCode: assetCode, debitAmount: amount, creditAmount: 0, fineractGlId: assetGlId, memo: memo || `Canonical funding ${reference || ''}`.trim() },
        { accountCode: cashCode, debitAmount: 0, creditAmount: amount, fineractGlId: cashGlId, memo: `Canonical cash draw ${reference || ''}`.trim() },
      ],
    };

    if (!cfg.live) {
      return { ...plan, shadow: true, committed: false, position, reason: 'CANONICAL_FUNDING_LIVE=false' };
    }
    if (!postToFineract) {
      throw reject(
        `no fineract_gl_mappings entry for account(s) ${[!cashGlId && cashCode, !assetGlId && assetCode].filter(Boolean).join(', ')}`,
        'GL_MAPPING_MISSING'
      );
    }
    if (!TrustAccountingEngine) throw reject('TrustAccountingEngine not available', 'LEDGER_UNAVAILABLE', 503);

    let savingsTransactionId = null;
    if (cfg.savingsAccountId) {
      const withdrawal = await FineractClient.withdrawSavings({
        accountId: cfg.savingsAccountId,
        amount,
        paymentTypeId: cfg.paymentTypeId,
        note: memo || `Canonical funding ${reference || ''}`.trim(),
      });
      savingsTransactionId = (withdrawal && (withdrawal.resourceId || withdrawal.savingsId)) || null;
    }

    try {
      const journal = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date(),
        description: memo || `Canonical funding draw ${reference || ''}`.trim(),
        referenceType,
        referenceId: reference || null,
        postedBy,
        postToFineract: true,
        lines: plan.lines,
      });
      return {
        ...plan,
        shadow: false,
        committed: true,
        journalEntryId: journal.entry_id || journal.entryId || null,
        fineractTransactionId: journal.fineract_transaction_id || null,
        savingsTransactionId,
        position,
      };
    } catch (err) {
      // Never leave the ERP short: put the withdrawn cash back before failing.
      if (savingsTransactionId || cfg.savingsAccountId) {
        await FineractClient.depositSavings({
          accountId: cfg.savingsAccountId,
          amount,
          paymentTypeId: cfg.paymentTypeId,
          note: `Rollback failed canonical funding ${reference || ''}`.trim(),
        }).catch((e) => console.warn(`[CanonicalFundingSource] savings rollback failed: ${e.message}`));
      }
      throw err;
    }
  }

  /** Undo a committed draw: deposit the cash back and reverse the journal. */
  static async reverse({ journalEntryId, amountUsd, reference, postedBy = 'canonical-funding-source' } = {}) {
    const cfg = this.getConfig();
    const result = { reversedJournalEntryId: null, savingsTransactionId: null };
    if (cfg.savingsAccountId && amountUsd) {
      const deposit = await FineractClient.depositSavings({
        accountId: cfg.savingsAccountId,
        amount: Number(amountUsd),
        paymentTypeId: cfg.paymentTypeId,
        note: `Reversal of canonical funding ${reference || ''}`.trim(),
      });
      result.savingsTransactionId = (deposit && deposit.resourceId) || null;
    }
    if (journalEntryId && TrustAccountingEngine) {
      const reversal = await TrustAccountingEngine.reverseJournalEntry(journalEntryId, { postedBy });
      result.reversedJournalEntryId = (reversal && (reversal.entry_id || reversal.entryId)) || journalEntryId;
    }
    return result;
  }

  /** Sub-ledger vs canonical GL, per funded account code. */
  static async reconcile({ accountCodes } = {}) {
    const cfg = this.getConfig();
    const codes = (Array.isArray(accountCodes) && accountCodes.length
      ? accountCodes
      : [cfg.cashAccountCode, cfg.assetAccountCode]).map(String);
    const accounts = [];
    for (const code of codes) {
      const position = await this.position({ accountCode: code });
      accounts.push({
        accountCode: code,
        glAccountId: position.glAccountId,
        canonicalUsd: position.canonicalBalanceCents === null ? null : fromCents(position.canonicalBalanceCents),
        ledgerUsd: position.ledgerBalanceCents === null ? null : fromCents(position.ledgerBalanceCents),
        driftUsd: position.driftCents === null ? null : fromCents(position.driftCents),
        inSync: position.driftCents !== null && Math.abs(position.driftCents) <= cfg.driftToleranceCents,
        degraded: position.degraded,
      });
    }
    return {
      system: cfg.system,
      toleranceUsd: fromCents(cfg.driftToleranceCents),
      generatedAt: new Date().toISOString(),
      inSync: accounts.every((a) => a.inSync),
      accounts,
    };
  }
}

module.exports = { CanonicalFundingSource };

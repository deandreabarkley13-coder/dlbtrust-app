'use strict';

/**
 * Ramp Fee Engine — monetization for on/off ramp and redemption flows.
 *
 * Computes a configurable bps spread on every ramp quote and books it to a
 * revenue GL account through `TrustAccountingEngine` when the corresponding
 * proposal executes. The fee is an internal double-entry journal only
 * (receivable/clearing → fee income); it never initiates an external transfer,
 * so it is safe while all rails stay in shadow mode. Booking is idempotent per
 * reference, so a re-executed proposal cannot double-charge.
 *
 * Configuration:
 *   RAMP_FEE_BPS                  default 0   (no fee until explicitly set)
 *   TREASURY_ON_RAMP_FEE_BPS      per-flow override for the treasury bridge
 *   RAMP_FEE_REVENUE_ACCOUNT      default 4100 (Fee Income)
 *   RAMP_FEE_CLEARING_ACCOUNT     default 1300 (Other Receivables)
 *   RAMP_FEE_BOOKING_ENABLED      default true (set false to quote fees only)
 */

let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function round2(n) { return Math.round(Number(n) * 100) / 100; }

class RampFeeEngine {
  static config({ feeBps } = {}) {
    const configured = feeBps != null ? Number(feeBps) : Number(process.env.RAMP_FEE_BPS || '0');
    return {
      feeBps: Number.isFinite(configured) && configured > 0 ? configured : 0,
      revenueAccount: process.env.RAMP_FEE_REVENUE_ACCOUNT || '4100',
      clearingAccount: process.env.RAMP_FEE_CLEARING_ACCOUNT || '1300',
      bookingEnabled: (process.env.RAMP_FEE_BOOKING_ENABLED || 'true') !== 'false',
    };
  }

  /** Fee/spread breakdown for a quote. Pure arithmetic, no side effects. */
  static quote({ amount, feeBps, direction = 'onramp', asset = 'USD' } = {}) {
    const cfg = this.config({ feeBps });
    const gross = Number(amount);
    if (!Number.isFinite(gross) || gross <= 0) {
      return { feeBps: cfg.feeBps, grossAmount: 0, feeAmount: 0, netAmount: 0, direction, asset, revenueAccount: cfg.revenueAccount };
    }
    const feeAmount = round2(gross * (cfg.feeBps / 10000));
    return {
      feeBps: cfg.feeBps,
      grossAmount: round2(gross),
      feeAmount,
      netAmount: round2(gross - feeAmount),
      direction,
      asset,
      revenueAccount: cfg.revenueAccount,
      clearingAccount: cfg.clearingAccount,
      bookingEnabled: cfg.bookingEnabled,
    };
  }

  static async _existingEntry(referenceType, referenceId) {
    if (!pool || !pool.query || !referenceId) return null;
    try {
      const rows = await pool.query(
        `SELECT entry_id FROM trust_journal_entries
          WHERE reference_type = $1 AND reference_id = $2 AND status = 'posted'
          LIMIT 1`,
        [referenceType, String(referenceId)]
      );
      return rows.rows[0] ? rows.rows[0].entry_id : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Book the fee for an executed ramp/redeem. Best-effort: an accounting
   * problem is reported in the result rather than failing the operation.
   */
  static async book({
    referenceType = 'ramp_fee', referenceId, amount, feeBps,
    direction = 'onramp', asset = 'USD', provider, description, postedBy,
  } = {}) {
    const fee = this.quote({ amount, feeBps, direction, asset });
    const result = { ...fee, referenceType, referenceId: referenceId || null, booked: false };

    if (!fee.feeAmount) return { ...result, status: 'no_fee' };
    if (!fee.bookingEnabled) return { ...result, status: 'booking_disabled' };
    if (!TrustAccountingEngine) return { ...result, status: 'accounting_unavailable' };

    const already = await this._existingEntry(referenceType, referenceId);
    if (already) return { ...result, status: 'already_booked', entryId: already, booked: true };

    try {
      const entry = await TrustAccountingEngine.postJournalEntry({
        entryDate: new Date().toISOString().slice(0, 10),
        description: description || `Ramp fee ${fee.feeBps}bps on ${fee.grossAmount} ${asset} (${direction}${provider ? ` via ${provider}` : ''})`,
        lines: [
          { accountCode: fee.clearingAccount, debitAmount: fee.feeAmount, creditAmount: 0, description: 'Ramp fee receivable' },
          { accountCode: fee.revenueAccount, debitAmount: 0, creditAmount: fee.feeAmount, description: 'Ramp fee income' },
        ],
        referenceType,
        referenceId: referenceId ? String(referenceId) : null,
        postedBy: postedBy || 'ramp-fee-engine',
        // Fineract mirroring stays off: fee capture is a local GL entry.
        postToFineract: false,
      });
      return { ...result, status: 'booked', booked: true, entryId: entry.entry_id || entry.entryId || null };
    } catch (e) {
      return { ...result, status: 'error', error: e.message };
    }
  }

  static status() {
    const cfg = this.config();
    return {
      feeBps: cfg.feeBps,
      revenueAccount: cfg.revenueAccount,
      clearingAccount: cfg.clearingAccount,
      bookingEnabled: cfg.bookingEnabled,
      accountingAvailable: Boolean(TrustAccountingEngine),
      note: 'Fees are internal double-entry journals; no external value movement.',
    };
  }
}

module.exports = { RampFeeEngine };

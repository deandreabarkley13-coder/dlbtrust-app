/**
 * GL Mapping Resolver — Auto-lookup Fineract GL account IDs
 *
 * Resolves trust account codes to Fineract GL IDs using the
 * fineract_gl_mappings table. Used by the fixed income orchestrator
 * and cash engine to auto-post journal entries to Fineract.
 */

'use strict';

const pool = require('./pgPool');

class GLResolver {

  /**
   * Look up a Fineract GL ID for a trust account code.
   * Uses 'trust_journal' mapping type (populated by seed-fineract-gl.js).
   */
  static async resolveByAccountCode(trustAccountCode) {
    const result = await pool.query(
      `SELECT fineract_gl_id FROM fineract_gl_mappings
       WHERE trust_account_code = $1 AND is_active = TRUE
       ORDER BY mapping_type = 'trust_journal' DESC
       LIMIT 1`,
      [trustAccountCode]
    );
    return result.rows.length > 0 ? result.rows[0].fineract_gl_id : null;
  }

  /**
   * Look up a Fineract GL ID by mapping type (e.g., bond_accrual_debit).
   * Falls back to trust_journal mapping for the given account code.
   */
  static async resolveByType(mappingType, { trustAccountCode, bondId, cashAccountId } = {}) {
    const conditions = ['mapping_type = $1', 'is_active = TRUE'];
    const params = [mappingType];
    let idx = 2;

    if (bondId) { conditions.push(`bond_id = $${idx++}`); params.push(bondId); }
    if (cashAccountId) { conditions.push(`cash_account_id = $${idx++}`); params.push(cashAccountId); }
    if (trustAccountCode) { conditions.push(`trust_account_code = $${idx++}`); params.push(trustAccountCode); }

    const result = await pool.query(
      `SELECT fineract_gl_id FROM fineract_gl_mappings
       WHERE ${conditions.join(' AND ')}
       LIMIT 1`,
      params
    );

    // Fall back to trust_journal mapping by account code
    if (result.rows.length === 0 && trustAccountCode) {
      return GLResolver.resolveByAccountCode(trustAccountCode);
    }

    return result.rows.length > 0 ? result.rows[0].fineract_gl_id : null;
  }

  /**
   * Resolve a debit/credit GL pair for a bond operation.
   *
   * @param {'accrual'|'interest_payment'|'principal_payment'} operationType
   * @param {string} debitAccountCode  - Trust account code for debit side
   * @param {string} creditAccountCode - Trust account code for credit side
   * @param {number} [bondId]          - Optional bond ID for bond-specific mappings
   * @returns {{ debitGlId: number|null, creditGlId: number|null }}
   */
  static async resolvePair(operationType, debitAccountCode, creditAccountCode, bondId) {
    const typePrefix = {
      accrual: 'bond_accrual',
      interest_payment: 'bond_interest',
      principal_payment: 'bond_principal',
      cash_transfer: 'cash_transfer',
    }[operationType] || operationType;

    const [debitGlId, creditGlId] = await Promise.all([
      GLResolver.resolveByType(`${typePrefix}_debit`, { trustAccountCode: debitAccountCode, bondId }),
      GLResolver.resolveByType(`${typePrefix}_credit`, { trustAccountCode: creditAccountCode, bondId }),
    ]);

    return { debitGlId, creditGlId };
  }

  /**
   * Resolve all GL mappings for bulk operations. Returns a map of
   * accountCode -> fineractGlId.
   */
  static async resolveAll() {
    const result = await pool.query(
      `SELECT trust_account_code, fineract_gl_id
       FROM fineract_gl_mappings
       WHERE is_active = TRUE AND trust_account_code IS NOT NULL
       ORDER BY mapping_type = 'trust_journal' DESC`
    );

    const map = {};
    for (const row of result.rows) {
      if (!map[row.trust_account_code]) {
        map[row.trust_account_code] = row.fineract_gl_id;
      }
    }
    return map;
  }
}

module.exports = { GLResolver };

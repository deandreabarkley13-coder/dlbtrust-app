/**
 * Bond Master Client — dlbtrust.cloud
 *
 * Handles bond interest calculations, schedule generation,
 * and interest disbursement via OpenACH.
 */

'use strict';

const { OpenACHClient } = require('../openach/openachClient');

class BondMasterClient {
  /**
   * Calculate interest per period for a bond.
   * @param {object} opts
   * @param {number} opts.face_value - Bond face value in dollars
   * @param {number} opts.coupon_rate - Annual coupon rate as a percentage (e.g. 5.25)
   * @param {string} opts.frequency - "monthly" | "quarterly" | "semi-annual" | "annual"
   * @returns {number} Interest amount per period in dollars
   */
  static calculateInterest({ face_value, coupon_rate, frequency }) {
    const periods = BondMasterClient._periodsPerYear(frequency);
    return Math.round((face_value * (coupon_rate / 100) / periods) * 100) / 100;
  }

  /**
   * Generate the projected payment schedule for a bond.
   * @param {object} opts
   * @param {number} opts.bond_id
   * @param {string} opts.issue_date - ISO date
   * @param {string} opts.maturity_date - ISO date
   * @param {string} opts.frequency
   * @param {number} opts.coupon_rate
   * @param {number} opts.face_value
   * @returns {Array<{payment_date: string, interest_amount: number}>}
   */
  static generateSchedule({ bond_id, issue_date, maturity_date, frequency, coupon_rate, face_value }) {
    const periods = BondMasterClient._periodsPerYear(frequency);
    const monthsPerPeriod = Math.round(12 / periods);
    const interestPerPeriod = BondMasterClient.calculateInterest({ face_value, coupon_rate, frequency });

    const schedule = [];
    const start = new Date(issue_date);
    const end = new Date(maturity_date);

    let current = new Date(start);
    current.setMonth(current.getMonth() + monthsPerPeriod);

    while (current <= end) {
      schedule.push({
        bond_id,
        payment_date: current.toISOString().split('T')[0],
        interest_amount: interestPerPeriod,
      });
      current = new Date(current);
      current.setMonth(current.getMonth() + monthsPerPeriod);
    }

    return schedule;
  }

  /**
   * Disburse interest payment for a bond allocation via OpenACH.
   * @param {object} opts
   * @param {object} opts.bond - Bond record
   * @param {object} opts.allocation - Bond allocation record
   * @param {string} opts.send_date - ISO date for the payment
   * @param {object} opts.pool - PostgreSQL pool
   * @returns {object} Disbursement result
   */
  static async disburseInterest({ bond, allocation, send_date, pool }) {
    const interestPerPeriod = BondMasterClient.calculateInterest({
      face_value: parseFloat(bond.face_value),
      coupon_rate: parseFloat(bond.coupon_rate),
      frequency: bond.frequency,
    });

    const allocatedAmount = Math.round(interestPerPeriod * (parseFloat(allocation.allocation_pct) / 100) * 100) / 100;

    // Look up wallet to get beneficiary info
    let wallet;
    try {
      const { rows } = await pool.query('SELECT * FROM wallets WHERE wallet_id = $1', [allocation.wallet_id]);
      wallet = rows[0];
    } catch (_) { /* optional */ }

    const firstName = wallet?.holder_name?.split(' ')[0] || allocation.beneficiary_name?.split(' ')[0] || 'Beneficiary';
    const lastName = wallet?.holder_name?.split(' ').slice(1).join(' ') || allocation.beneficiary_name?.split(' ').slice(1).join(' ') || allocation.wallet_id;

    let result;
    try {
      result = await OpenACHClient.disburseToBeneficiary({
        first_name: firstName,
        last_name: lastName,
        email: wallet?.email || '',
        external_id: `bond_${bond.id}_alloc_${allocation.id}`,
        bank_name: 'Beneficiary Bank',
        routing_number: wallet?.routing_number || '000000000',
        account_number: wallet?.account_number || '000000000',
        account_type: wallet?.account_type || 'Checking',
        amount: allocatedAmount,
        send_date,
        payment_type_id: process.env.BOND_PAYMENT_TYPE_ID || '',
        frequency: 'once',
        occurrences: 1,
      });
    } catch (err) {
      // Log failed payment
      await pool.query(
        `INSERT INTO bond_payments (bond_id, allocation_id, payment_date, interest_amount, status, created_at)
         VALUES ($1, $2, $3, $4, 'failed', NOW())`,
        [bond.id, allocation.id, send_date, allocatedAmount]
      );
      throw err;
    }

    // Log successful payment
    await pool.query(
      `INSERT INTO bond_payments (bond_id, allocation_id, payment_date, interest_amount, status, reference_id, created_at)
       VALUES ($1, $2, $3, $4, 'completed', $5, NOW())`,
      [bond.id, allocation.id, send_date, allocatedAmount, result.payment_schedule_id || null]
    );

    return {
      success: true,
      bond_id: bond.id,
      allocation_id: allocation.id,
      amount: allocatedAmount,
      send_date,
      reference_id: result.payment_schedule_id,
    };
  }

  static _periodsPerYear(frequency) {
    switch (frequency) {
      case 'monthly':     return 12;
      case 'quarterly':   return 4;
      case 'semi-annual': return 2;
      case 'annual':      return 1;
      default:            return 2;
    }
  }
}

module.exports = { BondMasterClient };

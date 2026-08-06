/**
 * Fixed Income Engine — Private Placement Bond
 *
 * Handles:
 *  - Bond creation and lifecycle management
 *  - Daily interest accrual (simple interest, configurable day count)
 *  - Interest and principal payments
 *  - Real-time balance queries
 *  - Fineract GL journal entry integration
 *
 * All monetary values stored as NUMERIC(18,2) in PostgreSQL.
 */

'use strict';

const pool = require('./pgPool');
const { FineractClient } = require('../fineract/fineractClient');
const { BondAmortization } = require('./bondAmortization');

// ─── Day Count Conventions ────────────────────────────────────────────────────

function dailyRate(annualRate, dayCount, year) {
  switch (dayCount) {
    case 'ACT/ACT':
      return annualRate / (isLeapYear(year) ? 366 : 365);
    case 'ACT/360':
      return annualRate / 360;
    case '30/360':
    default:
      return annualRate / 360;
  }
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysBetween(from, to, dayCount) {
  const d1 = new Date(from);
  const d2 = new Date(to);

  if (dayCount === '30/360') {
    let y1 = d1.getFullYear(), m1 = d1.getMonth() + 1, day1 = Math.min(d1.getDate(), 30);
    let y2 = d2.getFullYear(), m2 = d2.getMonth() + 1, day2 = Math.min(d2.getDate(), 30);
    return (y2 - y1) * 360 + (m2 - m1) * 30 + (day2 - day1);
  }

  const msPerDay = 86400000;
  return Math.round((d2.getTime() - d1.getTime()) / msPerDay);
}

// ─── Bond Engine ──────────────────────────────────────────────────────────────

class BondEngine {

  /**
   * Create a new bond and initialize its balance record.
   */
  static async createBond({ bondName, isin, faceValue, couponRate, issueDate, maturityDate, paymentFreq, dayCount, currency }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const bondResult = await client.query(
        `INSERT INTO bonds (bond_name, isin, face_value, coupon_rate, issue_date, maturity_date, payment_freq, day_count, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [bondName, isin || null, faceValue, couponRate, issueDate, maturityDate, paymentFreq || 'monthly', dayCount || '30/360', currency || 'USD']
      );

      const bond = bondResult.rows[0];

      await client.query(
        `INSERT INTO bond_balances (bond_id, principal_balance, accrued_interest, last_accrual_date)
         VALUES ($1, $2, 0, $3)`,
        [bond.id, faceValue, issueDate]
      );

      // Record the initial principal as a transaction
      await client.query(
        `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, description, transaction_date)
         VALUES ($1, 'issuance', $2, $3, 'Bond issued — initial principal', $4)`,
        [bond.id, faceValue, faceValue, issueDate]
      );

      await client.query('COMMIT');
      return bond;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get a bond with its current balance.
   */
  static async getBond(bondId) {
    const result = await pool.query(
      `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
              bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
       FROM bonds b
       JOIN bond_balances bb ON bb.bond_id = b.id
       WHERE b.id = $1`,
      [bondId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  }

  /**
   * List all bonds with current balances.
   */
  static async listBonds() {
    const result = await pool.query(
      `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
              bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
       FROM bonds b
       JOIN bond_balances bb ON bb.bond_id = b.id
       ORDER BY b.created_at DESC`
    );
    return result.rows;
  }

  /**
   * Accrue interest from the last accrual date to the target date.
   * Posts a Fineract GL journal entry if GL account IDs are provided.
   */
  static async accrueInterest(bondId, toDate, { glDebitAccountId, glCreditAccountId, requireFineractPost } = {}) {
    // Validate GL mapping: if either GL ID is provided, both must be present
    if (glDebitAccountId && !glCreditAccountId) {
      throw new Error('GL mapping incomplete: glDebitAccountId provided but glCreditAccountId is missing');
    }
    if (!glDebitAccountId && glCreditAccountId) {
      throw new Error('GL mapping incomplete: glCreditAccountId provided but glDebitAccountId is missing');
    }
    if (requireFineractPost && (!glDebitAccountId || !glCreditAccountId)) {
      throw new Error('Fineract GL post required but GL account mappings are missing — provide both glDebitAccountId and glCreditAccountId');
    }

    const client = await pool.connect();
    let clientReleased = false;
    try {
      await client.query('BEGIN');

      // Lock bond row to prevent concurrent accrual race conditions
      const bondResult = await client.query(
        `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
                bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
         FROM bonds b
         JOIN bond_balances bb ON bb.bond_id = b.id
         WHERE b.id = $1
         FOR UPDATE OF bb`,
        [bondId]
      );
      const bond = bondResult.rows[0];
      if (!bond) { await client.query('ROLLBACK'); throw new Error(`Bond ${bondId} not found`); }

      const now = new Date();
      const to = new Date(toDate || now);
      const maturityDate = new Date(bond.maturity_date);
      const statusAllowsAccrual = bond.status === 'active' || (bond.status === 'matured' && maturityDate > now);
      if (!statusAllowsAccrual) { await client.query('ROLLBACK'); throw new Error(`Bond ${bondId} is ${bond.status}, cannot accrue`); }

      if (bond.amortizing) {
        await client.query('COMMIT');
        client.release();
        clientReleased = true;
        const result = await this.applyAmortization(bondId, to.toISOString().split('T')[0]);
        return {
          accrued: result.accrual_delta || 0,
          days: 0,
          from_date: bond.last_accrual_date,
          to_date: to.toISOString().split('T')[0],
          new_accrued_interest: result.accrued_interest,
          principal_balance: result.principal_balance,
          transactions: result.transactions,
        };
      }

      const fromDate = bond.last_accrual_date;

      const from = new Date(fromDate);

      if (to <= from) {
        await client.query('ROLLBACK');
        return { accrued: 0, message: 'Already accrued up to this date' };
      }

      const days = daysBetween(from, to, bond.day_count);
      if (days <= 0) {
        await client.query('ROLLBACK');
        return { accrued: 0, message: 'No days to accrue' };
      }

      const rate = dailyRate(parseFloat(bond.coupon_rate), bond.day_count, to.getFullYear());
      let principalBalance = parseFloat(bond.principal_balance || 0);
      if (principalBalance <= 0 && maturityDate > now) principalBalance = parseFloat(bond.face_value || 0);
      const accrual = Math.round(principalBalance * rate * days * 100) / 100;

      if (accrual <= 0) {
        await client.query('ROLLBACK');
        return { accrued: 0, message: 'Accrual amount is zero' };
      }

      const newAccrued = parseFloat(bond.accrued_interest) + accrual;

      await client.query(
        `UPDATE bond_balances
         SET accrued_interest = $1, last_accrual_date = $2, updated_at = NOW()
         WHERE bond_id = $3`,
        [newAccrued, to.toISOString().split('T')[0], bondId]
      );

      const txnResult = await client.query(
        `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
         VALUES ($1, 'interest_accrual', $2, $3, $4, $5, $6)
         RETURNING *`,
        [bondId, accrual, principalBalance, newAccrued,
         `Interest accrual: ${days} days @ ${(parseFloat(bond.coupon_rate) * 100).toFixed(4)}% annual (${bond.day_count})`,
         to.toISOString().split('T')[0]]
      );

      await client.query('COMMIT');

      // Post to Fineract GL if account IDs provided
      let fineractTxnId = null;
      if (glDebitAccountId && glCreditAccountId) {
        try {
          const glResult = await FineractClient.postJournalEntry({
            officeId: 1,
            transactionDate: to,
            credits: [{ glAccountId: glCreditAccountId, amount: accrual }],
            debits:  [{ glAccountId: glDebitAccountId,  amount: accrual }],
            comments: `Bond ${bond.bond_name} — interest accrual ${days}d`,
          });
          fineractTxnId = glResult && glResult.resourceId ? String(glResult.resourceId) : null;

          if (fineractTxnId) {
            await pool.query(
              `UPDATE bond_transactions SET fineract_txn_id = $1 WHERE id = $2`,
              [fineractTxnId, txnResult.rows[0].id]
            );
          }
        } catch (glErr) {
          console.warn('[BondEngine] Fineract GL post failed (accrual still recorded):', glErr.message);
        }
      }

      return {
        accrued: accrual,
        days,
        from_date: from.toISOString().split('T')[0],
        to_date: to.toISOString().split('T')[0],
        new_accrued_interest: newAccrued,
        principal_balance: principalBalance,
        fineract_txn_id: fineractTxnId,
        transaction: txnResult.rows[0],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      if (!clientReleased) client.release();
    }
  }

  /**
   * Process an interest payment — reduces accrued interest, records the payment.
   */
  static async payInterest(bondId, amount, { glDebitAccountId, glCreditAccountId, requireFineractPost } = {}) {
    if (glDebitAccountId && !glCreditAccountId) {
      throw new Error('GL mapping incomplete: glDebitAccountId provided but glCreditAccountId is missing');
    }
    if (!glDebitAccountId && glCreditAccountId) {
      throw new Error('GL mapping incomplete: glCreditAccountId provided but glDebitAccountId is missing');
    }
    if (requireFineractPost && (!glDebitAccountId || !glCreditAccountId)) {
      throw new Error('Fineract GL post required but GL account mappings are missing — provide both glDebitAccountId and glCreditAccountId');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock bond row to prevent concurrent payment race conditions
      const bondResult = await client.query(
        `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
                bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
         FROM bonds b
         JOIN bond_balances bb ON bb.bond_id = b.id
         WHERE b.id = $1
         FOR UPDATE OF bb`,
        [bondId]
      );
      const bond = bondResult.rows[0];
      if (!bond) { await client.query('ROLLBACK'); throw new Error(`Bond ${bondId} not found`); }

      const now = new Date();
      const requestedAmount = amount !== undefined && amount !== null && String(amount).trim() !== '' ? Number(amount) : parseFloat(bond.accrued_interest || 0);
      const payAmount = Math.round(requestedAmount * 100) / 100;
      if (!Number.isFinite(payAmount) || payAmount <= 0) { await client.query('ROLLBACK'); throw new Error('No accrued interest to pay'); }
      const accrued = parseFloat(bond.accrued_interest || 0);
      if (payAmount > accrued + 1e-9) {
        await client.query('ROLLBACK');
        throw new Error(`Payment $${payAmount} exceeds accrued interest $${accrued}`);
      }

      const newAccrued = Math.round((accrued - payAmount) * 100) / 100;
      const totalPaid = parseFloat(bond.total_interest_paid || 0);
      const newTotalPaid = Math.round((totalPaid + payAmount) * 100) / 100;

      await client.query(
        `UPDATE bond_balances
         SET accrued_interest = $1, total_interest_paid = $2, updated_at = NOW()
         WHERE bond_id = $3`,
        [newAccrued, newTotalPaid, bondId]
      );

      const txnResult = await client.query(
        `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
         VALUES ($1, 'interest_payment', $2, $3, $4, $5, $6)
         RETURNING *`,
        [bondId, payAmount, parseFloat(bond.principal_balance || 0), newAccrued,
         `Interest payment of $${payAmount.toFixed(2)}`,
         now.toISOString().split('T')[0]]
      );

      await client.query('COMMIT');

      let fineractTxnId = null;
      if (glDebitAccountId && glCreditAccountId) {
        try {
          const glResult = await FineractClient.postJournalEntry({
            officeId: 1,
            transactionDate: new Date(),
            credits: [{ glAccountId: glCreditAccountId, amount: payAmount }],
            debits:  [{ glAccountId: glDebitAccountId,  amount: payAmount }],
            comments: `Bond ${bond.bond_name} — interest payment`,
          });
          fineractTxnId = glResult && glResult.resourceId ? String(glResult.resourceId) : null;

          if (fineractTxnId) {
            await pool.query(
              `UPDATE bond_transactions SET fineract_txn_id = $1 WHERE id = $2`,
              [fineractTxnId, txnResult.rows[0].id]
            );
          }
        } catch (glErr) {
          console.warn('[BondEngine] Fineract GL post failed (payment still recorded):', glErr.message);
        }
      }

      return {
        paid: payAmount,
        remaining_accrued: newAccrued,
        new_accrued_interest: newAccrued,
        total_interest_paid: newTotalPaid,
        fineract_txn_id: fineractTxnId,
        transaction: txnResult.rows[0],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Process a principal payment (partial or full).
   */
  static async payPrincipal(bondId, amount, { glDebitAccountId, glCreditAccountId, requireFineractPost } = {}) {
    if (glDebitAccountId && !glCreditAccountId) {
      throw new Error('GL mapping incomplete: glDebitAccountId provided but glCreditAccountId is missing');
    }
    if (!glDebitAccountId && glCreditAccountId) {
      throw new Error('GL mapping incomplete: glCreditAccountId provided but glDebitAccountId is missing');
    }
    if (requireFineractPost && (!glDebitAccountId || !glCreditAccountId)) {
      throw new Error('Fineract GL post required but GL account mappings are missing — provide both glDebitAccountId and glCreditAccountId');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock bond row to prevent concurrent payment race conditions
      const bondResult = await client.query(
        `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
                bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
         FROM bonds b
         JOIN bond_balances bb ON bb.bond_id = b.id
         WHERE b.id = $1
         FOR UPDATE OF bb`,
        [bondId]
      );
      const bond = bondResult.rows[0];
      if (!bond) { await client.query('ROLLBACK'); throw new Error(`Bond ${bondId} not found`); }

      const now = new Date();
      const principalBalance = parseFloat(bond.principal_balance || 0);
      const payAmount = Math.round(Number(amount) * 100) / 100;
      if (!Number.isFinite(payAmount) || payAmount <= 0) { await client.query('ROLLBACK'); throw new Error('Principal payment amount must be positive'); }
      if (payAmount > principalBalance + 1e-9) {
        await client.query('ROLLBACK');
        throw new Error(`Payment $${payAmount} exceeds principal balance $${principalBalance}`);
      }

      const maturityDate = new Date(bond.maturity_date);
      if (maturityDate > now && payAmount > principalBalance - 1e-9) {
        await client.query('ROLLBACK');
        throw new Error('Cannot fully redeem a bond before its maturity date');
      }

      const newBalance = Math.round((principalBalance - payAmount) * 100) / 100;
      const totalPrincipalPaid = parseFloat(bond.total_principal_paid || 0);
      const newTotalPrincipalPaid = Math.round((totalPrincipalPaid + payAmount) * 100) / 100;

      await client.query(
        `UPDATE bond_balances
         SET principal_balance = $1, total_principal_paid = $2, updated_at = NOW()
         WHERE bond_id = $3`,
        [newBalance, newTotalPrincipalPaid, bondId]
      );

      // If fully repaid and at/past maturity, mark bond as matured
      if (Math.abs(newBalance) < 0.0001) {
        const finalStatus = maturityDate <= now ? 'matured' : 'active';
        await client.query(
          `UPDATE bonds SET status = $1, updated_at = NOW() WHERE id = $2`,
          [finalStatus, bondId]
        );
      }

      const txType = Math.abs(newBalance) < 0.0001 ? 'maturity' : 'principal_payment';
      const txnResult = await client.query(
        `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [bondId, txType, payAmount, newBalance, parseFloat(bond.accrued_interest || 0),
         Math.abs(newBalance) < 0.0001 ? 'Bond matured — principal fully repaid' : `Principal payment of $${payAmount.toFixed(2)}`,
         now.toISOString().split('T')[0]]
      );

      await client.query('COMMIT');

      let fineractTxnId = null;
      if (glDebitAccountId && glCreditAccountId) {
        try {
          const glResult = await FineractClient.postJournalEntry({
            officeId: 1,
            transactionDate: new Date(),
            credits: [{ glAccountId: glCreditAccountId, amount: payAmount }],
            debits:  [{ glAccountId: glDebitAccountId,  amount: payAmount }],
            comments: `Bond ${bond.bond_name} — principal payment`,
          });
          fineractTxnId = glResult && glResult.resourceId ? String(glResult.resourceId) : null;

          if (fineractTxnId) {
            await pool.query(
              `UPDATE bond_transactions SET fineract_txn_id = $1 WHERE id = $2`,
              [fineractTxnId, txnResult.rows[0].id]
            );
          }
        } catch (glErr) {
          console.warn('[BondEngine] Fineract GL post failed (payment still recorded):', glErr.message);
        }
      }

      return {
        paid: payAmount,
        new_principal_balance: newBalance,
        total_principal_paid: newTotalPrincipalPaid,
        bond_status: Math.abs(newBalance) < 0.0001 ? 'matured' : 'active',
        fineract_txn_id: fineractTxnId,
        transaction: txnResult.rows[0],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Return/reinvest principal — inverse of a principal payment.
   * Used when a stablecoin settlement funded from this bond fails after
   * the principal was drawn but before the on-chain transfer completed.
   */
  static async receivePrincipal(bondId, amount, { glDebitAccountId, glCreditAccountId, requireFineractPost } = {}) {
    if (glDebitAccountId && !glCreditAccountId) {
      throw new Error('GL mapping incomplete: glDebitAccountId provided but glCreditAccountId is missing');
    }
    if (!glDebitAccountId && glCreditAccountId) {
      throw new Error('GL mapping incomplete: glCreditAccountId provided but glDebitAccountId is missing');
    }
    if (requireFineractPost && (!glDebitAccountId || !glCreditAccountId)) {
      throw new Error('Fineract GL post required but GL account mappings are missing — provide both glDebitAccountId and glCreditAccountId');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const bondResult = await client.query(
        `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_principal_paid,
                bb.total_interest_paid, bb.last_accrual_date, bb.last_payment_date
         FROM bonds b
         JOIN bond_balances bb ON bb.bond_id = b.id
         WHERE b.id = $1
         FOR UPDATE OF bb`,
        [bondId]
      );
      const bond = bondResult.rows[0];
      if (!bond) { await client.query('ROLLBACK'); throw new Error(`Bond ${bondId} not found`); }

      const principalBalance = parseFloat(bond.principal_balance);
      const returnAmount = Number(amount);
      const newBalance = principalBalance + returnAmount;
      const newTotalPrincipalPaid = Math.max(0, parseFloat(bond.total_principal_paid) - returnAmount);

      await client.query(
        `UPDATE bond_balances
         SET principal_balance = $1, total_principal_paid = $2, updated_at = NOW()
         WHERE bond_id = $3`,
        [newBalance, newTotalPrincipalPaid, bondId]
      );

      if (principalBalance === 0 && returnAmount > 0) {
        await client.query(
          `UPDATE bonds SET status = 'active', updated_at = NOW() WHERE id = $1`,
          [bondId]
        );
      }

      const txnResult = await client.query(
        `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
         VALUES ($1, 'principal_return', $2, $3, $4, $5, $6)
         RETURNING *`,
        [bondId, returnAmount, newBalance, parseFloat(bond.accrued_interest),
         `Principal return of $${returnAmount.toFixed(2)}`, new Date().toISOString().split('T')[0]]
      );

      await client.query('COMMIT');

      let fineractTxnId = null;
      if (glDebitAccountId && glCreditAccountId) {
        try {
          const glResult = await FineractClient.postJournalEntry({
            officeId: 1,
            transactionDate: new Date(),
            credits: [{ glAccountId: glCreditAccountId, amount: returnAmount }],
            debits:  [{ glAccountId: glDebitAccountId,  amount: returnAmount }],
            comments: `Bond ${bond.bond_name} — principal return`,
          });
          fineractTxnId = glResult && glResult.resourceId ? String(glResult.resourceId) : null;

          if (fineractTxnId) {
            await pool.query(
              `UPDATE bond_transactions SET fineract_txn_id = $1 WHERE id = $2`,
              [fineractTxnId, txnResult.rows[0].id]
            );
          }
        } catch (glErr) {
          console.warn('[BondEngine] Fineract GL post failed (return still recorded):', glErr.message);
        }
      }

      return {
        returned: returnAmount,
        new_principal_balance: newBalance,
        total_principal_paid: newTotalPrincipalPaid,
        bond_status: Math.abs(newBalance) < 0.0001 ? 'matured' : 'active',
        fineract_txn_id: fineractTxnId,
        transaction: txnResult.rows[0],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get the real-time bond dashboard: current state + recent transactions.
   */
  static async getBondDashboard(bondId) {
    const bond = await this.getBond(bondId);
    if (!bond) throw new Error(`Bond ${bondId} not found`);

    // Calculate what the accrued interest would be if accrued to today
    const now = new Date();
    const lastAccrual = new Date(bond.last_accrual_date);
    const pendingDays = daysBetween(lastAccrual, now, bond.day_count);
    const rate = dailyRate(parseFloat(bond.coupon_rate), bond.day_count, now.getFullYear());
    const pendingAccrual = Math.round(parseFloat(bond.principal_balance) * rate * Math.max(pendingDays, 0) * 100) / 100;

    const txns = await pool.query(
      `SELECT * FROM bond_transactions WHERE bond_id = $1 ORDER BY transaction_date DESC, id DESC LIMIT 20`,
      [bondId]
    );

    return {
      bond: {
        id: bond.id,
        bond_name: bond.bond_name,
        isin: bond.isin,
        face_value: parseFloat(bond.face_value),
        coupon_rate: parseFloat(bond.coupon_rate),
        coupon_rate_pct: (parseFloat(bond.coupon_rate) * 100).toFixed(4) + '%',
        issue_date: bond.issue_date,
        maturity_date: bond.maturity_date,
        payment_freq: bond.payment_freq,
        day_count: bond.day_count,
        currency: bond.currency,
        status: bond.status,
      },
      balances: {
        principal_balance: parseFloat(bond.principal_balance),
        accrued_interest: parseFloat(bond.accrued_interest),
        pending_accrual: pendingAccrual,
        total_current_value: parseFloat(bond.principal_balance) + parseFloat(bond.accrued_interest) + pendingAccrual,
        total_interest_paid: parseFloat(bond.total_interest_paid),
        total_principal_paid: parseFloat(bond.total_principal_paid),
        last_accrual_date: bond.last_accrual_date,
        last_payment_date: bond.last_payment_date,
      },
      recent_transactions: txns.rows,
      generated_at: now.toISOString(),
    };
  }

  /**
   * Get transaction history for a bond with optional filters.
   */
  static async getTransactions(bondId, { type, fromDate, toDate, limit } = {}) {
    let query = 'SELECT * FROM bond_transactions WHERE bond_id = $1';
    const params = [bondId];
    let idx = 2;

    if (type) {
      query += ` AND transaction_type = $${idx++}`;
      params.push(type);
    }
    if (fromDate) {
      query += ` AND transaction_date >= $${idx++}`;
      params.push(fromDate);
    }
    if (toDate) {
      query += ` AND transaction_date <= $${idx++}`;
      params.push(toDate);
    }

    query += ' ORDER BY transaction_date DESC, id DESC';

    if (limit) {
      query += ` LIMIT $${idx++}`;
      params.push(limit);
    }

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Return/reverse an interest payment — inverse of payInterest.
   * Used when a stablecoin swap funded from bond interest fails after the
   * interest was drawn but before the on-chain transfer completed.
   */
  static async receiveInterest(bondId, amount) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const bondResult = await client.query(
        `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
                bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
         FROM bonds b
         JOIN bond_balances bb ON bb.bond_id = b.id
         WHERE b.id = $1
         FOR UPDATE OF bb`,
        [bondId]
      );
      const bond = bondResult.rows[0];
      if (!bond) { await client.query('ROLLBACK'); throw new Error(`Bond ${bondId} not found`); }

      const amountNum = Number(amount);
      if (amountNum <= 0) { await client.query('ROLLBACK'); throw new Error('amount must be positive'); }

      const newAccrued = parseFloat(bond.accrued_interest) + amountNum;
      const newTotalInterestPaid = Math.max(0, parseFloat(bond.total_interest_paid) - amountNum);

      await client.query(
        `UPDATE bond_balances
         SET accrued_interest = $1, total_interest_paid = $2, updated_at = NOW()
         WHERE bond_id = $3`,
        [newAccrued, newTotalInterestPaid, bondId]
      );

      const txnResult = await client.query(
        `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
         VALUES ($1, 'interest_return', $2, $3, $4, $5, $6)
         RETURNING *`,
        [bondId, amountNum, parseFloat(bond.principal_balance), newAccrued,
         `Interest return of $${amountNum.toFixed(2)}`, new Date().toISOString().split('T')[0]]
      );

      await client.query('COMMIT');
      return {
        returned: amountNum,
        new_accrued_interest: newAccrued,
        total_interest_paid: newTotalInterestPaid,
        transaction: txnResult.rows[0],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Apply level-payment amortization through the target date.
   * Processes any scheduled principal+interest payments that have come due,
   * and accrues interest for the current partial period.
   */
  static async applyAmortization(bondId, asOfDate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bondResult = await client.query(
        `SELECT b.*, bb.principal_balance, bb.accrued_interest, bb.total_interest_paid,
                bb.total_principal_paid, bb.last_accrual_date, bb.last_payment_date
         FROM bonds b
         JOIN bond_balances bb ON bb.bond_id = b.id
         WHERE b.id = $1
         FOR UPDATE OF bb`,
        [bondId]
      );
      const bond = bondResult.rows[0];
      if (!bond || !bond.amortizing) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'Bond is not amortizing' };
      }

      const oldAccrued = parseFloat(bond.accrued_interest || 0);
      const state = BondAmortization.amortizedState(bond, asOfDate);

      await client.query(
        `UPDATE bond_balances
         SET principal_balance = $1, total_principal_paid = $2, total_interest_paid = $3,
             accrued_interest = $4, last_payment_date = $5, last_accrual_date = $6, updated_at = NOW()
         WHERE bond_id = $7`,
        [state.principal_balance, state.total_principal_paid, state.total_interest_paid,
         state.accrued_interest, state.last_payment_date, state.last_accrual_date, bondId]
      );

      for (const tx of state.transactions) {
        await client.query(
          `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
           VALUES ($1, 'principal_payment', $2, $3, $4, $5, $6)`,
          [bondId, tx.principal, tx.balance, 0, `Scheduled principal payment — ${tx.transaction_date}`, tx.transaction_date]
        );
        await client.query(
          `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
           VALUES ($1, 'interest_payment', $2, $3, $4, $5, $6)`,
          [bondId, tx.interest, tx.balance, 0, `Scheduled interest payment — ${tx.transaction_date}`, tx.transaction_date]
        );
      }

      const accrualDelta = Math.round((state.accrued_interest - oldAccrued) * 100) / 100;
      if (accrualDelta > 0) {
        await client.query(
          `INSERT INTO bond_transactions (bond_id, transaction_type, amount, running_balance, accrued_interest, description, transaction_date)
           VALUES ($1, 'interest_accrual', $2, $3, $4, $5, $6)`,
          [bondId, accrualDelta, state.principal_balance, state.accrued_interest,
           `Amortized interest accrual to ${state.last_accrual_date}`, state.last_accrual_date]
        );
      }

      await client.query('COMMIT');
      return {
        applied: true,
        principal_balance: state.principal_balance,
        total_principal_paid: state.total_principal_paid,
        total_interest_paid: state.total_interest_paid,
        accrued_interest: state.accrued_interest,
        accrual_delta: accrualDelta,
        transactions: state.transactions,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { BondEngine };

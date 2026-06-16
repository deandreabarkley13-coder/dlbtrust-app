/**
 * CRM Engine — DLB Trust Platform
 *
 * Manages investor/trustee/beneficiary contacts, KYC/AML tracking,
 * interaction history, and bond subscription records.
 * All storage via PostgreSQL (fineract_tenants).
 */

'use strict';

const pool = require('../bonds/pgPool');

class CrmEngine {

  static async createContact({
    contactType, firstName, lastName, company, email, phone, mailingAddress,
    dateOfBirth, ssnLast4, fineractClientId, linkedWalletId, preferredPayment,
    routingNumber, accountNumber, bankAccountType, bankName, notes, tags,
  }) {
    const contactId = 'CRM-' + contactType.toUpperCase().slice(0, 3) + '-' + Date.now();
    const result = await pool.query(
      `INSERT INTO crm_contacts
         (contact_id, contact_type, first_name, last_name, company, email, phone,
          mailing_address, date_of_birth, ssn_last4, fineract_client_id,
          linked_wallet_id, preferred_payment, routing_number, account_number,
          bank_account_type, bank_name, notes, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [contactId, contactType, firstName, lastName, company || null, email || null,
       phone || null, mailingAddress || null, dateOfBirth || null, ssnLast4 || null,
       fineractClientId || null, linkedWalletId || null, preferredPayment || 'ach',
       routingNumber || null, accountNumber || null, bankAccountType || 'checking',
       bankName || null, notes || null, tags || null]
    );
    return result.rows[0];
  }

  static async getContact(contactId) {
    const contactResult = await pool.query(
      `SELECT * FROM crm_contacts WHERE contact_id = $1`,
      [contactId]
    );
    if (contactResult.rows.length === 0) return null;

    const interactionsResult = await pool.query(
      `SELECT * FROM crm_interactions WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [contactId]
    );

    return {
      ...contactResult.rows[0],
      recent_interactions: interactionsResult.rows,
    };
  }

  static async listContacts({ contactType, kycStatus, amlStatus, status, search, limit, offset } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (contactType) { conditions.push(`contact_type = $${idx++}`); params.push(contactType); }
    if (kycStatus) { conditions.push(`kyc_status = $${idx++}`); params.push(kycStatus); }
    if (amlStatus) { conditions.push(`aml_status = $${idx++}`); params.push(amlStatus); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (search) {
      conditions.push(`(first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR email ILIKE $${idx} OR company ILIKE $${idx})`);
      params.push('%' + search + '%');
      idx++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const lim = limit ? parseInt(limit, 10) : 100;
    const off = offset ? parseInt(offset, 10) : 0;

    params.push(lim, off);
    const result = await pool.query(
      `SELECT * FROM crm_contacts ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );
    return result.rows;
  }

  static async updateContact(contactId, updates) {
    const allowedFields = [
      'first_name', 'last_name', 'company', 'email', 'phone', 'mailing_address',
      'preferred_payment', 'routing_number', 'account_number', 'bank_account_type',
      'bank_name', 'notes', 'tags', 'status', 'fineract_client_id', 'linked_wallet_id',
    ];

    const setClauses = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      const snakeKey = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      if (allowedFields.includes(snakeKey)) {
        setClauses.push(`${snakeKey} = $${idx++}`);
        params.push(value);
      }
    }

    if (setClauses.length === 0) throw new Error('No valid fields to update');

    setClauses.push(`updated_at = NOW()`);
    params.push(contactId);

    const result = await pool.query(
      `UPDATE crm_contacts SET ${setClauses.join(', ')} WHERE contact_id = $${idx} RETURNING *`,
      params
    );
    if (result.rows.length === 0) throw new Error(`Contact ${contactId} not found`);
    return result.rows[0];
  }

  static async updateKycStatus(contactId, kycStatus) {
    const verifiedAt = kycStatus === 'verified' ? new Date().toISOString() : null;
    const result = await pool.query(
      `UPDATE crm_contacts SET kyc_status = $1, kyc_verified_at = $2, updated_at = NOW()
       WHERE contact_id = $3 RETURNING *`,
      [kycStatus, verifiedAt, contactId]
    );
    if (result.rows.length === 0) throw new Error(`Contact ${contactId} not found`);
    return result.rows[0];
  }

  static async logInteraction({ contactId, interactionType, subject, body, direction, outcome, followUpDate, createdBy }) {
    const interactionId = 'INT-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const result = await pool.query(
      `INSERT INTO crm_interactions
         (interaction_id, contact_id, interaction_type, subject, body, direction, outcome, follow_up_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [interactionId, contactId, interactionType, subject || null, body || null,
       direction || null, outcome || null, followUpDate || null, createdBy || null]
    );
    return result.rows[0];
  }

  static async getInteractions(contactId, { limit, offset } = {}) {
    const lim = limit ? parseInt(limit, 10) : 50;
    const off = offset ? parseInt(offset, 10) : 0;
    const result = await pool.query(
      `SELECT * FROM crm_interactions WHERE contact_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [contactId, lim, off]
    );
    return result.rows;
  }

  static async createBondSubscription({ contactId, bondId, subscriptionAmount, offeringPrice, settlementDate, cashAccountId, notes }) {
    const subscriptionId = 'SUB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const result = await pool.query(
      `INSERT INTO crm_bond_subscriptions
         (subscription_id, contact_id, bond_id, subscription_amount, offering_price, settlement_date, cash_account_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [subscriptionId, contactId, bondId, subscriptionAmount, offeringPrice || 1.0,
       settlementDate, cashAccountId || null, notes || null]
    );
    return result.rows[0];
  }

  static async getBondSubscriptions({ contactId, bondId, status } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (contactId) { conditions.push(`s.contact_id = $${idx++}`); params.push(contactId); }
    if (bondId) { conditions.push(`s.bond_id = $${idx++}`); params.push(bondId); }
    if (status) { conditions.push(`s.status = $${idx++}`); params.push(status); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT s.*, c.first_name, c.last_name, c.company, c.email, b.bond_name, b.face_value
       FROM crm_bond_subscriptions s
       JOIN crm_contacts c ON c.contact_id = s.contact_id
       JOIN bonds b ON b.id = s.bond_id
       ${where}
       ORDER BY s.created_at DESC`,
      params
    );
    return result.rows;
  }

  static async getDashboard() {
    const contactsByType = await pool.query(
      `SELECT contact_type, COUNT(*) AS count FROM crm_contacts GROUP BY contact_type`
    );
    const kycPending = await pool.query(
      `SELECT COUNT(*) AS count FROM crm_contacts WHERE kyc_status = 'pending'`
    );
    const amlFlagged = await pool.query(
      `SELECT COUNT(*) AS count FROM crm_contacts WHERE aml_status = 'flagged'`
    );
    const subscriptionStats = await pool.query(
      `SELECT COUNT(*) AS active_count, COALESCE(SUM(subscription_amount), 0) AS total_amount
       FROM crm_bond_subscriptions WHERE status = 'active'`
    );

    const byType = {};
    for (const row of contactsByType.rows) {
      byType[row.contact_type] = parseInt(row.count, 10);
    }

    return {
      contacts_by_type: byType,
      total_contacts: Object.values(byType).reduce((s, v) => s + v, 0),
      kyc_pending_count: parseInt(kycPending.rows[0].count, 10),
      aml_flagged_count: parseInt(amlFlagged.rows[0].count, 10),
      active_subscriptions: parseInt(subscriptionStats.rows[0].active_count, 10),
      total_subscription_amount: parseFloat(subscriptionStats.rows[0].total_amount),
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = { CrmEngine };

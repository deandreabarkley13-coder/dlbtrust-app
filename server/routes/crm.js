/**
 * CRM Routes — Contact Relationship Management
 * DEANDREA LAVAR BARKLEY TRUST — Private Wealth Management Platform
 *
 * Endpoints:
 *   GET    /api/crm/contacts              - List all contacts (filter by type, status)
 *   POST   /api/crm/contacts              - Create a new contact
 *   GET    /api/crm/contacts/:id          - Contact detail with relationships & payment methods
 *   PUT    /api/crm/contacts/:id          - Update contact
 *   DELETE /api/crm/contacts/:id          - Deactivate contact (soft delete)
 *   GET    /api/crm/contacts/:id/payment-methods  - List payment methods
 *   POST   /api/crm/contacts/:id/payment-methods  - Add payment method
 *   PUT    /api/crm/contacts/:id/payment-methods/:pmId  - Update payment method
 *   DELETE /api/crm/contacts/:id/payment-methods/:pmId  - Remove payment method
 *   GET    /api/crm/contacts/:id/relationships    - List relationships
 *   POST   /api/crm/contacts/:id/relationships    - Link to account
 *   DELETE /api/crm/contacts/:id/relationships/:relId - Remove relationship
 *   GET    /api/crm/contacts/:id/documents        - List documents
 *   POST   /api/crm/contacts/:id/documents        - Add document record
 *   PUT    /api/crm/contacts/:id/documents/:docId  - Update document
 *   GET    /api/crm/contacts/:id/notes            - List notes
 *   POST   /api/crm/contacts/:id/notes            - Add note
 *   GET    /api/crm/contacts/:id/payments         - Payment history
 *   GET    /api/crm/dashboard                     - CRM summary metrics
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

function initSchema(db) {
  if (schemaInitialized) return;
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'crm-schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  }
  schemaInitialized = true;
}

// --- Middleware: DB per-request ---------------------------------------------

router.use((req, res, next) => {
  try {
    req.db = getDb();
    initSchema(req.db);
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// --- Helpers ----------------------------------------------------------------

function insertAudit(db, entry) {
  try {
    db.prepare(`
      INSERT INTO banking_audit_log (event_type, entity_type, entity_id, actor, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(entry.event_type, entry.entity_type, entry.entity_id, entry.actor, entry.action, entry.details);
  } catch (_) { /* audit table may not exist yet */ }
}

function toDollars(cents) { return (cents / 100).toFixed(2); }

const VALID_CONTACT_TYPES = ['trustee', 'beneficiary', 'vendor'];
const VALID_CONTACT_STATUSES = ['active', 'inactive', 'pending_kyc', 'suspended'];
const VALID_PAYMENT_METHODS = ['ach', 'wire', 'check', 'zelle'];
const VALID_RELATIONSHIP_TYPES = ['beneficiary_of', 'vendor_for', 'trustee_of', 'advisor_to'];

function maskAccountNumber(num) {
  if (!num || num.length <= 4) return num;
  return '****' + num.slice(-4);
}

function validateContact(body) {
  const errors = [];
  if (!body.first_name || !body.first_name.trim()) errors.push('first_name is required');
  if (!body.last_name || !body.last_name.trim()) errors.push('last_name is required');
  if (body.contact_type && !VALID_CONTACT_TYPES.includes(body.contact_type)) {
    errors.push(`contact_type must be one of: ${VALID_CONTACT_TYPES.join(', ')}`);
  }
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    errors.push('Invalid email format');
  }
  return errors;
}

// ============================================================================
// CONTACTS CRUD
// ============================================================================

// --- GET /contacts ----------------------------------------------------------
router.get('/contacts', (req, res) => {
  try {
    const { type, status, search, limit = 100, offset = 0 } = req.query;
    let sql = 'SELECT * FROM crm_contacts WHERE 1=1';
    const params = [];

    if (type) { sql += ' AND contact_type = ?'; params.push(type); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (search) {
      sql += ' AND (first_name LIKE ? OR last_name LIKE ? OR company_name LIKE ? OR email LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS total');
    const total = req.db.prepare(countSql).get(...params).total;

    sql += ' ORDER BY last_name, first_name LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const contacts = req.db.prepare(sql).all(...params);
    res.json({ count: total, contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /contacts ---------------------------------------------------------
router.post('/contacts', (req, res) => {
  try {
    const errors = validateContact(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; ') });

    const {
      contact_type = 'beneficiary',
      first_name, last_name, company_name = null,
      email = null, phone = null, mobile = null,
      address_line1 = null, address_line2 = null,
      city = null, state = null, zip = null, country = 'US',
      tax_id = null, tax_id_type = 'ssn',
      date_of_birth = null,
      vendor_category = null, payment_terms = 'net_30',
      trustee_role = null, trustee_start_date = null, trustee_end_date = null,
      beneficiary_class = null, distribution_pct = 0,
      notes = null, tags = null,
    } = req.body;

    const result = req.db.prepare(`
      INSERT INTO crm_contacts
        (contact_type, first_name, last_name, company_name,
         email, phone, mobile,
         address_line1, address_line2, city, state, zip, country,
         tax_id, tax_id_type, date_of_birth,
         vendor_category, payment_terms,
         trustee_role, trustee_start_date, trustee_end_date,
         beneficiary_class, distribution_pct,
         notes, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contact_type, first_name, last_name, company_name,
      email, phone, mobile,
      address_line1, address_line2, city, state, zip, country,
      tax_id, tax_id_type, date_of_birth,
      vendor_category, payment_terms,
      trustee_role, trustee_start_date, trustee_end_date,
      beneficiary_class, distribution_pct,
      notes, typeof tags === 'object' ? JSON.stringify(tags) : tags,
    );

    const contact = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(result.lastInsertRowid);

    insertAudit(req.db, {
      event_type: 'contact_created', entity_type: 'crm_contact', entity_id: contact.id,
      actor: 'system', action: 'create',
      details: JSON.stringify({ contact_type, name: `${first_name} ${last_name}` }),
    });

    res.status(201).json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /contacts/:id ------------------------------------------------------
router.get('/contacts/:id', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const payment_methods = req.db.prepare(
      'SELECT * FROM crm_payment_methods WHERE contact_id = ? AND status != ? ORDER BY is_default DESC'
    ).all(req.params.id, 'inactive');

    // Mask account numbers
    payment_methods.forEach(pm => { pm.account_number = maskAccountNumber(pm.account_number); });

    const relationships = req.db.prepare(`
      SELECT r.*, a.account_name, a.account_number, a.account_type, a.status AS account_status
      FROM crm_relationships r
      LEFT JOIN trust_accounts a ON a.id = r.account_id
      WHERE r.contact_id = ? AND r.status = 'active'
    `).all(req.params.id);

    const documents = req.db.prepare(
      'SELECT * FROM crm_documents WHERE contact_id = ? ORDER BY created_at DESC'
    ).all(req.params.id);

    const recent_notes = req.db.prepare(
      'SELECT * FROM crm_notes WHERE contact_id = ? ORDER BY created_at DESC LIMIT 10'
    ).all(req.params.id);

    res.json({ ...contact, payment_methods, relationships, documents, recent_notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /contacts/:id ------------------------------------------------------
router.put('/contacts/:id', (req, res) => {
  try {
    const existing = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    const fields = [
      'contact_type', 'status', 'first_name', 'last_name', 'company_name',
      'email', 'phone', 'mobile',
      'address_line1', 'address_line2', 'city', 'state', 'zip', 'country',
      'tax_id', 'tax_id_type', 'date_of_birth',
      'kyc_status', 'kyc_verified_date', 'kyc_expiry_date', 'aml_risk_rating',
      'vendor_category', 'payment_terms',
      'trustee_role', 'trustee_start_date', 'trustee_end_date',
      'beneficiary_class', 'distribution_pct',
      'notes', 'tags',
    ];

    const updates = [];
    const values = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(f === 'tags' && typeof req.body[f] === 'object' ? JSON.stringify(req.body[f]) : req.body[f]);
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);

    req.db.prepare(`UPDATE crm_contacts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const contact = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(req.params.id);

    insertAudit(req.db, {
      event_type: 'contact_updated', entity_type: 'crm_contact', entity_id: contact.id,
      actor: 'system', action: 'update',
      details: JSON.stringify({ updated_fields: Object.keys(req.body) }),
    });

    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DELETE /contacts/:id ---------------------------------------------------
router.delete('/contacts/:id', (req, res) => {
  try {
    const existing = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    // Soft delete: set status to inactive
    req.db.prepare("UPDATE crm_contacts SET status = 'inactive', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    insertAudit(req.db, {
      event_type: 'contact_deactivated', entity_type: 'crm_contact', entity_id: existing.id,
      actor: 'system', action: 'deactivate',
      details: JSON.stringify({ name: existing.display_name }),
    });

    res.json({ message: 'Contact deactivated', id: existing.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PAYMENT METHODS
// ============================================================================

// --- GET /contacts/:id/payment-methods --------------------------------------
router.get('/contacts/:id/payment-methods', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const methods = req.db.prepare(
      'SELECT * FROM crm_payment_methods WHERE contact_id = ? ORDER BY is_default DESC, created_at'
    ).all(req.params.id);

    methods.forEach(m => { m.account_number = maskAccountNumber(m.account_number); });
    res.json({ count: methods.length, payment_methods: methods });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /contacts/:id/payment-methods -------------------------------------
router.post('/contacts/:id/payment-methods', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const {
      method_type = 'ach', label = 'Primary', is_default = 0,
      bank_name = null, routing_number = null, account_number = null,
      account_type = 'checking',
      swift_code = null, wire_instructions = null, intermediary_bank = null,
      payable_to = null, mail_address = null,
      notes = null,
    } = req.body;

    if (!VALID_PAYMENT_METHODS.includes(method_type)) {
      return res.status(400).json({ error: `method_type must be one of: ${VALID_PAYMENT_METHODS.join(', ')}` });
    }

    if ((method_type === 'ach' || method_type === 'wire') && !routing_number) {
      return res.status(400).json({ error: 'routing_number is required for ACH/wire' });
    }
    if ((method_type === 'ach' || method_type === 'wire') && !account_number) {
      return res.status(400).json({ error: 'account_number is required for ACH/wire' });
    }
    if (routing_number && !/^\d{9}$/.test(String(routing_number))) {
      return res.status(400).json({ error: 'routing_number must be exactly 9 digits' });
    }

    // If setting as default, clear existing defaults
    if (is_default) {
      req.db.prepare('UPDATE crm_payment_methods SET is_default = 0 WHERE contact_id = ?').run(req.params.id);
    }

    const result = req.db.prepare(`
      INSERT INTO crm_payment_methods
        (contact_id, method_type, label, is_default, bank_name, routing_number, account_number,
         account_type, swift_code, wire_instructions, intermediary_bank,
         payable_to, mail_address, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, method_type, label, is_default ? 1 : 0,
      bank_name, routing_number, account_number, account_type,
      swift_code, wire_instructions, intermediary_bank,
      payable_to, mail_address, notes,
    );

    const pm = req.db.prepare('SELECT * FROM crm_payment_methods WHERE id = ?').get(result.lastInsertRowid);
    pm.account_number = maskAccountNumber(pm.account_number);

    insertAudit(req.db, {
      event_type: 'payment_method_added', entity_type: 'crm_contact', entity_id: Number(req.params.id),
      actor: 'system', action: 'create',
      details: JSON.stringify({ method_type, label, bank_name }),
    });

    res.status(201).json(pm);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /contacts/:id/payment-methods/:pmId --------------------------------
router.put('/contacts/:id/payment-methods/:pmId', (req, res) => {
  try {
    const pm = req.db.prepare(
      'SELECT * FROM crm_payment_methods WHERE id = ? AND contact_id = ?'
    ).get(req.params.pmId, req.params.id);
    if (!pm) return res.status(404).json({ error: 'Payment method not found' });

    const fields = [
      'method_type', 'label', 'is_default', 'bank_name', 'routing_number',
      'account_number', 'account_type', 'swift_code', 'wire_instructions',
      'intermediary_bank', 'payable_to', 'mail_address', 'verified',
      'verified_date', 'verification_method', 'status', 'notes',
    ];

    const updates = [];
    const values = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(req.body[f]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    // If setting as default, clear existing defaults
    if (req.body.is_default) {
      req.db.prepare('UPDATE crm_payment_methods SET is_default = 0 WHERE contact_id = ?').run(req.params.id);
    }

    updates.push("updated_at = datetime('now')");
    values.push(req.params.pmId, req.params.id);

    req.db.prepare(`UPDATE crm_payment_methods SET ${updates.join(', ')} WHERE id = ? AND contact_id = ?`).run(...values);
    const updated = req.db.prepare('SELECT * FROM crm_payment_methods WHERE id = ?').get(req.params.pmId);
    updated.account_number = maskAccountNumber(updated.account_number);

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DELETE /contacts/:id/payment-methods/:pmId -----------------------------
router.delete('/contacts/:id/payment-methods/:pmId', (req, res) => {
  try {
    const pm = req.db.prepare(
      'SELECT * FROM crm_payment_methods WHERE id = ? AND contact_id = ?'
    ).get(req.params.pmId, req.params.id);
    if (!pm) return res.status(404).json({ error: 'Payment method not found' });

    req.db.prepare(
      "UPDATE crm_payment_methods SET status = 'inactive', updated_at = datetime('now') WHERE id = ?"
    ).run(req.params.pmId);

    res.json({ message: 'Payment method deactivated', id: Number(req.params.pmId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// RELATIONSHIPS
// ============================================================================

// --- GET /contacts/:id/relationships ----------------------------------------
router.get('/contacts/:id/relationships', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const relationships = req.db.prepare(`
      SELECT r.*, a.account_name, a.account_number, a.account_type, a.balance_cents, a.status AS account_status
      FROM crm_relationships r
      LEFT JOIN trust_accounts a ON a.id = r.account_id
      WHERE r.contact_id = ?
      ORDER BY r.status, r.start_date
    `).all(req.params.id);

    res.json({ count: relationships.length, relationships });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /contacts/:id/relationships ---------------------------------------
router.post('/contacts/:id/relationships', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const {
      account_id, relationship_type, role_detail = null,
      share_pct = null, start_date = null, authorized_actions = null, notes = null,
    } = req.body;

    if (!relationship_type || !VALID_RELATIONSHIP_TYPES.includes(relationship_type)) {
      return res.status(400).json({ error: `relationship_type must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}` });
    }

    if (account_id) {
      const account = req.db.prepare('SELECT id FROM trust_accounts WHERE id = ?').get(account_id);
      if (!account) return res.status(404).json({ error: 'Account not found' });
    }

    const result = req.db.prepare(`
      INSERT INTO crm_relationships
        (contact_id, account_id, relationship_type, role_detail, share_pct, start_date, authorized_actions, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, account_id || null, relationship_type, role_detail,
      share_pct, start_date, typeof authorized_actions === 'object' ? JSON.stringify(authorized_actions) : authorized_actions,
      notes,
    );

    const rel = req.db.prepare('SELECT * FROM crm_relationships WHERE id = ?').get(result.lastInsertRowid);

    insertAudit(req.db, {
      event_type: 'relationship_created', entity_type: 'crm_contact', entity_id: Number(req.params.id),
      actor: 'system', action: 'create',
      details: JSON.stringify({ relationship_type, account_id }),
    });

    res.status(201).json(rel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- DELETE /contacts/:id/relationships/:relId ------------------------------
router.delete('/contacts/:id/relationships/:relId', (req, res) => {
  try {
    const rel = req.db.prepare(
      'SELECT * FROM crm_relationships WHERE id = ? AND contact_id = ?'
    ).get(req.params.relId, req.params.id);
    if (!rel) return res.status(404).json({ error: 'Relationship not found' });

    req.db.prepare(
      "UPDATE crm_relationships SET status = 'terminated', end_date = date('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(req.params.relId);

    res.json({ message: 'Relationship terminated', id: Number(req.params.relId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// DOCUMENTS
// ============================================================================

// --- GET /contacts/:id/documents --------------------------------------------
router.get('/contacts/:id/documents', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const documents = req.db.prepare(
      'SELECT * FROM crm_documents WHERE contact_id = ? ORDER BY created_at DESC'
    ).all(req.params.id);

    res.json({ count: documents.length, documents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /contacts/:id/documents -------------------------------------------
router.post('/contacts/:id/documents', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const {
      document_type, document_name, file_path = null,
      issue_date = null, expiry_date = null,
      review_required = 0, notes = null,
    } = req.body;

    if (!document_type || !document_name) {
      return res.status(400).json({ error: 'document_type and document_name are required' });
    }

    const result = req.db.prepare(`
      INSERT INTO crm_documents
        (contact_id, document_type, document_name, file_path, issue_date, expiry_date, review_required, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, document_type, document_name, file_path, issue_date, expiry_date, review_required ? 1 : 0, notes);

    const doc = req.db.prepare('SELECT * FROM crm_documents WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PUT /contacts/:id/documents/:docId -------------------------------------
router.put('/contacts/:id/documents/:docId', (req, res) => {
  try {
    const doc = req.db.prepare(
      'SELECT * FROM crm_documents WHERE id = ? AND contact_id = ?'
    ).get(req.params.docId, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const fields = [
      'document_type', 'document_name', 'file_path', 'issue_date', 'expiry_date',
      'status', 'review_required', 'reviewed_by', 'reviewed_date', 'notes',
    ];

    const updates = [];
    const values = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    updates.push("updated_at = datetime('now')");
    values.push(req.params.docId, req.params.id);

    req.db.prepare(`UPDATE crm_documents SET ${updates.join(', ')} WHERE id = ? AND contact_id = ?`).run(...values);
    const updated = req.db.prepare('SELECT * FROM crm_documents WHERE id = ?').get(req.params.docId);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// NOTES / COMMUNICATIONS LOG
// ============================================================================

// --- GET /contacts/:id/notes ------------------------------------------------
router.get('/contacts/:id/notes', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const notes = req.db.prepare(
      'SELECT * FROM crm_notes WHERE contact_id = ? ORDER BY created_at DESC'
    ).all(req.params.id);

    res.json({ count: notes.length, notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /contacts/:id/notes -----------------------------------------------
router.post('/contacts/:id/notes', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT id FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const {
      note_type = 'general', subject = null, body,
      priority = 'normal', due_date = null,
    } = req.body;

    if (!body || !body.trim()) return res.status(400).json({ error: 'body is required' });

    const result = req.db.prepare(`
      INSERT INTO crm_notes (contact_id, note_type, subject, body, priority, due_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.params.id, note_type, subject, body, priority, due_date);

    const note = req.db.prepare('SELECT * FROM crm_notes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// PAYMENT HISTORY (cross-references transfers)
// ============================================================================

// --- GET /contacts/:id/payments ---------------------------------------------
router.get('/contacts/:id/payments', (req, res) => {
  try {
    const contact = req.db.prepare('SELECT * FROM crm_contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Get account IDs linked to this contact
    const rels = req.db.prepare(
      "SELECT account_id FROM crm_relationships WHERE contact_id = ? AND status = 'active' AND account_id IS NOT NULL"
    ).all(req.params.id);

    const accountIds = rels.map(r => r.account_id);
    let payments = [];

    if (accountIds.length > 0) {
      const placeholders = accountIds.map(() => '?').join(',');
      try {
        payments = req.db.prepare(`
          SELECT * FROM internal_transfers
          WHERE from_account_id IN (${placeholders}) OR to_account_id IN (${placeholders})
          ORDER BY created_at DESC LIMIT 50
        `).all(...accountIds, ...accountIds);
      } catch (_) { /* transfers table may not exist */ }
    }

    res.json({ contact_name: contact.display_name, count: payments.length, payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CRM DASHBOARD
// ============================================================================

// --- GET /dashboard ---------------------------------------------------------
router.get('/dashboard', (req, res) => {
  try {
    const totalContacts = req.db.prepare('SELECT COUNT(*) AS total FROM crm_contacts').get().total;
    const byType = req.db.prepare(
      "SELECT contact_type, COUNT(*) AS count FROM crm_contacts WHERE status != 'inactive' GROUP BY contact_type"
    ).all();
    const byStatus = req.db.prepare(
      'SELECT status, COUNT(*) AS count FROM crm_contacts GROUP BY status'
    ).all();
    const pendingKyc = req.db.prepare(
      "SELECT COUNT(*) AS count FROM crm_contacts WHERE kyc_status = 'pending' AND status != 'inactive'"
    ).get().count;

    let expiringDocs = 0;
    try {
      expiringDocs = req.db.prepare(
        "SELECT COUNT(*) AS count FROM crm_documents WHERE expiry_date IS NOT NULL AND expiry_date <= date('now', '+30 days') AND status = 'active'"
      ).get().count;
    } catch (_) {}

    const recentContacts = req.db.prepare(
      'SELECT id, display_name, contact_type, status, created_at FROM crm_contacts ORDER BY created_at DESC LIMIT 5'
    ).all();

    const totalPaymentMethods = req.db.prepare(
      "SELECT COUNT(*) AS count FROM crm_payment_methods WHERE status = 'active'"
    ).get().count;

    const unverifiedPaymentMethods = req.db.prepare(
      "SELECT COUNT(*) AS count FROM crm_payment_methods WHERE verified = 0 AND status = 'active'"
    ).get().count;

    res.json({
      total_contacts: totalContacts,
      by_type: byType,
      by_status: byStatus,
      pending_kyc: pendingKyc,
      expiring_documents_30d: expiringDocs,
      recent_contacts: recentContacts,
      total_payment_methods: totalPaymentMethods,
      unverified_payment_methods: unverifiedPaymentMethods,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

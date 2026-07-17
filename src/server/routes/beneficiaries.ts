import { Router, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { v4 as uuid } from 'uuid';

const router = Router();

router.get('/', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const trustId = req.query.trust_id as string;

  let beneficiaries;
  if (trustId) {
    beneficiaries = db.prepare(`
      SELECT id, trust_id, first_name, last_name, email, phone, address_line1, address_line2,
             city, state, zip, account_type, account_number_last4, created_at, updated_at
      FROM beneficiaries WHERE trust_id = ? ORDER BY last_name, first_name
    `).all(trustId);
  } else if (req.user!.role === 'admin') {
    beneficiaries = db.prepare(`
      SELECT id, trust_id, first_name, last_name, email, phone, address_line1, address_line2,
             city, state, zip, account_type, account_number_last4, created_at, updated_at
      FROM beneficiaries ORDER BY last_name, first_name
    `).all();
  } else {
    beneficiaries = db.prepare(`
      SELECT b.id, b.trust_id, b.first_name, b.last_name, b.email, b.phone,
             b.address_line1, b.address_line2, b.city, b.state, b.zip,
             b.account_type, b.account_number_last4, b.created_at, b.updated_at
      FROM beneficiaries b
      JOIN trust_users tu ON b.trust_id = tu.trust_id
      WHERE tu.user_id = ?
      ORDER BY b.last_name, b.first_name
    `).all(req.user!.userId);
  }

  res.json({ data: beneficiaries });
});

router.get('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const beneficiary = db.prepare(`
    SELECT id, trust_id, first_name, last_name, email, phone, address_line1, address_line2,
           city, state, zip, account_type, account_number_last4, created_at, updated_at
    FROM beneficiaries WHERE id = ?
  `).get(req.params.id);

  if (!beneficiary) {
    res.status(404).json({ error: 'Beneficiary not found' });
    return;
  }

  res.json({ data: beneficiary });
});

router.post('/', requireAuth, requireRole('admin', 'trustee'), (req: Request, res: Response) => {
  const { trust_id, first_name, last_name, email, phone, address_line1, address_line2, city, state, zip, routing_number, account_number, account_type } = req.body;

  if (!trust_id || !first_name || !last_name || !email) {
    res.status(400).json({ error: 'trust_id, first_name, last_name, and email are required' });
    return;
  }

  const db = getDb();
  const trust = db.prepare('SELECT id FROM trusts WHERE id = ?').get(trust_id);
  if (!trust) {
    res.status(404).json({ error: 'Trust not found' });
    return;
  }

  const id = uuid();
  const last4 = account_number ? account_number.slice(-4) : null;

  db.prepare(`
    INSERT INTO beneficiaries (id, trust_id, first_name, last_name, email, phone, address_line1, address_line2, city, state, zip, routing_number, account_number_encrypted, account_number_last4, account_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, trust_id, first_name, last_name, email, phone || null, address_line1 || '', address_line2 || null, city || '', state || '', zip || '', routing_number || null, account_number || null, last4, account_type || null);

  logAudit(req.user!.userId, 'create_beneficiary', 'beneficiary', id, `Created ${first_name} ${last_name}`);

  const created = db.prepare(`
    SELECT id, trust_id, first_name, last_name, email, phone, address_line1, address_line2,
           city, state, zip, account_type, account_number_last4, created_at, updated_at
    FROM beneficiaries WHERE id = ?
  `).get(id);

  res.status(201).json({ data: created });
});

router.put('/:id', requireAuth, requireRole('admin', 'trustee'), (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { first_name, last_name, email, phone, address_line1, address_line2, city, state, zip, routing_number, account_number, account_type } = req.body;

  const existing = db.prepare('SELECT id FROM beneficiaries WHERE id = ?').get(id);
  if (!existing) {
    res.status(404).json({ error: 'Beneficiary not found' });
    return;
  }

  const last4 = account_number ? account_number.slice(-4) : undefined;

  db.prepare(`
    UPDATE beneficiaries SET
      first_name = COALESCE(?, first_name),
      last_name = COALESCE(?, last_name),
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      address_line1 = COALESCE(?, address_line1),
      address_line2 = COALESCE(?, address_line2),
      city = COALESCE(?, city),
      state = COALESCE(?, state),
      zip = COALESCE(?, zip),
      routing_number = COALESCE(?, routing_number),
      account_number_encrypted = COALESCE(?, account_number_encrypted),
      account_number_last4 = COALESCE(?, account_number_last4),
      account_type = COALESCE(?, account_type),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    first_name || null, last_name || null, email || null, phone || null,
    address_line1 || null, address_line2 || null, city || null, state || null,
    zip || null, routing_number || null, account_number || null, last4 || null,
    account_type || null, id
  );

  logAudit(req.user!.userId, 'update_beneficiary', 'beneficiary', id);

  const updated = db.prepare(`
    SELECT id, trust_id, first_name, last_name, email, phone, address_line1, address_line2,
           city, state, zip, account_type, account_number_last4, created_at, updated_at
    FROM beneficiaries WHERE id = ?
  `).get(id);

  res.json({ data: updated });
});

export default router;

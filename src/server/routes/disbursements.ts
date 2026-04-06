import { Router, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { initiateAchPayment, isOpenAchConfigured } from '../services/openach.js';
import { v4 as uuid } from 'uuid';
import type { DisbursementStatus } from '../../shared/types.js';

const router = Router();

router.get('/', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const { role, userId } = req.user!;
  const trustId = req.query.trust_id as string;
  const status = req.query.status as string;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  let query = `
    SELECT d.*, b.first_name || ' ' || b.last_name as beneficiary_name, t.name as trust_name
    FROM disbursements d
    JOIN beneficiaries b ON d.beneficiary_id = b.id
    JOIN trusts t ON d.trust_id = t.id
  `;
  const params: (string | number)[] = [];
  const conditions: string[] = [];

  if (role !== 'admin') {
    conditions.push('d.trust_id IN (SELECT trust_id FROM trust_users WHERE user_id = ?)');
    params.push(userId);
  }
  if (trustId) {
    conditions.push('d.trust_id = ?');
    params.push(trustId);
  }
  if (status) {
    conditions.push('d.status = ?');
    params.push(status);
  }

  if (conditions.length) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const disbursements = db.prepare(query).all(...params);
  res.json({ data: disbursements });
});

router.get('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const disbursement = db.prepare(`
    SELECT d.*, b.first_name || ' ' || b.last_name as beneficiary_name, t.name as trust_name
    FROM disbursements d
    JOIN beneficiaries b ON d.beneficiary_id = b.id
    JOIN trusts t ON d.trust_id = t.id
    WHERE d.id = ?
  `).get(req.params.id);

  if (!disbursement) {
    res.status(404).json({ error: 'Disbursement not found' });
    return;
  }

  res.json({ data: disbursement });
});

router.post('/', requireAuth, requireRole('admin', 'trustee'), (req: Request, res: Response) => {
  const { trust_id, beneficiary_id, amount, method, description } = req.body;

  if (!trust_id || !beneficiary_id || !amount) {
    res.status(400).json({ error: 'trust_id, beneficiary_id, and amount are required' });
    return;
  }

  if (amount <= 0) {
    res.status(400).json({ error: 'Amount must be positive' });
    return;
  }

  const db = getDb();
  const trust = db.prepare('SELECT * FROM trusts WHERE id = ?').get(trust_id) as { id: string; balance: number } | undefined;
  if (!trust) {
    res.status(404).json({ error: 'Trust not found' });
    return;
  }

  if (trust.balance < amount) {
    res.status(400).json({ error: 'Insufficient trust balance' });
    return;
  }

  const beneficiary = db.prepare('SELECT id FROM beneficiaries WHERE id = ? AND trust_id = ?').get(beneficiary_id, trust_id);
  if (!beneficiary) {
    res.status(404).json({ error: 'Beneficiary not found in this trust' });
    return;
  }

  const validMethods = ['ach', 'check', 'wire'];
  if (method && !validMethods.includes(method)) {
    res.status(400).json({ error: 'Invalid disbursement method' });
    return;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO disbursements (id, trust_id, beneficiary_id, amount, method, description, requested_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, trust_id, beneficiary_id, amount, method || 'ach', description || '', req.user!.userId);

  logAudit(req.user!.userId, 'create_disbursement', 'disbursement', id, `Amount: $${amount}`);

  const created = db.prepare(`
    SELECT d.*, b.first_name || ' ' || b.last_name as beneficiary_name, t.name as trust_name
    FROM disbursements d
    JOIN beneficiaries b ON d.beneficiary_id = b.id
    JOIN trusts t ON d.trust_id = t.id
    WHERE d.id = ?
  `).get(id);

  res.status(201).json({ data: created });
});

router.post('/:id/approve', requireAuth, requireRole('admin', 'trustee'), async (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const disbursement = db.prepare('SELECT * FROM disbursements WHERE id = ?').get(id) as {
    id: string; trust_id: string; beneficiary_id: string; amount: number; method: string; status: DisbursementStatus; requested_by: string;
  } | undefined;

  if (!disbursement) {
    res.status(404).json({ error: 'Disbursement not found' });
    return;
  }

  if (disbursement.status !== 'pending') {
    res.status(400).json({ error: `Cannot approve a disbursement with status: ${disbursement.status}` });
    return;
  }

  if (disbursement.requested_by === req.user!.userId) {
    res.status(403).json({ error: 'Cannot approve your own disbursement request' });
    return;
  }

  const trust = db.prepare('SELECT balance FROM trusts WHERE id = ?').get(disbursement.trust_id) as { balance: number };
  if (trust.balance < disbursement.amount) {
    res.status(400).json({ error: 'Insufficient trust balance' });
    return;
  }

  const approveAndDebit = db.transaction(() => {
    db.prepare(`
      UPDATE disbursements SET status = 'approved', approved_by = ?, updated_at = datetime('now') WHERE id = ?
    `).run(req.user!.userId, id);

    db.prepare(`
      UPDATE trusts SET balance = balance - ?, updated_at = datetime('now') WHERE id = ?
    `).run(disbursement.amount, disbursement.trust_id);

    db.prepare(`
      INSERT INTO transactions (id, trust_id, disbursement_id, type, amount, description)
      VALUES (?, ?, ?, 'debit', ?, ?)
    `).run(uuid(), disbursement.trust_id, id, disbursement.amount, `Disbursement approved`);
  });

  approveAndDebit();
  logAudit(req.user!.userId, 'approve_disbursement', 'disbursement', id, `Amount: $${disbursement.amount}`);

  if (disbursement.method === 'ach' && isOpenAchConfigured()) {
    try {
      const beneficiary = db.prepare('SELECT * FROM beneficiaries WHERE id = ?').get(disbursement.beneficiary_id) as {
        first_name: string; last_name: string; routing_number: string; account_number_encrypted: string; account_type: 'checking' | 'savings';
      };

      if (beneficiary.routing_number && beneficiary.account_number_encrypted) {
        const result = await initiateAchPayment({
          amount: disbursement.amount,
          routingNumber: beneficiary.routing_number,
          accountNumber: beneficiary.account_number_encrypted,
          accountType: beneficiary.account_type,
          recipientName: `${beneficiary.first_name} ${beneficiary.last_name}`,
          description: `DLB Trust disbursement`,
          referenceId: id,
        });

        db.prepare(`
          UPDATE disbursements SET status = 'processing', ach_transaction_id = ?, updated_at = datetime('now') WHERE id = ?
        `).run(result.transactionId, id);

        logAudit(req.user!.userId, 'initiate_ach', 'disbursement', id, `ACH TX: ${result.transactionId}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logAudit(req.user!.userId, 'ach_error', 'disbursement', id, message);
    }
  }

  const updated = db.prepare(`
    SELECT d.*, b.first_name || ' ' || b.last_name as beneficiary_name, t.name as trust_name
    FROM disbursements d
    JOIN beneficiaries b ON d.beneficiary_id = b.id
    JOIN trusts t ON d.trust_id = t.id
    WHERE d.id = ?
  `).get(id);

  res.json({ data: updated });
});

router.post('/:id/reject', requireAuth, requireRole('admin', 'trustee'), (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { reason } = req.body;

  const disbursement = db.prepare('SELECT * FROM disbursements WHERE id = ?').get(id) as { status: string } | undefined;
  if (!disbursement) {
    res.status(404).json({ error: 'Disbursement not found' });
    return;
  }

  if (disbursement.status !== 'pending') {
    res.status(400).json({ error: `Cannot reject a disbursement with status: ${disbursement.status}` });
    return;
  }

  db.prepare(`
    UPDATE disbursements SET status = 'rejected', rejection_reason = ?, updated_at = datetime('now') WHERE id = ?
  `).run(reason || null, id);

  logAudit(req.user!.userId, 'reject_disbursement', 'disbursement', id, reason);

  const updated = db.prepare(`
    SELECT d.*, b.first_name || ' ' || b.last_name as beneficiary_name, t.name as trust_name
    FROM disbursements d
    JOIN beneficiaries b ON d.beneficiary_id = b.id
    JOIN trusts t ON d.trust_id = t.id
    WHERE d.id = ?
  `).get(id);

  res.json({ data: updated });
});

export default router;

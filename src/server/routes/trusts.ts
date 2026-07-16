import { Router, Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { v4 as uuid } from 'uuid';

const router = Router();

router.get('/', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const { role, userId } = req.user!;

  let trusts;
  if (role === 'admin') {
    trusts = db.prepare('SELECT * FROM trusts ORDER BY name').all();
  } else {
    trusts = db.prepare(`
      SELECT t.* FROM trusts t
      JOIN trust_users tu ON t.id = tu.trust_id
      WHERE tu.user_id = ?
      ORDER BY t.name
    `).all(userId);
  }

  res.json({ data: trusts });
});

router.get('/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const { role, userId } = req.user!;
  const { id } = req.params;

  const trust = db.prepare('SELECT * FROM trusts WHERE id = ?').get(id);
  if (!trust) {
    res.status(404).json({ error: 'Trust not found' });
    return;
  }

  if (role !== 'admin') {
    const access = db.prepare('SELECT 1 FROM trust_users WHERE trust_id = ? AND user_id = ?').get(id, userId);
    if (!access) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
  }

  res.json({ data: trust });
});

router.post('/', requireAuth, requireRole('admin'), (req: Request, res: Response) => {
  const { name, description, balance } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Trust name is required' });
    return;
  }

  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO trusts (id, name, description, balance) VALUES (?, ?, ?, ?)
  `).run(id, name, description || '', balance || 0);

  if (balance && balance > 0) {
    db.prepare(`
      INSERT INTO transactions (id, trust_id, type, amount, description) VALUES (?, ?, 'credit', ?, 'Initial funding')
    `).run(uuid(), id, balance);
  }

  logAudit(req.user!.userId, 'create_trust', 'trust', id, `Created trust: ${name}`);
  const trust = db.prepare('SELECT * FROM trusts WHERE id = ?').get(id);
  res.status(201).json({ data: trust });
});

router.put('/:id', requireAuth, requireRole('admin', 'trustee'), (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { name, description } = req.body;

  const trust = db.prepare('SELECT * FROM trusts WHERE id = ?').get(id);
  if (!trust) {
    res.status(404).json({ error: 'Trust not found' });
    return;
  }

  db.prepare(`
    UPDATE trusts SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = datetime('now') WHERE id = ?
  `).run(name || null, description || null, id);

  logAudit(req.user!.userId, 'update_trust', 'trust', id);
  const updated = db.prepare('SELECT * FROM trusts WHERE id = ?').get(id);
  res.json({ data: updated });
});

router.get('/:id/transactions', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const transactions = db.prepare(`
    SELECT * FROM transactions WHERE trust_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(id, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE trust_id = ?').get(id) as { count: number };

  res.json({ data: transactions, total: total.count, limit, offset });
});

export default router;

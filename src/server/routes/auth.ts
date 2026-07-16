import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { generateToken, requireAuth } from '../middleware/auth.js';
import { logAudit } from '../services/audit.js';
import { v4 as uuid } from 'uuid';
import type { UserRole } from '../../shared/types.js';

const router = Router();

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const verify = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === verify;
}

router.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as {
    id: string; email: string; name: string; role: UserRole; password_hash: string;
  } | undefined;

  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = generateToken({ userId: user.id, email: user.email, role: user.role });
  logAudit(user.id, 'login', 'user', user.id);

  res.json({
    data: {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    },
  });
});

router.post('/register', requireAuth, (req: Request, res: Response) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Only admins can register new users' });
    return;
  }

  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    res.status(400).json({ error: 'Email, password, and name are required' });
    return;
  }

  const validRoles: UserRole[] = ['admin', 'trustee', 'beneficiary', 'viewer'];
  if (role && !validRoles.includes(role)) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    res.status(409).json({ error: 'User with this email already exists' });
    return;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)
  `).run(id, email, name, role || 'viewer', hashPassword(password));

  logAudit(req.user!.userId, 'register_user', 'user', id, `Registered ${email}`);

  res.status(201).json({ data: { id, email, name, role: role || 'viewer' } });
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ data: user });
});

export default router;

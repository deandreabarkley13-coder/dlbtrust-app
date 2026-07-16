import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/server/db/index.js';
import { generateToken, verifyToken } from '../src/server/middleware/auth.js';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

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

describe('JWT auth', () => {
  it('generates and verifies tokens', () => {
    const payload = { userId: 'abc-123', email: 'test@example.com', role: 'admin' as const };
    const token = generateToken(payload);
    const decoded = verifyToken(token);

    expect(decoded.userId).toBe('abc-123');
    expect(decoded.email).toBe('test@example.com');
    expect(decoded.role).toBe('admin');
  });

  it('rejects tampered tokens', () => {
    const token = generateToken({ userId: 'a', email: 'a@a.com', role: 'viewer' as const });
    expect(() => verifyToken(token + 'x')).toThrow();
  });
});

describe('Password hashing', () => {
  it('correctly hashes and verifies passwords', () => {
    const hashed = hashPassword('mypassword');
    expect(verifyPassword('mypassword', hashed)).toBe(true);
    expect(verifyPassword('wrongpassword', hashed)).toBe(false);
  });
});

describe('Auth login flow', () => {
  beforeEach(() => {
    const db = getDb();
    const id = uuid();
    db.prepare('INSERT OR IGNORE INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'authtest@example.com', 'Auth Tester', 'admin', hashPassword('testpass'));
  });

  it('finds user by email', () => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('authtest@example.com') as any;
    expect(user).toBeDefined();
    expect(user.name).toBe('Auth Tester');
  });

  it('verifies password for existing user', () => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('authtest@example.com') as any;
    expect(verifyPassword('testpass', user.password_hash)).toBe(true);
    expect(verifyPassword('wrongpass', user.password_hash)).toBe(false);
  });
});

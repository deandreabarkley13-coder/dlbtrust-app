import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/server/db/index.js';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

describe('Database schema', () => {
  it('creates all tables', () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row: any) => row.name);

    expect(tables).toContain('users');
    expect(tables).toContain('trusts');
    expect(tables).toContain('trust_users');
    expect(tables).toContain('beneficiaries');
    expect(tables).toContain('disbursements');
    expect(tables).toContain('transactions');
    expect(tables).toContain('audit_log');
  });

  it('enforces foreign keys', () => {
    const db = getDb();
    const fk = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(fk[0].foreign_keys).toBe(1);
  });
});

describe('Users table', () => {
  it('inserts and retrieves a user', () => {
    const db = getDb();
    const id = uuid();
    db.prepare('INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(id, `test-${id}@example.com`, 'Test User', 'viewer', hashPassword('pass'));

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
    expect(user).toBeDefined();
    expect(user.email).toBe(`test-${id}@example.com`);
    expect(user.role).toBe('viewer');
  });

  it('enforces unique email', () => {
    const db = getDb();
    const email = `unique-${uuid()}@example.com`;
    db.prepare('INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), email, 'User A', 'viewer', hashPassword('pass'));

    expect(() => {
      db.prepare('INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), email, 'User B', 'viewer', hashPassword('pass'));
    }).toThrow();
  });

  it('enforces valid role values', () => {
    const db = getDb();
    expect(() => {
      db.prepare('INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), `bad-${uuid()}@example.com`, 'Bad', 'superadmin', hashPassword('pass'));
    }).toThrow();
  });
});

describe('Trusts and transactions', () => {
  it('creates a trust and records a transaction', () => {
    const db = getDb();
    const trustId = uuid();
    db.prepare('INSERT INTO trusts (id, name, description, balance) VALUES (?, ?, ?, ?)')
      .run(trustId, 'Test Trust', 'A test trust', 100000);

    const txId = uuid();
    db.prepare('INSERT INTO transactions (id, trust_id, type, amount, description) VALUES (?, ?, ?, ?, ?)')
      .run(txId, trustId, 'credit', 100000, 'Initial funding');

    const trust = db.prepare('SELECT * FROM trusts WHERE id = ?').get(trustId) as any;
    expect(trust.balance).toBe(100000);

    const tx = db.prepare('SELECT * FROM transactions WHERE trust_id = ?').all(trustId);
    expect(tx.length).toBe(1);
  });

  it('prevents negative balance on insert', () => {
    const db = getDb();
    expect(() => {
      db.prepare('INSERT INTO trusts (id, name, balance) VALUES (?, ?, ?)')
        .run(uuid(), 'Negative Trust', -1000);
    }).toThrow();
  });
});

describe('Disbursements', () => {
  let trustId: string;
  let userId: string;
  let benId: string;

  beforeEach(() => {
    const db = getDb();
    userId = uuid();
    trustId = uuid();
    benId = uuid();

    db.prepare('INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(userId, `disb-${uuid()}@example.com`, 'Disbursement User', 'trustee', hashPassword('pass'));

    db.prepare('INSERT INTO trusts (id, name, balance) VALUES (?, ?, ?)')
      .run(trustId, `Trust-${trustId}`, 50000);

    db.prepare('INSERT INTO beneficiaries (id, trust_id, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)')
      .run(benId, trustId, 'Test', 'Ben', `ben-${uuid()}@example.com`);
  });

  it('creates a disbursement', () => {
    const db = getDb();
    const disbId = uuid();
    db.prepare(`
      INSERT INTO disbursements (id, trust_id, beneficiary_id, amount, method, status, requested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(disbId, trustId, benId, 1000, 'ach', 'pending', userId);

    const disb = db.prepare('SELECT * FROM disbursements WHERE id = ?').get(disbId) as any;
    expect(disb.amount).toBe(1000);
    expect(disb.status).toBe('pending');
    expect(disb.method).toBe('ach');
  });

  it('enforces positive amount', () => {
    const db = getDb();
    expect(() => {
      db.prepare(`
        INSERT INTO disbursements (id, trust_id, beneficiary_id, amount, method, status, requested_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(uuid(), trustId, benId, -500, 'ach', 'pending', userId);
    }).toThrow();
  });

  it('enforces valid status', () => {
    const db = getDb();
    expect(() => {
      db.prepare(`
        INSERT INTO disbursements (id, trust_id, beneficiary_id, amount, method, status, requested_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(uuid(), trustId, benId, 100, 'ach', 'invalid_status', userId);
    }).toThrow();
  });
});

import { getDb, closeDb } from './index.js';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function seed() {
  const db = getDb();

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
  if (userCount.count > 0) {
    console.log('Database already seeded. Skipping.');
    closeDb();
    return;
  }

  console.log('Seeding database...');

  const adminId = uuid();
  const trusteeId = uuid();
  const beneficiaryUserId = uuid();

  db.prepare(`
    INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)
  `).run(adminId, 'admin@dlbtrust.com', 'Admin User', 'admin', hashPassword('admin123'));

  db.prepare(`
    INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)
  `).run(trusteeId, 'trustee@dlbtrust.com', 'Jane Trustee', 'trustee', hashPassword('trustee123'));

  db.prepare(`
    INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, ?, ?, ?)
  `).run(beneficiaryUserId, 'beneficiary@dlbtrust.com', 'Bob Beneficiary', 'beneficiary', hashPassword('beneficiary123'));

  const trustId = uuid();
  db.prepare(`
    INSERT INTO trusts (id, name, description, balance) VALUES (?, ?, ?, ?)
  `).run(trustId, 'Barkley Family Trust', 'Primary family trust for educational and living expenses', 500000.00);

  db.prepare(`INSERT INTO trust_users (trust_id, user_id, role) VALUES (?, ?, ?)`).run(trustId, trusteeId, 'trustee');
  db.prepare(`INSERT INTO trust_users (trust_id, user_id, role) VALUES (?, ?, ?)`).run(trustId, beneficiaryUserId, 'beneficiary');

  const benId = uuid();
  db.prepare(`
    INSERT INTO beneficiaries (id, trust_id, first_name, last_name, email, phone, address_line1, city, state, zip, account_type, account_number_last4)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(benId, trustId, 'Bob', 'Barkley', 'bob@example.com', '555-0100', '123 Main St', 'Springfield', 'IL', '62701', 'checking', '4567');

  db.prepare(`
    INSERT INTO transactions (id, trust_id, type, amount, description) VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), trustId, 'credit', 500000.00, 'Initial trust funding');

  console.log('Database seeded successfully.');
  console.log('  Admin: admin@dlbtrust.com / admin123');
  console.log('  Trustee: trustee@dlbtrust.com / trustee123');
  console.log('  Beneficiary: beneficiary@dlbtrust.com / beneficiary123');
  closeDb();
}

seed();

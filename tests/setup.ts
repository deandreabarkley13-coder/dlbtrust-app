import { beforeAll, afterAll } from 'vitest';
import { getDb, closeDb } from '../src/server/db/index.js';

// Use in-memory database for tests
process.env.DATABASE_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';

beforeAll(() => {
  getDb();
});

afterAll(() => {
  closeDb();
});

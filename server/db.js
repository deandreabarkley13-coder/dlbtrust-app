'use strict';
const { Pool, types } = require('pg');

// Parse BIGINT (OID 20) as JavaScript Number instead of string.
// Safe for cent-denominated balances (well within Number.MAX_SAFE_INTEGER).
types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
module.exports = pool;

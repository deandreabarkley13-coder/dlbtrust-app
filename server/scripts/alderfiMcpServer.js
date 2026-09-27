#!/usr/bin/env node
'use strict';

/**
 * Alderfi MCP server over stdio — point an MCP client at it exactly as at the
 * Alderfi scaffold (github.com/Earleybeast/mcp):
 *
 *   npx @modelcontextprotocol/inspector node server/scripts/alderfiMcpServer.js
 *
 * or in Claude / Cursor MCP settings:
 *   { "command": "node", "args": ["server/scripts/alderfiMcpServer.js"],
 *     "env": { "DATABASE_URL": "postgres://..." } }
 *
 * Read-only: list_accounts, list_transactions, list_connections,
 * trust_balance_summary, list_journal_entries, aggregator_status.
 * Logs go to stderr so stdout stays a clean JSON-RPC stream.
 */

const { serveStdio } = require('../integrations/aggregator/alderfiMcp');
const pool = require('../integrations/bonds/pgPool');

console.log = (...a) => console.error(...a);

serveStdio()
  .catch((err) => { console.error('alderfiMcpServer failed:', err.message); process.exitCode = 1; })
  .finally(() => pool.end && pool.end().catch(() => {}));

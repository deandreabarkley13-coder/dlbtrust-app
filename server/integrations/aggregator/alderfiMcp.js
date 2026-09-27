'use strict';

/**
 * Alderfi MCP surface — exposes the Banking Aggregator and the unified trust
 * ledger as Model Context Protocol tools, following the Alderfi personal
 * finance platform's contract (Apache-2.0, github.com/Earleybeast/mcp: the app
 * IS an MCP server; `list_accounts` is its first tool). Alderfi clients
 * (Claude, Cursor, the Alderfi web UI, any MCP inspector) read the trust's
 * Betterment / BankSync / Orange Rails feeds and the principal-vs-income GL
 * through these tools.
 *
 * Read-only by design: no tool creates, approves or pushes money. Outbound
 * payments stay behind the maker/checker + PaymentComplianceGate path of
 * BankingAggregator.push and the Private Electronic Payment Network.
 *
 * Transports:
 *   - stdio  (node server/scripts/alderfiMcpServer.js) — newline-delimited
 *     JSON-RPC 2.0, the transport Alderfi's scaffold uses.
 *   - HTTP   (POST /api/aggregator/mcp, admin token) — one JSON-RPC message per
 *     request, for MCP clients configured against the Cloud Run service.
 *
 * Protocol coverage: initialize, notifications/initialized, ping, tools/list,
 * tools/call. Everything else answers -32601 (method not found).
 */

const { BankingAggregator } = require('./bankingAggregator');
const { DataBridge } = require('../accounting/dataBridge');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'alderfi-dlbtrust', version: '1.0.0' };
const MAX_LIMIT = 500;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clampLimit(v, dflt) { const n = parseInt(v, 10); return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : dflt, 1), MAX_LIMIT); }

/** Alderfi account shape: { id, name, institution, type, currency, balance, available_balance, balance_date }. */
function toAlderfiAccount(row, conn) {
  const raw = row.raw || {};
  return {
    id: `${row.connection_id}:${row.external_account_id}`,
    name: row.name || row.external_account_id,
    institution: (conn && conn.name) || raw.org_name || null,
    connector: conn ? conn.connector_type : null,
    type: row.account_type || null,
    currency: row.currency || 'USD',
    balance: num(row.balance_current),
    available_balance: num(row.balance_available),
    balance_date: raw.balance_date || (row.updated_at ? new Date(row.updated_at).toISOString().slice(0, 10) : null),
    mask: row.mask || null,
  };
}

/** Alderfi transaction shape: signed amount (debits negative), plus the trust GL classification. */
function toAlderfiTransaction(row, conn) {
  const amount = num(row.amount);
  const signed = amount == null ? null : (row.direction === 'debit' ? -amount : amount);
  const accounting = (conn && conn.config && conn.config.accounting) || {};
  const cls = DataBridge.classifyAggregatorTxn(row, accounting);
  return {
    id: `${row.connection_id}:${row.external_txn_id}`,
    account_id: `${row.connection_id}:${row.external_account_id}`,
    posted: row.posted_date ? new Date(row.posted_date).toISOString().slice(0, 10) : null,
    amount: signed,
    currency: row.currency || 'USD',
    description: row.description || null,
    category: row.category || null,
    pending: row.status === 'pending',
    trust_classification: cls.classification,
    gl: { debit: cls.debit, credit: cls.credit },
  };
}

async function connectionMap() {
  const conns = await BankingAggregator.listConnections();
  return new Map(conns.map((c) => [c.id, c]));
}

const TOOLS = [
  {
    name: 'list_accounts',
    description: 'List the trust\'s aggregated bank accounts (Betterment Trust Checking and any other linked feed) with current and available balances.',
    inputSchema: {
      type: 'object',
      properties: { connection_id: { type: 'string', description: 'Restrict to one aggregator connection id' } },
      additionalProperties: false,
    },
    async run(args) {
      const conns = await connectionMap();
      const rows = await BankingAggregator.listAccounts(args.connection_id || undefined);
      return { accounts: rows.map((r) => toAlderfiAccount(r, conns.get(r.connection_id))) };
    },
  },
  {
    name: 'list_transactions',
    description: 'List pulled bank transactions (debits negative) with the trust GL classification each one posts under: principal (3000 Trust Corpus), coupon_income (4100), interest_income (4000), fee_income, fee_expense, distribution or operating_expense.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Alderfi account id "<connection_id>:<external_account_id>"' },
        connection_id: { type: 'string' },
        classification: { type: 'string', enum: ['principal', 'coupon_income', 'interest_income', 'fee_income', 'fee_expense', 'distribution', 'operating_expense'] },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 100 },
      },
      additionalProperties: false,
    },
    async run(args) {
      const conns = await connectionMap();
      let connectionId = args.connection_id;
      let accountId;
      if (args.account_id) {
        const i = String(args.account_id).indexOf(':');
        if (i < 0) throw new Error('account_id must be "<connection_id>:<external_account_id>"');
        connectionId = String(args.account_id).slice(0, i);
        accountId = String(args.account_id).slice(i + 1);
      }
      const rows = await BankingAggregator.listTransactions({ connectionId, accountId, limit: clampLimit(args.limit, 100) });
      let out = rows.map((r) => toAlderfiTransaction(r, conns.get(r.connection_id)));
      if (args.classification) out = out.filter((t) => t.trust_classification === args.classification);
      return { transactions: out };
    },
  },
  {
    name: 'list_connections',
    description: 'List aggregator connections (provider, mode live|shadow, handshake state, capabilities). Credentials are never included.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const conns = await BankingAggregator.listConnections();
      return {
        connections: conns.map((c) => ({
          id: c.id, name: c.name, connector: c.connector_type, direction: c.direction, active: c.active,
          mode: c.mode, handshake_state: c.handshake_state, handshake_at: c.handshake_at,
          external_connection_id: c.external_connection_id, capabilities: c.capabilities || null,
        })),
      };
    },
  },
  {
    name: 'trust_balance_summary',
    description: 'Trial balance of the unified trust ledger, separating trust principal/corpus (3000), coupon income (4100) and interest income (4000) from cash and expenses.',
    inputSchema: {
      type: 'object',
      properties: { as_of_date: { type: 'string', description: 'YYYY-MM-DD' } },
      additionalProperties: false,
    },
    async run(args) {
      const tb = await TrustAccountingEngine.getTrialBalance({ asOfDate: args.as_of_date || undefined });
      const rows = Array.isArray(tb) ? tb : (tb && tb.accounts) || [];
      const find = (code) => rows.find((r) => String(r.account_code) === code) || null;
      const bal = (r) => (r ? num(r.current_balance) : null);
      return {
        as_of_date: args.as_of_date || null,
        trust_corpus: bal(find('3000')),
        coupon_income: bal(find('4100')),
        interest_income: bal(find('4000')),
        cash: bal(find('1000')),
        coupon_cash: bal(find('1020')),
        accounts: rows.map((r) => ({
          account_code: r.account_code, account_name: r.account_name, account_type: r.account_type,
          total_debits: num(r.total_debits), total_credits: num(r.total_credits), current_balance: num(r.current_balance),
        })),
      };
    },
  },
  {
    name: 'list_journal_entries',
    description: 'Journal entries DataBridge posted from aggregated bank activity (reference_type aggregator_txn), newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        from_date: { type: 'string' }, to_date: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 },
      },
      additionalProperties: false,
    },
    async run(args) {
      const rows = await TrustAccountingEngine.listJournalEntries({
        fromDate: args.from_date, toDate: args.to_date, referenceType: 'aggregator_txn', limit: clampLimit(args.limit, 50),
      });
      return {
        entries: rows.map((e) => ({
          entry_id: e.entry_id, entry_date: e.entry_date, description: e.description, status: e.status,
          reference_id: e.reference_id, total_debits: num(e.total_debits), total_credits: num(e.total_credits),
        })),
      };
    },
  },
  {
    name: 'aggregator_status',
    description: 'Banking Aggregator health: connections, verified handshakes, counts of accounts/transactions/events and available connectors.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return BankingAggregator.status(); },
  },
];

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: err };
}

function validateArgs(tool, args) {
  const schema = tool.inputSchema;
  const props = schema.properties || {};
  for (const k of Object.keys(args)) {
    if (!props[k]) throw new Error(`Unknown argument "${k}" for ${tool.name}`);
    const p = props[k];
    const v = args[k];
    if (v == null) continue;
    if (p.type === 'string' && typeof v !== 'string') throw new Error(`${k} must be a string`);
    if (p.type === 'integer' && (!Number.isInteger(v))) throw new Error(`${k} must be an integer`);
    if (p.enum && !p.enum.includes(v)) throw new Error(`${k} must be one of ${p.enum.join(', ')}`);
  }
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (no id) that need no reply.
 */
async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  const isNotification = id === undefined;

  try {
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Read-only view of the DeAndrea LaVar Barkley Family Trust bank feeds and trust ledger. No tool moves money.',
        } };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name, description, inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })) } };
      case 'tools/call': {
        const name = params && params.name;
        const tool = TOOL_INDEX.get(name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
        const args = (params && params.arguments && typeof params.arguments === 'object') ? params.arguments : {};
        try {
          validateArgs(tool, args);
          const result = await tool.run(args);
          return { jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          } };
        } catch (err) {
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err.message }], isError: true } };
        }
      }
      default:
        return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, -32603, err.message);
  }
}

/** Serve MCP over stdio (newline-delimited JSON-RPC). Resolves when stdin closes. */
function serveStdio(input = process.stdin, output = process.stdout) {
  return new Promise((resolve) => {
    let buf = '';
    const inflight = new Set();
    const write = (obj) => { if (obj) output.write(JSON.stringify(obj) + '\n'); };
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { write(rpcError(null, -32700, 'Parse error')); continue; }
        const p = handleMessage(msg).then(write);
        inflight.add(p);
        p.finally(() => inflight.delete(p));
      }
    });
    input.on('end', () => Promise.all(inflight).then(resolve));
  });
}

module.exports = { handleMessage, serveStdio, TOOLS, SERVER_INFO, PROTOCOL_VERSION, toAlderfiAccount, toAlderfiTransaction };

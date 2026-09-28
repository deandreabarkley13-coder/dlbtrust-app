import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { ClearingAgentNetworkEndpoint, verifyRequest } = require('../server/integrations/os/clearingAgentNetworkEndpoint');
const { hmac } = require('../server/integrations/os/clearingAgentOsEngine');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const SECRET = 'family-ppn-shared-credential';
const AGENT = 'DLB-TRUST-CLEARING-AGENT';
const PATH = '/api/os/private-payment-network/agent/clear';

function sha256(x: string | Buffer) { return crypto.createHash('sha256').update(x).digest('hex'); }
function sign(method: string, path: string, body: string, opts: { agent?: string; secret?: string; ts?: number } = {}) {
  const ts = opts.ts ?? Date.now();
  const bodyHash = sha256(body);
  return {
    'x-clearing-agent-id': opts.agent ?? AGENT,
    'x-clearing-agent-ts': String(ts),
    'x-clearing-agent-body-sha256': bodyHash,
    'x-clearing-agent-signature': hmac(opts.secret ?? SECRET, opts.agent ?? AGENT, method, path, String(ts), bodyHash),
  };
}

function memPool() {
  const receipts = new Map<string, any>();
  const events: any[] = [];
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any[] = []) => {
    const s = String(sql).trim();
    if (/INSERT INTO ppn_agent_events/.test(s)) { events.push({ type: params[0], detail: params[3] }); return { rows: [] }; }
    if (/SELECT reference, body_sha256, status FROM ppn_agent_clearing_receipts/.test(s)) { const r = receipts.get(params[0]); return { rows: r ? [r] : [] }; }
    if (/INSERT INTO ppn_agent_clearing_receipts/.test(s)) {
      const [reference, idempotency_key, agent_id, format, content_type, body_sha256, body_bytes] = params;
      receipts.set(idempotency_key, { reference, idempotency_key, agent_id, format, content_type, body_sha256, body_bytes, status: 'accepted' });
      return { rows: [] };
    }
    if (/COUNT\(\*\)/.test(s)) return { rows: [{ n: receipts.size }] };
    return { rows: [] };
  });
  return { receipts, events };
}

describe('Clearing Agent participant endpoint (family PPN side)', () => {
  let db: ReturnType<typeof memPool>;
  beforeEach(() => {
    process.env.PRIVATE_PAYMENT_NETWORK_AGENT_SECRET = SECRET;
    process.env.CLEARING_AGENT_ID = AGENT;
    process.env.PRIVATE_PAYMENT_NETWORK_AGENT_NETWORK_ID = 'PPN-FAMILY';
    db = memPool();
  });
  afterEach(() => { vi.restoreAllMocks(); process.env = { ...saved }; });

  it('verifies the agent request signature and refuses stale, foreign or tampered requests', () => {
    const body = 'hello';
    expect(verifyRequest({ headers: sign('POST', PATH, body), method: 'POST', path: PATH, body }).agentId).toBe(AGENT);
    expect(() => verifyRequest({ headers: sign('POST', PATH, body, { agent: 'SOMEONE-ELSE' }), method: 'POST', path: PATH, body })).toThrow(/not admitted/);
    expect(() => verifyRequest({ headers: sign('POST', PATH, body, { ts: Date.now() - 10 * 60 * 1000 }), method: 'POST', path: PATH, body })).toThrow(/timestamp/);
    expect(() => verifyRequest({ headers: sign('POST', PATH, body, { secret: 'wrong' }), method: 'POST', path: PATH, body })).toThrow(/did not verify/);
    expect(() => verifyRequest({ headers: sign('POST', PATH, body), method: 'POST', path: PATH, body: 'tampered' })).toThrow(/did not verify/);
    delete process.env.PRIVATE_PAYMENT_NETWORK_AGENT_SECRET;
    expect(() => verifyRequest({ headers: sign('POST', PATH, body), method: 'POST', path: PATH, body })).toThrow(/not mounted/);
  });

  it('answers the handshake with the mutual HMAC ack and never echoes the secret', async () => {
    const nonce = crypto.randomBytes(32).toString('hex');
    const p = '/api/os/private-payment-network/agent/handshake';
    const payload = { agentId: AGENT, networkId: 'PPN-FAMILY', nonce, signature: hmac(SECRET, AGENT, 'PPN-FAMILY', nonce) };
    const rawBody = JSON.stringify(payload);
    const out = await ClearingAgentNetworkEndpoint.handshake({ headers: sign('POST', p, rawBody), path: p, rawBody, payload });
    expect(out.signature).toBe(hmac(SECRET, 'PPN-FAMILY', AGENT, nonce, 'ack'));
    expect(out.capabilities.country).toBe('US');
    expect(out.capabilities.familyOnly).toBe(true);
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(db.events)).not.toContain(SECRET);

    const bad = { ...payload, signature: hmac('other', AGENT, 'PPN-FAMILY', nonce) };
    const badRaw = JSON.stringify(bad);
    await expect(ClearingAgentNetworkEndpoint.handshake({ headers: sign('POST', p, badRaw), path: p, rawBody: badRaw, payload: bad })).rejects.toThrow(/did not verify/);
    const wrongNet = { ...payload, networkId: 'PPN-OTHER' };
    const wrongRaw = JSON.stringify(wrongNet);
    await expect(ClearingAgentNetworkEndpoint.handshake({ headers: sign('POST', p, wrongRaw), path: p, rawBody: wrongRaw, payload: wrongNet })).rejects.toThrow(/networkId/);
  });

  it('receipts a bank-format message idempotently and refuses key reuse with a different body', async () => {
    const body = '101 021000021 0110000152609271200A094101FAMILY PPN             DLB TRUST              ';
    const headers = { ...sign('POST', PATH, body), 'x-clearing-format': 'nacha', 'x-idempotency-key': 'DIST-1', 'content-type': 'text/plain' };
    const a = await ClearingAgentNetworkEndpoint.clear({ headers, path: PATH, rawBody: Buffer.from(body) });
    expect(a.status).toBe('accepted');
    expect(a.idempotent).toBe(false);
    expect(a.reference).toMatch(/^PPNCLR-/);
    const b = await ClearingAgentNetworkEndpoint.clear({ headers, path: PATH, rawBody: Buffer.from(body) });
    expect(b).toEqual({ reference: a.reference, status: 'accepted', idempotent: true });

    const other = body.replace('DLB TRUST', 'XX  TRUST');
    const h2 = { ...sign('POST', PATH, other), 'x-clearing-format': 'nacha', 'x-idempotency-key': 'DIST-1' };
    await expect(ClearingAgentNetworkEndpoint.clear({ headers: h2, path: PATH, rawBody: Buffer.from(other) })).rejects.toThrow(/different message/);

    const h3 = { ...sign('POST', PATH, body), 'x-clearing-format': 'swift_mt103', 'x-idempotency-key': 'DIST-2' };
    await expect(ClearingAgentNetworkEndpoint.clear({ headers: h3, path: PATH, rawBody: Buffer.from(body) })).rejects.toThrow(/X-Clearing-Format/);
    expect(db.receipts.size).toBe(1);
  });

  it('reports the missing secret / base URL as readiness blockers', async () => {
    delete process.env.PRIVATE_PAYMENT_NETWORK_AGENT_SECRET;
    const s = await ClearingAgentNetworkEndpoint.status();
    expect(s.secretConfigured).toBe(false);
    expect(s.blockers.join(' ')).toMatch(/AGENT_SECRET not mounted/);
    expect(s.blockers.join(' ')).toMatch(/AGENT_BASE_URL not set/);
    process.env.PRIVATE_PAYMENT_NETWORK_AGENT_SECRET = SECRET;
    process.env.PRIVATE_PAYMENT_NETWORK_AGENT_BASE_URL = 'https://dlbtrust-app.example.run.app/api/os/private-payment-network/agent';
    expect((await ClearingAgentNetworkEndpoint.status()).blockers).toEqual([]);
  });
});

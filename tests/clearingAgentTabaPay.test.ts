import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import https from 'https';

const require = createRequire(import.meta.url);
const { ClearingAgentOsEngine, canonicalize, convert } = require('../server/integrations/os/clearingAgentOsEngine');
const TabaPay = require('../server/integrations/os/clearingAgentTabaPayAdapter');
const { EgressOsEngine } = require('../server/integrations/os/egressOsEngine');
const { getEgressConfig } = require('../server/integrations/os/egressOsEngine');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const BEARER = 'tabapay-bearer-key-value-never-logged';
const CLIENT_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const SETTLEMENT = 'Z1y2X3w4V5u6T7s8R9q0Pa';
const BASE = 'https://api.sandbox.tabapay.test:10443';

const IX = {
  amountCents: 125000,
  purpose: 'Beneficiary income support',
  endToEndId: 'DIST-2026-0001',
  speed: 'same_day',
  debtor: { name: 'DEANDREA LAVAR BARKLEY TRUST', routingNumber: '021000021', accountNumber: '000000002', fineractAccountId: '2' },
  creditor: { name: 'Jeremy N Robinson', routingNumber: '011000015', accountNumber: '9876543210', accountType: 'savings', participantId: 'CRM-BEN-1' },
};

function memPool() {
  const nets = new Map<string, any>();
  const ixs = new Map<string, any>();
  const events: any[] = [];
  const apply = (row: any, sql: string, params: any[]) => {
    for (const [, col, idx] of sql.matchAll(/(\w+) = \$(\d+)/g)) {
      let v = params[Number(idx) - 1];
      if (col === 'capabilities') v = JSON.parse(v);
      row[col] = v;
    }
    return row;
  };
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any[] = []) => {
    const s = String(sql).trim();
    if (/INSERT INTO clearing_agent_events/.test(s)) { events.push({ type: params[3], actor: params[4], detail: params[5] }); return { rows: [] }; }
    if (/INSERT INTO clearing_agent_networks/.test(s)) {
      const [network_id, name, kind, base_url, format, credential_ref, credential_fingerprint, capabilities, registered_by] = params;
      nets.set(network_id, { network_id, name, kind, country: 'US', base_url, format, credential_ref, credential_fingerprint, handshake_state: 'registered', capabilities: JSON.parse(capabilities), registered_by, created_at: new Date() });
      return { rows: [] };
    }
    if (/^SELECT \* FROM clearing_agent_networks WHERE network_id/.test(s)) { const n = nets.get(params[0]); return { rows: n ? [n] : [] }; }
    if (/^SELECT \* FROM clearing_agent_networks ORDER/.test(s)) return { rows: [...nets.values()] };
    if (/^UPDATE clearing_agent_networks/.test(s)) return { rows: [apply(nets.get(params[0]), s, params)] };
    if (/INSERT INTO clearing_agent_instructions/.test(s)) {
      const cols = s.match(/\(([^)]+)\)\s*VALUES/)![1].split(',').map((c) => c.trim());
      const vals = s.match(/VALUES\s*\((.+)\)/s)![1].split(',').map((v) => v.trim());
      const row: any = {};
      cols.forEach((c, i) => { const v = vals[i]; row[c] = v.startsWith('$') ? params[Number(v.slice(1)) - 1] : v.replace(/'/g, ''); });
      row.created_at = new Date();
      ixs.set(row.instruction_id, row);
      return { rows: [] };
    }
    if (/FROM clearing_agent_instructions WHERE idempotency_key/.test(s)) { const r = [...ixs.values()].find((x) => x.idempotency_key === params[0]); return { rows: r ? [r] : [] }; }
    if (/FROM clearing_agent_instructions WHERE instruction_id/.test(s)) { const r = ixs.get(params[0]); return { rows: r ? [r] : [] }; }
    if (/^UPDATE clearing_agent_instructions/.test(s)) return { rows: [apply(ixs.get(params[0]), s, params)] };
    if (/GROUP BY status/.test(s)) return { rows: [] };
    if (/FROM clearing_agent_instructions ORDER/.test(s)) return { rows: [...ixs.values()] };
    return { rows: [] };
  });
  return { nets, ixs, events };
}

/** Fake TabaPay: Retrieve Client + Create Transaction, bearer-checked. */
function mockTabaPay(opts: { clientStatus?: number; txStatus?: number; txBody?: any } = {}) {
  const calls: any[] = [];
  vi.spyOn(https, 'request').mockImplementation(((options: any, cb: any) => {
    const chunks: Buffer[] = [];
    const req: any = {
      on() { return req; },
      destroy() {},
      end(data?: Buffer) {
        if (data) chunks.push(data);
        const body = Buffer.concat(chunks).toString('utf8');
        calls.push({ method: options.method, port: options.port, path: options.path, headers: options.headers, body });
        let status = 200;
        let out: any = {};
        if (options.headers.Authorization !== `Bearer ${BEARER}`) { status = 401; out = { SC: 401, EC: '0' }; }
        else if (options.method === 'GET' && options.path === `/v1/clients/${CLIENT_ID}`) {
          status = opts.clientStatus || 200;
          out = status === 200 ? { SC: 200, EC: '0', referenceID: 'x', status: 'ACTIVE', name: 'DLB Trust' } : { SC: status, EC: '3C4' };
        } else if (options.method === 'POST' && options.path === `/v1/clients/${CLIENT_ID}/transactions`) {
          status = opts.txStatus || 200;
          out = opts.txBody || { SC: 200, EC: '0', transactionID: 'TX1234567890abcdef', network: 'RTP', networkRC: '00', status: 'COMPLETED', approvalCode: '123456' };
        } else { status = 404; out = { SC: 404 }; }
        const listeners: Record<string, any> = {};
        const res: any = { statusCode: status, on(ev: string, fn: any) { listeners[ev] = fn; if (ev === 'end') { listeners.data(Buffer.from(JSON.stringify(out))); fn(); } return res; } };
        cb(res);
      },
    };
    return req;
  }) as any);
  return calls;
}

const CAPS = { adapter: 'tabapay', clientId: CLIENT_ID, settlementAccountId: SETTLEMENT };

async function register(extra: any = {}) {
  return ClearingAgentOsEngine.register({ networkId: 'TABAPAY', name: 'TabaPay', kind: 'ach_operator', baseUrl: BASE, format: 'tabapay_json', credentialRef: 'TABAPAY_BEARER_TOKEN', capabilities: CAPS, actor: 'malissa.robinson', ...extra });
}

describe('TabaPay adapter — pure conversion', () => {
  it('validates the 22-character ClientID / settlement AccountID', () => {
    expect(TabaPay.adapterConfig({ capabilities: CAPS })).toEqual({ clientId: CLIENT_ID, settlementAccountId: SETTLEMENT, subClientId: null });
    expect(() => TabaPay.adapterConfig({ capabilities: { ...CAPS, clientId: 'short' } })).toThrow(/22-character TabaPay ClientID/);
    expect(() => TabaPay.adapterConfig({ capabilities: { ...CAPS, settlementAccountId: '' } })).toThrow(/settlement AccountID/);
    expect(TabaPay.isTabaPay({ capabilities: CAPS })).toBe(true);
    expect(TabaPay.isTabaPay({ capabilities: { iapAudience: 'x' } })).toBe(false);
  });

  it('builds a push transaction: settlement source, creditor bank destination, USD 840, two-decimal amount, speed → achOptions, deterministic 15-char referenceID', () => {
    const ix = canonicalize(IX);
    const tx = TabaPay.toTransaction(ix, { settlementAccountId: SETTLEMENT, idempotencyKey: 'k1' });
    expect(tx.type).toBe('push');
    expect(tx.currency).toBe('840');
    expect(tx.amount).toBe('1250.00');
    expect(tx.accounts.sourceAccountID).toBe(SETTLEMENT);
    expect(tx.accounts.destinationAccount.bank).toEqual({ routingNumber: '011000015', accountNumber: '9876543210', accountType: 'S' });
    expect(tx.accounts.destinationAccount.owner.name).toEqual({ first: 'Jeremy', middle: 'N', last: 'Robinson' });
    expect(tx.achOptions).toBe('S');
    expect(tx.achEntryType).toBe('PPD');
    expect(tx.referenceID).toMatch(/^[A-Za-z0-9]{15}$/);
    expect(tx.referenceID).toBe(TabaPay.referenceId('k1'));
    expect(TabaPay.referenceId('k2')).not.toBe(tx.referenceID);
    expect(TabaPay.toTransaction(canonicalize({ ...IX, speed: 'instant' }), { settlementAccountId: SETTLEMENT, idempotencyKey: 'k' }).achOptions).toBe('R');
    expect(TabaPay.toTransaction(canonicalize({ ...IX, speed: undefined }), { settlementAccountId: SETTLEMENT, idempotencyKey: 'k' }).achOptions).toBe('N');
    expect(convert(ix, 'tabapay_json', 'AGENT', { network: { capabilities: CAPS }, idempotencyKey: 'k1' }).body).toBe(JSON.stringify(tx));
    expect(() => convert(ix, 'tabapay_json', 'AGENT', { network: { capabilities: { ...CAPS, clientId: 'bad' } }, idempotencyKey: 'k1' })).toThrow(/ClientID/);
  });

  it('Egress OS derives the TabaPay host only when TABAPAY_BASE_URL is configured', () => {
    expect(getEgressConfig({}).allowedHosts).not.toContain('api.sandbox.tabapay.test');
    expect(getEgressConfig({ TABAPAY_BASE_URL: BASE }).allowedHosts).toContain('api.sandbox.tabapay.test');
  });
});

describe('TabaPay adapter — register, handshake, clear', () => {
  beforeEach(() => {
    process.env.TABAPAY_BEARER_TOKEN = BEARER;
    process.env.CLEARING_AGENT_LIVE = 'true';
    process.env.FINERACT_URL = 'https://fineract.internal/api/v1';
    process.env.FINERACT_USERNAME = 'mifos';
    process.env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY = 'true';
    vi.spyOn(EgressOsEngine, 'authorize').mockResolvedValue({ allowed: true, enforced: true, host: 'api.sandbox.tabapay.test', reason: 'allowed' });
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('registers only with adapter=tabapay + tabapay_json + valid ids; the bearer key is never stored or returned', async () => {
    const { nets, events } = memPool();
    await expect(register({ format: 'nacha' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_BAD_FORMAT' });
    await expect(register({ capabilities: {} })).rejects.toMatchObject({ code: 'CLEARING_AGENT_BAD_FORMAT' });
    await expect(register({ capabilities: { ...CAPS, settlementAccountId: 'nope' } })).rejects.toMatchObject({ code: 'CLEARING_AGENT_BAD_REQUEST' });
    await expect(register({ credentialRef: 'TABAPAY_MISSING' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_NO_CREDENTIAL' });
    const n = await register();
    expect(n.credential).toBe('***');
    expect(n.credential_ref).toBe('TABAPAY_BEARER_TOKEN');
    expect(n.capabilities).toEqual(CAPS);
    expect(n.handshake_state).toBe('registered');
    expect(JSON.stringify([...nets.values()])).not.toContain(BEARER);
    expect(JSON.stringify(events)).not.toContain(BEARER);
  });

  it('verify = authenticated Retrieve Client by a distinct checker; no money moves, no secret on the wire besides the Authorization header', async () => {
    const { nets, events } = memPool();
    const calls = mockTabaPay();
    await register();
    await ClearingAgentOsEngine.challenge({ networkId: 'TABAPAY', actor: 'malissa.robinson' });
    await expect(ClearingAgentOsEngine.verify({ networkId: 'TABAPAY', actor: 'malissa.robinson' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_SAME_ACTOR' });
    const v = await ClearingAgentOsEngine.verify({ networkId: 'TABAPAY', actor: 'deandreabarkley13@gmail.com' });
    expect(v.handshake_state).toBe('verified');
    expect(v.verified_by).toBe('deandreabarkley13@gmail.com');
    expect(v.capabilities).toMatchObject({ adapter: 'tabapay', clientId: CLIENT_ID, settlementAccountId: SETTLEMENT, clientStatus: 'ACTIVE', rails: ['ach_standard', 'ach_same_day', 'rtp'], country: 'US', currency: 'USD' });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].port).toBe('10443');
    expect(calls[0].path).toBe(`/v1/clients/${CLIENT_ID}`);
    expect(calls[0].body).toBe('');
    expect(JSON.stringify([...nets.values()])).not.toContain(BEARER);
    expect(JSON.stringify(events)).not.toContain(BEARER);
    expect(events.map((e) => e.type)).toEqual(['clearing_agent.registered', 'clearing_agent.challenged', 'clearing_agent.verified']);
  });

  it('handshake fails closed on a non-200 Retrieve Client (bad key / wrong ClientID)', async () => {
    const { nets } = memPool();
    mockTabaPay({ clientStatus: 401 });
    await register();
    await ClearingAgentOsEngine.challenge({ networkId: 'TABAPAY', actor: 'malissa.robinson' });
    await expect(ClearingAgentOsEngine.verify({ networkId: 'TABAPAY', actor: 'deandreabarkley13@gmail.com' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_HANDSHAKE' });
    expect(nets.get('TABAPAY').handshake_state).toBe('failed');
    expect(nets.get('TABAPAY').last_error).toMatch(/HTTP 401 SC 401/);
    expect(JSON.stringify([...nets.values()])).not.toContain(BEARER);
  });

  it('submit posts a push transaction, records the transactionID, is idempotent, then Fineract withdraws once', async () => {
    const { events } = memPool();
    const calls = mockTabaPay();
    const w = vi.spyOn(FineractClient, 'withdrawSavings').mockResolvedValue({ resourceId: 901 });
    await register();
    await ClearingAgentOsEngine.challenge({ networkId: 'TABAPAY', actor: 'malissa.robinson' });
    await ClearingAgentOsEngine.verify({ networkId: 'TABAPAY', actor: 'deandreabarkley13@gmail.com' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    const s1 = await ClearingAgentOsEngine.submit({ networkId: 'TABAPAY', instruction: IX, idempotencyKey: 'k1', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'deandreabarkley13@gmail.com' });
    expect(s1.status).toBe('cleared');
    expect(s1.network_ref).toBe('TX1234567890abcdef');
    expect(s1.format).toBe('tabapay_json');
    const post = calls.find((c) => c.method === 'POST');
    expect(post.path).toBe(`/v1/clients/${CLIENT_ID}/transactions`);
    const body = JSON.parse(post.body);
    expect(body).toMatchObject({ type: 'push', currency: '840', amount: '1250.00', achOptions: 'S', achEntryType: 'PPD', referenceID: TabaPay.referenceId('k1') });
    expect(body.accounts.sourceAccountID).toBe(SETTLEMENT);
    expect(post.body).not.toContain(BEARER);

    const s2 = await ClearingAgentOsEngine.submit({ networkId: 'TABAPAY', instruction: IX, idempotencyKey: 'k1', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'deandreabarkley13@gmail.com' });
    expect(s2.idempotent).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);

    const p = await ClearingAgentOsEngine.post({ instructionId: s1.instruction_id, actor: 'deandreabarkley13@gmail.com' });
    expect(p.status).toBe('posted');
    expect(w).toHaveBeenCalledWith(expect.objectContaining({ accountId: '2', amount: 1250 }));
    expect(w).toHaveBeenCalledTimes(1);
    const cleared = events.find((e) => e.type === 'clearing_agent.cleared');
    expect(JSON.parse(cleared.detail)).toMatchObject({ adapter: 'tabapay', networkRef: 'TX1234567890abcdef', tabapayStatus: 'COMPLETED' });
    expect(JSON.stringify(events)).not.toContain(BEARER);
    expect(JSON.stringify(events)).not.toContain('9876543210');
  });

  it('207 / ERROR responses reject the instruction and never post', async () => {
    memPool();
    mockTabaPay({ txStatus: 207, txBody: { SC: 207, EC: '0', transactionID: 'TXunknown', status: 'UNKNOWN' } });
    const w = vi.spyOn(FineractClient, 'withdrawSavings').mockResolvedValue({ resourceId: 901 });
    await register();
    await ClearingAgentOsEngine.challenge({ networkId: 'TABAPAY', actor: 'malissa.robinson' });
    await ClearingAgentOsEngine.verify({ networkId: 'TABAPAY', actor: 'deandreabarkley13@gmail.com' });
    const s = await ClearingAgentOsEngine.submit({ networkId: 'TABAPAY', instruction: IX, idempotencyKey: 'k207', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'deandreabarkley13@gmail.com' });
    expect(s.status).toBe('rejected');
    expect(s.error).toMatch(/UNKNOWN HTTP 207/);
    await expect(ClearingAgentOsEngine.post({ instructionId: s.instruction_id, actor: 'x' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_STATE' });
    expect(w).not.toHaveBeenCalled();
  });

  it('shadow mode converts but never calls TabaPay', async () => {
    memPool();
    const calls = mockTabaPay();
    await register();
    await ClearingAgentOsEngine.challenge({ networkId: 'TABAPAY', actor: 'malissa.robinson' });
    await ClearingAgentOsEngine.verify({ networkId: 'TABAPAY', actor: 'deandreabarkley13@gmail.com' });
    process.env.CLEARING_AGENT_LIVE = 'false';
    const s = await ClearingAgentOsEngine.submit({ networkId: 'TABAPAY', instruction: IX, idempotencyKey: 'kS', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'deandreabarkley13@gmail.com' });
    expect(s.shadow).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

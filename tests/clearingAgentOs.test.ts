import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import https from 'https';

const require = createRequire(import.meta.url);
const { ClearingAgentOsEngine, canonicalize, convert, redactPayload, hmac, FORMATS } = require('../server/integrations/os/clearingAgentOsEngine');
const { EgressOsEngine } = require('../server/integrations/os/egressOsEngine');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');
const pool = require('../server/integrations/bonds/pgPool');

const saved = { ...process.env };
const SECRET = 'ppn-shared-secret-value-never-logged';
const AGENT = 'DLB-TRUST-CLEARING-AGENT';

const IX = {
  amountCents: 125000,
  purpose: 'Beneficiary income support',
  endToEndId: 'DIST-2026-0001',
  debtor: { name: 'DEANDREA LAVAR BARKLEY TRUST', routingNumber: '021000021', accountNumber: '000000002', fineractAccountId: '4' },
  creditor: { name: 'Jeremy N Robinson', routingNumber: '011000015', accountNumber: '9876543210', accountType: 'savings', participantId: 'CRM-BEN-1', fineractAccountId: '5' },
};

/** In-memory Cloud SQL for the three clearing_agent tables. */
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

/** Fake PPN counterparty: answers /handshake with the mutual HMAC ack and /clear with a reference. */
function mockNetwork(opts: { badSig?: boolean; clearStatus?: number } = {}) {
  const calls: any[] = [];
  vi.spyOn(https, 'request').mockImplementation(((options: any, cb: any) => {
    const chunks: Buffer[] = [];
    const req: any = {
      on() { return req; },
      destroy() {},
      end(data: Buffer) {
        chunks.push(data);
        const body = Buffer.concat(chunks).toString('utf8');
        calls.push({ path: options.path, headers: options.headers, body });
        let status = 200;
        let out: any = {};
        if (options.path === '/ppn/handshake') {
          const j = JSON.parse(body);
          const mine = hmac(SECRET, j.agentId, j.networkId, j.nonce);
          if (mine !== j.signature) status = 401;
          out = { signature: opts.badSig ? 'nope' : hmac(SECRET, j.networkId, j.agentId, j.nonce, 'ack'), capabilities: { instant: true, apiKey: 'should-be-redacted' } };
        } else if (options.path === '/ppn/clear') {
          status = opts.clearStatus || 200;
          out = { reference: 'PPN-REF-77' };
        }
        const listeners: Record<string, any> = {};
        const res: any = { statusCode: status, on(ev: string, fn: any) { listeners[ev] = fn; if (ev === 'end') { listeners.data(Buffer.from(JSON.stringify(out))); fn(); } return res; } };
        cb(res);
      },
    };
    return req;
  }) as any);
  return calls;
}

async function registerAndVerify() {
  const n = await ClearingAgentOsEngine.register({ networkId: 'ppn-family', name: 'Family PPN', baseUrl: 'https://ppn.dlbtrust.internal/ppn', format: 'iso20022_pacs008', credentialRef: 'PPN_FAMILY_SHARED_SECRET', actor: 'trustee.a@f' });
  await ClearingAgentOsEngine.challenge({ networkId: n.network_id, actor: 'trustee.a@f' });
  return ClearingAgentOsEngine.verify({ networkId: n.network_id, actor: 'trustee.b@f' });
}

describe('Clearing Agent OS — USA-only format conversion (pure)', () => {
  it('canonicalizes and validates ABA routing / US / USD', () => {
    const ix = canonicalize(IX);
    expect(ix.amount).toBe('1250.00');
    expect(ix.debtor.routingNumber).toBe('021000021');
    expect(() => canonicalize({ ...IX, currency: 'EUR' })).toThrow(/USD only/);
    expect(() => canonicalize({ ...IX, creditor: { ...IX.creditor, country: 'CA' } })).toThrow(/USA-only/);
    expect(() => canonicalize({ ...IX, creditor: { ...IX.creditor, routingNumber: '123456789' } })).toThrow(/ABA/);
    expect(() => canonicalize({ ...IX, amountCents: 0 })).toThrow(/positive/);
  });

  it('converts to every supported format with the same amount and end-to-end id', () => {
    const ix = canonicalize(IX);
    expect(FORMATS).toEqual(['nacha', 'iso20022_pain001', 'iso20022_pacs008', 'fednow', 'rtp', 'bai2']);
    const nachaOut = convert(ix, 'nacha', AGENT).body;
    const lines = nachaOut.split(/\r?\n/).filter(Boolean);
    expect(lines.every((l: string) => l.length === 94)).toBe(true);
    expect(lines.find((l: string) => l.startsWith('6'))).toMatch(/^632011000015?/);
    expect(nachaOut).toMatch(/0000125000/);
    const pain = convert(ix, 'iso20022_pain001', AGENT).body;
    expect(pain).toMatch(/pain\.001\.001\.09/);
    expect(pain).toMatch(/<InstdAmt Ccy="USD">1250\.00<\/InstdAmt>/);
    expect(pain).toMatch(/<Cd>USABA<\/Cd><\/ClrSysId><MmbId>011000015<\/MmbId>/);
    const pacs = convert(ix, 'iso20022_pacs008', AGENT).body;
    expect(pacs).toMatch(/pacs\.008\.001\.08/);
    expect(pacs).toMatch(/<EndToEndId>DIST-2026-0001<\/EndToEndId>/);
    const fed = JSON.parse(convert(ix, 'fednow', AGENT).body);
    expect(fed.groupHeader.clearingSystem).toBe('FDN');
    expect(fed.creditTransfer.interbankSettlementAmount).toEqual({ currency: 'USD', amount: '1250.00' });
    expect(JSON.parse(convert(ix, 'rtp', AGENT).body).groupHeader.clearingSystem).toBe('TCH');
    const bai = convert(ix, 'bai2', AGENT).body;
    expect(bai).toMatch(/^01,021000021/);
    expect(bai).toMatch(/\n16,195,125000,Z,DIST-2026-0001/);
    expect(bai).toMatch(/\n99,/);
    expect(() => convert(ix, 'swift_mt103', AGENT)).toThrow(/format must be/);
  });

  it('redacts secrets and full account numbers before anything is emitted', () => {
    const r = redactPayload({ apiKey: 'k', nested: { signature: 's', accountNumber: '123456789012', name: 'ok' } });
    expect(r).toEqual({ apiKey: '***', nested: { signature: '***', accountNumber: '********9012', name: 'ok' } });
  });
});

describe('Clearing Agent OS — handshake, clear, post', () => {
  beforeEach(() => {
    process.env.PPN_FAMILY_SHARED_SECRET = SECRET;
    process.env.CLEARING_AGENT_LIVE = 'true';
    process.env.FINERACT_URL = 'https://fineract.internal/api/v1';
    process.env.FINERACT_USERNAME = 'mifos';
    process.env.PRIVATE_PAYMENT_NETWORK_FAMILY_ONLY = 'true';
    vi.spyOn(EgressOsEngine, 'authorize').mockResolvedValue({ allowed: true, enforced: true, host: 'ppn.dlbtrust.internal', reason: 'allowed' });
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('registers with a Secret Manager reference only, refuses missing secrets / non-https / non-US', async () => {
    const { nets, events } = memPool();
    await expect(ClearingAgentOsEngine.register({ name: 'Net X', baseUrl: 'https://x.internal', format: 'nacha', credentialRef: 'MISSING_REF', actor: 'a' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_NO_CREDENTIAL' });
    await expect(ClearingAgentOsEngine.register({ name: 'Net X', baseUrl: 'http://x.internal', format: 'nacha', credentialRef: 'PPN_FAMILY_SHARED_SECRET', actor: 'a' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_INSECURE' });
    await expect(ClearingAgentOsEngine.register({ name: 'Net X', baseUrl: 'https://x.internal', format: 'nacha', credentialRef: 'PPN_FAMILY_SHARED_SECRET', country: 'GB', actor: 'a' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_NON_US' });
    const n = await ClearingAgentOsEngine.register({ networkId: 'ppn-family', name: 'Family PPN', baseUrl: 'https://ppn.dlbtrust.internal/ppn', format: 'nacha', credentialRef: 'PPN_FAMILY_SHARED_SECRET', actor: 'trustee.a@f' });
    expect(n.credential).toBe('***');
    expect(n.credential_ref).toBe('PPN_FAMILY_SHARED_SECRET');
    expect(n.credential_configured).toBe(true);
    expect(n.handshake_state).toBe('registered');
    expect(JSON.stringify([...nets.values()])).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('challenge/verify: mutual HMAC proof, distinct verifier, capabilities redacted, secret never on the wire', async () => {
    const { nets, events } = memPool();
    const calls = mockNetwork();
    const n = await ClearingAgentOsEngine.register({ networkId: 'ppn-family', name: 'Family PPN', baseUrl: 'https://ppn.dlbtrust.internal/ppn', format: 'iso20022_pacs008', credentialRef: 'PPN_FAMILY_SHARED_SECRET', actor: 'trustee.a@f' });
    await expect(ClearingAgentOsEngine.verify({ networkId: 'ppn-family', actor: 'trustee.b@f' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_STATE' });
    const c = await ClearingAgentOsEngine.challenge({ networkId: n.network_id, actor: 'trustee.a@f' });
    expect(c.nonce).toMatch(/^[a-f0-9]{64}$/);
    await expect(ClearingAgentOsEngine.verify({ networkId: 'ppn-family', actor: 'TRUSTEE.A@f' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_SAME_ACTOR' });
    const v = await ClearingAgentOsEngine.verify({ networkId: 'ppn-family', actor: 'trustee.b@f' });
    expect(v.handshake_state).toBe('verified');
    expect(v.verified_by).toBe('trustee.b@f');
    expect(v.capabilities).toEqual({ instant: true, apiKey: '***' });
    expect(v.handshake_nonce).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/ppn/handshake');
    expect(calls[0].headers['X-Clearing-Agent-Signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0].body).not.toContain(SECRET);
    expect(JSON.stringify(calls[0].headers)).not.toContain(SECRET);
    expect(JSON.stringify([...nets.values()])).not.toContain(SECRET);
    expect(events.map((e) => e.type)).toEqual(['clearing_agent.registered', 'clearing_agent.challenged', 'clearing_agent.verified']);
  });

  it('handshake fails closed when the network cannot prove possession of the credential', async () => {
    memPool();
    mockNetwork({ badSig: true });
    await expect(registerAndVerify()).rejects.toMatchObject({ code: 'CLEARING_AGENT_HANDSHAKE' });
    const n = await ClearingAgentOsEngine.get('ppn-family');
    expect(n.handshake_state).toBe('failed');
    expect(n.last_error).toMatch(/signature did not verify/);
  });

  it('submit requires approval + screening + verified network, is idempotent, clears, then posts to Fineract once', async () => {
    const { events } = memPool();
    const calls = mockNetwork();
    const w = vi.spyOn(FineractClient, 'withdrawSavings').mockResolvedValue({ resourceId: 901 });
    const d = vi.spyOn(FineractClient, 'depositSavings').mockResolvedValue({ resourceId: 902 });

    await expect(ClearingAgentOsEngine.submit({ networkId: 'ppn-family', instruction: IX, idempotencyKey: 'k1', actor: 'a' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_APPROVAL' });
    await expect(ClearingAgentOsEngine.submit({ networkId: 'ppn-family', instruction: IX, idempotencyKey: 'k1', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'a' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_NOT_FOUND' });
    await ClearingAgentOsEngine.register({ networkId: 'ppn-family', name: 'Family PPN', baseUrl: 'https://ppn.dlbtrust.internal/ppn', format: 'iso20022_pacs008', credentialRef: 'PPN_FAMILY_SHARED_SECRET', actor: 'trustee.a@f' });
    await expect(ClearingAgentOsEngine.submit({ networkId: 'ppn-family', instruction: IX, idempotencyKey: 'k1', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'a' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_UNVERIFIED' });
    await ClearingAgentOsEngine.challenge({ networkId: 'ppn-family', actor: 'trustee.a@f' });
    await ClearingAgentOsEngine.verify({ networkId: 'ppn-family', actor: 'trustee.b@f' });
    expect(w).not.toHaveBeenCalled();

    await expect(ClearingAgentOsEngine.submit({ networkId: 'ppn-family', instruction: { ...IX, creditor: { ...IX.creditor, participantId: null } }, idempotencyKey: 'k0', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'a' })).rejects.toMatchObject({ code: 'CLEARING_AGENT_FAMILY_ONLY' });

    const s1 = await ClearingAgentOsEngine.submit({ networkId: 'ppn-family', instruction: IX, idempotencyKey: 'k1', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'trustee.a@f' });
    expect(s1.status).toBe('cleared');
    expect(s1.network_ref).toBe('PPN-REF-77');
    expect(s1.creditor_account_last4).toBe('******3210');
    expect(s1.message_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.filter((c) => c.path === '/ppn/clear')).toHaveLength(1);
    const clear = calls.find((c) => c.path === '/ppn/clear');
    expect(clear.headers['X-Clearing-Format']).toBe('iso20022_pacs008');
    expect(clear.headers['X-Idempotency-Key']).toBe('k1');
    expect(clear.body).toMatch(/pacs\.008/);
    expect(clear.body).not.toContain(SECRET);
    expect(w).not.toHaveBeenCalled();

    const s2 = await ClearingAgentOsEngine.submit({ networkId: 'ppn-family', instruction: IX, idempotencyKey: 'k1', approvalRef: 'APR-1', screeningRef: 'SCR-1', actor: 'trustee.a@f' });
    expect(s2.idempotent).toBe(true);
    expect(calls.filter((c) => c.path === '/ppn/clear')).toHaveLength(1);

    const p = await ClearingAgentOsEngine.post({ instructionId: s1.instruction_id, actor: 'trustee.b@f' });
    expect(p.status).toBe('posted');
    expect(p.fineract_withdrawal_id).toBe('901');
    expect(p.fineract_deposit_id).toBe('902');
    expect(w).toHaveBeenCalledWith(expect.objectContaining({ accountId: '4', amount: 1250 }));
    expect(d).toHaveBeenCalledWith(expect.objectContaining({ accountId: '5', amount: 1250 }));
    const p2 = await ClearingAgentOsEngine.post({ instructionId: s1.instruction_id, actor: 'trustee.b@f' });
    expect(p2.idempotent).toBe(true);
    expect(w).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toContain('clearing_agent.posted');
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('shadow mode converts and records but never calls the network or Fineract', async () => {
    memPool();
    const calls = mockNetwork();
    const w = vi.spyOn(FineractClient, 'withdrawSavings').mockResolvedValue({});
    await registerAndVerify();
    process.env.CLEARING_AGENT_LIVE = 'false';
    const s = await ClearingAgentOsEngine.submit({ networkId: 'ppn-family', instruction: IX, idempotencyKey: 'k9', approvalRef: 'A', screeningRef: 'S', actor: 'a' });
    expect(s.shadow).toBe(true);
    expect(s.status).toBe('rejected');
    expect(calls.filter((c) => c.path === '/ppn/clear')).toHaveLength(0);
    await expect(ClearingAgentOsEngine.post({ instructionId: s.instruction_id })).rejects.toMatchObject({ code: 'CLEARING_AGENT_STATE' });
    expect(w).not.toHaveBeenCalled();
  });

  it('network rejection leaves the instruction rejected and unposted', async () => {
    memPool();
    mockNetwork({ clearStatus: 422 });
    await registerAndVerify();
    const s = await ClearingAgentOsEngine.submit({ networkId: 'ppn-family', instruction: IX, idempotencyKey: 'k2', approvalRef: 'A', screeningRef: 'S', actor: 'a' });
    expect(s.status).toBe('rejected');
    expect(s.error).toMatch(/HTTP 422/);
  });

  it('readiness names every blocker and echoes no credential value', async () => {
    memPool();
    mockNetwork();
    delete process.env.CLEARING_AGENT_LIVE;
    let r = await ClearingAgentOsEngine.readiness();
    expect(r.mode).toBe('shadow');
    expect(r.blockers).toContain('no private electronic payment network registered (POST process action=register)');
    await registerAndVerify();
    r = await ClearingAgentOsEngine.readiness();
    expect(r.blockers).toEqual(['CLEARING_AGENT_LIVE not true']);
    process.env.CLEARING_AGENT_LIVE = 'true';
    r = await ClearingAgentOsEngine.readiness();
    expect(r.ready).toBe(true);
    expect(r.mode).toBe('live');
    expect(r.status.policy).toMatchObject({ usaOnly: true, credentialStorage: 'secret_manager_reference_only', handshakeMovesMoney: false });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    delete process.env.PPN_FAMILY_SHARED_SECRET;
    r = await ClearingAgentOsEngine.readiness();
    expect(r.blockers.join('\n')).toMatch(/credential reference PPN_FAMILY_SHARED_SECRET has no runtime value/);
  });
});

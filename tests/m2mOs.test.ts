import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { M2mOsEngine, opensshPublicKey, canonical, MANIFEST_SUFFIX } = require('../server/integrations/os/m2mOsEngine');
const { MftOsEngine, channelReadiness } = require('../server/integrations/os/mftOsEngine');
const wireTransport = require('../server/integrations/inhouseBank/wire/wireTransport');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/**
 * Both registers answered from memory. Only the SQL shapes the engines emit
 * are understood, so a new query is a test failure, not a silent pass.
 */
function store() {
  const identities: Row[] = [];
  const partners: Row[] = [];
  const m2mEvents: Row[] = [];
  const channels: Row[] = [];
  const files: Row[] = [];
  const events: Row[] = [];

  const FILE_COLUMNS = ['file_id', 'channel_id', 'file_type', 'format', 'status', 'filename', 'content', 'content_hash', 'size_bytes',
    'entry_count', 'credit_cents', 'debit_cents', 'effective_date', 'entries', 'built_by', 'approved_by', 'transport', 'memo', 'source_ref'];

  const applySet = (target: Row, setClause: string, params: any[]) => {
    setClause.split(', ').forEach(pair => {
      const [col, value] = pair.split(' = ');
      if (value === 'NOW()') target[col] = new Date().toISOString();
      else if (value === 'NULL') target[col] = null;
      else if (/^'.*'$/.test(value)) target[col] = value.slice(1, -1);
      else target[col] = params[Number(value.replace(/\$|::jsonb/g, '')) - 1];
    });
  };

  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };

    // ── m2m ──
    if (text.startsWith('INSERT INTO m2m_identities')) {
      const row = { identity_id: params[0], label: params[1], algorithm: 'rsa', bits: params[2], status: params[3], fingerprint: params[4],
        public_key_openssh: params[5], public_key_pem: params[6], private_key_enc: params[7], created_by: params[8],
        created_at: new Date().toISOString(), activated_at: /NOW\(\)\) RETURNING/.test(text) ? new Date().toISOString() : null, retired_at: null };
      identities.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM m2m_identities WHERE identity_id')) return { rows: identities.filter(i => i.identity_id === params[0]) };
    if (text.startsWith('SELECT * FROM m2m_identities ORDER')) return { rows: [...identities] };
    if (text.startsWith('UPDATE m2m_identities SET')) {
      const set = /SET (.+) WHERE identity_id = \$1/.exec(text)![1];
      identities.filter(i => i.identity_id === params[0]).forEach(i => applySet(i, set, params));
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO m2m_partners')) {
      const row = { partner_id: params[0], name: params[1], bank_name: params[2], channel_id: params[3], identity_id: params[4], staged_identity_id: null,
        host: params[5], port: params[6], username: params[7], host_key_fingerprint: params[8], policy: JSON.parse(params[9]), status: 'pending',
        last_handshake: null, last_handshake_at: null, last_cycle_at: null, created_by: params[10], created_at: new Date().toISOString() };
      partners.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM m2m_partners WHERE partner_id')) return { rows: partners.filter(p => p.partner_id === params[0]) };
    if (text.startsWith('SELECT partner_id FROM m2m_partners WHERE identity_id')) return { rows: partners.filter(p => p.identity_id === params[0]) };
    if (text.startsWith('SELECT * FROM m2m_partners ORDER')) return { rows: [...partners] };
    if (text.startsWith('UPDATE m2m_partners SET')) {
      const set = /SET (.+) WHERE partner_id = \$1/.exec(text)![1];
      partners.filter(p => p.partner_id === params[0]).forEach(p => {
        applySet(p, set, params);
        if (typeof p.last_handshake === 'string') p.last_handshake = JSON.parse(p.last_handshake);
      });
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO m2m_events')) {
      m2mEvents.push({ event_id: params[0], partner_id: params[1], identity_id: params[2], event_type: params[3], actor: params[4], detail: JSON.parse(params[5]), created_at: new Date().toISOString() });
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM m2m_events')) {
      let out = [...m2mEvents].reverse();
      if (/partner_id = \$1/.test(text)) out = out.filter(e => e.partner_id === params[0]);
      return { rows: out };
    }

    // ── mft ──
    if (text.startsWith('SELECT * FROM mft_channels WHERE channel_id')) return { rows: channels.filter(c => c.channel_id === params[0]) };
    if (text.startsWith('SELECT * FROM mft_channels ORDER BY')) return { rows: [...channels] };
    if (text.startsWith('INSERT INTO mft_channels')) {
      const row = { channel_id: params[0], name: params[1], bank_name: params[2], status: 'active', file_types: JSON.parse(params[3]), config: JSON.parse(params[4]), created_by: params[5], created_at: new Date().toISOString() };
      channels.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('UPDATE mft_channels SET config')) {
      channels.filter(c => c.channel_id === params[0]).forEach(c => { c.config = JSON.parse(params[1]); });
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO mft_files')) {
      const row: Row = { built_at: new Date().toISOString(), remote_path: null, archive_path: null, bank_reference: null, failure_reason: null, approved_at: null, transmitted_at: null, acknowledged_at: null, settled_at: null };
      FILE_COLUMNS.forEach((col, i) => { row[col] = col === 'entries' ? JSON.parse(params[i]) : params[i]; });
      if (row.approved_by) row.approved_at = new Date().toISOString();
      files.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM mft_files WHERE file_id')) return { rows: files.filter(f => f.file_id === params[0]) };
    if (text.startsWith('SELECT * FROM mft_files WHERE channel_id = $1 AND filename')) return { rows: files.filter(f => f.channel_id === params[0] && f.filename === params[1]) };
    if (text.startsWith('SELECT file_id, transmitted_at FROM mft_files')) {
      return { rows: files.filter(f => f.channel_id === params[0] && f.content_hash === params[1] && f.file_id !== params[2] && ['transmitted', 'acknowledged', 'settled'].includes(f.status)) };
    }
    if (text.startsWith('SELECT * FROM mft_files')) {
      let out = [...files].reverse();
      const m = /WHERE (.+) ORDER BY/.exec(text);
      if (m) {
        m[1].split(' AND ').forEach(clause => {
          const [col, ref] = clause.split(' = ');
          out = out.filter(f => f[col] === params[Number(ref.slice(1)) - 1]);
        });
      }
      return { rows: out };
    }
    if (text.startsWith('UPDATE mft_files SET')) {
      const setClause = /SET (.+) WHERE file_id = \$1 RETURNING/.exec(text)![1];
      const target = files.find(f => f.file_id === params[0]);
      if (!target) return { rows: [] };
      applySet(target, setClause, params);
      return { rows: [target] };
    }
    if (text.startsWith('INSERT INTO mft_events')) {
      events.push({ event_id: params[0], file_id: params[1], channel_id: params[2], event_type: params[3], actor: params[4], detail: JSON.parse(params[5]), created_at: new Date().toISOString() });
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM mft_events')) return { rows: events.filter(e => e.file_id === params[0]) };

    throw new Error(`unexpected SQL in test: ${text}`);
  });

  vi.spyOn(pool, 'query').mockImplementation(query as any);
  return { identities, partners, m2mEvents, channels, files, events, query };
}

/**
 * The bank host, played by the spool: every SFTP open is captured (so the
 * test can see exactly which credential the machine presented) and served
 * from a directory with the same staging-and-rename semantics.
 */
function fakeBank(dir: string) {
  const opened: Row[] = [];
  vi.spyOn(wireTransport, 'openWireTransport').mockImplementation(async (config: Row) => {
    opened.push(config);
    if (config.transport !== 'sftp') return wireTransport.SpoolSession.open(config);
    if (!config.hostKeyFingerprint) throw new Error('host key not pinned');
    if (!config.privateKey || !/BEGIN RSA PRIVATE KEY/.test(config.privateKey)) throw new Error('bank rejected authentication');
    if (config.password) throw new Error('bank does not accept passwords');
    return wireTransport.SpoolSession.open({ ...config, transport: 'spool', spoolDir: path.join(dir, config.host) });
  });
  return opened;
}

const payee = (over: Row = {}) => ({ routingNumber: '021000021', accountNumber: '123456789', amountCents: 125_000, name: 'Jane Beneficiary', identifier: 'BEN-1', ...over });
const bank = { name: 'Origin Bank', bankName: 'Origin Bank N.A.', host: 'sftp.originbank.test', username: 'dlbtrust-svc', hostKeyFingerprint: 'SHA256:bankbankbankbankbankbankbankbankbankbankbank', createdBy: 'admin@dlb.trust' };

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm2m-'));
  process.env.MFT_SPOOL_DIR = path.join(tmp, 'spool');
  process.env.MFT_ARCHIVE_DIR = path.join(tmp, 'archive');
  process.env.PAYMENT_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.M2M_KEY_BITS = '2048';
  delete process.env.MFT_SFTP_HOST;
  delete process.env.M2M_CYCLE_INTERVAL_MS;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  M2mOsEngine.stopScheduler();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('M2M OS — machine identities', () => {
  it('mints an RSA identity whose private key is encrypted at rest and never surfaced', async () => {
    const s = store();
    const identity = await M2mOsEngine.createIdentity({ label: 'origin bank', createdBy: 'admin@dlb.trust' });
    expect(identity.status).toBe('active');
    expect(identity.bits).toBe(2048);
    expect(identity.publicKeyOpenssh).toMatch(/^ssh-rsa AAAA/);
    expect(identity.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(JSON.stringify(identity)).not.toContain('PRIVATE KEY');
    expect(s.identities[0].private_key_enc).toMatch(/^enc:v1:/);
    expect(s.identities[0].private_key_enc).not.toContain('PRIVATE KEY');

    const pem = await M2mOsEngine.privateKeyFor(identity.identityId);
    expect(pem).toMatch(/BEGIN RSA PRIVATE KEY/);
    const derived = opensshPublicKey(crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' }), '');
    expect(derived.fingerprint).toBe(identity.fingerprint);
  });

  it('refuses to hand out a retired key and refuses to retire a key a partner still uses', async () => {
    store();
    fakeBank(tmp);
    const idle = await M2mOsEngine.createIdentity({ label: 'idle' });
    await M2mOsEngine.retireIdentity(idle.identityId, 'admin@dlb.trust');
    await expect(M2mOsEngine.privateKeyFor(idle.identityId)).rejects.toMatchObject({ code: 'M2M_IDENTITY_RETIRED' });

    const { partner } = await M2mOsEngine.registerPartner(bank);
    await expect(M2mOsEngine.retireIdentity(partner.identityId, 'admin@dlb.trust')).rejects.toMatchObject({ code: 'M2M_IDENTITY_IN_USE' });
  });
});

describe('M2M OS — partners and the handshake', () => {
  it('registers a partner with a bound MFT channel that needs no environment credential', async () => {
    store();
    const { partner, identity, channel, authorize } = await M2mOsEngine.registerPartner(bank);
    expect(partner.status).toBe('pending');
    expect(partner.channelId).toBe(`m2m-${partner.partnerId}`.toLowerCase());
    expect(channel.config.identityId).toBe(identity.identityId);
    expect(channel.config.signManifests).toBe(true);
    expect(channel.config.passwordEnv).toBe('');
    expect(channel.config.privateKeyEnv).toBe('');
    expect(channelReadiness(channel)).toEqual({ ready: true, transport: 'sftp', blockers: [] });
    expect(authorize.publicKeyOpenssh).toBe(identity.publicKeyOpenssh);
    expect(authorize.instruction).toContain(bank.host);
  });

  it('will not register a partner whose host key is not pinned', async () => {
    store();
    await expect(M2mOsEngine.registerPartner({ ...bank, hostKeyFingerprint: '' })).rejects.toMatchObject({ code: 'M2M_UNPINNED_HOST' });
  });

  it('a passing handshake authenticates with the machine key, probes every directory and verifies the partner', async () => {
    store();
    const opened = fakeBank(tmp);
    const { partner } = await M2mOsEngine.registerPartner(bank);
    const { partner: after, handshake } = await M2mOsEngine.handshake(partner.partnerId, { actor: 'ops@dlb.trust' });

    expect(handshake.ok).toBe(true);
    expect(handshake.steps.map((s: Row) => s.step)).toEqual(['connect', 'list:outboundPath', 'list:ackPath', 'list:returnPath', 'list:archivePath', 'probe:write', 'probe:remove']);
    expect(after.status).toBe('verified');
    expect(after.lastHandshake.fingerprint).toBe(handshake.fingerprint);

    expect(opened).toHaveLength(1);
    expect(opened[0].transport).toBe('sftp');
    expect(opened[0].username).toBe('dlbtrust-svc');
    expect(opened[0].privateKey).toMatch(/BEGIN RSA PRIVATE KEY/);
    expect(opened[0].password).toBe('');
    expect(opened[0].privateKeyPath).toBe('');
    expect(fs.readdirSync(path.join(tmp, bank.host, 'payments', 'outbound'))).toEqual([]);
  });

  it('a failing handshake names the broken step and degrades the partner instead of trusting it', async () => {
    store();
    vi.spyOn(wireTransport, 'openWireTransport').mockRejectedValue(new Error('bank rejected authentication'));
    const { partner } = await M2mOsEngine.registerPartner(bank);
    const { partner: after, handshake } = await M2mOsEngine.handshake(partner.partnerId);
    expect(handshake.ok).toBe(false);
    expect(handshake.steps).toEqual([{ step: 'connect', ok: false, error: 'bank rejected authentication' }]);
    expect(after.status).toBe('degraded');
    await expect(M2mOsEngine.setPartnerStatus(partner.partnerId, 'verified', 'admin@dlb.trust')).rejects.toMatchObject({ code: 'M2M_UNVERIFIED' });
  });
});

describe('M2M OS — the unattended cycle', () => {
  it('transmits only human-approved files, signs a manifest beside each, collects the acks, and never releases anything itself', async () => {
    store();
    fakeBank(tmp);
    const { partner } = await M2mOsEngine.registerPartner(bank);
    await M2mOsEngine.handshake(partner.partnerId);

    const { file: approved } = await MftOsEngine.build({ channelId: partner.channelId, fileType: 'direct_deposit', builtBy: 'maker@dlb.trust', entries: [payee()] });
    await MftOsEngine.approve(approved.fileId, 'checker@dlb.trust');
    const { file: unreleased } = await MftOsEngine.build({ channelId: partner.channelId, fileType: 'vendor_payment', builtBy: 'maker@dlb.trust', entries: [payee({ amountCents: 99_00, name: 'Acme Vendor' })] });

    const first = await M2mOsEngine.runCycle();
    expect(first.partners).toHaveLength(1);
    expect(first.partners[0].transmitted.map((t: Row) => t.fileId)).toEqual([approved.fileId]);
    expect(first.partners[0].errors).toEqual([]);
    expect(first.partners[0].degraded).toBe(false);
    expect((await MftOsEngine.get(unreleased.fileId)).status).toBe('built');

    const sent = await MftOsEngine.get(approved.fileId);
    expect(sent.status).toBe('transmitted');
    const outbound = path.join(tmp, bank.host, 'payments', 'outbound');
    expect(fs.readdirSync(outbound).sort()).toEqual([sent.filename, `${sent.filename}${MANIFEST_SUFFIX}`].sort());

    const doc = JSON.parse(fs.readFileSync(path.join(outbound, `${sent.filename}${MANIFEST_SUFFIX}`), 'utf8'));
    expect(doc.manifest.sha256).toBe(sent.contentHash);
    expect(doc.manifest.creditCents).toBe(125_000);
    expect(doc.manifest.identityId).toBe(partner.identityId);
    expect(await M2mOsEngine.verifyManifest(doc)).toMatchObject({ valid: true, identityId: partner.identityId });
    const { publicKeyPem } = await M2mOsEngine.identity(partner.identityId);
    expect(crypto.verify('sha256', Buffer.from(canonical(doc.manifest)), publicKeyPem, Buffer.from(doc.signature, 'base64'))).toBe(true);
    const tampered = { ...doc, manifest: { ...doc.manifest, creditCents: 1 } };
    expect(await M2mOsEngine.verifyManifest(tampered)).toMatchObject({ valid: false, reason: 'signature does not verify' });

    const transmitEvent = (await MftOsEngine.events(approved.fileId)).find((e: Row) => e.eventType === 'transmitted');
    expect(transmitEvent.actor).toBe(`machine:${partner.identityId}`);
    expect(transmitEvent.detail.manifestPath).toContain(MANIFEST_SUFFIX);

    fs.mkdirSync(path.join(tmp, bank.host, 'payments', 'ack'), { recursive: true });
    fs.writeFileSync(path.join(tmp, bank.host, 'payments', 'ack', `${sent.filename}.ack`), 'BANKREF-777\n');
    const second = await M2mOsEngine.runCycle({ partnerId: partner.partnerId });
    expect(second.partners[0].transmitted).toEqual([]);
    expect(second.partners[0].collected.acknowledged).toEqual([approved.fileId]);
    expect((await MftOsEngine.get(approved.fileId)).bankReference).toBe('BANKREF-777');
  });

  it('skips partners that have not passed a handshake and degrades one whose bank goes away', async () => {
    store();
    const opened = fakeBank(tmp);
    const { partner } = await M2mOsEngine.registerPartner(bank);
    const pending = await M2mOsEngine.runCycle({ partnerId: partner.partnerId });
    expect(pending.partners[0].errors[0]).toContain('run a handshake first');
    expect(opened).toHaveLength(0);

    await M2mOsEngine.handshake(partner.partnerId);
    vi.spyOn(wireTransport, 'openWireTransport').mockRejectedValue(new Error('SFTP connection to sftp.originbank.test failed: ECONNREFUSED'));
    const down = await M2mOsEngine.runCycle();
    expect(down.partners[0].degraded).toBe(true);
    expect((await M2mOsEngine.partner(partner.partnerId)).status).toBe('degraded');
    expect((await M2mOsEngine.events({ partnerId: partner.partnerId }))[0].eventType).toBe('cycle_degraded');
  });

  it('the scheduler stays off unless an interval is configured', async () => {
    store();
    expect(M2mOsEngine.startScheduler({ log: { log() {}, warn() {} } })).toBeNull();
    expect(M2mOsEngine.startScheduler({ intervalMs: 60_000, log: { log() {}, warn() {} } })).toBe(60_000);
    expect((await M2mOsEngine.status()).scheduler.running).toBe(true);
    M2mOsEngine.stopScheduler();
    expect((await M2mOsEngine.status()).scheduler.running).toBe(false);
  });
});

describe('M2M OS — key rotation', () => {
  it('stages a new key, refuses to promote until the bank has authorized it, then swaps and retires the old key', async () => {
    store();
    fakeBank(tmp);
    const { partner, identity: original } = await M2mOsEngine.registerPartner(bank);
    await M2mOsEngine.handshake(partner.partnerId);

    const { staged, authorize, alreadyStaged } = await M2mOsEngine.rotate(partner.partnerId, { actor: 'admin@dlb.trust' });
    expect(alreadyStaged).toBe(false);
    expect(staged.status).toBe('staged');
    expect(authorize.fingerprint).toBe(staged.fingerprint);
    expect((await M2mOsEngine.rotate(partner.partnerId)).alreadyStaged).toBe(true);
    expect((await M2mOsEngine.partner(partner.partnerId)).identityId).toBe(original.identityId);

    // Bank has not installed the new key yet: the staged handshake fails and nothing changes.
    const authorized = new Set([original.identityId]);
    const spool = wireTransport.openWireTransport;
    vi.spyOn(wireTransport, 'openWireTransport').mockImplementation(async (config: Row) => {
      const known = (await M2mOsEngine.identities()).find((i: Row) => authorized.has(i.identityId) && crypto.createPublicKey(config.privateKey).export({ type: 'spki', format: 'pem' }) === i.publicKeyPem);
      if (!known) throw new Error('bank rejected authentication');
      return spool(config);
    });
    await expect(M2mOsEngine.promote(partner.partnerId, { actor: 'admin@dlb.trust' })).rejects.toMatchObject({ code: 'M2M_HANDSHAKE_FAILED' });
    expect((await M2mOsEngine.partner(partner.partnerId)).identityId).toBe(original.identityId);
    expect((await M2mOsEngine.partner(partner.partnerId)).status).toBe('verified');

    authorized.add(staged.identityId);
    const promoted = await M2mOsEngine.promote(partner.partnerId, { actor: 'admin@dlb.trust' });
    expect(promoted.partner.identityId).toBe(staged.identityId);
    expect(promoted.partner.stagedIdentityId).toBeNull();
    expect(promoted.identity.status).toBe('active');
    expect(promoted.retired.status).toBe('retired');
    expect((await MftOsEngine.channel(partner.channelId)).config.identityId).toBe(staged.identityId);
    await expect(M2mOsEngine.privateKeyFor(original.identityId)).rejects.toMatchObject({ code: 'M2M_IDENTITY_RETIRED' });
  });
});

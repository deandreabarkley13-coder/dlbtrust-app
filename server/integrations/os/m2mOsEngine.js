'use strict';

/**
 * M2M OS — machine-to-machine delivery of the trust's payment files.
 *
 * MFT OS decides *what* leaves and proves it left. This engine decides *who*
 * the bank is talking to when it does, and makes sure that "who" is never a
 * person. Every banking partner gets a machine identity: a key pair generated
 * on this host, whose private half is encrypted into the keyring and whose
 * public half is handed to the bank once, out of band, to authorize. From then
 * on the handshake, every transmission and every acknowledgement pickup
 * authenticates with that key, resolved for the life of a session and never
 * written to the environment, a config file, or a human's password manager.
 *
 * What the engine owns:
 *
 *   identities   RSA key pairs (banks accept RSA everywhere; Ed25519 not yet).
 *                Private key encrypted at rest with the payment data key.
 *                States: staged → active → retired. Only active identities
 *                open sessions; a staged one may only run a handshake.
 *   partners     One bank host, one pinned host key, one MFT channel, one
 *                identity. Registering a partner registers its channel with
 *                `identityId` bound, so MFT authenticates through this keyring.
 *   handshake    Proves the machine relationship end to end: connect with the
 *                identity key against the pinned host key, confirm the four
 *                directories, write a probe under the staging name, rename,
 *                delete. Success promotes the partner to `verified`; failure
 *                marks it `degraded` and says which step broke. Nothing about
 *                a partner is trusted until a handshake has passed.
 *   manifests    A signed sidecar per transmitted file — hash, size, totals,
 *                identity fingerprint — so the bank can verify the sender and
 *                the bytes without trusting the transport, and so the trust
 *                can prove later exactly what was signed for.
 *   rotation     A new key is staged while the old one is still active. The
 *                bank authorizes it, the staged handshake proves it, promotion
 *                swaps identities atomically and retires the old one. The
 *                channel is never without a working key.
 *   cycle        The unattended workflow: for every verified partner, transmit
 *                what has been *approved by people* through MFT's four-eyes
 *                gate, collect acknowledgements and returns, record a
 *                heartbeat. The machine carries the files; it never releases
 *                them. `MFT_REQUIRE_APPROVAL` is not this engine's to relax.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { encrypt, decrypt } = require('../paymentHub/paymentCrypto');
const wireTransport = require('../inhouseBank/wire/wireTransport');

const MANIFEST_VERSION = 'dlbtrust-m2m-manifest/1';
const MANIFEST_SUFFIX = '.m2m.json';
const IDENTITY_STATUSES = ['staged', 'active', 'retired'];
const PARTNER_STATUSES = ['pending', 'verified', 'degraded', 'suspended'];
const DEFAULT_BITS = 3072;

class M2mError extends Error {
  constructor(message, code = 'M2M_ERROR', status = 409, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function text(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null || String(v).trim() === '' ? fallback : String(v).trim();
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(text(name, ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function getM2mConfig() {
  return {
    keyBits: intEnv('M2M_KEY_BITS', DEFAULT_BITS, { min: 2048, max: 8192 }),
    cycleIntervalMs: intEnv('M2M_CYCLE_INTERVAL_MS', 0, { min: 0, max: 24 * 3600 * 1000 }),
    keyComment: text('M2M_KEY_COMMENT', 'dlbtrust-m2m'),
  };
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** RFC 4253 `ssh-rsa` wire encoding of a public key, as `authorized_keys` wants it. */
function opensshPublicKey(publicKeyPem, comment) {
  const jwk = crypto.createPublicKey(publicKeyPem).export({ format: 'jwk' });
  const mpint = b64 => {
    let buf = Buffer.from(b64, 'base64url');
    if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
    return buf;
  };
  const field = buf => { const len = Buffer.alloc(4); len.writeUInt32BE(buf.length); return Buffer.concat([len, buf]); };
  const blob = Buffer.concat([field(Buffer.from('ssh-rsa')), field(mpint(jwk.e)), field(mpint(jwk.n))]);
  return { line: `ssh-rsa ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`, fingerprint: `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` };
}

function generateIdentityKey(bits, comment) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const openssh = opensshPublicKey(publicKey, comment);
  return { privateKeyPem: privateKey, publicKeyPem: publicKey, publicKeyOpenssh: openssh.line, fingerprint: openssh.fingerprint };
}

function signCanonical(privateKeyPem, value) {
  return crypto.sign('sha256', Buffer.from(canonical(value), 'utf8'), privateKeyPem).toString('base64');
}

function verifyCanonical(publicKeyPem, value, signatureB64) {
  try {
    return crypto.verify('sha256', Buffer.from(canonical(value), 'utf8'), publicKeyPem, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────────

/** The private key never leaves this module through a mapper. */
function mapIdentity(row) {
  return {
    identityId: row.identity_id,
    label: row.label,
    algorithm: row.algorithm,
    bits: Number(row.bits),
    status: row.status,
    fingerprint: row.fingerprint,
    publicKeyOpenssh: row.public_key_openssh,
    publicKeyPem: row.public_key_pem,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
  };
}

function mapPartner(row) {
  return {
    partnerId: row.partner_id,
    name: row.name,
    bankName: row.bank_name,
    channelId: row.channel_id,
    identityId: row.identity_id,
    stagedIdentityId: row.staged_identity_id,
    host: row.host,
    port: Number(row.port),
    username: row.username,
    hostKeyFingerprint: row.host_key_fingerprint,
    policy: parseJson(row.policy, {}),
    status: row.status,
    lastHandshake: parseJson(row.last_handshake, null),
    lastHandshakeAt: row.last_handshake_at,
    lastCycleAt: row.last_cycle_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function machineActor(identityId) {
  return `machine:${identityId}`;
}

let cycleTimer = null;
let cycleRunning = false;

const M2mOsEngine = {
  M2mError,
  MANIFEST_VERSION,
  MANIFEST_SUFFIX,
  IDENTITY_STATUSES,
  PARTNER_STATUSES,
  config: getM2mConfig,

  async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS m2m_identities (
        identity_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        bits INTEGER NOT NULL,
        status TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        public_key_openssh TEXT NOT NULL,
        public_key_pem TEXT NOT NULL,
        private_key_enc TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ,
        retired_at TIMESTAMPTZ
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS m2m_partners (
        partner_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        bank_name TEXT,
        channel_id TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        staged_identity_id TEXT,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        host_key_fingerprint TEXT,
        policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL,
        last_handshake JSONB,
        last_handshake_at TIMESTAMPTZ,
        last_cycle_at TIMESTAMPTZ,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS m2m_events (
        event_id TEXT PRIMARY KEY,
        partner_id TEXT,
        identity_id TEXT,
        event_type TEXT NOT NULL,
        actor TEXT,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS m2m_events_partner_idx ON m2m_events (partner_id, created_at)');
  },

  // ── Identities ─────────────────────────────────────────────────────────────

  /**
   * Mint a machine identity. The private key is generated here, encrypted
   * immediately, and returned to nobody. What comes back is the public half
   * to hand the bank.
   */
  async createIdentity({ label, createdBy = null, status = 'active', bits = null } = {}) {
    if (!label) throw new M2mError('An identity needs a label', 'M2M_BAD_IDENTITY', 400);
    if (!['staged', 'active'].includes(status)) throw new M2mError('A new identity is staged or active', 'M2M_BAD_IDENTITY', 400);
    const cfg = getM2mConfig();
    const keyBits = Math.min(8192, Math.max(2048, Number(bits) || cfg.keyBits));
    const key = generateIdentityKey(keyBits, `${cfg.keyComment}:${label}`.replace(/\s+/g, '-'));
    const identityId = newId('M2MID');
    const { rows } = await pool.query(
      `INSERT INTO m2m_identities (identity_id, label, algorithm, bits, status, fingerprint, public_key_openssh, public_key_pem, private_key_enc, created_by, activated_at)
       VALUES ($1, $2, 'rsa', $3, $4, $5, $6, $7, $8, $9, ${status === 'active' ? 'NOW()' : 'NULL'}) RETURNING *`,
      [identityId, label, keyBits, status, key.fingerprint, key.publicKeyOpenssh, key.publicKeyPem, encrypt(key.privateKeyPem), createdBy]
    );
    await this._event(null, identityId, 'identity_created', createdBy, { fingerprint: key.fingerprint, bits: keyBits, status });
    return mapIdentity(rows[0]);
  },

  async identities() {
    const { rows } = await pool.query('SELECT * FROM m2m_identities ORDER BY created_at');
    return rows.map(mapIdentity);
  },

  async identity(identityId) {
    const { rows } = await pool.query('SELECT * FROM m2m_identities WHERE identity_id = $1', [identityId]);
    if (!rows.length) throw new M2mError(`Identity ${identityId} is not in the keyring`, 'M2M_NO_IDENTITY', 404);
    return mapIdentity(rows[0]);
  },

  /**
   * The decrypted private key for one session. A retired key never opens
   * anything; a staged key may, so a handshake can prove it before promotion.
   */
  async privateKeyFor(identityId) {
    const { rows } = await pool.query('SELECT * FROM m2m_identities WHERE identity_id = $1', [identityId]);
    if (!rows.length) throw new M2mError(`Identity ${identityId} is not in the keyring`, 'M2M_NO_IDENTITY', 404);
    if (rows[0].status === 'retired') throw new M2mError(`Identity ${identityId} is retired and cannot authenticate`, 'M2M_IDENTITY_RETIRED', 403);
    return decrypt(rows[0].private_key_enc);
  },

  async retireIdentity(identityId, actor) {
    const id = await this.identity(identityId);
    const bound = await pool.query('SELECT partner_id FROM m2m_partners WHERE identity_id = $1', [identityId]);
    if (bound.rows.length) {
      throw new M2mError(`Identity ${identityId} is the active key for ${bound.rows.map(r => r.partner_id).join(', ')}; rotate first`, 'M2M_IDENTITY_IN_USE', 409);
    }
    if (id.status === 'retired') return id;
    await pool.query(`UPDATE m2m_identities SET status = 'retired', retired_at = NOW() WHERE identity_id = $1`, [identityId]);
    await this._event(null, identityId, 'identity_retired', actor, { fingerprint: id.fingerprint });
    return this.identity(identityId);
  },

  // ── Partners ───────────────────────────────────────────────────────────────

  /**
   * Register a banking partner. Mints its identity unless one is given, and
   * registers an MFT channel bound to that identity, so from this moment the
   * only credential the channel knows is the machine's.
   */
  async registerPartner({ partnerId = null, name, bankName = null, host, port = 22, username, hostKeyFingerprint = '', identityId = null,
    fileTypes = undefined, layout = {}, policy = {}, createdBy = null } = {}) {
    if (!name) throw new M2mError('A partner needs a name', 'M2M_BAD_PARTNER', 400);
    if (!host) throw new M2mError('A partner needs a bank host', 'M2M_BAD_PARTNER', 400);
    if (!username) throw new M2mError('A partner needs the username the bank assigned to the machine', 'M2M_BAD_PARTNER', 400);
    if (!hostKeyFingerprint) throw new M2mError('A partner needs the bank host key fingerprint pinned before anything connects', 'M2M_UNPINNED_HOST', 400);
    const { MftOsEngine } = require('./mftOsEngine');

    const id = partnerId || newId('M2MP');
    let identity;
    if (identityId) {
      identity = await this.identity(identityId);
      if (identity.status !== 'active') throw new M2mError(`Identity ${identityId} is ${identity.status}; a partner binds an active identity`, 'M2M_BAD_IDENTITY', 409);
    } else {
      identity = await this.createIdentity({ label: `${id} ${name}`, createdBy });
    }

    const channel = await MftOsEngine.registerChannel({
      channelId: `m2m-${id}`.toLowerCase(),
      name: `${name} (M2M)`,
      bankName,
      fileTypes,
      config: {
        host, port: Number(port) || 22, username, hostKeyFingerprint,
        identityId: identity.identityId,
        signManifests: policy.signManifests !== false,
        outboundPath: layout.outboundPath, ackPath: layout.ackPath, returnPath: layout.returnPath, archivePath: layout.archivePath,
        filePrefix: layout.filePrefix, stagingSuffix: layout.stagingSuffix, connectTimeoutMs: layout.connectTimeoutMs,
      },
      createdBy,
    });

    const stored = {
      autoTransmit: policy.autoTransmit !== false,
      collect: policy.collect !== false,
      signManifests: policy.signManifests !== false,
    };
    const { rows } = await pool.query(
      `INSERT INTO m2m_partners (partner_id, name, bank_name, channel_id, identity_id, host, port, username, host_key_fingerprint, policy, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending', $11) RETURNING *`,
      [id, name, bankName, channel.channelId, identity.identityId, host, Number(port) || 22, username, hostKeyFingerprint, JSON.stringify(stored), createdBy]
    );
    await this._event(id, identity.identityId, 'partner_registered', createdBy, { channelId: channel.channelId, host, username, fingerprint: identity.fingerprint });
    return { partner: mapPartner(rows[0]), identity, channel, authorize: this._authorizeInstructions(identity, username, host) };
  },

  _authorizeInstructions(identity, username, host) {
    return {
      publicKeyOpenssh: identity.publicKeyOpenssh,
      fingerprint: identity.fingerprint,
      instruction: `Hand this public key to ${host} for user ${username} (authorized_keys). Then run the handshake; the partner is not trusted until it passes.`,
    };
  },

  async partners() {
    const { rows } = await pool.query('SELECT * FROM m2m_partners ORDER BY created_at');
    return rows.map(mapPartner);
  },

  async partner(partnerId) {
    const { rows } = await pool.query('SELECT * FROM m2m_partners WHERE partner_id = $1', [partnerId]);
    if (!rows.length) throw new M2mError(`Partner ${partnerId} is not registered`, 'M2M_NO_PARTNER', 404);
    return mapPartner(rows[0]);
  },

  async setPartnerStatus(partnerId, status, actor) {
    if (!['verified', 'suspended'].includes(status)) throw new M2mError('status must be verified or suspended', 'M2M_BAD_PARTNER', 400);
    const partner = await this.partner(partnerId);
    if (status === 'verified' && !(partner.lastHandshake && partner.lastHandshake.ok)) {
      throw new M2mError(`Partner ${partnerId} has no passing handshake; run one instead of marking it verified`, 'M2M_UNVERIFIED', 412);
    }
    await pool.query('UPDATE m2m_partners SET status = $2 WHERE partner_id = $1', [partnerId, status]);
    await this._event(partnerId, partner.identityId, `partner_${status}`, actor, {});
    return this.partner(partnerId);
  },

  // ── Handshake ──────────────────────────────────────────────────────────────

  /**
   * Prove the machine relationship with the bank end to end. Uses the
   * partner's active identity unless `identityId` names its staged one.
   */
  async handshake(partnerId, { actor = null, identityId = null } = {}) {
    const { MftOsEngine, sessionConfig } = require('./mftOsEngine');
    const partner = await this.partner(partnerId);
    if (partner.status === 'suspended') throw new M2mError(`Partner ${partnerId} is suspended`, 'M2M_SUSPENDED', 409);
    const useId = identityId || partner.identityId;
    if (useId !== partner.identityId && useId !== partner.stagedIdentityId) {
      throw new M2mError(`Identity ${useId} is neither the active nor the staged key for ${partnerId}`, 'M2M_BAD_IDENTITY', 409);
    }
    const identity = await this.identity(useId);
    const channel = await MftOsEngine.channel(partner.channelId);
    const started = Date.now();
    const steps = [];
    const step = async (name, fn) => {
      try {
        const detail = await fn();
        steps.push({ step: name, ok: true, detail: detail === undefined ? null : detail });
        return true;
      } catch (err) {
        steps.push({ step: name, ok: false, error: err.message });
        return false;
      }
    };

    let session = null;
    let ok = await step('connect', async () => {
      const config = await sessionConfig({ ...channel, config: { ...channel.config, identityId: useId } });
      session = await wireTransport.openWireTransport(config);
      return { transport: config.transport, host: config.host || 'spool', fingerprint: identity.fingerprint };
    });
    if (ok && session) {
      try {
        const dirs = ['outboundPath', 'ackPath', 'returnPath', 'archivePath'];
        for (const d of dirs) {
          if (!ok) break;
          ok = await step(`list:${d}`, async () => {
            if (typeof session.mkdirp === 'function') await session.mkdirp(channel.config[d]);
            const entries = await session.list(channel.config[d]);
            return { path: channel.config[d], files: entries.length };
          });
        }
        if (ok) {
          const probe = `.m2m-probe-${Date.now().toString(36)}`;
          ok = await step('probe:write', async () => {
            const remote = await session.put(channel.config.outboundPath, probe, `${MANIFEST_VERSION} ${identity.fingerprint}\n`);
            if (!(await session.exists(remote))) throw new Error('probe not visible after rename');
            return { remote };
          });
          if (ok) {
            ok = await step('probe:remove', async () => {
              await session.remove(`${channel.config.outboundPath}/${probe}`);
              if (await session.exists(`${channel.config.outboundPath}/${probe}`)) throw new Error('probe still present after delete');
              return null;
            });
          }
        }
      } finally {
        await session.close();
      }
    }

    const result = { ok, identityId: useId, fingerprint: identity.fingerprint, staged: useId === partner.stagedIdentityId, steps, durationMs: Date.now() - started, at: new Date().toISOString() };
    if (useId === partner.identityId) {
      const status = ok ? 'verified' : 'degraded';
      await pool.query('UPDATE m2m_partners SET status = $2, last_handshake = $3::jsonb, last_handshake_at = NOW() WHERE partner_id = $1', [partnerId, status, JSON.stringify(result)]);
    }
    await this._event(partnerId, useId, ok ? 'handshake_passed' : 'handshake_failed', actor || machineActor(useId), result);
    return { partner: await this.partner(partnerId), handshake: result };
  },

  // ── Rotation ───────────────────────────────────────────────────────────────

  /** Stage a new key next to the active one. The bank authorizes it before promotion. */
  async rotate(partnerId, { actor = null, bits = null } = {}) {
    const partner = await this.partner(partnerId);
    if (partner.stagedIdentityId) {
      const staged = await this.identity(partner.stagedIdentityId);
      return { partner, staged, authorize: this._authorizeInstructions(staged, partner.username, partner.host), alreadyStaged: true };
    }
    const staged = await this.createIdentity({ label: `${partnerId} ${partner.name} (rotation)`, createdBy: actor, status: 'staged', bits });
    await pool.query('UPDATE m2m_partners SET staged_identity_id = $2 WHERE partner_id = $1', [partnerId, staged.identityId]);
    await this._event(partnerId, staged.identityId, 'rotation_staged', actor, { previous: partner.identityId, fingerprint: staged.fingerprint });
    return { partner: await this.partner(partnerId), staged, authorize: this._authorizeInstructions(staged, partner.username, partner.host), alreadyStaged: false };
  },

  /** Prove the staged key with a handshake, then make it the partner's key and retire the old one. */
  async promote(partnerId, { actor = null } = {}) {
    const { MftOsEngine } = require('./mftOsEngine');
    const partner = await this.partner(partnerId);
    if (!partner.stagedIdentityId) throw new M2mError(`Partner ${partnerId} has no staged identity to promote`, 'M2M_NOTHING_STAGED', 409);
    const proof = await this.handshake(partnerId, { actor, identityId: partner.stagedIdentityId });
    if (!proof.handshake.ok) {
      throw new M2mError(`Staged identity ${partner.stagedIdentityId} failed its handshake; the bank has not authorized it yet`, 'M2M_HANDSHAKE_FAILED', 412, { handshake: proof.handshake });
    }
    const previous = partner.identityId;
    await pool.query(`UPDATE m2m_identities SET status = 'active', activated_at = NOW() WHERE identity_id = $1`, [partner.stagedIdentityId]);
    await pool.query(
      `UPDATE m2m_partners SET identity_id = $2, staged_identity_id = NULL, status = 'verified', last_handshake = $3::jsonb, last_handshake_at = NOW() WHERE partner_id = $1`,
      [partnerId, partner.stagedIdentityId, JSON.stringify({ ...proof.handshake, staged: false })]
    );
    await MftOsEngine.bindIdentity(partner.channelId, partner.stagedIdentityId, actor || machineActor(partner.stagedIdentityId));
    await pool.query(`UPDATE m2m_identities SET status = 'retired', retired_at = NOW() WHERE identity_id = $1`, [previous]);
    await this._event(partnerId, partner.stagedIdentityId, 'rotation_promoted', actor, { previous, retired: previous });
    return { partner: await this.partner(partnerId), identity: await this.identity(partner.stagedIdentityId), retired: await this.identity(previous) };
  },

  // ── Manifests ──────────────────────────────────────────────────────────────

  buildManifest(identity, partnerRef, file, remotePath) {
    return {
      version: MANIFEST_VERSION,
      sender: 'DEANDREA LAVAR BARKLEY TRUST COMPANY',
      identityId: identity.identityId,
      fingerprint: identity.fingerprint,
      channelId: partnerRef.channelId,
      fileId: file.fileId,
      filename: file.filename,
      remotePath,
      fileType: file.fileType,
      format: file.format,
      sha256: file.contentHash,
      sizeBytes: file.sizeBytes,
      entryCount: file.entryCount,
      creditCents: file.creditCents,
      debitCents: file.debitCents,
      effectiveDate: file.effectiveDate || null,
      signedAt: new Date().toISOString(),
    };
  },

  async signManifest(identityId, channelRef, file, remotePath) {
    const identity = await this.identity(identityId);
    const manifest = this.buildManifest(identity, channelRef, file, remotePath);
    const signature = signCanonical(await this.privateKeyFor(identityId), manifest);
    return { manifest, signature, algorithm: 'RSA-SHA256', publicKeyOpenssh: identity.publicKeyOpenssh };
  },

  /** Called by MFT inside the transmit session: sidecar goes next to the file, same staging semantics. */
  async putManifest(session, channel, file, remotePath) {
    const signed = await this.signManifest(channel.config.identityId, channel, file, remotePath);
    const name = `${file.filename}${MANIFEST_SUFFIX}`;
    const path = await session.put(channel.config.outboundPath, name, JSON.stringify(signed, null, 2));
    await this._event(null, channel.config.identityId, 'manifest_signed', machineActor(channel.config.identityId), { fileId: file.fileId, remotePath: path, sha256: file.contentHash });
    return path;
  },

  /** Anyone holding the public key can verify; the register also checks the key is one of ours. */
  async verifyManifest(doc) {
    const manifest = doc && doc.manifest;
    if (!manifest || !doc.signature) return { valid: false, reason: 'manifest and signature are required' };
    if (manifest.version !== MANIFEST_VERSION) return { valid: false, reason: `unsupported manifest version ${manifest.version}` };
    const { rows } = await pool.query('SELECT * FROM m2m_identities WHERE identity_id = $1', [manifest.identityId]);
    if (!rows.length) return { valid: false, reason: `identity ${manifest.identityId} is not in the keyring` };
    const identity = mapIdentity(rows[0]);
    if (identity.fingerprint !== manifest.fingerprint) return { valid: false, reason: 'fingerprint does not match the identity on record' };
    const valid = verifyCanonical(identity.publicKeyPem, manifest, doc.signature);
    return { valid, reason: valid ? null : 'signature does not verify', identityId: identity.identityId, fingerprint: identity.fingerprint, identityStatus: identity.status };
  },

  // ── Cycle ──────────────────────────────────────────────────────────────────

  /**
   * One unattended pass over every verified partner (or one named partner).
   * Transmits files people have approved, collects the bank's answers, and
   * records a heartbeat. A partner that fails is marked degraded and the pass
   * continues; nothing here throws for one bank's bad day.
   */
  async runCycle({ partnerId = null, actor = null } = {}) {
    const { MftOsEngine } = require('./mftOsEngine');
    const targets = partnerId ? [await this.partner(partnerId)] : (await this.partners()).filter(p => p.status === 'verified');
    const results = [];
    for (const partner of targets) {
      const who = actor || machineActor(partner.identityId);
      const r = { partnerId: partner.partnerId, channelId: partner.channelId, transmitted: [], skipped: [], collected: null, errors: [] };
      if (partner.status === 'suspended') { r.errors.push('partner is suspended'); results.push(r); continue; }
      if (partner.status !== 'verified') { r.errors.push(`partner is ${partner.status}; run a handshake first`); results.push(r); continue; }
      try {
        if (partner.policy.autoTransmit !== false) {
          const approved = await MftOsEngine.list({ channelId: partner.channelId, status: 'approved', limit: 200 });
          for (const file of approved) {
            try {
              const sent = await MftOsEngine.transmit(file.fileId, { actor: who });
              (sent.transmitted ? r.transmitted : r.skipped).push({ fileId: file.fileId, filename: file.filename, manifestPath: sent.manifestPath || null });
            } catch (err) {
              r.errors.push(`${file.fileId}: ${err.message}`);
            }
          }
        }
        if (partner.policy.collect !== false) r.collected = await MftOsEngine.collect(partner.channelId, { actor: who });
      } catch (err) {
        r.errors.push(err.message);
      }
      const degraded = r.errors.some(e => /failed|ECONN|timed out|not ready|cannot/i.test(e));
      await pool.query(
        `UPDATE m2m_partners SET last_cycle_at = NOW()${degraded ? ", status = 'degraded'" : ''} WHERE partner_id = $1`,
        [partner.partnerId]
      );
      await this._event(partner.partnerId, partner.identityId, degraded ? 'cycle_degraded' : 'cycle_completed', who, {
        transmitted: r.transmitted.length, skipped: r.skipped.length, errors: r.errors,
        acknowledged: r.collected ? r.collected.acknowledged.length : 0, rejected: r.collected ? r.collected.rejected.length : 0, returns: r.collected ? r.collected.returns.length : 0,
      });
      r.degraded = degraded;
      results.push(r);
    }
    return { at: new Date().toISOString(), partners: results };
  },

  /** Scheduler for the unattended cycle. Off unless M2M_CYCLE_INTERVAL_MS > 0. */
  startScheduler({ intervalMs = null, log = console } = {}) {
    const every = intervalMs === null ? getM2mConfig().cycleIntervalMs : intervalMs;
    this.stopScheduler();
    if (!every) return null;
    cycleTimer = setInterval(async () => {
      if (cycleRunning) return;
      cycleRunning = true;
      try {
        const out = await this.runCycle();
        const sent = out.partners.reduce((n, p) => n + p.transmitted.length, 0);
        if (out.partners.length) log.log(`[m2m-os] cycle: ${out.partners.length} partner(s), ${sent} file(s) transmitted`);
      } catch (err) {
        log.warn(`[m2m-os] cycle failed: ${err.message}`);
      } finally {
        cycleRunning = false;
      }
    }, every);
    if (typeof cycleTimer.unref === 'function') cycleTimer.unref();
    return every;
  },

  stopScheduler() {
    if (cycleTimer) clearInterval(cycleTimer);
    cycleTimer = null;
  },

  // ── Reporting ──────────────────────────────────────────────────────────────

  async events({ partnerId = null, identityId = null, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (partnerId) { params.push(partnerId); clauses.push(`partner_id = $${params.length}`); }
    if (identityId) { params.push(identityId); clauses.push(`identity_id = $${params.length}`); }
    params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
    const { rows } = await pool.query(
      `SELECT * FROM m2m_events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows.map(r => ({ eventId: r.event_id, partnerId: r.partner_id, identityId: r.identity_id, eventType: r.event_type, actor: r.actor, detail: parseJson(r.detail, {}), createdAt: r.created_at }));
  },

  async status() {
    const [identities, partners] = await Promise.all([this.identities(), this.partners()]);
    const cfg = getM2mConfig();
    return {
      engine: 'm2m-os',
      identities: { total: identities.length, active: identities.filter(i => i.status === 'active').length, staged: identities.filter(i => i.status === 'staged').length, retired: identities.filter(i => i.status === 'retired').length },
      partners: partners.map(p => ({ partnerId: p.partnerId, name: p.name, bankName: p.bankName, channelId: p.channelId, status: p.status, host: p.host, identityId: p.identityId, stagedIdentityId: p.stagedIdentityId, lastHandshakeAt: p.lastHandshakeAt, lastCycleAt: p.lastCycleAt, policy: p.policy })),
      scheduler: { running: Boolean(cycleTimer), intervalMs: cfg.cycleIntervalMs },
      policy: { keyBits: cfg.keyBits, manifestVersion: MANIFEST_VERSION, humanCredentials: 'never' },
    };
  },

  async _event(partnerId, identityId, eventType, actor, detail) {
    await pool.query(
      'INSERT INTO m2m_events (event_id, partner_id, identity_id, event_type, actor, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [newId('M2MEV'), partnerId, identityId, eventType, actor, JSON.stringify(detail || {})]
    );
  },
};

module.exports = { M2mOsEngine, M2mError, getM2mConfig, opensshPublicKey, generateIdentityKey, canonical, signCanonical, verifyCanonical, MANIFEST_VERSION, MANIFEST_SUFFIX };

'use strict';

/**
 * Host-to-host transport
 *
 * A session is deliberately tiny: list, read, write-then-commit, move, exists.
 * That is the whole vocabulary a bank file channel needs, and keeping it that
 * small is what lets the engine be tested against the local spool without a
 * second code path for "real" transmission.
 *
 * `put` never writes to the final name. It writes the staging name, fsyncs (or
 * lets SFTP close the handle), then renames — the bank's collector polls the
 * outbound directory, and a rename is the only way to hand it a file that is
 * either wholly there or not there at all. `commit` returns the final remote
 * path, and that return is the moment the idempotency vault treats the wire as
 * delivered.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { getWireChannelConfig } = require('./wireHostToHostConfig');

class WireTransportError extends Error {
  constructor(message, code = 'WIRE_H2H_TRANSPORT', status = 502) {
    super(message);
    this.name = 'WireTransportError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function fingerprintHostKey(key) {
  const digest = crypto.createHash('sha256').update(key).digest();
  return {
    base64: digest.toString('base64').replace(/=+$/, ''),
    hex: digest.toString('hex'),
  };
}

function hostKeyMatches(key, expected) {
  const { base64, hex } = fingerprintHostKey(key);
  const wanted = String(expected).trim().replace(/^SHA256:/i, '').replace(/:/g, '').replace(/=+$/, '').toLowerCase();
  return wanted === base64.toLowerCase() || wanted === hex.toLowerCase();
}

/** The bank host over SFTP. */
class SftpSession {
  constructor(conn, sftp, config) {
    this._conn = conn;
    this._sftp = sftp;
    this._config = config;
  }

  static async open(config) {
    const { Client } = require('ssh2');
    const auth = { host: config.host, port: config.port, username: config.username, readyTimeout: config.connectTimeoutMs };
    if (config.privateKeyPath) auth.privateKey = await fsp.readFile(config.privateKeyPath);
    else if (config.privateKey) auth.privateKey = config.privateKey;
    else auth.password = config.password;
    if (config.passphrase) auth.passphrase = config.passphrase;

    if (config.hostKeyFingerprint) {
      auth.hostVerifier = key => hostKeyMatches(key, config.hostKeyFingerprint);
    } else if (!config.allowUnknownHostKey) {
      throw new WireTransportError(
        'The bank host key is not pinned; set WIRE_H2H_SFTP_HOST_KEY_FINGERPRINT before transmitting wires',
        'WIRE_H2H_UNPINNED_HOST',
        412
      );
    }

    const conn = new Client();
    const sftp = await new Promise((resolve, reject) => {
      conn.on('ready', () => conn.sftp((err, handle) => (err ? reject(err) : resolve(handle))));
      conn.on('error', err => reject(new WireTransportError(`SFTP connection to ${config.host} failed: ${err.message}`)));
      conn.connect(auth);
    });
    return new SftpSession(conn, sftp, config);
  }

  _call(method, ...args) {
    return new Promise((resolve, reject) => {
      this._sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  async list(remoteDir) {
    try {
      const entries = await this._call('readdir', remoteDir);
      return entries
        .filter(entry => entry.attrs && entry.attrs.isFile())
        .map(entry => ({ name: entry.filename, size: entry.attrs.size, modifiedAt: new Date(entry.attrs.mtime * 1000) }));
    } catch (err) {
      if (err && (err.code === 2 || /no such file/i.test(err.message))) return [];
      throw err;
    }
  }

  async read(remotePath) {
    const buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const stream = this._sftp.createReadStream(remotePath);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
    return buffer.toString('utf8');
  }

  async exists(remotePath) {
    try {
      await this._call('stat', remotePath);
      return true;
    } catch {
      return false;
    }
  }

  async mkdirp(remoteDir) {
    const parts = String(remoteDir).split('/').filter(Boolean);
    let current = remoteDir.startsWith('/') ? '' : '.';
    for (const part of parts) {
      current = `${current}/${part}`;
      try { await this._call('mkdir', current); } catch { /* already there, or not ours to create */ }
    }
  }

  async put(remoteDir, filename, content) {
    await this.mkdirp(remoteDir);
    const staging = `${remoteDir}/${filename}${this._config.stagingSuffix}`;
    const final = `${remoteDir}/${filename}`;
    await new Promise((resolve, reject) => {
      const stream = this._sftp.createWriteStream(staging);
      stream.on('error', reject);
      stream.on('close', resolve);
      stream.end(Buffer.from(content, 'utf8'));
    });
    await this._call('rename', staging, final);
    return final;
  }

  async move(fromPath, toDir, filename) {
    await this.mkdirp(toDir);
    const target = `${toDir}/${filename}`;
    await this._call('rename', fromPath, target);
    return target;
  }

  async close() {
    try { this._conn.end(); } catch { /* connection already gone */ }
  }
}

/**
 * The local spool. Same directory layout, same staging-then-rename semantics,
 * so an operator can generate and reconcile a real file set on a machine with
 * no bank connectivity.
 */
class SpoolSession {
  constructor(config) {
    this._config = config;
  }

  static async open(config) {
    await fsp.mkdir(config.spoolDir, { recursive: true });
    return new SpoolSession(config);
  }

  _local(remotePath) {
    return path.join(this._config.spoolDir, String(remotePath).replace(/^\/+/, ''));
  }

  async list(remoteDir) {
    const dir = this._local(remoteDir);
    let names;
    try { names = await fsp.readdir(dir); } catch { return []; }
    const entries = [];
    for (const name of names) {
      const stat = await fsp.stat(path.join(dir, name));
      if (stat.isFile()) entries.push({ name, size: stat.size, modifiedAt: stat.mtime });
    }
    return entries;
  }

  async read(remotePath) {
    return fsp.readFile(this._local(remotePath), 'utf8');
  }

  async exists(remotePath) {
    return fs.existsSync(this._local(remotePath));
  }

  async put(remoteDir, filename, content) {
    const dir = this._local(remoteDir);
    await fsp.mkdir(dir, { recursive: true });
    const staging = path.join(dir, `${filename}${this._config.stagingSuffix}`);
    await fsp.writeFile(staging, content, 'utf8');
    await fsp.rename(staging, path.join(dir, filename));
    return `${remoteDir}/${filename}`;
  }

  async move(fromPath, toDir, filename) {
    const target = this._local(`${toDir}/${filename}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(this._local(fromPath), target);
    return `${toDir}/${filename}`;
  }

  async close() {
    return true;
  }
}

/** Open whichever transport the channel is configured for. */
async function openWireTransport(config = getWireChannelConfig()) {
  return config.transport === 'sftp' ? SftpSession.open(config) : SpoolSession.open(config);
}

/** Run one unit of work against a transport and always hang up afterwards. */
async function withWireTransport(fn, config = getWireChannelConfig()) {
  const session = await openWireTransport(config);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

module.exports = {
  openWireTransport,
  withWireTransport,
  SftpSession,
  SpoolSession,
  WireTransportError,
  fingerprintHostKey,
  hostKeyMatches,
};

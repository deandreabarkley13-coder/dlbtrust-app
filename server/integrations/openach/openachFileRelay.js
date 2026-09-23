'use strict';

/**
 * OpenACH -> ODFI file relay.
 *
 * OpenACH's `cronnightly` job (infra/gcp/openach_cron.tf) builds NACHA files
 * with the Manual bank plugin, which writes them to `export/` in the GCS
 * bucket mounted at its runtime directory. This relay lists those files and
 * delivers each one to the ODFI through the trust's MFT Gateway AS2 station
 * (MFTGATEWAY_PARTNER_AS2_ID = the ODFI's AS2 partner registered on
 * mftgateway.com). Delivered files are moved to `sent/`, failures to
 * `failed/`, and every attempt is journalled in openach_file_relays.
 *
 *   OPENACH_ACH_FILES_BUCKET      GCS bucket (required to enable the relay)
 *   OPENACH_ACH_FILES_PREFIX      folder inside the bucket, default "export/"
 *   OPENACH_FILE_RELAY_INTERVAL_MS  in-process scheduler cadence (0 = off)
 *
 * Fail-closed: without a bucket, MFT Gateway credentials or a partner the
 * relay reports itself unready and never touches the bucket.
 */

const { MftGatewayClient } = require('../edi/mftGatewayClient');
const google = require('../google/googleServiceAccount');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const STORAGE_API = 'https://storage.googleapis.com/storage/v1';

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function enc(s) { return encodeURIComponent(s); }

class OpenAchFileRelay {
  static getConfig() {
    let prefix = str('OPENACH_ACH_FILES_PREFIX', 'export/').replace(/^\/+/, '');
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    return {
      bucket: str('OPENACH_ACH_FILES_BUCKET'),
      prefix,
      sentPrefix: 'sent/',
      failedPrefix: 'failed/',
      stationAs2Id: MftGatewayClient.getConfig().stationAs2Id,
      partnerAs2Id: MftGatewayClient.getConfig().partnerAs2Id,
    };
  }

  static status() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.bucket) issues.push('OPENACH_ACH_FILES_BUCKET not configured');
    issues.push(...MftGatewayClient.issues());
    return {
      ready: issues.length === 0,
      bucket: cfg.bucket || null,
      prefix: cfg.prefix,
      transport: 'mftgateway',
      stationAs2Id: cfg.stationAs2Id || null,
      partnerAs2Id: cfg.partnerAs2Id || null,
      issues,
    };
  }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS openach_file_relays (
        id BIGSERIAL PRIMARY KEY,
        object_name TEXT NOT NULL,
        bytes INTEGER,
        partner_as2_id TEXT,
        status TEXT NOT NULL,
        message_id TEXT,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  static async _token() {
    const sa = google.onGoogleRuntime() ? null : google.loadServiceAccount();
    return google.getAccessToken(sa, STORAGE_SCOPE);
  }

  static async listPending() {
    const cfg = this.getConfig();
    const token = await this._token();
    const url = `${STORAGE_API}/b/${enc(cfg.bucket)}/o?prefix=${enc(cfg.prefix)}&fields=items(name,size,updated)`;
    const res = await google.googleFetch('GET', url, token);
    if (!res.ok) throw new Error(`GCS list failed (${res.statusCode}): ${res.text.slice(0, 200)}`);
    const items = (res.json && res.json.items) || [];
    return items
      .filter((o) => /\.ach$/i.test(o.name))
      .map((o) => ({ name: o.name, bytes: Number(o.size), updated: o.updated }));
  }

  static async _download(name) {
    const cfg = this.getConfig();
    const token = await this._token();
    const res = await fetch(`${STORAGE_API}/b/${enc(cfg.bucket)}/o/${enc(name)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`GCS download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  static async _move(name, destPrefix) {
    const cfg = this.getConfig();
    const token = await this._token();
    const base = name.slice(cfg.prefix.length);
    const dest = `${destPrefix}${new Date().toISOString().replace(/[:.]/g, '-')}-${base}`;
    const copy = await google.googleFetch('POST', `${STORAGE_API}/b/${enc(cfg.bucket)}/o/${enc(name)}/rewriteTo/b/${enc(cfg.bucket)}/o/${enc(dest)}`, token, {});
    if (!copy.ok) throw new Error(`GCS copy failed (${copy.statusCode})`);
    const del = await google.googleFetch('DELETE', `${STORAGE_API}/b/${enc(cfg.bucket)}/o/${enc(name)}`, token);
    if (!del.ok && del.statusCode !== 404) throw new Error(`GCS delete failed (${del.statusCode})`);
    return dest;
  }

  static async _journal(row) {
    if (!pool) return;
    try {
      await this.ensureTables();
      await pool.query(
        'INSERT INTO openach_file_relays (object_name, bytes, partner_as2_id, status, message_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.object_name, row.bytes || null, row.partner_as2_id || null, row.status, row.message_id || null, row.detail || null]
      );
    } catch (e) {
      console.warn('[openach-relay] journal:', e.message);
    }
  }

  /** Deliver every pending NACHA file. Returns per-file results. */
  static async run() {
    const status = this.status();
    if (!status.ready) {
      return { ready: false, delivered: 0, failed: 0, files: [], issues: status.issues };
    }
    const cfg = this.getConfig();
    const pending = await this.listPending();
    const files = [];
    for (const file of pending) {
      const filename = file.name.slice(cfg.prefix.length);
      try {
        const payload = await this._download(file.name);
        if (!payload.length) throw new Error('empty file');
        const result = await MftGatewayClient.submit(payload, filename, {
          stationAs2Id: cfg.stationAs2Id,
          partnerAs2Id: cfg.partnerAs2Id,
          contentType: 'text/plain',
          subject: `NACHA ${filename}`,
        });
        if (!result.success) {
          throw new Error(`MFT Gateway ${result.status_code}: ${result.response_body || 'submit rejected'}`);
        }
        const moved = await this._move(file.name, cfg.sentPrefix);
        await this._journal({ object_name: file.name, bytes: payload.length, partner_as2_id: cfg.partnerAs2Id, status: 'sent', message_id: result.message_id, detail: moved });
        files.push({ object: file.name, file: filename, status: 'delivered', message_id: result.message_id, bytes: payload.length, moved_to: moved });
        console.log(`[openach-relay] ${filename} -> ${cfg.partnerAs2Id} via MFT Gateway (${result.message_id})`);
      } catch (e) {
        let moved = null;
        try { moved = await this._move(file.name, cfg.failedPrefix); } catch (moveErr) { console.warn('[openach-relay] move failed:', moveErr.message); }
        await this._journal({ object_name: file.name, bytes: file.bytes, partner_as2_id: cfg.partnerAs2Id, status: 'failed', detail: `${e.message}${moved ? ` (moved to ${moved})` : ''}` });
        files.push({ object: file.name, file: filename, status: 'failed', error: e.message, moved_to: moved });
        console.warn(`[openach-relay] ${filename} failed:`, e.message);
      }
    }
    return {
      ready: true,
      delivered: files.filter((f) => f.status === 'delivered').length,
      failed: files.filter((f) => f.status === 'failed').length,
      files,
      issues: [],
    };
  }

  static async history(limit = 50) {
    if (!pool) return [];
    await this.ensureTables();
    const r = await pool.query('SELECT * FROM openach_file_relays ORDER BY id DESC LIMIT $1', [Math.min(Number(limit) || 50, 500)]);
    return r.rows;
  }
}

module.exports = { OpenAchFileRelay };

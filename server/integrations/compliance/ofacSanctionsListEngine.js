'use strict';

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const OFAC_HOST = 'https://sanctionslistservice.ofac.treas.gov';
const OFAC_API = `${OFAC_HOST}/api/PublicationPreview`;
const USER_AGENT = 'DLBTrust-Compliance/1.0';
const REQUIRED_FILES = [
  { key: 'sdn-primary', catalog: 'SdnList', fileName: 'SDN.CSV', nameIndex: 1, idIndexes: [0], primary: true, minimumEntries: 1000 },
  { key: 'sdn-alias', catalog: 'SdnList', fileName: 'ALT.CSV', nameIndex: 3, idIndexes: [0, 1], primary: false },
  { key: 'consolidated-primary', catalog: 'ConsolidatedList', fileName: 'CONS_PRIM.CSV', nameIndex: 1, idIndexes: [0], primary: true, minimumEntries: 100 },
  { key: 'consolidated-alias', catalog: 'ConsolidatedList', fileName: 'CONS_ALT.CSV', nameIndex: 3, idIndexes: [0, 1], primary: false },
];

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value.trim());
  return values;
}

function parseEntries(text, file) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseCsvLine)
    .map((columns) => {
      const name = columns[file.nameIndex];
      const normalized = normalizeName(name);
      if (!normalized || name === '-0-') return null;
      return {
        listKey: file.key,
        entryUid: file.idIndexes.map((index) => columns[index]).join(':'),
        name,
        normalizedName: normalized,
        sourceFile: file.fileName,
        isAlias: !file.primary,
        aliasType: file.primary ? null : (columns[2] || null),
      };
    })
    .filter(Boolean);
}

function maxAgeHours() {
  const configured = Number.parseInt(process.env.COMPLIANCE_OFAC_MAX_AGE_HOURS || '48', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 48;
}

function normalizeDigest(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

class OfacSanctionsListEngine {
  static _cache = null;

  static _cacheVersion = null;

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compliance_sanctions_lists (
        list_key TEXT PRIMARY KEY,
        source_file TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_updated_at TIMESTAMPTZ,
        refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        entry_count INTEGER NOT NULL DEFAULT 0,
        digest TEXT
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS compliance_sanctions_entries (
        id BIGSERIAL PRIMARY KEY,
        list_key TEXT NOT NULL REFERENCES compliance_sanctions_lists(list_key) ON DELETE CASCADE,
        entry_uid TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        source_file TEXT NOT NULL,
        is_alias BOOLEAN NOT NULL DEFAULT false,
        alias_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (list_key, entry_uid, normalized_name)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_sanctions_normalized_name ON compliance_sanctions_entries(normalized_name)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_sanctions_list_key ON compliance_sanctions_entries(list_key)');
  }

  static async _fetchJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(Number(process.env.COMPLIANCE_OFAC_TIMEOUT_MS || 60000)),
    });
    if (!response.ok) throw new Error(`OFAC request failed: ${response.status} ${response.statusText}`);
    return response.json();
  }

  static async _fetchText(url) {
    const response = await fetch(url, {
      headers: { Accept: 'text/csv', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(Number(process.env.COMPLIANCE_OFAC_TIMEOUT_MS || 60000)),
    });
    if (!response.ok) throw new Error(`OFAC download failed: ${response.status} ${response.statusText}`);
    const text = await response.text();
    if (!text.trim()) throw new Error(`OFAC download was empty: ${url}`);
    return {
      text,
      digest: response.headers.get('digest'),
      lastModified: response.headers.get('last-modified'),
    };
  }

  static async _catalog(catalog) {
    const rows = await this._fetchJson(`${OFAC_API}/${catalog}`, {
      method: 'POST',
      body: '{}',
    });
    if (!Array.isArray(rows)) throw new Error(`Unexpected OFAC ${catalog} response`);
    return rows;
  }

  static async _downloadFile(file, catalogs) {
    const catalog = catalogs[file.catalog] || [];
    const metadata = catalog.find((row) => String(row.fileName).toUpperCase() === file.fileName);
    if (!metadata) throw new Error(`OFAC catalog is missing ${file.fileName}`);
    const sourceUrl = `${OFAC_API}/exports/${encodeURIComponent(file.fileName)}`;
    const download = await this._fetchText(sourceUrl);
    const entries = parseEntries(download.text, file);
    const minimum = file.minimumEntries || 1;
    if (entries.length < minimum) {
      throw new Error(`OFAC ${file.fileName} contained only ${entries.length} entries`);
    }
    return {
      file,
      entries,
      sourceUrl,
      sourceUpdatedAt: metadata.lastUpdated || download.lastModified || null,
      digest: normalizeDigest(download.digest || metadata.hashCodes),
    };
  }

  static async _insertEntries(client, entries) {
    const size = 500;
    for (let offset = 0; offset < entries.length; offset += size) {
      const chunk = entries.slice(offset, offset + size);
      const params = [];
      const values = chunk.map((entry, rowIndex) => {
        const base = rowIndex * 7;
        params.push(
          entry.listKey,
          entry.entryUid,
          entry.name,
          entry.normalizedName,
          entry.sourceFile,
          entry.isAlias,
          entry.aliasType
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
      });
      await client.query(
        `INSERT INTO compliance_sanctions_entries
           (list_key, entry_uid, name, normalized_name, source_file, is_alias, alias_type)
         VALUES ${values.join(',')}
         ON CONFLICT (list_key, entry_uid, normalized_name) DO NOTHING`,
        params
      );
    }
  }

  static async refresh() {
    if (!pool) throw new Error('Database pool not available for OFAC sanctions lists');
    await this.ensureTables();
    const [sdnCatalog, consolidatedCatalog] = await Promise.all([
      this._catalog('SdnList'),
      this._catalog('ConsolidatedList'),
    ]);
    const catalogs = { SdnList: sdnCatalog, ConsolidatedList: consolidatedCatalog };
    const downloads = await Promise.all(
      REQUIRED_FILES.map((file) => this._downloadFile(file, catalogs))
    );

    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    try {
      await client.query('BEGIN');
      for (const download of downloads) {
        await client.query(
          `INSERT INTO compliance_sanctions_lists
             (list_key, source_file, source_url, source_updated_at, refreshed_at, entry_count, digest)
           VALUES ($1,$2,$3,$4,NOW(),$5,$6)
           ON CONFLICT (list_key) DO UPDATE SET
             source_file=EXCLUDED.source_file,
             source_url=EXCLUDED.source_url,
             source_updated_at=EXCLUDED.source_updated_at,
             refreshed_at=NOW(),
             entry_count=EXCLUDED.entry_count,
             digest=EXCLUDED.digest`,
          [
            download.file.key,
            download.file.fileName,
            download.sourceUrl,
            download.sourceUpdatedAt,
            download.entries.length,
            download.digest,
          ]
        );
        await client.query('DELETE FROM compliance_sanctions_entries WHERE list_key = $1', [download.file.key]);
        await this._insertEntries(client, download.entries);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      if (client !== pool && typeof client.release === 'function') client.release();
    }

    this._cache = downloads.flatMap((download) => download.entries);
    this._cacheVersion = await this._databaseVersion();
    return this.readiness();
  }

  static async readiness() {
    if (!pool) {
      return {
        ready: false,
        provider: 'ofac',
        entryCount: 0,
        issues: ['Database pool not available for OFAC sanctions lists'],
      };
    }
    await this.ensureTables();
    const result = await pool.query(
      `SELECT list_key, source_file, source_url, source_updated_at, refreshed_at, entry_count, digest
       FROM compliance_sanctions_lists
       ORDER BY list_key`
    );
    const lists = result.rows || [];
    const issues = [];
    const missing = REQUIRED_FILES.filter((file) => !lists.some((list) => list.list_key === file.key));
    if (missing.length) issues.push(`Missing OFAC files: ${missing.map((file) => file.fileName).join(', ')}`);
    const empty = lists.filter((list) => Number(list.entry_count || 0) <= 0);
    if (empty.length) issues.push(`Empty OFAC files: ${empty.map((list) => list.source_file).join(', ')}`);
    const entryCount = lists.reduce((sum, list) => sum + Number(list.entry_count || 0), 0);
    if (entryCount <= 0) issues.push('OFAC sanctions list contains no entries');
    const oldestRefresh = lists.reduce((oldest, list) => {
      const value = list.refreshed_at ? new Date(list.refreshed_at).getTime() : 0;
      return oldest === null || value < oldest ? value : oldest;
    }, null);
    const ageHours = oldestRefresh ? (Date.now() - oldestRefresh) / 3600000 : null;
    if (ageHours === null || ageHours > maxAgeHours()) {
      issues.push(`OFAC sanctions list is missing or older than ${maxAgeHours()} hours`);
    }
    return {
      ready: issues.length === 0,
      provider: 'ofac',
      source: 'US Treasury OFAC Sanctions List Service',
      entryCount,
      maxAgeHours: maxAgeHours(),
      ageHours,
      lists,
      issues,
    };
  }

  static async refreshIfStale() {
    const status = await this.readiness();
    if (status.ready) return status;
    return this.refresh();
  }

  static async _databaseVersion() {
    const result = await pool.query(
      `SELECT COUNT(*)::integer AS list_count,
              COALESCE(SUM(entry_count), 0)::bigint AS entry_count,
              MIN(refreshed_at) AS oldest_refresh,
              MAX(refreshed_at) AS newest_refresh
       FROM compliance_sanctions_lists`
    );
    const row = result.rows[0] || {};
    const timestamp = (value) => value ? new Date(value).toISOString() : null;
    return JSON.stringify([
      Number(row.list_count || 0),
      String(row.entry_count || 0),
      timestamp(row.oldest_refresh),
      timestamp(row.newest_refresh),
    ]);
  }

  static async _loadCache() {
    if (!pool) return [];
    await this.ensureTables();
    const databaseVersion = await this._databaseVersion();
    if (this._cache && this._cacheVersion === databaseVersion) return this._cache;
    const result = await pool.query(
      `SELECT list_key, entry_uid, name, normalized_name, source_file, is_alias, alias_type
       FROM compliance_sanctions_entries`
    );
    this._cache = result.rows.map((row) => ({
      listKey: row.list_key,
      entryUid: row.entry_uid,
      name: row.name,
      normalizedName: row.normalized_name,
      sourceFile: row.source_file,
      isAlias: row.is_alias,
      aliasType: row.alias_type,
    }));
    this._cacheVersion = databaseVersion;
    return this._cache;
  }

  static _similarity(input, target) {
    if (input === target) return 1;
    if (input.length < 8 || target.length < 8) return 0;
    const inputTokens = input.split(' ');
    const targetTokens = target.split(' ');
    const tokenCounts = (tokens) => tokens.reduce((counts, token) => {
      counts.set(token, (counts.get(token) || 0) + 1);
      return counts;
    }, new Map());
    const containsTokens = (container, candidate) => {
      const available = tokenCounts(container);
      return Array.from(tokenCounts(candidate).entries())
        .every(([token, count]) => (available.get(token) || 0) >= count);
    };
    if (containsTokens(inputTokens, targetTokens) || containsTokens(targetTokens, inputTokens)) {
      return inputTokens.length === targetTokens.length ? 0.96 : 0.92;
    }
    if (Math.abs(input.length - target.length) > 3) return 0;
    const longer = Math.max(input.length, target.length);
    const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
    for (let inputIndex = 1; inputIndex <= input.length; inputIndex += 1) {
      let diagonal = previous[0];
      previous[0] = inputIndex;
      for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
        const above = previous[targetIndex];
        const cost = input[inputIndex - 1] === target[targetIndex - 1] ? 0 : 1;
        previous[targetIndex] = Math.min(
          previous[targetIndex] + 1,
          previous[targetIndex - 1] + 1,
          diagonal + cost
        );
        diagonal = above;
      }
    }
    return 1 - (previous[target.length] / longer);
  }

  static async screenName(name) {
    const normalized = normalizeName(name);
    if (!normalized) return null;
    const entries = await this._loadCache();
    let best = null;
    for (const entry of entries) {
      const similarity = this._similarity(normalized, entry.normalizedName);
      if (similarity >= 0.88 && (!best || similarity > best.similarity)) {
        best = { ...entry, similarity };
        if (similarity === 1) break;
      }
    }
    return best;
  }
}

module.exports = {
  OfacSanctionsListEngine,
  normalizeName,
  parseCsvLine,
  parseEntries,
};

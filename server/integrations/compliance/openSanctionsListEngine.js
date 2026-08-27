'use strict';

/**
 * OpenSanctions sanctions list engine.
 *
 * Ingests an OpenSanctions dataset (default: the "sanctions" consolidated
 * dataset, https://www.opensanctions.org/datasets/sanctions/) into the shared
 * compliance_sanctions_* tables, so screening can run against a consolidated
 * international list rather than OFAC alone.
 *
 * The bulk `targets.simple.csv` export is streamed and parsed incrementally:
 * the file is ~70MB and must never be buffered in memory in full.
 *
 * Screening is executed in PostgreSQL (exact normalized match, then a bounded
 * candidate set scored with the shared similarity function) because the dataset
 * holds ~300k names — too many to cache in the application process.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const { normalizeName, nameSimilarity } = require('./nameMatching');

const PROVIDER = 'opensanctions';
const USER_AGENT = 'DLBTrust-Compliance/1.0';
const PRIMARY_LIST_SUFFIX = 'primary';
const ALIAS_LIST_SUFFIX = 'alias';
const BULK_RESOURCE = 'targets.simple.csv';
const MATCH_THRESHOLD = 0.88;
const CANDIDATE_LIMIT = 500;

function baseUrl() {
  return (process.env.COMPLIANCE_OPENSANCTIONS_BASE_URL || 'https://data.opensanctions.org')
    .replace(/\/+$/, '');
}

function datasetName() {
  return (process.env.COMPLIANCE_OPENSANCTIONS_DATASET || 'sanctions').trim();
}

function listKey(suffix) {
  return `${PROVIDER}:${datasetName()}:${suffix}`;
}

function requestTimeoutMs() {
  const configured = Number.parseInt(process.env.COMPLIANCE_OPENSANCTIONS_TIMEOUT_MS || '600000', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 600000;
}

function maxAgeHours() {
  const configured = Number.parseInt(process.env.COMPLIANCE_OPENSANCTIONS_MAX_AGE_HOURS || '48', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 48;
}

function minimumTargets() {
  const configured = Number.parseInt(process.env.COMPLIANCE_OPENSANCTIONS_MIN_TARGETS || '5000', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 5000;
}

function authHeaders() {
  const apiKey = process.env.COMPLIANCE_OPENSANCTIONS_API_KEY;
  return apiKey ? { Authorization: `ApiKey ${apiKey}` } : {};
}

/**
 * Incremental RFC4180 parser: feed it text chunks, get back complete records.
 * Quoted fields may span chunks and contain commas and newlines (addresses do).
 */
function createCsvRecordParser() {
  let field = '';
  let record = [];
  let quoted = false;
  let quoteJustClosed = false;

  return function consume(chunk) {
    const records = [];
    for (const char of chunk) {
      if (quoted) {
        if (quoteJustClosed) {
          quoteJustClosed = false;
          if (char === '"') { field += '"'; continue; }
          quoted = false;
          // fall through and handle char as unquoted
        } else if (char === '"') {
          quoteJustClosed = true;
          continue;
        } else {
          field += char;
          continue;
        }
      }
      if (char === '"' && field === '') { quoted = true; continue; }
      if (char === ',') { record.push(field); field = ''; continue; }
      if (char === '\n') {
        record.push(field.replace(/\r$/, ''));
        records.push(record);
        record = [];
        field = '';
        continue;
      }
      field += char;
    }
    return records;
  };
}

function splitAliases(value) {
  return String(value || '')
    .split(';')
    .map((alias) => alias.trim())
    .filter(Boolean);
}

class OpenSanctionsListEngine {
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

  static async _datasetIndex() {
    const url = `${baseUrl()}/datasets/latest/${encodeURIComponent(datasetName())}/index.json`;
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...authHeaders() },
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
    if (!response.ok) {
      throw new Error(`OpenSanctions index request failed: ${response.status} ${response.statusText}`);
    }
    const index = await response.json();
    const resource = (index.resources || []).find((entry) => entry.name === BULK_RESOURCE);
    if (!resource || !resource.url) {
      throw new Error(`OpenSanctions dataset ${datasetName()} does not publish ${BULK_RESOURCE}`);
    }
    return {
      version: index.version || null,
      lastChange: index.last_change || index.last_export || null,
      targetCount: Number(index.target_count || 0),
      resourceUrl: resource.url,
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

  /**
   * Streams targets.simple.csv, calling onEntries with batches of parsed rows.
   * Returns the number of target (primary) rows seen.
   */
  static async _streamTargets(resourceUrl, onEntries) {
    const response = await fetch(resourceUrl, {
      redirect: 'follow',
      headers: { Accept: 'text/csv', 'User-Agent': USER_AGENT, ...authHeaders() },
      signal: AbortSignal.timeout(requestTimeoutMs()),
    });
    if (!response.ok || !response.body) {
      throw new Error(`OpenSanctions download failed: ${response.status} ${response.statusText}`);
    }

    const consume = createCsvRecordParser();
    const decoder = new TextDecoder('utf-8');
    let header = null;
    let columns = {};
    let targetCount = 0;
    let batch = [];

    const flush = async (force) => {
      if (batch.length && (force || batch.length >= 2000)) {
        await onEntries(batch);
        batch = [];
      }
    };

    const handleRecord = (record) => {
      if (!header) {
        header = record.map((column) => column.trim().toLowerCase());
        columns = {
          id: header.indexOf('id'),
          name: header.indexOf('name'),
          aliases: header.indexOf('aliases'),
          schema: header.indexOf('schema'),
          countries: header.indexOf('countries'),
        };
        if (columns.id < 0 || columns.name < 0) {
          throw new Error(`Unexpected ${BULK_RESOURCE} header: ${header.join(',')}`);
        }
        return;
      }
      const entityId = record[columns.id];
      const name = record[columns.name];
      if (!entityId || !name) return;
      const normalized = normalizeName(name);
      if (!normalized) return;
      targetCount += 1;
      batch.push({
        listKey: listKey(PRIMARY_LIST_SUFFIX),
        entryUid: entityId,
        name,
        normalizedName: normalized,
        sourceFile: BULK_RESOURCE,
        isAlias: false,
        aliasType: null,
      });
      if (columns.aliases >= 0) {
        for (const alias of splitAliases(record[columns.aliases])) {
          const normalizedAlias = normalizeName(alias);
          if (!normalizedAlias || normalizedAlias === normalized) continue;
          batch.push({
            listKey: listKey(ALIAS_LIST_SUFFIX),
            entryUid: entityId,
            name: alias,
            normalizedName: normalizedAlias,
            sourceFile: BULK_RESOURCE,
            isAlias: true,
            aliasType: 'alias',
          });
        }
      }
    };

    for await (const chunk of response.body) {
      for (const record of consume(decoder.decode(chunk, { stream: true }))) {
        handleRecord(record);
      }
      await flush(false);
    }
    for (const record of consume(decoder.decode())) handleRecord(record);
    await flush(true);

    return targetCount;
  }

  static async refresh() {
    if (!pool) throw new Error('Database pool not available for OpenSanctions lists');
    if (typeof pool.connect !== 'function') {
      throw new Error('A dedicated client is required to refresh OpenSanctions lists');
    }
    await this.ensureTables();
    const index = await this._datasetIndex();

    const client = await pool.connect();
    let counts = { [listKey(PRIMARY_LIST_SUFFIX)]: 0, [listKey(ALIAS_LIST_SUFFIX)]: 0 };
    try {
      await client.query('BEGIN');
      for (const suffix of [PRIMARY_LIST_SUFFIX, ALIAS_LIST_SUFFIX]) {
        await client.query(
          `INSERT INTO compliance_sanctions_lists
             (list_key, source_file, source_url, source_updated_at, refreshed_at, entry_count, digest)
           VALUES ($1,$2,$3,$4,NOW(),0,$5)
           ON CONFLICT (list_key) DO UPDATE SET
             source_file=EXCLUDED.source_file,
             source_url=EXCLUDED.source_url,
             source_updated_at=EXCLUDED.source_updated_at,
             refreshed_at=NOW(),
             entry_count=0,
             digest=EXCLUDED.digest`,
          [listKey(suffix), BULK_RESOURCE, index.resourceUrl, index.lastChange, index.version]
        );
        await client.query('DELETE FROM compliance_sanctions_entries WHERE list_key = $1', [listKey(suffix)]);
      }

      const targetCount = await this._streamTargets(index.resourceUrl, async (entries) => {
        for (const entry of entries) counts[entry.listKey] = (counts[entry.listKey] || 0) + 1;
        await this._insertEntries(client, entries);
      });

      if (targetCount < minimumTargets()) {
        throw new Error(
          `OpenSanctions ${datasetName()} returned only ${targetCount} targets (minimum ${minimumTargets()})`
        );
      }

      for (const [key, count] of Object.entries(counts)) {
        await client.query(
          'UPDATE compliance_sanctions_lists SET entry_count = $2, refreshed_at = NOW() WHERE list_key = $1',
          [key, count]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return this.readiness();
  }

  static async readiness() {
    if (!pool) {
      return {
        ready: false,
        provider: PROVIDER,
        entryCount: 0,
        issues: ['Database pool not available for OpenSanctions lists'],
      };
    }
    await this.ensureTables();
    const result = await pool.query(
      `SELECT list_key, source_file, source_url, source_updated_at, refreshed_at, entry_count, digest
       FROM compliance_sanctions_lists
       WHERE list_key = ANY($1)
       ORDER BY list_key`,
      [[listKey(PRIMARY_LIST_SUFFIX), listKey(ALIAS_LIST_SUFFIX)]]
    );
    const lists = result.rows || [];
    const issues = [];
    const primary = lists.find((list) => list.list_key === listKey(PRIMARY_LIST_SUFFIX));
    if (!primary) {
      issues.push(`OpenSanctions dataset ${datasetName()} has never been ingested`);
    } else if (Number(primary.entry_count || 0) < minimumTargets()) {
      issues.push(
        `OpenSanctions dataset ${datasetName()} holds ${Number(primary.entry_count || 0)} targets (minimum ${minimumTargets()})`
      );
    }
    const entryCount = lists.reduce((sum, list) => sum + Number(list.entry_count || 0), 0);
    const oldestRefresh = lists.reduce((oldest, list) => {
      const value = list.refreshed_at ? new Date(list.refreshed_at).getTime() : 0;
      return oldest === null || value < oldest ? value : oldest;
    }, null);
    const ageHours = oldestRefresh ? (Date.now() - oldestRefresh) / 3600000 : null;
    if (ageHours === null || ageHours > maxAgeHours()) {
      issues.push(`OpenSanctions data is missing or older than ${maxAgeHours()} hours`);
    }
    return {
      ready: issues.length === 0,
      provider: PROVIDER,
      source: `OpenSanctions ${datasetName()} dataset`,
      dataset: datasetName(),
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

  static async screenName(name) {
    const normalized = normalizeName(name);
    if (!normalized || !pool) return null;
    await this.ensureTables();
    const keys = [listKey(PRIMARY_LIST_SUFFIX), listKey(ALIAS_LIST_SUFFIX)];

    const exact = await pool.query(
      `SELECT list_key, entry_uid, name, normalized_name, source_file, is_alias, alias_type
       FROM compliance_sanctions_entries
       WHERE list_key = ANY($1) AND normalized_name = $2
       LIMIT 1`,
      [keys, normalized]
    );
    if (exact.rows[0]) return this._toMatch(exact.rows[0], 1);

    // Bounded candidate set: any entry sharing the longest token of the input.
    const tokens = normalized.split(' ').filter((token) => token.length >= 4);
    if (!tokens.length) return null;
    const longest = tokens.reduce((best, token) => (token.length > best.length ? token : best), '');
    const candidates = await pool.query(
      `SELECT list_key, entry_uid, name, normalized_name, source_file, is_alias, alias_type
       FROM compliance_sanctions_entries
       WHERE list_key = ANY($1)
         AND (normalized_name = $2
              OR normalized_name LIKE $3
              OR normalized_name LIKE $4
              OR normalized_name LIKE $5)
       LIMIT $6`,
      [keys, longest, `${longest} %`, `% ${longest}`, `% ${longest} %`, CANDIDATE_LIMIT]
    );

    let best = null;
    for (const row of candidates.rows) {
      const similarity = nameSimilarity(normalized, row.normalized_name);
      if (similarity >= MATCH_THRESHOLD && (!best || similarity > best.similarity)) {
        best = this._toMatch(row, similarity);
        if (similarity === 1) break;
      }
    }
    return best;
  }

  static _toMatch(row, similarity) {
    return {
      listKey: row.list_key,
      entryUid: row.entry_uid,
      name: row.name,
      normalizedName: row.normalized_name,
      sourceFile: row.source_file,
      isAlias: row.is_alias,
      aliasType: row.alias_type,
      similarity,
    };
  }
}

module.exports = {
  OpenSanctionsListEngine,
  createCsvRecordParser,
  splitAliases,
};

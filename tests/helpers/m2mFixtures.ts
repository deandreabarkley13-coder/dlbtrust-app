import { vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const wireTransport = require('../../server/integrations/inhouseBank/wire/wireTransport');
const pool = require('../../server/integrations/bonds/pgPool');

export type Row = Record<string, any>;

/**
 * Both registers answered from memory. Only the SQL shapes the engines emit
 * are understood, so a new query is a test failure, not a silent pass.
 */
export function store() {
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
    if (text.startsWith('SELECT status, COUNT(*)::int AS count')) {
      const byStatus: Record<string, Row> = {};
      files.forEach(f => {
        const s = byStatus[f.status] || (byStatus[f.status] = { status: f.status, count: 0, credit_cents: 0, debit_cents: 0 });
        s.count += 1; s.credit_cents += Number(f.credit_cents); s.debit_cents += Number(f.debit_cents);
      });
      return { rows: Object.values(byStatus) };
    }
    if (text.startsWith('SELECT * FROM mft_files WHERE channel_id = $1 AND source_ref')) {
      return { rows: [...files].reverse().filter(f => f.channel_id === params[0] && f.source_ref === params[1] && f.status !== 'rejected').slice(0, 1) };
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
export function fakeBank(dir: string) {
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

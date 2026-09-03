import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { MftOsEngine, channelReadiness, normalizeEntry, parsePacs008, FILE_TYPES } = require('../server/integrations/os/mftOsEngine');
const { parseNACHAFile, generateNACHAFile } = require('../server/integrations/ach/nachaGenerator');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/**
 * The register answered from memory. Only the SQL shapes the engine actually
 * emits are understood, so a new query is a test failure, not a silent pass.
 */
function store() {
  const channels: Row[] = [];
  const files: Row[] = [];
  const events: Row[] = [];

  const FILE_COLUMNS = ['file_id', 'channel_id', 'file_type', 'format', 'status', 'filename', 'content', 'content_hash', 'size_bytes',
    'entry_count', 'credit_cents', 'debit_cents', 'effective_date', 'entries', 'built_by', 'approved_by', 'transport', 'memo', 'source_ref'];

  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };

    if (text.startsWith('SELECT * FROM mft_channels WHERE channel_id')) {
      return { rows: channels.filter(c => c.channel_id === params[0]) };
    }
    if (text.startsWith('SELECT * FROM mft_channels ORDER BY')) return { rows: [...channels] };
    if (text.startsWith('INSERT INTO mft_channels')) {
      const row = {
        channel_id: params[0], name: params[1], bank_name: params[2], status: 'active',
        file_types: JSON.parse(params[3]), config: JSON.parse(params[4]), created_by: params[5], created_at: new Date().toISOString(),
      };
      channels.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('UPDATE mft_channels SET status')) {
      channels.filter(c => c.channel_id === params[0]).forEach(c => { c.status = params[1]; });
      return { rows: [] };
    }

    if (text.startsWith('INSERT INTO mft_files')) {
      const row: Row = { built_at: new Date().toISOString(), remote_path: null,
        archive_path: null, bank_reference: null, failure_reason: null, approved_at: null, transmitted_at: null, acknowledged_at: null, settled_at: null };
      FILE_COLUMNS.forEach((col, i) => { row[col] = col === 'entries' ? JSON.parse(params[i]) : params[i]; });
      if (row.approved_by) row.approved_at = new Date().toISOString();
      files.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM mft_files WHERE file_id')) return { rows: files.filter(f => f.file_id === params[0]) };
    if (text.startsWith('SELECT * FROM mft_files WHERE channel_id = $1 AND filename')) {
      return { rows: files.filter(f => f.channel_id === params[0] && f.filename === params[1]) };
    }
    if (text.startsWith('SELECT * FROM mft_files WHERE channel_id = $1 AND source_ref')) {
      return { rows: [...files].reverse().filter(f => f.channel_id === params[0] && f.source_ref === params[1] && f.status !== 'rejected') };
    }
    if (text.startsWith('SELECT file_id, transmitted_at FROM mft_files')) {
      return { rows: files.filter(f => f.channel_id === params[0] && f.content_hash === params[1] && f.file_id !== params[2]
        && ['transmitted', 'acknowledged', 'settled'].includes(f.status)) };
    }
    if (text.startsWith('SELECT * FROM mft_files')) return { rows: [...files].reverse() };
    if (text.startsWith('UPDATE mft_files SET')) {
      const setClause = /SET (.+) WHERE file_id = \$1 RETURNING/.exec(text)![1];
      const target = files.find(f => f.file_id === params[0]);
      if (!target) return { rows: [] };
      setClause.split(', ').forEach(pair => {
        const [col, value] = pair.split(' = ');
        target[col] = value === 'NOW()' ? new Date().toISOString() : params[Number(value.slice(1)) - 1];
      });
      return { rows: [target] };
    }
    if (text.startsWith('SELECT status, COUNT(*)')) {
      const by: Record<string, Row> = {};
      files.forEach(f => {
        by[f.status] = by[f.status] || { status: f.status, count: 0, credit_cents: 0, debit_cents: 0 };
        by[f.status].count += 1; by[f.status].credit_cents += f.credit_cents; by[f.status].debit_cents += f.debit_cents;
      });
      return { rows: Object.values(by) };
    }

    if (text.startsWith('INSERT INTO mft_events')) {
      events.push({ event_id: params[0], file_id: params[1], channel_id: params[2], event_type: params[3], actor: params[4], detail: JSON.parse(params[5]), created_at: new Date().toISOString() });
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM mft_events')) return { rows: events.filter(e => e.file_id === params[0]) };

    throw new Error(`unexpected SQL in test: ${text}`);
  });

  vi.spyOn(pool, 'query').mockImplementation(query as any);
  return { channels, files, events, query };
}

const payee = (over: Row = {}) => ({ routingNumber: '021000021', accountNumber: '123456789', amountCents: 125_000, name: 'Jane Beneficiary', identifier: 'BEN-1', ...over });

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mft-'));
  process.env.MFT_SPOOL_DIR = path.join(tmp, 'spool');
  process.env.MFT_ARCHIVE_DIR = path.join(tmp, 'archive');
  delete process.env.MFT_SFTP_HOST;
  delete process.env.MFT_REQUIRE_APPROVAL;
  delete process.env.MFT_ALLOW_SPOOL_IN_PRODUCTION;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MFT OS — building payment files', () => {
  it('renders a direct deposit file whose control totals match its entries and masks account numbers', async () => {
    store();
    await MftOsEngine.ensureTables();
    const { file, duplicateOf } = await MftOsEngine.build({
      fileType: 'direct_deposit', builtBy: 'maker@dlb.trust',
      entries: [payee(), payee({ amountCents: 75_000, name: 'John Beneficiary', accountType: 'savings' })],
    });
    expect(file.status).toBe('built');
    expect(file.entryCount).toBe(2);
    expect(file.creditCents).toBe(200_000);
    expect(file.debitCents).toBe(0);
    expect(file.transport).toBe('spool');
    expect(duplicateOf).toBeNull();
    expect(file.entries[0].account).toBe('*****6789');
    expect(JSON.stringify(file)).not.toContain('123456789');

    const full = await MftOsEngine.get(file.fileId, { withContent: true });
    const parsed = parseNACHAFile(full.content);
    expect(parsed.batches[0].secCode).toBe('PPD');
    expect(parsed.batches[0].serviceClassCode).toBe('220');
    expect(parsed.batches[0].entries.map((e: Row) => e.transactionCode)).toEqual(['22', '32']);
    expect(parsed.fileControl.totalCredit).toBe(200_000);
  });

  it('refuses a debit on a credits-only file, a bad routing number, an empty file and an anonymous builder', async () => {
    store();
    await MftOsEngine.ensureTables();
    await expect(MftOsEngine.build({ fileType: 'vendor_payment', builtBy: 'x', entries: [payee({ direction: 'debit' })] }))
      .rejects.toMatchObject({ code: 'MFT_DEBIT_NOT_ALLOWED' });
    await expect(MftOsEngine.build({ fileType: 'vendor_payment', builtBy: 'x', entries: [payee({ routingNumber: '021000022' })] }))
      .rejects.toMatchObject({ code: 'MFT_BAD_ROUTING' });
    await expect(MftOsEngine.build({ fileType: 'vendor_payment', builtBy: 'x', entries: [] }))
      .rejects.toMatchObject({ code: 'MFT_EMPTY' });
    await expect(MftOsEngine.build({ fileType: 'vendor_payment', entries: [payee()] }))
      .rejects.toMatchObject({ code: 'MFT_NO_ACTOR' });
    await expect(MftOsEngine.build({ fileType: 'payroll', builtBy: 'x', entries: [payee()] }))
      .rejects.toMatchObject({ code: 'MFT_BAD_FILE_TYPE' });
  });

  it('builds a mixed clearing and settlement file as service class 200 with CCD debits and credits', async () => {
    store();
    await MftOsEngine.ensureTables();
    const { file } = await MftOsEngine.build({
      fileType: 'clearing_settlement', builtBy: 'ops@dlb.trust',
      entries: [payee({ name: 'Counterparty A', amountCents: 500_000 }), payee({ name: 'Counterparty B', amountCents: 300_000, direction: 'debit' })],
    });
    expect(file.creditCents).toBe(500_000);
    expect(file.debitCents).toBe(300_000);
    const parsed = parseNACHAFile((await MftOsEngine.get(file.fileId, { withContent: true })).content);
    expect(parsed.batches[0].serviceClassCode).toBe('200');
    expect(parsed.batches[0].secCode).toBe('CCD');
    expect(parsed.fileControl.totalDebit).toBe(300_000);
  });

  it('never accepts a secret in a channel record', async () => {
    store();
    await MftOsEngine.ensureTables();
    await expect(MftOsEngine.registerChannel({ name: 'Bank', config: { host: 'sftp.bank.test', password: 'hunter2' } }))
      .rejects.toMatchObject({ code: 'MFT_SECRET_IN_CONFIG' });
    const ch = await MftOsEngine.registerChannel({ name: 'Bank', config: { host: 'sftp.bank.test', username: 'dlb', passwordEnv: 'BANK_PW' } });
    expect(ch.transport).toBe('sftp');
    expect(JSON.stringify(ch)).not.toContain('hunter2');
  });
});

describe('MFT OS — release and transmission', () => {
  async function built(by = 'maker@dlb.trust') {
    const { file } = await MftOsEngine.build({ fileType: 'vendor_payment', builtBy: by, entries: [payee({ name: 'Acme Vendor LLC' })] });
    return file;
  }

  it('will not let the builder release the file, and will not transmit an unreleased file', async () => {
    store();
    await MftOsEngine.ensureTables();
    const file = await built();
    await expect(MftOsEngine.approve(file.fileId, 'MAKER@dlb.trust')).rejects.toMatchObject({ code: 'MFT_FOUR_EYES' });
    await expect(MftOsEngine.transmit(file.fileId, { actor: 'ops' })).rejects.toMatchObject({ code: 'MFT_WRONG_STATE' });
  });

  it('transmits once, replays without writing, archives the bytes, and follows the bank ack to settlement', async () => {
    store();
    await MftOsEngine.ensureTables();
    const file = await built();
    await MftOsEngine.approve(file.fileId, 'checker@dlb.trust');

    const first = await MftOsEngine.transmit(file.fileId, { actor: 'checker@dlb.trust' });
    expect(first.transmitted).toBe(true);
    expect(first.file.status).toBe('transmitted');
    expect(first.file.remotePath).toBe(`/payments/outbound/${file.filename}`);

    const onHost = path.join(process.env.MFT_SPOOL_DIR!, 'default', 'payments', 'outbound', file.filename);
    expect(fs.existsSync(onHost)).toBe(true);
    expect(fs.readdirSync(path.dirname(onHost)).some(n => n.endsWith('.tmp'))).toBe(false);
    expect(fs.readFileSync(first.file.archivePath, 'utf8')).toBe(fs.readFileSync(onHost, 'utf8'));
    expect(await MftOsEngine.verify(file.fileId)).toMatchObject({ intact: true, archiveMatches: true });

    const again = await MftOsEngine.transmit(file.fileId, { actor: 'checker@dlb.trust' });
    expect(again.transmitted).toBe(false);
    expect(again.replay).toBe(true);

    await expect(MftOsEngine.settle(file.fileId, { actor: 'ops' })).rejects.toMatchObject({ code: 'MFT_NO_EVIDENCE' });

    const ackDir = path.join(process.env.MFT_SPOOL_DIR!, 'default', 'payments', 'ack');
    fs.mkdirSync(ackDir, { recursive: true });
    fs.writeFileSync(path.join(ackDir, `${file.filename}.ack`), 'BANKREF-778\nACCEPTED 1 ENTRIES\n');
    fs.writeFileSync(path.join(ackDir, 'unrelated.txt'), 'noise');
    const collected = await MftOsEngine.collect('default', { actor: 'poller' });
    expect(collected.acknowledged).toEqual([file.fileId]);
    expect(collected.ignored).toEqual(['unrelated.txt']);
    expect(fs.existsSync(path.join(ackDir, `${file.filename}.ack`))).toBe(false);
    expect((await MftOsEngine.get(file.fileId)).bankReference).toBe('BANKREF-778');

    const settled = await MftOsEngine.settle(file.fileId, { actor: 'ops', bankReference: 'SETTLE-9' });
    expect(settled.status).toBe('settled');
    expect((await MftOsEngine.events(file.fileId)).map((e: Row) => e.eventType))
      .toEqual(['built', 'approved', 'transmitted', 'acknowledged', 'settled']);
  });

  it('refuses a byte-identical file already transmitted on the channel unless forced', async () => {
    store();
    await MftOsEngine.ensureTables();
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['Date'] });
    const a = await built();
    await MftOsEngine.approve(a.fileId, 'checker');
    await MftOsEngine.transmit(a.fileId, { actor: 'checker' });

    vi.setSystemTime(1_800_000_000_500);
    const b = await MftOsEngine.build({ fileType: 'vendor_payment', builtBy: 'maker@dlb.trust', entries: [payee({ name: 'Acme Vendor LLC' })] });
    expect(b.duplicateOf).toBe(a.fileId);
    await MftOsEngine.approve(b.file.fileId, 'checker');
    await expect(MftOsEngine.transmit(b.file.fileId, { actor: 'checker' })).rejects.toMatchObject({ code: 'MFT_DUPLICATE', details: { duplicateOf: a.fileId } });
    const forced = await MftOsEngine.transmit(b.file.fileId, { actor: 'checker', force: true });
    expect(forced.transmitted).toBe(true);
    vi.useRealTimers();
  });

  it('reads a NACHA return file off the channel and records its trace numbers', async () => {
    store();
    await MftOsEngine.ensureTables();
    const returnsDir = path.join(process.env.MFT_SPOOL_DIR!, 'default', 'payments', 'returns');
    fs.mkdirSync(returnsDir, { recursive: true });
    const ret = generateNACHAFile({}, [{ secCode: 'CCD', serviceClassCode: '200', entries: [{ receivingRouting: '021000021', accountNumber: '1', amountCents: 500, transactionCode: '21', individualName: 'R01 RETURN' }] }]);
    fs.writeFileSync(path.join(returnsDir, 'RETURNS_0903.ach'), ret);
    const collected = await MftOsEngine.collect('default');
    expect(collected.returns).toHaveLength(1);
    expect(collected.returns[0].entries[0]).toMatchObject({ amountCents: 500, transactionCode: '21' });
    expect(fs.existsSync(path.join(returnsDir, 'RETURNS_0903.ach'))).toBe(false);
  });

  it('marks a bank rejection terminal and refuses further movement', async () => {
    store();
    await MftOsEngine.ensureTables();
    const file = await built();
    await MftOsEngine.approve(file.fileId, 'checker');
    await MftOsEngine.transmit(file.fileId, { actor: 'checker' });
    const ackDir = path.join(process.env.MFT_SPOOL_DIR!, 'default', 'payments', 'ack');
    fs.mkdirSync(ackDir, { recursive: true });
    fs.writeFileSync(path.join(ackDir, `${file.filename}.rej`), 'INVALID ODFI\n');
    const collected = await MftOsEngine.collect('default');
    expect(collected.rejected).toEqual([file.fileId]);
    const rejected = await MftOsEngine.get(file.fileId);
    expect(rejected.status).toBe('rejected');
    expect(rejected.failureReason).toBe('INVALID ODFI');
    await expect(MftOsEngine.settle(file.fileId, { bankReference: 'X' })).rejects.toMatchObject({ code: 'MFT_WRONG_STATE' });
  });
});

describe('MFT OS — channel readiness', () => {
  it('spool is ready outside production and refused in production unless allowed', () => {
    const spool = { channelId: 'default', status: 'active', config: {} };
    expect(channelReadiness(spool).ready).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(channelReadiness(spool)).toMatchObject({ ready: false, blockers: [expect.stringContaining('spool transmission is not allowed')] });
    expect(channelReadiness({ ...spool, config: { allowSpoolInProduction: true } }).ready).toBe(true);
  });

  it('sftp needs a pinned host key and a credential present in the environment', () => {
    const base = { channelId: 'bank', status: 'active', config: { host: 'sftp.bank.test', username: 'dlb', passwordEnv: 'MFT_TEST_PW' } };
    delete process.env.MFT_TEST_PW;
    const r = channelReadiness(base);
    expect(r.transport).toBe('sftp');
    expect(r.blockers).toEqual(['bank host key is not pinned', 'no SFTP credential is present in the environment']);
    process.env.MFT_TEST_PW = 'secret';
    expect(channelReadiness({ ...base, config: { ...base.config, hostKeyFingerprint: 'SHA256:abc' } }).ready).toBe(true);
    delete process.env.MFT_TEST_PW;
  });

  it('a suspended channel cannot transmit', async () => {
    store();
    await MftOsEngine.ensureTables();
    process.env.MFT_REQUIRE_APPROVAL = 'false';
    const { file } = await MftOsEngine.build({ fileType: 'direct_deposit', builtBy: 'maker', entries: [payee()] });
    await MftOsEngine.setChannelStatus('default', 'suspended', 'admin');
    await expect(MftOsEngine.transmit(file.fileId, { actor: 'ops' })).rejects.toMatchObject({ code: 'MFT_CHANNEL_NOT_READY' });
    const status = await MftOsEngine.status();
    expect(status.channels[0].readiness.ready).toBe(false);
    expect(status.files.approved.count).toBe(1);
  });
});

describe('MFT OS — entry normalisation', () => {
  it('derives transaction codes from direction and account type', () => {
    const spec = FILE_TYPES.clearing_settlement;
    expect(normalizeEntry(payee(), spec, 0).transactionCode).toBe('22');
    expect(normalizeEntry(payee({ accountType: 'savings' }), spec, 0).transactionCode).toBe('32');
    expect(normalizeEntry(payee({ direction: 'debit' }), spec, 0).transactionCode).toBe('27');
    expect(normalizeEntry(payee({ direction: 'debit', accountType: 'savings' }), spec, 0).transactionCode).toBe('37');
    expect(() => normalizeEntry(payee({ amountCents: 0 }), spec, 0)).toThrow(/positive integer/);
    expect(() => normalizeEntry(payee({ name: '' }), spec, 0)).toThrow(/receiver name/);
  });
});

describe('MFT OS — wire payments as pacs.008', () => {
  const wire = (over: Row = {}) => ({ routingNumber: '021000021', accountNumber: '9876543210', amountCents: 2_500_000, name: 'Settlement Bank N.A.', endToEndId: 'E2E-100', remittance: 'Fund settlement', ...over });

  it('builds a pacs.008 whose header count and control sum match its transactions, and refuses to build without a debtor account', async () => {
    store();
    await MftOsEngine.ensureTables();
    delete process.env.MFT_DEBTOR_ACCOUNT;
    await expect(MftOsEngine.build({ fileType: 'wire_payment', builtBy: 'maker', entries: [wire()] })).rejects.toMatchObject({ code: 'MFT_NOT_CONFIGURED' });

    process.env.MFT_DEBTOR_ACCOUNT = '5550001111';
    process.env.MFT_ORIGIN_BIC = 'DLBTUS33';
    const { file } = await MftOsEngine.build({
      fileType: 'wire_payment', builtBy: 'maker',
      entries: [wire(), wire({ bic: 'CHASUS33XXX', routingNumber: '', amountCents: 100_000, name: 'Vendor GmbH', endToEndId: 'E2E-101' })],
    });
    expect(file.format).toBe('pacs.008');
    expect(file.filename).toMatch(/_WIRE_PAYMENT_.*\.xml$/);
    expect(file.entryCount).toBe(2);
    expect(file.creditCents).toBe(2_600_000);
    expect(file.entries[0].account).toBe('******3210');
    expect(file.entries[1].bic).toBe('CHASUS33XXX');

    const full = await MftOsEngine.get(file.fileId, { withContent: true });
    const parsed = parsePacs008(full.content);
    expect(parsed).toMatchObject({ count: 2, totalCents: 2_600_000, currency: 'USD', messageId: file.fileId });
    expect(parsed.transactions.map((t: Row) => t.endToEndId)).toEqual(['E2E-100', 'E2E-101']);
    expect(full.content).toContain('<BICFI>DLBTUS33</BICFI>');
    expect(full.content).toContain('<MmbId>021000021</MmbId>');
    expect(full.content).toContain('<BICFI>CHASUS33XXX</BICFI>');
    expect(full.content).not.toContain('123456789');
    delete process.env.MFT_DEBTOR_ACCOUNT;
    delete process.env.MFT_ORIGIN_BIC;
  });

  it('rejects a pacs.008 whose header lies about its transactions', () => {
    const doc = (count: number, total: string) => `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf>
      <GrpHdr><MsgId>M1</MsgId><NbOfTxs>${count}</NbOfTxs><TtlIntrBkSttlmAmt Ccy="USD">${total}</TtlIntrBkSttlmAmt></GrpHdr>
      <CdtTrfTxInf><PmtId><EndToEndId>E1</EndToEndId></PmtId><IntrBkSttlmAmt Ccy="USD">100.00</IntrBkSttlmAmt><Cdtr><Nm>A</Nm></Cdtr><CdtrAcct><Id><Othr><Id>1</Id></Othr></Id></CdtrAcct></CdtTrfTxInf>
      <CdtTrfTxInf><PmtId><EndToEndId>E2</EndToEndId></PmtId><IntrBkSttlmAmt Ccy="USD">0.50</IntrBkSttlmAmt><Cdtr><Nm>B</Nm></Cdtr><CdtrAcct><Id><Othr><Id>2</Id></Othr></Id></CdtrAcct></CdtTrfTxInf>
    </FIToFICstmrCdtTrf></Document>`;
    expect(parsePacs008(doc(2, '100.50'))).toMatchObject({ count: 2, totalCents: 10_050 });
    expect(() => parsePacs008(doc(1, '100.50'))).toThrow(/does not match/);
    expect(() => parsePacs008(doc(2, '100.00'))).toThrow(/does not match/);
    expect(() => parsePacs008('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001"></Document>')).toThrow(/Not a pacs.008/);
  });

  it('a wire entry needs a BIC or a valid routing number', () => {
    const spec = FILE_TYPES.wire_payment;
    expect(normalizeEntry(wire(), spec, 0)).toMatchObject({ routingNumber: '021000021', bic: '', accountNumber: '9876543210', direction: 'credit' });
    expect(normalizeEntry(wire({ bic: 'chasus33', routingNumber: '' }), spec, 0).bic).toBe('CHASUS33');
    expect(() => normalizeEntry(wire({ routingNumber: '123456789' }), spec, 0)).toThrow(/BIC or a routing number/);
    expect(() => normalizeEntry(wire({ bic: 'BAD' }), spec, 0)).toThrow(/8 or 11 characters/);
    expect(() => normalizeEntry(wire({ direction: 'debit' }), spec, 0)).toThrow(/credits only/);
  });
});

describe('MFT OS — ingesting files other engines rendered', () => {
  const nacha = (amountCents = 125_000) => generateNACHAFile({}, [{
    secCode: 'PPD', serviceClassCode: '220', companyEntryDescription: 'DIRECT DEP', effectiveEntryDate: new Date('2026-09-04T00:00:00Z'),
    entries: [{ receivingRouting: '021000021', accountNumber: '123456789', amountCents, transactionCode: '22', individualId: 'BEN-1', individualName: 'Jane Beneficiary' }],
  }]);

  it('registers a NACHA file under its source, classifies it, masks accounts, and returns the same file for the same source and bytes', async () => {
    store();
    await MftOsEngine.ensureTables();
    const content = nacha();
    const first = await MftOsEngine.ingest({ content, format: 'nacha', filename: 'ACH-1.ach', sourceRef: 'ach:BATCH-1', builtBy: 'payer-os' });
    expect(first.reused).toBe(false);
    expect(first.file).toMatchObject({ fileType: 'direct_deposit', status: 'built', filename: 'ACH-1.ach', sourceRef: 'ach:BATCH-1', entryCount: 1, creditCents: 125_000, effectiveDate: '2026-09-04' });
    expect(first.file.entries[0].account).toBe('*****6789');

    const again = await MftOsEngine.ingest({ content, format: 'nacha', sourceRef: 'ach:BATCH-1', builtBy: 'payer-os' });
    expect(again.reused).toBe(true);
    expect(again.file.fileId).toBe(first.file.fileId);

    await expect(MftOsEngine.ingest({ content: nacha(999_999), format: 'nacha', sourceRef: 'ach:BATCH-1', builtBy: 'payer-os' }))
      .rejects.toMatchObject({ code: 'MFT_SOURCE_CONFLICT' });
  });

  it('carries upstream dual control across, under the same four-eyes rule', async () => {
    store();
    await MftOsEngine.ensureTables();
    await expect(MftOsEngine.ingest({ content: nacha(), sourceRef: 'ach:B-2', builtBy: 'trustee-a', approvedBy: 'TRUSTEE-A' }))
      .rejects.toMatchObject({ code: 'MFT_FOUR_EYES' });
    const { file } = await MftOsEngine.ingest({ content: nacha(), sourceRef: 'ach:B-2', builtBy: 'trustee-a', approvedBy: 'trustee-b' });
    expect(file).toMatchObject({ status: 'approved', builtBy: 'trustee-a', approvedBy: 'trustee-b' });
    const events = await MftOsEngine.events(file.fileId);
    expect(events.map((e: Row) => e.eventType)).toEqual(['built', 'approved']);
    expect(events[1].detail.carriedFrom).toBe('ach:B-2');
  });

  it('refuses a NACHA file whose control record does not match its entries, and a debit file under a credit-only type', async () => {
    store();
    await MftOsEngine.ensureTables();
    const tampered = nacha().split('\n').map(l => l.startsWith('6') ? l.slice(0, 29) + '0000000001' + l.slice(39) : l).join('\n');
    await expect(MftOsEngine.ingest({ content: tampered, builtBy: 'x' })).rejects.toMatchObject({ code: 'MFT_CONTROL_MISMATCH' });
    const debit = generateNACHAFile({}, [{ secCode: 'CCD', serviceClassCode: '225', effectiveEntryDate: new Date(),
      entries: [{ receivingRouting: '021000021', accountNumber: '1', amountCents: 100, transactionCode: '27', individualName: 'Counterparty' }] }]);
    expect((await MftOsEngine.ingest({ content: debit, builtBy: 'x' })).file.fileType).toBe('clearing_settlement');
    await expect(MftOsEngine.ingest({ content: debit, fileType: 'vendor_payment', builtBy: 'x' })).rejects.toMatchObject({ code: 'MFT_DEBIT_NOT_ALLOWED' });
    await expect(MftOsEngine.ingest({ content: 'not a file', builtBy: 'x' })).rejects.toMatchObject({ code: 'MFT_BAD_CONTENT' });
  });

  it('deliver() ingests and transmits in one step, and a second delivery of the same source is a replay that writes nothing', async () => {
    store();
    await MftOsEngine.ensureTables();
    const args = { content: nacha(), filename: 'ACH-3.ach', sourceRef: 'ach:B-3', builtBy: 'trustee-a', approvedBy: 'trustee-b' };
    const first = await MftOsEngine.deliver(args);
    expect(first).toMatchObject({ transmitted: true, replay: false, reused: false });
    expect(first.file.status).toBe('transmitted');
    const outbound = path.join(process.env.MFT_SPOOL_DIR!, 'default', 'payments', 'outbound');
    expect(fs.readdirSync(outbound)).toEqual(['ACH-3.ach']);

    const second = await MftOsEngine.deliver(args);
    expect(second).toMatchObject({ transmitted: false, replay: true, reused: true });
    expect(second.file.fileId).toBe(first.file.fileId);
    expect(fs.readdirSync(outbound)).toEqual(['ACH-3.ach']);

    const unreleased = await MftOsEngine.deliver({ ...args, sourceRef: 'ach:B-4', filename: 'ACH-4.ach', approvedBy: null }).catch(e => e);
    expect(unreleased).toMatchObject({ code: 'MFT_WRONG_STATE' });
    expect((await MftOsEngine.list({ sourceRef: 'ach:B-4' }))[0].status).toBe('built');
    expect(fs.readdirSync(outbound)).toEqual(['ACH-3.ach']);
  });
});

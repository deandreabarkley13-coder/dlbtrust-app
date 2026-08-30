import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  buildClearingFile,
  buildManifest,
  signClearingFile,
  filenameFor,
} = require('../server/integrations/inhouseBank/wire/wireClearingFile');
const { directSendReadiness, getDirectSendConfig } = require('../server/integrations/inhouseBank/wire/wireDirectSendConfig');
const transport = require('../server/integrations/inhouseBank/wire/wireDirectSendTransport');
const { WireDirectSendTransportError, parseReceipt, dropPathFor } = transport;
const {
  WireDirectSendEngine,
  BATCH_TRANSITIONS,
  memberFilename,
} = require('../server/integrations/inhouseBank/wire/wireDirectSendEngine');
const { WireIdempotencyVault } = require('../server/integrations/inhouseBank/wire/wireIdempotencyVault');
const { InHouseBankEngine } = require('../server/integrations/inhouseBank/inHouseBankEngine');
const { DualLedgerEngine } = require('../server/integrations/inhouseBank/dualLedgerEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/** One dispatched external wire, as the in-house bank reports it. */
function dispatchedPayment(paymentId: string, overrides: Row = {}): Row {
  return {
    paymentId,
    status: 'dispatched',
    internal: false,
    rail: 'fedwire',
    amountCents: 250000,
    feeCents: 0,
    currency: 'USD',
    endToEndId: `E2E-${paymentId}`,
    uetr: `UETR-${paymentId}`,
    creditor: { name: 'Barkley Holdings LLC', accountNumber: '4455667788', routingNumber: '021000021' },
    ...overrides,
  };
}

function pacs008For(paymentId: string, amount = '2500.00'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr><MsgId>MSG-${paymentId}</MsgId><NbOfTxs>1</NbOfTxs></GrpHdr>
    <CdtTrfTxInf>
      <PmtId><EndToEndId>E2E-${paymentId}</EndToEndId><UETR>UETR-${paymentId}</UETR></PmtId>
      <IntrBkSttlmAmt Ccy="USD">${amount}</IntrBkSttlmAmt>
      <Cdtr><Nm>Barkley Holdings LLC</Nm></Cdtr>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>`;
}

interface DirectState {
  transmissions: Row[];
  vaultLog: Row[];
  exceptions: Row[];
  batches: Row[];
  items: Row[];
  log: Row[];
  payments: Row[];
}

function emptyState(): DirectState {
  return { transmissions: [], vaultLog: [], exceptions: [], batches: [], items: [], log: [], payments: [] };
}

/**
 * The Direct Send engine touches its own ihb_wire_direct_* tables, the wire
 * vault it shares with the single-file path, the shared exception queue and a
 * read of ihb_payments. The fake recognises exactly those: an unhandled
 * statement throws, so a duplicate-suppression or release test cannot pass by
 * quietly returning no rows.
 */
function fakeDb(state: DirectState) {
  const clone = (row: Row) => ({ ...row });

  /** Apply a dynamically built `SET col = $n` update to one row. */
  const applySets = (row: Row, text: string, params: any[]) => {
    const sets = /SET (.+) WHERE/.exec(text)![1];
    for (const assignment of sets.split(',')) {
      const [rawColumn, rawValue] = assignment.split('=').map((part) => part.trim());
      if (rawValue === 'NOW()') { row[rawColumn] = new Date(); continue; }
      const index = /^\$(\d+)$/.exec(rawValue);
      if (!index) continue;
      const value = params[Number(index[1]) - 1];
      row[rawColumn] = typeof value === 'string' && /^[[{]/.test(value) ? JSON.parse(value) : value;
    }
    return row;
  };

  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|DROP)/i.test(text)) return { rows: [] };

    // ── the shared wire vault ────────────────────────────────────────────────
    if (text.startsWith('INSERT INTO ihb_wire_transmissions')) {
      if (state.transmissions.some((r) => r.wire_key === params[1])) return { rows: [] };
      const row: Row = {
        transmission_id: params[0],
        wire_key: params[1],
        payment_id: params[2],
        state: 'reserved',
        filename: params[3],
        payload: params[4],
        payload_hash: params[5],
        message_type: params[6],
        rail: params[7],
        amount_cents: params[8],
        currency: params[9],
        end_to_end_id: params[10],
        uetr: params[11],
        creditor_name: params[12],
        creditor_account: params[13],
        reservation_owner: params[14],
        reserved_at: new Date(),
        attempts: 1,
        remote_path: null,
        bank_reference: null,
        return_reference: null,
        return_reason: null,
        transmitted_at: null,
        acknowledged_at: null,
        settled_at: null,
        returned_at: null,
        last_error: null,
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      };
      state.transmissions.push(row);
      return { rows: [clone(row)] };
    }

    if (text.startsWith('UPDATE ihb_wire_transmissions')) {
      const row = state.transmissions.find((r) => r.transmission_id === params[0]);
      if (!row) return { rows: [] };
      return { rows: [clone(applySets(row, text, params))] };
    }

    if (text.startsWith('SELECT * FROM ihb_wire_transmissions')) {
      const column = /WHERE (\w+) = \$1/.exec(text);
      const rows = column
        ? state.transmissions.filter((r) => r[column[1]] === params[0])
        : state.transmissions;
      return { rows: rows.map(clone) };
    }

    if (text.startsWith('INSERT INTO ihb_wire_state_log')) {
      state.vaultLog.push({ transmission_id: params[1], from_state: params[3], to_state: params[4], reason: params[6] });
      return { rows: [] };
    }

    if (text.startsWith('SELECT * FROM ihb_wire_state_log')) {
      return { rows: state.vaultLog.filter((r) => r.transmission_id === params[0]).map(clone) };
    }

    // ── the shared exception queue ───────────────────────────────────────────
    if (text.startsWith('INSERT INTO ihb_wire_exceptions')) {
      const key = params[2] || params[4] || '';
      const open = state.exceptions.find((r) => r.kind === params[1] && (r.transmission_id || r.filename || '') === key && !r.resolved);
      if (open) {
        open.detail = params[5];
        open.context = JSON.parse(params[6]);
        return { rows: [clone(open)] };
      }
      const row: Row = {
        exception_id: params[0],
        kind: params[1],
        transmission_id: params[2],
        payment_id: params[3],
        filename: params[4],
        detail: params[5],
        context: JSON.parse(params[6]),
        resolved: false,
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      };
      state.exceptions.push(row);
      return { rows: [clone(row)] };
    }

    if (text.startsWith('SELECT * FROM ihb_wire_exceptions')) {
      return { rows: state.exceptions.filter((r) => params[0] === null || Boolean(r.resolved) === params[0]).map(clone) };
    }

    // ── Direct Send's own tables ─────────────────────────────────────────────
    if (text.startsWith('INSERT INTO ihb_wire_direct_batches')) {
      const row: Row = {
        batch_id: params[0],
        state: 'assembled',
        filename: params[1],
        payload: params[2],
        payload_hash: params[3],
        format: 'pacs.008.001.08',
        mode: params[4],
        endpoint: params[5],
        manifest: JSON.parse(params[6]),
        signature_algorithm: params[7],
        signature: params[8],
        item_count: params[9],
        total_amount_cents: params[10],
        currency: params[11],
        receipt: {},
        bank_reference: null,
        remote_path: null,
        archive_path: null,
        assembled_by: params[12],
        attempts: 0,
        last_error: null,
        transmitted_at: null,
        acknowledged_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      state.batches.push(row);
      return { rows: [clone(row)] };
    }

    if (text.startsWith('UPDATE ihb_wire_direct_batches')) {
      const row = state.batches.find((r) => r.batch_id === params[0]);
      if (!row) return { rows: [] };
      return { rows: [clone(applySets(row, text, params))] };
    }

    if (text.startsWith('SELECT payload FROM ihb_wire_direct_batches')) {
      const row = state.batches.find((r) => r.batch_id === params[0]);
      return { rows: row ? [{ payload: row.payload }] : [] };
    }

    if (text.startsWith('SELECT * FROM ihb_wire_direct_batches')) {
      if (/WHERE batch_id = \$1/.test(text)) {
        return { rows: state.batches.filter((r) => r.batch_id === params[0]).map(clone) };
      }
      if (/\$1::text IS NULL/.test(text)) {
        const rows = state.batches.filter((r) => params[0] === null || r.state === params[0]);
        return { rows: rows.map(clone) };
      }
      const wanted = /state = '(\w+)'/.exec(text)![1];
      const minutes = params.length ? Number(params[0]) : 0;
      const cutoff = Date.now() - minutes * 60000;
      const column = /transmitted_at </.test(text) ? 'transmitted_at' : (/updated_at </.test(text) ? 'updated_at' : null);
      const rows = state.batches.filter((r) => r.state === wanted
        && (!column || (r[column] && new Date(r[column]).getTime() < cutoff)));
      return { rows: rows.map(clone) };
    }

    if (text.startsWith('INSERT INTO ihb_wire_direct_batch_items')) {
      state.items.push({
        batch_id: params[0],
        payment_id: params[1],
        transmission_id: params[2],
        amount_cents: params[3],
        currency: params[4],
        end_to_end_id: params[5],
        created_at: new Date(),
      });
      return { rows: [] };
    }

    if (text.startsWith('SELECT * FROM ihb_wire_direct_batch_items')) {
      return { rows: state.items.filter((r) => r.batch_id === params[0]).map(clone) };
    }

    if (text.startsWith('INSERT INTO ihb_wire_direct_log')) {
      state.log.push({
        log_id: params[0],
        batch_id: params[1],
        from_state: params[2],
        to_state: params[3],
        actor: params[4],
        reason: params[5],
        evidence: JSON.parse(params[6]),
        created_at: new Date(),
      });
      return { rows: [] };
    }

    if (text.startsWith('SELECT * FROM ihb_wire_direct_log')) {
      return { rows: state.log.filter((r) => r.batch_id === params[0]).map(clone) };
    }

    if (text.startsWith('SELECT p.payment_id')) {
      return { rows: state.payments.map(clone) };
    }

    throw new Error(`unhandled statement in the Direct Send fake: ${text.slice(0, 120)}`);
  });
}

const DIRECT_ENV = [
  'WIRE_DIRECT_SEND_ENABLED',
  'WIRE_DIRECT_SEND_URL',
  'WIRE_DIRECT_SEND_RECEIVER_ID',
  'WIRE_DIRECT_SEND_SIGNING_SECRET',
  'WIRE_DIRECT_SEND_SIGNING_ALGORITHM',
  'WIRE_DIRECT_SEND_SIGNING_KEY_PATH',
  'WIRE_DIRECT_SEND_REQUIRE_SIGNATURE',
  'WIRE_DIRECT_SEND_CLIENT_CERT_PATH',
  'WIRE_DIRECT_SEND_CLIENT_KEY_PATH',
  'WIRE_DIRECT_SEND_TOKEN',
  'WIRE_DIRECT_SEND_INSECURE_TLS',
  'WIRE_DIRECT_SEND_ARCHIVE_DIR',
  'WIRE_DIRECT_SEND_MIN_ITEMS',
  'WIRE_DIRECT_SEND_MAX_ITEMS',
  'WIRE_DIRECT_SEND_MAX_AMOUNT_CENTS',
];

function clearDirectEnv() {
  for (const name of DIRECT_ENV) delete process.env[name];
}

describe('clearing file', () => {
  const config = () => ({ ...getDirectSendConfig(), senderId: 'PTCUUS41XXX', receiverId: 'CHASUS33XXX' });

  it('carries every wire verbatim under one set of control totals', () => {
    const members = [
      { payment: dispatchedPayment('IHB-1'), pacs008: pacs008For('IHB-1') },
      { payment: dispatchedPayment('IHB-2', { amountCents: 125050 }), pacs008: pacs008For('IHB-2', '1250.50') },
    ];
    const file = buildClearingFile({ batchId: 'DSB-AAA', members, config: config(), createdAt: new Date('2026-02-01T12:00:00Z') });

    expect(file.count).toBe(2);
    expect(file.totalAmountCents).toBe(375050);
    expect(file.payload).toContain('<NbOfTxs>2</NbOfTxs>');
    expect(file.payload).toContain('<TtlIntrBkSttlmAmt Ccy="USD">3750.50</TtlIntrBkSttlmAmt>');
    expect(file.payload).toContain('<BICFI>CHASUS33XXX</BICFI>');
    // The transaction bodies are the payments' own bytes, not re-rendered ones.
    expect(file.payload.match(/<CdtTrfTxInf>/g)).toHaveLength(2);
    expect(file.payload).toContain('<EndToEndId>E2E-IHB-1</EndToEndId>');
    expect(file.payload).toContain('<EndToEndId>E2E-IHB-2</EndToEndId>');
    // The single-payment group headers do not survive into the batch.
    expect(file.payload).not.toContain('MSG-IHB-1');
    expect(file.filename).toBe('PTCCLR-20260201120000-AAA.xml');
  });

  it('refuses a file the bank could not balance: mixed currencies, or no wires at all', () => {
    const members = [
      { payment: dispatchedPayment('IHB-1'), pacs008: pacs008For('IHB-1') },
      { payment: dispatchedPayment('IHB-2', { currency: 'EUR' }), pacs008: pacs008For('IHB-2') },
    ];
    expect(() => buildClearingFile({ batchId: 'DSB-A', members, config: config() })).toThrow(/one currency per file/);
    expect(() => buildClearingFile({ batchId: 'DSB-A', members: [], config: config() })).toThrow(/at least one dispatched wire/);
  });

  it('refuses a rendered message with no transaction to clear', () => {
    const members = [{ payment: dispatchedPayment('IHB-1'), pacs008: '<Document><FIToFICstmrCdtTrf><GrpHdr/></FIToFICstmrCdtTrf></Document>' }];
    expect(() => buildClearingFile({ batchId: 'DSB-A', members, config: config() })).toThrow(/no CdtTrfTxInf/);
  });

  it('signs the exact bytes, so an altered file no longer verifies', () => {
    const signing = { ...config(), signingAlgorithm: 'hmac-sha256', signingSecret: 'shared-with-the-bank' };
    const file = buildClearingFile({
      batchId: 'DSB-AAA',
      members: [{ payment: dispatchedPayment('IHB-1'), pacs008: pacs008For('IHB-1') }],
      config: signing,
      createdAt: new Date('2026-02-01T12:00:00Z'),
    });
    const signature = signClearingFile(file.payload, signing);
    const tampered = signClearingFile(file.payload.replace('2500.00', '9500.00'), signing);

    expect(signature.algorithm).toBe('hmac-sha256');
    expect(signature.value).toHaveLength(64);
    expect(tampered.value).not.toBe(signature.value);
    expect(signClearingFile(file.payload, { ...signing, signingSecret: '' })).toBeNull();

    const manifest = buildManifest({ file, members: [{ payment: dispatchedPayment('IHB-1') }], signature, config: signing });
    expect(manifest.controls).toEqual({
      count: 1,
      totalAmountCents: 250000,
      totalAmount: '2500.00',
      payloadSha256: file.payloadHash,
    });
    expect(manifest.items[0]).toMatchObject({ paymentId: 'IHB-1', endToEndId: 'E2E-IHB-1', creditorRouting: '021000021' });
  });

  it('names the file after the batch it carries', () => {
    const created = new Date('2026-02-01T12:00:00Z');
    expect(filenameFor('DSB-DEADBEEF', created, { filePrefix: 'PTCCLR', fileExtension: '.xml' }))
      .toBe('PTCCLR-20260201120000-DEADBEEF.xml');
  });
});

describe('Direct Send readiness', () => {
  beforeEach(clearDirectEnv);
  afterEach(clearDirectEnv);

  it('fails closed on an endpoint that could be impersonated or read in transit', () => {
    process.env.WIRE_DIRECT_SEND_URL = 'http://clearing.bank.example/pipeline';
    process.env.WIRE_DIRECT_SEND_SIGNING_SECRET = 'secret';
    const readiness = directSendReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toMatch(/must be https/);
    expect(readiness.blockers.join(' ')).toMatch(/cannot authenticate the trust/);
  });

  it('will not send an unsigned file when signatures are required', () => {
    process.env.WIRE_DIRECT_SEND_URL = 'https://clearing.bank.example/pipeline';
    process.env.WIRE_DIRECT_SEND_TOKEN = 'token';
    expect(directSendReadiness().blockers.join(' ')).toMatch(/the file cannot be signed/);

    process.env.WIRE_DIRECT_SEND_SIGNING_SECRET = 'secret';
    const readiness = directSendReadiness();
    expect(readiness.ready).toBe(true);
    // A bearer credential alone authenticates the connection, not the key material.
    expect(readiness.warnings.join(' ')).toMatch(/bearer credential only/);
  });

  it('refuses half a client certificate', () => {
    process.env.WIRE_DIRECT_SEND_URL = 'https://clearing.bank.example/pipeline';
    process.env.WIRE_DIRECT_SEND_SIGNING_SECRET = 'secret';
    process.env.WIRE_DIRECT_SEND_CLIENT_CERT_PATH = '/etc/ptc/clearing.crt';
    expect(directSendReadiness().blockers.join(' ')).toMatch(/must be supplied together/);
  });

  it('says plainly that a file-mode channel posts nothing', () => {
    process.env.WIRE_DIRECT_SEND_SIGNING_SECRET = 'secret';
    const readiness = directSendReadiness();
    expect(readiness.mode).toBe('file');
    expect(readiness.ready).toBe(true);
    expect(readiness.warnings.join(' ')).toMatch(/dropped on the host-to-host channel/);
  });

  it('reports the channel closed when Direct Send is switched off', () => {
    process.env.WIRE_DIRECT_SEND_ENABLED = 'false';
    process.env.WIRE_DIRECT_SEND_SIGNING_SECRET = 'secret';
    expect(directSendReadiness()).toMatchObject({ ready: false, enabled: false });
  });
});

describe('pipeline receipts', () => {
  it('reads the counts a pipeline echoes back, whatever it calls them', () => {
    expect(parseReceipt(200, JSON.stringify({ status: 'ACCEPTED', fileId: 'FILE-77', accepted: 3, totalCents: 750000 })))
      .toMatchObject({ status: 'ACCEPTED', reference: 'FILE-77', acceptedCount: 3, totalAmountCents: 750000 });
    expect(parseReceipt(202, JSON.stringify({ reference: 'R-1', nbOfTxs: 2 })))
      .toMatchObject({ reference: 'R-1', acceptedCount: 2, totalAmountCents: null });
  });

  it('treats a body it cannot parse as accepted-but-uncounted rather than inventing totals', () => {
    const receipt = parseReceipt(200, 'OK');
    expect(receipt).toMatchObject({ status: 'accepted', reference: null, acceptedCount: null, totalAmountCents: null });
    expect(receipt.body).toBe('OK');
  });

  it('drops a clearing file beside the outbound directory, not inside it', () => {
    expect(dropPathFor({ dropDir: 'clearing' }, { outboundPath: '/wire/outbound' })).toBe('/wire/clearing');
    expect(dropPathFor({ dropDir: '/incoming/fedwire' }, { outboundPath: '/wire/outbound' })).toBe('/incoming/fedwire');
  });
});

describe('clearing batch states', () => {
  it('never lets a file the pipeline may hold report itself failed without a determination', () => {
    expect(BATCH_TRANSITIONS.transmitted).not.toContain('failed');
    expect(BATCH_TRANSITIONS.transmitting).toContain('held');
    expect(BATCH_TRANSITIONS.held).toEqual(['transmitted', 'rejected', 'failed']);
    expect(BATCH_TRANSITIONS.acknowledged).toEqual([]);
  });
});

describe('Direct Send engine', () => {
  let state: DirectState;
  let originalQuery: any;
  let spool: string;
  let archive: string;

  beforeEach(() => {
    clearDirectEnv();
    spool = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-send-spool-'));
    archive = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-send-archive-'));
    process.env.WIRE_H2H_SPOOL_DIR = spool;
    delete process.env.WIRE_H2H_SFTP_HOST;
    // File mode against the local spool: no bank is reachable from a test.
    process.env.WIRE_DIRECT_SEND_SIGNING_SECRET = 'shared-with-the-bank';
    process.env.WIRE_DIRECT_SEND_ARCHIVE_DIR = archive;

    state = emptyState();
    originalQuery = pool.query;
    pool.query = fakeDb(state);
    vi.spyOn(DualLedgerEngine, 'appendEvent').mockResolvedValue({} as never);
    vi.spyOn(InHouseBankEngine, 'require').mockImplementation(async (id: string) => dispatchedPayment(id));
    vi.spyOn(InHouseBankEngine, 'pacs008').mockImplementation(async (id: string) => pacs008For(id));
  });

  afterEach(() => {
    pool.query = originalQuery;
    delete process.env.WIRE_H2H_SPOOL_DIR;
    clearDirectEnv();
    fs.rmSync(spool, { recursive: true, force: true });
    fs.rmSync(archive, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('clears many dispatched wires in one signed file and claims each payment once', async () => {
    const result = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-1', 'IHB-2'] });

    expect(result).toMatchObject({ assembled: true, sent: true });
    expect(result.batch).toMatchObject({ state: 'transmitted', itemCount: 2, totalAmountCents: 500000, mode: 'file' });
    expect(result.batch.signatureAlgorithm).toBe('hmac-sha256');
    expect(state.transmissions.map((r) => r.state)).toEqual(['transmitted', 'transmitted']);
    // Payment identity in the vault names the file that carried it.
    expect(state.transmissions[0].filename).toBe(memberFilename(result.batch.filename, 'IHB-1'));

    // The bytes reached the bank drop directory, and only under their final name.
    const dropped = fs.readdirSync(path.join(spool, 'wire', 'clearing'));
    expect(dropped).toContain(result.batch.filename);
    expect(dropped).toContain(`${result.batch.filename}.sig`);
    expect(dropped).toContain(`${result.batch.filename}.manifest.json`);
    expect(dropped.some((name) => name.endsWith('.tmp'))).toBe(false);
    // And the trust kept its own copy of the instruction of record.
    expect(fs.readdirSync(path.join(archive, result.batch.batchId))).toContain(result.batch.filename);
  });

  it('will not clear the same payment twice, in a second file or as a single wire', async () => {
    const first = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    expect(first.sent).toBe(true);

    const second = await WireDirectSendEngine.assemble({ actor: 'operator-b', paymentIds: ['IHB-1'] });
    expect(second).toMatchObject({ assembled: false, reason: 'no_claimable_wires' });
    expect(second.skipped[0]).toMatchObject({ paymentId: 'IHB-1', reason: 'already_transmitted' });
    expect(state.batches).toHaveLength(1);
    expect(state.transmissions).toHaveLength(1);
  });

  it('sends one file per batch however many times it is pushed', async () => {
    const assembled = await WireDirectSendEngine.assemble({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    await WireDirectSendEngine.send(assembled.batch.batchId, { actor: 'operator-a' });
    const replay = await WireDirectSendEngine.send(assembled.batch.batchId, { actor: 'operator-b' });

    expect(replay).toMatchObject({ sent: false, replay: true, reason: 'already_transmitted' });
    expect(fs.readdirSync(path.join(spool, 'wire', 'clearing')).filter((n) => n.endsWith('.xml'))).toHaveLength(1);
  });

  it('keeps on-us transfers and unfunded payments out of the clearing file', async () => {
    (InHouseBankEngine.require as any).mockImplementation(async (id: string) => {
      if (id === 'IHB-INTERNAL') return dispatchedPayment(id, { internal: true });
      if (id === 'IHB-APPROVED') return dispatchedPayment(id, { status: 'approved' });
      if (id === 'IHB-RTP') return dispatchedPayment(id, { rail: 'rtp' });
      return dispatchedPayment(id);
    });

    const result = await WireDirectSendEngine.assemble({
      actor: 'operator-a',
      paymentIds: ['IHB-INTERNAL', 'IHB-APPROVED', 'IHB-RTP', 'IHB-1'],
    });

    expect(result.items).toEqual(['IHB-1']);
    expect(result.skipped.map((s: Row) => s.reason)).toEqual([
      'WIRE_DIRECT_SEND_INTERNAL_PAYMENT',
      'WIRE_DIRECT_SEND_NOT_DISPATCHED',
      'WIRE_DIRECT_SEND_RAIL_NOT_CARRIED',
    ]);
    expect(result.batch.payload).toBeUndefined();
    expect(state.transmissions.map((r) => r.payment_id)).toEqual(['IHB-1']);
  });

  it('releases the payments when the pipeline refuses the file, so a later file may carry them', async () => {
    vi.spyOn(transport, 'sendClearingFile').mockRejectedValue(
      new WireDirectSendTransportError('The clearing pipeline refused it with HTTP 400', 'WIRE_DIRECT_SEND_REFUSED', 502, {
        ambiguous: false,
        detail: 'invalid creditor routing number',
      })
    );

    const assembled = await WireDirectSendEngine.assemble({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    await expect(WireDirectSendEngine.send(assembled.batch.batchId, { actor: 'operator-a' })).rejects.toThrow(/refused/);

    expect(state.batches[0].state).toBe('failed');
    expect(state.transmissions[0].state).toBe('failed');
    // A refused file raises no ambiguity exception: the bank told us it has nothing.
    expect(state.exceptions).toHaveLength(0);

    // The released payment can be claimed by the next file, through the same vault row.
    (transport.sendClearingFile as any).mockRestore();
    const retry = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    expect(retry.sent).toBe(true);
    expect(state.transmissions).toHaveLength(1);
    expect(state.transmissions[0].state).toBe('transmitted');
  });

  it('holds an ambiguous send for an operator instead of clearing the money twice', async () => {
    vi.spyOn(transport, 'sendClearingFile').mockRejectedValue(
      new WireDirectSendTransportError('The clearing pipeline did not answer within 60000ms', 'WIRE_DIRECT_SEND_TIMEOUT', 504, {
        ambiguous: true,
      })
    );

    const assembled = await WireDirectSendEngine.assemble({ actor: 'operator-a', paymentIds: ['IHB-1', 'IHB-2'] });
    const held = await WireDirectSendEngine.send(assembled.batch.batchId, { actor: 'operator-a' });

    expect(held).toMatchObject({ sent: false, reason: 'held_for_operator' });
    expect(state.batches[0].state).toBe('held');
    // The payments stay claimed: nothing may pick them up while the bank might have them.
    expect(state.transmissions.map((r) => r.state)).toEqual(['transmitting', 'transmitting']);
    expect(state.exceptions[0]).toMatchObject({ kind: 'direct_send_ambiguous' });

    // A held file is never re-sent by asking again, and never resolved by a guess.
    expect(await WireDirectSendEngine.send(assembled.batch.batchId, { actor: 'operator-a' }))
      .toMatchObject({ sent: false, reason: 'held_for_operator' });
    await expect(WireDirectSendEngine.resolveHeld(assembled.batch.batchId, { actor: 'operator-a', note: 'checked' }))
      .rejects.toThrow(/explicit received=true\/false/);
    await expect(WireDirectSendEngine.resolveHeld(assembled.batch.batchId, { actor: 'operator-a', received: true }))
      .rejects.toThrow(/note recording what the bank confirmed/);

    const resolved = await WireDirectSendEngine.resolveHeld(assembled.batch.batchId, {
      actor: 'operator-a',
      received: true,
      note: 'bank operations confirmed the pipeline ingested the file as FILE-99',
    });
    expect(resolved).toMatchObject({ resolved: true, received: true });
    expect(resolved.batch.state).toBe('transmitted');
    expect(state.transmissions.map((r) => r.state)).toEqual(['transmitted', 'transmitted']);
  });

  it('releases the payments when the bank confirms a held file never arrived', async () => {
    vi.spyOn(transport, 'sendClearingFile').mockRejectedValue(
      new WireDirectSendTransportError('socket hang up', 'WIRE_DIRECT_SEND_UNREACHABLE', 502, { ambiguous: true })
    );
    const assembled = await WireDirectSendEngine.assemble({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    await WireDirectSendEngine.send(assembled.batch.batchId, { actor: 'operator-a' });

    const resolved = await WireDirectSendEngine.resolveHeld(assembled.batch.batchId, {
      actor: 'operator-a',
      received: false,
      note: 'bank operations confirmed no file was ingested',
    });
    expect(resolved.batch.state).toBe('failed');
    expect(state.transmissions[0].state).toBe('failed');
  });

  it('acknowledges a file whose control totals the bank balanced, and escalates one it did not', async () => {
    const cleared = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-1', 'IHB-2'] });

    const mismatch = await WireDirectSendEngine.acknowledge(cleared.batch.batchId, {
      actor: 'reconciliation',
      acceptedCount: 1,
      reference: 'FILE-99',
    });
    expect(mismatch.acknowledged).toBe(false);
    expect(state.exceptions[0]).toMatchObject({ kind: 'direct_send_control_mismatch' });
    expect(state.batches[0].state).toBe('transmitted');

    const balanced = await WireDirectSendEngine.acknowledge(cleared.batch.batchId, {
      actor: 'reconciliation',
      acceptedCount: 2,
      totalAmountCents: 500000,
      reference: 'FILE-99',
    });
    expect(balanced.acknowledged).toBe(true);
    expect(balanced.batch).toMatchObject({ state: 'acknowledged', bankReference: 'FILE-99' });
  });

  it('acknowledges straight away when the pipeline itself balanced the file', async () => {
    vi.spyOn(transport, 'sendClearingFile').mockResolvedValue({
      httpStatus: 200,
      status: 'ACCEPTED',
      reference: 'FILE-77',
      acceptedCount: 1,
      totalAmountCents: 250000,
      mode: 'pipeline',
    } as never);

    const cleared = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    expect(cleared.batch).toMatchObject({ state: 'acknowledged', bankReference: 'FILE-77' });
  });

  it('raises an exception when the pipeline accepted fewer wires than were sent', async () => {
    vi.spyOn(transport, 'sendClearingFile').mockResolvedValue({
      httpStatus: 200, status: 'PARTIAL', reference: 'FILE-78', acceptedCount: 1, totalAmountCents: 250000, mode: 'pipeline',
    } as never);

    const cleared = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-1', 'IHB-2'] });
    expect(cleared.batch.state).toBe('transmitted');
    expect(state.exceptions[0]).toMatchObject({ kind: 'direct_send_control_mismatch' });
  });

  it('gives the payments back when an assembled file is abandoned, and refuses to abandon a sent one', async () => {
    const assembled = await WireDirectSendEngine.assemble({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    const cancelled = await WireDirectSendEngine.cancel(assembled.batch.batchId, { actor: 'operator-a', reason: 'wrong cutoff' });

    expect(cancelled.batch.state).toBe('cancelled');
    expect(state.transmissions[0].state).toBe('failed');

    const sent = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-2'] });
    await expect(WireDirectSendEngine.cancel(sent.batch.batchId, { actor: 'operator-a' }))
      .rejects.toThrow(/cannot go from transmitted to cancelled/);
  });

  it('will not build a file below the batch minimum, and releases what it claimed', async () => {
    process.env.WIRE_DIRECT_SEND_MIN_ITEMS = '2';
    const result = await WireDirectSendEngine.assemble({ actor: 'operator-a', paymentIds: ['IHB-1'] });

    expect(result).toMatchObject({ assembled: false, reason: 'below_minimum_items' });
    expect(state.batches).toHaveLength(0);
    expect(state.transmissions[0].state).toBe('failed');
  });

  it('leaves a wire out of the file rather than breaching the file value cap', async () => {
    process.env.WIRE_DIRECT_SEND_MAX_AMOUNT_CENTS = '300000';
    const result = await WireDirectSendEngine.assemble({ actor: 'operator-a', paymentIds: ['IHB-1', 'IHB-2'] });

    expect(result.items).toEqual(['IHB-1']);
    expect(result.skipped[0]).toMatchObject({ paymentId: 'IHB-2', reason: 'file_amount_cap' });
  });

  it('refuses to assemble anything while the channel is closed', async () => {
    process.env.WIRE_DIRECT_SEND_ENABLED = 'false';
    await expect(WireDirectSendEngine.assemble({ actor: 'operator-a', paymentIds: ['IHB-1'] }))
      .rejects.toThrow(/Direct Send is not configured/);
    expect(state.transmissions).toHaveLength(0);
  });

  it('escalates a file the bank has not acknowledged, and one stuck mid-send', async () => {
    const cleared = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    state.batches[0].transmitted_at = new Date(Date.now() - 120 * 60000);
    state.batches.push({
      ...state.batches[0],
      batch_id: 'DSB-STUCK',
      state: 'transmitting',
      filename: 'PTCCLR-STUCK.xml',
      updated_at: new Date(Date.now() - 120 * 60000),
    });

    const reconciled = await WireDirectSendEngine.reconcile({ actor: 'reconciliation' });
    expect(reconciled.exceptions).toBe(2);
    expect(state.exceptions.map((e) => e.kind)).toEqual(['direct_send_unacknowledged', 'direct_send_stuck']);
    expect(state.exceptions[0].filename).toBe(cleared.batch.filename);
  });

  it('offers the operator the file, its manifest and its whole history', async () => {
    const cleared = await WireDirectSendEngine.directSend({ actor: 'operator-a', paymentIds: ['IHB-1'] });
    const batch = await WireDirectSendEngine.batch(cleared.batch.batchId, { includePayload: true });

    expect(batch.payload).toContain('<NbOfTxs>1</NbOfTxs>');
    expect(batch.manifest.controls.payloadSha256).toBe(batch.payloadHash);
    expect(batch.items).toHaveLength(1);
    expect(batch.transmissions[0].state).toBe('transmitted');
    expect(batch.history.map((entry: Row) => entry.to)).toEqual(['assembled', 'transmitting', 'transmitted']);
  });

  it('offers only dispatched external wires on a carried rail for the next file', async () => {
    state.payments.push({ payment_id: 'IHB-1', rail: 'fedwire', amount_cents: 250000, fee_cents: 0, currency: 'USD', dispatched_at: new Date() });
    const pending = await WireDirectSendEngine.pending({ limit: 10 });

    expect(pending).toEqual([{ paymentId: 'IHB-1', rail: 'fedwire', amountCents: 250000, feeCents: 0, currency: 'USD', dispatchedAt: expect.any(Date) }]);
    const sql = (pool.query as any).mock.calls.map((call: any[]) => String(call[0]).replace(/\s+/g, ' ')).join(' ');
    expect(sql).toContain("p.status = 'dispatched'");
    expect(sql).toContain('p.internal = FALSE');
    expect(sql).toContain('w.transmission_id IS NULL');
  });
});

describe('vault sharing between the two wire paths', () => {
  it('keys a batched wire on the payment, exactly as a single wire is keyed', () => {
    expect(WireIdempotencyVault.wireKeyFor('IHB-1')).toBe('wire:IHB-1');
    expect(memberFilename('PTCCLR-20260201120000-AAA.xml', 'IHB-1')).toBe('PTCCLR-20260201120000-AAA.xml#IHB-1');
  });
});

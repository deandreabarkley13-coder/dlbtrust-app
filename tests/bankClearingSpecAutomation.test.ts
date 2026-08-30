import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  detectFormat,
  normalize,
  normalizeRail,
} = require('../server/integrations/inhouseBank/clearing/clearingIntakeDetector');
const {
  formatToSpec,
  specIds,
} = require('../server/integrations/inhouseBank/clearing/clearingSpecRegistry');
const {
  ClearingAutoFormatEngine,
  resolveRail,
  resolveSpec,
} = require('../server/integrations/inhouseBank/clearing/clearingAutoFormatEngine');
const { parseRailMap, getClearingSpecConfig } = require('../server/integrations/inhouseBank/clearing/clearingSpecConfig');
const { parseNACHAFile } = require('../server/integrations/ach/nachaGenerator');

const VENDOR_CSV = [
  'reference,payee_name,routing_number,account_number,amount,memo,rail',
  'INV-1001,ACME SUPPLY CO,021000021,1234567890,1250.00,INVOICE 1001,fedwire',
  'INV-1002,BLUE RIDGE LLC,021000021,9876543210,"3,400.55",INVOICE 1002,fedwire',
].join('\n');

const PAYROLL_JSON = JSON.stringify({
  payments: [
    {
      id: 'PR-1',
      beneficiary: 'JANE DOE',
      aba: '021000021',
      account: '11122233',
      amountCents: 225000,
      method: 'ach',
      account_type: 'checking',
      memo: 'PAYROLL',
    },
  ],
});

const PROFILE = {
  senderId: 'PTCUUS41XXX',
  senderName: 'DLB TRUST',
  senderRouting: '021000021',
  senderAccount: '100200300',
  receiverId: 'BANKUS33XXX',
  receiverRouting: '021000021',
  receiverName: 'RECEIVING BANK',
  currency: 'USD',
};

function instruction(overrides: Record<string, any> = {}) {
  return {
    reference: 'REF-1',
    endToEndId: 'REF-1',
    amountCents: 125000,
    currency: 'USD',
    rail: 'fedwire',
    direction: 'credit',
    debtor: { name: 'DLB TRUST', accountNumber: '100200300' },
    creditor: {
      name: 'ACME SUPPLY CO',
      accountNumber: '1234567890',
      routingNumber: '021000021',
      country: 'US',
    },
    remittanceInformation: 'INVOICE 1001',
    ...overrides,
  };
}

describe('bank clearing spec automation — inbound detection', () => {
  it('detects each format a data workflow emits from its structure, not its extension', () => {
    expect(detectFormat(VENDOR_CSV)).toMatchObject({ format: 'csv' });
    expect(detectFormat(PAYROLL_JSON)).toMatchObject({ format: 'json', confidence: 'certain' });
    expect(detectFormat('<Document><CstmrCdtTrfInitn/></Document>')).toMatchObject({
      format: 'pain.001',
      confidence: 'certain',
    });
    expect(detectFormat('<Document><FIToFICstmrCdtTrf/></Document>')).toMatchObject({
      format: 'pacs.008',
      confidence: 'certain',
    });
  });

  it('refuses payload it cannot identify rather than guessing a format', () => {
    expect(() => detectFormat('garbage not a payment file\n')).toThrowError(/matches no known payment data format/);
    expect(() => detectFormat('<Document><SomeOtherIsoMessage/></Document>')).toThrowError(/CustomerCreditTransferInitiation/);
    expect(() => detectFormat('   ')).toThrowError(/empty/);
  });

  it('lifts CSV columns into canonical instructions across source naming conventions', () => {
    const { instructions } = normalize(VENDOR_CSV);
    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toMatchObject({
      reference: 'INV-1001',
      amountCents: 125000,
      currency: 'USD',
      rail: 'fedwire',
      direction: 'credit',
    });
    expect(instructions[0].creditor).toMatchObject({
      name: 'ACME SUPPLY CO',
      routingNumber: '021000021',
      accountNumber: '1234567890',
    });
    // A quoted, thousands-separated amount is a currency value, not a string to round.
    expect(instructions[1].amountCents).toBe(340055);
  });

  it('refuses an amount it cannot read as currency instead of rounding it', () => {
    const bad = 'reference,payee_name,routing_number,account_number,amount\nX,Y,021000021,1,about a thousand';
    expect(() => normalize(bad)).toThrowError(/is not a currency value/);
  });

  it('maps source-system rail vocabularies onto the rails the bank clears', () => {
    expect(normalizeRail('WIRE')).toBe('fedwire');
    expect(normalizeRail('Fedwire')).toBe('fedwire');
    expect(normalizeRail('instant')).toBe('rtp');
    expect(normalizeRail('cross-border')).toBe('swift');
    expect(normalizeRail('NACHA')).toBe('ach');
    expect(normalizeRail('')).toBeNull();
  });
});

describe('bank clearing spec automation — rendering to spec', () => {
  it('renders a pacs.008 whose group header totals agree with its transactions', () => {
    const formatted = formatToSpec({
      specId: 'pacs.008.001.08',
      instructions: [instruction(), instruction({ reference: 'REF-2', amountCents: 340055 })],
      batchId: 'CLRFMT-TEST-1',
      profile: PROFILE,
      createdAt: new Date('2026-03-04T10:00:00Z'),
    });

    expect(formatted.payload).toContain('urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08');
    expect(formatted.payload).toContain('<NbOfTxs>2</NbOfTxs>');
    expect(formatted.payload).toContain('<TtlIntrBkSttlmAmt Ccy="USD">4650.55</TtlIntrBkSttlmAmt>');
    expect(formatted.controls).toMatchObject({ count: 2, totalAmountCents: 465055 });
    expect(formatted.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    // The rendered file must be readable back as the same payments.
    const { instructions: roundTripped } = normalize(formatted.payload);
    expect(roundTripped.map((entry: any) => entry.amountCents)).toEqual([125000, 340055]);
    expect(roundTripped[0].creditor.routingNumber).toBe('021000021');
  });

  it('omits an empty debtor account element rather than emitting one a bank rejects', () => {
    const formatted = formatToSpec({
      specId: 'pacs.008.001.08',
      instructions: [instruction({ debtor: { name: 'DLB TRUST', accountNumber: null } })],
      batchId: 'CLRFMT-TEST-2',
      profile: { ...PROFILE, senderAccount: '' },
      createdAt: new Date('2026-03-04T10:00:00Z'),
    });
    expect(formatted.payload).not.toContain('<DbtrAcct>');
  });

  it('renders NACHA the repository’s own parser reads back with balanced control totals', () => {
    const formatted = formatToSpec({
      specId: 'nacha-ccd',
      instructions: [instruction({ rail: 'ach', creditor: { ...instruction().creditor, accountType: 'checking' } })],
      batchId: 'CLRFMT-TEST-3',
      profile: PROFILE,
      createdAt: new Date('2026-03-04T10:00:00Z'),
    });

    // NACHA records are 94 characters and CRLF-terminated, as the ODFI expects.
    const lines = formatted.payload.split('\r\n').filter((line: string) => line.length > 0);
    expect(lines.every((line: string) => line.length === 94)).toBe(true);
    expect(lines.length % 10).toBe(0);

    const parsed = parseNACHAFile(formatted.payload);
    const entries = parsed.batches.flatMap((batch: any) => batch.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0].individualName).toContain('ACME SUPPLY CO');
    expect(formatted.controls).toMatchObject({ count: 1, totalAmountCents: 125000, secCode: 'CCD' });
  });

  it('renders the Fedwire tag format with amounts in whole cents', () => {
    const formatted = formatToSpec({
      specId: 'fedwire-tag',
      instructions: [instruction()],
      batchId: 'CLRFMT-TEST-4',
      profile: PROFILE,
      createdAt: new Date('2026-03-04T10:00:00Z'),
    });
    expect(formatted.payload).toContain('{2000}000000125000');
    expect(formatted.payload).toContain('{3400}021000021');
    expect(formatted.payload).toContain('ACME SUPPLY CO');
    expect(formatted.extension).toBe('.fwr');
  });

  it('rejects an instruction the bank would reject, naming the field, before rendering', () => {
    expect(() =>
      formatToSpec({
        specId: 'pacs.008.001.08',
        instructions: [instruction({ creditor: { name: 'ACME', accountNumber: null, routingNumber: null } })],
        batchId: 'CLRFMT-TEST-5',
        profile: PROFILE,
      })
    ).toThrowError(/cannot be cleared as pacs\.008\.001\.08/);

    expect(() =>
      formatToSpec({
        specId: 'nacha-ccd',
        instructions: [instruction({ creditor: { ...instruction().creditor, routingNumber: '123456789' } })],
        batchId: 'CLRFMT-TEST-6',
        profile: PROFILE,
      })
    ).toThrowError(/nacha-ccd/);
  });

  it('refuses to balance two currencies in one clearing file', () => {
    expect(() =>
      formatToSpec({
        specId: 'pacs.008.001.08',
        instructions: [instruction(), instruction({ reference: 'REF-EUR', currency: 'EUR' })],
        batchId: 'CLRFMT-TEST-7',
        profile: PROFILE,
      })
    ).toThrowError(/one currency per file/);
  });

  it('refuses an empty file and an unknown spec', () => {
    expect(() => formatToSpec({ specId: 'pacs.008.001.08', instructions: [], batchId: 'B', profile: PROFILE }))
      .toThrowError(/at least one instruction/);
    expect(() => formatToSpec({ specId: 'iso-9999', instructions: [instruction()], batchId: 'B', profile: PROFILE }))
      .toThrowError(/Unknown bank clearing spec/);
  });
});

describe('bank clearing spec automation — rail and spec resolution', () => {
  const config = { defaultRail: 'fedwire', railSpecs: { fedwire: 'pacs.008.001.08', ach: 'nacha-ccd' } };

  it('takes the rail from the source data, then the caller, then configuration', () => {
    expect(resolveRail([instruction({ rail: 'ach' })], { config })).toMatchObject({ rail: 'ach', source: 'source data' });
    expect(resolveRail([instruction({ rail: null })], { config })).toMatchObject({ rail: 'fedwire' });
    expect(resolveRail([instruction({ rail: 'ach' })], { requestedRail: 'RTP', config }))
      .toMatchObject({ rail: 'rtp', source: 'caller' });
  });

  it('refuses to put two rails in one clearing file', () => {
    expect(() => resolveRail([instruction({ rail: 'ach' }), instruction({ rail: 'fedwire' })], { config }))
      .toThrowError(/one clearing file clears one rail/);
  });

  it('resolves the output spec from configuration, never from the payload', () => {
    expect(resolveSpec({ rail: 'ach', config })).toMatchObject({
      specId: 'nacha-ccd',
      source: 'CLEARING_SPEC_RAIL_MAP',
    });
    expect(() => resolveSpec({ rail: 'sepa', config })).toThrowError(/No bank clearing spec is configured/);
    expect(() => resolveSpec({ rail: 'ach', requestedSpec: 'iso-9999', config })).toThrowError(/Unknown bank clearing spec/);
  });

  it('parses the rail map every spec it names is registered for', () => {
    expect(parseRailMap('fedwire=pacs.008.001.08, ach=nacha-ccd')).toEqual({
      fedwire: 'pacs.008.001.08',
      ach: 'nacha-ccd',
    });
    expect(parseRailMap('nonsense')).toEqual({});
    for (const spec of Object.values(getClearingSpecConfig().railSpecs)) {
      expect(specIds()).toContain(spec);
    }
  });
});

describe('bank clearing spec automation — end to end and intake', () => {
  let workDir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-spec-'));
    process.env.CLEARING_AUTOFORMAT_INTAKE_DIR = path.join(workDir, 'intake');
    process.env.CLEARING_AUTOFORMAT_ARCHIVE_DIR = path.join(workDir, 'archive');
    process.env.CLEARING_AUTOFORMAT_SENDER_ROUTING = '021000021';
    process.env.CLEARING_AUTOFORMAT_SENDER_ACCOUNT = '100200300';
    process.env.CLEARING_AUTOFORMAT_DELIVER = 'false';
  });

  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('inspects without rendering or writing anything', () => {
    const inspected = ClearingAutoFormatEngine.inspect({ input: VENDOR_CSV });
    expect(inspected).toMatchObject({ rail: 'fedwire', spec: 'pacs.008.001.08' });
    expect(inspected.summary).toMatchObject({ count: 2, totalAmountCents: 465055 });
    expect(fs.existsSync(path.join(workDir, 'archive'))).toBe(false);
  });

  it('formats a workflow CSV into the rail’s spec and archives the evidence', async () => {
    const result = await ClearingAutoFormatEngine.format({ input: VENDOR_CSV, source: 'test' });
    expect(result).toMatchObject({
      spec: 'pacs.008.001.08',
      rail: 'fedwire',
      specSource: 'CLEARING_SPEC_RAIL_MAP',
      delivered: false,
    });
    expect(result.filename).toMatch(/^PTCFMT-FEDWIRE-\d+-[0-9A-F]+\.xml$/);
    expect(fs.readFileSync(path.join(result.archivePath, result.filename), 'utf8')).toBe(result.payload);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(result.archivePath, `${result.filename}.manifest.json`), 'utf8')
    );
    expect(manifest.controls.payloadSha256).toBe(result.controls.payloadSha256);
    expect(manifest.items).toHaveLength(2);
  });

  it('follows the ACH rail to the NACHA spec when the source data names it', async () => {
    const result = await ClearingAutoFormatEngine.format({ input: PAYROLL_JSON, source: 'test' });
    expect(result).toMatchObject({ rail: 'ach', railSource: 'source data', spec: 'nacha-ccd' });
    expect(result.filename.endsWith('.ach')).toBe(true);
  });

  it('cannot be talked into a different bank’s format by the payload it is given', async () => {
    // A pacs.008 arriving on the ACH rail still clears as the configured NACHA
    // spec: inbound bytes choose the parser, configuration chooses the output.
    const pacs = await ClearingAutoFormatEngine.format({ input: VENDOR_CSV, source: 'test' });
    const rerouted = await ClearingAutoFormatEngine.format({ input: pacs.payload, rail: 'ach', source: 'test' });
    expect(rerouted.detection.format).toBe('pacs.008');
    expect(rerouted.spec).toBe('nacha-ccd');
  });

  it('refuses to format when the automation is switched off', async () => {
    process.env.CLEARING_AUTOFORMAT_ENABLED = 'false';
    await expect(ClearingAutoFormatEngine.format({ input: VENDOR_CSV })).rejects.toThrowError(/is off/);
    expect(ClearingAutoFormatEngine.readiness().ready).toBe(false);
  });

  it('holds the file back when delivery is asked for and the bank channel is closed', async () => {
    delete process.env.WIRE_DIRECT_SEND_URL;
    process.env.WIRE_DIRECT_SEND_ENABLED = 'false';
    await expect(ClearingAutoFormatEngine.format({ input: VENDOR_CSV, deliver: true }))
      .rejects.toThrowError(/formatted and archived but not sent/);
  });

  it('refuses a file over the configured ceilings', async () => {
    process.env.CLEARING_AUTOFORMAT_MAX_AMOUNT_CENTS = '100000';
    await expect(ClearingAutoFormatEngine.format({ input: VENDOR_CSV })).rejects.toThrowError(/over the CLEARING_AUTOFORMAT_MAX_AMOUNT_CENTS ceiling/);
    process.env.CLEARING_AUTOFORMAT_MAX_AMOUNT_CENTS = '0';
    process.env.CLEARING_AUTOFORMAT_MAX_INPUT_BYTES = '1024';
    await expect(ClearingAutoFormatEngine.format({ input: 'x'.repeat(2048) })).rejects.toThrowError(/over the CLEARING_AUTOFORMAT_MAX_INPUT_BYTES ceiling/);
  });

  it('runs an intake cycle that formats good files, quarantines bad ones and repeats safely', async () => {
    const inbox = path.join(workDir, 'intake', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'vendors.csv'), VENDOR_CSV);
    fs.writeFileSync(path.join(inbox, 'payroll.json'), PAYROLL_JSON);
    fs.writeFileSync(path.join(inbox, 'broken.csv'), 'garbage not a payment file\n');

    const cycle = await ClearingAutoFormatEngine.runIntakeCycle({ trigger: 'test' });
    expect(cycle.formatted).toHaveLength(2);
    expect(cycle.failed).toHaveLength(1);
    expect(cycle.failed[0]).toMatchObject({ input: 'broken.csv', code: 'CLEARING_INTAKE_UNRECOGNISED' });
    expect(cycle.delivered).toBe(false);

    const outbox = fs.readdirSync(path.join(workDir, 'intake', 'outbox'));
    expect(outbox.filter(name => name.endsWith('.xml'))).toHaveLength(1);
    expect(outbox.filter(name => name.endsWith('.ach'))).toHaveLength(1);
    expect(outbox.filter(name => name.endsWith('.manifest.json'))).toHaveLength(2);

    // Every input leaves the inbox, so a scheduled cycle never re-formats — and
    // never re-sends — a file it has already handled.
    expect(fs.readdirSync(inbox)).toHaveLength(0);
    expect(fs.readdirSync(path.join(workDir, 'intake', 'processed'))).toHaveLength(2);
    expect(fs.readdirSync(path.join(workDir, 'intake', 'failed')).sort()).toEqual(['broken.csv', 'broken.csv.error.json']);

    const second = await ClearingAutoFormatEngine.runIntakeCycle({ trigger: 'test' });
    expect(second.formatted).toHaveLength(0);
    expect(second.failed).toHaveLength(0);
  });

  it('leaves the intake scheduler off unless it is explicitly switched on', () => {
    expect(ClearingAutoFormatEngine.startAutoIntake()).toMatchObject({
      started: false,
      reason: 'CLEARING_AUTOFORMAT_AUTO_INTAKE is off',
    });
  });

  it('reports its readiness and the specs it can render', () => {
    const status = ClearingAutoFormatEngine.status();
    expect(status.ready).toBe(true);
    expect(status.specs.map((spec: any) => spec.id)).toEqual(
      expect.arrayContaining(['pacs.008.001.08', 'fedwire-tag', 'nacha-ccd', 'nacha-ppd'])
    );
    expect(status.railSpecs.ach).toBe('nacha-ccd');
  });
});

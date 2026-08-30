import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const stateMachine = require('../server/integrations/inhouseBank/wire/wireStateMachine');
const { parseAdvice } = require('../server/integrations/inhouseBank/wire/wireAdviceParser');
const { SpoolSession } = require('../server/integrations/inhouseBank/wire/wireTransport');
const { getWireChannelConfig } = require('../server/integrations/inhouseBank/wire/wireHostToHostConfig');
const { WireIdempotencyVault } = require('../server/integrations/inhouseBank/wire/wireIdempotencyVault');
const { WireHostToHostEngine } = require('../server/integrations/inhouseBank/wire/wireHostToHostEngine');
const { InHouseBankEngine } = require('../server/integrations/inhouseBank/inHouseBankEngine');
const { DualLedgerEngine } = require('../server/integrations/inhouseBank/dualLedgerEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

interface WireState {
  transmissions: Row[];
  log: Row[];
  advices: Row[];
  exceptions: Row[];
  payments: Row[];
}

/**
 * The wire engine touches only its own ihb_wire_* tables plus a read of
 * ihb_payments during reconciliation, so the fake recognises exactly those.
 * Anything else throws: an unhandled statement quietly returning no rows would
 * make a duplicate-suppression test pass for the wrong reason.
 */
function fakeDb(state: WireState) {
  const clone = (row: Row) => ({ ...row });
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|DROP)/i.test(text)) return { rows: [] };

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
      const row = state.transmissions.find(
        (r) => r.transmission_id === params[0] || r.transmission_id === params[0]
      );
      if (!row) return { rows: [] };
      for (const [, column, position] of text.matchAll(/(\w+) = \$(\d+)/g)) {
        row[column] = params[Number(position) - 1];
      }
      row.updated_at = new Date();
      return { rows: [clone(row)] };
    }

    if (text.startsWith('SELECT * FROM ihb_wire_transmissions WHERE transmission_id')) {
      return { rows: state.transmissions.filter((r) => r.transmission_id === params[0]).map(clone) };
    }
    if (text.startsWith('SELECT * FROM ihb_wire_transmissions WHERE wire_key')) {
      return { rows: state.transmissions.filter((r) => r.wire_key === params[0]).map(clone) };
    }
    if (text.startsWith('SELECT * FROM ihb_wire_transmissions WHERE filename')) {
      return { rows: state.transmissions.filter((r) => r.filename === params[0]).map(clone) };
    }
    if (text.startsWith('SELECT * FROM ihb_wire_transmissions WHERE payment_id')) {
      return { rows: state.transmissions.filter((r) => r.payment_id === params[0]).map(clone) };
    }
    if (text.startsWith('SELECT * FROM ihb_wire_transmissions WHERE ($1::text IS NOT NULL AND payment_id')) {
      const [paymentId, endToEndId, uetr, bankReference] = params;
      const match = state.transmissions.find(
        (r) =>
          (paymentId && r.payment_id === paymentId) ||
          (endToEndId && r.end_to_end_id === endToEndId) ||
          (uetr && r.uetr === uetr) ||
          (bankReference && r.bank_reference === bankReference)
      );
      return { rows: match ? [clone(match)] : [] };
    }
    if (text.startsWith("SELECT * FROM ihb_wire_transmissions WHERE state = 'transmitted'")) return { rows: [] };
    if (text.startsWith("SELECT * FROM ihb_wire_transmissions WHERE state = 'acknowledged'")) return { rows: [] };
    if (text.startsWith("SELECT * FROM ihb_wire_transmissions WHERE state IN ('reserved','transmitting')")) return { rows: [] };
    if (text.startsWith('SELECT * FROM ihb_wire_transmissions')) return { rows: state.transmissions.map(clone) };
    if (text.startsWith('SELECT state, COUNT(*)')) {
      return { rows: [{ state: 'transmitted', count: state.transmissions.length, amount_cents: 0 }] };
    }

    if (text.startsWith('INSERT INTO ihb_wire_state_log')) {
      state.log.push({ transmission_id: params[1], from_state: params[3], to_state: params[4], actor: params[5], reason: params[6] });
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM ihb_wire_state_log')) {
      return { rows: state.log.filter((r) => r.transmission_id === params[0]).map(clone) };
    }

    if (text.startsWith('INSERT INTO ihb_wire_advices')) {
      if (state.advices.some((r) => r.content_hash === params[1])) return { rows: [] };
      const row = { advice_id: params[0], content_hash: params[1], advice_type: params[3], applied: false };
      state.advices.push(row);
      return { rows: [{ advice_id: params[0] }] };
    }
    if (text.startsWith('UPDATE ihb_wire_advices')) {
      const row = state.advices.find((r) => r.advice_id === params[0]);
      if (row) { row.applied = true; row.outcome = params[1]; }
      return { rows: [] };
    }

    if (text.startsWith('INSERT INTO ihb_wire_exceptions')) {
      const key = params[2] || params[4] || '';
      const existing = state.exceptions.find((r) => r.kind === params[1] && (r.transmission_id || r.filename || '') === key && !r.resolved);
      if (existing) {
        existing.detail = params[5];
        existing.last_seen_at = new Date();
        return { rows: [clone(existing)] };
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
    if (text.startsWith('UPDATE ihb_wire_exceptions')) {
      const row = state.exceptions.find((r) => r.exception_id === params[0] && !r.resolved);
      if (!row) return { rows: [] };
      row.resolved = true;
      row.resolved_by = params[1];
      row.resolution = params[2];
      row.resolved_at = new Date();
      return { rows: [clone(row)] };
    }
    if (text.startsWith('SELECT * FROM ihb_wire_exceptions')) {
      return { rows: state.exceptions.filter((r) => Boolean(r.resolved) === Boolean(params[0])).map(clone) };
    }

    if (text.startsWith('SELECT p.payment_id')) return { rows: state.payments.map(clone) };

    throw new Error(`unhandled SQL in test fake: ${text.slice(0, 100)}`);
  });
}

const PACS008 = '<?xml version="1.0"?><Document><FIToFICstmrCdtTrf><CdtTrfTxInf><PmtId><InstrId>IHB-1</InstrId></PmtId></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>';

function dispatchedPayment(overrides: Row = {}) {
  return {
    paymentId: 'IHB-1',
    status: 'dispatched',
    internal: false,
    rail: 'fedwire',
    amountCents: 250000,
    feeCents: 0,
    currency: 'USD',
    endToEndId: 'E2E-1',
    uetr: 'UETR-1',
    creditor: { name: 'Barkley Household LLC', accountNumber: '123456789' },
    dispatchedAt: '2026-02-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('wire state machine', () => {
  it('never lets a wire the bank can already see report itself as failed', () => {
    expect(stateMachine.canTransition('transmitting', 'failed')).toBe(true);
    expect(stateMachine.canTransition('transmitted', 'failed')).toBe(false);
    expect(() => stateMachine.assertTransition('transmitted', 'failed', { transmissionId: 'IHW-1' })).toThrow(
      /cannot go from transmitted to failed/
    );
  });

  it('allows a settled wire to be returned but nothing else', () => {
    expect(stateMachine.canTransition('settled', 'returned')).toBe(true);
    expect(stateMachine.canTransition('settled', 'acknowledged')).toBe(false);
    expect(stateMachine.canTransition('returned', 'settled')).toBe(false);
  });

  it('treats a replayed advice as a no-op instead of an error', () => {
    expect(stateMachine.assertTransition('acknowledged', 'acknowledged')).toEqual({
      changed: false,
      from: 'acknowledged',
      to: 'acknowledged',
    });
  });

  it('permits a retry only after a failure that never reached the bank', () => {
    expect(stateMachine.canTransition('failed', 'reserved')).toBe(true);
    expect(stateMachine.canTransition('rejected', 'reserved')).toBe(false);
  });
});

describe('bank advice parsing', () => {
  it('reads settlement out of a pacs.002 status report', () => {
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10">
      <FIToFIPmtStsRpt>
        <GrpHdr><MsgId>ACK-9001</MsgId><OrgnlMsgId>PTCWIRE_20260201T120000_IHB-1.xml</OrgnlMsgId></GrpHdr>
        <TxInfAndSts>
          <OrgnlEndToEndId>E2E-1</OrgnlEndToEndId>
          <TxSts>ACSC</TxSts>
          <AcctSvcrRef>20260201FED0001</AcctSvcrRef>
        </TxInfAndSts>
      </FIToFIPmtStsRpt></Document>`;
    const [advice] = parseAdvice(xml, 'ack-9001.xml');
    expect(advice).toMatchObject({
      adviceType: 'status',
      endToEndId: 'E2E-1',
      status: 'ACSC',
      outcome: 'settled',
      bankReference: '20260201FED0001',
    });
  });

  it('maps an accepted status to acknowledged, not settled', () => {
    const [advice] = parseAdvice(
      '<Document><FIToFIPmtStsRpt><TxInfAndSts><OrgnlEndToEndId>E2E-1</OrgnlEndToEndId><TxSts>ACTC</TxSts></TxInfAndSts></FIToFIPmtStsRpt></Document>'
    );
    expect(advice.outcome).toBe('acknowledged');
  });

  it('reads a pacs.004 return with its reason', () => {
    const xml = `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.004.001.09"><PmtRtr>
      <TxInf>
        <RtrId>RTN-4455</RtrId>
        <OrgnlEndToEndId>E2E-1</OrgnlEndToEndId>
        <RtrdIntrBkSttlmAmt Ccy="USD">2500.00</RtrdIntrBkSttlmAmt>
        <RtrRsnInf><Rsn><Cd>AC04</Cd></Rsn><AddtlInf>Beneficiary account closed</AddtlInf></RtrRsnInf>
      </TxInf></PmtRtr></Document>`;
    const [advice] = parseAdvice(xml, 'rtn.xml');
    expect(advice).toMatchObject({
      adviceType: 'return',
      outcome: 'returned',
      bankReference: 'RTN-4455',
      reason: 'Beneficiary account closed',
      amountCents: 250000,
      currency: 'USD',
    });
  });

  it('accepts the delimited and JSON advice shapes banks also send', () => {
    const [csv] = parseAdvice('end_to_end_id|status|reference\nE2E-1|ACSC|FED-77', 'ack.psv');
    expect(csv).toMatchObject({ endToEndId: 'E2E-1', outcome: 'settled', bankReference: 'FED-77' });

    const [json] = parseAdvice(JSON.stringify({ endToEndId: 'E2E-1', status: 'RJCT', reason: 'Invalid routing number' }));
    expect(json).toMatchObject({ outcome: 'rejected', reason: 'Invalid routing number' });
  });

  it('refuses an empty advice file rather than treating it as no news', () => {
    expect(() => parseAdvice('   ', 'empty.xml')).toThrow(/empty/);
  });
});

describe('spool transport', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-spool-'));
    process.env.WIRE_H2H_SPOOL_DIR = dir;
  });
  afterEach(() => {
    delete process.env.WIRE_H2H_SPOOL_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never leaves a partially written file under the final name', async () => {
    const config = getWireChannelConfig();
    const session = await SpoolSession.open(config);
    const remote = await session.put(config.outboundPath, 'PTCWIRE_TEST.xml', PACS008);

    expect(remote).toBe(`${config.outboundPath}/PTCWIRE_TEST.xml`);
    const outbound = fs.readdirSync(path.join(dir, 'wire', 'outbound'));
    expect(outbound).toEqual(['PTCWIRE_TEST.xml']);
    expect(await session.read(remote)).toBe(PACS008);

    await session.move(remote, config.archivePath, 'PTCWIRE_TEST.xml');
    expect(fs.readdirSync(path.join(dir, 'wire', 'outbound'))).toEqual([]);
    expect((await session.list(config.archivePath)).map((e: Row) => e.name)).toEqual(['PTCWIRE_TEST.xml']);
  });
});

describe('wire idempotency vault and engine', () => {
  let state: WireState;
  let originalQuery: any;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-engine-'));
    process.env.WIRE_H2H_SPOOL_DIR = dir;
    delete process.env.WIRE_H2H_SFTP_HOST;
    state = { transmissions: [], log: [], advices: [], exceptions: [], payments: [] };
    originalQuery = pool.query;
    pool.query = fakeDb(state);
    vi.spyOn(DualLedgerEngine, 'appendEvent').mockResolvedValue({} as never);
    vi.spyOn(InHouseBankEngine, 'require').mockImplementation(async () => dispatchedPayment());
    vi.spyOn(InHouseBankEngine, 'get').mockImplementation(async () => dispatchedPayment());
    vi.spyOn(InHouseBankEngine, 'pacs008').mockResolvedValue(PACS008 as never);
    vi.spyOn(InHouseBankEngine, 'confirm').mockImplementation(async (id: string, opts: Row) => ({
      paymentId: id,
      status: opts.outcome,
    }));
  });

  afterEach(() => {
    pool.query = originalQuery;
    delete process.env.WIRE_H2H_SPOOL_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('transmits a dispatched payment exactly once, however many times it is pushed', async () => {
    const first = await WireHostToHostEngine.transmit('IHB-1', { actor: 'operator-a' });
    expect(first.transmitted).toBe(true);
    expect(first.transmission.state).toBe('transmitted');
    expect(first.transmission.filename).toBe('PTCWIRE_20260201T120000_IHB-1.xml');

    const second = await WireHostToHostEngine.transmit('IHB-1', { actor: 'operator-b' });
    expect(second).toMatchObject({ transmitted: false, replay: true, reason: 'already_transmitted' });
    expect(second.transmission.transmissionId).toBe(first.transmission.transmissionId);

    expect(fs.readdirSync(path.join(dir, 'wire', 'outbound'))).toEqual(['PTCWIRE_20260201T120000_IHB-1.xml']);
  });

  it('refuses to transmit when the same payment has already been prepared with different content', async () => {
    await WireHostToHostEngine.transmit('IHB-1', { actor: 'operator-a' });
    (InHouseBankEngine.pacs008 as any).mockResolvedValue(PACS008.replace('IHB-1', 'IHB-1-TAMPERED'));

    await expect(WireHostToHostEngine.transmit('IHB-1', { actor: 'operator-a' })).rejects.toThrow(
      /different content/
    );
  });

  it('will not reclaim a reservation without proof the file is absent from the bank host', async () => {
    const reserved = await WireIdempotencyVault.reserve({
      paymentId: 'IHB-9',
      filename: 'PTCWIRE_IHB-9.xml',
      payload: PACS008,
      owner: 'operator-a',
    });
    await expect(
      WireIdempotencyVault.reclaim(reserved.transmission.transmissionId, { owner: 'operator-b', absentFromHost: false })
    ).rejects.toThrow(/not been proven absent/);
  });

  it('refuses a payment that is not dispatched and one that never leaves the bank', async () => {
    (InHouseBankEngine.require as any).mockResolvedValue(dispatchedPayment({ status: 'approved' }));
    await expect(WireHostToHostEngine.prepare('IHB-1')).rejects.toThrow(/only a dispatched payment/);

    (InHouseBankEngine.require as any).mockResolvedValue(dispatchedPayment({ internal: true }));
    await expect(WireHostToHostEngine.prepare('IHB-1')).rejects.toThrow(/never leaves the bank/);
  });

  it('settles from a bank advice once and ignores the same advice replayed', async () => {
    await WireHostToHostEngine.transmit('IHB-1', { actor: 'operator-a' });
    const [advice] = parseAdvice(
      '<Document><FIToFIPmtStsRpt><TxInfAndSts><OrgnlEndToEndId>E2E-1</OrgnlEndToEndId><TxSts>ACSC</TxSts><AcctSvcrRef>FED-1</AcctSvcrRef></TxInfAndSts></FIToFIPmtStsRpt></Document>',
      'ack.xml'
    );

    const applied = await WireHostToHostEngine.applyAdvice(advice);
    expect(applied).toMatchObject({ matched: true, duplicate: false, paymentOutcome: 'settled' });
    expect(applied.transmission.state).toBe('settled');
    expect(applied.transmission.bankReference).toBe('FED-1');
    expect(InHouseBankEngine.confirm).toHaveBeenCalledTimes(1);

    const replay = await WireHostToHostEngine.applyAdvice(advice);
    expect(replay.duplicate).toBe(true);
    expect(InHouseBankEngine.confirm).toHaveBeenCalledTimes(1);
  });

  it('reverses a return through the in-house bank exactly once', async () => {
    await WireHostToHostEngine.transmit('IHB-1', { actor: 'operator-a' });
    const [advice] = parseAdvice(
      '<Document><PmtRtr><TxInf><RtrId>RTN-1</RtrId><OrgnlEndToEndId>E2E-1</OrgnlEndToEndId><RtrRsnInf><Rsn><Cd>AC04</Cd></Rsn><AddtlInf>Account closed</AddtlInf></RtrRsnInf></TxInf></PmtRtr></Document>',
      'rtn.xml'
    );

    const applied = await WireHostToHostEngine.applyAdvice(advice);
    expect(applied.paymentOutcome).toBe('returned');
    expect(applied.transmission).toMatchObject({ state: 'returned', returnReference: 'RTN-1', returnReason: 'Account closed' });
    expect(InHouseBankEngine.confirm).toHaveBeenCalledWith('IHB-1', expect.objectContaining({ outcome: 'returned', reference: 'RTN-1' }));
    expect((InHouseBankEngine.confirm as any).mock.calls).toHaveLength(1);
  });

  it('escalates a return that arrives after settlement instead of re-crediting the payment', async () => {
    await WireHostToHostEngine.transmit('IHB-1', { actor: 'operator-a' });
    (InHouseBankEngine.get as any).mockResolvedValue(dispatchedPayment({ status: 'settled' }));
    const [advice] = parseAdvice(
      '<Document><PmtRtr><TxInf><RtrId>RTN-2</RtrId><OrgnlEndToEndId>E2E-1</OrgnlEndToEndId></TxInf></PmtRtr></Document>',
      'rtn-late.xml'
    );

    const applied = await WireHostToHostEngine.applyAdvice(advice);
    expect(applied.escalated).toBe(true);
    expect(InHouseBankEngine.confirm).not.toHaveBeenCalled();
    expect(state.exceptions.map((e) => e.kind)).toContain('return_after_settlement');
  });

  it('records an unmatched bank advice as an exception rather than guessing a payment', async () => {
    const [advice] = parseAdvice(JSON.stringify({ endToEndId: 'E2E-UNKNOWN', status: 'ACSC', reference: 'FED-X' }), 'stray.json');
    const applied = await WireHostToHostEngine.applyAdvice(advice);

    expect(applied.matched).toBe(false);
    expect(InHouseBankEngine.confirm).not.toHaveBeenCalled();
    expect(state.exceptions[0]).toMatchObject({ kind: 'unmatched_advice' });
  });

  it('flags a payment dispatched on the wire rail with no file prepared', async () => {
    state.payments.push({ payment_id: 'IHB-77', rail: 'fedwire', dispatched_at: new Date() });
    const result = await WireHostToHostEngine.reconcile({ actor: 'reconciliation' });

    expect(result.raised).toBe(1);
    expect(result.open[0]).toMatchObject({ kind: 'dispatched_without_file', paymentId: 'IHB-77' });
  });
});

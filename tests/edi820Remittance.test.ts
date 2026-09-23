import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.DAPP_MEMORY_MODE = 'true';

const { renderEdi820, parseEdi820, Edi820Error } = require('../server/integrations/edi/edi820Generator');
const { Edi820RemittanceEngine } = require('../server/integrations/edi/edi820RemittanceEngine');
const { ErpPayoutWorkflowEngine } = require('../server/integrations/finops/erpPayoutWorkflowEngine');
const { CanonicalFundingSource } = require('../server/integrations/fineract/canonicalFundingSource');
const { AS2Client } = require('../server/integrations/ach/as2Client');
const { AS2Partners } = require('../server/integrations/ach/as2Partners');
const { WireOriginationEngine } = require('../server/integrations/dapp/wireOriginationEngine');

const saved = { ...process.env };

const PARTNER = {
  partnerId: 'BANK-820',
  partnerName: 'Bank AS2',
  partnerUrl: 'https://bank.example/as2',
  partnerAs2Id: 'BANK-AS2-ID',
  localAs2Id: 'DLBTRUST-AS2',
  requestMdn: false,
  useMtls: false,
};

function run(erpReference = 'ERP-INV-1001') {
  return {
    erpReference,
    payments: [{
      reference: 'CTW-1',
      amountCents: 125050,
      method: 'ach',
      payee: { name: 'Acme Supplies', routingNumber: '091017138', accountNumber: '123456789', accountType: 'checking', id: 'VEND-42' },
      remittance: [
        { invoiceNumber: 'INV-1', amountCents: 100000 },
        { invoiceNumber: 'INV-2', amountCents: 25050, purchaseOrder: 'PO-7' },
      ],
    }],
  };
}

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    workflow_id: 'CTW-ERP-1',
    type: 'payment',
    reference_type: 'erp_payout',
    reference_id: 'ERP-INV-1001',
    amount_cents: 125050,
    currency: 'USD',
    required_approvals: 1,
    approvals: [{ approver: 'checker@dlbtrust', at: '2026-09-20T10:00:00Z' }],
    status: 'approved',
    metadata: {
      createdBy: 'maker@dlbtrust',
      payout: {
        erpReference: 'ERP-INV-1001',
        method: 'ach',
        payee: { name: 'Acme Supplies', routingNumber: '091017138', accountNumber: '123456789', accountType: 'checking' },
        remittance: [{ invoiceNumber: 'INV-1', amountCents: 125050 }],
        purpose: 'vendor_payment',
      },
    },
    ...overrides,
  };
}

let transmit: ReturnType<typeof vi.spyOn>;
let commit: ReturnType<typeof vi.spyOn>;
let assertAvailable: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.DAPP_MEMORY_MODE = 'true';
  process.env.EDI_820_SENDER_ID = 'DLBTRUST-AS2';
  process.env.EDI_820_RECEIVER_ID = 'BANK-AS2-ID';
  process.env.EDI_820_PAYER_NAME = 'DB NET MGMT';
  process.env.EDI_820_ORIGINATOR_ID = '1091017138';
  process.env.EDI_820_ODFI_ROUTING = '091017138';
  process.env.EDI_820_ODFI_ACCOUNT = '999000111';
  delete process.env.EDI_820_LIVE;
  delete process.env.CANONICAL_FUNDING_LIVE;
  delete process.env.EDI_820_AS2_PARTNER_ID;

  Edi820RemittanceEngine._resetMemory();
  vi.spyOn(AS2Partners, 'getDefaultPartnerConfig').mockResolvedValue(PARTNER);
  vi.spyOn(AS2Partners, 'getPartnerConfig').mockResolvedValue(PARTNER);
  transmit = vi.spyOn(AS2Client, 'transmit').mockResolvedValue({ success: true, status_code: 200, message_id: '<msg-1@dlbtrust>', transmitted_at: '2026-09-20T10:00:05Z' });
  assertAvailable = vi.spyOn(CanonicalFundingSource, 'assertAvailable').mockResolvedValue({ ok: true, availableUsd: 50_000 });
  commit = vi.spyOn(CanonicalFundingSource, 'commit').mockImplementation(async ({ amountUsd, reference }) => {
    const live = process.env.CANONICAL_FUNDING_LIVE === 'true';
    return live
      ? { shadow: false, committed: true, amountUsd, reference, entryId: 'JRN-1' }
      : { shadow: true, committed: false, amountUsd, reference, reason: 'CANONICAL_FUNDING_LIVE=false' };
  });
  vi.spyOn(WireOriginationEngine, 'createPayout').mockResolvedValue({ id: 'WPO-1', status: 'pending_approval' });
  vi.spyOn(WireOriginationEngine, 'approvePayout').mockResolvedValue({ id: 'WPO-1', status: 'approved' });
  vi.spyOn(WireOriginationEngine, 'sendPayout').mockResolvedValue({ id: 'WPO-1', status: 'sent', railId: 'ACH-1' });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('edi820Generator', () => {
  const profile = {
    senderId: 'DLBTRUST-AS2', receiverId: 'BANK-AS2-ID', senderName: 'DB NET MGMT', originatorId: '1091017138',
    payer: { name: 'DB NET MGMT', id: '1091017138', routingNumber: '091017138', accountNumber: '999000111' }, usageIndicator: 'T',
  };

  it('renders a complete ISA/GS/ST … SE/GE/IEA interchange with BPR, N1 loops and ENT/RMR detail', () => {
    const doc = renderEdi820({ run: run(), profile, createdAt: new Date('2026-09-20T10:00:00Z') });
    const lines = doc.payload.trim().split('\n');
    expect(lines[0]).toMatch(/^ISA\*00\*\s{10}\*00\*\s{10}\*ZZ\*DLBTRUST-AS2\s+\*ZZ\*BANK-AS2-ID\s+\*260920\*1000\*\^\*00501\*\d{9}\*0\*T\*>~$/);
    expect(lines[1]).toMatch(/^GS\*RA\*DLBTRUST-AS2\*BANK-AS2-ID\*20260920\*1000\*\d+\*X\*005010~$/);
    expect(lines[2]).toBe('ST*820*0001~');
    expect(lines[3]).toBe('BPR*C*1250.50*C*ACH*CCP*01*091017138*DA*999000111*1091017138**01*091017138*DA*123456789*20260920~');
    expect(lines).toContain('REF*TN*ERP-INV-1001~');
    expect(lines).toContain('N1*PR*DB NET MGMT*91*1091017138~');
    expect(lines).toContain('N1*PE*Acme Supplies*91*VEND-42~');
    expect(lines).toContain('ENT*1~');
    expect(lines).toContain('RMR*IV*INV-1*PO*1000.00*1000.00~');
    expect(lines).toContain('RMR*IV*INV-2*PO*250.50*250.50~');
    expect(lines).toContain('REF*PO*PO-7~');
    expect(lines.at(-3)).toMatch(/^SE\*\d+\*0001~$/);
    expect(lines.at(-2)).toBe(`GE*1*${doc.groupControlNumber}~`);
    expect(lines.at(-1)).toBe(`IEA*1*${doc.interchangeControlNumber}~`);
    // SE01 counts ST..SE inclusive
    const seCount = Number(lines.at(-3)!.split('*')[1]);
    expect(seCount).toBe(lines.length - 4);
    expect(doc.controls).toMatchObject({ count: 1, transactionSets: 1, totalAmountCents: 125050 });
    expect(doc.payloadHash).toMatch(/^[0-9a-f]{64}$/);

    const parsed = parseEdi820(doc.payload);
    expect(parsed.senderId).toBe('DLBTRUST-AS2');
    expect(parsed.totalAmountCents).toBe(125050);
    expect(parsed.payments).toHaveLength(1);
    expect(parsed.remittanceLines).toBe(2);
  });

  it('derives control numbers from the ERP reference so re-rendering is deterministic', () => {
    const a = renderEdi820({ run: run(), profile, createdAt: new Date('2026-09-20T10:00:00Z') });
    const b = renderEdi820({ run: run(), profile, createdAt: new Date('2026-09-21T15:30:00Z') });
    const c = renderEdi820({ run: run('ERP-INV-1002'), profile, createdAt: new Date('2026-09-20T10:00:00Z') });
    expect(a.interchangeControlNumber).toBe(b.interchangeControlNumber);
    expect(a.groupControlNumber).toBe(b.groupControlNumber);
    expect(c.interchangeControlNumber).not.toBe(a.interchangeControlNumber);
  });

  it('refuses a run whose remittance total does not match the payment', () => {
    const bad = run();
    bad.payments[0].remittance[0].amountCents = 1;
    expect(() => renderEdi820({ run: bad, profile })).toThrow(Edi820Error);
    try { renderEdi820({ run: bad, profile }); } catch (err: any) {
      expect(err.code).toBe('EDI_820_INVALID');
      expect(err.status).toBe(422);
      expect(err.failures.some((f: any) => f.field === 'remittance')).toBe(true);
    }
  });

  it('refuses a run without sender/receiver EDI ids or with an invalid routing number', () => {
    expect(() => renderEdi820({ run: run(), profile: { ...profile, receiverId: '' } })).toThrow(/receiver/i);
    const bad = run();
    bad.payments[0].payee.routingNumber = '123456789';
    expect(() => renderEdi820({ run: bad, profile })).toThrow(/routing/i);
  });
});

describe('Edi820RemittanceEngine gating', () => {
  it('shadow by default: renders and stores the document, sends nothing', async () => {
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: false });
    expect(result.shadow).toBe(true);
    expect(result.transmitted).toBe(false);
    expect(result.status).toBe('shadow');
    expect(result.payload).toContain('ST*820*0001~');
    expect(result.reason).toContain('CANONICAL_FUNDING_LIVE=false');
    expect(result.reason).toContain('EDI_820_LIVE=false');
    expect(transmit).not.toHaveBeenCalled();
    expect(await Edi820RemittanceEngine.get('ERP-INV-1001')).toMatchObject({ status: 'shadow', erpReference: 'ERP-INV-1001' });
  });

  it('EDI_820_LIVE alone is not enough — CANONICAL_FUNDING_LIVE must also be true', async () => {
    process.env.EDI_820_LIVE = 'true';
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    expect(result.shadow).toBe(true);
    expect(result.reason).toBe('CANONICAL_FUNDING_LIVE=false');
    expect(transmit).not.toHaveBeenCalled();
  });

  it('CANONICAL_FUNDING_LIVE alone is not enough — EDI_820_LIVE must also be true', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    expect(result.shadow).toBe(true);
    expect(result.reason).toBe('EDI_820_LIVE=false');
    expect(transmit).not.toHaveBeenCalled();
  });

  it('both flags on but the ERP draw was a shadow plan → still no transmission', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: false });
    expect(result.shadow).toBe(true);
    expect(result.reason).toMatch(/shadow plan/);
    expect(transmit).not.toHaveBeenCalled();
  });

  it('transmits over AS2 only when both flags are true and the draw committed', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true, workflowId: 'CTW-ERP-1' });
    expect(result.transmitted).toBe(true);
    expect(result.shadow).toBe(false);
    expect(result.status).toBe('transmitted');
    expect(result.as2MessageId).toBe('<msg-1@dlbtrust>');
    expect(result.partnerId).toBe('BANK-820');
    expect(transmit).toHaveBeenCalledTimes(1);
    const [payload, filename, partner] = transmit.mock.calls[0];
    expect(payload).toBe(result.payload);
    expect(filename).toMatch(/^EDI820-ERP-INV-1001-\d{9}\.edi$/);
    expect(partner).toBe(PARTNER);
    // production usage indicator once the rail is live
    expect(payload.split('\n')[0]).toMatch(/\*P\*>~$/);
  });

  it('honours EDI_820_AS2_PARTNER_ID when selecting the AS2 partner', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    process.env.EDI_820_AS2_PARTNER_ID = 'BANK-820';
    await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    expect(AS2Partners.getPartnerConfig).toHaveBeenCalledWith('BANK-820');
    expect(AS2Partners.getDefaultPartnerConfig).not.toHaveBeenCalled();
  });

  it('fails closed when no AS2 partner is registered', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    (AS2Partners.getDefaultPartnerConfig as any).mockResolvedValue(null);
    await expect(Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true })).rejects.toMatchObject({ code: 'EDI_820_NO_AS2_PARTNER' });
    expect(transmit).not.toHaveBeenCalled();
  });

  it('records a failed transmission and surfaces the error', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    transmit.mockResolvedValue({ success: false, status_code: 500, response_body: 'boom' });
    await expect(Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true })).rejects.toMatchObject({ code: 'EDI_820_TRANSMIT_FAILED' });
    expect(await Edi820RemittanceEngine.get('ERP-INV-1001')).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('500') });
  });
});

describe('Edi820RemittanceEngine idempotency', () => {
  it('the same ERP reference is never transmitted twice', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    const first = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    const second = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    const third = await Edi820RemittanceEngine.transmit('ERP-INV-1001', { fundingCommitted: true });
    expect(first.transmitted).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ transmitted: true, duplicate: true, documentId: first.documentId, payloadHash: first.payloadHash });
    expect(third).toMatchObject({ transmitted: true, duplicate: true });
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it('a shadow document re-emitted once the gates open goes out exactly once, with the original control numbers', async () => {
    const shadow = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: false });
    expect(transmit).not.toHaveBeenCalled();

    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    const live = await Edi820RemittanceEngine.transmit('ERP-INV-1001', { fundingCommitted: true });
    expect(live.transmitted).toBe(true);
    expect(live.interchangeControlNumber).toBe(shadow.interchangeControlNumber);
    expect(live.documentId).toBe(shadow.documentId);
    expect(transmit).toHaveBeenCalledTimes(1);

    await Edi820RemittanceEngine.transmit('ERP-INV-1001', { fundingCommitted: true });
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it('transmit() of an unknown reference is a 404, not a send', async () => {
    await expect(Edi820RemittanceEngine.transmit('ERP-NOPE')).rejects.toMatchObject({ code: 'EDI_820_NOT_FOUND', status: 404 });
    expect(transmit).not.toHaveBeenCalled();
  });
});

describe('Edi820RemittanceEngine over MFT Gateway', () => {
  const { MftGatewayClient } = require('../server/integrations/edi/mftGatewayClient');
  let fetchMock: ReturnType<typeof vi.fn>;

  function jsonResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  beforeEach(() => {
    process.env.EDI_820_TRANSPORT = 'mftgateway';
    process.env.MFTGATEWAY_API_TOKEN_ID = 'token-id';
    process.env.MFTGATEWAY_API_TOKEN_SECRET = 'token-secret';
    process.env.MFTGATEWAY_STATION_AS2_ID = 'DLBTRUST-AS2';
    process.env.MFTGATEWAY_PARTNER_AS2_ID = 'BANK-MFT';
    MftGatewayClient._resetSession();
    fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/authorize')) return jsonResponse(200, { apiToken: 'jwt-1', apiTokenExpiryIn: 3600, refreshToken: 'r' });
      if (String(url).includes('/message/submit')) {
        expect((init.headers as Record<string, string>).Authorization).toBe('jwt-1');
        return jsonResponse(202, { message: 'Message queued successfully', messageIdentifier: '<mft-1@mftgateway.com>' }, { link: 'https://api.mftgateway.com/message/outbox/x' });
      }
      if (String(url).endsWith('/station')) return jsonResponse(200, { stations: [{ identifier: 'DLBTRUST-AS2', name: 'DLB Trust Treasury' }] });
      return jsonResponse(404, { message: 'nope' });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('shadow by default: nothing is posted to MFT Gateway', async () => {
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: false });
    expect(result.transmitted).toBe(false);
    expect(result.shadow).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
  });

  it('both gates open: authorizes with the token pair and submits AS2-From station → AS2-To partner', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    expect(result).toMatchObject({ transmitted: true, shadow: false, status: 'transmitted', as2MessageId: '<mft-1@mftgateway.com>', partnerId: 'BANK-MFT' });
    expect(result.transmission.transport).toBe('mftgateway');
    expect(transmit).not.toHaveBeenCalled();

    const [authUrl, authInit] = fetchMock.mock.calls[0];
    expect(authUrl).toBe('https://api.mftgateway.com/authorize');
    expect(JSON.parse(authInit.body)).toEqual({ tokenID: 'token-id', tokenSecret: 'token-secret' });
    const [submitUrl, submitInit] = fetchMock.mock.calls[1];
    expect(submitUrl).toBe('https://api.mftgateway.com/message/submit?service=as2');
    expect(submitInit.headers).toMatchObject({ 'AS2-From': 'DLBTRUST-AS2', 'AS2-To': 'BANK-MFT', 'Content-Type': 'application/edi-x12' });
    expect(submitInit.headers['Attachment-Name']).toMatch(/^EDI820-ERP-INV-1001-\d{9}\.edi$/);
    expect(submitInit.body.toString('utf8')).toBe(result.payload);

    await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gates stay closed without an API token even when both live flags are on', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    delete process.env.MFTGATEWAY_API_TOKEN_SECRET;
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    expect(result.transmitted).toBe(false);
    expect(result.reason).toContain('MFT Gateway API token not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a rejected submission is recorded as failed and re-thrown', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    fetchMock.mockImplementation(async (url: string) => (
      String(url).endsWith('/authorize')
        ? jsonResponse(200, { apiToken: 'jwt-1', apiTokenExpiryIn: 3600 })
        : jsonResponse(422, { message: 'Unable to find partner with AS2 identifier: BANK-MFT' })
    ));
    await expect(Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true })).rejects.toMatchObject({ code: 'EDI_820_TRANSMIT_FAILED' });
    const stored = await Edi820RemittanceEngine.get('ERP-INV-1001');
    expect(stored.status).toBe('failed');
    expect(stored.errorMessage).toContain('Unable to find partner');
  });

  it('an unknown EDI_820_TRANSPORT fails closed instead of falling back to AS2', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    process.env.EDI_820_TRANSPORT = 'mftgatway';
    const result = await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    expect(result.transmitted).toBe(false);
    expect(result.reason).toContain('EDI_820_TRANSPORT=mftgatway is not a supported transport');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
    const readiness = await Edi820RemittanceEngine.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.mode).toBe('shadow');
  });

  it('refuses a non-HTTPS or credentialed MFTGATEWAY_API_URL', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    for (const bad of ['http://api.mftgateway.com', 'https://user:pw@api.mftgateway.com', 'not a url']) {
      process.env.MFTGATEWAY_API_URL = bad;
      const result = await Edi820RemittanceEngine.emit({ run: run(`ERP-${bad.length}`), fundingCommitted: true });
      expect(result.transmitted).toBe(false);
      expect(result.reason).toContain('MFTGATEWAY_API_URL must be an https:// URL');
      const readiness = await Edi820RemittanceEngine.readiness();
      expect(readiness.issues.join(' ')).toContain('MFTGATEWAY_API_URL must be an https:// URL');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('every gateway request carries an abort timeout', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    process.env.MFTGATEWAY_TIMEOUT_MS = '5000';
    await Edi820RemittanceEngine.emit({ run: run(), fundingCommitted: true });
    await Edi820RemittanceEngine.readiness();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [, init] of fetchMock.mock.calls) expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(MftGatewayClient.getConfig().timeoutMs).toBe(5000);
  });

  it('readiness reports the station and the missing partner id', async () => {
    delete process.env.MFTGATEWAY_PARTNER_AS2_ID;
    delete process.env.EDI_820_RECEIVER_ID;
    const readiness = await Edi820RemittanceEngine.readiness();
    expect(readiness.transport).toBe('mftgateway');
    expect(readiness.station).toEqual({ identifier: 'DLBTRUST-AS2', name: 'DLB Trust Treasury' });
    expect(readiness.ready).toBe(false);
    expect(readiness.issues).toContain('MFTGATEWAY_PARTNER_AS2_ID not configured');
    expect(readiness.mode).toBe('shadow');
  });
});

describe('ErpPayoutWorkflowEngine', () => {
  it('enforces maker/checker: unapproved, self-approved or maker-less workflows are refused before any funding call', async () => {
    await expect(ErpPayoutWorkflowEngine.execute(workflow({ status: 'pending' }))).rejects.toMatchObject({ code: 'ERP_PAYOUT_NOT_APPROVED' });
    await expect(ErpPayoutWorkflowEngine.execute(workflow({ approvals: [{ approver: 'maker@dlbtrust' }] }))).rejects.toMatchObject({ code: 'ERP_PAYOUT_DUAL_CONTROL' });
    await expect(ErpPayoutWorkflowEngine.execute(workflow({ metadata: { payout: workflow().metadata.payout } }))).rejects.toMatchObject({ code: 'ERP_PAYOUT_DUAL_CONTROL' });
    await expect(ErpPayoutWorkflowEngine.execute(workflow({ reference_type: 'settlement' }))).rejects.toMatchObject({ code: 'ERP_PAYOUT_WRONG_TYPE' });
    expect(assertAvailable).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(WireOriginationEngine.createPayout).not.toHaveBeenCalled();
    expect(transmit).not.toHaveBeenCalled();
  });

  it('shadow end-to-end: assertAvailable + commit are called, no external leg, 820 rendered but not sent', async () => {
    const result = await ErpPayoutWorkflowEngine.execute(workflow(), { executedBy: 'checker@dlbtrust' });
    expect(assertAvailable).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 1250.5, accountCode: '1000' }));
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 1250.5, reference: 'ERP-INV-1001', referenceType: 'erp_payout' }));
    expect(result.shadow).toBe(true);
    expect(result.funding.committed).toBe(false);
    expect(result.externalLeg).toMatchObject({ shadow: true, originated: false, rail: 'ach' });
    expect(WireOriginationEngine.createPayout).not.toHaveBeenCalled();
    expect(result.edi820).toMatchObject({ status: 'shadow', transmitted: false, shadow: true });
    expect(result.edi820.interchangeControlNumber).toMatch(/^\d{9}$/);
    expect(transmit).not.toHaveBeenCalled();
    const stored = await Edi820RemittanceEngine.getByWorkflow('CTW-ERP-1');
    expect(stored.payload).toContain('REF*TN*ERP-INV-1001~');
  });

  it('live end-to-end: ERP draw committed → external leg via WireOriginationEngine → 820 over AS2', async () => {
    process.env.CANONICAL_FUNDING_LIVE = 'true';
    process.env.EDI_820_LIVE = 'true';
    const result = await ErpPayoutWorkflowEngine.execute(workflow(), { executedBy: 'checker@dlbtrust' });
    expect(result.shadow).toBe(false);
    expect(result.funding.committed).toBe(true);
    expect(WireOriginationEngine.createPayout).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'cash', sourceAccountId: 'CA-OPERATING', amountCents: 125050, method: 'ach', reference: 'ERP-INV-1001', createdBy: 'maker@dlbtrust',
    }));
    expect(WireOriginationEngine.approvePayout).toHaveBeenCalledWith('WPO-1', 'checker@dlbtrust');
    expect(WireOriginationEngine.sendPayout).toHaveBeenCalledWith('WPO-1');
    expect(result.externalLeg).toMatchObject({ originated: true, payoutId: 'WPO-1', status: 'sent' });
    expect(result.edi820).toMatchObject({ status: 'transmitted', transmitted: true, shadow: false, duplicate: false });
    expect(transmit).toHaveBeenCalledTimes(1);

    // Re-executing the same ERP reference must not re-emit.
    const again = await Edi820RemittanceEngine.emit({ run: ErpPayoutWorkflowEngine.runFromWorkflow(workflow()), fundingCommitted: true });
    expect(again.duplicate).toBe(true);
    expect(transmit).toHaveBeenCalledTimes(1);
  });

  it('with CANONICAL_FUNDING_LIVE=false, EDI_820_LIVE=true still moves nothing', async () => {
    process.env.EDI_820_LIVE = 'true';
    const result = await ErpPayoutWorkflowEngine.execute(workflow(), { executedBy: 'checker@dlbtrust' });
    expect(result.shadow).toBe(true);
    expect(WireOriginationEngine.createPayout).not.toHaveBeenCalled();
    expect(result.edi820.transmitted).toBe(false);
    expect(transmit).not.toHaveBeenCalled();
  });
});

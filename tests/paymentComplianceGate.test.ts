import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { ComplianceEngine } = require('../server/integrations/compliance/complianceEngine');
const { CustomerIdentificationEngine } = require('../server/integrations/compliance/customerIdentificationEngine');
const { OfacSanctionsListEngine, parseCsvLine, parseEntries } = require('../server/integrations/compliance/ofacSanctionsListEngine');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const { MelioEngine } = require('../server/integrations/os/osEngine');
const pool = require('../server/integrations/bonds/pgPool');

const originalEnvironment = {
  COMPLIANCE_CIP_REQUIRED_RAILS: process.env.COMPLIANCE_CIP_REQUIRED_RAILS,
  COMPLIANCE_PROVIDER: process.env.COMPLIANCE_PROVIDER,
  COMPLIANCE_SANCTIONED_NAMES: process.env.COMPLIANCE_SANCTIONED_NAMES,
  COMPLIANCE_ALLOW_LOCAL_SCREENING: process.env.COMPLIANCE_ALLOW_LOCAL_SCREENING,
  NODE_ENV: process.env.NODE_ENV,
};

afterEach(() => {
  vi.restoreAllMocks();
  OfacSanctionsListEngine._cache = null;
  OfacSanctionsListEngine._cacheVersion = null;
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearScreening() {
  return {
    screening_id: 'COMP-CLEAR-1',
    status: 'clear',
    provider: 'ofac',
    risk_level: 'low',
    risk_score: 0,
    created_at: '2026-08-22T00:00:00.000Z',
  };
}

describe('payment compliance gate', () => {
  it.each(['pending', 'review', 'blocked', 'unknown'])('blocks %s screening status', (status) => {
    expect(() => ComplianceEngine.mustPass({
      screening_id: `COMP-${status}`,
      status,
      risk_level: 'medium',
    })).toThrow();
  });

  it('blocks a missing screening', () => {
    expect(() => ComplianceEngine.mustPass(null))
      .toThrow('Compliance screening required before payout');
  });

  it('permits a clear screening and clear CIP for a required rail', async () => {
    vi.spyOn(PaymentComplianceGate, 'assertReady').mockResolvedValue({ ready: true });
    vi.spyOn(ComplianceEngine, 'screenRecipientForPayout').mockResolvedValue(clearScreening());
    vi.spyOn(CustomerIdentificationEngine, 'validatePayoutRecipient').mockResolvedValue({
      valid: true,
      required: true,
      recordId: 'CIP-CLEAR-1',
      status: 'clear',
    });

    const result = await PaymentComplianceGate.screenVendorPayment({
      vendor: {
        name: 'Clear Vendor',
        email: 'clear@example.com',
        account_number: '1234',
        routing_number: '021000021',
      },
      amount: 125,
      sourceAccountId: '1000',
      rail: 'ach',
      screenedBy: 'operator@example.com',
    });

    expect(result).toMatchObject({
      screeningId: 'COMP-CLEAR-1',
      status: 'clear',
      provider: 'ofac',
      cip: {
        valid: true,
        required: true,
        recordId: 'CIP-CLEAR-1',
      },
    });
  });

  it.each([
    ['missing', { valid: false, required: true, reason: 'No CIP record found for recipient' }],
    ['review', { valid: false, required: true, recordId: 'CIP-REVIEW', status: 'review', reason: 'CIP review required' }],
    ['blocked', { valid: false, required: true, recordId: 'CIP-BLOCKED', status: 'blocked', reason: 'CIP blocked' }],
  ])('blocks %s CIP for a required rail', async (_label, cip) => {
    vi.spyOn(PaymentComplianceGate, 'assertReady').mockResolvedValue({ ready: true });
    vi.spyOn(ComplianceEngine, 'screenRecipientForPayout').mockResolvedValue(clearScreening());
    vi.spyOn(CustomerIdentificationEngine, 'validatePayoutRecipient').mockResolvedValue(cip);

    await expect(PaymentComplianceGate.screenVendorPayment({
      vendor: { name: 'CIP Vendor' },
      amount: 25,
      sourceAccountId: '1000',
      rail: 'wire',
    })).rejects.toThrow('CIP clearance required before payment');
  });

  it('requires identity provider evidence on clear CIP records', async () => {
    await expect(CustomerIdentificationEngine.mustBeClear({
      kyc_status: 'clear',
      risk_level: 'low',
      risk_score: 0,
      id_verification_provider: null,
      id_verification_reference: null,
    })).rejects.toThrow('CIP identity verification provider and reference are required');
  });

  it('fails closed when the compliance provider is unavailable', async () => {
    vi.spyOn(ComplianceEngine, 'readiness').mockResolvedValue({
      ready: false,
      provider: 'ofac',
      issues: ['OFAC sanctions list is stale'],
    });

    await expect(PaymentComplianceGate.assertReady({
      rail: 'ach',
      action: 'execute',
    })).rejects.toMatchObject({
      code: 'COMPLIANCE_GATE_BLOCKED',
      status: 503,
    });
  });

  it('never treats local sanctions rules as production payment readiness', async () => {
    process.env.NODE_ENV = 'production';
    process.env.COMPLIANCE_PROVIDER = 'local';
    process.env.COMPLIANCE_ALLOW_LOCAL_SCREENING = 'true';
    process.env.COMPLIANCE_SANCTIONED_NAMES = 'Sanctioned Example';

    const readiness = await ComplianceEngine.readiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.issues).toContain(
      'Local sanctions screening cannot authorize production payments',
    );
  });

  it('rejects a recorded screening from a different provider', async () => {
    vi.spyOn(ComplianceEngine, 'assertPaymentReady').mockResolvedValue({
      ready: true,
      provider: 'ofac',
    });
    vi.spyOn(ComplianceEngine, 'getScreening').mockResolvedValue({
      ...clearScreening(),
      provider: 'local',
    });

    await expect(PaymentComplianceGate.verifyRecordedScreening('COMP-LOCAL-1'))
      .rejects.toThrow('Compliance screening provider does not match the active payment provider');
  });

  it('distinguishes Melio manual export from unavailable live execution', async () => {
    vi.spyOn(ComplianceEngine, 'readiness').mockResolvedValue({
      ready: true,
      provider: 'ofac',
      issues: [],
    });
    vi.spyOn(MelioEngine, 'status').mockResolvedValue({
      enabled: true,
      mode: 'shadow',
      apiStatus: { reachable: false },
      issues: [],
    });

    const manual = await PaymentComplianceGate.paymentReadiness({
      rail: 'melio',
      action: 'export',
    });
    const live = await PaymentComplianceGate.paymentReadiness({
      rail: 'melio',
      action: 'execute',
    });

    expect(manual).toMatchObject({
      ready: true,
      paymentProvider: {
        mode: 'manual_export',
        liveExecution: false,
      },
    });
    expect(live.ready).toBe(false);
    expect(live.paymentProvider.issues).toEqual(expect.arrayContaining([
      'Melio live execution is not enabled',
      'Melio API is not reachable',
    ]));
  });
});

describe('OFAC sanctions readiness', () => {
  it('parses official primary and alias CSV formats', () => {
    expect(parseCsvLine('123,\"ACME, LLC\",Entity')).toEqual(['123', 'ACME, LLC', 'Entity']);
    expect(parseEntries('123,\"ACME, LLC\",Entity', {
      key: 'sdn-primary',
      fileName: 'SDN.CSV',
      nameIndex: 1,
      idIndexes: [0],
      primary: true,
    })).toEqual([expect.objectContaining({
      entryUid: '123',
      name: 'ACME, LLC',
      normalizedName: 'acme llc',
      isAlias: false,
    })]);
    expect(parseEntries('123,0,a.k.a.,\"ACME TRADING\"', {
      key: 'sdn-alias',
      fileName: 'ALT.CSV',
      nameIndex: 3,
      idIndexes: [0, 1],
      primary: false,
    })).toEqual([expect.objectContaining({
      entryUid: '123:0',
      name: 'ACME TRADING',
      isAlias: true,
      aliasType: 'a.k.a.',
    })]);
  });

  it('fails readiness when a required file is missing, empty, or stale', async () => {
    vi.spyOn(OfacSanctionsListEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [
        {
          list_key: 'sdn-primary',
          source_file: 'SDN.CSV',
          refreshed_at: new Date(Date.now() - 72 * 3600000),
          entry_count: 1000,
        },
        {
          list_key: 'sdn-alias',
          source_file: 'ALT.CSV',
          refreshed_at: new Date(),
          entry_count: 0,
        },
      ],
    });

    const result = await OfacSanctionsListEngine.readiness();

    expect(result.ready).toBe(false);
    expect(result.issues.join('; ')).toContain('Missing OFAC files');
    expect(result.issues.join('; ')).toContain('Empty OFAC files: ALT.CSV');
    expect(result.issues.join('; ')).toContain('older than 48 hours');
  });

  it('refreshes OFAC data when readiness is not clear', async () => {
    vi.spyOn(OfacSanctionsListEngine, 'readiness').mockResolvedValue({
      ready: false,
      issues: ['stale'],
    });
    const refresh = vi.spyOn(OfacSanctionsListEngine, 'refresh').mockResolvedValue({
      ready: true,
      entryCount: 5000,
    });

    await expect(OfacSanctionsListEngine.refreshIfStale())
      .resolves.toMatchObject({ ready: true, entryCount: 5000 });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reloads cached sanctions entries after an external refresh', async () => {
    vi.spyOn(OfacSanctionsListEngine, 'ensureTables').mockResolvedValue(undefined);
    let refreshedAt = new Date('2026-08-22T00:00:00.000Z');
    let entries = [{
      list_key: 'sdn-primary',
      entry_uid: 'old',
      name: 'OLD ENTRY',
      normalized_name: 'old entry',
      source_file: 'SDN.CSV',
      is_alias: false,
      alias_type: null,
    }];
    vi.spyOn(pool, 'query').mockImplementation(async (sql) => {
      if (String(sql).includes('COUNT(*)::integer AS list_count')) {
        return {
          rows: [{
            list_count: 4,
            entry_count: 1,
            oldest_refresh: refreshedAt,
            newest_refresh: refreshedAt,
          }],
        };
      }
      if (String(sql).includes('FROM compliance_sanctions_entries')) {
        return { rows: entries };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(OfacSanctionsListEngine._loadCache())
      .resolves.toEqual([expect.objectContaining({ entryUid: 'old' })]);

    refreshedAt = new Date('2026-08-22T01:00:00.000Z');
    entries = [{
      ...entries[0],
      entry_uid: 'new',
      name: 'NEWLY SANCTIONED ENTITY',
      normalized_name: 'newly sanctioned entity',
    }];

    await expect(OfacSanctionsListEngine._loadCache())
      .resolves.toEqual([expect.objectContaining({ entryUid: 'new' })]);
  });

  it('flags longer legal names and reordered sanctioned names for review', () => {
    expect(OfacSanctionsListEngine._similarity(
      'sberbank of russia pjsc',
      'sberbank',
    )).toBeGreaterThanOrEqual(0.88);
    expect(OfacSanctionsListEngine._similarity(
      'russia sberbank pjsc',
      'sberbank russia',
    )).toBeGreaterThanOrEqual(0.88);
    expect(OfacSanctionsListEngine._similarity(
      'russia sberbank',
      'sberbank russia',
    )).toBe(0.96);
  });

  it('does not treat partial words as sanctioned-name containment', () => {
    expect(OfacSanctionsListEngine._similarity(
      'sberbanking technology services',
      'sberbank',
    )).toBeLessThan(0.88);
  });

  it('exposes authenticated readiness and refresh operations plus a refresh script', () => {
    const routes = fs.readFileSync(
      path.resolve(process.cwd(), 'server/routes/finops.js'),
      'utf8',
    );
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    );

    expect(routes).toContain("router.get('/compliance/readiness', operatorAuth");
    expect(routes).toContain("router.post('/compliance/ofac/refresh', operatorAuth");
    expect(packageJson.scripts['compliance:refresh-ofac'])
      .toBe('node scripts/refresh-ofac-sanctions.cjs');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { CanonicalGlMapBuilder } = require('../server/integrations/fineract/canonicalGlMapBuilder');
const { FineractClient } = require('../server/integrations/fineract/fineractClient');

const saved = { ...process.env };

/** Shaped like Fineract GET /glaccounts. usage 1 = HEADER, 2 = DETAIL. */
function gl(id: number, glCode: string, name: string, typeId = 1, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    glCode,
    type: { id: typeId, value: ['', 'ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'][typeId] },
    usage: { id: 2, value: 'DETAIL' },
    manualEntriesAllowed: true,
    disabled: false,
    ...extra,
  };
}

function trust(code: string, name: string, type = 'asset', subType: string | null = 'cash') {
  return { account_code: code, account_name: name, account_type: type, sub_type: subType, is_active: true };
}

// The live production chart at the time of writing, trimmed to the shape that
// matters: 1210 (the treasury funding target) is unmapped, 1010 is unmapped.
const TRUST_CHART = [
  trust('1000', 'Trust Cash & Equivalents'),
  trust('1010', 'Trust Checking'),
  trust('1210', 'Stablecoin Backing Asset'),
  trust('2000', 'Distributions Payable', 'liability', 'payable'),
  trust('PTC-MEMBER-1786486061885-65A652', 'PTC Member Trust — Malissa Robinson'),
];
const STORED = [
  { trust_account_code: '1000', fineract_gl_id: 1 },
  { trust_account_code: '2000', fineract_gl_id: 5 },
];
const LIVE = [gl(1, '1000', 'Trust Cash & Equivalents'), gl(9, '1210', 'Stablecoin Backing Asset'), gl(5, '2000', 'Distributions Payable', 2)];

let queries: Array<{ sql: string; params: any[] }> = [];

function mockPool(chart = TRUST_CHART, stored = STORED) {
  queries = [];
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    queries.push({ sql, params });
    if (/FROM trust_accounts/.test(sql)) return { rows: chart };
    if (/FROM fineract_gl_mappings/.test(sql)) return { rows: stored };
    return { rows: [] };
  });
  vi.spyOn(CanonicalGlMapBuilder, '_db').mockReturnValue({ query });
  return query;
}

function byCode(plan: any, code: string) {
  return plan.entries.find((e: any) => e.accountCode === code);
}

beforeEach(() => {
  delete process.env.DAPP_MEMORY_MODE;
  process.env.CANONICAL_FUNDING_CASH_ACCOUNT_CODE = '1000';
  process.env.CANONICAL_FUNDING_ASSET_ACCOUNT_CODE = '1210';
  process.env.FINERACT_URL = 'https://fineract.dlbtrust.internal/fineract-provider/api/v1';
  vi.spyOn(FineractClient, 'getGLAccounts').mockResolvedValue(LIVE as any);
  mockPool();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('plan from live data', () => {
  it('classifies each account against the ERP and only maps what it confirms', async () => {
    const plan = await CanonicalGlMapBuilder.build({});
    expect(byCode(plan, '1000')).toMatchObject({ status: 'mapped', storedGlId: 1, liveGlId: 1, fineractGlId: 1, action: 'none' });
    // The live gap this was built for: the ERP has 1210, the mapping table does not.
    expect(byCode(plan, '1210')).toMatchObject({ status: 'discoverable', storedGlId: null, fineractGlId: 9, action: 'write-mapping' });
    expect(byCode(plan, '1010')).toMatchObject({ status: 'absent', fineractGlId: null, action: 'create-gl' });
    expect(plan.map).toEqual({ 1000: 1, 1210: 9, 2000: 5 });
    expect(plan.envLine).toBe('CANONICAL_GL_MAP=1000:1,1210:9,2000:5');
    expect(plan.coverage).toMatchObject({ trustAccounts: 4, mapped: 2, repairable: 1, needsGlAccount: 1 });
    expect(plan.ok).toBe(true);
  });

  it('excludes generated per-client codes unless asked, and honours an explicit list', async () => {
    const core = await CanonicalGlMapBuilder.build({});
    expect(core.entries.map((e: any) => e.accountCode)).not.toContain('PTC-MEMBER-1786486061885-65A652');

    const all = await CanonicalGlMapBuilder.build({ includeDynamic: true });
    expect(all.entries).toHaveLength(5);

    const scoped = await CanonicalGlMapBuilder.build({ codes: ['1210'] });
    expect(scoped.entries.map((e: any) => e.accountCode)).toEqual(['1210']);
  });

  it('flags a mapping that drifted from the ERP and one pointing at a deleted GL', async () => {
    mockPool(TRUST_CHART, [
      { trust_account_code: '1000', fineract_gl_id: 77 },
      { trust_account_code: '1210', fineract_gl_id: 404 },
    ]);
    (FineractClient.getGLAccounts as any).mockResolvedValue([gl(1, '1000', 'Trust Cash & Equivalents')]);
    const plan = await CanonicalGlMapBuilder.build({});
    expect(byCode(plan, '1000')).toMatchObject({ status: 'drifted', storedGlId: 77, fineractGlId: 1 });
    expect(byCode(plan, '1000').reason).toMatch(/mapping says GL 77, ERP glCode 1000 is GL 1/);
    expect(byCode(plan, '1210')).toMatchObject({ status: 'stale', fineractGlId: null, action: 'create-gl' });
    expect(plan.ok).toBe(false);
    expect(plan.issues).toContain('required account 1210 unusable: stale');
  });

  it('withholds header, disabled, and wrong-type GL accounts from the map', async () => {
    (FineractClient.getGLAccounts as any).mockResolvedValue([
      gl(1, '1000', 'Cash header', 1, { usage: { id: 1, value: 'HEADER' } }),
      gl(9, '1210', 'Stablecoin', 1, { manualEntriesAllowed: false }),
      gl(5, '2000', 'Distributions Payable', 4), // income, but the chart says liability
    ]);
    const plan = await CanonicalGlMapBuilder.build({});
    expect(byCode(plan, '1000')).toMatchObject({ status: 'unpostable', fineractGlId: null });
    expect(byCode(plan, '1000').reason).toMatch(/HEADER/);
    expect(byCode(plan, '1210')).toMatchObject({ status: 'unpostable', fineractGlId: null });
    expect(byCode(plan, '2000')).toMatchObject({ status: 'type_mismatch', fineractGlId: null });
    expect(byCode(plan, '2000').reason).toMatch(/trust chart says liability, ERP GL 5 is income/);
    expect(plan.map).toEqual({});
    expect(plan.ok).toBe(false);
  });

  it('keeps a deliberate mapping whose glCode differs from the trust code', async () => {
    mockPool([trust('1000', 'Trust Cash & Equivalents')], [{ trust_account_code: '1000', fineract_gl_id: 31 }]);
    (FineractClient.getGLAccounts as any).mockResolvedValue([gl(31, '10001', 'Operating Cash')]);
    const plan = await CanonicalGlMapBuilder.build({});
    expect(byCode(plan, '1000')).toMatchObject({ status: 'mapped', fineractGlId: 31 });
    expect(byCode(plan, '1000').reason).toMatch(/glCode differs from trust code/);
  });

  it('reports mappings whose trust account no longer exists', async () => {
    mockPool([trust('1000', 'Trust Cash & Equivalents')], [...STORED, { trust_account_code: '9999', fineract_gl_id: 42 }]);
    const plan = await CanonicalGlMapBuilder.build({});
    expect(plan.orphanMappings).toEqual([{ accountCode: '2000', fineractGlId: 5 }, { accountCode: '9999', fineractGlId: 42 }]);
  });

  it('trusts nothing when the ERP is unreachable', async () => {
    (FineractClient.getGLAccounts as any).mockRejectedValue(new Error('Fineract circuit breaker OPEN — service temporarily unavailable'));
    const plan = await CanonicalGlMapBuilder.build({});
    expect(plan.erp).toMatchObject({ reachable: false, glAccounts: 0 });
    expect(byCode(plan, '1000')).toMatchObject({ status: 'unverified', storedGlId: 1, fineractGlId: null });
    expect(byCode(plan, '1210')).toMatchObject({ status: 'absent' });
    expect(plan.map).toEqual({});
    expect(plan.ok).toBe(false);
    expect(plan.issues[0]).toMatch(/ERP unreachable .*circuit breaker OPEN.* could not be verified/);
  });
});

describe('apply', () => {
  it('writes confirmed mappings and leaves already-correct rows alone', async () => {
    const query = mockPool();
    const result = await CanonicalGlMapBuilder.apply({});
    expect(result.written).toEqual([{ accountCode: '1210', fineractGlId: 9, previousGlId: null, status: 'discoverable' }]);
    expect(result.created).toEqual([]);
    expect(result.skipped.map((s: any) => s.accountCode)).toEqual(['1010']);
    expect(result.envLine).toBe('CANONICAL_GL_MAP=1000:1,1210:9,2000:5');
    const inserts = query.mock.calls.filter(([sql]) => /INSERT INTO fineract_gl_mappings/.test(sql as string));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(['trust_journal', '1210', 9, 'Stablecoin Backing Asset (asset)']);
  });

  it('creates the missing GL account in the ERP when asked, then maps it', async () => {
    const create = vi.spyOn(FineractClient, 'createGLAccount').mockResolvedValue({ resourceId: 61 } as any);
    const result = await CanonicalGlMapBuilder.apply({ createMissing: true });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ glCode: '1010', name: 'Trust Checking', type: 1, usage: 2 }));
    expect(result.created).toEqual([{ accountCode: '1010', accountName: 'Trust Checking', fineractGlId: 61 }]);
    expect(result.written.map((w: any) => w.accountCode)).toEqual(['1010', '1210']);
  });

  it('never creates a GL account for a withheld conflict', async () => {
    (FineractClient.getGLAccounts as any).mockResolvedValue([gl(5, '1210', 'Wrong side', 5)]);
    const create = vi.spyOn(FineractClient, 'createGLAccount');
    const result = await CanonicalGlMapBuilder.apply({ createMissing: true, codes: ['1210'] });
    expect(create).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({ accountCode: '1210', status: 'type_mismatch' });
    expect(result.ok).toBe(false);
  });

  it('refuses to write anything while the ERP is unreachable', async () => {
    (FineractClient.getGLAccounts as any).mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(CanonicalGlMapBuilder.apply({})).rejects.toMatchObject({ code: 'ERP_UNREACHABLE', status: 503 });
    expect(queries.some(({ sql }) => /INSERT INTO|UPDATE fineract_gl_mappings/.test(sql))).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const THIRDWEB = '0x1A90c1b2d3E4f5A6b7C8d9E0f1A2b3C4d5E64f89';
const OTHER = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';

process.env.SPRITZ_API_KEY = 'test-key';
process.env.SPRITZ_API_BASE_URL = 'https://platform.spritz.finance';
process.env.THIRDWEB_SECRET_KEY = 'tw-secret';
process.env.THIRDWEB_SERVER_WALLET_ADDRESS = THIRDWEB;
process.env.THIRDWEB_SERVER_WALLET_CHAIN_ID = '8453';
process.env.CANONICAL_FUNDING_CASH_ACCOUNT_CODE = '1000';

const pool = require('../server/integrations/bonds/pgPool');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { SpritzBuyEngine } = require('../server/integrations/spritz/spritzBuyEngine');
const { OnOffRampEngine } = require('../server/integrations/dapp/onOffRampEngine');

type FetchCall = { url: string; init: RequestInit };

const USER_OK = { id: 'u1', capabilities: [{ product: 'fiat_to_crypto', method: 'ach_debit', status: 'active', requirements: [] }] };
const USER_BLOCKED = { id: 'u1', capabilities: [{ product: 'fiat_to_crypto', method: 'ach_debit', status: 'requirements_needed', requirements: [{ type: 'terms_acceptance', status: 'pending', actionUrl: 'https://spritz.example/terms' }] }] };
const SRC = { id: 'fs_1', status: 'active', institutionName: 'Lili', accountType: 'checking', accountNumberLast4: '4321', permanent: true };
const SRC_2 = { id: 'fs_2', status: 'active', institutionName: 'Chase', accountType: 'checking', accountNumberLast4: '9999', permanent: true };
const LIMITS = { limitsByPriority: { normal: { available: true, minAmountUsd: '10', maxAmountUsd: '5000' }, high: { available: false, reason: 'high priority disabled' } } };
const PREP = {
  preparationId: 'prep_1', expiresAt: '2026-09-13T17:00:00Z', message: 'authorize ACH debit',
  summary: { requestedAmountUsd: '250.00', principalAmountUsd: '250.00', expectedAssetAmount: '249.12', userFeeUsd: '0.88', feeRateBps: 35, totalDebitAmountUsd: '250.88', priority: 'normal', destinationAddress: THIRDWEB, network: 'base', asset: 'USDC' },
};
function deposit(status: string, extra: Record<string, unknown> = {}) {
  return { id: 'dep_1', status, debitStatus: 'pending', releaseStatus: 'pending', principalAmountUsd: '250.00', expectedAssetAmount: '249.12', userFeeUsd: '0.88', totalDebitAmountUsd: '250.88', address: THIRDWEB, network: 'base', createdAt: '2026-09-13T16:00:00Z', ...extra };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Spritz Buy USDC (ACH debit -> thirdweb server wallet)', () => {
  const calls: FetchCall[] = [];
  let rows: Record<string, any>;
  let journal: any[];

  function stubSpritz(overrides: Record<string, unknown> = {}) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      if (path in overrides) {
        const v = overrides[path];
        return typeof v === 'function' ? (v as any)(init) : jsonResponse(v);
      }
      if (path === '/v1/users/me') return jsonResponse(USER_OK);
      if (path === '/v1/funding-sources/') return jsonResponse([SRC]);
      if (path === '/v1/funding-sources/fs_1/deposit-limits') return jsonResponse(LIMITS);
      if (path === '/v1/deposits/direct/prepare') return jsonResponse(PREP);
      if (path === '/v1/deposits/direct') return jsonResponse(deposit('processing'));
      if (path === '/v1/deposits/dep_1') return jsonResponse(deposit('processing'));
      return jsonResponse({ error: `unstubbed ${path}` }, 500);
    }));
  }

  function stubDb() {
    rows = {};
    journal = [];
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params: any[] = []) => {
      if (/INSERT INTO spritz_buys/.test(sql)) {
        const prev = rows[params[0]] || { created_at: new Date('2026-09-13T16:00:00Z') };
        rows[params[0]] = { ...prev, reference: params[0], amount_usd: params[1], priority: params[2], funding_source_id: params[3], destination: params[4], network: params[5], preparation_id: params[6], quote: JSON.parse(params[7]), deposit_id: params[8], deposit: JSON.parse(params[9]), status: params[10], shadow: params[11], error: params[12], memo: prev.memo ?? params[13], created_by: prev.created_by ?? params[14] };
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE spritz_buys SET deposit = /.test(sql)) {
        Object.assign(rows[params[3]], { deposit: JSON.parse(params[0]), status: params[1], error: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE spritz_buys SET gl_entry_id/.test(sql)) {
        Object.assign(rows[params[1]], { gl_entry_id: params[0] });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT \* FROM spritz_buys WHERE reference/.test(sql)) return { rows: rows[params[0]] ? [rows[params[0]]] : [], rowCount: 0 };
      if (/SELECT \* FROM spritz_buys/.test(sql)) return { rows: Object.values(rows), rowCount: 0 };
      if (/FROM trust_journal_entries/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockImplementation(async (entry: any) => {
      journal.push(entry);
      return { entry_id: `JE-${journal.length}` };
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    calls.length = 0;
    delete process.env.SPRITZ_BUY_LIVE;
    delete process.env.SPRITZ_BUY_FUNDING_SOURCE_ID;
    delete process.env.SPRITZ_BUY_DESTINATION;
    delete process.env.SPRITZ_BUY_MAX_AMOUNT_USD;
    stubDb();
    stubSpritz();
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('defaults the destination to the thirdweb server wallet on Base', () => {
    const cfg = SpritzBuyEngine.config();
    expect(cfg.destination).toBe(THIRDWEB);
    expect(cfg.destinationIsThirdweb).toBe(true);
    expect(cfg.network).toBe('base');
    expect(cfg.live).toBe(false);
  });

  it('readiness reports shadow mode, the linked funding source and its limits', async () => {
    const r = await SpritzBuyEngine.readiness();
    expect(r.ready).toBe(true);
    expect(r.live).toBe(false);
    expect(r.destination).toBe(THIRDWEB);
    expect(r.fundingSources).toHaveLength(1);
    expect(r.fundingSources[0]).toMatchObject({ id: 'fs_1', active: true, accountNumberLast4: '4321' });
    expect(r.warnings.join(' ')).toMatch(/SPRITZ_BUY_LIVE=false/);
  });

  it('quotes via /deposits/direct/prepare against the thirdweb wallet and creates nothing', async () => {
    const q = await SpritzBuyEngine.quote({ amountUsd: 250 });
    expect(q.destination).toBe(THIRDWEB);
    expect(q.fundingSource.id).toBe('fs_1');
    expect(q.quote).toMatchObject({ preparationId: 'prep_1', totalDebitAmountUsd: '250.88', expectedAssetAmount: '249.12' });
    const prep = calls.find((c) => c.url.endsWith('/v1/deposits/direct/prepare'));
    expect(prep).toBeTruthy();
    expect(JSON.parse(String(prep!.init.body))).toMatchObject({ sourceId: 'fs_1', address: THIRDWEB, network: 'base', asset: 'USDC', amountUsd: '250.00', quoteType: 'exact_input', priority: 'normal' });
    expect(calls.some((c) => c.url.endsWith('/v1/deposits/direct'))).toBe(false);
  });

  it('refuses when the capability needs requirements, the source is missing/ambiguous, or limits are exceeded', async () => {
    stubSpritz({ '/v1/users/me': USER_BLOCKED });
    await expect(SpritzBuyEngine.quote({ amountUsd: 250 })).rejects.toMatchObject({ code: 'BUY_CAPABILITY_INACTIVE' });

    stubSpritz({ '/v1/funding-sources/': [] });
    await expect(SpritzBuyEngine.quote({ amountUsd: 250 })).rejects.toMatchObject({ code: 'FUNDING_SOURCE_MISSING' });

    stubSpritz({ '/v1/funding-sources/': [SRC, SRC_2] });
    await expect(SpritzBuyEngine.quote({ amountUsd: 250 })).rejects.toMatchObject({ code: 'FUNDING_SOURCE_AMBIGUOUS' });

    stubSpritz({ '/v1/funding-sources/': [{ ...SRC, status: 'disabled' }] });
    await expect(SpritzBuyEngine.quote({ amountUsd: 250, fundingSourceId: 'fs_1' })).rejects.toMatchObject({ code: 'FUNDING_SOURCE_INACTIVE' });

    stubSpritz();
    await expect(SpritzBuyEngine.quote({ amountUsd: 9000 })).rejects.toMatchObject({ code: 'BUY_ABOVE_DEPOSIT_LIMIT' });
    await expect(SpritzBuyEngine.quote({ amountUsd: 5 })).rejects.toMatchObject({ code: 'BUY_BELOW_MINIMUM' });
    await expect(SpritzBuyEngine.quote({ amountUsd: 250, priority: 'high' })).rejects.toMatchObject({ code: 'BUY_LIMIT_UNAVAILABLE' });

    process.env.SPRITZ_BUY_MAX_AMOUNT_USD = '100';
    await expect(SpritzBuyEngine.quote({ amountUsd: 250 })).rejects.toMatchObject({ code: 'BUY_AMOUNT_ABOVE_CEILING' });
  });

  it('shadow mode records the quote, never POSTs /deposits/direct, and is idempotent', async () => {
    const r = await SpritzBuyEngine.buy({ amountUsd: 250, reference: 'ERP-1', createdBy: 'maker' });
    expect(r.status).toBe('quoted');
    expect(r.shadow).toBe(true);
    expect(r.destination).toBe(THIRDWEB);
    expect(calls.some((c) => c.url.endsWith('/v1/deposits/direct'))).toBe(false);

    calls.length = 0;
    const again = await SpritzBuyEngine.buy({ amountUsd: 250, reference: 'ERP-1' });
    expect(again.idempotent).toBe(true);
    expect(calls).toHaveLength(0);
    expect(journal).toHaveLength(0);
  });

  it('live mode creates the deposit with Idempotency-Key = reference and books the GL only on completion', async () => {
    process.env.SPRITZ_BUY_LIVE = 'true';
    const r = await SpritzBuyEngine.buy({ amountUsd: 250, reference: 'ERP-2', createdBy: 'checker' });
    expect(r.status).toBe('processing');
    expect(r.shadow).toBe(false);
    expect(r.depositId).toBe('dep_1');
    const create = calls.find((c) => c.url.endsWith('/v1/deposits/direct'));
    expect(create).toBeTruthy();
    expect(new Headers(create!.init.headers as HeadersInit).get('Idempotency-Key')).toBe('ERP-2');
    expect(JSON.parse(String(create!.init.body))).toEqual({ preparationId: 'prep_1' });
    expect(journal).toHaveLength(0);

    // still processing: no booking
    let s = await SpritzBuyEngine.sync({ reference: 'ERP-2' });
    expect(s.updates[0]).toMatchObject({ status: 'processing', changed: false, gl: null });
    expect(journal).toHaveLength(0);

    // completed: Dr 1210 principal, Dr 5300 fee, Cr 1000 total debit — exactly once
    stubSpritz({ '/v1/deposits/dep_1': deposit('completed', { debitStatus: 'settled', releaseStatus: 'confirmed' }) });
    s = await SpritzBuyEngine.sync({ reference: 'ERP-2' });
    expect(s.updates[0]).toMatchObject({ status: 'completed', changed: true });
    expect(s.updates[0].gl).toMatchObject({ booked: true, status: 'booked' });
    expect(journal).toHaveLength(1);
    expect(journal[0].referenceType).toBe('spritz_buy');
    expect(journal[0].referenceId).toBe('ERP-2');
    expect(journal[0].lines).toEqual([
      expect.objectContaining({ accountCode: '1210', debitAmount: 250, creditAmount: 0 }),
      expect.objectContaining({ accountCode: '5300', debitAmount: 0.88, creditAmount: 0 }),
      expect.objectContaining({ accountCode: '1000', debitAmount: 0, creditAmount: 250.88 }),
    ]);

    const after = await SpritzBuyEngine.get('ERP-2');
    expect(after.glEntryId).toBe('JE-1');
    s = await SpritzBuyEngine.sync({ reference: 'ERP-2' });
    expect(s.updates[0].gl).toMatchObject({ status: 'already_booked' });
    expect(journal).toHaveLength(1);
  });

  it('live mode fails closed when Spritz refuses the deposit', async () => {
    process.env.SPRITZ_BUY_LIVE = 'true';
    stubSpritz({ '/v1/deposits/direct': () => jsonResponse({ message: 'funding source frozen' }, 422) });
    await expect(SpritzBuyEngine.buy({ amountUsd: 250, reference: 'ERP-3' })).rejects.toMatchObject({ code: 'BUY_CREATE_FAILED' });
    const row = await SpritzBuyEngine.get('ERP-3');
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/funding source frozen/);
    expect(journal).toHaveLength(0);
  });

  it('ramp engine routes spritz onramp proposals into the buy engine and pins the destination', async () => {
    const providers = await OnOffRampEngine.providers();
    expect(providers.find((p: any) => p.id === 'spritz').directions).toContain('onramp');

    const buy = vi.spyOn(SpritzBuyEngine, 'buy').mockResolvedValue({ reference: 'RMP-1', status: 'quoted' } as any);
    const out = await OnOffRampEngine._executeProvider({ id: 'RMP-1', created_by: 'checker', payload: { provider: 'spritz', direction: 'onramp', amount: 250, fundingSourceId: 'fs_1', priority: 'normal', targetAddress: THIRDWEB } });
    expect(out.status).toBe('quoted');
    expect(buy).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 250, reference: 'RMP-1', fundingSourceId: 'fs_1', createdBy: 'checker' }));

    await expect(OnOffRampEngine._executeProvider({ id: 'RMP-2', payload: { provider: 'spritz', direction: 'onramp', amount: 250, targetAddress: OTHER } }))
      .rejects.toMatchObject({ code: 'SPRITZ_BUY_DESTINATION_MISMATCH' });
  });
});

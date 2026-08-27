import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { ComplianceEngine } = require('../server/integrations/compliance/complianceEngine');
const {
  OpenSanctionsListEngine,
  createCsvRecordParser,
  splitAliases,
} = require('../server/integrations/compliance/openSanctionsListEngine');
const pool = require('../server/integrations/bonds/pgPool');

const originalEnvironment = {
  COMPLIANCE_PROVIDER: process.env.COMPLIANCE_PROVIDER,
  COMPLIANCE_OPENSANCTIONS_DATASET: process.env.COMPLIANCE_OPENSANCTIONS_DATASET,
  COMPLIANCE_OPENSANCTIONS_MIN_TARGETS: process.env.COMPLIANCE_OPENSANCTIONS_MIN_TARGETS,
  NODE_ENV: process.env.NODE_ENV,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    list_key: 'opensanctions:sanctions:primary',
    source_file: 'targets.simple.csv',
    source_url: 'https://data.opensanctions.org/artifacts/sanctions/x/targets.simple.csv',
    source_updated_at: new Date(),
    refreshed_at: new Date(),
    entry_count: 72033,
    digest: '20260826-x',
    ...overrides,
  };
}

describe('OpenSanctions bulk CSV ingestion', () => {
  it('parses records split across chunks, quoted commas and embedded newlines', () => {
    const consume = createCsvRecordParser();
    expect(consume('id,name,alias')).toEqual([]);
    expect(consume('es\nNK-1,"ACME, LLC","AC')).toEqual([['id', 'name', 'aliases']]);
    expect(consume('ME\nTRADING"\n')).toEqual([['NK-1', 'ACME, LLC', 'ACME\nTRADING']]);
  });

  it('preserves doubled quotes and splits multi-valued alias columns', () => {
    const consume = createCsvRecordParser();
    expect(consume('NK-2,"THE ""RED"" GROUP"\r\n')).toEqual([['NK-2', 'THE "RED" GROUP']]);
    expect(splitAliases('Alias One; Alias Two ;;')).toEqual(['Alias One', 'Alias Two']);
  });
});

describe('OpenSanctions readiness', () => {
  it('fails closed when the dataset has never been ingested', async () => {
    vi.spyOn(OpenSanctionsListEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] });

    const result = await OpenSanctionsListEngine.readiness();

    expect(result.ready).toBe(false);
    expect(result.issues.join('; ')).toContain('has never been ingested');
  });

  it('fails closed on a stale or truncated dataset', async () => {
    vi.spyOn(OpenSanctionsListEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [listRow({
        entry_count: 12,
        refreshed_at: new Date(Date.now() - 72 * 3600000),
      })],
    });

    const result = await OpenSanctionsListEngine.readiness();

    expect(result.ready).toBe(false);
    expect(result.issues.join('; ')).toContain('holds 12 targets');
    expect(result.issues.join('; ')).toContain('older than 48 hours');
  });

  it('is ready on a fresh, fully ingested dataset', async () => {
    vi.spyOn(OpenSanctionsListEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [
        listRow(),
        listRow({ list_key: 'opensanctions:sanctions:alias', entry_count: 219477 }),
      ],
    });

    const result = await OpenSanctionsListEngine.readiness();

    expect(result).toMatchObject({ ready: true, provider: 'opensanctions', dataset: 'sanctions' });
    expect(result.entryCount).toBe(291510);
    expect(result.issues).toEqual([]);
  });

  it('refreshes when readiness is not clear', async () => {
    vi.spyOn(OpenSanctionsListEngine, 'readiness').mockResolvedValue({ ready: false, issues: ['stale'] });
    const refresh = vi.spyOn(OpenSanctionsListEngine, 'refresh')
      .mockResolvedValue({ ready: true, entryCount: 291510 });

    await expect(OpenSanctionsListEngine.refreshIfStale())
      .resolves.toMatchObject({ ready: true });
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('OpenSanctions screening', () => {
  it('returns an exact match without scanning candidates', async () => {
    vi.spyOn(OpenSanctionsListEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(pool, 'query').mockResolvedValue({
      rows: [{
        list_key: 'opensanctions:sanctions:primary',
        entry_uid: 'NK-abc',
        name: 'Sberbank of Russia',
        normalized_name: 'sberbank of russia',
        source_file: 'targets.simple.csv',
        is_alias: false,
        alias_type: null,
      }],
    });

    await expect(OpenSanctionsListEngine.screenName('Sberbank of Russia'))
      .resolves.toMatchObject({ entryUid: 'NK-abc', similarity: 1 });
  });

  it('flags a bounded candidate as a potential match and clears unrelated names', async () => {
    vi.spyOn(OpenSanctionsListEngine, 'ensureTables').mockResolvedValue(undefined);
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params: unknown[]) => {
      if (String(sql).includes('normalized_name = $2\n       LIMIT 1')) return { rows: [] };
      expect(params[5]).toBe(500);
      return {
        rows: [{
          list_key: 'opensanctions:sanctions:primary',
          entry_uid: 'NK-def',
          name: 'Sberbank',
          normalized_name: 'sberbank',
          source_file: 'targets.simple.csv',
          is_alias: false,
          alias_type: null,
        }],
      };
    });

    await expect(OpenSanctionsListEngine.screenName('Sberbank of Russia PJSC'))
      .resolves.toMatchObject({ entryUid: 'NK-def' });
    await expect(OpenSanctionsListEngine.screenName('Sberbanking Technology Services'))
      .resolves.toBeNull();
  });

  it('refuses to screen against an unready dataset', async () => {
    process.env.COMPLIANCE_PROVIDER = 'opensanctions';
    vi.spyOn(OpenSanctionsListEngine, 'readiness')
      .mockResolvedValue({ ready: false, provider: 'opensanctions', issues: ['dataset is stale'] });
    const screenName = vi.spyOn(OpenSanctionsListEngine, 'screenName');

    await expect(ComplianceEngine._sanctionsMatch('Any Vendor', 'opensanctions'))
      .rejects.toMatchObject({ code: 'COMPLIANCE_UNAVAILABLE' });
    expect(screenName).not.toHaveBeenCalled();
  });
});

describe('compliance provider selection', () => {
  it('authorizes production screening through the OpenSanctions dataset', async () => {
    process.env.NODE_ENV = 'production';
    process.env.COMPLIANCE_PROVIDER = 'opensanctions';
    vi.spyOn(OpenSanctionsListEngine, 'readiness').mockResolvedValue({
      ready: true,
      provider: 'opensanctions',
      entryCount: 291510,
      issues: [],
    });

    await expect(ComplianceEngine.readiness())
      .resolves.toMatchObject({ ready: true, provider: 'opensanctions', sanctionedCount: 291510 });
  });

  it('rejects an unsupported provider', async () => {
    process.env.COMPLIANCE_PROVIDER = 'guesswork';

    const readiness = await ComplianceEngine.readiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.issues).toContain('Unsupported compliance provider: guesswork');
  });

  it('exposes an authenticated refresh operation and a refresh script', () => {
    const routes = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/finops.js'), 'utf8');
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    );

    expect(routes).toContain("router.post('/compliance/opensanctions/refresh', operatorAuth");
    expect(packageJson.scripts['compliance:refresh-opensanctions'])
      .toBe('node scripts/refresh-opensanctions.cjs');
  });
});

import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.GCP_PROJECT = 'dlb-treasury-management';

const { EngineWiringReadiness: E } = require('../server/integrations/os/engineWiringReadiness');

const NEW_FIAT_ENGINES = ['accounting', 'stripe-intake', 'treasury-funding-bank', 'payment-hub', 'openach', 'mft'];

describe('engineWiringReadiness registry', () => {
  it('registers every fiat engine with a title, tables and a reporter', () => {
    for (const key of [...NEW_FIAT_ENGINES, 'aggregator', 'private-payment-network']) {
      expect(E.ENGINE_KEYS).toContain(key);
      expect(E.ENGINE_TITLES[key]).toBeTruthy();
      expect(E.TABLES[key].length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown engines', async () => {
    await expect(E.engineReadiness('nope')).rejects.toThrow(/Unknown platform engine/);
  });

  it('reports the new engines with the shared ready/mode/blockers shape', async () => {
    for (const key of NEW_FIAT_ENGINES) {
      const r = await E.engineReadiness(key);
      expect(r.engine).toBe(key);
      expect(r.title).toBe(E.ENGINE_TITLES[key]);
      expect(['live', 'shadow']).toContain(r.mode);
      expect(Array.isArray(r.blockers)).toBe(true);
      expect(r.routes).toContain(`/api/os/readiness/${key}`);
      expect(typeof r.liveFlags).toBe('object');
      expect(r.gcp.expectedProject).toBe('dlb-treasury-management');
      expect(r.ready).toBe(r.blockers.length === 0);
    }
  }, 60000);

  it('treasury-funding-bank stays shadow until the Betterment mandate is linked and verified', async () => {
    const r = await E.engineReadiness('treasury-funding-bank');
    expect(r.mode).toBe('shadow');
    expect(r.blockers.some((b: string) => /treasury funding bank:/.test(b))).toBe(true);
  });

  it('openach / mft report the ODFI file-channel blocker instead of claiming live', async () => {
    const o = await E.engineReadiness('openach');
    expect(o.mode).toBe('shadow');
    expect(o.liveFlags.ODFI_FILE_CHANNEL_READY).toBe(false);
    const m = await E.engineReadiness('mft');
    expect(m.mode).toBe('shadow');
    expect(m.blockers.length).toBeGreaterThan(0);
  });

  it('aggregate readiness includes every registered engine', async () => {
    const r = await E.readiness();
    expect(r.total).toBe(E.ENGINE_KEYS.length);
    for (const key of E.ENGINE_KEYS) expect(r.engines[key]).toBeTruthy();
    expect(r.ready).toBe(Object.values(r.engines).every((e: any) => e.ready));
  }, 120000);
});

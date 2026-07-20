import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const trustIdentity = require('../server/integrations/payments/trustIdentity');

describe('trustIdentity', () => {
  const saved = {
    id: process.env.TRUST_ID,
    acct: process.env.TRUST_MASTER_ACCOUNT,
    name: process.env.TRUST_NAME,
  };

  beforeEach(() => {
    delete process.env.TRUST_ID;
    delete process.env.TRUST_MASTER_ACCOUNT;
    delete process.env.TRUST_NAME;
  });

  afterEach(() => {
    if (saved.id === undefined) delete process.env.TRUST_ID; else process.env.TRUST_ID = saved.id;
    if (saved.acct === undefined) delete process.env.TRUST_MASTER_ACCOUNT; else process.env.TRUST_MASTER_ACCOUNT = saved.acct;
    if (saved.name === undefined) delete process.env.TRUST_NAME; else process.env.TRUST_NAME = saved.name;
  });

  it('masks identifiers to last 4 digits, never exposing the full value', () => {
    expect(trustIdentity.mask('1978144300')).toBe('******4300');
    expect(trustIdentity.mask('274804322')).toBe('*****4322');
    // short values are fully masked (no leak)
    expect(trustIdentity.mask('12')).toBe('**');
    expect(trustIdentity.mask('')).toBeNull();
    expect(trustIdentity.mask(null)).toBeNull();
  });

  it('reports not-configured when identifiers are absent', () => {
    expect(trustIdentity.isConfigured()).toBe(false);
    expect(() => trustIdentity.requireConfigured()).toThrow(/TRUST_ID/);
  });

  it('reads env-driven identifiers and exposes only a redacted summary', () => {
    process.env.TRUST_ID = '274804322';
    process.env.TRUST_MASTER_ACCOUNT = '1978144300';
    process.env.TRUST_NAME = 'Test Trust';

    expect(trustIdentity.isConfigured()).toBe(true);
    expect(trustIdentity.requireConfigured()).toBe(true);

    const s = trustIdentity.summary();
    expect(s.configured).toBe(true);
    expect(s.trust_name).toBe('Test Trust');
    expect(s.trust_id).toBe('*****4322');
    expect(s.trust_master_account).toBe('******4300');

    // The summary must NOT contain the full sensitive values.
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain('274804322');
    expect(serialized).not.toContain('1978144300');
  });

  it('requireConfigured lists each missing identifier', () => {
    process.env.TRUST_ID = '274804322';
    expect(() => trustIdentity.requireConfigured()).toThrow(/TRUST_MASTER_ACCOUNT/);
  });
});

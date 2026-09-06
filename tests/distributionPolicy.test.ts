import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const ENV = ['DISTRIBUTION_LIMIT_BENEFICIARY_USD', 'DISTRIBUTION_LIMIT_TRUSTEE_USD', 'DISTRIBUTION_PURPOSES'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  process.env.DAPP_MEMORY_MODE = 'true';
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const Policy = require('../server/integrations/dapp/distributionPolicy');

describe('distribution policy', () => {
  it('defaults to $100K per transaction for beneficiaries and $500K for trustees', () => {
    expect(Policy.getPolicy()).toEqual({
      limitsUsd: { beneficiary: 100000, trustee: 500000 },
      purposes: ['lifestyle', 'medical', 'travel', 'home', 'education'],
    });
    expect(Policy.enforce({ requesterRole: 'beneficiary', amountUsd: 100000, purpose: 'travel' })).toMatchObject({ limitUsd: 100000, purpose: 'travel' });
    expect(() => Policy.enforce({ requesterRole: 'beneficiary', amountUsd: 100000.01 })).toThrow(/\$100,000 per-transaction limit/);
    expect(Policy.enforce({ requesterRole: 'trustee_checker', amountUsd: 500000 })).toMatchObject({ requesterRole: 'trustee', limitUsd: 500000 });
    expect(() => Policy.enforce({ requesterRole: 'trustee', amountUsd: 500001 })).toThrow(/\$500,000 per-transaction limit/);
  });

  it('only accepts the supported expense purposes and known roles', () => {
    expect(() => Policy.enforce({ requesterRole: 'beneficiary', amountUsd: 1, purpose: 'crypto' })).toThrow(/not permitted/);
    expect(() => Policy.enforce({ requesterRole: 'auditor', amountUsd: 1 })).toThrow(/requesterRole/);
    expect(() => Policy.enforce({ requesterRole: 'beneficiary', amountUsd: 0 })).toThrow(/amountUsd/);
    expect(Policy.enforce({ requesterRole: 'beneficiary', amountUsd: 1, purpose: ' Medical ' }).purpose).toBe('medical');
  });

  it('is env-tunable', () => {
    process.env.DISTRIBUTION_LIMIT_BENEFICIARY_USD = '250000';
    process.env.DISTRIBUTION_PURPOSES = 'medical';
    expect(Policy.enforce({ requesterRole: 'beneficiary', amountUsd: 200000, purpose: 'medical' }).limitUsd).toBe(250000);
    expect(() => Policy.enforce({ requesterRole: 'beneficiary', amountUsd: 1, purpose: 'travel' })).toThrow(/allowed: medical/);
  });
});

describe('distribution requests honour the policy', () => {
  const { DistributionRequestEngine } = require('../server/integrations/dapp/distributionRequestEngine');
  const base = { beneficiaryEmail: 'b@dlbtrust.test', destinationAddress: '0x000000000000000000000000000000000000dEaD' };

  it('rejects requests above the requester role limit and records the purpose', async () => {
    await expect(DistributionRequestEngine.createRequest({ ...base, requesterRole: 'beneficiary', amountUsd: 150000, purpose: 'home' }))
      .rejects.toMatchObject({ code: 'DISTRIBUTION_LIMIT_EXCEEDED' });
    const ok = await DistributionRequestEngine.createRequest({ ...base, requesterRole: 'trustee', amountUsd: 150000, purpose: 'home' });
    expect(Number(ok.amount_cents)).toBe(15000000);
    expect(ok.metadata).toMatchObject({ purpose: 'home', limitUsd: 500000 });
  });
});

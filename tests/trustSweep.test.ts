import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sweep = require('../server/integrations/payments/trustSweepScheduler');

describe('trustSweepScheduler.computeAvailable', () => {
  it('sweeps balance minus reserve', () => {
    expect(sweep.computeAvailable(1000, 250, null)).toBe(750);
  });

  it('never sweeps a negative amount (floors at 0)', () => {
    expect(sweep.computeAvailable(100, 250, null)).toBe(0);
    expect(sweep.computeAvailable(-50, 0, null)).toBe(0);
  });

  it('caps at max_amount when set', () => {
    expect(sweep.computeAvailable(1000, 0, 400)).toBe(400);
    expect(sweep.computeAvailable(300, 0, 400)).toBe(300);
  });

  it('rounds to cents to avoid floating-point dust', () => {
    expect(sweep.computeAvailable(100.005, 0, null)).toBe(100.01);
  });
});

describe('trustSweepScheduler.buildSweepKey', () => {
  it('is stable within the same window bucket (idempotent) and differs across sources', () => {
    const k1 = sweep.buildSweepKey('1000', 60000);
    const k2 = sweep.buildSweepKey('1000', 60000);
    expect(k1).toBe(k2); // same source + window → same key
    expect(sweep.buildSweepKey('2000', 60000)).not.toBe(k1);
  });

  it('honors an explicit override key', () => {
    expect(sweep.buildSweepKey('1000', 60000, 'my-key')).toBe('my-key');
  });

  it('encodes source and window in the derived key', () => {
    const k = sweep.buildSweepKey('1000', 60000);
    expect(k.startsWith('1000:60000:')).toBe(true);
  });
});

describe('trustSweepScheduler.isEnabled', () => {
  it('is off unless TRUST_SWEEP_ENABLED=true (money movement is opt-in)', () => {
    const old = process.env.TRUST_SWEEP_ENABLED;
    delete process.env.TRUST_SWEEP_ENABLED;
    expect(sweep.isEnabled()).toBe(false);
    process.env.TRUST_SWEEP_ENABLED = 'false';
    expect(sweep.isEnabled()).toBe(false);
    process.env.TRUST_SWEEP_ENABLED = 'true';
    expect(sweep.isEnabled()).toBe(true);
    if (old === undefined) delete process.env.TRUST_SWEEP_ENABLED;
    else process.env.TRUST_SWEEP_ENABLED = old;
  });
});

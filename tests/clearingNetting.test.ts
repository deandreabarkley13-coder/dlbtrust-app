import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ClearingNettingEngine } = require('../server/integrations/os/clearingNettingEngine');
const { WealthBackOfficeEngine } = require('../server/integrations/os/wealthBackOfficeEngine');
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { FundingSourceRegistry } = require('../server/integrations/inhouseBank/clearing/fundingSourceRegistry');
const { MessagingEngine } = require('../server/integrations/messaging/messagingEngine');
const pool = require('../server/integrations/bonds/pgPool');

const TODAY = new Date().toISOString().slice(0, 10);

function queueItem(over: any = {}) {
  return {
    origin: 'vendor_payable',
    originId: 'VPAY-1',
    desk: 'payouts',
    label: 'Approved vendor payable',
    disbursementType: 'vendor_payout',
    payeeKey: 'acme',
    counterparty: 'ACME PLUMBING LLC',
    amountCents: 250_000,
    amount: '$2,500.00',
    currency: 'USD',
    reference: 'INV-77',
    dueDate: '2026-09-01',
    status: 'approved',
    pushable: true,
    blockers: [] as string[],
    disbursementId: null,
    ...over,
  };
}

/**
 * The clearing tables answered from memory, so a cycle can be opened, funded,
 * settled and read back exactly as the engine writes it.
 */
function clearingStore({
  queue = [queueItem()] as any[],
  queueErrors = [] as any[],
  availableCents = 1_000_000,
  operatingEligible = true,
} = {}) {
  const cycles: any[] = [];
  const legs: any[] = [];
  const items: any[] = [];
  const pushes: any[] = [];

  const run = async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };

    if (/INSERT INTO clearing_cycles/.test(text)) {
      cycles.push({
        cycle_id: params[0], value_date: params[1], currency: params[2], opened_by: params[3],
        gross_cents: params[4], net_cents: params[5], note: params[6], status: 'netted',
        settled_cents: 0, created_at: new Date(), netted_at: new Date(),
        funded_at: null, settled_at: null, cancelled_at: null,
        funding_source: null, funded_by: null, cancelled_by: null, cancel_reason: null,
      });
      return { rows: [] };
    }
    if (/INSERT INTO clearing_cycle_legs/.test(text)) {
      legs.push({
        leg_id: params[0], cycle_id: params[1], payee_key: params[2], counterparty: params[3],
        disbursement_type: params[4], currency: params[5], value_date: params[6],
        gross_cents: params[7], net_cents: params[8], obligation_count: params[9],
        status: 'netted', disbursement_id: null, failure_reason: null,
      });
      return { rows: [] };
    }
    if (/INSERT INTO clearing_cycle_items/.test(text)) {
      const claimed = items.find(i => !i.released && i.origin === params[3] && i.origin_id === params[4]);
      if (claimed) throw new Error('duplicate key value violates unique constraint "uq_clearing_items_live_claim"');
      items.push({
        item_id: params[0], cycle_id: params[1], leg_id: params[2], origin: params[3], origin_id: params[4],
        desk: params[5], counterparty: params[6], payee_key: params[7], amount_cents: params[8],
        currency: params[9], reference: params[10], due_date: params[11], released: false,
        created_at: new Date(),
      });
      return { rows: [] };
    }
    if (/INSERT INTO wealth_credit_pushes/.test(text)) {
      pushes.push({ push_id: params[0], origin: params[1], origin_id: params[2], disbursement_id: params[3], amount_cents: params[6] });
      return { rows: [] };
    }

    if (/UPDATE clearing_cycle_legs SET status = 'failed'/.test(text)) {
      const leg = legs.find(l => l.leg_id === params[0]);
      if (leg) { leg.status = 'failed'; leg.failure_reason = params[1]; }
      return { rows: [] };
    }
    if (/UPDATE clearing_cycle_legs SET status = 'settled'/.test(text)) {
      const leg = legs.find(l => l.leg_id === params[0]);
      if (leg) leg.status = 'settled';
      return { rows: [] };
    }
    if (/UPDATE clearing_cycle_legs SET status = 'released'/.test(text)) {
      const leg = legs.find(l => l.leg_id === params[0]);
      if (leg) leg.status = 'released';
      return { rows: [] };
    }
    if (/UPDATE clearing_cycle_legs SET status = 'pushed'/.test(text)) {
      const leg = legs.find(l => l.leg_id === params[0]);
      if (leg) { leg.status = 'pushed'; leg.disbursement_id = params[1]; }
      return { rows: [] };
    }
    if (/UPDATE clearing_cycle_items SET released = TRUE/.test(text)) {
      items.filter(i => i.cycle_id === params[0] && i.leg_id === params[1]).forEach((i) => { i.released = true; });
      return { rows: [] };
    }
    if (/UPDATE clearing_cycles SET status = 'funded'/.test(text)) {
      const cycle = cycles.find(c => c.cycle_id === params[0]);
      if (cycle) { cycle.status = 'funded'; cycle.funding_source = params[1]; cycle.funded_by = params[2]; }
      return { rows: [] };
    }
    if (/UPDATE clearing_cycles SET status = 'settling'/.test(text)) {
      const cycle = cycles.find(c => c.cycle_id === params[0]);
      if (cycle) cycle.status = 'settling';
      return { rows: [] };
    }
    if (/UPDATE clearing_cycles SET status = 'cancelled'/.test(text)) {
      const cycle = cycles.find(c => c.cycle_id === params[0]);
      if (cycle) { cycle.status = 'cancelled'; cycle.cancelled_by = params[1]; cycle.cancel_reason = params[2]; }
      return { rows: [] };
    }
    if (/UPDATE clearing_cycles SET status = \$2, settled_cents/.test(text)) {
      const cycle = cycles.find(c => c.cycle_id === params[0]);
      if (cycle) { cycle.status = params[1]; cycle.settled_cents = params[2]; }
      return { rows: [] };
    }

    if (/SELECT COALESCE\(SUM\(net_cents - settled_cents\), 0\)/.test(text)) {
      const live = cycles.filter(c => params[0].includes(c.status) && c.cycle_id !== (params[1] || ''));
      return { rows: [{ committed: live.reduce((total, c) => total + Number(c.net_cents) - Number(c.settled_cents), 0) }] };
    }
    if (/FROM clearing_cycle_items i JOIN clearing_cycles c/.test(text)) {
      return {
        rows: items
          .filter(i => !i.released)
          .map(i => ({ ...i, status: (cycles.find(c => c.cycle_id === i.cycle_id) || {}).status }))
          .filter(row => params[0].includes(row.status)),
      };
    }
    if (/SELECT \* FROM clearing_cycles WHERE cycle_id/.test(text)) {
      return { rows: cycles.filter(c => c.cycle_id === params[0]) };
    }
    if (/SELECT cycle_id FROM clearing_cycles WHERE status/.test(text)) {
      return { rows: cycles.filter(c => c.status === params[0]).map(c => ({ cycle_id: c.cycle_id })) };
    }
    if (/SELECT cycle_id FROM clearing_cycles ORDER BY/.test(text)) {
      return { rows: cycles.map(c => ({ cycle_id: c.cycle_id })) };
    }
    if (/SELECT \* FROM clearing_cycle_legs WHERE cycle_id/.test(text)) {
      return { rows: legs.filter(l => l.cycle_id === params[0]) };
    }
    if (/SELECT status FROM clearing_cycle_legs WHERE cycle_id/.test(text)) {
      return { rows: legs.filter(l => l.cycle_id === params[0]).map(l => ({ status: l.status })) };
    }
    if (/SELECT \* FROM clearing_cycle_items WHERE cycle_id/.test(text)) {
      return { rows: items.filter(i => i.cycle_id === params[0]) };
    }
    return { rows: [] };
  };

  vi.spyOn(pool, 'query').mockImplementation(run as any);
  vi.spyOn(pool, 'connect').mockResolvedValue({ query: run, release: () => undefined } as any);
  vi.spyOn(WealthBackOfficeEngine, 'creditQueue').mockResolvedValue({
    asOf: new Date().toISOString(),
    complete: queueErrors.length === 0,
    errors: queueErrors,
    totals: {},
    items: queue,
  } as any);
  vi.spyOn(WealthBackOfficeEngine, 'ensureTables').mockResolvedValue(true as any);
  vi.spyOn(FundingSourceRegistry, 'list').mockResolvedValue([
    {
      sourceType: 'trust_operating',
      sourceId: 'trust:1010',
      accountName: 'Trust Operating Account',
      availableCents,
      eligible: operatingEligible,
      ineligibleReason: operatingEligible ? null : 'The account is frozen',
    },
  ] as any);
  vi.spyOn(MessagingEngine, 'notify').mockResolvedValue({} as any);

  return { cycles, legs, items, pushes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('netting', () => {
  it('collapses several obligations to one counterparty into a single net leg', async () => {
    clearingStore({
      queue: [
        queueItem({ originId: 'VPAY-1', amountCents: 250_000 }),
        queueItem({ originId: 'VPAY-2', amountCents: 100_000, reference: 'INV-78' }),
        queueItem({ originId: 'VPAY-3', amountCents: 34, reference: 'INV-79' }),
      ],
    });

    const candidates = await ClearingNettingEngine.candidates();

    expect(candidates.totals.obligationCount).toBe(3);
    expect(candidates.totals.legCount).toBe(1);
    expect(candidates.totals.creditsAvoided).toBe(2);
    expect(candidates.totals.netCents).toBe(350_034);
    expect(candidates.proposedLegs[0].obligationCount).toBe(3);
  });

  it('never nets across rails: a vendor CCD and a beneficiary PPD stay separate legs', async () => {
    clearingStore({
      queue: [
        queueItem(),
        queueItem({
          origin: 'beneficiary_distribution',
          originId: 'DIST-1',
          disbursementType: 'direct_deposit',
          payeeKey: 'jane-doe',
          counterparty: 'JANE DOE',
          amountCents: 120_000,
        }),
      ],
    });

    const candidates = await ClearingNettingEngine.candidates();

    expect(candidates.totals.legCount).toBe(2);
    expect(candidates.proposedLegs.map((leg: any) => leg.disbursementType).sort())
      .toEqual(['direct_deposit', 'vendor_payout']);
  });

  it('never nets across currencies', async () => {
    clearingStore({
      queue: [queueItem(), queueItem({ originId: 'VPAY-EUR', currency: 'EUR' })],
    });

    const candidates = await ClearingNettingEngine.candidates();

    expect(candidates.totals.legCount).toBe(2);
  });

  it('takes only what the back office says is pushable', async () => {
    clearingStore({
      queue: [
        queueItem(),
        queueItem({ originId: 'VPAY-BLOCKED', pushable: false, blockers: ['not a registered vendor_payout payee'] }),
      ],
    });

    const candidates = await ClearingNettingEngine.candidates();

    expect(candidates.totals.obligationCount).toBe(1);
    expect(candidates.eligible[0].originId).toBe('VPAY-1');
  });

  it('leaves a USDC payable out, since a cash-funded cycle cannot net tokens', async () => {
    clearingStore({
      queue: [
        queueItem(),
        queueItem({
          originId: 'VPAY-9',
          disbursementType: 'stablecoin_payout',
          payeeKey: 'db-net-mgmt',
          counterparty: 'DB NET MGMT',
          amountCents: 34,
        }),
      ],
    });

    const candidates = await ClearingNettingEngine.candidates();

    expect(candidates.eligible.map((item: any) => item.originId)).toEqual(['VPAY-1']);
    expect(candidates.excluded[0]).toMatchObject({ originId: 'VPAY-9' });
    expect(candidates.excluded[0].reason).toMatch(/Payable in USDC/);
  });

  it('says so when a desk could not be read, so an incomplete set is not funded as if it were whole', async () => {
    clearingStore({ queueErrors: [{ origin: 'vendor_payable', error: 'relation does not exist' }] });

    const candidates = await ClearingNettingEngine.candidates();

    expect(candidates.note).toMatch(/incomplete/);
  });
});

describe('opening a cycle', () => {
  it('binds its obligations and reports the credits it avoided', async () => {
    const store = clearingStore({
      queue: [queueItem({ originId: 'VPAY-1' }), queueItem({ originId: 'VPAY-2', amountCents: 50_000 })],
    });

    const cycle = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });

    expect(cycle.status).toBe('netted');
    expect(cycle.valueDate).toBe(TODAY);
    expect(cycle.legs).toHaveLength(1);
    expect(cycle.legs[0].netCents).toBe(300_000);
    expect(cycle.obligationCount).toBe(2);
    expect(cycle.creditsAvoided).toBe(1);
    expect(store.items).toHaveLength(2);
    expect(cycle.nextStep).toMatch(/Fund the cycle/);
  });

  it('refuses without a named operator', async () => {
    clearingStore();
    await expect(ClearingNettingEngine.openCycle({})).rejects.toThrow(/openedBy is required/);
  });

  it('refuses when nothing is eligible rather than opening an empty cycle', async () => {
    clearingStore({ queue: [] });
    await expect(ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' }))
      .rejects.toThrow(/No unclaimed USD obligation is eligible/);
  });

  it('leaves an obligation claimed by a live cycle out of the next one', async () => {
    clearingStore({ queue: [queueItem()] });
    await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });

    const candidates = await ClearingNettingEngine.candidates();

    expect(candidates.eligible).toHaveLength(0);
    expect(candidates.excluded[0].reason).toMatch(/Already bound to clearing cycle CYC-/);
  });

  it('can be limited to chosen origins', async () => {
    clearingStore({
      queue: [
        queueItem(),
        queueItem({ origin: 'beneficiary_distribution', originId: 'DIST-1', disbursementType: 'direct_deposit', payeeKey: 'jane-doe', counterparty: 'JANE DOE' }),
      ],
    });

    const cycle = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com', origins: ['vendor_payable'] });

    expect(cycle.legs).toHaveLength(1);
    expect(cycle.legs[0].disbursementType).toBe('vendor_payout');
  });
});

describe('funding a cycle', () => {
  it('funds against the operating account and records who decided', async () => {
    clearingStore({ availableCents: 500_000 });
    const opened = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });

    const funded = await ClearingNettingEngine.fundCycle({ cycleId: opened.cycleId, fundedBy: 'ops@example.com' });

    expect(funded.status).toBe('funded');
    expect(funded.fundingSource).toBe('trust:1010');
    expect(funded.fundedBy).toBe('ops@example.com');
  });

  it('refuses when the net exceeds what the operating account holds', async () => {
    clearingStore({ availableCents: 100 });
    const opened = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });

    await expect(ClearingNettingEngine.fundCycle({ cycleId: opened.cycleId, fundedBy: 'ops@example.com' }))
      .rejects.toThrow(/spendable/);
  });

  it('will not let a second cycle spend the first cycle\'s dollars', async () => {
    clearingStore({ availableCents: 300_000, queue: [queueItem({ originId: 'VPAY-1' })] });
    const first = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });
    await ClearingNettingEngine.fundCycle({ cycleId: first.cycleId, fundedBy: 'ops@example.com' });

    const funding = await ClearingNettingEngine.funding();

    expect(funding.committedCents).toBe(250_000);
    expect(funding.spendableCents).toBe(50_000);
  });

  it('refuses when the operating account itself is not eligible to fund', async () => {
    clearingStore({ operatingEligible: false });
    const opened = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });

    await expect(ClearingNettingEngine.fundCycle({ cycleId: opened.cycleId, fundedBy: 'ops@example.com' }))
      .rejects.toThrow(/The account is frozen/);
  });

  it('refuses to fund a cycle that is not netted', async () => {
    clearingStore();
    const opened = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });
    await ClearingNettingEngine.fundCycle({ cycleId: opened.cycleId, fundedBy: 'ops@example.com' });

    await expect(ClearingNettingEngine.fundCycle({ cycleId: opened.cycleId, fundedBy: 'ops@example.com' }))
      .rejects.toThrow(/is funded and cannot move to funded/);
  });
});

describe('settling a cycle', () => {
  async function fundedCycle(options: any = {}) {
    const store = clearingStore(options);
    const opened = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });
    await ClearingNettingEngine.fundCycle({ cycleId: opened.cycleId, fundedBy: 'ops@example.com' });
    return { store, cycleId: opened.cycleId };
  }

  it('hands one net credit per leg to Payer OS and records it against every obligation in the leg', async () => {
    const { store, cycleId } = await fundedCycle({
      queue: [queueItem({ originId: 'VPAY-1' }), queueItem({ originId: 'VPAY-2', amountCents: 50_000 })],
    });
    const initiate = vi.spyOn(PayerOsEngine, 'initiate').mockResolvedValue({
      disbursement: { disbursement_id: 'PAY-1', status: 'pending_approval' },
    } as any);
    vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({ status: 'pending_approval' } as any);

    const result = await ClearingNettingEngine.settleCycle({ cycleId, initiatedBy: 'trustee-one@example.com' });

    expect(initiate).toHaveBeenCalledTimes(1);
    expect(initiate.mock.calls[0][0]).toMatchObject({
      disbursementType: 'vendor_payout',
      amountCents: 300_000,
      payee: 'acme',
      initiatedBy: 'trustee-one@example.com',
    });
    expect(result.cycle.status).toBe('settling');
    expect(store.pushes.map((push: any) => push.origin_id).sort()).toEqual(['VPAY-1', 'VPAY-2']);
    expect(store.pushes.every((push: any) => push.disbursement_id === 'PAY-1')).toBe(true);
  });

  it('stops at pending_approval: it never approves, sends or settles the credit itself', async () => {
    const { cycleId } = await fundedCycle();
    vi.spyOn(PayerOsEngine, 'initiate').mockResolvedValue({
      disbursement: { disbursement_id: 'PAY-1', status: 'pending_approval' },
    } as any);
    const approve = vi.spyOn(PayerOsEngine, 'approve');
    const send = vi.spyOn(PayerOsEngine, 'send');
    const settle = vi.spyOn(PayerOsEngine, 'settle');
    vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({ status: 'pending_approval' } as any);

    await ClearingNettingEngine.settleCycle({ cycleId, initiatedBy: 'trustee-one@example.com' });

    expect(approve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('records a leg Payer OS refused with its reason instead of dropping it', async () => {
    const { cycleId } = await fundedCycle();
    vi.spyOn(PayerOsEngine, 'initiate').mockRejectedValue(new Error('no ACH transmission channel is configured'));

    const result = await ClearingNettingEngine.settleCycle({ cycleId, initiatedBy: 'trustee-one@example.com' });

    expect(result.legs[0].status).toBe('failed');
    expect(result.legs[0].error).toMatch(/no ACH transmission channel/);
    expect(result.cycle.legs[0].failureReason).toMatch(/no ACH transmission channel/);
  });

  it('refuses to settle a cycle that was never funded', async () => {
    clearingStore();
    const opened = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });

    await expect(ClearingNettingEngine.settleCycle({ cycleId: opened.cycleId, initiatedBy: 'trustee-one@example.com' }))
      .rejects.toThrow(/is netted and cannot move to settling/);
  });

  it('reports partially_settled rather than calling a half-settled cycle done', async () => {
    const { cycleId } = await fundedCycle({
      queue: [
        queueItem({ originId: 'VPAY-1' }),
        queueItem({ origin: 'beneficiary_distribution', originId: 'DIST-1', disbursementType: 'direct_deposit', payeeKey: 'jane-doe', counterparty: 'JANE DOE', amountCents: 120_000 }),
      ],
    });
    let issued = 0;
    vi.spyOn(PayerOsEngine, 'initiate').mockImplementation(async () => {
      issued += 1;
      return { disbursement: { disbursement_id: `PAY-${issued}`, status: 'pending_approval' } } as any;
    });
    vi.spyOn(PayerOsEngine, 'get').mockImplementation(async (id: any) => (
      id === 'PAY-1' ? { status: 'settled' } : { status: 'pending_approval' }
    ) as any);

    const result = await ClearingNettingEngine.settleCycle({ cycleId, initiatedBy: 'trustee-one@example.com' });

    expect(result.cycle.status).toBe('partially_settled');
    expect(result.cycle.settledCents).toBe(250_000);
    expect(result.cycle.nextStep).toMatch(/Chase the legs that did not settle/);
  });

  it('settles the cycle only when every leg settled', async () => {
    const { cycleId } = await fundedCycle();
    vi.spyOn(PayerOsEngine, 'initiate').mockResolvedValue({
      disbursement: { disbursement_id: 'PAY-1', status: 'pending_approval' },
    } as any);
    vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({ status: 'settled' } as any);

    const result = await ClearingNettingEngine.settleCycle({ cycleId, initiatedBy: 'trustee-one@example.com' });

    expect(result.cycle.status).toBe('settled');
    expect(result.cycle.settledCents).toBe(250_000);
  });

  it('marks a leg failed when its disbursement ends in another terminal state', async () => {
    const { cycleId } = await fundedCycle();
    vi.spyOn(PayerOsEngine, 'initiate').mockResolvedValue({
      disbursement: { disbursement_id: 'PAY-1', status: 'pending_approval' },
    } as any);
    vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({ status: 'returned' } as any);

    const result = await ClearingNettingEngine.settleCycle({ cycleId, initiatedBy: 'trustee-one@example.com' });

    expect(result.cycle.legs[0].status).toBe('failed');
    expect(result.cycle.legs[0].failureReason).toMatch(/ended returned/);
  });
});

describe('cancelling a cycle', () => {
  it('releases obligations that never reached Payer OS back to the queue', async () => {
    const store = clearingStore();
    const opened = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });

    const result = await ClearingNettingEngine.cancelCycle({ cycleId: opened.cycleId, cancelledBy: 'ops@example.com', reason: 'wrong value date' });

    expect(result.cycle.status).toBe('cancelled');
    expect(result).toMatchObject({ releasedLegs: 1, releasedObligations: 1 });
    expect(store.items.every((item: any) => item.released)).toBe(true);
    const candidates = await ClearingNettingEngine.candidates();
    expect(candidates.eligible).toHaveLength(1);
  });

  it('keeps a leg whose credit is already with Payer OS instead of un-promising it', async () => {
    clearingStore();
    const opened = await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });
    await ClearingNettingEngine.fundCycle({ cycleId: opened.cycleId, fundedBy: 'ops@example.com' });
    vi.spyOn(PayerOsEngine, 'initiate').mockResolvedValue({
      disbursement: { disbursement_id: 'PAY-1', status: 'pending_approval' },
    } as any);
    vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({ status: 'pending_approval' } as any);
    await ClearingNettingEngine.settleCycle({ cycleId: opened.cycleId, initiatedBy: 'trustee-one@example.com' });

    const result = await ClearingNettingEngine.cancelCycle({ cycleId: opened.cycleId, cancelledBy: 'ops@example.com' });

    expect(result.cycle.status).not.toBe('cancelled');
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0].disbursementId).toBe('PAY-1');
  });
});

describe('the clearing runbook', () => {
  it('chases a cycle that is netted but never funded', async () => {
    clearingStore();
    await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });

    const runbook = await ClearingNettingEngine.runbook();

    expect(runbook.liveCycles).toBe(1);
    expect(runbook.actions.join(' ')).toMatch(/is not funded yet/);
    expect(runbook.clean).toBe(false);
  });

  it('reports a break when live cycles commit more than the account holds', async () => {
    clearingStore({ availableCents: 300_000, queue: [queueItem({ amountCents: 250_000 })] });
    await ClearingNettingEngine.openCycle({ openedBy: 'ops@example.com' });
    // The account is drawn down elsewhere after the cycle was netted.
    vi.spyOn(FundingSourceRegistry, 'list').mockResolvedValue([{
      sourceType: 'trust_operating',
      sourceId: 'trust:1010',
      accountName: 'Trust Operating Account',
      availableCents: 100_000,
      eligible: true,
      ineligibleReason: null,
    }] as any);

    const runbook = await ClearingNettingEngine.runbook();

    expect(runbook.breaks.join(' ')).toMatch(/a cycle will fail funding until one settles/);
  });

  it('is clean when there is no live cycle', async () => {
    clearingStore({ queue: [] });

    const runbook = await ClearingNettingEngine.runbook();

    expect(runbook.liveCycles).toBe(0);
    expect(runbook.clean).toBe(true);
  });
});

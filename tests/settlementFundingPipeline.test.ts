import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  SettlementFundingEngine,
  settlementEvidence,
} = require('../server/integrations/inhouseBank/settlementFundingEngine');
const { WireEngine } = require('../server/integrations/wire/wireEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { ComplianceEngine } = require('../server/integrations/compliance/complianceEngine');
const { FraudComplianceOsEngine } = require('../server/integrations/os/fraudComplianceOsEngine');
const { runPipeline, advancePipeline } = require('../server/scripts/fundingPipeline');
const pool = require('../server/integrations/bonds/pgPool');

function fundingWire(overrides: any = {}) {
  return {
    wire_id: 'WIRE-F1',
    payment_type: 'settlement_funding',
    status: 'pending_approval',
    amount_cents: 2_500_000,
    beneficiary_name: 'DLB TRUST',
    beneficiary_routing: '121145307',
    beneficiary_account: '692101092959',
    initiated_by: 'trustee-one',
    approved_by: null,
    journal_entry_id: null,
    ...overrides,
    metadata: {
      fundingSource: { sourceType: 'trust_operating', sourceKey: 'trust:1010', sourceId: '1010' },
      glDebitAccountCode: '1050',
      glCreditAccountCode: '1010',
      approvalRef: 'APR-1',
      screeningRef: 'FCS-1',
      ...(overrides.metadata || {}),
    },
  };
}

function fakeClient() {
  const calls: any[] = [];
  return {
    calls,
    client: {
      async query(sql: string, params: any[]) {
        calls.push({ sql, params });
        if (sql.includes('FOR UPDATE')) return { rows: [fundingWire()] };
        return { rows: [] };
      },
      release() {},
    },
  };
}

describe('settlement funding — committed, not settled', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.SETTLEMENT_FUNDING_IN_TRANSIT_GL_ACCOUNT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  describe('the in-transit commitment', () => {
    it('posts DR in-transit / CR operating through postJournalEntry and points settlement at in-transit', async () => {
      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire());
      vi.spyOn(TrustAccountingEngine, 'getAccount').mockImplementation(async (code: string) => (
        code === '1010'
          ? { account_code: '1010', account_name: 'Trust Checking', account_type: 'asset', balance: '50000.00', funding_eligible: true }
          : { account_code: code, account_name: 'Settlement Funding In Transit', account_type: 'asset', sub_type: 'other', balance: '0', funding_eligible: false }
      ));
      vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as any);
      const { calls, client } = fakeClient();
      vi.spyOn(pool, 'connect').mockResolvedValue(client as any);
      const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-COMMIT' } as any);

      const result = await SettlementFundingEngine.commitInTransit('WIRE-F1', { committedBy: 'trustee-one' });

      expect(result).toMatchObject({ applied: true, entryId: 'JRN-COMMIT', debitAccountCode: '1015', creditAccountCode: '1010' });
      const entry = post.mock.calls[0][0] as any;
      expect(entry).toMatchObject({ referenceType: 'settlement_funding_commit', referenceId: 'WIRE-F1', postToFineract: false, transactionClient: client });
      expect(entry.lines).toEqual([
        expect.objectContaining({ accountCode: '1015', debitAmount: 25000, creditAmount: 0 }),
        expect.objectContaining({ accountCode: '1010', debitAmount: 0, creditAmount: 25000 }),
      ]);
      const update = calls.find((c) => c.sql.includes('UPDATE wire_transfers'));
      expect(JSON.parse(update.params[1])).toMatchObject({
        glCreditAccountCode: '1015',
        inTransit: { entryId: 'JRN-COMMIT', glAccountCode: '1015', sourceAccountCode: '1010' },
      });
      expect(calls.some((c) => /UPDATE trust_accounts SET balance/.test(c.sql))).toBe(false);
      expect(calls.map((c) => c.sql)).toContain('COMMIT');
    });

    it('previews without posting unless applied', async () => {
      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire());
      vi.spyOn(TrustAccountingEngine, 'getAccount').mockResolvedValue({ account_code: '1010', account_name: 'Trust Checking', account_type: 'asset', balance: '50000.00' } as any);
      const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry');
      const result = await SettlementFundingEngine.commitInTransit('WIRE-F1', { apply: false });
      expect(result).toMatchObject({ applied: false, amount: '25000.00', debitAccountCode: '1015', creditAccountCode: '1010' });
      expect(post).not.toHaveBeenCalled();
    });

    it('is idempotent once committed', async () => {
      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire({ metadata: { inTransit: { entryId: 'JRN-OLD' } } }));
      const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry');
      const result = await SettlementFundingEngine.commitInTransit('WIRE-F1');
      expect(result).toMatchObject({ alreadyCommitted: true, entryId: 'JRN-OLD', applied: false });
      expect(post).not.toHaveBeenCalled();
    });

    it('refuses a wire that is not in flight, or more than the operating account holds', async () => {
      vi.spyOn(WireEngine, 'getWire').mockResolvedValueOnce(fundingWire({ status: 'settled' }));
      await expect(SettlementFundingEngine.commitInTransit('WIRE-F1')).rejects.toThrowError(/only an in-flight wire/);

      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire());
      vi.spyOn(TrustAccountingEngine, 'getAccount').mockResolvedValue({ account_code: '1010', account_name: 'Trust Checking', account_type: 'asset', balance: '100.00' } as any);
      await expect(SettlementFundingEngine.commitInTransit('WIRE-F1')).rejects.toThrowError(/holds 100\.00/);
    });

    it('refuses a spendable account as the in-transit account', async () => {
      vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as any);
      vi.spyOn(TrustAccountingEngine, 'getAccount').mockResolvedValue({ account_code: '1015', account_type: 'asset', sub_type: 'cash', funding_eligible: true } as any);
      await expect(SettlementFundingEngine.ensureInTransitAccount()).rejects.toThrowError(/classified as spendable/);
    });

    it('releases a cancelled wire back to operating, and never a settled one', async () => {
      const committed = { inTransit: { entryId: 'JRN-COMMIT', glAccountCode: '1015', sourceAccountCode: '1010' }, glCreditAccountCode: '1015' };
      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire({ status: 'settled', journal_entry_id: 'JRN-S', metadata: committed }));
      await expect(SettlementFundingEngine.releaseInTransit('WIRE-F1')).rejects.toThrowError(/settled/);

      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire({ status: 'sent', metadata: committed }));
      await expect(SettlementFundingEngine.releaseInTransit('WIRE-F1')).rejects.toThrowError(/may still settle/);

      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire({ status: 'cancelled', metadata: committed }));
      const { client } = fakeClient();
      vi.spyOn(pool, 'connect').mockResolvedValue(client as any);
      const post = vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-REL' } as any);
      const result = await SettlementFundingEngine.releaseInTransit('WIRE-F1', { releasedBy: 'trustee-one' });
      expect(result).toMatchObject({ released: true, entryId: 'JRN-REL' });
      expect((post.mock.calls[0][0] as any).lines).toEqual([
        expect.objectContaining({ accountCode: '1010', debitAmount: 25000 }),
        expect.objectContaining({ accountCode: '1015', creditAmount: 25000 }),
      ]);
    });
  });

  describe('bank evidence', () => {
    it('counts only a provider reference whose status says settled', () => {
      expect(settlementEvidence({ metadata: { externalProviderReference: 'P-1', externalProviderStatus: 'accepted' } })).toBeNull();
      expect(settlementEvidence({ metadata: {} })).toBeNull();
      expect(settlementEvidence({ metadata: { providerConfirmationReference: 'FED-9', providerConfirmationStatus: 'Settled' } }))
        .toEqual({ reference: 'FED-9', providerStatus: 'settled' });
    });
  });

  describe('AML / OFAC screening', () => {
    beforeEach(() => {
      process.env.FRAUD_COMPLIANCE_ENABLED = 'true';
      process.env.FRAUD_COMPLIANCE_LIVE = 'true';
    });

    it('requires a live FCS- screening', async () => {
      await expect(SettlementFundingEngine.verifyScreeningFor({ amountCents: 1 })).rejects.toThrowError(/screeningRef is required/);
      await expect(SettlementFundingEngine.verifyScreeningFor({ screeningRef: 'COMP-1', amountCents: 1 })).rejects.toThrowError(/not a Fraud & Compliance OS/);
      process.env.FRAUD_COMPLIANCE_LIVE = 'false';
      await expect(SettlementFundingEngine.verifyScreeningFor({ screeningRef: 'FCS-1', amountCents: 1 })).rejects.toThrowError(/shadow screening/);
    });

    it('refuses when the sanctions list is not ready', async () => {
      vi.spyOn(ComplianceEngine, 'assertPaymentReady').mockRejectedValue(new Error('Compliance provider is not ready: OpenSanctions data is missing'));
      const verify = vi.spyOn(FraudComplianceOsEngine, 'verify');
      await expect(SettlementFundingEngine.verifyScreeningFor({ screeningRef: 'FCS-1', amountCents: 1 })).rejects.toThrowError(/OpenSanctions/);
      expect(verify).not.toHaveBeenCalled();
    });

    it('binds the screening to the wire amount and payee, and consumes it at send', async () => {
      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire({ status: 'approved' }));
      vi.spyOn(ComplianceEngine, 'assertPaymentReady').mockResolvedValue({ ready: true } as any);
      const verify = vi.spyOn(FraudComplianceOsEngine, 'verify').mockResolvedValue({ screeningRef: 'FCS-1', status: 'consumed' } as any);
      const sendWire = vi.spyOn(WireEngine, 'sendWire').mockResolvedValue({ status: 'sent' } as any);

      await SettlementFundingEngine.sendScreened('WIRE-F1');
      expect(verify).toHaveBeenCalledWith({
        screeningRef: 'FCS-1',
        amountCents: 2_500_000,
        payee: { name: 'DLB TRUST', routingNumber: '121145307', accountNumber: '692101092959' },
        requireLive: true,
        consume: true,
        consumer: 'settlement_funding:WIRE-F1',
      });
      expect(sendWire).toHaveBeenCalledWith('WIRE-F1');
    });

    it('will not send a wire without an approvalRef', async () => {
      vi.spyOn(WireEngine, 'getWire').mockResolvedValue(fundingWire({ status: 'approved', metadata: { approvalRef: undefined } }));
      const sendWire = vi.spyOn(WireEngine, 'sendWire');
      await expect(SettlementFundingEngine.sendScreened('WIRE-F1')).rejects.toThrowError(/no approvalRef/);
      expect(sendWire).not.toHaveBeenCalled();
    });
  });
});

describe('settlement funding pipeline', () => {
  function harness({ drift = [], evidence = null as any, readinessReady = true } = {}) {
    let wire: any = null;
    const calls: string[] = [];
    const engine = {
      PAYMENT_TYPE: 'settlement_funding',
      inTransitAccountCode: () => '1015',
      config: () => ({ fundingSourceRef: 'operating' }),
      destination: () => ({ key: 'melio', glAccountCode: '1050', beneficiaryName: 'DLB TRUST', routingNumber: '121145307', accountNumber: '692101092959' }),
      readiness: async () => ({ ready: readinessReady, blockers: readinessReady ? [] : ['compliance: FRAUD_COMPLIANCE_LIVE not true'] }),
      plan: async ({ amountCents }: any) => ({
        amountCents, amount: (amountCents / 100).toFixed(2), available: '50000.00', inFlight: '0.00', spendable: '50000.00', funded: true,
        source: { sourceId: '1010', accountName: 'Trust Checking', debtorName: 'DLB TRUST' },
        destination: { key: 'melio', accountLast4: '2959', beneficiaryName: 'DLB TRUST', routingNumber: '121145307', accountNumber: '692101092959' },
      }),
      verifyScreeningFor: vi.fn(async () => ({ status: 'clear' })),
      verifyScreening: vi.fn(async () => ({ status: 'clear' })),
      initiate: vi.fn(async (opts: any) => {
        calls.push('initiate');
        wire = fundingWire({ metadata: { approvalRef: opts.approvalRef, screeningRef: opts.screeningRef } });
        return { wire };
      }),
      commitInTransit: vi.fn(async () => {
        calls.push('commit');
        wire = { ...wire, metadata: { ...wire.metadata, glCreditAccountCode: '1015', inTransit: { entryId: 'JRN-C', sourceAccountCode: '1010' } } };
        return { wire, entryId: 'JRN-C', debitAccountCode: '1015', creditAccountCode: '1010', amount: '25000.00' };
      }),
      approve: vi.fn(async (_id: string, checker: string) => { calls.push('approve'); wire = { ...wire, status: 'approved', approved_by: checker }; return wire; }),
      sendScreened: vi.fn(async () => {
        calls.push('send');
        wire = { ...wire, status: 'sent', metadata: { ...wire.metadata, ...(evidence || {}) } };
        return wire;
      }),
      confirm: vi.fn(async () => { calls.push('confirm'); wire = { ...wire, status: 'confirmed' }; return wire; }),
      settle: vi.fn(async () => { calls.push('settle'); wire = { ...wire, status: 'settled', journal_entry_id: 'JRN-S' }; return wire; }),
      releaseInTransit: vi.fn(),
      get: async () => wire,
      list: async ({ status }: any) => (wire && wire.status === status ? [wire] : []),
    };
    const deps = {
      engine,
      wires: { getWire: async () => wire },
      reconcile: vi.fn(async () => ({ drift, balances: [] })),
      sleep: vi.fn(async () => {}),
      log: () => {},
    };
    return { deps, engine, calls, setWire: (w: any) => { wire = w; } };
  }

  const NEW = { amountCents: 2_500_000, maker: 'trustee-one', checker: 'trustee-two', approvalRef: 'APR-1', screeningRef: 'FCS-1' };

  it('chains ledger check, plan, screening, maker, commit, checker, send and settles on the bank reference', async () => {
    const { deps, engine, calls } = harness({ evidence: { externalProviderReference: 'FED-1', externalProviderStatus: 'completed' } });
    const result = await runPipeline({ ...NEW, yes: true }, deps);
    expect(result.status).toBe('settled');
    expect(calls).toEqual(['initiate', 'commit', 'approve', 'send', 'confirm', 'settle']);
    expect(engine.verifyScreeningFor).toHaveBeenCalledWith(expect.objectContaining({ screeningRef: 'FCS-1', amountCents: 2_500_000 }));
    expect(engine.settle).toHaveBeenCalledWith('WIRE-F1', expect.objectContaining({ reference: 'FED-1', providerStatus: 'completed' }));
    expect(deps.reconcile).toHaveBeenCalledWith({ apply: false });
  });

  it('never marks a wire settled without the bank\'s reference', async () => {
    const { deps, engine } = harness();
    const result = await runPipeline({ ...NEW, yes: true, timeoutSeconds: 60, pollSeconds: 30 }, deps);
    expect(result).toMatchObject({ status: 'waiting', stoppedAt: 'bank_reference', exitCode: 3 });
    expect(engine.confirm).not.toHaveBeenCalled();
    expect(engine.settle).not.toHaveBeenCalled();
    expect(deps.sleep).toHaveBeenCalled();
  });

  it('refuses a provider status that does not say settled', async () => {
    const { deps, engine, setWire } = harness();
    setWire(fundingWire({ status: 'sent', metadata: { inTransit: { entryId: 'JRN-C' } } }));
    const result = await runPipeline({ wireId: 'WIRE-F1', reference: 'FED-1', providerStatus: 'accepted' }, deps);
    expect(result).toMatchObject({ status: 'stopped', stoppedAt: 'bank_reference' });
    expect(engine.settle).not.toHaveBeenCalled();
  });

  it('keeps maker/checker and the approval and screening references', async () => {
    const { deps, engine } = harness();
    expect(await runPipeline({ ...NEW, checker: 'Trustee-One' }, deps)).toMatchObject({ status: 'stopped', reason: /different trustees/ });
    expect(await runPipeline({ ...NEW, screeningRef: null }, deps)).toMatchObject({ status: 'stopped', reason: /screeningRef/ });
    expect(await runPipeline({ ...NEW, approvalRef: null }, deps)).toMatchObject({ status: 'stopped', reason: /approvalRef/ });
    expect(engine.initiate).not.toHaveBeenCalled();
  });

  it('stops on ledger drift or a closed readiness gate before creating anything', async () => {
    const drifted = harness({ drift: [{ account_code: '1010', drift: 10 }] });
    expect(await runPipeline(NEW, drifted.deps)).toMatchObject({ status: 'stopped', stoppedAt: 'ledger_check' });
    expect(drifted.engine.initiate).not.toHaveBeenCalled();

    const closed = harness({ readinessReady: false });
    expect(await runPipeline(NEW, closed.deps)).toMatchObject({ status: 'stopped', stoppedAt: 'readiness' });
    expect(closed.engine.initiate).not.toHaveBeenCalled();
  });

  it('does not transmit without --yes', async () => {
    const { deps, engine, calls } = harness();
    const result = await runPipeline(NEW, deps);
    expect(result).toMatchObject({ status: 'waiting', stoppedAt: 'send' });
    expect(calls).toEqual(['initiate', 'commit', 'approve']);
    expect(engine.sendScreened).not.toHaveBeenCalled();
  });

  it('advance settles only wires whose bank reference is recorded, and creates nothing', async () => {
    const waiting = harness();
    waiting.setWire(fundingWire({ status: 'sent', metadata: { inTransit: { entryId: 'JRN-C', sourceAccountCode: '1010' } } }));
    const idle = await advancePipeline({}, waiting.deps);
    expect(idle.results).toEqual([{ wireId: 'WIRE-F1', status: 'sent', action: 'awaiting_bank_reference' }]);
    expect(waiting.engine.settle).not.toHaveBeenCalled();

    const ready = harness();
    ready.setWire(fundingWire({ status: 'sent', metadata: { providerConfirmationReference: 'FED-2', providerConfirmationStatus: 'settled' } }));
    const done = await advancePipeline({}, ready.deps);
    expect(done.results[0]).toMatchObject({ action: 'settled', reference: 'FED-2' });
    expect(ready.engine.initiate).not.toHaveBeenCalled();
    expect(ready.engine.sendScreened).not.toHaveBeenCalled();
  });
});

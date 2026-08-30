import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  SettlementFundingEngine,
} = require('../server/integrations/inhouseBank/settlementFundingEngine');
const { FundingSourceRegistry } = require('../server/integrations/inhouseBank/clearing/fundingSourceRegistry');
const { WireEngine } = require('../server/integrations/wire/wireEngine');
const pool = require('../server/integrations/bonds/pgPool');

const MELIO_DDA = {
  label: 'Lili Bank — Melio funding DDA',
  beneficiaryName: 'DLB TRUST',
  bankName: 'Lili Bank',
  routingNumber: '121145307',
  accountNumber: '692101092959',
  glAccountCode: '1050',
};

function operatingSource(availableCents: number) {
  return {
    sourceType: 'trust_operating',
    sourceKey: 'trust:1010',
    sourceId: '1010',
    sourceOfTruth: 'trust_accounting',
    accountName: 'Trust Operating Account',
    debtorName: 'DLB TRUST',
    debtorAccountNumber: '100200300',
    debtorRouting: '021000021',
    currency: 'USD',
    balanceCents: availableCents,
    availableCents,
    eligible: true,
    ineligibleReason: null,
    beneficiary: null,
  };
}

/** The ledger says the operating account holds this much, and no other account is spendable. */
function ledger(availableCents: number) {
  vi.spyOn(FundingSourceRegistry, 'list').mockResolvedValue([operatingSource(availableCents)]);
}

/** Settlement funding wires already promised out of the operating account. */
function inFlight(cents: number) {
  vi.spyOn(WireEngine, 'ensureTables').mockResolvedValue(undefined);
  vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ cents: String(cents) }] } as any);
}

describe('settlement funding — the trust funding its own settlement account', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.SETTLEMENT_FUNDING_DESTINATIONS = JSON.stringify({ melio: MELIO_DDA });
    process.env.CLEARING_FUNDING_OPERATING_ACCOUNT = '1010';
    delete process.env.SETTLEMENT_FUNDING_ROUTING;
    delete process.env.SETTLEMENT_FUNDING_ACCOUNT;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  describe('the credit side is an allowlist', () => {
    it('credits only a registered settlement account', () => {
      expect(() => SettlementFundingEngine.destination('some-other-bank')).toThrowError(
        /is not a registered settlement account/
      );
    });

    it('says so when nothing is registered rather than defaulting to an account', () => {
      delete process.env.SETTLEMENT_FUNDING_DESTINATIONS;
      expect(() => SettlementFundingEngine.destination()).toThrowError(
        /SETTLEMENT_FUNDING_DESTINATIONS is empty/
      );
    });

    it('refuses a destination with no GL account to land the credit in', () => {
      process.env.SETTLEMENT_FUNDING_DESTINATIONS = JSON.stringify({
        melio: { ...MELIO_DDA, glAccountCode: '' },
      });
      expect(() => SettlementFundingEngine.destination('melio')).toThrowError(/needs glAccountCode/);
    });

    it('refuses a destination whose routing number is not an ABA', () => {
      process.env.SETTLEMENT_FUNDING_DESTINATIONS = JSON.stringify({
        melio: { ...MELIO_DDA, routingNumber: '1211453' },
      });
      expect(() => SettlementFundingEngine.destination('melio')).toThrowError(/9-digit ABA/);
    });

    it('takes a single destination from plain variables', () => {
      delete process.env.SETTLEMENT_FUNDING_DESTINATIONS;
      process.env.SETTLEMENT_FUNDING_ROUTING = '121145307';
      process.env.SETTLEMENT_FUNDING_ACCOUNT = '692101092959';
      process.env.SETTLEMENT_FUNDING_GL_ACCOUNT = '1050';
      expect(SettlementFundingEngine.destination()).toMatchObject({
        key: 'melio',
        routingNumber: '121145307',
        accountLast4: '2959',
        glAccountCode: '1050',
      });
    });
  });

  describe('the funding side is the book of record', () => {
    it('reports what is spendable net of wires already in flight', async () => {
      ledger(5_000_000);
      inFlight(1_500_000);
      const plan = await SettlementFundingEngine.plan({ amountCents: 2_500_000 });
      expect(plan).toMatchObject({
        amount: '25000.00',
        available: '50000.00',
        inFlight: '15000.00',
        spendable: '35000.00',
        funded: true,
      });
      expect(plan.source.sourceKey).toBe('trust:1010');
      expect(plan.destination.accountLast4).toBe('2959');
    });

    it('will not promise the same dollars twice', async () => {
      ledger(5_000_000);
      inFlight(4_000_000);
      const plan = await SettlementFundingEngine.plan({ amountCents: 2_000_000 });
      expect(plan).toMatchObject({ funded: false, spendable: '10000.00', shortfallCents: 1_000_000 });

      await expect(
        SettlementFundingEngine.initiate({ amountCents: 2_000_000, initiatedBy: 'trustee-one' })
      ).rejects.toThrowError(/10000\.00 spendable/);
    });

    it('draws on the Trust Operating Account and refuses any other account', async () => {
      ledger(5_000_000);
      inFlight(0);
      await expect(
        SettlementFundingEngine.plan({ amountCents: 100_000, fundingSourceRef: 'reserve:RESERVE-1' })
      ).rejects.toThrowError(/Trust Operating Account or a Beneficiary Trust Account/);
    });

    it('refuses a wire from the funding account to itself', async () => {
      process.env.SETTLEMENT_FUNDING_DESTINATIONS = JSON.stringify({
        melio: { ...MELIO_DDA, glAccountCode: '1010' },
      });
      ledger(5_000_000);
      inFlight(0);
      await expect(SettlementFundingEngine.plan({ amountCents: 100_000 })).rejects.toThrowError(
        /moves no money/
      );
    });

    it('refuses an amount that is not positive whole cents', async () => {
      ledger(5_000_000);
      inFlight(0);
      await expect(SettlementFundingEngine.plan({ amountCents: 0 })).rejects.toThrowError(
        /positive whole number of cents/
      );
      await expect(SettlementFundingEngine.plan({ amountCents: 10.5 })).rejects.toThrowError(
        /positive whole number of cents/
      );
    });
  });

  describe('the wire it makes', () => {
    it('is a dual-control settlement wire that posts the destination against the funding account', async () => {
      ledger(5_000_000);
      inFlight(0);
      const initiateWire = vi
        .spyOn(WireEngine, 'initiateWire')
        .mockImplementation(async (opts: any) => ({ ...opts, wire_id: 'WIRE-TEST-1', status: 'pending_approval' }));

      const { wire } = await SettlementFundingEngine.initiate({
        amountCents: 2_500_000,
        initiatedBy: 'trustee-one',
        memo: 'Fund Melio DDA for August bills',
      });

      expect(wire.wire_id).toBe('WIRE-TEST-1');
      const opts = initiateWire.mock.calls[0][0] as any;
      expect(opts).toMatchObject({
        amountCents: 2_500_000,
        wireType: 'settlement',
        paymentType: 'settlement_funding',
        requiresApproval: true,
        initiatedBy: 'trustee-one',
        description: 'Fund Melio DDA for August bills',
        beneficiaryName: 'DLB TRUST',
        beneficiaryRouting: '121145307',
        beneficiaryAccount: '692101092959',
        beneficiaryBankName: 'Lili Bank',
        senderName: 'DLB TRUST',
      });
      // The trust's own money changing accounts: the DDA gains what 1010 loses.
      expect(opts.metadata).toMatchObject({
        glDebitAccountCode: '1050',
        glCreditAccountCode: '1010',
        settlementFunding: { destination: 'melio', accountLast4: '2959' },
      });
      expect(opts.metadata.fundingSource.sourceKey).toBe('trust:1010');
    });

    it('is made by a named trustee', async () => {
      ledger(5_000_000);
      inFlight(0);
      await expect(SettlementFundingEngine.initiate({ amountCents: 100_000 })).rejects.toThrowError(
        /initiatedBy is required/
      );
    });

    it('will not approve, send or settle a wire that is not a settlement funding wire', async () => {
      vi.spyOn(WireEngine, 'getWire').mockResolvedValue({
        wire_id: 'WIRE-OTHER',
        payment_type: 'vendor_payment',
      } as any);
      const approveWire = vi.spyOn(WireEngine, 'approveWire').mockResolvedValue({} as any);
      const sendWire = vi.spyOn(WireEngine, 'sendWire').mockResolvedValue({} as any);

      await expect(SettlementFundingEngine.approve('WIRE-OTHER', 'trustee-two')).rejects.toThrowError(
        /is a vendor_payment wire/
      );
      await expect(SettlementFundingEngine.send('WIRE-OTHER')).rejects.toThrowError(
        /is a vendor_payment wire/
      );
      expect(approveWire).not.toHaveBeenCalled();
      expect(sendWire).not.toHaveBeenCalled();
    });

    it('hands approval and transmission to the wire engine, which owns dual control', async () => {
      vi.spyOn(WireEngine, 'getWire').mockResolvedValue({
        wire_id: 'WIRE-TEST-1',
        payment_type: 'settlement_funding',
      } as any);
      const approveWire = vi.spyOn(WireEngine, 'approveWire').mockResolvedValue({ status: 'approved' } as any);
      const sendWire = vi.spyOn(WireEngine, 'sendWire').mockResolvedValue({ status: 'sent' } as any);

      await SettlementFundingEngine.approve('WIRE-TEST-1', 'trustee-two');
      await SettlementFundingEngine.send('WIRE-TEST-1');
      expect(approveWire).toHaveBeenCalledWith('WIRE-TEST-1', 'trustee-two');
      expect(sendWire).toHaveBeenCalledWith('WIRE-TEST-1');
    });
  });

  describe('readiness', () => {
    it('treats a missing bank channel as a blocker, so nothing is simulated', async () => {
      delete process.env.PARTNER_BANK_PROVIDER;
      delete process.env.PARTNER_BANK_API_KEY;
      delete process.env.PARTNER_BANK_ACCOUNT_ID;
      ledger(5_000_000);
      inFlight(0);

      const readiness = await SettlementFundingEngine.readiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.partnerBank.ready).toBe(false);
      expect(readiness.blockers.join(' ')).toMatch(/No bank channel can originate the wire/);
      expect(readiness.destinations).toEqual([
        { key: 'melio', label: MELIO_DDA.label, accountLast4: '2959', glAccountCode: '1050' },
      ]);
      expect(readiness.fundingSource).toMatchObject({ sourceKey: 'trust:1010', spendable: '50000.00' });
    });

    it('blocks when no settlement account is registered', async () => {
      delete process.env.SETTLEMENT_FUNDING_DESTINATIONS;
      ledger(5_000_000);
      inFlight(0);
      const readiness = await SettlementFundingEngine.readiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers.join(' ')).toMatch(/No settlement account is registered/);
    });

    it('warns when the operating account holds nothing to wire', async () => {
      ledger(0);
      inFlight(0);
      const readiness = await SettlementFundingEngine.readiness();
      expect(readiness.warnings.join(' ')).toMatch(/holds nothing/);
    });
  });
});

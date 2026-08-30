import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { FundingSourceRegistry } = require('../server/integrations/inhouseBank/clearing/fundingSourceRegistry');
const { SettlementFundingEngine } = require('../server/integrations/inhouseBank/settlementFundingEngine');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const { ACHEngine } = require('../server/integrations/ach/achEngine');
const { SystemSettings } = require('../server/integrations/ach/systemSettings');
const { AS2Partners } = require('../server/integrations/ach/as2Partners');
const { WireEngine } = require('../server/integrations/wire/wireEngine');
const pool = require('../server/integrations/bonds/pgPool');

const PAYEES = {
  'jane-doe': {
    label: 'Jane Doe — payroll',
    purpose: 'direct_deposit',
    name: 'JANE DOE',
    routingNumber: '121145307',
    accountNumber: '9911002233',
    accountType: 'checking',
    glAccountCode: '5200',
  },
  acme: {
    label: 'ACME Plumbing LLC',
    purpose: 'vendor_payout',
    name: 'ACME PLUMBING LLC',
    routingNumber: '021000021',
    accountNumber: '4455667788',
    accountType: 'checking',
    glAccountCode: '5300',
  },
};

const MELIO_DDA = {
  label: 'Lili Bank — Melio funding DDA',
  beneficiaryName: 'DLB TRUST',
  bankName: 'Lili Bank',
  routingNumber: '121145307',
  accountNumber: '692101092959',
  glAccountCode: '1050',
};

const INSERT_COLUMNS = [
  'disbursement_id', 'disbursement_type', 'rail', 'amount_cents', 'currency',
  'payee_key', 'payee_label', 'payee_name', 'payee_routing', 'payee_account_last4',
  'sec_code', 'transaction_code', 'funding_source_key', 'funding_account_id', 'funding_account_name',
  'gl_debit_account', 'gl_credit_account', 'memo', 'initiated_by', 'rail_reference', 'metadata',
];

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

/**
 * The ledger holds this much in the operating account, wires and ACH credits
 * already promised out of it total that much, and every write is captured
 * rather than performed.
 */
function ledger(availableCents: number, { wireInFlight = 0, achInFlight = 0 } = {}) {
  const rows: any[] = [];
  vi.spyOn(FundingSourceRegistry, 'list').mockResolvedValue([operatingSource(availableCents)]);
  vi.spyOn(WireEngine, 'ensureTables').mockResolvedValue(undefined);
  vi.spyOn(PayerOsEngine, 'ensureTables').mockResolvedValue(true);
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/FROM wire_transfers/.test(text)) return { rows: [{ cents: String(wireInFlight) }] } as any;
    if (/SUM\(amount_cents\)/.test(text)) return { rows: [{ cents: String(achInFlight) }] } as any;
    if (/INSERT INTO payer_disbursements/.test(text)) {
      const row: any = { status: 'pending_approval', direction: 'credit' };
      INSERT_COLUMNS.forEach((column, index) => { row[column] = params[index]; });
      rows.push(row);
      return { rows: [row] } as any;
    }
    if (/UPDATE payer_disbursements/.test(text)) {
      return { rows: [{ ...rows[rows.length - 1], status: 'approved' }] } as any;
    }
    return { rows: [] } as any;
  });
  return rows;
}

/** No bank endpoint, no SFTP drop and no AS2 partner: the ACH engine would only write a file. */
function noAchChannel(mode = 'sandbox') {
  vi.spyOn(SystemSettings, 'getMode').mockResolvedValue(mode as any);
  vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue(null as any);
  vi.spyOn(AS2Partners, 'getDefaultPartnerConfig').mockResolvedValue(null as any);
}

function cleared() {
  vi.spyOn(PaymentComplianceGate, 'screenVendorPayment').mockResolvedValue({
    screeningId: 'SCR-1',
    status: 'clear',
    provider: 'local',
  } as any);
}

describe('Payer OS — the trust originating its own payments', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.PAYER_OS_PAYEES = JSON.stringify(PAYEES);
    process.env.SETTLEMENT_FUNDING_DESTINATIONS = JSON.stringify({ melio: MELIO_DDA });
    process.env.CLEARING_FUNDING_OPERATING_ACCOUNT = '1010';
    delete process.env.PAYER_OS_MAX_AMOUNT_CENTS;
    delete process.env.ACH_SFTP_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  describe('it pushes credits and nothing else', () => {
    it('has no entry point for anything but the three credit pushes', async () => {
      for (const attempt of ['ach_debit', 'collection', 'direct_debit', 'refund']) {
        await expect(
          PayerOsEngine.plan({ disbursementType: attempt, amountCents: 1000, payee: 'acme' })
        ).rejects.toThrowError(/pushes credits only/);
      }
    });

    it('credits a checking or savings account only, so a code that debits cannot be registered', () => {
      process.env.PAYER_OS_PAYEES = JSON.stringify({
        acme: { ...PAYEES.acme, accountType: 'loan' },
      });
      expect(() => PayerOsEngine.payee('vendor_payout', 'acme')).toThrowError(
        /credits a checking or savings account only/
      );
    });

    it('gives a vendor payout a CCD credit and a direct deposit a PPD credit, both transaction code 22', async () => {
      ledger(10_000_000);
      const vendor = await PayerOsEngine.plan({
        disbursementType: 'vendor_payout',
        amountCents: 250_000,
        payee: 'acme',
      });
      const payroll = await PayerOsEngine.plan({
        disbursementType: 'direct_deposit',
        amountCents: 120_000,
        payee: 'jane-doe',
      });
      expect(vendor).toMatchObject({ rail: 'ach', direction: 'credit', secCode: 'CCD', transactionCode: '22' });
      expect(payroll).toMatchObject({ rail: 'ach', direction: 'credit', secCode: 'PPD', transactionCode: '22' });
    });
  });

  describe('the payee is an allowlist, never free-form', () => {
    it('refuses a payee that is not registered', () => {
      expect(() => PayerOsEngine.payee('vendor_payout', 'some-other-company')).toThrowError(
        /is not a registered payee/
      );
    });

    it('says so when nothing is registered rather than accepting an account number', () => {
      delete process.env.PAYER_OS_PAYEES;
      expect(() => PayerOsEngine.payee('vendor_payout', 'acme')).toThrowError(/PAYER_OS_PAYEES is empty/);
    });

    it('refuses to name a payee by routing and account number', async () => {
      ledger(10_000_000);
      await expect(
        PayerOsEngine.plan({ disbursementType: 'vendor_payout', amountCents: 1000, payee: null })
      ).rejects.toThrowError(/names a registered payee, never a routing and account number/);
    });

    it('will not pay a payroll payee as a vendor, or a vendor as payroll', () => {
      expect(() => PayerOsEngine.payee('vendor_payout', 'jane-doe')).toThrowError(
        /registered for direct_deposit, so it cannot be paid as a vendor_payout/
      );
      expect(() => PayerOsEngine.payee('direct_deposit', 'acme')).toThrowError(
        /registered for vendor_payout, so it cannot be paid as a direct_deposit/
      );
    });

    it('refuses a payee whose routing number is not an ABA, or that has no GL account', () => {
      process.env.PAYER_OS_PAYEES = JSON.stringify({ acme: { ...PAYEES.acme, routingNumber: '021000022' } });
      expect(() => PayerOsEngine.payee('vendor_payout', 'acme')).toThrowError(/valid 9-digit ABA/);
      process.env.PAYER_OS_PAYEES = JSON.stringify({ acme: { ...PAYEES.acme, glAccountCode: '' } });
      expect(() => PayerOsEngine.payee('vendor_payout', 'acme')).toThrowError(/needs glAccountCode/);
    });

    it('takes settlement accounts from the settlement funding registry, not its own list', () => {
      expect(PayerOsEngine.payees('settlement_funding')).toEqual([
        {
          key: 'melio',
          purpose: 'settlement_funding',
          label: MELIO_DDA.label,
          name: 'DLB TRUST',
          bankName: 'Lili Bank',
          routingNumber: '121145307',
          accountLast4: '2959',
          glAccountCode: '1050',
        },
      ]);
    });

    it('never reports a full account number when listing payees', () => {
      for (const payee of PayerOsEngine.payees()) {
        expect(payee.accountNumber).toBeUndefined();
      }
    });
  });

  describe('the funding side is the book of record', () => {
    it('reports what is spendable net of wires and credits already in flight', async () => {
      ledger(5_000_000, { wireInFlight: 1_000_000, achInFlight: 500_000 });
      const plan = await PayerOsEngine.plan({
        disbursementType: 'vendor_payout',
        amountCents: 2_500_000,
        payee: 'acme',
      });
      expect(plan).toMatchObject({
        amount: '25000.00',
        available: '50000.00',
        inFlight: '15000.00',
        spendable: '35000.00',
        funded: true,
        glDebitAccountCode: '5300',
        glCreditAccountCode: '1010',
      });
      expect(plan.source.sourceKey).toBe('trust:1010');
    });

    it('will not promise the same dollars twice', async () => {
      ledger(5_000_000, { achInFlight: 4_000_000 });
      const plan = await PayerOsEngine.plan({
        disbursementType: 'vendor_payout',
        amountCents: 2_000_000,
        payee: 'acme',
      });
      expect(plan).toMatchObject({ funded: false, spendable: '10000.00', shortfallCents: 1_000_000 });
      await expect(
        PayerOsEngine.initiate({
          disbursementType: 'vendor_payout',
          amountCents: 2_000_000,
          payee: 'acme',
          initiatedBy: 'trustee-one',
        })
      ).rejects.toThrowError(/10000\.00 spendable/);
    });

    it('draws on the Trust Operating Account and refuses any other account', async () => {
      ledger(5_000_000);
      await expect(
        PayerOsEngine.plan({
          disbursementType: 'vendor_payout',
          amountCents: 100_000,
          payee: 'acme',
          fundingSourceRef: 'reserve:RESERVE-1',
        })
      ).rejects.toThrowError(/Trust Operating Account or a Beneficiary Trust Account/);
    });

    it('refuses an amount that is not positive whole cents, or above the ceiling', async () => {
      ledger(5_000_000);
      await expect(
        PayerOsEngine.plan({ disbursementType: 'vendor_payout', amountCents: 0, payee: 'acme' })
      ).rejects.toThrowError(/positive whole number of cents/);
      process.env.PAYER_OS_MAX_AMOUNT_CENTS = '100000';
      await expect(
        PayerOsEngine.plan({ disbursementType: 'vendor_payout', amountCents: 200_000, payee: 'acme' })
      ).rejects.toThrowError(/exceeds the Payer OS ceiling of 1000\.00/);
    });
  });

  describe('the disbursement it raises', () => {
    it('records a screened, dual-control credit and originates nothing yet', async () => {
      const rows = ledger(5_000_000);
      cleared();
      const createBatch = vi.spyOn(ACHEngine, 'createBatch');

      const { disbursement, plan } = await PayerOsEngine.initiate({
        disbursementType: 'vendor_payout',
        amountCents: 250_000,
        payee: 'acme',
        initiatedBy: 'trustee-one',
        memo: 'August plumbing invoice',
      });

      expect(createBatch).not.toHaveBeenCalled();
      expect(plan.funded).toBe(true);
      expect(rows).toHaveLength(1);
      expect(disbursement).toMatchObject({
        disbursement_type: 'vendor_payout',
        rail: 'ach',
        direction: 'credit',
        status: 'pending_approval',
        amount_cents: 250_000,
        payee_key: 'acme',
        payee_name: 'ACME PLUMBING LLC',
        payee_account_last4: '7788',
        sec_code: 'CCD',
        transaction_code: '22',
        funding_source_key: 'trust:1010',
        gl_debit_account: '5300',
        gl_credit_account: '1010',
        initiated_by: 'trustee-one',
        memo: 'August plumbing invoice',
      });
      expect(JSON.parse(disbursement.metadata).screeningId).toBe('SCR-1');
    });

    it('screens the payee before the checker ever sees it', async () => {
      ledger(5_000_000);
      cleared();
      await PayerOsEngine.initiate({
        disbursementType: 'direct_deposit',
        amountCents: 120_000,
        payee: 'jane-doe',
        initiatedBy: 'trustee-one',
      });
      expect(PaymentComplianceGate.screenVendorPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          rail: 'ach',
          action: 'execute',
          amount: 1200,
          vendor: expect.objectContaining({ fullName: 'JANE DOE', routingNumber: '121145307' }),
        })
      );
    });

    it('is made by a named trustee', async () => {
      ledger(5_000_000);
      await expect(
        PayerOsEngine.initiate({ disbursementType: 'vendor_payout', amountCents: 1000, payee: 'acme' })
      ).rejects.toThrowError(/initiatedBy is required/);
    });

    it('hands a settlement funding push to the wire engine under its own dual control', async () => {
      ledger(5_000_000);
      const initiate = vi.spyOn(SettlementFundingEngine, 'initiate').mockResolvedValue({
        wire: { wire_id: 'WIRE-1', status: 'pending_approval' },
        plan: {},
      } as any);

      const result = await PayerOsEngine.initiate({
        disbursementType: 'settlement_funding',
        amountCents: 2_500_000,
        payee: 'melio',
        initiatedBy: 'trustee-one',
      });

      expect(initiate).toHaveBeenCalledWith(
        expect.objectContaining({ amountCents: 2_500_000, destination: 'melio', initiatedBy: 'trustee-one' })
      );
      expect(result.disbursement).toMatchObject({
        rail: 'wire',
        disbursement_type: 'settlement_funding',
        rail_reference: 'WIRE-1',
        gl_debit_account: '1050',
        gl_credit_account: '1010',
      });
    });
  });

  describe('dual control', () => {
    it('refuses the maker as the checker', async () => {
      ledger(5_000_000);
      vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({
        disbursement_id: 'PAYVP-1',
        status: 'pending_approval',
        rail: 'ach',
        initiated_by: 'Trustee-One',
      } as any);
      await expect(PayerOsEngine.approve('PAYVP-1', 'trustee-one')).rejects.toThrowError(
        /cannot approve it/
      );
    });

    it('will not originate a credit that has not been approved', async () => {
      ledger(5_000_000);
      vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({
        disbursement_id: 'PAYVP-1',
        status: 'pending_approval',
        rail: 'ach',
        initiated_by: 'trustee-one',
      } as any);
      const createBatch = vi.spyOn(ACHEngine, 'createBatch');
      await expect(PayerOsEngine.send('PAYVP-1')).rejects.toThrowError(/still needs a second trustee/);
      expect(createBatch).not.toHaveBeenCalled();
    });
  });

  describe('nothing is simulated', () => {
    it('refuses to originate an ACH credit with no bank channel, rather than exporting a file', async () => {
      ledger(5_000_000);
      noAchChannel();
      vi.spyOn(PaymentComplianceGate, 'verifyRecordedScreening').mockResolvedValue({} as any);
      vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({
        disbursement_id: 'PAYVP-1',
        disbursement_type: 'vendor_payout',
        rail: 'ach',
        status: 'approved',
        amount_cents: 250_000,
        payee_key: 'acme',
        funding_source_key: 'trust:1010',
        sec_code: 'CCD',
        initiated_by: 'trustee-one',
        approved_by: 'trustee-two',
        metadata: JSON.stringify({ screeningId: 'SCR-1' }),
      } as any);
      const createBatch = vi.spyOn(ACHEngine, 'createBatch');

      await expect(PayerOsEngine.send('PAYVP-1')).rejects.toThrowError(/No ACH channel can originate/);
      expect(createBatch).not.toHaveBeenCalled();
    });

    it('reports a local file export as no channel at all', async () => {
      noAchChannel('production');
      vi.spyOn(SystemSettings, 'getProductionPartnerConfig').mockResolvedValue({
        partnerId: 'DLBTRUST-DIRECT',
        apiBaseUrl: 'direct',
      } as any);
      const channel = await PayerOsEngine.achChannel();
      expect(channel).toMatchObject({ ready: false });
      expect(channel.reason).toMatch(/local file export/);
    });

    it('accepts the bank NACHA SFTP drop as a channel', async () => {
      process.env.ACH_SFTP_URL = 'sftp://trust@bank.example.com:22/incoming';
      noAchChannel('production');
      expect(await PayerOsEngine.achChannel()).toMatchObject({ ready: true });
    });
  });

  describe('the ledger posts on the bank\'s word', () => {
    it('will not settle without the bank\'s own reference', async () => {
      ledger(5_000_000);
      vi.spyOn(PayerOsEngine, 'get').mockResolvedValue({
        disbursement_id: 'PAYVP-1',
        rail: 'ach',
        status: 'sent',
      } as any);
      await expect(PayerOsEngine.settle('PAYVP-1', {})).rejects.toThrowError(
        /settlement reference from the bank is required/
      );
    });
  });

  describe('readiness', () => {
    it('treats a missing ACH channel as a blocker and lists what it originates', async () => {
      ledger(5_000_000);
      noAchChannel();
      const readiness = await PayerOsEngine.readiness();

      expect(readiness.ready).toBe(false);
      expect(readiness.blockers.join(' ')).toMatch(/ACH credits cannot be originated/);
      expect(readiness.originates.map((entry: any) => entry.disbursementType)).toEqual([
        'settlement_funding', 'direct_deposit', 'vendor_payout',
      ]);
      expect(readiness.originates.every((entry: any) => entry.direction === 'credit')).toBe(true);
      expect(readiness.fundingSource).toMatchObject({ sourceKey: 'trust:1010', spendable: '50000.00' });
    });

    it('warns when no payee is registered instead of inventing one', async () => {
      delete process.env.PAYER_OS_PAYEES;
      ledger(5_000_000);
      noAchChannel();
      const readiness = await PayerOsEngine.readiness();
      expect(readiness.warnings.join(' ')).toMatch(/No direct deposit or vendor payee is registered/);
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CorporateTreasuryEngine } = require('../server/integrations/finops/corporateTreasuryEngine');
const { AttestationOsEngine } = require('../server/integrations/os/attestationOsEngine');

const ledgerAccounts = [
  {
    account_id: 'CT-CUSTODIAN',
    name: 'Custodian reserve',
    category: 'custodian',
    currency: 'USD',
    available_cents: 10_924_000_000,
    balance_cents: 10_924_000_000,
    hold_cents: 0,
    linked_source_type: 'treasury',
    linked_source_id: 'TREASURY_HOT',
    custodian: true,
    issuer: false,
  },
  {
    account_id: 'CT-ISSUER',
    name: 'Issuer backing',
    category: 'issuer',
    currency: 'USD',
    available_cents: 10_924_000_000,
    balance_cents: 10_924_000_000,
    hold_cents: 0,
    linked_source_type: 'treasury',
    linked_source_id: 'TREASURY_HOT',
    custodian: false,
    issuer: true,
  },
  {
    account_id: 'CA-OPERATING',
    name: 'Operating cash',
    category: 'operating',
    currency: 'USD',
    available_cents: 500_000_000,
    balance_cents: 500_000_000,
    hold_cents: 0,
    linked_source_type: 'cash',
    linked_source_id: 'CA-OPERATING',
    custodian: false,
    issuer: false,
  },
];

function mockDashboardData() {
  vi.spyOn(CorporateTreasuryEngine, 'syncBalances').mockResolvedValue({ updated: 0 });
  vi.spyOn(CorporateTreasuryEngine, 'listAccounts').mockResolvedValue(ledgerAccounts);
  vi.spyOn(CorporateTreasuryEngine, 'listCashPools').mockResolvedValue([]);
  vi.spyOn(CorporateTreasuryEngine, 'listCashFlows').mockResolvedValue([]);
  vi.spyOn(CorporateTreasuryEngine, 'listInvestments').mockResolvedValue([]);
  vi.spyOn(CorporateTreasuryEngine, 'listWorkflows').mockResolvedValue([]);
  vi.spyOn(CorporateTreasuryEngine, 'getLiquidityForecast').mockResolvedValue([]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CorporateTreasuryEngine.getDashboard evidence', () => {
  it('does not present internal treasury ledgers as custodian or issuer cash', async () => {
    mockDashboardData();
    vi.spyOn(AttestationOsEngine, 'snapshot').mockResolvedValue({ attestedCents: 0 });

    const dashboard = await CorporateTreasuryEngine.getDashboard();

    expect(dashboard.custodianCashCents).toBe(0);
    expect(dashboard.issuerCashCents).toBe(0);
    expect(dashboard.custodianLedgerCents).toBe(10_924_000_000);
    expect(dashboard.issuerLedgerCents).toBe(10_924_000_000);
    expect(dashboard.ledgerCashCents).toBe(22_348_000_000);
    expect(dashboard.externalCashCents).toBe(0);
    expect(dashboard.attestedCustodyCents).toBe(0);
    expect(dashboard.ptcReserveRatioBps).toBe(0);
    expect(dashboard.accounts.every((a) => a.evidence === 'internal_ledger')).toBe(true);
  });

  it('compares outside-custodian attestation against issuer ledger backing', async () => {
    mockDashboardData();
    vi.spyOn(AttestationOsEngine, 'snapshot').mockResolvedValue({ attestedCents: 5_000_000_000 });

    const dashboard = await CorporateTreasuryEngine.getDashboard();

    expect(dashboard.attestedCustodyCents).toBe(5_000_000_000);
    expect(dashboard.ptcReserveRatioBps).toBe(4577);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ReserveEngine, ReserveShortfallError } = require('../server/integrations/finops/reserveEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

interface FakeState {
  attestations: Row[];
  accounts: Row[];
  movements: Row[];
}

/**
 * In-memory stand-in for reserve_attestations, cash_accounts and cash_movements.
 * Only the statements the engine issues are recognised.
 */
function fakeDb(state: FakeState) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/i.test(text)) return { rows: [] };

    if (text.startsWith('INSERT INTO reserve_attestations')) {
      const row = {
        attestation_id: params[0],
        source_type: params[1],
        source_key: params[2],
        asset: params[3],
        balance_cents: params[4],
        verification: params[5],
        unverified_reason: params[6],
        evidence_reference: params[7],
        attested_by: params[8],
        detail: params[9],
        observed_at: new Date().toISOString(),
      };
      state.attestations.push(row);
      return { rows: [row] };
    }

    if (text.includes('FROM reserve_attestations')) {
      const latest = new Map<string, Row>();
      for (const row of state.attestations) {
        latest.set(`${row.source_type}:${row.source_key}`, row);
      }
      return { rows: Array.from(latest.values()) };
    }

    if (text.includes('SUM(balance_cents)') && text.includes('cash_accounts')) {
      const total = state.accounts
        .filter((a) => a.status === 'active')
        .reduce((sum, a) => sum + Number(a.balance_cents), 0);
      return { rows: [{ total }] };
    }

    if (text.startsWith('SELECT * FROM cash_accounts')) {
      return { rows: state.accounts.filter((a) => a.account_id === params[0]) };
    }

    if (text.includes('FROM cash_movements')) {
      return { rows: state.movements.filter((m) => m.to_account_id === params[0]) };
    }

    return { rows: [] };
  });
}

function account(accountId: string, balanceCents: number) {
  return { account_id: accountId, account_name: accountId, balance_cents: balanceCents, status: 'active' };
}

function movement(fields: Partial<Row>) {
  return {
    movement_id: `MOV-${Math.random().toString(36).slice(2, 8)}`,
    from_account_id: null,
    to_account_id: null,
    amount_cents: 0,
    reference_type: null,
    memo: null,
    ...fields,
  };
}

const ENV_KEYS = [
  'RESERVE_ENFORCEMENT',
  'RESERVE_EXTERNAL_ORIGINS',
  'RESERVE_LIVE_TTL_HOURS',
  'RESERVE_STATEMENT_TTL_HOURS',
  'DAPP_OPERATOR_ADDRESS',
  'CIRCLE_ENABLED',
  'CIRCLE_MINT_API_KEY',
  'PARTNER_BANK_PROVIDER',
  'PARTNER_BANK_API_KEY',
  'PARTNER_BANK_ACCOUNT_ID',
];

describe('core bank reserve engine', () => {
  let state: FakeState;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    state = { attestations: [], accounts: [], movements: [] };
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(pool, 'query').mockImplementation(fakeDb(state) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('attestations', () => {
    it('refuses an unsupported source and a source without a key', async () => {
      await expect(ReserveEngine.record({ sourceType: 'canonical_ledger', sourceKey: 'CA-OPERATING' }))
        .rejects.toThrow(/Unsupported reserve source type/);
      await expect(ReserveEngine.record({ sourceType: 'partner_bank', sourceKey: '  ' }))
        .rejects.toThrow(/requires a source key/);
    });

    it('refuses a statement without evidence or an attester', async () => {
      const base = { sourceType: 'depository_account', sourceKey: 'Betterment Trust Checking', verification: 'statement', balanceCents: 100000 };
      await expect(ReserveEngine.record(base)).rejects.toThrow(/evidence reference/);
      await expect(ReserveEngine.record({ ...base, evidenceReference: 'STMT-2026-08' }))
        .rejects.toThrow(/attesting trustee/);
    });

    it('refuses to let an unverified source report a balance', async () => {
      await expect(ReserveEngine.record({
        sourceType: 'partner_bank',
        sourceKey: 'column',
        verification: 'unverified',
        balanceCents: 584259658,
      })).rejects.toThrow(/unverified source cannot report a reserve balance/);
    });

    it('records a fully evidenced statement attestation', async () => {
      const row = await ReserveEngine.record({
        sourceType: 'depository_account',
        sourceKey: 'Betterment Trust Checking',
        verification: 'statement',
        balanceCents: 250,
        evidenceReference: 'STMT-2026-08',
        attestedBy: 'DeAndrea Lavar Barkley',
      });
      expect(row.verification).toBe('statement');
      expect(row.balance_cents).toBe(250);
      expect(state.attestations).toHaveLength(1);
    });
  });

  describe('live verification', () => {
    it('records every unreadable custody source as unverified with a reason', async () => {
      const result = await ReserveEngine.verifyLive();
      const byType = Object.fromEntries(result.sources.map((s: Row) => [s.source_type, s]));
      expect(byType.onchain_wallet.verification).toBe('unverified');
      expect(byType.onchain_wallet.unverified_reason).toMatch(/DAPP_OPERATOR_ADDRESS/);
      expect(byType.circle_custody.verification).toBe('unverified');
      expect(byType.partner_bank.verification).toBe('unverified');
      expect(result.sources.every((s: Row) => Number(s.balance_cents) === 0)).toBe(true);
    });

    it('counts wallet USDC as a live USD reserve and excludes native ETH', async () => {
      process.env.DAPP_OPERATOR_ADDRESS = '0x3e53000000000000000000000000000000006562';
      const Web3Engine = require('../server/integrations/dapp/web3Engine').Web3Engine;
      vi.spyOn(Web3Engine, 'getBalances').mockResolvedValue({
        chain: 1,
        address: process.env.DAPP_OPERATOR_ADDRESS,
        native: { symbol: 'ETH', balance: '0.0002' },
        usdc: { symbol: 'USDC', formatted: '0.2563' },
      } as any);

      const wallet = await ReserveEngine._verifyOnchainWallet();
      expect(wallet.verification).toBe('live');
      expect(wallet.balanceCents).toBe(26);
      expect(wallet.asset).toBe('USDC');
    });

    it('reports a configured partner bank as unverified because no balance API is integrated', () => {
      process.env.PARTNER_BANK_PROVIDER = 'column';
      process.env.PARTNER_BANK_API_KEY = 'test_key';
      process.env.PARTNER_BANK_ACCOUNT_ID = 'bacc_test';
      const source = ReserveEngine._verifyPartnerBank();
      expect(source.verification).toBe('unverified');
      expect(source.balanceCents).toBe(0);
      expect(source.unverifiedReason).toMatch(/statement attestation/);
    });
  });

  describe('coverage', () => {
    it('reports internally created ledger cash as unbacked', async () => {
      state.accounts.push(account('CA-OPERATING', 584259658));
      await ReserveEngine.record({
        sourceType: 'onchain_wallet',
        sourceKey: '0x3e53',
        verification: 'live',
        balanceCents: 26,
      });

      const coverage = await ReserveEngine.coverage();
      expect(coverage.status).toBe('partially_backed');
      expect(coverage.ledgerCashCents).toBe(584259658);
      expect(coverage.attestedReserveCents).toBe(26);
      expect(coverage.unbackedCents).toBe(584259632);
      expect(coverage.reserveRatioBps).toBe(0);
      expect(coverage.spendableCents).toBe(26);
    });

    it('excludes a stale live reading from the reserve', async () => {
      state.accounts.push(account('CA-OPERATING', 1000));
      await ReserveEngine.record({
        sourceType: 'onchain_wallet',
        sourceKey: '0x3e53',
        verification: 'live',
        balanceCents: 1000,
      });
      state.attestations[0].observed_at = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

      const coverage = await ReserveEngine.coverage();
      expect(coverage.sources[0].stale).toBe(true);
      expect(coverage.attestedReserveCents).toBe(0);
      expect(coverage.status).toBe('unbacked');
    });
  });

  describe('provenance', () => {
    it('classifies a balance transferred from an account that was never funded', async () => {
      state.accounts.push(account('CA-OPERATING', 584259658), account('CA-BOND-PROCEEDS', 0));
      state.movements.push(movement({
        from_account_id: 'CA-BOND-PROCEEDS',
        to_account_id: 'CA-OPERATING',
        amount_cents: 600000000,
        memo: '2% Allocation per year start year 02/2024',
      }));

      const trace = await ReserveEngine.provenance('CA-OPERATING');
      expect(trace.classification).toBe('internally_originated');
      expect(trace.externalDepositCents).toBe(0);
      expect(trace.internalOriginCents).toBe(600000000);
      expect(trace.origins.map((o: Row) => o.funding)).toEqual(['internal_transfer', 'never_funded']);
    });

    it('classifies a chain that reaches an external deposit as externally backed', async () => {
      state.accounts.push(account('CA-OPERATING', 500000), account('CA-DEPOSITORY', 0));
      state.movements.push(
        movement({ from_account_id: 'CA-DEPOSITORY', to_account_id: 'CA-OPERATING', amount_cents: 500000 }),
        movement({ to_account_id: 'CA-DEPOSITORY', amount_cents: 500000, reference_type: 'incoming_wire' }),
      );

      const trace = await ReserveEngine.provenance('CA-OPERATING');
      expect(trace.classification).toBe('mixed');
      expect(trace.externalDepositCents).toBe(500000);
      expect(trace.origins.some((o: Row) => o.funding === 'external_deposit')).toBe(true);
    });
  });

  describe('enforcement', () => {
    beforeEach(() => {
      state.accounts.push(account('CA-OPERATING', 584259658));
    });

    async function attestLiveCents(balanceCents: number) {
      await ReserveEngine.record({
        sourceType: 'onchain_wallet',
        sourceKey: '0x3e53',
        verification: 'live',
        balanceCents,
      });
    }

    it('requires a positive amount', async () => {
      await expect(ReserveEngine.assertSpendable({ amountCents: 0 }))
        .rejects.toThrow(/positive integer amountCents/);
    });

    it('stays advisory until a custody source has been observed', async () => {
      const decision = await ReserveEngine.assertSpendable({ amountCents: 25, rail: 'wire' });
      expect(decision.allowed).toBe(true);
      expect(decision.enforcement).toBe('uninitialized');
      expect(decision.warning).toMatch(/reserve verification/);
    });

    it('blocks an amount above the attested reserve in strict mode', async () => {
      await attestLiveCents(26);
      await expect(ReserveEngine.assertSpendable({ amountCents: 25000, rail: 'wire', accountId: 'CA-OPERATING' }))
        .rejects.toThrow(ReserveShortfallError);
    });

    it('allows an amount the attested reserve covers', async () => {
      await attestLiveCents(26);
      const decision = await ReserveEngine.assertSpendable({ amountCents: 25, rail: 'wire' });
      expect(decision.allowed).toBe(true);
      expect(decision.shortfall).toBe(0);
    });

    it('records the shortfall but permits the rail in warn mode', async () => {
      process.env.RESERVE_ENFORCEMENT = 'warn';
      await attestLiveCents(26);
      const decision = await ReserveEngine.assertSpendable({ amountCents: 25000, rail: 'ach' });
      expect(decision.allowed).toBe(true);
      expect(decision.warning).toMatch(/Reserve shortfall/);
      expect(decision.shortfall).toBe(249.74);
    });

    it('skips the check entirely when enforcement is off', async () => {
      process.env.RESERVE_ENFORCEMENT = 'off';
      const decision = await ReserveEngine.assertSpendable({ amountCents: 600000000 });
      expect(decision.allowed).toBe(true);
      expect(decision.enforcement).toBe('off');
    });
  });
});

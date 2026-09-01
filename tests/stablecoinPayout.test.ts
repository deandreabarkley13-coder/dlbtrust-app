import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  StablecoinPayoutRail,
  CIRCLE_USDC_ISSUERS,
} = require('../server/integrations/os/stablecoinPayoutRail');
const { PayerOsEngine } = require('../server/integrations/os/payerOsEngine');
const { BlockchainEngine } = require('../server/integrations/stablecoin/blockchainEngine');
const { PaymentComplianceGate } = require('../server/integrations/compliance/paymentComplianceGate');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const pool = require('../server/integrations/bonds/pgPool');

const DISTRIBUTOR = 'GANCFNWGTHXEZH7EL3L5WTUKUBAUUBQUH562XBKAP62NB7ZEGLB2TVXK';
const DISTRIBUTOR_SECRET = 'SDU7P3JYWUEBWNYFUYWOWWO2DGBNINFUTNECO5WYBJBLGSJQGP5MPDTC';
const WALLET_ADDRESS = 'GCTTGO5ABSTS7SEQCHZKUJTGCTNZ4WYU5EMSBXRJRHMRRDGCMKOLGYPB';
const HOME_MADE_ISSUER = 'GB6VBVUXVBI4LMYQVBZLQFWFXBWU4WGWLGVBHW5TWJZ57SLTGVIVDLSM';

const WALLET = {
  label: 'DB NET MGMT — USDC',
  name: 'DB NET MGMT',
  address: WALLET_ADDRESS,
  network: 'testnet',
  asset: 'USDC',
  glAccountCode: '5300',
};

const INSERT_COLUMNS = [
  'disbursement_id', 'disbursement_type', 'rail', 'amount_cents', 'currency',
  'payee_key', 'payee_label', 'payee_name', 'payee_routing', 'payee_account_last4',
  'sec_code', 'transaction_code', 'funding_source_key', 'funding_account_id', 'funding_account_name',
  'gl_debit_account', 'gl_credit_account', 'memo', 'initiated_by', 'rail_reference', 'metadata',
];

/** The rail configured the way a real USDC payout needs it. */
function configured({ network = 'testnet', issuer = CIRCLE_USDC_ISSUERS.testnet, mode = 'testnet' } = {}) {
  process.env.STABLECOIN_ENABLED = 'true';
  process.env.STABLECOIN_MODE = mode;
  process.env.STABLECOIN_NETWORK = network;
  process.env.STABLECOIN_ASSET_CODE = 'USDC';
  process.env.STABLECOIN_ISSUER_PUBLIC = issuer;
  process.env.STABLECOIN_DISTRIBUTOR_PUBLIC = DISTRIBUTOR;
  process.env.STABLECOIN_DISTRIBUTOR_SECRET = DISTRIBUTOR_SECRET;
  process.env.PAYER_OS_WALLETS = JSON.stringify({ 'db-net-mgmt': WALLET });
}

/**
 * Horizon, answering only what it is asked: the distributor's balances, and
 * whichever transaction and operations the caller looks up.
 */
function horizon({
  balances = [{ asset_code: 'USDC', asset_issuer: CIRCLE_USDC_ISSUERS.testnet, balance: '10.0000000' }],
  accountExists = true,
  transaction = { successful: true, ledger: 55_123, created_at: '2026-08-30T00:00:00Z' },
  operations = [] as any[],
} = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    const path = String(url);
    if (/\/accounts\//.test(path)) {
      if (!accountExists) return { status: 404, ok: false } as any;
      return { status: 200, ok: true, json: async () => ({ balances }) } as any;
    }
    if (/\/operations/.test(path)) {
      return { status: 200, ok: true, json: async () => ({ _embedded: { records: operations } }) } as any;
    }
    if (/\/transactions\//.test(path)) {
      if (!transaction) return { status: 404, ok: false } as any;
      return { status: 200, ok: true, json: async () => transaction } as any;
    }
    return { status: 404, ok: false } as any;
  }));
  return calls;
}

function payment(overrides: any = {}) {
  return {
    type: 'payment',
    to: WALLET_ADDRESS,
    amount: '0.3400000',
    asset_code: 'USDC',
    asset_issuer: CIRCLE_USDC_ISSUERS.testnet,
    ...overrides,
  };
}

/** Payer OS writes captured rather than performed, with `stablecoinInFlight` already promised. */
function payerLedger({ stablecoinInFlight = 0, row = null as any } = {}) {
  const rows: any[] = [];
  vi.spyOn(PayerOsEngine, 'ensureTables').mockResolvedValue(true);
  vi.spyOn(pool, 'query').mockImplementation(async (sql: any, params: any = []) => {
    const text = String(sql);
    if (/rail = 'stablecoin' AND status/.test(text)) {
      return { rows: [{ cents: String(stablecoinInFlight) }] } as any;
    }
    if (/SUM\(amount_cents\)/.test(text)) return { rows: [{ cents: '0' }] } as any;
    if (/INSERT INTO payer_disbursements/.test(text)) {
      const inserted: any = { status: 'pending_approval', direction: 'credit' };
      INSERT_COLUMNS.forEach((column, index) => { inserted[column] = params[index]; });
      rows.push(inserted);
      return { rows: [inserted] } as any;
    }
    if (/FROM payer_disbursements/.test(text) && row) return { rows: [row] } as any;
    if (/UPDATE payer_disbursements/.test(text)) {
      rows.push({ ...(row || {}), updated: params });
      return { rows: [{ ...(row || {}) }] } as any;
    }
    return { rows: [] } as any;
  });
  return rows;
}

function sentRow(overrides: any = {}) {
  return {
    disbursement_id: 'PAYUSDC-1',
    disbursement_type: 'stablecoin_payout',
    rail: 'stablecoin',
    status: 'sent',
    amount_cents: '34',
    currency: 'USD',
    payee_key: 'db-net-mgmt',
    payee_label: WALLET.label,
    payee_name: WALLET.name,
    payee_account_last4: WALLET_ADDRESS.slice(-4),
    funding_source_key: `stablecoin:${DISTRIBUTOR}`,
    gl_debit_account: '5300',
    gl_credit_account: '1210',
    initiated_by: 'trustee-one@example.com',
    approved_by: 'trustee-two@example.com',
    rail_reference: 'abc123',
    metadata: { screeningId: 'SCR-1' },
    ...overrides,
  };
}

describe('Real USDC as a Payer OS rail', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    configured();
    process.env.PAYER_OS_REQUIRE_SCREENING = 'false';
    delete process.env.STABLECOIN_TRUSTED_ISSUERS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  describe('the asset is Circle\'s USDC, or it is nothing', () => {
    it('is ready when the issuer is Circle\'s published issuer for the network', async () => {
      const readiness = await StablecoinPayoutRail.readiness();
      expect(readiness).toMatchObject({ ready: true, asset: 'USDC', issuer: CIRCLE_USDC_ISSUERS.testnet });
    });

    it('refuses an issuer that is not Circle, so a look-alike token is never sent as USDC', async () => {
      configured({ issuer: HOME_MADE_ISSUER });
      const readiness = await StablecoinPayoutRail.readiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.issues.join(' ')).toMatch(/not Circle's USDC issuer for testnet/);
    });

    it('pins mainnet to Circle\'s mainnet issuer, not the testnet one', async () => {
      configured({ network: 'mainnet', mode: 'mainnet', issuer: CIRCLE_USDC_ISSUERS.testnet });
      const wrong = await StablecoinPayoutRail.readiness();
      expect(wrong.ready).toBe(false);
      configured({ network: 'mainnet', mode: 'mainnet', issuer: CIRCLE_USDC_ISSUERS.public });
      const right = await StablecoinPayoutRail.readiness();
      expect(right).toMatchObject({ ready: true, issuer: CIRCLE_USDC_ISSUERS.public });
    });

    it('lets testnet name another issuer, but never mainnet', async () => {
      process.env.STABLECOIN_TRUSTED_ISSUERS = HOME_MADE_ISSUER;
      configured({ issuer: HOME_MADE_ISSUER });
      expect((await StablecoinPayoutRail.readiness()).ready).toBe(true);

      configured({ network: 'mainnet', mode: 'mainnet', issuer: HOME_MADE_ISSUER });
      const mainnet = await StablecoinPayoutRail.readiness();
      expect(mainnet.ready).toBe(false);
      expect(mainnet.trustedIssuers).toEqual([CIRCLE_USDC_ISSUERS.public]);
      expect(mainnet.warnings.join(' ')).toMatch(/ignored on mainnet/);
    });

    it('refuses an asset that is not USDC and an issuer that is not named at all', async () => {
      process.env.STABLECOIN_ASSET_CODE = 'DLBUSD';
      delete process.env.STABLECOIN_ISSUER_PUBLIC;
      const readiness = await StablecoinPayoutRail.readiness();
      expect(readiness.issues.join(' ')).toMatch(/pays real USDC only/);
      expect(readiness.issues.join(' ')).toMatch(/STABLECOIN_ISSUER_PUBLIC is required/);
    });

    it('refuses to originate in shadow mode, where the hash would be invented', async () => {
      configured({ mode: 'shadow' });
      const readiness = await StablecoinPayoutRail.readiness();
      expect(readiness.issues.join(' ')).toMatch(/settlement would be simulated/);
      await expect(StablecoinPayoutRail.submit({ wallet: 'db-net-mgmt', amountCents: 34 }))
        .rejects.toThrow(/cannot originate this payout/);
    });

    it('funds and verifies the Stellar rail only, rather than guessing at the others', async () => {
      configured({ network: 'circle' });
      const readiness = await StablecoinPayoutRail.readiness();
      expect(readiness.issues.join(' ')).toMatch(/funds and verifies the Stellar USDC rail only/);
    });
  });

  describe('the destination is an allowlist, never an address', () => {
    it('resolves a registered wallet by key', () => {
      expect(StablecoinPayoutRail.wallet('db-net-mgmt')).toMatchObject({
        key: 'db-net-mgmt',
        name: 'DB NET MGMT',
        address: WALLET_ADDRESS,
        purpose: 'stablecoin_payout',
        glAccountCode: '5300',
      });
    });

    it('refuses an unregistered wallet, and says so when the registry is empty', () => {
      expect(() => StablecoinPayoutRail.wallet('somebody-else')).toThrow(/is not a registered wallet/);
      delete process.env.PAYER_OS_WALLETS;
      expect(() => StablecoinPayoutRail.wallet('db-net-mgmt')).toThrow(/PAYER_OS_WALLETS is empty/);
    });

    it('refuses an address passed in place of a wallet key', async () => {
      await expect(PayerOsEngine.plan({
        disbursementType: 'stablecoin_payout',
        amountCents: 34,
        payee: WALLET_ADDRESS,
      })).rejects.toThrow(/is not a registered wallet/);
    });

    it('will not pay a wallet registered on another network', () => {
      configured({ network: 'mainnet', mode: 'mainnet', issuer: CIRCLE_USDC_ISSUERS.public });
      expect(() => StablecoinPayoutRail.wallet('db-net-mgmt')).toThrow(
        /registered on testnet, but this system is configured for mainnet/
      );
    });

    it('refuses a wallet with no valid address, no network or no GL account', () => {
      process.env.PAYER_OS_WALLETS = JSON.stringify({ w: { ...WALLET, address: '0xdeadbeef' } });
      expect(() => StablecoinPayoutRail.wallet('w')).toThrow(/valid Stellar address/);
      process.env.PAYER_OS_WALLETS = JSON.stringify({ w: { ...WALLET, network: '' } });
      expect(() => StablecoinPayoutRail.wallet('w')).toThrow(/needs network/);
      process.env.PAYER_OS_WALLETS = JSON.stringify({ w: { ...WALLET, glAccountCode: '' } });
      expect(() => StablecoinPayoutRail.wallet('w')).toThrow(/needs glAccountCode/);
      process.env.PAYER_OS_WALLETS = JSON.stringify({ w: { ...WALLET, asset: 'DLBUSD' } });
      expect(() => StablecoinPayoutRail.wallet('w')).toThrow(/pays USDC only/);
    });

    it('shows a registered wallet truncated, so a full address is not handed around', () => {
      expect(StablecoinPayoutRail.wallets()[0].address).toBe(`…${WALLET_ADDRESS.slice(-4)}`);
    });
  });

  describe('funding is the token position, not the cash account', () => {
    it('reads the distributor\'s USDC trustline as what is spendable', async () => {
      horizon();
      payerLedger();
      const plan = await PayerOsEngine.plan({
        disbursementType: 'stablecoin_payout',
        amountCents: 34,
        payee: 'db-net-mgmt',
      });
      expect(plan).toMatchObject({
        rail: 'stablecoin',
        direction: 'credit',
        asset: 'USDC',
        issuer: CIRCLE_USDC_ISSUERS.testnet,
        availableCents: 1000,
        spendableCents: 1000,
        funded: true,
        glCreditAccountCode: '1210',
        glDebitAccountCode: '5300',
      });
      expect(plan.source.sourceType).toBe('stablecoin_distributor');
    });

    it('subtracts USDC already promised out, so the same tokens cannot back two payouts', async () => {
      horizon({ balances: [{ asset_code: 'USDC', asset_issuer: CIRCLE_USDC_ISSUERS.testnet, balance: '1.0000000' }] });
      payerLedger({ stablecoinInFlight: 90 });
      const plan = await PayerOsEngine.plan({
        disbursementType: 'stablecoin_payout',
        amountCents: 34,
        payee: 'db-net-mgmt',
      });
      expect(plan).toMatchObject({ availableCents: 100, inFlightCents: 90, spendableCents: 10, funded: false });
      await expect(PayerOsEngine.initiate({
        disbursementType: 'stablecoin_payout',
        amountCents: 34,
        payee: 'db-net-mgmt',
        initiatedBy: 'trustee-one@example.com',
      })).rejects.toThrow(/spendable/);
    });

    it('refuses when the distributor holds no trustline for Circle\'s USDC', async () => {
      horizon({ balances: [{ asset_type: 'native', balance: '100' }] });
      payerLedger();
      await expect(PayerOsEngine.plan({
        disbursementType: 'stablecoin_payout',
        amountCents: 34,
        payee: 'db-net-mgmt',
      })).rejects.toThrow(/holds no USDC trustline/);
    });

    it('refuses when the account does not exist rather than assuming a zero it can spend', async () => {
      horizon({ accountExists: false });
      payerLedger();
      await expect(StablecoinPayoutRail.position()).rejects.toThrow(/does not exist on testnet/);
    });

    it('refuses when Horizon cannot be reached, rather than inventing a balance', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
      await expect(StablecoinPayoutRail.position()).rejects.toThrow(/is unreachable/);
    });

    it('never charges the payout to the trust\'s cash account', async () => {
      horizon();
      const rows = payerLedger();
      await PayerOsEngine.initiate({
        disbursementType: 'stablecoin_payout',
        amountCents: 34,
        payee: 'db-net-mgmt',
        initiatedBy: 'trustee-one@example.com',
      });
      expect(rows[0]).toMatchObject({
        rail: 'stablecoin',
        gl_credit_account: '1210',
        funding_source_key: `stablecoin:${DISTRIBUTOR}`,
        status: 'pending_approval',
      });
      expect(rows[0].funding_account_id).not.toBe('1010');
    });
  });

  describe('dual control and origination', () => {
    it('comes back pending a second trustee, so initiating does not send', async () => {
      horizon();
      const rows = payerLedger();
      const { disbursement } = await PayerOsEngine.initiate({
        disbursementType: 'stablecoin_payout',
        amountCents: 34,
        payee: 'db-net-mgmt',
        initiatedBy: 'trustee-one@example.com',
      });
      expect(disbursement.status).toBe('pending_approval');
      expect(rows).toHaveLength(1);
    });

    it('records the transaction hash the chain returned as the rail reference', async () => {
      horizon();
      payerLedger({ row: sentRow({ status: 'approved', rail_reference: null }) });
      vi.spyOn(PaymentComplianceGate, 'verifyRecordedScreening').mockResolvedValue({ status: 'clear' } as any);
      vi.spyOn(BlockchainEngine.prototype, 'settle').mockResolvedValue({
        hash: 'e2f0c1',
        ledger: 55_123,
        amount: '0.34',
        explorer: 'https://stellar.expert/explorer/testnet/tx/e2f0c1',
        simulated: false,
      } as any);

      const result = await PayerOsEngine.send('PAYUSDC-1');
      expect(result.stablecoin).toMatchObject({ reference: 'e2f0c1' });
    });

    it('refuses a simulated result rather than recording it as an origination', async () => {
      horizon();
      payerLedger({ row: sentRow({ status: 'approved', rail_reference: null }) });
      vi.spyOn(PaymentComplianceGate, 'verifyRecordedScreening').mockResolvedValue({ status: 'clear' } as any);
      vi.spyOn(BlockchainEngine.prototype, 'settle').mockResolvedValue({
        hash: 'shadow-1', simulated: true,
      } as any);

      await expect(PayerOsEngine.send('PAYUSDC-1')).rejects.toThrow(/simulated result, so nothing was originated/);
    });
  });

  describe('settlement is what the chain confirms', () => {
    beforeEach(() => {
      vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JE-1' } as any);
    });

    it('posts the ledger once the chain shows that payment to that wallet', async () => {
      horizon({ operations: [payment()] });
      payerLedger({ row: sentRow() });
      const result = await PayerOsEngine.settle('PAYUSDC-1', { reference: 'abc123' });
      expect(result.journalEntry.entry_id).toBe('JE-1');
      expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
        lines: expect.arrayContaining([expect.objectContaining({ accountCode: '1210', creditAmount: 0.34 })]),
      }));
    });

    it('refuses a hash Horizon does not know', async () => {
      horizon({ transaction: null as any });
      payerLedger({ row: sentRow() });
      await expect(PayerOsEngine.settle('PAYUSDC-1', { reference: 'abc123' }))
        .rejects.toThrow(/Horizon does not know transaction abc123/);
      expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
    });

    it('refuses a transaction that failed on-chain', async () => {
      horizon({ transaction: { successful: false } as any });
      payerLedger({ row: sentRow() });
      await expect(PayerOsEngine.settle('PAYUSDC-1', { reference: 'abc123' }))
        .rejects.toThrow(/failed on testnet/);
    });

    it('refuses a transaction that paid a different wallet, amount, or asset', async () => {
      payerLedger({ row: sentRow() });
      horizon({ operations: [payment({ to: DISTRIBUTOR })] });
      await expect(PayerOsEngine.settle('PAYUSDC-1', { reference: 'abc123' })).rejects.toThrow(/does not pay/);
      horizon({ operations: [payment({ amount: '5.0000000' })] });
      await expect(PayerOsEngine.settle('PAYUSDC-1', { reference: 'abc123' })).rejects.toThrow(/does not pay/);
      horizon({ operations: [payment({ asset_issuer: HOME_MADE_ISSUER })] });
      await expect(PayerOsEngine.settle('PAYUSDC-1', { reference: 'abc123' })).rejects.toThrow(/does not pay/);
      expect(TrustAccountingEngine.postJournalEntry).not.toHaveBeenCalled();
    });

    it('refuses a transaction that carries no payment at all', async () => {
      horizon({ operations: [{ type: 'change_trust' }] });
      payerLedger({ row: sentRow() });
      await expect(PayerOsEngine.settle('PAYUSDC-1', { reference: 'abc123' }))
        .rejects.toThrow(/carries no payment operation/);
    });
  });
});

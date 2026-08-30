import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WalletEngine } = require('../server/integrations/inhouseBank/wallet/walletEngine');
const { WalletCredentials } = require('../server/integrations/inhouseBank/wallet/walletCredentials');
const { WireDispatchLink } = require('../server/integrations/inhouseBank/wire/wireDispatchLink');
const { VirtualAccountManager } = require('../server/integrations/inhouseBank/virtualAccountManager');
const { WireHostToHostEngine } = require('../server/integrations/inhouseBank/wire/wireHostToHostEngine');
const { InHouseBankEngine } = require('../server/integrations/inhouseBank/inHouseBankEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

const WALLET: Row = {
  wallet_id: 'WAL-1',
  handle: 'dee',
  holder_name: 'DeAndrea Barkley',
  holder_ref: 'member-1',
  holder_email: null,
  wallet_type: 'family_member',
  status: 'active',
  va_id: 'VA-1',
  account_number: '8842000000001',
  per_payment_limit_cents: 500000,
  daily_limit_cents: 750000,
  monthly_limit_cents: null,
  allowed_rails: null,
  payee_allowlist: null,
  internal_only: false,
  opened_by: 'operator',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  closed_at: null,
};

const ACCOUNT = {
  vaId: 'VA-1',
  accountNumber: '8842000000001',
  status: 'active',
  balanceCents: 1000000,
  availableCents: 1000000,
  available: '10000.00',
};

/**
 * Only the statements these engines actually issue are recognised; anything
 * else throws, so a query nobody modelled cannot pass as an empty result.
 */
function fakeDb(state: { wallets: Row[]; credentials: Row[]; spend: Row; payments: Row[]; runs: Row[] }) {
  return vi.fn(async (sql: string, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|DROP)/i.test(text)) return { rows: [] };

    if (text.startsWith('SELECT * FROM ihb_wallets WHERE wallet_id')) {
      const ref = String(params[0]);
      return { rows: state.wallets.filter(w => [w.wallet_id, w.handle, w.va_id, w.account_number].includes(ref)) };
    }
    if (text.startsWith('UPDATE ihb_wallets SET status')) {
      const row = state.wallets.find(w => w.wallet_id === params[0]);
      row.status = params[1];
      return { rows: [row] };
    }
    if (text.startsWith('UPDATE ihb_wallets SET per_payment_limit_cents')) {
      const row = state.wallets.find(w => w.wallet_id === params[0]);
      Object.assign(row, {
        per_payment_limit_cents: params[1],
        daily_limit_cents: params[2],
        monthly_limit_cents: params[3],
        allowed_rails: params[4],
        payee_allowlist: params[5],
        internal_only: params[6],
      });
      return { rows: [row] };
    }
    if (text.includes('FROM ihb_payments WHERE debtor_va_id')) return { rows: [state.spend] };

    if (text.startsWith('INSERT INTO ihb_wallet_credentials')) {
      const row = {
        credential_id: params[0], key_id: params[1], wallet_id: params[2], secret_hash: params[3],
        label: params[4], scopes: params[5], status: 'active', expires_at: params[6],
        created_by: params[7], last_used_at: null, created_at: new Date().toISOString(),
        revoked_at: null, revoked_by: null,
      };
      state.credentials.push(row);
      return { rows: [row] };
    }
    if (text.startsWith('SELECT * FROM ihb_wallet_credentials WHERE key_id')) {
      return { rows: state.credentials.filter(c => c.key_id === params[0]) };
    }
    if (text.startsWith('SELECT * FROM ihb_wallet_credentials WHERE wallet_id')) {
      return { rows: state.credentials.filter(c => c.wallet_id === params[0]) };
    }
    if (text.startsWith('UPDATE ihb_wallet_credentials SET last_used_at')) return { rows: [] };
    if (text.startsWith('UPDATE ihb_wallet_credentials')) {
      const row = state.credentials.find(c => c.key_id === params[0]);
      if (!row || row.status !== 'active') return { rows: [] };
      row.status = 'revoked';
      row.revoked_at = new Date().toISOString();
      return { rows: [row] };
    }

    if (text.includes('FROM ihb_payments p LEFT JOIN ihb_wire_transmissions')) return { rows: state.payments };
    if (text.startsWith('SELECT started_at FROM ihb_wire_link_runs')) return { rows: [] };
    if (text.startsWith('SELECT * FROM ihb_wire_link_runs')) return { rows: state.runs };
    if (text.startsWith('INSERT INTO ihb_wire_link_runs')) {
      state.runs.push({ trigger: params[0], transmitted: params[3], failed: params[5] });
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO ihb_ledger_events') || text.startsWith('INSERT INTO ihb_events')) return { rows: [] };

    throw new Error(`unhandled SQL in test fake: ${text.slice(0, 90)}`);
  });
}

describe('family wallets', () => {
  let state: { wallets: Row[]; credentials: Row[]; spend: Row; payments: Row[]; runs: Row[] };
  let original: any;

  beforeEach(() => {
    state = {
      wallets: [{ ...WALLET }],
      credentials: [],
      spend: { day_cents: '0', month_cents: '0', day_count: 0 },
      payments: [],
      runs: [],
    };
    original = pool.query;
    pool.query = fakeDb(state);
    vi.spyOn(VirtualAccountManager, 'get').mockImplementation(async (ref: string) =>
      ref === 'VA-1' || ref === '8842000000001' ? { ...ACCOUNT } : null
    );
    vi.spyOn(VirtualAccountManager, 'setStatus').mockImplementation(async (_ref: string, status: string) => ({ ...ACCOUNT, status }));
  });

  afterEach(() => {
    pool.query = original;
    vi.restoreAllMocks();
  });

  it('allows a payment inside every control', async () => {
    const decision = await WalletEngine.check('dee', { amountCents: 100000 });
    expect(decision.allowed).toBe(true);
    expect(decision.violations).toEqual([]);
  });

  it('refuses an amount above the per-payment limit', async () => {
    const decision = await WalletEngine.check('dee', { amountCents: 600000 });
    expect(decision.allowed).toBe(false);
    expect(decision.violations.map((v: Row) => v.code)).toContain('WALLET_PER_PAYMENT_LIMIT');
  });

  it('counts what is already committed today against the daily limit', async () => {
    state.spend = { day_cents: '700000', month_cents: '700000', day_count: 3 };
    const decision = await WalletEngine.check('dee', { amountCents: 100000 });
    expect(decision.violations.map((v: Row) => v.code)).toContain('WALLET_DAILY_LIMIT');
    expect(decision.spend.dailyRemainingCents).toBe(50000);
  });

  it('refuses to spend more than the account has available', async () => {
    const decision = await WalletEngine.check('dee', { amountCents: 1000001 + 0 });
    expect(decision.violations.map((v: Row) => v.code)).toContain('WALLET_INSUFFICIENT');
  });

  it('keeps an internal-only wallet inside the family bank', async () => {
    state.wallets[0].internal_only = true;
    const outside = await WalletEngine.check('dee', { amountCents: 1000, creditorAccountNumber: '999999999' });
    expect(outside.violations.map((v: Row) => v.code)).toContain('WALLET_INTERNAL_ONLY');
    const inside = await WalletEngine.check('dee', { amountCents: 1000, creditorAccountNumber: '8842000000001' });
    expect(inside.allowed).toBe(true);
  });

  it('honours a payee allowlist', async () => {
    state.wallets[0].payee_allowlist = JSON.stringify(['123456789']);
    const denied = await WalletEngine.check('dee', { amountCents: 1000, creditorAccountNumber: '987654321' });
    expect(denied.violations.map((v: Row) => v.code)).toContain('WALLET_PAYEE_NOT_ALLOWED');
    const allowed = await WalletEngine.check('dee', { amountCents: 1000, creditorAccountNumber: '123456789' });
    expect(allowed.allowed).toBe(true);
  });

  it('refuses to send from a frozen wallet, and freezes the account under it too', async () => {
    await WalletEngine.setStatus('dee', 'frozen', { actor: 'trustee' });
    expect(VirtualAccountManager.setStatus).toHaveBeenCalledWith('VA-1', 'frozen', 'trustee');
    await expect(
      WalletEngine.pay('dee', { idempotencyKey: 'k-1', amountCents: 1000, creditor: { name: 'Vendor' } })
    ).rejects.toThrow(/frozen/);
  });

  it('will not send without an idempotency key', async () => {
    await expect(WalletEngine.pay('dee', { amountCents: 1000 })).rejects.toThrow(/idempotency key/i);
  });

  it('hands an allowed payment to the in-house bank rather than moving money itself', async () => {
    const submit = vi.spyOn(InHouseBankEngine, 'submit').mockResolvedValue({ paymentId: 'IHB-1', replay: false } as never);
    await WalletEngine.pay('dee', {
      idempotencyKey: 'k-2',
      amountCents: 25000,
      memo: 'School fees',
      creditor: { name: 'Academy', accountNumber: '123456789' },
    });
    const instruction = submit.mock.calls[0][0] as any;
    expect(instruction.payload.debtorAccount).toBe('8842000000001');
    expect(instruction.payload.amountCents).toBe(25000);
    expect(instruction.payload.remittanceInformation).toBe('School fees');
    expect(instruction.principal.scope).toBe('payments:initiate');
  });

  it('routes a wallet-to-wallet transfer through the same pipeline, on-us', async () => {
    state.wallets.push({ ...WALLET, wallet_id: 'WAL-2', handle: 'jr', va_id: 'VA-2', account_number: '8842000000002', holder_name: 'DB Jr' });
    const submit = vi.spyOn(InHouseBankEngine, 'submit').mockResolvedValue({ paymentId: 'IHB-2', replay: false } as never);
    await WalletEngine.transfer('dee', { toRef: 'jr', idempotencyKey: 'k-3', amountCents: 5000 });
    const instruction = submit.mock.calls[0][0] as any;
    expect(instruction.payload.creditor.accountNumber).toBe('8842000000002');
    expect(instruction.payload.paymentPurpose).toBe('Transfer to jr');
  });

  it('refuses a wallet paying itself', async () => {
    await expect(WalletEngine.transfer('dee', { toRef: 'dee', idempotencyKey: 'k-4', amountCents: 100 }))
      .rejects.toThrow(/cannot pay itself/);
  });
});

describe('wallet credentials', () => {
  let state: any;
  let original: any;

  beforeEach(() => {
    state = { wallets: [{ ...WALLET }], credentials: [], spend: { day_cents: '0', month_cents: '0', day_count: 0 }, payments: [], runs: [] };
    original = pool.query;
    pool.query = fakeDb(state);
    vi.spyOn(VirtualAccountManager, 'get').mockResolvedValue({ ...ACCOUNT } as never);
  });
  afterEach(() => {
    pool.query = original;
    vi.restoreAllMocks();
  });

  it('returns the secret once and stores only its hash', async () => {
    const issued = await WalletCredentials.issue('dee', { label: 'phone', createdBy: 'trustee' });
    expect(issued.secret).toMatch(/^ws_/);
    expect(issued.keyId).toMatch(/^wk_/);
    expect(state.credentials[0].secret_hash).not.toContain(issued.secret);
    const listed = await WalletCredentials.list('dee');
    expect(JSON.stringify(listed)).not.toContain(issued.secret);
  });

  it('verifies a good key and rejects a wrong secret', async () => {
    const issued = await WalletCredentials.issue('dee', {});
    const verified = await WalletCredentials.verify({ keyId: issued.keyId, secret: issued.secret, scope: 'wallet:pay' });
    expect(verified.walletId).toBe('WAL-1');
    expect(verified.principal).toBe('wallet:dee');
    await expect(WalletCredentials.verify({ keyId: issued.keyId, secret: 'ws_wrong' }))
      .rejects.toThrow(/not valid/);
  });

  it('refuses a scope the key was not issued for', async () => {
    const issued = await WalletCredentials.issue('dee', { scopes: ['wallet:read'] });
    await expect(WalletCredentials.verify({ keyId: issued.keyId, secret: issued.secret, scope: 'wallet:pay' }))
      .rejects.toThrow(/may not wallet:pay/);
  });

  it('stops working the moment it is revoked', async () => {
    const issued = await WalletCredentials.issue('dee', {});
    await WalletCredentials.revoke(issued.keyId, { actor: 'trustee' });
    await expect(WalletCredentials.verify({ keyId: issued.keyId, secret: issued.secret }))
      .rejects.toThrow(/revoked/);
  });
});

describe('wire dispatch link', () => {
  let state: any;
  let original: any;

  beforeEach(() => {
    state = { wallets: [], credentials: [], spend: {}, payments: [], runs: [] };
    original = pool.query;
    pool.query = fakeDb(state);
  });
  afterEach(() => {
    pool.query = original;
    vi.restoreAllMocks();
  });

  it('only offers dispatched, untransmitted wire-rail payments', async () => {
    state.payments = [
      { payment_id: 'IHB-1', rail: 'fedwire', amount_cents: '100000', fee_cents: '2500', currency: 'USD', dispatched_at: '2026-01-01T00:00:00Z' },
    ];
    const pending = await WireDispatchLink.pending({});
    expect(pending).toEqual([
      { paymentId: 'IHB-1', rail: 'fedwire', amountCents: 102500, currency: 'USD', dispatchedAt: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('transmits every candidate and reports what went out', async () => {
    state.payments = [
      { payment_id: 'IHB-1', rail: 'fedwire', amount_cents: '1000', fee_cents: '0', currency: 'USD', dispatched_at: null },
      { payment_id: 'IHB-2', rail: 'fedwire', amount_cents: '2000', fee_cents: '0', currency: 'USD', dispatched_at: null },
    ];
    vi.spyOn(WireHostToHostEngine, 'transmit').mockImplementation(async (paymentId: string) => ({
      transmitted: true,
      transmission: { transmissionId: `T-${paymentId}`, filename: `${paymentId}.xml` },
    }));
    vi.spyOn(WireHostToHostEngine, 'ingestAdvices').mockResolvedValue({ files: 0, records: 0, applied: [] } as never);
    vi.spyOn(WireHostToHostEngine, 'reconcile').mockResolvedValue({ raised: 0, open: 0, findings: [] } as never);

    const report = await WireDispatchLink.driveOnce({ trigger: 'test' });
    expect(report.candidates).toBe(2);
    expect(report.transmitted.map((t: Row) => t.paymentId)).toEqual(['IHB-1', 'IHB-2']);
    expect(report.failed).toEqual([]);
  });

  it('turns a payment it cannot transmit into a wire exception, and still sends the rest', async () => {
    state.payments = [
      { payment_id: 'IHB-BAD', rail: 'fedwire', amount_cents: '1000', fee_cents: '0', currency: 'USD', dispatched_at: null },
      { payment_id: 'IHB-OK', rail: 'fedwire', amount_cents: '2000', fee_cents: '0', currency: 'USD', dispatched_at: null },
    ];
    vi.spyOn(WireHostToHostEngine, 'transmit').mockImplementation(async (paymentId: string) => {
      if (paymentId === 'IHB-BAD') throw new Error('creditor routing number is missing');
      return { transmitted: true, transmission: { transmissionId: 'T-OK', filename: 'ok.xml' } };
    });
    const raise = vi.spyOn(WireHostToHostEngine, 'raiseException').mockResolvedValue({} as never);
    vi.spyOn(WireHostToHostEngine, 'ingestAdvices').mockResolvedValue({ files: 0, records: 0, applied: [] } as never);
    vi.spyOn(WireHostToHostEngine, 'reconcile').mockResolvedValue({ raised: 0, open: 0, findings: [] } as never);

    const report = await WireDispatchLink.driveOnce({ trigger: 'test' });
    expect(report.failed.map((f: Row) => f.paymentId)).toEqual(['IHB-BAD']);
    expect(report.transmitted.map((t: Row) => t.paymentId)).toEqual(['IHB-OK']);
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transmission_blocked', paymentId: 'IHB-BAD' }));
  });

  it('never lets a transmission problem fail an already-ledgered dispatch', async () => {
    state.payments = [
      { payment_id: 'IHB-9', rail: 'fedwire', amount_cents: '1000', fee_cents: '0', currency: 'USD', dispatched_at: null },
    ];
    vi.spyOn(WireHostToHostEngine, 'transmit').mockRejectedValue(new Error('bank host refused the connection'));
    vi.spyOn(WireHostToHostEngine, 'raiseException').mockResolvedValue({} as never);
    const result = await WireDispatchLink.kick('IHB-9');
    expect(result.transmitted).toBeFalsy();
    expect(result.error).toMatch(/refused/);
  });
});

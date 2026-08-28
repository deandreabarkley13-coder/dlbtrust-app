import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TrustBankEngine } = require('../server/integrations/dapp/trustBankEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

/**
 * In-memory stand-in for the trust bank tables: enough of Postgres to prove the
 * maker/checker lifecycle and that a rollback leaves balances untouched.
 */
function fakeDb(accounts: Row[]) {
  const state = {
    accounts: new Map(accounts.map((a) => [a.account_id, { ...a }])),
    payments: new Map<string, Row>(),
    transactions: [] as Row[],
    committed: false,
    rolledBack: false,
    failBalanceUpdateFor: null as string | null,
  };

  const run = async (sql: string, params: any[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(text)) {
      if (/^COMMIT/i.test(text)) state.committed = true;
      if (/^ROLLBACK/i.test(text)) state.rolledBack = true;
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM trust_bank_accounts WHERE account_id')) {
      const account = state.accounts.get(params[0]);
      return { rows: account ? [account] : [] };
    }
    if (text.startsWith('SELECT balance_cents, status FROM trust_bank_accounts')) {
      const account = state.accounts.get(params[0]);
      return { rows: account ? [account] : [] };
    }
    if (text.startsWith('UPDATE trust_bank_accounts SET balance_cents')) {
      if (state.failBalanceUpdateFor === params[0]) throw new Error('simulated balance failure');
      const account = state.accounts.get(params[0]);
      if (!account) return { rows: [] };
      account.balance_cents = Number(account.balance_cents) + Number(params[1]);
      return { rows: [account] };
    }
    if (text.startsWith('INSERT INTO trust_bank_payments')) {
      const [payment_id, from_account_id, to_account_id, amount_cents, initiated_by, metadata] = params;
      state.payments.set(payment_id, {
        payment_id,
        from_account_id,
        to_account_id,
        amount_cents,
        rail: 'internal',
        status: 'pending',
        initiated_by,
        metadata: JSON.parse(metadata),
      });
      return { rows: [] };
    }
    if (text.startsWith('SELECT * FROM trust_bank_payments WHERE payment_id')) {
      const payment = state.payments.get(params[0]);
      return { rows: payment ? [payment] : [] };
    }
    if (text.startsWith("SELECT * FROM trust_bank_payments WHERE rail = 'internal'")) {
      return { rows: [...state.payments.values()].filter((p) => p.status === params[0]) };
    }
    if (text.startsWith('UPDATE trust_bank_payments SET metadata')) {
      const payment = state.payments.get(params[0]);
      payment.metadata = JSON.parse(params[1]);
      return { rows: [payment] };
    }
    if (text.startsWith("UPDATE trust_bank_payments SET status = 'completed'")) {
      const payment = state.payments.get(params[0]);
      payment.status = 'completed';
      payment.metadata = JSON.parse(params[1]);
      return { rows: [payment] };
    }
    if (text.startsWith("UPDATE trust_bank_payments SET status = 'cancelled'")) {
      const payment = state.payments.get(params[0]);
      if (!payment || payment.status !== 'pending') return { rows: [] };
      payment.status = 'cancelled';
      payment.error_message = params[1];
      return { rows: [payment] };
    }
    if (text.startsWith('INSERT INTO trust_bank_transactions')) {
      state.transactions.push({ account_id: params[1], type: params[5], balance_after: params[6] });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  };

  vi.spyOn(pool, 'query').mockImplementation(run as any);
  vi.spyOn(pool, 'connect').mockResolvedValue({ query: run, release: () => {} } as any);
  return state;
}

const FAMILY = [
  { account_id: 'TBA-CORPUS', balance_cents: 100000, status: 'active' },
  { account_id: 'TBA-BENEFICIARY', balance_cents: 0, status: 'active' },
];

describe('Trust bank internal distributions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TRUST_BANK_DUAL_CONTROL_THRESHOLD_CENTS;
  });

  it('moves nothing until two distinct trustees sign', async () => {
    const db = fakeDb(FAMILY);
    const proposal = await TrustBankEngine.proposeInternalTransfer({
      fromAccountId: 'TBA-CORPUS',
      toAccountId: 'TBA-BENEFICIARY',
      amount: 250,
      description: 'Beneficiary distribution',
      requestedBy: 'AnnRobinson1117@gmail.com',
    });
    expect(proposal).toMatchObject({ status: 'pending', requiredSignatures: 2, amount_cents: 25000 });
    expect(db.accounts.get('TBA-CORPUS')!.balance_cents).toBe(100000);

    const first = await TrustBankEngine.approveInternalTransfer(
      proposal.paymentId,
      'AnnRobinson1117@gmail.com',
      { role: 'maker' },
    );
    expect(first).toMatchObject({ status: 'pending', remainingSignatures: 1 });
    expect(db.accounts.get('TBA-CORPUS')!.balance_cents).toBe(100000);

    await expect(
      TrustBankEngine.approveInternalTransfer(proposal.paymentId, 'annrobinson1117@GMAIL.com'),
    ).rejects.toThrow(/already signed/);

    const second = await TrustBankEngine.approveInternalTransfer(
      proposal.paymentId,
      'deandreabarkley13@gmail.com',
      { role: 'checker' },
    );
    expect(second.status).toBe('completed');
    expect(second.approvals.map((a: any) => a.role)).toEqual(['maker', 'checker']);
    expect(db.accounts.get('TBA-CORPUS')!.balance_cents).toBe(75000);
    expect(db.accounts.get('TBA-BENEFICIARY')!.balance_cents).toBe(25000);
    expect(db.transactions.map((t) => t.type)).toEqual(['debit', 'credit']);
    expect(db.committed).toBe(true);

    await expect(
      TrustBankEngine.approveInternalTransfer(proposal.paymentId, 'someone@else.com'),
    ).rejects.toThrow(/already completed/);
  });

  it('honours a single-signature threshold for small distributions', async () => {
    const db = fakeDb(FAMILY);
    process.env.TRUST_BANK_DUAL_CONTROL_THRESHOLD_CENTS = '50000';
    const small = await TrustBankEngine.proposeInternalTransfer({
      fromAccountId: 'TBA-CORPUS',
      toAccountId: 'TBA-BENEFICIARY',
      amount: 10,
      requestedBy: 'AnnRobinson1117@gmail.com',
    });
    expect(small.requiredSignatures).toBe(1);
    const settled = await TrustBankEngine.approveInternalTransfer(small.paymentId, 'AnnRobinson1117@gmail.com');
    expect(settled.status).toBe('completed');
    expect(db.accounts.get('TBA-BENEFICIARY')!.balance_cents).toBe(1000);

    const large = await TrustBankEngine.proposeInternalTransfer({
      fromAccountId: 'TBA-CORPUS',
      toAccountId: 'TBA-BENEFICIARY',
      amount: 500,
      requestedBy: 'AnnRobinson1117@gmail.com',
    });
    expect(large.requiredSignatures).toBe(2);
  });

  it('rejects a distribution and refuses to sign it afterwards', async () => {
    const db = fakeDb(FAMILY);
    const proposal = await TrustBankEngine.proposeInternalTransfer({
      fromAccountId: 'TBA-CORPUS',
      toAccountId: 'TBA-BENEFICIARY',
      amount: 100,
      requestedBy: 'AnnRobinson1117@gmail.com',
    });
    const rejected = await TrustBankEngine.rejectInternalTransfer(
      proposal.paymentId,
      'deandreabarkley13@gmail.com',
      'Not authorised this quarter',
    );
    expect(rejected.status).toBe('cancelled');
    expect(db.accounts.get('TBA-CORPUS')!.balance_cents).toBe(100000);
    await expect(
      TrustBankEngine.approveInternalTransfer(proposal.paymentId, 'deandreabarkley13@gmail.com'),
    ).rejects.toThrow(/already cancelled/);
  });

  it('refuses proposals that overdraw, self-pay, or target a frozen account', async () => {
    fakeDb([...FAMILY, { account_id: 'TBA-FROZEN', balance_cents: 0, status: 'frozen' }]);
    const base = { fromAccountId: 'TBA-CORPUS', toAccountId: 'TBA-BENEFICIARY', requestedBy: 'maker@x.com' };
    await expect(TrustBankEngine.proposeInternalTransfer({ ...base, amount: 5000 }))
      .rejects.toThrow(/Insufficient balance/);
    await expect(TrustBankEngine.proposeInternalTransfer({ ...base, toAccountId: 'TBA-CORPUS', amount: 1 }))
      .rejects.toThrow(/must differ/);
    await expect(TrustBankEngine.proposeInternalTransfer({ ...base, toAccountId: 'TBA-FROZEN', amount: 1 }))
      .rejects.toThrow(/is frozen/);
    await expect(TrustBankEngine.proposeInternalTransfer({ ...base, amount: 1, requestedBy: null }))
      .rejects.toThrow(/requestedBy is required/);
  });

  it('rolls back both legs when one balance update fails', async () => {
    const db = fakeDb(FAMILY);
    const proposal = await TrustBankEngine.proposeInternalTransfer({
      fromAccountId: 'TBA-CORPUS',
      toAccountId: 'TBA-BENEFICIARY',
      amount: 100,
      requestedBy: 'maker@x.com',
    });
    await TrustBankEngine.approveInternalTransfer(proposal.paymentId, 'maker@x.com');
    db.failBalanceUpdateFor = 'TBA-BENEFICIARY';
    await expect(TrustBankEngine.approveInternalTransfer(proposal.paymentId, 'checker@x.com'))
      .rejects.toThrow(/simulated balance failure/);
    expect(db.rolledBack).toBe(true);
    expect(db.payments.get(proposal.paymentId)!.status).toBe('pending');
  });
});

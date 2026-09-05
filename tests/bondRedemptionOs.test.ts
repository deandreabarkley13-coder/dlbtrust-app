import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pool = require('../server/integrations/bonds/pgPool');
const { BondEngine } = require('../server/integrations/bonds/bondEngine');
const { TrustAccountingEngine } = require('../server/integrations/accounting/trustAccountingEngine');
const { KafkaEventBus, TOPICS } = require('../server/integrations/events/kafkaEventBus');
const { BondRedemptionOsEngine, clearingChecks, netAllocations, NOTICE_TRANSITIONS, BATCH_TRANSITIONS, GL } = require('../server/integrations/os/bondRedemptionOsEngine');

type Row = Record<string, any>;

const TODAY = new Date().toISOString().slice(0, 10);

/** In-memory store answering the SQL shapes the engine emits. */
function store(bond: Row) {
  const t: Record<string, Row[]> = { bond_redemption_notices: [], bond_redemption_allocations: [], bond_redemption_batches: [], bond_redemption_events: [], trust_accounts: [] };
  const bonds: Row[] = [bond];
  const cols = /\(([^)]+)\)\s+VALUES/i;
  const query = vi.fn(async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^CREATE/.test(text)) return { rows: [] };
    let m: RegExpExecArray | null;
    if (/^SELECT b\.id, b\.bond_name, b\.status, b\.maturity_date, b\.currency, b\.face_value/.test(text)) {
      return { rows: bonds.filter(b => b.id === params[0]) };
    }
    if (/^SELECT b\.id, b\.bond_name, b\.status, b\.maturity_date, b\.currency, b\.issuer/.test(text)) {
      return { rows: bonds.filter(b => b.status === 'active' && Number(b.principal_balance) > 0).map(b => ({ ...b, notice_id: null })) };
    }
    if (/^SELECT 1 FROM trust_accounts/.test(text)) return { rows: t.trust_accounts.filter(r => r.account_code === params[0]) };
    if ((m = /^INSERT INTO (\w+)/.exec(text))) {
      const table = m[1];
      const names = cols.exec(text)![1].split(',').map(s => s.trim());
      const values = /VALUES \((.+?)\)( RETURNING)?/.exec(text)![1].split(',').map(s => s.trim());
      const row: Row = { created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      names.forEach((n, i) => {
        const v = values[i];
        if (/^\$\d+/.test(v)) row[n] = params[Number(v.replace(/\D/g, '')) - 1];
        else if (/^'.*'$/.test(v)) row[n] = v.slice(1, -1);
        else row[n] = v;
      });
      if (table === 'bond_redemption_notices') Object.assign(row, { batch_id: null, clearing: null, bond_transaction_id: null, journal_entry_id: null, settled_at: null });
      if (table === 'bond_redemption_batches') Object.assign(row, { funding: null, settlement: null, funded_by: null, settled_at: null });
      t[table].push(row);
      return { rows: [row] };
    }
    if ((m = /^DELETE FROM (\w+) WHERE (\w+) = \$1$/.exec(text))) { t[m[1]] = t[m[1]].filter(r => r[m![2]] !== params[0]); return { rows: [] }; }
    if ((m = /^UPDATE bonds SET status = 'called'/.exec(text))) { bonds.filter(b => b.id === params[0] && ['active', 'matured'].includes(b.status)).forEach(b => { b.status = 'called'; }); return { rows: [] }; }
    if ((m = /^UPDATE (\w+) SET (.+) WHERE (\w+) = \$1( AND status = '(\w+)')?$/.exec(text))) {
      const [, table, set, key, , onlyStatus] = m;
      t[table].filter(r => r[key] === params[0] && (!onlyStatus || r.status === onlyStatus)).forEach(r => {
        set.split(/, (?=\w+ = )/).forEach(pair => {
          const [col, value] = pair.split(/ = (.+)/);
          if (value === 'NOW()') r[col] = new Date().toISOString();
          else if (value === 'NULL') r[col] = null;
          else if (/^'.*'$/.test(value)) r[col] = value.slice(1, -1);
          else if (/^CASE/.test(value)) r[col] = params[1] === 'settled' ? new Date().toISOString() : r[col];
          else r[col] = params[Number(value.replace(/\$|::jsonb/g, '')) - 1];
        });
      });
      return { rows: [] };
    }
    if ((m = /^SELECT \* FROM (\w+) WHERE (\w+) = \$1( ORDER BY .+)?$/.exec(text))) return { rows: t[m[1]].filter(r => r[m![2]] === params[0]) };
    if (/^SELECT \* FROM bond_redemption_notices WHERE status = 'settled' AND journal_entry_id IS NULL/.test(text)) {
      return { rows: t.bond_redemption_notices.filter(r => r.status === 'settled' && !r.journal_entry_id) };
    }
    if ((m = /^SELECT \* FROM bond_redemption_notices (WHERE (.+?) )?ORDER BY .+ LIMIT \$(\d+)$/.exec(text))) {
      let rows = [...t.bond_redemption_notices];
      if (m[2]) m[2].split(' AND ').forEach(cond => { const [col, ref] = cond.split(' = '); rows = rows.filter(r => r[col] === params[Number(ref.slice(1)) - 1]); });
      return { rows };
    }
    if ((m = /^SELECT \* FROM (\w+) (WHERE status = \$1 )?ORDER BY .+ LIMIT/.exec(text))) return { rows: t[m[1]].filter(r => !m![2] || r.status === params[0]) };
    if (/^SELECT status, COUNT\(\*\) AS n/.test(text)) return { rows: [] };
    throw new Error(`unhandled SQL in test store: ${text}`);
  });
  return { t, bonds, query };
}

const BOND = { id: 7, bond_name: 'DLB-PRB', status: 'active', maturity_date: '2026-06-30', currency: 'USD', face_value: '1000000.00', issuer: 'DeAndrea Lavar Barkley Trust', principal_balance: '1000000.00', accrued_interest: '0.00' };

describe('clearing gate (pure)', () => {
  const bond = { status: 'active', maturityDate: '2026-06-30', principalBalanceCents: 100_000_000, currency: 'USD', accruedInterestCents: 0 };

  it('passes a full maturity redemption on the maturity date footed to holders', () => {
    const r = clearingChecks({ kind: 'maturity', principalCents: 100_000_000, valueDate: '2026-06-30', recordDate: '2026-06-15', currency: 'USD' }, bond, [{ amountCents: 60_000_000 }, { amountCents: 40_000_000 }]);
    expect(r).toMatchObject({ ok: true, reasons: [] });
  });

  it('refuses a maturity redemption before maturity, a partial maturity, unfooted allocations and inactive bonds', () => {
    expect(clearingChecks({ kind: 'maturity', principalCents: 100_000_000, valueDate: '2026-01-01', currency: 'USD' }, bond, [{ amountCents: 100_000_000 }]).reasons).toEqual([expect.stringMatching(/precedes maturity.*use kind 'call'/)]);
    expect(clearingChecks({ kind: 'maturity', principalCents: 50_000_000, valueDate: '2026-06-30', currency: 'USD' }, bond, [{ amountCents: 50_000_000 }]).reasons).toEqual([expect.stringMatching(/full outstanding principal/)]);
    expect(clearingChecks({ kind: 'call', principalCents: 100_000_000, valueDate: '2026-03-01', currency: 'USD' }, bond, [{ amountCents: 99_000_000 }]).reasons).toEqual([expect.stringMatching(/do not foot/)]);
    expect(clearingChecks({ kind: 'call', principalCents: 100_000_000, valueDate: '2026-03-01', currency: 'USD' }, bond, []).reasons).toEqual([expect.stringMatching(/no holder allocations/)]);
    expect(clearingChecks({ kind: 'call', principalCents: 100_000_001, valueDate: '2026-03-01', currency: 'USD' }, bond, [{ amountCents: 100_000_001 }]).reasons).toEqual([expect.stringMatching(/exceeds outstanding balance/)]);
    expect(clearingChecks({ kind: 'call', principalCents: 100_000_000, valueDate: '2026-03-01', recordDate: '2026-03-02', currency: 'USD' }, bond, [{ amountCents: 100_000_000 }]).reasons).toEqual([expect.stringMatching(/value date precedes record date/)]);
    expect(clearingChecks({ kind: 'call', principalCents: 100_000_000, valueDate: '2026-03-01', currency: 'USD' }, { ...bond, status: 'matured' }, [{ amountCents: 100_000_000 }]).reasons).toEqual([expect.stringMatching(/bond is matured/)]);
    expect(clearingChecks({ kind: 'call', principalCents: 1, valueDate: '2026-03-01' }, null, []).ok).toBe(false);
  });

  it('warns, without blocking, on outstanding accrued interest and a partial call that retires the whole balance', () => {
    const r = clearingChecks({ kind: 'partial_call', principalCents: 100_000_000, valueDate: '2026-03-01', currency: 'USD' }, { ...bond, accruedInterestCents: 12_345 }, [{ amountCents: 100_000_000 }]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([expect.stringMatching(/retires the entire balance/), expect.stringMatching(/accrued interest 123.45/)]);
  });

  it('nets allocations to one leg per holder across notices', () => {
    const legs = netAllocations([
      { noticeId: 'A', holderRef: 'h1', holderName: 'One', amountCents: 100 },
      { noticeId: 'B', holderRef: 'h1', holderName: 'One', amountCents: 250 },
      { noticeId: 'B', holderRef: 'h2', holderName: 'Two', amountCents: 50 },
    ]);
    expect(legs).toEqual([
      expect.objectContaining({ holderRef: 'h1', amountCents: 350, noticeIds: ['A', 'B'] }),
      expect.objectContaining({ holderRef: 'h2', amountCents: 50, noticeIds: ['B'] }),
    ]);
  });

  it('terminal states have no exits and settled/cancelled are terminal on both machines', () => {
    expect(NOTICE_TRANSITIONS.settled.size).toBe(0);
    expect(NOTICE_TRANSITIONS.cancelled.size).toBe(0);
    expect(BATCH_TRANSITIONS.settled.size).toBe(0);
    expect(BATCH_TRANSITIONS.cancelled.size).toBe(0);
    expect(NOTICE_TRANSITIONS.rejected.has('record_struck')).toBe(true);
    expect(BATCH_TRANSITIONS.open.has('settling')).toBe(false);
  });
});

describe('Bond Redemption OS lifecycle', () => {
  let s: ReturnType<typeof store>;
  beforeEach(() => {
    s = store({ ...BOND });
    vi.spyOn(pool, 'query').mockImplementation(s.query as any);
    vi.spyOn(KafkaEventBus, 'publish').mockResolvedValue({ published: false });
    vi.spyOn(TrustAccountingEngine, 'postJournalEntry').mockResolvedValue({ entry_id: 'JRN-1' });
    vi.spyOn(TrustAccountingEngine, 'getFundingPosition').mockResolvedValue({ available_balance_cents: 0 });
    vi.spyOn(BondEngine, 'payPrincipal').mockImplementation(async (bondId: number, amount: number) => {
      const b = s.bonds.find(x => x.id === bondId)!;
      const remaining = Math.round((Number(b.principal_balance) - amount) * 100) / 100;
      b.principal_balance = String(remaining);
      if (remaining === 0) b.status = 'matured';
      return { paid: amount, new_principal_balance: remaining, transaction: { id: 101 } };
    });
    vi.spyOn(BondEngine, 'receivePrincipal').mockResolvedValue({ returned: 1, new_principal_balance: 0, transaction: { id: 202 } });
  });
  afterEach(() => vi.restoreAllMocks());

  it('announce requires a named trustee and defaults principal and value date from the bond', async () => {
    await expect(BondRedemptionOsEngine.announce({ bondId: 7 })).rejects.toMatchObject({ code: 'BOND_REDEMPTION_NO_ACTOR' });
    await expect(BondRedemptionOsEngine.announce({ bondId: 99, announcedBy: 't' })).rejects.toMatchObject({ code: 'BOND_REDEMPTION_NOT_FOUND' });
    await expect(BondRedemptionOsEngine.announce({ bondId: 7, kind: 'bogus', announcedBy: 't' })).rejects.toMatchObject({ code: 'BOND_REDEMPTION_INVALID' });
    const n = await BondRedemptionOsEngine.announce({ bondId: 7, announcedBy: 'trustee' });
    expect(n).toMatchObject({ status: 'announced', kind: 'maturity', direction: 'issuer', principalCents: 100_000_000, valueDate: '2026-06-30', bondName: 'DLB-PRB' });
    expect(KafkaEventBus.publish).toHaveBeenCalledWith(TOPICS.bondRedemptionAnnounced, expect.objectContaining({ noticeId: n.noticeId }), expect.anything());
  });

  it('record strike defaults the trust as sole holder and refuses allocations that do not foot', async () => {
    const n = await BondRedemptionOsEngine.announce({ bondId: 7, announcedBy: 'trustee' });
    await expect(BondRedemptionOsEngine.strikeRecord(n.noticeId, { holders: [{ holderRef: 'h1', amountCents: 1 }] })).rejects.toMatchObject({ code: 'BOND_REDEMPTION_UNBALANCED' });
    const struck = await BondRedemptionOsEngine.strikeRecord(n.noticeId, { actor: 'ops' });
    expect(struck.status).toBe('record_struck');
    expect(struck.recordDate).toBe('2026-06-30'); // past maturity: record date cannot postdate the value date
    expect(struck.allocations).toEqual([expect.objectContaining({ holderRef: 'trust:operating', amountCents: 100_000_000 })]);
  });

  it('clearing rejects with reasons, allows a re-strike, then clears', async () => {
    const n = await BondRedemptionOsEngine.announce({ bondId: 7, kind: 'maturity', valueDate: '2026-06-30', recordDate: '2026-07-15', announcedBy: 'trustee' });
    await BondRedemptionOsEngine.strikeRecord(n.noticeId, {});
    const rejected = await BondRedemptionOsEngine.clear(n.noticeId, { actor: 'ops' });
    expect(rejected.status).toBe('rejected');
    expect(rejected.clearing.reasons).toEqual([expect.stringMatching(/value date precedes record date/)]);
    await BondRedemptionOsEngine.strikeRecord(n.noticeId, { recordDate: '2026-06-15' });
    const cleared = await BondRedemptionOsEngine.clear(n.noticeId, { actor: 'ops' });
    expect(cleared.status).toBe('cleared');
    expect(cleared.clearing.ok).toBe(true);
  });

  it('nets cleared notices into a batch, blocks funding without cash, settles through the bond engine and posts the GL', async () => {
    const n = await BondRedemptionOsEngine.announce({ bondId: 7, announcedBy: 'trustee', reference: 'PRB-MATURITY-2026' });
    await BondRedemptionOsEngine.strikeRecord(n.noticeId, { holders: [{ holderRef: 'ben:1', holderName: 'Beneficiary One', amountCents: 60_000_000 }, { holderRef: 'ben:2', holderName: 'Beneficiary Two', amountCents: 40_000_000 }] });
    await BondRedemptionOsEngine.clear(n.noticeId, {});

    await expect(BondRedemptionOsEngine.openBatch({ direction: 'holder', openedBy: 'ops' })).rejects.toMatchObject({ code: 'BOND_REDEMPTION_EMPTY' });
    const b = await BondRedemptionOsEngine.openBatch({ direction: 'issuer', openedBy: 'ops' });
    expect(b).toMatchObject({ status: 'open', valueDate: '2026-06-30', noticeCount: 1, netCents: 100_000_000 });
    expect(b.legs).toEqual([expect.objectContaining({ holderRef: 'ben:1', amountCents: 60_000_000 }), expect.objectContaining({ holderRef: 'ben:2', amountCents: 40_000_000 })]);
    expect((await BondRedemptionOsEngine.notice(n.noticeId)).status).toBe('batched');

    await expect(BondRedemptionOsEngine.settleBatch(b.batchId, { settledBy: 'trustee' })).rejects.toMatchObject({ code: 'BOND_REDEMPTION_STATE' });
    await expect(BondRedemptionOsEngine.fundBatch(b.batchId, { fundedBy: 'trustee' })).rejects.toMatchObject({ code: 'BOND_REDEMPTION_UNFUNDED', details: expect.objectContaining({ availableCents: 0, requiredCents: 100_000_000 }) });
    (TrustAccountingEngine.getFundingPosition as any).mockResolvedValue({ available_balance_cents: 250_000_000 });
    const funded = await BondRedemptionOsEngine.fundBatch(b.batchId, { fundedBy: 'trustee' });
    expect(funded.status).toBe('funded');
    expect(funded.funding).toMatchObject({ funded: true, availableCents: 250_000_000 });

    const settled = await BondRedemptionOsEngine.settleBatch(b.batchId, { settledBy: 'trustee' });
    expect(settled.status).toBe('settled');
    expect(BondEngine.payPrincipal).toHaveBeenCalledWith(7, 1_000_000, {});
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      referenceType: 'bond_redemption', referenceId: n.noticeId, entryDate: '2026-06-30',
      lines: [expect.objectContaining({ accountCode: GL.BONDS_PAYABLE, debitAmount: 1_000_000 }), expect.objectContaining({ accountCode: GL.CASH, creditAmount: 1_000_000 })],
    }));
    expect(settled.settlement.results).toEqual([expect.objectContaining({ noticeId: n.noticeId, status: 'settled', bondTransactionId: '101', journalEntryId: 'JRN-1' })]);
    expect(settled.settlement.instructions).toEqual([
      expect.objectContaining({ holderRef: 'ben:1', amountCents: 60_000_000, direction: 'credit_holder' }),
      expect.objectContaining({ holderRef: 'ben:2', amountCents: 40_000_000 }),
    ]);
    expect(KafkaEventBus.publish).toHaveBeenCalledWith(TOPICS.bondRedemptionSettled, expect.objectContaining({ noticeId: n.noticeId, journalEntryId: 'JRN-1' }), expect.anything());
    expect(KafkaEventBus.publish).toHaveBeenCalledWith(TOPICS.ledgerPosted, expect.objectContaining({ referenceType: 'bond_redemption' }), expect.anything());
    expect((await BondRedemptionOsEngine.notice(n.noticeId))).toMatchObject({ status: 'settled', journalEntryId: 'JRN-1' });
    expect(s.bonds[0].status).toBe('matured');

    // settling again is refused: the batch is terminal
    await expect(BondRedemptionOsEngine.settleBatch(b.batchId, { settledBy: 'trustee' })).rejects.toMatchObject({ code: 'BOND_REDEMPTION_STATE' });
  });

  it('a full call before maturity marks the bond called and the holder-side entry derecognizes the investment', async () => {
    s.bonds[0].maturity_date = '2124-02-28';
    const n = await BondRedemptionOsEngine.announce({ bondId: 7, kind: 'call', direction: 'holder', valueDate: '2026-09-30', announcedBy: 'trustee' });
    await BondRedemptionOsEngine.strikeRecord(n.noticeId, { recordDate: '2026-09-15' });
    expect((await BondRedemptionOsEngine.clear(n.noticeId, {})).status).toBe('cleared');
    const b = await BondRedemptionOsEngine.openBatch({ direction: 'holder', openedBy: 'ops' });
    const funded = await BondRedemptionOsEngine.fundBatch(b.batchId, { fundedBy: 'trustee' });
    expect(funded.funding).toMatchObject({ required: false, funded: true });
    expect(TrustAccountingEngine.getFundingPosition).not.toHaveBeenCalled();
    const settled = await BondRedemptionOsEngine.settleBatch(b.batchId, { settledBy: 'trustee' });
    expect(settled.status).toBe('settled');
    expect(BondEngine.receivePrincipal).toHaveBeenCalledWith(7, 1_000_000, {});
    expect(TrustAccountingEngine.postJournalEntry).toHaveBeenCalledWith(expect.objectContaining({
      lines: [expect.objectContaining({ accountCode: GL.CASH, debitAmount: 1_000_000 }), expect.objectContaining({ accountCode: GL.BOND_INVESTMENTS, creditAmount: 1_000_000 })],
    }));
    expect(s.bonds[0].status).toBe('called');
  });

  it('a GL failure at settlement leaves the notice settled but unposted, and the DataBridge drain posts it', async () => {
    (TrustAccountingEngine.postJournalEntry as any).mockRejectedValueOnce(new Error('ledger offline'));
    const n = await BondRedemptionOsEngine.announce({ bondId: 7, announcedBy: 'trustee' });
    await BondRedemptionOsEngine.strikeRecord(n.noticeId, {});
    await BondRedemptionOsEngine.clear(n.noticeId, {});
    const b = await BondRedemptionOsEngine.openBatch({ openedBy: 'ops' });
    await BondRedemptionOsEngine.fundBatch(b.batchId, { fundedBy: 'trustee', force: true });
    const settled = await BondRedemptionOsEngine.settleBatch(b.batchId, { settledBy: 'trustee' });
    expect(settled.status).toBe('settled');
    expect(settled.settlement.results[0]).toMatchObject({ status: 'settled', journalEntryId: null, glError: 'ledger offline' });
    expect(await BondRedemptionOsEngine.unpostedSettlements()).toHaveLength(1);

    const { DataBridge } = require('../server/integrations/accounting/dataBridge');
    vi.spyOn(DataBridge, '_logSync').mockResolvedValue(undefined);
    const drained = await DataBridge.syncBondRedemptionsToAccounting();
    expect(drained).toMatchObject({ pending: 1, synced: 1, failed: 0 });
    expect((await BondRedemptionOsEngine.notice(n.noticeId)).journalEntryId).toBe('JRN-1');
    expect(await BondRedemptionOsEngine.unpostedSettlements()).toHaveLength(0);
  });

  it('cancelling a batch releases its notices back to cleared; a settled notice cannot be cancelled', async () => {
    const n = await BondRedemptionOsEngine.announce({ bondId: 7, announcedBy: 'trustee' });
    await BondRedemptionOsEngine.strikeRecord(n.noticeId, {});
    await BondRedemptionOsEngine.clear(n.noticeId, {});
    const b = await BondRedemptionOsEngine.openBatch({ openedBy: 'ops' });
    const cancelled = await BondRedemptionOsEngine.cancelBatch(b.batchId, { cancelledBy: 'ops', reason: 'wrong value date' });
    expect(cancelled.status).toBe('cancelled');
    expect((await BondRedemptionOsEngine.notice(n.noticeId))).toMatchObject({ status: 'cleared', batchId: null });
    const again = await BondRedemptionOsEngine.openBatch({ openedBy: 'ops' });
    expect(again.noticeCount).toBe(1);
    await BondRedemptionOsEngine.fundBatch(again.batchId, { fundedBy: 't', force: true });
    await BondRedemptionOsEngine.settleBatch(again.batchId, { settledBy: 't' });
    await expect(BondRedemptionOsEngine.cancelNotice(n.noticeId, {})).rejects.toMatchObject({ code: 'BOND_REDEMPTION_STATE' });
  });

  it('preflight touches nothing and reports the same gate result', async () => {
    const r = await BondRedemptionOsEngine.preflight({ bondId: 7, kind: 'maturity', valueDate: '2026-01-01' });
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/use kind 'call'/);
    expect(s.t.bond_redemption_notices).toHaveLength(0);
    expect(s.t.bond_redemption_events).toHaveLength(0);
  });
});

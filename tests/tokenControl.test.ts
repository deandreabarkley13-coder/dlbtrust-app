import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CapControlEngine } = require('../server/integrations/os/capControlEngine');
const { IntegrityControlEngine } = require('../server/integrations/os/integrityControlEngine');
const { IssuanceOsEngine } = require('../server/integrations/os/issuanceOsEngine');
const { MintExchangeOsEngine } = require('../server/integrations/os/mintExchangeOsEngine');
const { BondTokenizationEngine } = require('../server/integrations/dapp/bondTokenizationEngine');
const { BondEngine } = require('../server/integrations/bonds/bondEngine');
const pool = require('../server/integrations/bonds/pgPool');

type Row = Record<string, any>;

function token(over: Row = {}): Row {
  return {
    id: 'BT-1',
    bond_id: 7,
    bond_name: 'DLB-PRB',
    token_name: 'DLB Private Placement Bond',
    token_symbol: 'DLB-PRB',
    token_address: 'shadow-dlb-prb',
    total_supply: 0,
    tokenized_principal: 0,
    tokenized_interest: 0,
    status: 'active',
    metadata: { decimals: 6 },
    ...over,
  };
}

/**
 * The token, holder, issuance and movement tables answered from memory, so a
 * ticket can be raised, approved, minted and burned exactly as the engines
 * write it. Amounts in these tables are dollars, as they are in Postgres.
 */
function store({
  tokens = [token()] as Row[],
  holders = [] as Row[],
  bonds = [{
    id: 7,
    bond_name: 'DLB-PRB',
    bond_identifier: '19781443-DLB-PRB',
    isin: 'US-DLB-PRB-2024',
    principal_balance: 1_000_000,
    accrued_interest: 5_000,
  }] as Row[],
  issuances = [] as Row[],
  movements = [] as Row[],
} = {}) {
  const runs: Row[] = [];

  const run = async (sql: any, params: any[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(CREATE|BEGIN|COMMIT|ROLLBACK|ALTER)/.test(text)) return { rows: [] };
    if (/to_regclass/.test(text)) return { rows: [{ present: true }] };

    if (/^SELECT \* FROM bond_tokens WHERE id/.test(text)) {
      return { rows: tokens.filter(t => t.id === params[0]) };
    }
    if (/SELECT id FROM bond_tokens WHERE status/.test(text)) {
      return { rows: tokens.filter(t => t.status === 'active').map(t => ({ id: t.id })) };
    }
    if (/FROM bond_tokens WHERE bond_id = \$1 AND status/.test(text)) {
      const active = tokens.filter(t => t.bond_id === params[0] && t.status === 'active');
      return {
        rows: [{
          principal: active.reduce((sum, t) => sum + Number(t.tokenized_principal), 0),
          interest: active.reduce((sum, t) => sum + Number(t.tokenized_interest), 0),
          supply: active.reduce((sum, t) => sum + Number(t.total_supply), 0),
        }],
      };
    }
    if (/FROM bond_tokens WHERE bond_id = \$1 ORDER BY/.test(text)) {
      return { rows: tokens.filter(t => t.bond_id === params[0]) };
    }
    if (/COALESCE\(tokenized_principal, 0\)/.test(text)) {
      const found = tokens.find(t => t.id === params[0]);
      return {
        rows: [{
          principal: Number(found?.tokenized_principal || 0),
          interest: Number(found?.tokenized_interest || 0),
          supply: Number(found?.total_supply || 0),
        }],
      };
    }
    if (/SUM\(total_supply\) AS supply FROM bond_tokens WHERE status/.test(text)) {
      return {
        rows: [{
          supply: tokens.filter(t => t.status === 'active')
            .reduce((sum, t) => sum + Number(t.total_supply), 0),
        }],
      };
    }
    if (/FROM bonds WHERE/.test(text)) {
      const ref = String(params[1] || '').toUpperCase();
      return {
        rows: bonds.filter(b => (params[0] !== null && b.id === params[0])
          || String(b.bond_identifier || '').toUpperCase() === ref
          || String(b.bond_name).toUpperCase() === ref
          || String(b.isin || '').toUpperCase() === ref),
      };
    }

    if (/SUM\(balance\), 0\) AS total/.test(text)) {
      const mine = holders.filter(h => h.token_id === params[0]);
      return {
        rows: [{
          total: mine.reduce((sum, h) => sum + Number(h.balance), 0),
          negatives: mine.filter(h => Number(h.balance) < 0).length,
        }],
      };
    }
    if (/SELECT balance FROM bond_token_holders WHERE token_id = \$1 AND holder_address/.test(text)) {
      return { rows: holders.filter(h => h.token_id === params[0] && h.holder_address === params[1]) };
    }
    if (/SELECT holder_address, balance FROM bond_token_holders/.test(text)) {
      return { rows: holders.filter(h => h.token_id === params[0] && Number(h.balance) > 0) };
    }

    if (/FROM token_issuances WHERE status = ANY/.test(text) && /SUM\(principal_cents\)/.test(text)) {
      const open = issuances.filter((i) => {
        if (!params[0].includes(i.status)) return false;
        if (String(text).includes('bond_id = $2') && i.bond_id !== params[1]) return false;
        if (String(text).includes('token_id = $2') && i.token_id !== params[1]) return false;
        const excluded = params[2];
        return !excluded || i.issuance_id !== excluded;
      });
      return {
        rows: [{
          principal: open.reduce((sum, i) => sum + Number(i.principal_cents), 0),
          interest: open.reduce((sum, i) => sum + Number(i.interest_cents), 0),
        }],
      };
    }
    if (/INSERT INTO token_issuances/.test(text)) {
      const row = {
        issuance_id: params[0], token_id: params[1], bond_id: params[2],
        principal_cents: params[3], interest_cents: params[4], status: 'pending_approval',
        holder_address: params[5], initiated_by: params[6], memo: params[7],
        approved_by: null, rejected_by: null, chain_reference: null,
      };
      issuances.push(row);
      return { rows: [row] };
    }
    if (/UPDATE token_issuances/.test(text)) {
      const row = issuances.find(i => i.issuance_id === params[0]);
      if (!row) return { rows: [] };
      if (/status = 'approved'/.test(text)) Object.assign(row, { status: 'approved', approved_by: params[1] });
      if (/status = 'consumed'/.test(text)) Object.assign(row, { status: 'consumed', chain_reference: params[1] });
      if (/status = 'rejected'/.test(text)) Object.assign(row, { status: 'rejected', rejected_by: params[1] });
      return { rows: [row] };
    }
    if (/SELECT \* FROM token_issuances WHERE issuance_id/.test(text)) {
      return { rows: issuances.filter(i => i.issuance_id === params[0]) };
    }
    if (/SELECT \* FROM token_issuances/.test(text)) {
      return { rows: issuances };
    }

    if (/INSERT INTO token_movements/.test(text)) {
      const kindFromSql = /'mint'/.test(text) ? 'mint' : null;
      const row = kindFromSql === 'mint'
        ? {
          movement_id: params[0], kind: 'mint', token_id: params[1], bond_id: params[2],
          issuance_id: params[3], holder_address: params[4], principal_cents: params[5],
          interest_cents: params[6], status: 'executing', initiated_by: params[7],
          approved_by: params[8],
        }
        : {
          movement_id: params[0], kind: params[1], token_id: params[2], bond_id: params[3],
          holder_address: params[4], principal_cents: params[5], interest_cents: params[6],
          status: 'pending_approval', initiated_by: params[7], memo: params[8],
          approved_by: null, issuance_id: null,
        };
      movements.push(row);
      return { rows: [row] };
    }
    if (/UPDATE token_movements/.test(text)) {
      const id = /movement_id = \$1/.test(text) ? params[0] : null;
      const row = movements.find(m => m.movement_id === id);
      if (!row) return { rows: [] };
      if (/status = 'approved'/.test(text)) Object.assign(row, { status: 'approved', approved_by: params[1] });
      if (/status = 'executing'/.test(text)) Object.assign(row, { status: 'executing' });
      if (/status = 'executed'/.test(text)) Object.assign(row, { status: 'executed', chain_reference: params[1] });
      if (/status = 'failed'/.test(text)) Object.assign(row, { status: 'failed', failure_reason: params[1] });
      if (/status = 'cancelled'/.test(text)) Object.assign(row, { status: 'cancelled' });
      return { rows: [row] };
    }
    if (/SELECT \* FROM token_movements WHERE movement_id/.test(text)) {
      return { rows: movements.filter(m => m.movement_id === params[0]) };
    }
    if (/SELECT \* FROM token_movements/.test(text)) {
      return { rows: movements };
    }
    if (/INSERT INTO integrity_control_runs/.test(text)) {
      const row = {
        run_id: params[0], tokens: params[1], findings: params[2],
        blocking: params[3], clean: params[4], checked_by: params[6],
      };
      runs.push(row);
      return { rows: [row] };
    }

    if (/UPDATE bond_tokens SET total_supply/.test(text)) {
      const found = tokens.find(t => t.id === params[3]);
      if (found) {
        Object.assign(found, {
          total_supply: params[0], tokenized_principal: params[1], tokenized_interest: params[2],
        });
      }
      return { rows: [] };
    }
    if (/INSERT INTO bond_token_holders/.test(text)) {
      const existing = holders.find(h => h.token_id === params[1] && h.holder_address === params[2]);
      if (existing) existing.balance = Number(existing.balance) + Number(params[3]);
      else holders.push({ token_id: params[1], holder_address: params[2], balance: Number(params[3]) });
      return { rows: [] };
    }
    if (/UPDATE bond_token_holders SET balance = balance - /.test(text)) {
      const existing = holders.find(h => h.token_id === params[0] && h.holder_address === params[1]);
      if (!existing || Number(existing.balance) < Number(params[2])) return { rows: [] };
      existing.balance = Number(existing.balance) - Number(params[2]);
      return { rows: [{ balance: existing.balance }] };
    }
    if (/SELECT \* FROM bond_token_holders WHERE token_id/.test(text)) {
      return { rows: holders.filter(h => h.token_id === params[0]) };
    }

    return { rows: [] };
  };

  vi.spyOn(pool, 'query').mockImplementation(run as any);
  vi.spyOn(BondEngine, 'getBond').mockImplementation(async (bondId: any) => (
    bonds.find(b => b.id === Number(bondId)) || null
  ));
  vi.spyOn(BondTokenizationEngine, 'getConfig').mockReturnValue({ shadow: true } as any);

  return { tokens, holders, issuances, movements, runs };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TOKEN_DECLARED_CEILINGS;
  delete process.env.TOKEN_ISSUANCE_GLOBAL_CEILING_CENTS;
});

describe('Cap Control: what the bond backs', () => {
  it('takes the ceiling from the bond ledger, not from the caller', async () => {
    store();
    const headroom = await CapControlEngine.headroom('BT-1');
    expect(headroom.ceiling.basis).toBe('bond');
    expect(headroom.ceiling.principalCents).toBe(100_000_000);
    expect(headroom.ceiling.interestCents).toBe(500_000);
    expect(headroom.totalCents).toBe(100_500_000);
  });

  it('refuses a mint larger than the outstanding principal', async () => {
    store();
    await expect(CapControlEngine.assertIssuable({
      tokenId: 'BT-1', principalCents: 100_000_001,
    })).rejects.toThrow(/more token in existence than backs it/);
  });

  it('caps interest against accrued interest, not against principal headroom', async () => {
    store();
    const assessment = await CapControlEngine.assess({ tokenId: 'BT-1', interestCents: 600_000 });
    expect(assessment.allowed).toBe(false);
    expect(assessment.breaches.join(' ')).toMatch(/interest: \$6000.00 requested/);
  });

  it('shares one bond ceiling across every token standing on that bond', async () => {
    store({
      tokens: [
        token({ tokenized_principal: 900_000, total_supply: 900_000 }),
        token({ id: 'BT-2', token_symbol: 'DLB-PRB-B' }),
      ],
    });
    const headroom = await CapControlEngine.headroom('BT-2');
    expect(headroom.issued.principalCents).toBe(90_000_000);
    expect(headroom.principalCents).toBe(10_000_000);
  });

  it('holds headroom for open tickets so two approvals cannot spend it twice', async () => {
    store({
      issuances: [{
        issuance_id: 'ISS-1', token_id: 'BT-1', bond_id: 7,
        principal_cents: 100_000_000, interest_cents: 0, status: 'pending_approval',
      }],
    });
    const headroom = await CapControlEngine.headroom('BT-1');
    expect(headroom.reserved.principalCents).toBe(100_000_000);
    expect(headroom.principalCents).toBe(0);
    await expect(CapControlEngine.assertIssuable({
      tokenId: 'BT-1', principalCents: 1_000,
    })).rejects.toThrow(/reserved/);
  });

  it('refuses an unbacked token that has no declared ceiling', async () => {
    store({ tokens: [token({ bond_id: null, token_symbol: 'DLBUSD' })] });
    await expect(CapControlEngine.headroom('BT-1'))
      .rejects.toThrow(/no declared ceiling/);
  });

  it('governs an unbacked token by its declared ceiling', async () => {
    process.env.TOKEN_DECLARED_CEILINGS = JSON.stringify({ DLBUSD: 500_000 });
    store({ tokens: [token({ bond_id: null, token_symbol: 'DLBUSD' })] });
    const headroom = await CapControlEngine.headroom('BT-1');
    expect(headroom.ceiling.basis).toBe('declared');
    expect(headroom.totalCents).toBe(500_000);
    await expect(CapControlEngine.assertIssuable({ tokenId: 'BT-1', principalCents: 500_001 }))
      .rejects.toThrow(/declared ceiling/);
  });

  it('applies the trust-wide ceiling on top of the bond one', async () => {
    process.env.TOKEN_ISSUANCE_GLOBAL_CEILING_CENTS = '100000';
    store();
    const assessment = await CapControlEngine.assess({ tokenId: 'BT-1', principalCents: 200_000 });
    expect(assessment.allowed).toBe(false);
    expect(assessment.breaches.join(' ')).toMatch(/trust-wide ceiling/);
  });

  it('names the burn a paid-down bond requires', async () => {
    store({
      tokens: [token({ tokenized_principal: 1_000_000, total_supply: 1_000_000 })],
      bonds: [{ id: 7, bond_name: 'DLB-PRB', principal_balance: 400_000, accrued_interest: 0 }],
    });
    const excess = await CapControlEngine.excess('BT-1');
    expect(excess.totalCents).toBe(60_000_000);
  });

  it('finds a bond by the trust identifier rather than assuming a row id', async () => {
    store();
    const summary = await CapControlEngine.bondSummary('19781443-DLB-PRB');
    expect(summary.bond.id).toBe(7);
    expect(summary.ceiling.totalCents).toBe(100_500_000);
    expect(summary.tokens).toHaveLength(1);
  });
});

describe('Integrity Control: whether the books agree', () => {
  it('passes a token whose components, holders and ceiling reconcile', async () => {
    store({
      tokens: [token({ total_supply: 1_000, tokenized_principal: 1_000 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xoperator', balance: 1_000 }],
    });
    const report = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    expect(report.clean).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('catches supply that does not equal its own components', async () => {
    store({
      tokens: [token({ total_supply: 1_500, tokenized_principal: 1_000 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xoperator', balance: 1_500 }],
    });
    const report = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    expect(report.findings.map((f: Row) => f.code)).toContain('COMPONENT_MISMATCH');
    expect(report.clean).toBe(false);
  });

  it('catches a holder register that does not add up to supply', async () => {
    store({
      tokens: [token({ total_supply: 1_000, tokenized_principal: 1_000 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xoperator', balance: 400 }],
    });
    const report = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    const finding = report.findings.find((f: Row) => f.code === 'HOLDER_SUM_MISMATCH');
    expect(finding.detail).toMatch(/unaccounted/);
  });

  it('catches a negative holder balance', async () => {
    store({
      tokens: [token({ total_supply: 0, tokenized_principal: 0 })],
      holders: [
        { token_id: 'BT-1', holder_address: '0xa', balance: 500 },
        { token_id: 'BT-1', holder_address: '0xb', balance: -500 },
      ],
    });
    const report = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    expect(report.findings.map((f: Row) => f.code)).toContain('NEGATIVE_BALANCE');
  });

  it('reports the burn required once the bond has been paid down', async () => {
    store({
      tokens: [token({ total_supply: 1_000_000, tokenized_principal: 1_000_000 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xoperator', balance: 1_000_000 }],
      bonds: [{ id: 7, bond_name: 'DLB-PRB', principal_balance: 400_000, accrued_interest: 0 }],
    });
    const report = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    const overCap = report.findings.find((f: Row) => f.code === 'OVER_CAP');
    expect(overCap.remediation).toMatchObject({ action: 'burn', amountCents: 60_000_000 });
  });

  it('treats an ungoverned token with supply as blocking and an empty one as advisory', async () => {
    store({
      tokens: [token({ bond_id: null, token_symbol: 'DLBUSD', total_supply: 500, tokenized_principal: 500 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xa', balance: 500 }],
    });
    const withSupply = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    expect(withSupply.clean).toBe(false);

    vi.restoreAllMocks();
    store({ tokens: [token({ bond_id: null, token_symbol: 'DLBUSD' })] });
    const empty = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    expect(empty.findings[0].severity).toBe('advisory');
    expect(empty.clean).toBe(true);
  });

  it('does not claim a chain reading in shadow mode', async () => {
    store({
      tokens: [token({ token_address: '0xdeployed', total_supply: 0 })],
    });
    const report = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    expect(report.tokens[0].chainSupplyCents).toBeNull();
    expect(report.findings.map((f: Row) => f.code)).not.toContain('CHAIN_SUPPLY_MISMATCH');
  });

  it('catches a contract whose supply disagrees with the ledger in live mode', async () => {
    store({
      tokens: [token({ token_address: '0xdeployed', total_supply: 1_000, tokenized_principal: 1_000 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xa', balance: 1_000 }],
    });
    vi.spyOn(BondTokenizationEngine, 'getConfig').mockReturnValue({ shadow: false } as any);
    vi.spyOn(BondTokenizationEngine, 'chainSupply').mockResolvedValue(2_000 as any);
    const report = await IntegrityControlEngine.check({ tokenId: 'BT-1' });
    const finding = report.findings.find((f: Row) => f.code === 'CHAIN_SUPPLY_MISMATCH');
    expect(finding.detail).toMatch(/contract reports \$2000.00 but the ledger records \$1000.00/);
  });
});

describe('Issuance OS: the ticket', () => {
  it('refuses a ticket while the books are breached', async () => {
    store({
      tokens: [token({ total_supply: 1_500, tokenized_principal: 1_000 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xa', balance: 1_500 }],
    });
    await expect(IssuanceOsEngine.request({
      tokenId: 'BT-1', principalCents: 1_000, initiatedBy: 'trustee-one',
    })).rejects.toThrow(/cannot issue while its records disagree/);
  });

  it('will not let the requesting trustee approve their own ticket', async () => {
    store();
    const { issuance } = await IssuanceOsEngine.request({
      tokenId: 'BT-1', principalCents: 1_000, initiatedBy: 'trustee-one',
    });
    await expect(IssuanceOsEngine.approve(issuance.issuance_id, 'TRUSTEE-ONE'))
      .rejects.toThrow(/cannot also approve/);
  });

  it('re-checks the ceiling at approval, because the bond can be paid down after the request', async () => {
    const state = store();
    const { issuance } = await IssuanceOsEngine.request({
      tokenId: 'BT-1', principalCents: 100_000_000, initiatedBy: 'trustee-one',
    });
    state.tokens[0].bond_id = 7;
    vi.spyOn(BondEngine, 'getBond').mockResolvedValue({
      id: 7, bond_name: 'DLB-PRB', principal_balance: 10_000, accrued_interest: 0,
    } as any);
    await expect(IssuanceOsEngine.approve(issuance.issuance_id, 'trustee-two'))
      .rejects.toThrow(/no longer backed/);
  });

  it('refuses to authorise an amount the ticket does not carry', async () => {
    store();
    const { issuance } = await IssuanceOsEngine.request({
      tokenId: 'BT-1', principalCents: 1_000, initiatedBy: 'trustee-one',
    });
    await IssuanceOsEngine.approve(issuance.issuance_id, 'trustee-two');
    await expect(IssuanceOsEngine.authorize({
      issuanceId: issuance.issuance_id, tokenId: 'BT-1', principalCents: 5_000,
    })).rejects.toThrow(/authorises \$10.00 principal/);
  });

  it('returns the headroom a rejected ticket was holding', async () => {
    store();
    const { issuance } = await IssuanceOsEngine.request({
      tokenId: 'BT-1', principalCents: 100_000_000, initiatedBy: 'trustee-one',
    });
    expect((await CapControlEngine.headroom('BT-1')).principalCents).toBe(0);
    await IssuanceOsEngine.reject(issuance.issuance_id, { rejectedBy: 'trustee-two' });
    expect((await CapControlEngine.headroom('BT-1')).principalCents).toBe(100_000_000);
  });
});

describe('Mint & Exchange OS: the act', () => {
  async function approvedTicket(principalCents = 1_000) {
    const { issuance } = await IssuanceOsEngine.request({
      tokenId: 'BT-1', principalCents, holderAddress: '0xoperator', initiatedBy: 'trustee-one',
    });
    return IssuanceOsEngine.approve(issuance.issuance_id, 'trustee-two');
  }

  it('refuses to mint without a ticket', async () => {
    store();
    await expect(MintExchangeOsEngine.mint({}))
      .rejects.toThrow(/needs an approved issuance/);
  });

  it('mints the ticket amount and consumes the ticket', async () => {
    const state = store();
    const ticket = await approvedTicket();
    const result = await MintExchangeOsEngine.mint({
      issuanceId: ticket.issuance_id, mintedBy: 'trustee-two',
    });
    expect(result.movement.status).toBe('executed');
    expect(state.tokens[0].total_supply).toBe(10);
    expect(state.holders[0]).toMatchObject({ holder_address: '0xoperator', balance: 10 });
    expect(result.issuance.status).toBe('consumed');
  });

  it('will not spend the same ticket twice', async () => {
    store();
    const ticket = await approvedTicket();
    await MintExchangeOsEngine.mint({ issuanceId: ticket.issuance_id });
    await expect(MintExchangeOsEngine.mint({ issuanceId: ticket.issuance_id }))
      .rejects.toThrow(/is consumed; a mint needs an approved issuance/);
  });

  it('refuses a ticket that authorises something other than the caller intended', async () => {
    store();
    const ticket = await approvedTicket();
    await expect(MintExchangeOsEngine.mint({
      issuanceId: ticket.issuance_id,
      expect: { tokenId: 'BT-1', principalCents: 99_999 },
    })).rejects.toThrow(/authorises \$10.00, not \$999.99/);
  });

  it('re-runs the integrity check immediately before the mint', async () => {
    store();
    const ticket = await approvedTicket();
    const gate = vi.spyOn(IntegrityControlEngine, 'assertClean');
    await MintExchangeOsEngine.mint({ issuanceId: ticket.issuance_id });
    expect(gate).toHaveBeenCalledWith('BT-1');
  });

  it('will not burn token a holder does not hold', async () => {
    store({
      tokens: [token({ total_supply: 100, tokenized_principal: 100 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xoperator', balance: 100 }],
    });
    await expect(MintExchangeOsEngine.request({
      kind: 'burn', tokenId: 'BT-1', holderAddress: '0xstranger',
      principalCents: 1_000, initiatedBy: 'trustee-one',
    })).rejects.toThrow(/0xstranger holds \$0.00 of BT-1/);
  });

  it('burns under dual control, bringing a paid-down bond back under its cap', async () => {
    const state = store({
      tokens: [token({ total_supply: 1_000_000, tokenized_principal: 1_000_000 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xoperator', balance: 1_000_000 }],
      bonds: [{ id: 7, bond_name: 'DLB-PRB', principal_balance: 400_000, accrued_interest: 0 }],
    });
    const required = await MintExchangeOsEngine.burnRequired('BT-1');
    expect(required.requiredCents).toBe(60_000_000);

    const movement = await MintExchangeOsEngine.request({
      kind: 'burn', tokenId: 'BT-1', holderAddress: '0xoperator',
      principalCents: required.requiredCents, initiatedBy: 'trustee-one',
    });
    await expect(MintExchangeOsEngine.approve(movement.movement_id, 'trustee-one'))
      .rejects.toThrow(/cannot also approve/);
    await MintExchangeOsEngine.approve(movement.movement_id, 'trustee-two');
    const executed = await MintExchangeOsEngine.execute(movement.movement_id);

    expect(executed.movement.status).toBe('executed');
    expect(state.tokens[0].total_supply).toBe(400_000);
    expect(state.holders[0].balance).toBe(400_000);
    expect((await MintExchangeOsEngine.burnRequired('BT-1')).requiredCents).toBe(0);
  });

  it('leaves an exchange owing the holder rather than calling it settled', async () => {
    store({
      tokens: [token({ total_supply: 1_000, tokenized_principal: 1_000 })],
      holders: [{ token_id: 'BT-1', holder_address: '0xbeneficiary', balance: 1_000 }],
    });
    const movement = await MintExchangeOsEngine.request({
      kind: 'exchange', tokenId: 'BT-1', holderAddress: '0xbeneficiary',
      principalCents: 100_000, initiatedBy: 'trustee-one',
    });
    await MintExchangeOsEngine.approve(movement.movement_id, 'trustee-two');
    const executed = await MintExchangeOsEngine.execute(movement.movement_id, {
      settlementReference: 'DISB-PENDING',
    });
    expect(executed.obligation).toMatchObject({
      owedToHolder: '0xbeneficiary', amountCents: 100_000, settled: false,
    });
  });

  it('refuses a mint raised as a movement, because supply comes from a ticket', async () => {
    store();
    await expect(MintExchangeOsEngine.request({
      kind: 'mint', tokenId: 'BT-1', holderAddress: '0xoperator',
      principalCents: 1_000, initiatedBy: 'trustee-one',
    })).rejects.toThrow(/raised through Issuance OS/);
  });
});

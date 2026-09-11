'use strict';

/**
 * SpritzFiatFundingEngine — the fiat funding leg: Treasury-Core Banking ERP
 * canonical GL --(ERP-originated ACH / wire credit push)--> Spritz auto-ramp
 * account --(auto-converts)--> USDC at the TrustDistributionPolicy contract.
 *
 * No USDC is bought or moved by the ERP and no bank is debited: the ERP's own
 * payment origination (ACHEngine NACHA batches / WireOriginationEngine via
 * BankTransferEngine.pushCredit) pushes fiat from the canonical cash account
 * to the virtual bank account Spritz opens in the trust's name. Spritz turns
 * the deposit into USDC at the policy contract, from where the existing
 * governed payout leg (SpritzTreasuryLegEngine) pays ACH / RTP / wire / Bill
 * Pay at settlement.
 *
 * Every step is fail-closed and idempotent on the ERP reference:
 *   capability (fiat_to_crypto ach_credit / wire must be `active`)
 *   → auto-ramp account for the policy contract (`active`)
 *   → Collateral OS spendable headroom (when the facility carries pledges)
 *   → ERP canonical commit (Dr USDC treasury / Cr canonical cash)
 *   → credit-push origination (bank_transfers row + ACH batch / wire payout)
 *   → transmit → Spritz on-ramp record → USDC read back on the contract.
 * A funding is only `completed` once Spritz reports the on-ramp completed.
 */

const { SpritzEngine } = require('./spritzEngine');
const { TrustPolicyEngine } = require('../dapp/trustPolicyEngine');
const { TrustAllocationEngine } = require('../dapp/trustAllocationEngine');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
let CanonicalFundingSource;
try { ({ CanonicalFundingSource } = require('../fineract/canonicalFundingSource')); } catch (e) { CanonicalFundingSource = null; }
let BankTransferEngine;
try { ({ BankTransferEngine } = require('../dapp/bankTransferEngine')); } catch (e) { BankTransferEngine = null; }
let SystemSettings;
try { ({ SystemSettings } = require('../ach/systemSettings')); } catch (e) { SystemSettings = null; }
let AS2Partners;
try { ({ AS2Partners } = require('../ach/as2Partners')); } catch (e) { AS2Partners = null; }
let PartnerBankRails;
try { ({ PartnerBankRails } = require('../rails/partnerBankRails')); } catch (e) { PartnerBankRails = null; }

const TABLE = 'spritz_fiat_fundings';
const STATUSES = ['prepared', 'submitted', 'awaiting_payment', 'processing', 'completed', 'failed', 'cancelled'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// ERP credit-push rail -> Spritz fiat_to_crypto capability method / on-ramp input rail.
const RAILS = {
  ach: { capability: 'ach_credit', onRampRail: 'ach_credit', depositRail: 'ach', label: 'ACH credit (ERP originated)' },
  wire: { capability: 'wire', onRampRail: 'wire', depositRail: 'wire', label: 'Wire (ERP originated)' },
};

function str(name, def = '') { return (process.env[name] || def).trim(); }
function httpError(status, message, code) { return Object.assign(new Error(message), { status, code }); }
function badRequest(message, code = 'BAD_REQUEST') { return httpError(400, message, code); }
function conflict(message, code) { return httpError(409, message, code); }
function sameAddress(a, b) { return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase(); }
function usd(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('amountUsd must be a positive number');
  return Math.round(n * 100) / 100;
}

let tableReady = null;
async function ensureTable() {
  if (!pool || !pool.query) return;
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        reference TEXT PRIMARY KEY,
        bucket TEXT,
        amount_usd NUMERIC(18,2) NOT NULL,
        rail TEXT NOT NULL,
        auto_ramp_account_id TEXT,
        deposit_instructions JSONB,
        source_account TEXT,
        erp_commit JSONB,
        transfer_id TEXT,
        transfer_status TEXT,
        onramp_id TEXT,
        onramp JSONB,
        status TEXT NOT NULL,
        error TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`).catch((e) => { tableReady = null; throw e; });
  }
  await tableReady;
}

function mapRow(r) {
  if (!r) return null;
  return {
    reference: r.reference,
    bucket: r.bucket,
    amountUsd: Number(r.amount_usd),
    rail: r.rail,
    autoRampAccountId: r.auto_ramp_account_id,
    depositInstructions: r.deposit_instructions || null,
    sourceAccount: r.source_account,
    erpCommit: r.erp_commit || null,
    transferId: r.transfer_id,
    transferStatus: r.transfer_status,
    onRampId: r.onramp_id,
    onRamp: r.onramp || null,
    status: r.status,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function loadLeg() {
  // Lazy: SpritzTreasuryLegEngine and CollateralOsEngine both import this module's siblings.
  return require('./spritzTreasuryLegEngine').SpritzTreasuryLegEngine;
}
function loadCollateralOs() {
  try { return require('../os/collateralOsEngine').CollateralOsEngine; } catch (e) { return null; }
}

class SpritzFiatFundingEngine {
  static config() {
    const leg = loadLeg().config();
    return {
      policyAddress: leg.policyAddress,
      chainId: leg.chainId,
      network: leg.network,
      token: 'USDC',
      defaultRail: str('SPRITZ_FIAT_FUNDING_RAIL', 'ach'),
      autoRampAccountId: str('SPRITZ_AUTO_RAMP_ACCOUNT_ID') || null,
      // 'auto' gates on Collateral OS headroom whenever the facility holds live pledges; 'always' / 'never' force it.
      collateralGate: str('SPRITZ_FIAT_FUNDING_COLLATERAL_GATE', 'auto').toLowerCase(),
      fundingSource: leg.fundingSource,
      gl: leg.gl,
    };
  }

  static rails() { return Object.entries(RAILS).map(([rail, r]) => ({ rail, ...r })); }

  /** Spritz fiat_to_crypto capability for an ERP rail; fail-closed unless `active`. */
  static async capability(rail) {
    const spec = RAILS[rail];
    if (!spec) throw badRequest(`unsupported ERP credit-push rail ${rail}; use ${Object.keys(RAILS).join(' or ')}`, 'FIAT_FUNDING_RAIL_UNSUPPORTED');
    const caps = await SpritzEngine.capabilities();
    const cap = (Array.isArray(caps) ? caps : []).find((c) => c.product === 'fiat_to_crypto' && c.method === spec.capability) || null;
    const requirements = cap && Array.isArray(cap.requirements) ? cap.requirements : [];
    return {
      rail,
      method: spec.capability,
      status: cap ? cap.status : 'missing',
      active: Boolean(cap && cap.status === 'active'),
      requirements: requirements.map((r) => ({ type: r.type || r.name || null, status: r.status || null, actionUrl: r.actionUrl || r.url || null })),
    };
  }

  /**
   * The trust's Spritz auto-ramp account for the policy contract (USDC on the
   * policy chain). Found by SPRITZ_AUTO_RAMP_ACCOUNT_ID or by matching
   * destination; created only when `ensure` is set.
   */
  static async account({ ensure = false } = {}) {
    const cfg = this.config();
    if (!cfg.policyAddress) throw conflict('TRUST_POLICY_ADDRESS not configured', 'TRUST_POLICY_NOT_CONFIGURED');
    if (!cfg.network) throw badRequest(`chain ${cfg.chainId} is not a Spritz network`);
    const list = await SpritzEngine.listAutoRampAccounts();
    const accounts = Array.isArray(list) ? list : (list && Array.isArray(list.data) ? list.data : []);
    const matches = (a) => sameAddress(a.address, cfg.policyAddress)
      && String(a.network || '').toLowerCase() === cfg.network
      && String(a.token || '').toUpperCase() === cfg.token;
    let match = cfg.autoRampAccountId ? accounts.find((a) => a.id === cfg.autoRampAccountId) || null : null;
    if (match && !matches(match)) {
      throw conflict(`SPRITZ_AUTO_RAMP_ACCOUNT_ID ${match.id} converts to ${match.address} on ${match.network}, not the policy contract ${cfg.policyAddress} on ${cfg.network}`, 'AUTO_RAMP_ACCOUNT_MISMATCH');
    }
    if (!match) match = accounts.find(matches) || null;
    let created = false;
    if (!match && ensure) {
      match = await SpritzEngine.createAutoRampAccount({ address: cfg.policyAddress, network: cfg.network, token: cfg.token });
      created = true;
    }
    if (!match) return null;
    const di = match.depositInstructions || null;
    return {
      id: match.id,
      status: match.status || null,
      active: String(match.status || '').toLowerCase() === 'active',
      address: match.address,
      network: match.network,
      token: match.token,
      currency: match.currency || 'USD',
      created,
      depositInstructions: di ? {
        type: di.type || 'us',
        bankName: di.bankName || null,
        bankAddress: di.bankAddress || null,
        bankRoutingNumber: di.bankRoutingNumber || null,
        bankAccountNumber: di.bankAccountNumber || null,
        paymentRails: Array.isArray(di.paymentRails) ? di.paymentRails : [],
      } : null,
    };
  }

  static async estimate({ amountUsd } = {}) {
    const amount = usd(amountUsd);
    const account = await this.account();
    if (!account) throw conflict('no Spritz auto-ramp account for the policy contract; call account({ ensure: true }) first', 'AUTO_RAMP_ACCOUNT_MISSING');
    const estimate = await SpritzEngine.estimateAutoRampDeposit(account.id, { amount });
    return { accountId: account.id, amountUsd: amount.toFixed(2), estimate };
  }

  /** Collateral OS spendable headroom for a funding of `amount`. */
  static async collateralHeadroom(amount) {
    const cfg = this.config();
    const Cos = loadCollateralOs();
    if (!Cos || cfg.collateralGate === 'never') return { gated: false, reason: cfg.collateralGate === 'never' ? 'SPRITZ_FIAT_FUNDING_COLLATERAL_GATE=never' : 'Collateral OS not available' };
    let facility;
    try { facility = await Cos.facility(); } catch (e) { return { gated: false, reason: `Collateral OS unavailable: ${e.message}` }; }
    const hasPledges = Array.isArray(facility.byPosition) && facility.byPosition.length > 0;
    const gated = cfg.collateralGate === 'always' || (cfg.collateralGate === 'auto' && hasPledges);
    return {
      gated,
      spendableUsd: facility.spendableUsd,
      drawnUsd: facility.drawnUsd,
      availableUsd: facility.availableUsd,
      positions: hasPledges ? facility.byPosition.length : 0,
      sufficient: !gated || Number(facility.availableUsd || 0) >= amount,
    };
  }

  static async readiness() {
    const cfg = this.config();
    const issues = [];
    if (!str('SPRITZ_API_KEY')) issues.push('SPRITZ_API_KEY not configured');
    if (!cfg.policyAddress) issues.push('TRUST_POLICY_ADDRESS not configured');
    if (!cfg.network) issues.push(`chain ${cfg.chainId} has no Spritz network mapping`);
    if (!RAILS[cfg.defaultRail]) issues.push(`SPRITZ_FIAT_FUNDING_RAIL=${cfg.defaultRail} is not ach or wire`);
    if (!CanonicalFundingSource) issues.push('CanonicalFundingSource (Treasury-Core ERP) not available');
    if (!BankTransferEngine) issues.push('BankTransferEngine (ERP credit-push origination) not available');
    const erp = CanonicalFundingSource ? CanonicalFundingSource.getConfig() : null;
    if (erp && !erp.live) issues.push('CANONICAL_FUNDING_LIVE=false: ERP commit runs in shadow mode');

    let capabilities = [];
    let account = null;
    if (str('SPRITZ_API_KEY') && cfg.policyAddress && cfg.network) {
      try {
        capabilities = await Promise.all(Object.keys(RAILS).map((rail) => this.capability(rail)));
        for (const c of capabilities) {
          if (!c.active) issues.push(`Spritz fiat_to_crypto ${c.method} is ${c.status}${c.requirements.length ? ` (${c.requirements.map((r) => `${r.type || 'requirement'}${r.actionUrl ? ' ' + r.actionUrl : ''}`).join('; ')})` : ''}`);
        }
        account = await this.account();
        if (!account) issues.push(`no Spritz auto-ramp account converting to the policy contract ${cfg.policyAddress} (create one with ensureAccount)`);
        else if (!account.active) issues.push(`Spritz auto-ramp account ${account.id} is ${account.status}`);
      } catch (e) {
        issues.push(e.message);
      }
    }
    const channels = await Promise.all(Object.keys(RAILS).map((rail) => this.originationChannel(rail)));
    for (const ch of channels) {
      if (!ch.ready) issues.push(`${ch.rail} origination: ${ch.detail}`);
    }
    const collateral = await this.collateralHeadroom(0);
    return {
      provider: 'spritz-fiat-funding',
      direction: 'erp_credit_push',
      ready: issues.length === 0,
      issues,
      originationChannels: channels,
      policyContract: cfg.policyAddress,
      chainId: cfg.chainId,
      network: cfg.network,
      token: cfg.token,
      defaultRail: cfg.defaultRail,
      rails: this.rails(),
      capabilities,
      autoRampAccount: account,
      erp: erp ? { system: erp.system, cashAccountCode: erp.cashAccountCode, assetAccountCode: erp.assetAccountCode, live: Boolean(erp.live) } : null,
      fundingSource: cfg.fundingSource,
      collateral,
      gl: cfg.gl,
    };
  }

  /**
   * The bank-network channel an ERP credit push would actually leave through.
   * ACH without an ODFI channel self-transmits the NACHA file back to this app
   * and still reports `transmitted`, so it must be refused rather than trusted.
   */
  static async originationChannel(rail) {
    const key = String(rail || '').toLowerCase();
    const out = { rail: key, ready: false, channel: null, detail: null };
    if (!RAILS[key]) return { ...out, detail: 'unsupported rail' };
    let mode = 'production';
    try { if (SystemSettings) mode = await SystemSettings.getMode(); } catch (e) { /* settings table unavailable */ }
    if (mode !== 'production') return { ...out, detail: `system mode is ${mode}; bank transmission requires production` };
    if (key === 'ach') {
      if (str('ACH_MFT_CHANNEL')) return { ...out, ready: true, channel: 'mft', detail: `MFT channel ${str('ACH_MFT_CHANNEL')}` };
      let endpoint = null;
      try { if (SystemSettings) endpoint = await SystemSettings.get('bank_endpoint'); } catch (e) { /* unavailable */ }
      if (endpoint && endpoint !== 'direct') return { ...out, ready: true, channel: 'bank_endpoint', detail: `ODFI endpoint ${endpoint}` };
      let partner = null;
      try { if (AS2Partners) partner = await AS2Partners.getDefaultPartnerConfig(); } catch (e) { /* no partner table */ }
      const partnerUrl = partner && (partner.apiBaseUrl || partner.partnerUrl);
      if (partner && partnerUrl && partnerUrl !== 'direct') return { ...out, ready: true, channel: 'as2_partner', detail: `AS2 partner ${partner.partnerId || partner.partnerName}` };
      if (str('ACH_SFTP_URL')) return { ...out, ready: true, channel: 'sftp', detail: 'bank NACHA SFTP drop' };
      return { ...out, detail: 'no ODFI channel (ACH_MFT_CHANNEL, bank_endpoint setting, AS2 partner or ACH_SFTP_URL); transmission would only self-post the NACHA file' };
    }
    if (PartnerBankRails && PartnerBankRails.isConfigured()) return { ...out, ready: true, channel: 'partner_bank', detail: `partner bank ${str('PARTNER_BANK_PROVIDER')}` };
    let wireEndpoint = null;
    try { if (SystemSettings) wireEndpoint = await SystemSettings.getWireEndpoint(); } catch (e) { /* unavailable */ }
    if (wireEndpoint) return { ...out, ready: true, channel: 'wire_endpoint', detail: `wire endpoint ${wireEndpoint}` };
    return { ...out, detail: 'no wire channel (PARTNER_BANK_* or wire_endpoint setting)' };
  }

  static async ensureAccount() {
    const account = await this.account({ ensure: true });
    return account;
  }

  /**
   * Raise an ERP-originated fiat credit push to the auto-ramp account.
   * Idempotent on `reference`. Nothing is transmitted to the bank network
   * here: the ACH batch / wire payout is originated and left for `send`.
   */
  static async fund({ amountUsd, bucket, reference, rail, createdBy, memo } = {}) {
    await ensureTable();
    const cfg = this.config();
    if (!reference) throw badRequest('reference required (ERP reference)');
    const amount = usd(amountUsd);
    const useRail = String(rail || cfg.defaultRail).toLowerCase();
    if (!RAILS[useRail]) throw badRequest(`unsupported ERP credit-push rail ${useRail}; use ${Object.keys(RAILS).join(' or ')}`, 'FIAT_FUNDING_RAIL_UNSUPPORTED');
    if (!CanonicalFundingSource) throw conflict('CanonicalFundingSource (Treasury-Core ERP) not available', 'ERP_UNAVAILABLE');
    if (!BankTransferEngine) throw conflict('BankTransferEngine (ERP credit-push origination) not available', 'ERP_ORIGINATION_UNAVAILABLE');

    const existing = await this.get(reference);
    if (existing) return { ...existing, idempotent: true };

    const segregated = TrustAllocationEngine.assertFundingSource({ bucket, ...cfg.fundingSource });
    const source = segregated.source;
    if (String(source.sourceType || '').toLowerCase() !== 'canonical' || !source.sourceAccountId) {
      throw conflict('fiat funding originates only from the Treasury-Core canonical cash account (sourceType canonical)', 'FIAT_FUNDING_SOURCE_NOT_CANONICAL');
    }
    bucket = segregated.bucket ? segregated.bucket.key : null;

    const capability = await this.capability(useRail);
    if (!capability.active) {
      const action = capability.requirements.map((r) => r.actionUrl).filter(Boolean)[0];
      throw conflict(`Spritz fiat_to_crypto ${capability.method} is ${capability.status}${action ? `; complete ${action}` : ''}`, 'FIAT_FUNDING_CAPABILITY_INACTIVE');
    }
    const account = await this.account({ ensure: true });
    if (!account.active) throw conflict(`Spritz auto-ramp account ${account.id} is ${account.status}, not active`, 'AUTO_RAMP_ACCOUNT_INACTIVE');
    const di = account.depositInstructions;
    if (!di || !di.bankRoutingNumber || !di.bankAccountNumber) throw conflict(`Spritz auto-ramp account ${account.id} has no US deposit instructions`, 'AUTO_RAMP_INSTRUCTIONS_MISSING');
    if (di.paymentRails.length && !di.paymentRails.includes(RAILS[useRail].depositRail)) {
      throw conflict(`auto-ramp account ${account.id} accepts ${di.paymentRails.join(', ')}, not ${RAILS[useRail].depositRail}`, 'FIAT_FUNDING_RAIL_NOT_ACCEPTED');
    }

    const collateral = await this.collateralHeadroom(amount);
    if (!collateral.sufficient) {
      throw conflict(`Collateral OS spendable headroom ${collateral.availableUsd} USD is below ${amount.toFixed(2)}`, 'COLLATERAL_INSUFFICIENT');
    }

    // ERP: Dr USDC treasury (in transit) / Cr canonical cash. Fails closed on insufficient GL cash.
    const erpCommit = await CanonicalFundingSource.commit({
      amountUsd: amount,
      reference,
      referenceType: 'spritz_fiat_funding',
      memo: memo || `ERP credit push to Spritz auto-ramp ${account.id} [${reference}]`,
      cashAccountCode: source.sourceAccountId,
      assetAccountCode: cfg.gl.treasuryAccount,
      postedBy: createdBy || 'spritz-fiat-funding',
      purpose: 'spritz_fiat_funding',
    });

    let transfer = null;
    let error = null;
    try {
      transfer = await BankTransferEngine.pushCredit({
        sourceCashAccountId: null,
        destinationDetails: {
          name: `Spritz auto-ramp ${account.id}`,
          bankName: di.bankName,
          routingNumber: di.bankRoutingNumber,
          accountNumber: di.bankAccountNumber,
          accountType: 'checking',
          country: 'US',
          beneficiaryAddress: di.bankAddress,
        },
        amount,
        rail: useRail,
        memo: memo || reference,
        initiatedBy: createdBy || 'spritz-fiat-funding',
      });
    } catch (e) {
      error = e.message;
    }

    const status = error ? 'failed' : 'prepared';
    if (pool && pool.query) {
      await pool.query(
        `INSERT INTO ${TABLE} (reference, bucket, amount_usd, rail, auto_ramp_account_id, deposit_instructions, source_account, erp_commit, transfer_id, transfer_status, status, error, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (reference) DO NOTHING`,
        [reference, bucket, amount.toFixed(2), useRail, account.id, JSON.stringify(di), String(source.sourceAccountId),
          JSON.stringify({ shadow: Boolean(erpCommit && erpCommit.shadow), committed: Boolean(erpCommit && erpCommit.committed), reason: erpCommit && erpCommit.reason, entryId: erpCommit && (erpCommit.entryId || erpCommit.entry_id) || null }),
          transfer ? transfer.transfer_id : null, transfer ? transfer.status : null, status, error, createdBy || null]
      );
    }
    if (error) throw conflict(`ERP credit-push origination failed after the ERP commit: ${error}`, 'FIAT_FUNDING_ORIGINATION_FAILED');
    return {
      status,
      reference,
      bucket,
      amountUsd: amount.toFixed(2),
      rail: useRail,
      source: { kind: 'treasury_core_erp', account: source.sourceAccountId, shadow: Boolean(erpCommit && erpCommit.shadow) },
      autoRampAccount: account,
      erpCommit,
      collateral,
      transfer: { id: transfer.transfer_id, status: transfer.status, achBatchId: transfer.ach_batch_id || null, wirePayoutId: transfer.wire_payout_id || null },
      next: 'send({ reference }) transmits the ERP credit push; reconcile() then tracks the Spritz on-ramp until USDC lands on the policy contract.',
    };
  }

  /** Transmit the originated credit push (ACH batch / wire payout) to the bank network. */
  static async send({ reference } = {}) {
    await ensureTable();
    const row = await this.get(reference);
    if (!row) throw httpError(404, `no fiat funding ${reference}`, 'FIAT_FUNDING_NOT_FOUND');
    if (row.status !== 'prepared') return { ...row, idempotent: true };
    if (!row.transferId) throw conflict(`fiat funding ${reference} has no originated transfer`, 'FIAT_FUNDING_NO_TRANSFER');
    if (!BankTransferEngine) throw conflict('BankTransferEngine not available', 'ERP_ORIGINATION_UNAVAILABLE');
    const channel = await this.originationChannel(row.rail);
    if (!channel.ready) throw conflict(`${row.rail} credit push cannot reach the bank network: ${channel.detail}`, 'ERP_ORIGINATION_CHANNEL_MISSING');
    const sent = await BankTransferEngine.sendPushCredit(row.transferId);
    const failed = ['failed', 'cancelled'].includes(sent.status);
    const status = failed ? 'failed' : (sent.status === 'manual_pending' ? 'prepared' : 'submitted');
    await pool.query(`UPDATE ${TABLE} SET transfer_status = $1, status = $2, error = $3, updated_at = NOW() WHERE reference = $4`,
      [sent.status, status, failed ? `transfer ${sent.status}` : null, reference]);
    return { ...(await this.get(reference)), transfer: sent };
  }

  static async get(reference) {
    await ensureTable();
    if (!pool || !pool.query || !reference) return null;
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} WHERE reference = $1`, [reference]);
    return mapRow(rows[0]);
  }

  static async list({ status, limit = 50 } = {}) {
    await ensureTable();
    if (!pool || !pool.query) return [];
    const params = [];
    const where = status ? (params.push(status), 'WHERE status = $1') : '';
    params.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
    const { rows } = await pool.query(`SELECT * FROM ${TABLE} ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(mapRow);
  }

  /**
   * Match open fundings to Spritz on-ramp records (same rail, same amount,
   * created after the funding) and read the policy contract balance back.
   */
  static async reconcile() {
    await ensureTable();
    const cfg = this.config();
    const [open, onRampsRaw, policy] = await Promise.all([
      this.list({ limit: 500 }).then((rows) => rows.filter((r) => !TERMINAL.has(r.status))),
      SpritzEngine.listOnRamps().catch(() => []),
      TrustPolicyEngine.status().catch(() => null),
    ]);
    const onRamps = Array.isArray(onRampsRaw) ? onRampsRaw : (onRampsRaw && Array.isArray(onRampsRaw.data) ? onRampsRaw.data : []);
    const claimed = new Set(open.map((r) => r.onRampId).filter(Boolean));
    const updates = [];
    for (const row of open) {
      let match = row.onRampId ? onRamps.find((o) => o.id === row.onRampId) : null;
      if (!match) {
        match = onRamps.find((o) => !claimed.has(o.id)
          && String(o.input && o.input.rail || '') === RAILS[row.rail].onRampRail
          && Math.abs(Number(o.input && o.input.amount) - row.amountUsd) < 0.005
          && (!o.createdAt || !row.createdAt || new Date(o.createdAt) >= new Date(row.createdAt))) || null;
        if (match) claimed.add(match.id);
      }
      if (!match) continue;
      const s = String(match.status || '');
      const status = s === 'completed' ? 'completed'
        : ['failed', 'cancelled', 'reversed', 'refunded'].includes(s) ? 'failed'
          : ['processing', 'partially_delivered', 'in_review'].includes(s) ? 'processing'
            : 'awaiting_payment';
      if (status !== row.status || match.id !== row.onRampId) {
        await pool.query(`UPDATE ${TABLE} SET onramp_id = $1, onramp = $2, status = $3, error = $4, updated_at = NOW() WHERE reference = $5`,
          [match.id, JSON.stringify({ status: s, input: match.input || null, output: match.output || null, fees: match.fees || null, createdAt: match.createdAt || null }), status, status === 'failed' ? `on-ramp ${s}` : null, row.reference]);
        updates.push({ reference: row.reference, onRampId: match.id, from: row.status, to: status });
      }
    }
    const fundings = await this.list({ limit: 100 });
    return {
      policyContract: cfg.policyAddress,
      onChain: policy ? { token: policy.treasury.token, balanceUnits: policy.treasury.balance, availableUnits: policy.treasury.available } : null,
      funded: Boolean(policy && BigInt(policy.treasury.balance || '0') > 0n),
      onRamps: onRamps.length,
      updates,
      open: fundings.filter((r) => !TERMINAL.has(r.status)),
      completedUsd: fundings.filter((r) => r.status === 'completed').reduce((s, r) => s + r.amountUsd, 0).toFixed(2),
      fundings,
    };
  }
}

module.exports = { SpritzFiatFundingEngine, FIAT_FUNDING_RAILS: RAILS, FIAT_FUNDING_STATUSES: STATUSES };

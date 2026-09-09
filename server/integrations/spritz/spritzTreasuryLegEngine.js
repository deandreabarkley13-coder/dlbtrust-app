'use strict';

/**
 * SpritzTreasuryLegEngine — the Spritz leg of the treasury-core ERP and the
 * governed smart accounts on Base.
 *
 *   fund:   bank funding source --(Spritz ACH-debit on-ramp)--> USDC on Base
 *           delivered straight to the TrustDistributionPolicy contract.
 *   payout: policy contract --(governed distribution)--> payout wallet
 *           --(Spritz off-ramp)--> beneficiary bank (ACH / RTP / card).
 *
 * Every leg is booked as a double-entry journal in the trust GL
 * (TrustAccountingEngine) keyed by the Spritz deposit / off-ramp id so a
 * replay never double-books. No leg moves value until Spritz confirms it and
 * the policy contract's on-chain balance is read back.
 */

const { SpritzEngine } = require('./spritzEngine');
const { TrustPolicyEngine } = require('../dapp/trustPolicyEngine');
const { getConfig } = require('../dapp/config');

let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const USDC_DECIMALS = 6;

function str(name, def = '') { return (process.env[name] || def).trim(); }

function glConfig() {
  return {
    // USDC held by the policy contract (digital-asset treasury).
    treasuryAccount: str('SPRITZ_TREASURY_GL_ACCOUNT', '1210'),
    // Bank account debited by the Spritz on-ramp.
    bankAccount: str('SPRITZ_FUNDING_BANK_GL_ACCOUNT', str('PTC_BANK_GL_ACCOUNT', '1010')),
    // Beneficiary distributions settled through the Spritz off-ramp.
    distributionsAccount: str('SPRITZ_DISTRIBUTIONS_GL_ACCOUNT', '2000'),
    // Spritz platform / network fees.
    feeAccount: str('SPRITZ_FEE_GL_ACCOUNT', '5300'),
    bookingEnabled: str('SPRITZ_GL_BOOKING_ENABLED', 'true').toLowerCase() !== 'false',
  };
}

function badRequest(message, code = 'BAD_REQUEST') {
  return Object.assign(new Error(message), { status: 400, code });
}

function usdToUnits(amountUsd) {
  const n = Number(amountUsd);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('amountUsd must be a positive number');
  return BigInt(Math.round(n * 10 ** USDC_DECIMALS));
}

function unitsToUsd(units) {
  const n = BigInt(String(units || '0'));
  const whole = n / 10n ** BigInt(USDC_DECIMALS);
  const frac = (n % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, '0');
  return `${whole}.${frac}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

async function existingEntry(referenceType, referenceId) {
  if (!pool || !pool.query || !referenceId) return null;
  try {
    const rows = await pool.query(
      `SELECT entry_id FROM trust_journal_entries
        WHERE reference_type = $1 AND reference_id = $2 AND status = 'posted'
        LIMIT 1`,
      [referenceType, String(referenceId)]
    );
    return rows.rows[0] ? rows.rows[0].entry_id : null;
  } catch (e) {
    return null;
  }
}

async function book({ referenceType, referenceId, description, lines, postedBy }) {
  const gl = glConfig();
  if (!gl.bookingEnabled) return { status: 'booking_disabled', booked: false };
  if (!TrustAccountingEngine) return { status: 'accounting_unavailable', booked: false };
  const already = await existingEntry(referenceType, referenceId);
  if (already) return { status: 'already_booked', booked: true, entryId: already };
  try {
    const entry = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date().toISOString().slice(0, 10),
      description,
      lines,
      referenceType,
      referenceId: String(referenceId),
      postedBy: postedBy || 'spritz-treasury-leg',
      postToFineract: false,
    });
    return { status: 'booked', booked: true, entryId: entry.entry_id || entry.entryId || null };
  } catch (e) {
    return { status: 'error', booked: false, error: e.message };
  }
}

class SpritzTreasuryLegEngine {
  static config() {
    const dapp = getConfig();
    const policy = TrustPolicyEngine.getConfig();
    return {
      policyAddress: policy.address || null,
      chainId: policy.chainId || dapp.chainId,
      network: SpritzEngine.chainName(policy.chainId || dapp.chainId),
      settlementToken: policy.settlementToken || dapp.usdcAddress || null,
      payoutWallet: str('SPRITZ_PAYOUT_WALLET', dapp.operatorAddress || ''),
      defaultRail: str('SPRITZ_PAYOUT_RAIL', 'ach_standard'),
      gl: glConfig(),
    };
  }

  /** What the Spritz leg can do right now, without moving anything. */
  static async readiness() {
    const cfg = this.config();
    const issues = [];
    if (!str('SPRITZ_API_KEY')) issues.push('SPRITZ_API_KEY not configured');
    if (!cfg.policyAddress) issues.push('TRUST_POLICY_ADDRESS not configured');
    if (!cfg.network) issues.push(`chain ${cfg.chainId} has no Spritz network mapping`);

    let capabilities = [];
    let fundingSources = [];
    let bankAccounts = [];
    if (!issues.length) {
      try {
        [capabilities, fundingSources, bankAccounts] = await Promise.all([
          SpritzEngine.capabilities(),
          SpritzEngine.listFundingSources(),
          SpritzEngine.listBankAccounts(),
        ]);
      } catch (e) {
        issues.push(`Spritz API unreachable: ${e.message}`);
      }
    }
    const onramp = capabilities.find(c => c.product === 'fiat_to_crypto' && c.method === 'ach_debit');
    const offramp = capabilities.find(c => c.product === 'crypto_to_fiat' && c.method === 'ach_credit');
    if (onramp && onramp.status !== 'active') issues.push(`Spritz ACH-debit on-ramp is ${onramp.status}`);
    if (!fundingSources.length && !issues.length) issues.push('No Plaid-linked funding source in Spritz; link the trust bank account in the Spritz dashboard');

    return {
      provider: 'spritz-treasury-leg',
      ready: issues.length === 0,
      issues,
      policyContract: cfg.policyAddress,
      chainId: cfg.chainId,
      network: cfg.network,
      settlementToken: cfg.settlementToken,
      payoutWallet: cfg.payoutWallet || null,
      onramp: onramp ? { status: onramp.status, nextRequirement: onramp.nextRequirement } : null,
      offramp: offramp ? { status: offramp.status } : null,
      fundingSources: fundingSources.map(f => ({
        id: f.id, institution: (f.institution && f.institution.name) || f.institutionName || null,
        accountNumberLast4: f.accountNumberLast4 || null, status: f.status || null,
      })),
      bankAccounts: bankAccounts.map(b => ({
        id: b.id, label: b.label || null, institution: (b.institution && b.institution.name) || null,
        accountNumberLast4: b.accountNumberLast4 || null, status: b.status, supportedRails: b.supportedRails || [],
      })),
      gl: cfg.gl,
    };
  }

  // ─── Fund: bank -> Spritz -> USDC on Base -> policy contract ───────────────

  /**
   * Price a deposit into the policy contract. Nothing moves: the preparation
   * expires unless `fund()` is called with the returned preparationId.
   */
  static async quoteFunding({ amountUsd, sourceId, priority = 'normal' } = {}) {
    const cfg = this.config();
    if (!cfg.policyAddress) throw badRequest('TRUST_POLICY_ADDRESS not configured', 'TRUST_POLICY_NOT_CONFIGURED');
    if (!cfg.network) throw badRequest(`chain ${cfg.chainId} is not a Spritz deposit network`);
    const source = sourceId || await this._defaultFundingSource();
    const prep = await SpritzEngine.prepareDirectDeposit({
      sourceId: source,
      address: cfg.policyAddress,
      network: cfg.network,
      asset: 'USDC',
      amountUsd,
      quoteType: 'exact_input',
      priority,
    });
    return {
      preparationId: prep.id || prep.preparationId || null,
      sourceId: source,
      destination: cfg.policyAddress,
      network: cfg.network,
      amountUsd: Number(amountUsd).toFixed(2),
      preparation: prep,
    };
  }

  /**
   * Execute a prepared deposit. `reference` is the ERP reference the deposit
   * is booked under; it doubles as the Spritz idempotency key so a retry after
   * a timeout recovers the original deposit instead of creating a second one.
   */
  static async fund({ preparationId, amountUsd, sourceId, reference, priority = 'normal', createdBy } = {}) {
    const cfg = this.config();
    if (!reference) throw badRequest('reference required (ERP reference / idempotency key)');
    let prepId = preparationId;
    let quote = null;
    if (!prepId) {
      quote = await this.quoteFunding({ amountUsd, sourceId, priority });
      prepId = quote.preparationId;
    }
    if (!prepId) throw new Error('Spritz did not return a preparation id');

    const deposit = await SpritzEngine.createDirectDeposit({ preparationId: prepId, idempotencyKey: `dlb-fund-${reference}` });
    const gross = num(deposit.amountUsd || deposit.inputAmount || (deposit.input && deposit.input.amount) || amountUsd || (quote && quote.amountUsd));
    const fee = num(deposit.feeUsd || (deposit.fees && deposit.fees.total));
    const gl = cfg.gl;
    const lines = [
      { accountCode: gl.treasuryAccount, debitAmount: +(gross - fee).toFixed(2), creditAmount: 0, description: `USDC to policy contract ${cfg.policyAddress}` },
      { accountCode: gl.bankAccount, debitAmount: 0, creditAmount: +gross.toFixed(2), description: 'Spritz ACH debit from funding source' },
    ];
    if (fee > 0) lines.push({ accountCode: gl.feeAccount, debitAmount: +fee.toFixed(2), creditAmount: 0, description: 'Spritz on-ramp fee' });
    const journal = await book({
      referenceType: 'spritz_deposit',
      referenceId: deposit.id || `prep:${prepId}`,
      description: `Spritz on-ramp ${gross.toFixed(2)} USD -> USDC (${cfg.network}) to TrustDistributionPolicy [${reference}]`,
      lines,
      postedBy: createdBy,
    });

    return {
      status: deposit.status || 'submitted',
      depositId: deposit.id || null,
      preparationId: prepId,
      reference,
      destination: cfg.policyAddress,
      network: cfg.network,
      amountUsd: gross.toFixed(2),
      feeUsd: fee.toFixed(2),
      deposit,
      journal,
      note: 'Funding is complete only when the policy contract balance on chain reflects the USDC; see reconcileFunding().',
    };
  }

  /** Spritz deposit records vs. the policy contract's on-chain USDC balance. */
  static async reconcileFunding() {
    const cfg = this.config();
    const [deposits, status] = await Promise.all([
      SpritzEngine.listDeposits(),
      TrustPolicyEngine.status({ token: cfg.settlementToken || undefined }),
    ]);
    const list = Array.isArray(deposits) ? deposits : (deposits && deposits.data) || [];
    const toContract = list.filter(d => {
      const addr = d.address || d.destinationAddress || (d.destination && d.destination.address) || '';
      return String(addr).toLowerCase() === String(cfg.policyAddress || '').toLowerCase();
    });
    const settled = toContract.filter(d => /complete|settled|success/i.test(String(d.status || '')));
    const settledUsd = settled.reduce((s, d) => s + num(d.outputAmount || (d.output && d.output.amount) || d.amountUsd), 0);
    return {
      policyContract: cfg.policyAddress,
      onChain: {
        token: status.treasury.token,
        balanceUnits: status.treasury.balance,
        balanceUsd: unitsToUsd(status.treasury.balance),
        availableUnits: status.treasury.available,
      },
      spritz: {
        depositsToContract: toContract.length,
        settled: settled.length,
        settledUsd: settledUsd.toFixed(2),
        pending: toContract.filter(d => !settled.includes(d)).map(d => ({ id: d.id, status: d.status })),
      },
      funded: BigInt(status.treasury.balance || '0') > 0n,
    };
  }

  // ─── Payout: policy contract -> payout wallet -> Spritz -> beneficiary bank ─

  /**
   * Stage a governed distribution whose fiat leg settles through Spritz.
   *
   * The policy contract only pays allow-listed wallets, so the distribution is
   * proposed to the payout wallet (default: DAPP_OPERATOR_ADDRESS) which then
   * executes the Spritz off-ramp quote to the beneficiary's bank account after
   * the checker approval + timelock. The quote is created first so the amount
   * the checker approves is the amount Spritz will pay out.
   */
  static async stagePayout({ bankAccountId, amountUsd, purpose, reference, rail, memo, payoutWallet } = {}) {
    const cfg = this.config();
    if (!bankAccountId) throw badRequest('bankAccountId required (Spritz bank account of the beneficiary)');
    if (!reference) throw badRequest('reference required');
    const wallet = payoutWallet || cfg.payoutWallet;
    if (!wallet) throw badRequest('SPRITZ_PAYOUT_WALLET (or DAPP_OPERATOR_ADDRESS) not configured', 'PAYOUT_WALLET_NOT_CONFIGURED');
    if (!cfg.network) throw badRequest(`chain ${cfg.chainId} is not a Spritz network`);

    const gate = await TrustPolicyEngine.beneficiaryStatus({ beneficiary: wallet, token: cfg.settlementToken || undefined });
    if (!gate.allowed) {
      throw Object.assign(new Error(`payout wallet ${wallet} is not an allow-listed beneficiary on the policy contract; the contract owner must call setBeneficiary/setBeneficiaryLimits first`), {
        status: 409, code: 'PAYOUT_WALLET_NOT_ALLOWLISTED',
      });
    }
    if (gate.frozen) throw Object.assign(new Error(`payout wallet ${wallet} is frozen on the policy contract`), { status: 409, code: 'PAYOUT_WALLET_FROZEN' });

    const quote = await SpritzEngine.createOffRampQuote({
      accountId: bankAccountId,
      amount: Number(amountUsd).toFixed(2),
      chain: cfg.network,
      tokenAddress: cfg.settlementToken || undefined,
      amountMode: 'output',
      rail: rail || cfg.defaultRail,
      memo: memo || reference,
    });
    const required = quote.requiredTokenInput || quote.inputAmount || (quote.input && quote.input.amount) || null;
    const quantity = required !== null ? BigInt(String(required)) : usdToUnits(amountUsd);

    const proposal = await TrustPolicyEngine.propose({
      beneficiary: wallet,
      quantity: quantity.toString(),
      tokenAddress: cfg.settlementToken || undefined,
      purpose,
      reference,
    });

    return {
      status: 'proposed',
      reference,
      payoutWallet: wallet,
      bankAccountId,
      amountUsd: Number(amountUsd).toFixed(2),
      quantityUnits: quantity.toString(),
      rail: rail || cfg.defaultRail,
      spritzQuoteId: quote.id || null,
      spritzQuote: quote,
      distribution: proposal,
      next: 'checker approves the distribution; after the release delay call executePayout({ distributionId, spritzQuoteId, reference }).',
    };
  }

  /**
   * Release the distribution to the payout wallet and settle the Spritz
   * off-ramp from it, booking the beneficiary payout in the GL.
   */
  static async executePayout({ distributionId, spritzQuoteId, reference, amountUsd, createdBy } = {}) {
    const cfg = this.config();
    if (!distributionId) throw badRequest('distributionId required');
    if (!spritzQuoteId) throw badRequest('spritzQuoteId required');
    if (!reference) throw badRequest('reference required');

    const release = await TrustPolicyEngine.execute({ distributionId });
    const settlement = await SpritzEngine.executeQuote(spritzQuoteId);
    const quote = await SpritzEngine.getOffRampQuote(spritzQuoteId).catch(() => null);
    const gross = num((quote && (quote.outputAmount || (quote.output && quote.output.amount))) || amountUsd);
    const fee = num(quote && (quote.feeUsd || (quote.fees && quote.fees.total)));
    const gl = cfg.gl;
    const lines = [
      { accountCode: gl.distributionsAccount, debitAmount: +gross.toFixed(2), creditAmount: 0, description: `Beneficiary payout via Spritz off-ramp (distribution ${distributionId})` },
      { accountCode: gl.treasuryAccount, debitAmount: 0, creditAmount: +(gross + fee).toFixed(2), description: `USDC released from policy contract ${cfg.policyAddress}` },
    ];
    if (fee > 0) lines.push({ accountCode: gl.feeAccount, debitAmount: +fee.toFixed(2), creditAmount: 0, description: 'Spritz off-ramp fee' });
    const journal = await book({
      referenceType: 'spritz_offramp',
      referenceId: spritzQuoteId,
      description: `Spritz off-ramp ${gross.toFixed(2)} USD for distribution ${distributionId} [${reference}]`,
      lines,
      postedBy: createdBy,
    });

    return {
      status: 'settling',
      reference,
      distributionId: String(distributionId),
      release,
      spritzQuoteId,
      txHash: settlement.txHash,
      amountUsd: gross.toFixed(2),
      feeUsd: fee.toFixed(2),
      journal,
    };
  }

  static async _defaultFundingSource() {
    const sources = await SpritzEngine.listFundingSources();
    const list = Array.isArray(sources) ? sources : [];
    const active = list.find(s => !s.status || /active|verified/i.test(String(s.status))) || list[0];
    if (!active) {
      throw Object.assign(new Error('No Spritz funding source: link the trust bank account via Plaid in the Spritz dashboard'), {
        status: 409, code: 'SPRITZ_NO_FUNDING_SOURCE',
      });
    }
    return active.id;
  }
}

module.exports = { SpritzTreasuryLegEngine, usdToUnits, unitsToUsd };

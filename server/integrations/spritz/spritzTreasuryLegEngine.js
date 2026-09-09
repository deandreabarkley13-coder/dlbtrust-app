'use strict';

/**
 * SpritzTreasuryLegEngine — the Spritz leg of the treasury-core ERP and the
 * governed smart accounts on Base.
 *
 *   fund:   Treasury-Core ERP reserve (ledger source or module/bond token such
 *           as DLB-PRB / DLB-TREASURY) --(CanonicalMoneyEngine, maker/checker
 *           consensus)--> USDC on Base delivered to the TrustDistributionPolicy
 *           contract. No bank account is ever debited.
 *   payout: policy contract --(governed distribution)--> payout wallet
 *           --(Spritz off-ramp)--> settlement bank (DB NET MGMT).
 *
 * Every leg is booked as a double-entry journal in the trust GL
 * (TrustAccountingEngine) keyed by the ERP request / Spritz quote id so a
 * replay never double-books. Funding is only "complete" once the policy
 * contract's on-chain USDC balance is read back.
 */

const { SpritzEngine } = require('./spritzEngine');
const { TrustPolicyEngine } = require('../dapp/trustPolicyEngine');
const { getConfig } = require('../dapp/config');
const { TrustAllocationEngine } = require('../dapp/trustAllocationEngine');

let CanonicalMoneyEngine;
try { ({ CanonicalMoneyEngine } = require('../dapp/canonicalMoneyEngine')); } catch (e) { CanonicalMoneyEngine = null; }
let TrustAccountingEngine;
try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

const USDC_DECIMALS = 6;
const DEFAULT_SETTLEMENT_BANK_MATCH = 'DB NET MGMT';

function str(name, def = '') { return (process.env[name] || def).trim(); }

function glConfig() {
  return {
    // USDC held by the policy contract (digital-asset treasury).
    treasuryAccount: str('SPRITZ_TREASURY_GL_ACCOUNT', '1210'),
    // ERP reserve the USDC is converted out of (bond investments by default).
    reserveAccount: str('SPRITZ_FUNDING_RESERVE_GL_ACCOUNT', '1100'),
    // Beneficiary distributions settled through the Spritz off-ramp.
    distributionsAccount: str('SPRITZ_DISTRIBUTIONS_GL_ACCOUNT', '2000'),
    // Spritz / swap fees.
    feeAccount: str('SPRITZ_FEE_GL_ACCOUNT', '5300'),
    bookingEnabled: str('SPRITZ_GL_BOOKING_ENABLED', 'true').toLowerCase() !== 'false',
  };
}

function badRequest(message, code = 'BAD_REQUEST') {
  return Object.assign(new Error(message), { status: 400, code });
}

function conflict(message, code) {
  return Object.assign(new Error(message), { status: 409, code });
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

function bankMatches(account, needle) {
  const hay = [account.label, account.accountHolderName, account.name, account.institution && account.institution.name]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(String(needle).toLowerCase());
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
      settlementBankAccountId: str('SPRITZ_SETTLEMENT_BANK_ACCOUNT_ID'),
      settlementBankMatch: str('SPRITZ_SETTLEMENT_BANK_MATCH', DEFAULT_SETTLEMENT_BANK_MATCH),
      fundingSource: {
        sourceType: str('SPRITZ_FUNDING_SOURCE_TYPE'),
        sourceAccountId: str('SPRITZ_FUNDING_SOURCE_ACCOUNT'),
        sourceToken: str('SPRITZ_FUNDING_SOURCE_TOKEN'),
        sourceModule: str('SPRITZ_FUNDING_SOURCE_MODULE'),
      },
      gl: glConfig(),
    };
  }

  /**
   * The DB NET MGMT bank account on the Spritz user: the only place the
   * off-ramp settles to. Resolved by id when pinned, otherwise by name match.
   */
  static async settlementBank() {
    const cfg = this.config();
    const accounts = await SpritzEngine.listBankAccounts();
    const list = Array.isArray(accounts) ? accounts : [];
    let match = null;
    if (cfg.settlementBankAccountId) match = list.find(b => b.id === cfg.settlementBankAccountId) || null;
    if (!match) match = list.find(b => bankMatches(b, cfg.settlementBankMatch) && (!b.status || /active/i.test(String(b.status)))) || null;
    if (!match) {
      throw conflict(`No Spritz settlement bank account matching "${cfg.settlementBankMatch}"; set SPRITZ_SETTLEMENT_BANK_ACCOUNT_ID`, 'SPRITZ_SETTLEMENT_BANK_NOT_FOUND');
    }
    return {
      id: match.id,
      label: match.label || null,
      institution: (match.institution && match.institution.name) || null,
      accountNumberLast4: match.accountNumberLast4 || null,
      status: match.status || null,
      supportedRails: match.supportedRails || [],
    };
  }

  /** What the leg can do right now, without moving anything. */
  static async readiness() {
    const cfg = this.config();
    const issues = [];
    if (!str('SPRITZ_API_KEY')) issues.push('SPRITZ_API_KEY not configured');
    if (!cfg.policyAddress) issues.push('TRUST_POLICY_ADDRESS not configured');
    if (!cfg.network) issues.push(`chain ${cfg.chainId} has no Spritz network mapping`);
    if (!CanonicalMoneyEngine) issues.push('CanonicalMoneyEngine not available (ERP funding route)');
    const fs = cfg.fundingSource;
    if (!fs.sourceType && !fs.sourceToken && !fs.sourceModule) {
      issues.push('No default ERP funding source (SPRITZ_FUNDING_SOURCE_TYPE / _TOKEN / _MODULE); pass one per request');
    }

    let capabilities = [];
    let settlementBank = null;
    if (str('SPRITZ_API_KEY')) {
      try {
        capabilities = await SpritzEngine.capabilities();
        settlementBank = await this.settlementBank();
      } catch (e) {
        issues.push(e.message);
      }
    }
    const offramp = capabilities.find(c => c.product === 'crypto_to_fiat' && c.method === 'ach_credit');
    if (offramp && offramp.status !== 'active') issues.push(`Spritz ACH payout is ${offramp.status}`);

    let fundingRoute = null;
    if (CanonicalMoneyEngine && (fs.sourceType || fs.sourceToken || fs.sourceModule)) {
      try {
        fundingRoute = await CanonicalMoneyEngine.quote({ ...fs, amount: '1', targetAsset: 'USDC' });
        if (fundingRoute.action !== 'mint_and_swap' && !fundingRoute.poolAddress) issues.push(fundingRoute.note || 'No canonical liquidity pool for the ERP funding route');
      } catch (e) {
        issues.push(`ERP funding route: ${e.message}`);
      }
    }

    return {
      provider: 'spritz-treasury-leg',
      ready: issues.length === 0,
      issues,
      policyContract: cfg.policyAddress,
      chainId: cfg.chainId,
      network: cfg.network,
      settlementToken: cfg.settlementToken,
      payoutWallet: cfg.payoutWallet || null,
      fundingSource: { kind: 'treasury_core_erp', ...fs, route: fundingRoute },
      settlementBank,
      offramp: offramp ? { status: offramp.status } : null,
      gl: cfg.gl,
    };
  }

  // ─── Fund: ERP reserve -> USDC on Base -> policy contract ─────────────────

  /** Price the ERP reserve -> USDC route without creating anything. */
  static async quoteFunding({ amountUsd, sourceType, sourceAccountId, sourceToken, sourceModule } = {}) {
    const cfg = this.config();
    if (!cfg.policyAddress) throw conflict('TRUST_POLICY_ADDRESS not configured', 'TRUST_POLICY_NOT_CONFIGURED');
    if (!CanonicalMoneyEngine) throw new Error('CanonicalMoneyEngine not available');
    const source = this._fundingSource({ sourceType, sourceAccountId, sourceToken, sourceModule });
    const amount = Number(amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) throw badRequest('amountUsd must be a positive number');
    const route = await CanonicalMoneyEngine.quote({ ...source, amount: amount.toFixed(2), targetAsset: 'USDC' });
    return {
      source,
      destination: cfg.policyAddress,
      chainId: cfg.chainId,
      amountUsd: amount.toFixed(2),
      route,
      executable: route.action === 'mint_and_swap' || Boolean(route.poolAddress),
    };
  }

  /**
   * Raise the maker/checker proposal that converts an ERP reserve into USDC
   * paid to the policy contract. Nothing moves until the checker approves;
   * `reconcileFunding()` books the GL entry once the request has executed.
   */
  static async fund({ amountUsd, bucket, sourceType, sourceAccountId, sourceToken, sourceModule, reference, createdBy, autoApprove = false } = {}) {
    const cfg = this.config();
    if (!reference) throw badRequest('reference required (ERP reference)');
    if (bucket) {
      const allocated = TrustAllocationEngine.fundingSource(bucket);
      sourceToken = sourceToken || allocated.sourceToken;
      sourceModule = sourceModule || allocated.sourceModule;
    }
    const quote = await this.quoteFunding({ amountUsd, sourceType, sourceAccountId, sourceToken, sourceModule });
    if (!quote.executable) {
      throw conflict(`ERP funding route is not executable: ${quote.route.note || 'no canonical liquidity pool'}`, 'ERP_FUNDING_ROUTE_UNAVAILABLE');
    }
    const existing = await this._requestByReference(reference);
    if (existing) {
      return { status: existing.status, requestId: existing.id, proposalId: existing.proposal_id, reference, destination: cfg.policyAddress, amountUsd: quote.amountUsd, idempotent: true };
    }
    const proposal = await CanonicalMoneyEngine.propose({
      ...quote.source,
      amount: quote.amountUsd,
      targetAsset: 'USDC',
      recipient: cfg.policyAddress,
      title: `Fund TrustDistributionPolicy ${quote.amountUsd} USDC from ERP reserve [${reference}]`,
      createdBy: createdBy || 'spritz-treasury-leg',
      autoApprove,
    });
    return {
      status: 'proposed',
      requestId: proposal.requestId,
      proposalId: proposal.proposalId,
      reference,
      bucket: bucket || null,
      source: quote.source,
      destination: cfg.policyAddress,
      chainId: cfg.chainId,
      amountUsd: quote.amountUsd,
      route: proposal.route,
      next: 'checker approves the canonical_money proposal; then call reconcileFunding() to book the reserve -> USDC journal once the contract balance reflects it.',
    };
  }

  /**
   * ERP funding requests to the policy contract vs. its on-chain USDC balance.
   * Completed requests are journaled (Dr USDC treasury / Cr ERP reserve) once.
   */
  static async reconcileFunding({ postedBy } = {}) {
    const cfg = this.config();
    const [toContract, status] = await Promise.all([
      this._requestsToContract(cfg.policyAddress),
      TrustPolicyEngine.status({ token: cfg.settlementToken || undefined }),
    ]);
    const completed = toContract.filter(r => r.status === 'completed');
    const journals = [];
    for (const r of completed) {
      const amount = num(r.amount);
      journals.push({
        requestId: r.id,
        ...(await book({
          referenceType: 'erp_policy_funding',
          referenceId: r.id,
          description: `ERP reserve -> ${amount.toFixed(2)} USDC to TrustDistributionPolicy ${cfg.policyAddress} (${r.source_type || r.source_token || r.source_module})`,
          lines: [
            { accountCode: cfg.gl.treasuryAccount, debitAmount: +amount.toFixed(2), creditAmount: 0, description: `USDC to policy contract ${cfg.policyAddress}` },
            { accountCode: cfg.gl.reserveAccount, debitAmount: 0, creditAmount: +amount.toFixed(2), description: `ERP reserve converted (${r.source_type || r.source_token || r.source_module})` },
          ],
          postedBy,
        })),
      });
    }
    const completedUsd = completed.reduce((s, r) => s + num(r.amount), 0);
    return {
      policyContract: cfg.policyAddress,
      onChain: {
        token: status.treasury.token,
        balanceUnits: status.treasury.balance,
        balanceUsd: unitsToUsd(status.treasury.balance),
        availableUnits: status.treasury.available,
      },
      erp: {
        requestsToContract: toContract.length,
        completed: completed.length,
        completedUsd: completedUsd.toFixed(2),
        pending: toContract.filter(r => r.status !== 'completed').map(r => ({ id: r.id, status: r.status, amount: r.amount })),
        journals,
      },
      funded: BigInt(status.treasury.balance || '0') > 0n,
    };
  }

  // ─── Payout: policy contract -> payout wallet -> Spritz -> settlement bank ─

  /**
   * Stage a governed distribution whose fiat leg settles through Spritz to the
   * DB NET MGMT settlement bank.
   *
   * The policy contract only pays allow-listed wallets, so the distribution is
   * proposed to the payout wallet (default: DAPP_OPERATOR_ADDRESS) which then
   * executes the Spritz off-ramp quote after the checker approval + timelock.
   * The quote is created first so the amount the checker approves is the
   * amount Spritz will consume.
   */
  static async stagePayout({ amountUsd, purpose, reference, rail, memo, payoutWallet, bankAccountId, bucket } = {}) {
    const cfg = this.config();
    if (!reference) throw badRequest('reference required');
    const wallet = payoutWallet || cfg.payoutWallet;
    if (!wallet) throw conflict('SPRITZ_PAYOUT_WALLET (or DAPP_OPERATOR_ADDRESS) not configured', 'PAYOUT_WALLET_NOT_CONFIGURED');
    if (!cfg.network) throw badRequest(`chain ${cfg.chainId} is not a Spritz network`);

    const gate = await TrustPolicyEngine.beneficiaryStatus({ beneficiary: wallet, token: cfg.settlementToken || undefined });
    if (!gate.allowed) {
      throw conflict(`payout wallet ${wallet} is not an allow-listed beneficiary on the policy contract; the contract owner must call setBeneficiary/setBeneficiaryLimits first`, 'PAYOUT_WALLET_NOT_ALLOWLISTED');
    }
    if (gate.frozen) throw conflict(`payout wallet ${wallet} is frozen on the policy contract`, 'PAYOUT_WALLET_FROZEN');

    const bank = await this.settlementBank();
    if (bankAccountId && bankAccountId !== bank.id) {
      throw conflict(`bankAccountId ${bankAccountId} is not the settlement bank (${bank.id}); Spritz payouts settle only to ${cfg.settlementBankMatch}`, 'SPRITZ_SETTLEMENT_BANK_MISMATCH');
    }

    const allocation = await TrustAllocationEngine.assertPayout({ bucket, payoutWallet: wallet, purpose, amountUsd, reference });

    const quote = await SpritzEngine.createOffRampQuote({
      accountId: bank.id,
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

    await TrustAllocationEngine.recordPayout({
      bucket: allocation.key, reference, payoutWallet: wallet, purpose, amountUsd,
      distributionId: proposal && (proposal.distributionId || proposal.id), spritzQuoteId: quote.id || null,
    });

    return {
      status: 'proposed',
      reference,
      bucket: allocation.key,
      payoutWallet: wallet,
      settlementBank: bank,
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
   * off-ramp from it, booking the payout in the GL.
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
      { accountCode: gl.distributionsAccount, debitAmount: +gross.toFixed(2), creditAmount: 0, description: `Payout to settlement bank via Spritz off-ramp (distribution ${distributionId})` },
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
    await TrustAllocationEngine.markExecuted(reference);

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

  // ─── helpers ───────────────────────────────────────────────────────────────

  static _fundingSource({ sourceType, sourceAccountId, sourceToken, sourceModule } = {}) {
    const cfg = this.config().fundingSource;
    const source = {
      sourceType: sourceType || cfg.sourceType || undefined,
      sourceAccountId: sourceAccountId || cfg.sourceAccountId || undefined,
      sourceToken: sourceToken || cfg.sourceToken || undefined,
      sourceModule: sourceModule || cfg.sourceModule || undefined,
    };
    if (!source.sourceType && !source.sourceToken && !source.sourceModule) {
      throw badRequest('ERP funding source required: sourceType+sourceAccountId (ledger), sourceToken, or sourceModule', 'ERP_FUNDING_SOURCE_REQUIRED');
    }
    if (source.sourceType && !source.sourceAccountId) throw badRequest('sourceAccountId required with sourceType');
    return source;
  }

  /** canonical_money requests whose proposal pays USDC to the policy contract. */
  static async _requestsToContract(policyAddress) {
    if (!pool || !pool.query || !policyAddress) return [];
    try {
      const rows = await pool.query(
        `SELECT r.id, r.proposal_id, r.source_type, r.source_token, r.source_module, r.amount, r.status, r.created_at
           FROM canonical_money_requests r
           JOIN canonical_proposals p ON p.id = r.proposal_id
          WHERE p.category = 'canonical_money' AND LOWER(p.payload->>'recipient') = $1
          ORDER BY r.created_at DESC LIMIT 200`,
        [String(policyAddress).toLowerCase()]
      );
      return rows.rows;
    } catch (e) {
      return [];
    }
  }

  static async _requestByReference(reference) {
    if (!pool || !pool.query) return null;
    try {
      const rows = await pool.query(
        `SELECT r.* FROM canonical_money_requests r
           JOIN canonical_proposals p ON p.id = r.proposal_id
          WHERE p.title LIKE $1 AND r.status <> 'failed'
          ORDER BY r.created_at DESC LIMIT 1`,
        [`%[${reference}]%`]
      );
      return rows.rows[0] || null;
    } catch (e) {
      return null;
    }
  }
}

module.exports = { SpritzTreasuryLegEngine, usdToUnits, unitsToUsd };

'use strict';

/**
 * SpritzTreasuryLegEngine — the Spritz leg of the treasury-core ERP and the
 * governed smart accounts on Base.
 *
 *   fund:   Treasury-Core Banking ERP canonical GL (default; `sourceType:
 *           canonical` + the CanonicalFundingSource cash account) or a
 *           module/bond token such as DLB-PRB / DLB-TREASURY --(CanonicalMoneyEngine,
 *           maker/checker consensus)--> USDC on Base delivered to the
 *           TrustDistributionPolicy contract. The trust has no bank account:
 *           nothing is ever debited outside the ERP.
 *   payout: policy contract --(governed distribution)--> payout wallet
 *           --(Spritz off-ramp)--> a Spritz destination: a linked bill
 *           (rail `bill_pay`, see SpritzBillPayEngine) or, when one is
 *           linked, a settlement bank account.
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
let CanonicalFundingSource;
try { ({ CanonicalFundingSource } = require('../fineract/canonicalFundingSource')); } catch (e) { CanonicalFundingSource = null; }
let ExternalWalletEngine;
try { ({ ExternalWalletEngine } = require('../dapp/externalWalletEngine')); } catch (e) { ExternalWalletEngine = null; }
let viem, viemChains;
try { viem = require('viem'); viemChains = require('viem/chains'); } catch (e) { viem = null; viemChains = null; }

const ERC20_BALANCE_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
];

function viemChain(chainId) {
  if (!viemChains) return undefined;
  return Object.values(viemChains).find(c => c && typeof c === 'object' && c.id === Number(chainId));
}

const USDC_DECIMALS = 6;
const DEFAULT_SETTLEMENT_BANK_MATCH = 'DB NET MGMT';
// The trust's Coinbase Spritz wallet: receives governed distributions and pays
// Spritz quotes. Externally held, so the server prepares transactions for it to
// sign rather than signing with DAPP_PRIVATE_KEY.
const DEFAULT_SPRITZ_PAYOUT_WALLET = '0xA0f8C3d9e4fE7F531968b11f1Ce298F56483040F';

function sameAddress(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

/** 'operator' when the payout wallet is DAPP_OPERATOR_ADDRESS with a server key; otherwise 'external' (Coinbase). */
function payoutSigner(wallet, dapp) {
  if (wallet && dapp.privateKey && sameAddress(wallet, dapp.operatorAddress)) return 'operator';
  return 'external';
}

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

/**
 * The ERP funding source Spritz legs draw from when the caller names none:
 * SPRITZ_FUNDING_SOURCE_* when set, otherwise the Treasury-Core Banking ERP
 * canonical GL cash account (CanonicalFundingSource).
 */
function defaultFundingSource() {
  const explicit = {
    sourceType: str('SPRITZ_FUNDING_SOURCE_TYPE'),
    sourceAccountId: str('SPRITZ_FUNDING_SOURCE_ACCOUNT'),
    sourceToken: str('SPRITZ_FUNDING_SOURCE_TOKEN'),
    sourceModule: str('SPRITZ_FUNDING_SOURCE_MODULE'),
  };
  if (explicit.sourceType || explicit.sourceToken || explicit.sourceModule) return { ...explicit, kind: 'configured' };
  const erp = CanonicalFundingSource ? CanonicalFundingSource.getConfig() : null;
  return {
    sourceType: 'canonical',
    sourceAccountId: (erp && erp.cashAccountCode) || str('CANONICAL_FUNDING_CASH_ACCOUNT_CODE', '1000'),
    sourceToken: '',
    sourceModule: explicit.sourceModule,
    kind: 'treasury_core_erp',
    system: erp ? erp.system : 'fineract',
    live: Boolean(erp && erp.live),
  };
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
      payoutWallet: str('SPRITZ_PAYOUT_WALLET', DEFAULT_SPRITZ_PAYOUT_WALLET),
      payoutWalletSigner: payoutSigner(str('SPRITZ_PAYOUT_WALLET', DEFAULT_SPRITZ_PAYOUT_WALLET), dapp),
      payoutWalletProvider: str('SPRITZ_PAYOUT_WALLET_PROVIDER', 'coinbase'),
      defaultRail: str('SPRITZ_PAYOUT_RAIL', 'ach_standard'),
      settlementBankAccountId: str('SPRITZ_SETTLEMENT_BANK_ACCOUNT_ID'),
      settlementBankMatch: str('SPRITZ_SETTLEMENT_BANK_MATCH', DEFAULT_SETTLEMENT_BANK_MATCH),
      // The trust holds no bank account; a settlement bank is only used when
      // one is actually linked on the Spritz user. Bills are the default
      // destination.
      settlementBankRequired: str('SPRITZ_SETTLEMENT_BANK_REQUIRED', 'false').toLowerCase() === 'true',
      fundingSource: defaultFundingSource(),
      gl: glConfig(),
    };
  }

  /**
   * The settlement bank account on the Spritz user, if one is linked: the only
   * bank the off-ramp may settle to. Resolved by id when pinned, otherwise by
   * name match. Returns null when the Spritz user has no such account (the
   * trust has no bank account of its own) unless `required`.
   */
  static async settlementBank({ required = false } = {}) {
    const cfg = this.config();
    const accounts = await SpritzEngine.listBankAccounts();
    const list = Array.isArray(accounts) ? accounts : [];
    let match = null;
    if (cfg.settlementBankAccountId) match = list.find(b => b.id === cfg.settlementBankAccountId) || null;
    if (!match) match = list.find(b => bankMatches(b, cfg.settlementBankMatch) && (!b.status || /active/i.test(String(b.status)))) || null;
    if (!match) {
      if (!required) return null;
      throw conflict(`No Spritz settlement bank account matching "${cfg.settlementBankMatch}"; the trust has no bank account — pay through a linked Spritz bill (billId) or set SPRITZ_SETTLEMENT_BANK_ACCOUNT_ID`, 'SPRITZ_SETTLEMENT_BANK_NOT_FOUND');
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
    const fundingSources = await TrustAllocationEngine.fundingSources({ quote: CanonicalMoneyEngine ? (q) => CanonicalMoneyEngine.quote(q) : undefined });
    for (const s of fundingSources) {
      if (!s.configured) issues.push(`${s.bucket} funding source: ${s.issue}`);
      else if (s.executable === false) issues.push(`${s.bucket} funding route: ${s.issue}`);
    }
    const defaultOwner = TrustAllocationEngine.bucketForSource(fs);
    if (fs.kind === 'configured' && !defaultOwner) {
      issues.push('SPRITZ_FUNDING_SOURCE_* default is not a segregated bucket source; bucket-tagged funding refuses it');
    }

    let capabilities = [];
    let settlementBank = null;
    let payableBills = [];
    if (str('SPRITZ_API_KEY')) {
      try {
        capabilities = await SpritzEngine.capabilities();
        settlementBank = await this.settlementBank({ required: cfg.settlementBankRequired });
        payableBills = (await SpritzEngine.listBills().catch(() => []) || []).filter(b => b && b.status === 'active' && !b.unpayableCode);
      } catch (e) {
        issues.push(e.message);
      }
      if (!settlementBank && payableBills.length === 0) {
        issues.push('No Spritz settlement destination: link a bill (Spritz Bill Pay) — the trust has no bank account');
      }
    }
    const offramp = capabilities.find(c => c.product === 'crypto_to_fiat' && c.method === 'ach_credit');
    if (settlementBank && offramp && offramp.status !== 'active') issues.push(`Spritz ACH payout is ${offramp.status}`);
    const billPay = capabilities.find(c => c.product === 'crypto_to_fiat' && /bill/i.test(String(c.method || c.name || '')));
    if (billPay && billPay.status !== 'active') issues.push(`Spritz Bill Pay is ${billPay.status}`);

    let fundingRoute = null;
    if (CanonicalMoneyEngine && (fs.sourceType || fs.sourceToken || fs.sourceModule)) {
      try {
        fundingRoute = await CanonicalMoneyEngine.quote({ ...fs, amount: '1', targetAsset: 'USDC' });
        if (!TrustAllocationEngine.routeExecutable(fundingRoute)) issues.push(fundingRoute.note || 'No canonical liquidity pool for the ERP funding route');
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
      payoutWalletSigner: { type: cfg.payoutWalletSigner, provider: cfg.payoutWalletSigner === 'external' ? cfg.payoutWalletProvider : 'server' },
      fundingSource: { ...fs, kind: fs.kind || 'treasury_core_erp', bucket: defaultOwner ? defaultOwner.key : null, route: fundingRoute },
      fundingSources,
      segregation: 'coupon_income (DLB-PRB / bond_portfolio -> beneficiaries) and trust_operating (DLB-TREASURY / treasury -> trustees) are funded and paid out separately; cross-bucket sources are refused with ALLOCATION_SOURCE_MISMATCH',
      settlementBank,
      settlementDestinations: {
        bank: settlementBank ? 1 : 0,
        bills: payableBills.length,
        default: settlementBank ? 'bank' : (payableBills.length ? 'bill' : null),
      },
      offramp: offramp ? { status: offramp.status } : null,
      billPay: billPay ? { status: billPay.status } : null,
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
      executable: TrustAllocationEngine.routeExecutable(route),
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
    const requested = this._fundingSource({ sourceType, sourceAccountId, sourceToken, sourceModule }, { optional: Boolean(bucket) });
    const segregated = TrustAllocationEngine.assertFundingSource({ bucket, ...requested });
    bucket = segregated.bucket ? segregated.bucket.key : null;
    ({ sourceType, sourceAccountId, sourceToken, sourceModule } = segregated.source);
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
      title: `Fund TrustDistributionPolicy ${quote.amountUsd} USDC from ${bucket || 'ERP reserve'} [${reference}]`,
      createdBy: createdBy || 'spritz-treasury-leg',
      autoApprove,
    });
    return {
      status: 'proposed',
      requestId: proposal.requestId,
      proposalId: proposal.proposalId,
      reference,
      bucket,
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
   * Completed requests are journaled (Dr USDC treasury / Cr ERP reserve) once;
   * `erp_treasury` requests are skipped because CanonicalFundingSource already
   * posted that entry to both books when the proposal executed.
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
      const route = typeof r.route === 'string' ? JSON.parse(r.route || '{}') : (r.route || {});
      if (route.action === 'erp_treasury') {
        journals.push({ requestId: r.id, status: 'booked', booked: true, bookedBy: 'canonical_funding_source', glAccounts: route.glAccounts || null });
        continue;
      }
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
  static async stagePayout({ amountUsd, purpose, reference, rail, memo, payoutWallet, bankAccountId, billId, bucket } = {}) {
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

    const destination = await this._settlementDestination({ bankAccountId, billId });
    const bank = destination.kind === 'bank' ? destination.bank : null;

    const allocation = await TrustAllocationEngine.assertPayout({ bucket, payoutWallet: wallet, purpose, amountUsd, reference });

    const payoutRail = destination.kind === 'bill' ? 'bill_pay' : (rail || cfg.defaultRail);
    const quote = await SpritzEngine.createOffRampQuote({
      accountId: destination.accountId,
      amount: Number(amountUsd).toFixed(2),
      chain: cfg.network,
      tokenAddress: cfg.settlementToken || undefined,
      amountMode: 'output',
      rail: payoutRail,
      memo: destination.kind === 'bank' ? (memo || reference) : undefined,
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
      destination,
      amountUsd: Number(amountUsd).toFixed(2),
      quantityUnits: quantity.toString(),
      rail: payoutRail,
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
    if (cfg.payoutWalletSigner === 'external') {
      // Coinbase (external) payout wallet: hand back the unsigned Spritz payment
      // for the wallet to sign; confirmPayout() books it once the tx is sent.
      const unsignedTx = await SpritzEngine.prepareQuoteTransaction(spritzQuoteId, { senderAddress: cfg.payoutWallet });
      return {
        status: 'awaiting_signature',
        reference,
        distributionId: String(distributionId),
        release,
        spritzQuoteId,
        payoutWallet: cfg.payoutWallet,
        signer: { type: 'external', provider: cfg.payoutWalletProvider },
        unsignedTx,
        next: `Sign ${unsignedTx.approve ? 'approve then ' : ''}payment from ${cfg.payoutWallet} in the ${cfg.payoutWalletProvider} wallet, then POST /spritz/treasury/payout/confirm { spritzQuoteId, txHash, distributionId, reference }`,
      };
    }
    const settlement = await SpritzEngine.executeQuote(spritzQuoteId);
    return this._bookPayout({ distributionId, spritzQuoteId, reference, amountUsd, createdBy, release, settlement });
  }

  /** Record a Spritz payout signed by the external (Coinbase) payout wallet. */
  static async confirmPayout({ distributionId, spritzQuoteId, txHash, reference, amountUsd, createdBy } = {}) {
    if (!distributionId) throw badRequest('distributionId required');
    if (!spritzQuoteId) throw badRequest('spritzQuoteId required');
    if (!reference) throw badRequest('reference required');
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) throw badRequest('txHash required');
    return this._bookPayout({ distributionId, spritzQuoteId, reference, amountUsd, createdBy, release: null, settlement: { txHash, quoteId: spritzQuoteId, signer: 'external' } });
  }

  static async _bookPayout({ distributionId, spritzQuoteId, reference, amountUsd, createdBy, release, settlement }) {
    const cfg = this.config();
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

  // ─── payout wallet (Coinbase Spritz wallet) ───────────────────────────────

  /**
   * Register the externally-held payout wallet (default: the trust's Coinbase
   * Spritz wallet) in the external-wallet registry so it is a known ledger
   * source, and report whether it is the configured Spritz payout wallet.
   */
  static async connectPayoutWallet({ address, provider, label, createdBy } = {}) {
    const cfg = this.config();
    const wallet = address || cfg.payoutWallet;
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw badRequest('address must be a valid EVM address');
    if (!ExternalWalletEngine) throw conflict('ExternalWalletEngine not available', 'EXTERNAL_WALLET_UNAVAILABLE');
    const type = provider || cfg.payoutWalletProvider || 'coinbase';
    const registered = await ExternalWalletEngine.register({
      type,
      address: wallet,
      label: label || `${type} Spritz payout wallet`,
      createdBy,
    });
    return { ...(await this.payoutWalletStatus({ address: wallet })), registered };
  }

  /** Configured payout wallet, its registry entry, on-chain USDC balance and policy allow-list state. */
  static async payoutWalletStatus({ address } = {}) {
    const cfg = this.config();
    const wallet = address || cfg.payoutWallet;
    const configured = sameAddress(wallet, cfg.payoutWallet);
    const issues = [];
    if (!configured) issues.push(`${wallet} is not the configured SPRITZ_PAYOUT_WALLET (${cfg.payoutWallet})`);

    let registry = null;
    if (ExternalWalletEngine) {
      try { registry = await ExternalWalletEngine.getWalletByAddress(wallet); } catch (e) { registry = null; }
    }
    if (!registry) issues.push('payout wallet is not registered as an external wallet; POST /spritz/wallet/connect');

    let usdcBalance = null;
    if (viem && cfg.settlementToken) {
      try {
        const client = viem.createPublicClient({ chain: viemChain(cfg.chainId), transport: viem.http(getConfig().rpcUrl) });
        const raw = await client.readContract({ address: cfg.settlementToken, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [wallet] });
        usdcBalance = unitsToUsd(raw);
      } catch (e) {
        usdcBalance = null;
      }
    }

    let policy = null;
    try {
      policy = await TrustPolicyEngine.beneficiaryStatus({ beneficiary: wallet, token: cfg.settlementToken || undefined });
      if (!policy.allowed) issues.push('payout wallet is not an allow-listed beneficiary on the policy contract');
    } catch (e) {
      issues.push(`policy contract check unavailable: ${e.message}`);
    }

    return {
      address: wallet,
      configured,
      signer: { type: sameAddress(wallet, cfg.payoutWallet) ? cfg.payoutWalletSigner : 'external', provider: cfg.payoutWalletProvider },
      registry: registry ? { id: registry.id, type: registry.type, label: registry.label, createdAt: registry.created_at } : null,
      chainId: cfg.chainId,
      network: cfg.network,
      settlementToken: cfg.settlementToken,
      usdcBalance,
      policy,
      ready: issues.length === 0,
      issues,
    };
  }

  /**
   * Unsigned owner transactions that allow-list the payout wallet on the policy
   * contract. The contract owner (trustee governance wallet) signs them; the
   * server wallet cannot, so nothing is submitted here.
   */
  static async prepareAllowlistPayoutWallet({ address, maxPerDistributionUsd, periodCapUsd, periodSeconds } = {}) {
    const cfg = this.config();
    const wallet = address || cfg.payoutWallet;
    const toUnits = (usd) => (usd === undefined || usd === null || usd === '' ? '0' : usdToUnits(usd).toString());
    const prepared = await TrustPolicyEngine.prepareBeneficiaryAllowlist({
      beneficiary: wallet,
      token: cfg.settlementToken || undefined,
      maxPerDistribution: toUnits(maxPerDistributionUsd),
      periodCap: toUnits(periodCapUsd),
      periodSeconds: Number(periodSeconds) || 0,
    });
    const status = await this.payoutWalletStatus({ address: wallet });
    return {
      ...prepared,
      beneficiary: wallet,
      token: cfg.settlementToken,
      alreadyAllowed: Boolean(status.policy && status.policy.allowed),
      limits: { maxPerDistributionUsd: num(maxPerDistributionUsd), periodCapUsd: num(periodCapUsd), periodSeconds: Number(periodSeconds) || 0 },
      instructions: prepared.serverWalletIsOwner
        ? 'Server wallet owns the contract: POST /api/dapp/trust-policy/beneficiaries submits directly.'
        : `Sign and broadcast each tx from ${prepared.owner} (contract owner) on chain ${prepared.chainId}, then re-check /spritz/wallet/status.`,
    };
  }

  /** Staged/executed Spritz payouts recorded against allocation buckets. */
  static async listPayouts(opts = {}) {
    return TrustAllocationEngine.listPayouts(opts);
  }

  /** Funding legs (ERP reserve -> USDC -> policy contract) recorded as canonical money requests. */
  static async listFundingLegs({ limit = 50 } = {}) {
    const cfg = this.config();
    const rows = await this._requestsToContract(cfg.policyAddress);
    return rows.slice(0, Math.min(Math.max(Number(limit) || 50, 1), 200)).map((r) => ({
      requestId: r.id,
      proposalId: r.proposal_id,
      sourceType: r.source_type,
      sourceAccount: r.source_account,
      sourceToken: r.source_token,
      sourceModule: r.source_module,
      amount: r.amount,
      route: r.route,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  /**
   * One live snapshot of the Treasury-Core ERP -> policy contract -> Spritz
   * pipeline: funding route, canonical buckets, policy contract, payout wallet,
   * settlement destinations, and the most recent legs in each direction.
   */
  static async pipeline({ limit = 20 } = {}) {
    const cfg = this.config();
    const settle = (p) => p.then((value) => ({ ok: true, value })).catch((e) => ({ ok: false, error: e.message }));
    const [readiness, policy, payoutWallet, buckets, funding, payouts] = await Promise.all([
      settle(this.readiness()),
      settle(TrustPolicyEngine.status()),
      settle(this.payoutWalletStatus()),
      settle(TrustAllocationEngine.summaries()),
      settle(this.listFundingLegs({ limit })),
      settle(this.listPayouts({ limit })),
    ]);
    const errors = [];
    const pick = (label, r, fallback = null) => { if (!r.ok) errors.push(`${label}: ${r.error}`); return r.ok ? r.value : fallback; };
    const rd = pick('treasury leg', readiness);
    const pw = pick('payout wallet', payoutWallet);
    const pol = pick('policy contract', policy);
    const stages = [
      { key: 'erp', label: 'Treasury-Core ERP (canonical GL)', ok: Boolean(rd && rd.fundingSource && (!rd.fundingSource.route || rd.fundingSource.route.executable !== false)), detail: rd ? `${rd.fundingSource.system || rd.fundingSource.sourceType} ${rd.fundingSource.sourceAccountId} -> ${cfg.gl.treasuryAccount}` : null },
      { key: 'policy', label: 'Trust distribution policy (on-chain)', ok: Boolean(pol && pol.live && !pol.paused), detail: pol ? `${cfg.policyAddress} chain ${cfg.chainId}${pol.paused ? ' PAUSED' : ''}` : null },
      { key: 'payoutWallet', label: 'Spritz payout wallet (Coinbase)', ok: Boolean(pw && pw.ready), detail: pw ? (pw.ready ? `${pw.address} allow-listed` : pw.issues.join('; ')) : null },
      { key: 'spritz', label: 'Spritz off-ramp / Bill Pay', ok: Boolean(rd && rd.settlementDestinations && rd.settlementDestinations.default), detail: rd && rd.settlementDestinations ? `bank ${rd.settlementDestinations.bank}, bills ${rd.settlementDestinations.bills}` : null },
    ];
    return {
      asOf: new Date().toISOString(),
      ready: stages.every((s) => s.ok) && errors.length === 0,
      stages,
      errors,
      config: {
        policyContract: cfg.policyAddress, chainId: cfg.chainId, network: cfg.network, settlementToken: cfg.settlementToken,
        payoutWallet: cfg.payoutWallet, payoutWalletSigner: cfg.payoutWalletSigner, gl: cfg.gl, fundingSource: cfg.fundingSource,
      },
      readiness: rd,
      policy: pol,
      payoutWallet: pw,
      buckets: pick('allocation buckets', buckets, []),
      fundingLegs: pick('funding legs', funding, []),
      payouts: pick('payouts', payouts, []),
    };
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /**
   * Where a payout settles: an explicit linked Spritz bill (`billId`), else
   * the settlement bank when one is linked, else the single payable bill.
   * A `bankAccountId` other than the settlement bank is always refused.
   */
  static async _settlementDestination({ bankAccountId, billId } = {}) {
    const cfg = this.config();
    if (billId) {
      const bills = await SpritzEngine.listBills();
      const bill = (Array.isArray(bills) ? bills : []).find(b => b && b.id === billId);
      if (!bill) throw conflict(`Spritz bill ${billId} is not linked on this account`, 'SPRITZ_BILL_NOT_FOUND');
      if (bill.status !== 'active' || bill.unpayableCode) throw conflict(`Spritz bill ${billId} is ${bill.unpayableCode || bill.status}, not payable`, 'SPRITZ_BILL_NOT_PAYABLE');
      return { kind: 'bill', accountId: bill.id, bill: { id: bill.id, name: bill.name || null, type: bill.type || null, institution: (bill.institution && bill.institution.name) || null, accountNumberLast4: bill.accountNumberLast4 || null } };
    }
    const bank = await this.settlementBank();
    if (bankAccountId) {
      if (!bank || bankAccountId !== bank.id) {
        throw conflict(`bankAccountId ${bankAccountId} is not the settlement bank (${bank ? bank.id : 'none linked'}); Spritz payouts settle only to ${cfg.settlementBankMatch} or a linked bill`, 'SPRITZ_SETTLEMENT_BANK_MISMATCH');
      }
    }
    if (bank) return { kind: 'bank', accountId: bank.id, bank };
    const bills = (await SpritzEngine.listBills().catch(() => []) || []).filter(b => b && b.status === 'active' && !b.unpayableCode);
    if (bills.length === 1) return this._settlementDestination({ billId: bills[0].id });
    if (bills.length > 1) throw badRequest(`billId required: ${bills.length} payable Spritz bills are linked and the trust has no settlement bank`, 'SPRITZ_BILL_ID_REQUIRED');
    throw conflict('No Spritz settlement destination: the trust has no bank account and no payable bill is linked (activate Spritz Bill Pay)', 'SPRITZ_SETTLEMENT_DESTINATION_REQUIRED');
  }

  static _fundingSource({ sourceType, sourceAccountId, sourceToken, sourceModule } = {}, { optional = false } = {}) {
    const cfg = this.config().fundingSource;
    const explicit = Boolean(sourceType || sourceAccountId || sourceToken || sourceModule);
    const source = explicit ? { sourceType, sourceAccountId, sourceToken, sourceModule } : {
      sourceType: cfg.sourceType || undefined,
      sourceAccountId: cfg.sourceAccountId || undefined,
      sourceToken: cfg.sourceToken || undefined,
      sourceModule: cfg.sourceModule || undefined,
    };
    for (const k of Object.keys(source)) if (!source[k]) source[k] = undefined;
    if (optional && !explicit) return {};
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
        `SELECT r.id, r.proposal_id, r.source_type, r.source_account, r.source_token, r.source_module, r.amount, r.route, r.status, r.created_at
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

module.exports = { SpritzTreasuryLegEngine, usdToUnits, unitsToUsd, bookJournal: book, defaultFundingSource, DEFAULT_SPRITZ_PAYOUT_WALLET, sameAddress };

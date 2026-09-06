'use strict';

/**
 * Trust ecosystem — the backend surface that the browser extension and the
 * mobile app use to pay and manage trust expenses on behalf of trustees and
 * beneficiaries.
 *
 * Every client is thin: it holds a portal session (email-OTP or SIWE JWT from
 * /api/dapp/auth) and calls these methods through /api/dapp/ecosystem/*. The
 * thirdweb secret key, the server wallet and the price oracle never leave the
 * backend. Value only moves through ThirdwebServerWalletEngine.send, which is
 * shadow unless THIRDWEB_SERVER_WALLET_LIVE=true, and only for a distribution
 * request that both trustees (maker + checker) have approved.
 *
 * Flow:
 *   session   → who am I, my role, my limits, my wallets
 *   portfolio → priced token holdings of the linked wallet (thirdweb wallet tokens)
 *   expenses  → submit (any portal user, within role limit + purpose),
 *               list (own for beneficiaries, all for trustees),
 *               approve/reject (trustees only, existing maker/checker control),
 *               pay (trustees only, approved requests, via the server wallet)
 */

const { DistributionRequestEngine } = require('./distributionRequestEngine');
const DistributionPolicy = require('./distributionPolicy');
const { ThirdwebServerWalletEngine } = require('./thirdwebServerWalletEngine');
const { ThirdwebPriceOracle, NATIVE_TOKEN } = require('./thirdwebPriceOracle');
const { getConfig: getBaseConfig } = require('./config');
const { TRUSTEES } = require('./trustees');

let DappEngine = null;
try { ({ DappEngine } = require('./dappEngine')); } catch (e) { /* optional */ }
let SmartWalletProvisioner = null;
try { ({ SmartWalletProvisioner } = require('./smartWalletProvisioner')); } catch (e) { /* optional */ }

const PAYABLE_STATUSES = new Set(['approved']);
/** Marks ecosystem requests so checker approval does not auto-execute via the fiat payout center. */
const PAYOUT_RAIL = 'thirdweb_server_wallet';

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }

function rolesOf(user) {
  const u = user || {};
  const roles = Array.isArray(u.roles) ? u.roles : [];
  return [u.role, u.activeRole, ...roles].filter(Boolean).map((r) => String(r).toLowerCase());
}

function isTrustee(user) {
  return rolesOf(user).some((r) => r.includes('trustee') || r === 'admin' || r === 'operator');
}

/** Maker/checker seat for a trustee user: explicit role first, then the trustee roster by email. */
function trusteeSeat(user, explicitRole) {
  if (explicitRole) return String(explicitRole).toLowerCase().replace(/^trustee_/, '');
  const roles = rolesOf(user);
  if (roles.includes('trustee_maker')) return 'maker';
  if (roles.includes('trustee_checker')) return 'checker';
  const email = String((user || {}).email || '').toLowerCase();
  const seat = TRUSTEES.find((t) => ['maker', 'checker'].includes(t.role) && String(t.email).toLowerCase() === email);
  return seat ? seat.role : null;
}

function forbidden(message) { return Object.assign(new Error(message), { status: 403, code: 'FORBIDDEN' }); }
function badRequest(message, code = 'BAD_REQUEST') { return Object.assign(new Error(message), { status: 400, code }); }
function notFound(message) { return Object.assign(new Error(message), { status: 404, code: 'NOT_FOUND' }); }

class TrustEcosystemEngine {
  static getConfig() {
    const base = getBaseConfig();
    return {
      chainId: Number(str('THIRDWEB_SERVER_WALLET_CHAIN_ID') || base.chainId || 1),
      apiUrl: str('THIRDWEB_API_URL', 'https://api.thirdweb.com').replace(/\/+$/, ''),
      secretKey: str('THIRDWEB_SECRET_KEY'),
      clientId: str('THIRDWEB_CLIENT_ID'),
      payoutToken: str('ECOSYSTEM_PAYOUT_TOKEN_ADDRESS') || null,
      timeoutMs: Number(str('THIRDWEB_API_TIMEOUT_MS', '20000')),
    };
  }

  /**
   * Public, unauthenticated discovery document for extension/mobile builds:
   * where to authenticate, which chain, which client id, what the policy is.
   * Contains no secrets.
   */
  static manifest() {
    const cfg = this.getConfig();
    const wallet = ThirdwebServerWalletEngine.readiness();
    return {
      name: 'DLB Trust Ecosystem',
      version: 1,
      chainId: cfg.chainId,
      thirdwebClientId: cfg.clientId || null,
      payoutToken: cfg.payoutToken || 'native',
      auth: {
        emailOtp: { send: '/api/dapp/auth/send-code', verify: '/api/dapp/auth/verify' },
        siwe: { nonce: '/api/dapp/auth/siwe/nonce', verify: '/api/dapp/auth/siwe/verify' },
        session: '/api/dapp/auth/me',
        header: 'Authorization: Bearer <token>',
      },
      endpoints: {
        session: '/api/dapp/ecosystem/session',
        portfolio: '/api/dapp/ecosystem/portfolio',
        quote: '/api/dapp/ecosystem/quote',
        expenses: '/api/dapp/ecosystem/expenses',
        approve: '/api/dapp/ecosystem/expenses/:id/approve',
        reject: '/api/dapp/ecosystem/expenses/:id/reject',
        pay: '/api/dapp/ecosystem/expenses/:id/pay',
      },
      policy: DistributionPolicy.getPolicy(),
      treasury: {
        address: wallet.address || null,
        shadow: wallet.shadow,
        canSend: wallet.canSend,
      },
      priceOracle: ThirdwebPriceOracle.readiness(),
    };
  }

  /** The caller's ecosystem context: role, limits, linked wallets. */
  static async session(user) {
    if (!user) throw forbidden('session required');
    const trustee = isTrustee(user);
    const requesterRole = trustee ? 'trustee' : 'beneficiary';
    const policy = DistributionPolicy.getPolicy();
    let dappUser = null;
    if (DappEngine && user.email) {
      dappUser = await DappEngine.getUserByEmail(user.email).then((u) => DappEngine._sanitizeUser(u)).catch(() => null);
    }
    const walletAddress = (dappUser && dappUser.wallet_address) || user.walletAddress || null;
    let smartAccount = user.smartAccount || null;
    if (!smartAccount && SmartWalletProvisioner && (dappUser || walletAddress)) {
      smartAccount = dappUser
        ? SmartWalletProvisioner.describe(dappUser)
        : await SmartWalletProvisioner.predictAddress(walletAddress).then((p) => (p ? { enabled: true, owner: walletAddress, ...p } : null)).catch(() => null);
    }
    return {
      userId: user.userId || (dappUser && dappUser.id) || null,
      email: user.email || null,
      name: (dappUser && dappUser.name) || null,
      role: requesterRole,
      roles: rolesOf(user),
      trusteeSeat: trustee ? trusteeSeat(user) : null,
      authMethod: user.authMethod || null,
      walletAddress,
      smartAccount,
      chainId: this.getConfig().chainId,
      limits: {
        perTransactionUsd: policy.limitsUsd[requesterRole],
        purposes: policy.purposes,
      },
      capabilities: {
        submitExpense: true,
        approveExpense: trustee,
        payExpense: trustee,
        viewAllExpenses: trustee,
      },
    };
  }

  /** Priced holdings of a wallet via thirdweb's wallet-token endpoint. */
  static async portfolio({ user, address, chainId } = {}) {
    const cfg = this.getConfig();
    if (!cfg.secretKey) throw Object.assign(new Error('THIRDWEB_SECRET_KEY is required'), { status: 503 });
    const session = await this.session(user);
    const target = address || session.walletAddress || (session.smartAccount && session.smartAccount.address);
    if (!target) throw badRequest('no wallet linked to this session; pass ?address=', 'NO_WALLET');
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw badRequest('address invalid');
    const own = [session.walletAddress, session.smartAccount && session.smartAccount.address]
      .filter(Boolean).map((a) => a.toLowerCase());
    if (!session.capabilities.viewAllExpenses && !own.includes(target.toLowerCase())) {
      throw forbidden('beneficiaries can only view their own wallets');
    }
    const chain = Number(chainId || cfg.chainId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let response;
    try {
      response = await fetch(`${cfg.apiUrl}/v1/wallets/${target}/tokens?chainId=${chain}&limit=100`, {
        headers: { 'x-secret-key': cfg.secretKey }, signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) {
      const detail = json.error ? (json.error.message || JSON.stringify(json.error)) : response.statusText;
      throw Object.assign(new Error(`thirdweb wallet tokens failed (${response.status}): ${detail}`), { status: 502 });
    }
    const result = json.result || json;
    const tokens = (result.tokens || []).map((t) => {
      const decimals = Number(t.decimals || 0);
      const balance = BigInt(t.balance || '0');
      const scale = 10n ** BigInt(decimals);
      const amount = Number(balance / scale) + Number(balance % scale) / Number(scale);
      const priceUsd = Number(t.priceUsd ?? (t.prices && t.prices.USD) ?? (t.price_data && t.price_data.price_usd));
      return {
        chainId: t.chainId || chain,
        tokenAddress: t.tokenAddress || t.token_address || NATIVE_TOKEN,
        symbol: t.symbol,
        name: t.name,
        decimals,
        balance: balance.toString(),
        amount,
        priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
        valueUsd: Number.isFinite(priceUsd) ? Math.round(amount * priceUsd * 100) / 100 : null,
      };
    });
    const totalUsd = Math.round(tokens.reduce((s, t) => s + (t.valueUsd || 0), 0) * 100) / 100;
    return { address: target, chainId: chain, tokens, totalUsd, pricedAt: new Date().toISOString() };
  }

  /** Price quote for a USD expense in the payout asset (no side effects). */
  static async quote({ amountUsd, tokenAddress, chainId } = {}) {
    const cfg = this.getConfig();
    return ThirdwebPriceOracle.quantityForUsd({
      chainId: Number(chainId || cfg.chainId),
      tokenAddress: tokenAddress || cfg.payoutToken || null,
      amountUsd,
    });
  }

  /** Submit an expense as a distribution request under the caller's role limit. */
  static async submitExpense({ user, amountUsd, purpose, memo, destinationAddress, beneficiaryEmail, beneficiaryName, client = 'ecosystem' } = {}) {
    const session = await this.session(user);
    const requesterRole = session.role;
    const email = requesterRole === 'trustee' && beneficiaryEmail ? beneficiaryEmail : session.email;
    if (!email) throw badRequest('an email-linked session (or beneficiaryEmail for trustees) is required');
    const destination = destinationAddress || session.walletAddress || (session.smartAccount && session.smartAccount.address);
    if (!destination) throw badRequest('destinationAddress required (no wallet linked to this session)', 'NO_WALLET');
    const request = await DistributionRequestEngine.createRequest({
      type: 'distribution',
      requesterRole,
      beneficiaryEmail: email,
      beneficiaryName: beneficiaryName || session.name || undefined,
      amountUsd,
      destinationAddress: destination,
      memo,
      purpose,
      createdBy: session.email || session.userId,
      metadata: { channel: 'ecosystem', client, payoutRail: PAYOUT_RAIL, submittedBy: session.email || session.userId, walletAddress: session.walletAddress },
    });
    return this._view(request);
  }

  static async listExpenses({ user, status, limit = 50 } = {}) {
    const session = await this.session(user);
    const rows = await DistributionRequestEngine.listRequests({
      status,
      beneficiaryEmail: session.capabilities.viewAllExpenses ? undefined : session.email,
      limit,
    });
    return rows.map((r) => this._view(r));
  }

  static async getExpense({ user, requestId } = {}) {
    const session = await this.session(user);
    const request = await DistributionRequestEngine.getRequest(requestId);
    if (!request) throw notFound('expense not found');
    if (!session.capabilities.viewAllExpenses && String(request.beneficiary_email).toLowerCase() !== String(session.email).toLowerCase()) {
      throw forbidden('not your expense');
    }
    return this._view(request);
  }

  static async approveExpense({ user, requestId, role, signature, proofId } = {}) {
    const session = await this.session(user);
    if (!session.capabilities.approveExpense) throw forbidden('trustee access required');
    const seat = trusteeSeat(user, role);
    if (!seat) throw forbidden('no maker/checker seat for this trustee');
    const request = await DistributionRequestEngine.approveRequest({
      requestId, role: seat, trusteeEmail: session.email, signature, signerName: session.name, proofId,
    });
    return this._view(request);
  }

  static async rejectExpense({ user, requestId, reason } = {}) {
    const session = await this.session(user);
    if (!session.capabilities.approveExpense) throw forbidden('trustee access required');
    const request = await DistributionRequestEngine.rejectRequest({ requestId, trusteeEmail: session.email, reason });
    return this._view(request);
  }

  /**
   * Pay an approved expense from the thirdweb server wallet. The USD amount
   * comes from the approved request; the oracle converts it to the payout
   * asset and the server wallet re-prices the quantity before sending, so a
   * limit breach or a price drift beyond tolerance is rejected here.
   * Shadow unless THIRDWEB_SERVER_WALLET_LIVE=true.
   */
  static async payExpense({ user, requestId, tokenAddress, chainId } = {}) {
    const session = await this.session(user);
    if (!session.capabilities.payExpense) throw forbidden('trustee access required');
    const request = await DistributionRequestEngine.getRequest(requestId);
    if (!request) throw notFound('expense not found');
    if (!PAYABLE_STATUSES.has(request.status)) {
      throw Object.assign(new Error(`expense is ${request.status}; both trustee approvals are required before payment`), { status: 409, code: 'NOT_APPROVED' });
    }
    if (request.tx_hash || (request.metadata && request.metadata.serverWalletTransferId)) {
      throw Object.assign(new Error('expense already paid'), { status: 409, code: 'ALREADY_PAID' });
    }
    const cfg = this.getConfig();
    const amountUsd = Number(request.amount_cents) / 100;
    const asset = tokenAddress || cfg.payoutToken || null;
    const chain = Number(chainId || cfg.chainId);
    const quoted = await ThirdwebPriceOracle.quantityForUsd({ chainId: chain, tokenAddress: asset, amountUsd });
    const transfer = await ThirdwebServerWalletEngine.send({
      to: request.destination_address,
      quantity: quoted.quantity,
      tokenAddress: asset,
      chainId: chain,
      reference: request.id,
      memo: request.memo || `${request.metadata && request.metadata.purpose} expense ${request.id}`,
      amountUsd,
      requesterRole: request.requester_role,
      purpose: request.metadata && request.metadata.purpose,
    });
    const updated = await DistributionRequestEngine._update(request.id, {
      status: transfer.shadow ? 'approved' : 'executed',
      tx_hash: transfer.transactionHash || null,
      metadata: {
        ...(request.metadata || {}),
        serverWalletTransferId: transfer.shadow ? null : transfer.id,
        lastPayment: {
          transferId: transfer.id,
          shadow: transfer.shadow,
          status: transfer.status,
          thirdwebTransactionId: transfer.transactionId || null,
          symbol: quoted.symbol,
          quantity: quoted.quantity,
          priceUsd: quoted.priceUsd,
          paidBy: session.email,
          at: new Date().toISOString(),
        },
      },
    });
    return { expense: this._view(DistributionRequestEngine._rowToObject(updated)), transfer };
  }

  static _view(r) {
    if (!r) return null;
    const meta = r.metadata || {};
    return {
      id: r.id,
      status: r.status,
      requesterRole: r.requester_role,
      beneficiaryEmail: r.beneficiary_email,
      beneficiaryName: r.beneficiary_name,
      amountUsd: Number(r.amount_cents) / 100,
      currency: r.currency,
      purpose: meta.purpose || null,
      limitUsd: meta.limitUsd || null,
      memo: r.memo,
      destinationAddress: r.destination_address,
      approvals: (r.approvals || []).map((a) => ({ role: a.role, trusteeEmail: a.trusteeEmail, approvedAt: a.approvedAt })),
      payoutRail: meta.payoutRail || 'payout_center',
      payment: meta.lastPayment || null,
      txHash: r.tx_hash || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

module.exports = { TrustEcosystemEngine, isTrustee, trusteeSeat };

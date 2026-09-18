'use strict';

/**
 * Payout Route Engine
 *
 * Decides which rail settles an approved distribution or disbursement.
 *
 * - A wallet destination stays on the crypto path: the SIT mint by default, or
 *   the thirdweb server wallet when the record asks for it.
 * - A bank destination settles over ACH (NACHA file + AS2 transmission), or
 *   over the API gateway (Apigee / APISIX) when `payoutRail` asks for it.
 * - A biller destination settles over the bill-pay provider.
 * - A google_wallet destination provisions a Save-to-Google-Wallet pass for
 *   the trustee/beneficiary and funds them over the gateway (bank details) or
 *   the SIT mint (wallet address). The pass itself is not a funded card.
 *
 * The routing decision is derived from the canonical request, so the same
 * maker/checker approval covers either side and neither rail can be reached
 * without one.
 */

let viem;
try { viem = require('viem'); } catch (e) { viem = null; }

let validateRouting;
try { ({ validateRouting } = require('../ach/nachaGenerator')); } catch (e) { validateRouting = null; }

const DESTINATION_TYPES = ['wallet', 'bank', 'biller', 'google_wallet'];
const GATEWAY_RAILS = ['api_gateway', 'apigee', 'apisix'];
const BANK_RAILS = ['ach', ...GATEWAY_RAILS];
const ACCOUNT_TYPES = ['checking', 'savings'];
const HOLDER_TYPES = ['individual', 'business'];

// Rails this engine will hand to the payout center on its own. Anything else
// has to be executed deliberately, so an override cannot auto-release funds.
const ROUTED_RAILS = ['sit', 'ach', 'bill_pay', 'google_wallet', ...GATEWAY_RAILS];

// A payout receipt is stored on the request, which beneficiaries can read. The
// NACHA file and raw account fields belong in the ACH tables, not there.
const DROPPED_RECEIPT_KEYS = new Set(['nacha_content', 'nachaContent', 'file_content', 'fileContent']);
const MASKED_RECEIPT_KEYS = new Set(['accountNumber', 'account_number', 'bankAccount', 'accountReference']);

function isAddress(v) {
  return Boolean(viem && viem.isAddress && viem.isAddress(String(v || '')));
}

function digits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

function mask(v) {
  const d = digits(v);
  return d ? `****${d.slice(-4)}` : null;
}

// Bad destination details are the caller's input, so they answer 4xx rather
// than reading as a server fault.
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Which rail a wallet destination takes when the request does not name one.
// `sit` mints from the trust supply; `thirdweb_server_wallet` sends existing
// tokens from the Vault-held treasury wallet, which is released deliberately.
const WALLET_RAILS = ['sit', 'thirdweb', 'thirdweb_server_wallet', 'google_wallet'];

function defaultWalletRail() {
  const configured = String(process.env.DAPP_WALLET_PAYOUT_RAIL || '').toLowerCase().trim();
  return WALLET_RAILS.includes(configured) ? configured : 'sit';
}

function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

class PayoutRouteEngine {
  static get DESTINATION_TYPES() { return [...DESTINATION_TYPES]; }
  static get GATEWAY_RAILS() { return [...GATEWAY_RAILS]; }
  static isGatewayRail(rail) { return GATEWAY_RAILS.includes(String(rail || '').toLowerCase()); }

  /**
   * Resolve the destination type. An explicit type wins; otherwise the record
   * keeps its historical meaning, where the destination is a wallet.
   */
  static resolveDestinationType(destinationType, destinationAddress) {
    if (destinationType) {
      const normalized = String(destinationType).toLowerCase();
      if (!DESTINATION_TYPES.includes(normalized)) {
        throw badRequest(`destinationType must be one of ${DESTINATION_TYPES.join(', ')}`);
      }
      return normalized;
    }
    if (destinationAddress && isAddress(destinationAddress)) return 'wallet';
    return 'wallet';
  }

  /**
   * Validate and normalize a bank destination. Throws when the account could
   * not be paid, rather than letting an approval reach a malformed NACHA entry.
   */
  static normalizeBank(bank = {}) {
    const routingNumber = digits(pick(bank.routingNumber, bank.routing, bank.aba));
    const accountNumber = digits(pick(bank.accountNumber, bank.account, bank.bankAccount));
    const accountHolderName = pick(bank.accountHolderName, bank.recipientName, bank.fullName, bank.businessName);
    const accountType = String(pick(bank.accountType, 'checking')).toLowerCase();
    const holderType = String(pick(bank.holderType, bank.accountHolderType, 'individual')).toLowerCase();

    if (!routingNumber) throw badRequest('bank.routingNumber required for a bank destination');
    if (routingNumber.length !== 9) throw badRequest('bank.routingNumber must be 9 digits');
    if (validateRouting && !validateRouting(routingNumber)) throw badRequest(`bank.routingNumber ${routingNumber} failed the ABA checksum`);
    if (!accountNumber) throw badRequest('bank.accountNumber required for a bank destination');
    if (!accountHolderName) throw badRequest('bank.accountHolderName required for a bank destination');
    if (!ACCOUNT_TYPES.includes(accountType)) throw badRequest(`bank.accountType must be one of ${ACCOUNT_TYPES.join(', ')}`);
    if (!HOLDER_TYPES.includes(holderType)) throw badRequest(`bank.holderType must be one of ${HOLDER_TYPES.join(', ')}`);

    return {
      routingNumber,
      accountNumber,
      accountHolderName,
      accountType,
      holderType,
      // PPD credits a consumer account, CCD a business one.
      secCode: String(pick(bank.secCode, holderType === 'business' ? 'CCD' : 'PPD')).toUpperCase(),
      bankName: pick(bank.bankName),
      email: pick(bank.email),
      address: bank.address || null,
      effectiveDate: pick(bank.effectiveDate),
    };
  }

  /**
   * Validate and normalize a biller destination for the bill-pay provider.
   */
  static normalizeBiller(biller = {}) {
    const billerName = pick(biller.billerName, biller.vendorName, biller.name, biller.businessName);
    const billerId = pick(biller.billerId, biller.vendorId);
    if (!billerName && !billerId) throw badRequest('biller.billerName or biller.billerId required for a biller destination');
    return {
      billerId,
      billerName,
      accountReference: pick(biller.accountReference, biller.accountNumber, biller.customerNumber),
      invoiceNumber: pick(biller.invoiceNumber, biller.invoice),
      dueDate: pick(biller.dueDate),
      email: pick(biller.email),
      address: biller.address || null,
      deliveryMethod: String(pick(biller.deliveryMethod, biller.method, 'ach')).toLowerCase(),
    };
  }

  /**
   * Validate and normalize a Google Wallet destination. The pass is keyed by
   * the trustee/beneficiary email or wallet address; the money leg needs either
   * bank details (gateway push credit) or a wallet address (SIT mint).
   */
  static normalizeGoogleWallet(googleWallet = {}, { destinationAddress, payoutRail } = {}) {
    const email = pick(googleWallet.email, googleWallet.beneficiaryEmail);
    const walletAddress = pick(googleWallet.walletAddress, googleWallet.address, destinationAddress);
    if (!email && !walletAddress) throw badRequest('googleWallet.email or googleWallet.walletAddress required for a google_wallet destination');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('googleWallet.email is not a valid email');
    if (walletAddress && !isAddress(walletAddress)) throw badRequest('googleWallet.walletAddress is not a valid address');
    const role = String(pick(googleWallet.role, 'beneficiary')).toLowerCase();
    if (!['trustee', 'beneficiary'].includes(role)) throw badRequest('googleWallet.role must be trustee or beneficiary');

    const bankInput = googleWallet.bank || (googleWallet.routingNumber ? googleWallet : null);
    const bank = bankInput ? this.normalizeBank(bankInput) : null;
    const requested = payoutRail ? String(payoutRail).toLowerCase() : null;
    let fundingRail;
    if (bank) {
      fundingRail = requested && GATEWAY_RAILS.includes(requested) ? requested : 'api_gateway';
    } else if (walletAddress) {
      fundingRail = 'sit';
    } else {
      throw badRequest('googleWallet.bank (gateway push credit) or googleWallet.walletAddress (SIT) required to fund a google_wallet payout');
    }
    return {
      email,
      walletAddress,
      role,
      name: pick(googleWallet.name, googleWallet.fullName, bank && bank.accountHolderName),
      userId: pick(googleWallet.userId),
      bank,
      fundingRail,
    };
  }

  /**
   * Build the route for a new request. Returns the rail, the rail options the
   * payout center needs, the label to store as the record's destination, and
   * the redacted copy that is safe to persist in metadata or show in the UI.
   */
  static plan({ destinationType, destinationAddress, bank, biller, googleWallet, payoutRail, currency = 'USD' } = {}) {
    const type = this.resolveDestinationType(destinationType, destinationAddress);
    const override = payoutRail ? String(payoutRail).toLowerCase() : null;

    if (type === 'google_wallet' || (type === 'wallet' && override === 'google_wallet')) {
      if (String(currency).toUpperCase() !== 'USD') throw badRequest(`google_wallet destinations settle in USD, not ${currency}`);
      const gw = this.normalizeGoogleWallet(googleWallet || {}, { destinationAddress, payoutRail: override === 'google_wallet' ? null : override });
      const walletPass = { email: gw.email, walletAddress: gw.walletAddress, role: gw.role, name: gw.name, userId: gw.userId };
      const bankOptions = gw.bank ? {
        routingNumber: gw.bank.routingNumber,
        accountNumber: gw.bank.accountNumber,
        accountType: gw.bank.accountType,
        holderType: gw.bank.holderType,
        recipientName: gw.bank.accountHolderName,
        bankName: gw.bank.bankName,
        secCode: gw.bank.secCode,
      } : {};
      return {
        destinationType: 'google_wallet',
        rail: 'google_wallet',
        engine: 'payout_center',
        asset: gw.fundingRail === 'sit' ? 'SIT' : 'USD',
        destinationLabel: `google_wallet:${gw.email || gw.walletAddress}`,
        railOptions: { walletPass, fundingRail: gw.fundingRail, walletAddress: gw.walletAddress, ...bankOptions },
        redacted: {
          destinationType: 'google_wallet',
          rail: 'google_wallet',
          fundingRail: gw.fundingRail,
          email: gw.email,
          walletAddress: gw.walletAddress,
          role: gw.role,
          bankName: gw.bank ? gw.bank.bankName : null,
          routingNumber: gw.bank ? gw.bank.routingNumber : null,
          accountNumber: gw.bank ? mask(gw.bank.accountNumber) : null,
          cardFunding: 'not_provisioned: pass/link only; funded NFC card credit requires a Token Service Provider',
        },
        autoExecutable: true,
      };
    }

    if (type === 'wallet') {
      if (!destinationAddress) throw badRequest('destinationAddress required for a wallet destination');
      if (override && !WALLET_RAILS.includes(override)) {
        throw badRequest(`payoutRail for a wallet destination must be one of ${WALLET_RAILS.join(', ')}`);
      }
      const rail = override || defaultWalletRail();
      const engine = rail === 'thirdweb' || rail === 'thirdweb_server_wallet' ? 'thirdweb' : 'payout_center';
      return {
        destinationType: type,
        rail,
        engine,
        asset: 'SIT',
        destinationLabel: destinationAddress,
        railOptions: {},
        redacted: { destinationType: type, rail, destination: destinationAddress },
        autoExecutable: engine === 'payout_center' && ROUTED_RAILS.includes(rail),
      };
    }

    if (String(currency).toUpperCase() !== 'USD') {
      throw badRequest(`${type} destinations settle in USD, not ${currency}`);
    }

    if (type === 'bank') {
      const normalized = this.normalizeBank(bank || {});
      if (override && !BANK_RAILS.includes(override)) {
        throw badRequest(`payoutRail for a bank destination must be one of ${BANK_RAILS.join(', ')}`);
      }
      const rail = override || 'ach';
      return {
        destinationType: type,
        rail,
        engine: 'payout_center',
        asset: 'USD',
        destinationLabel: `${GATEWAY_RAILS.includes(rail) ? rail : 'ach'}:${mask(normalized.accountNumber)}`,
        railOptions: {
          routingNumber: normalized.routingNumber,
          accountNumber: normalized.accountNumber,
          accountType: normalized.accountType,
          holderType: normalized.holderType,
          recipientName: normalized.accountHolderName,
          fullName: normalized.holderType === 'individual' ? normalized.accountHolderName : null,
          businessName: normalized.holderType === 'business' ? normalized.accountHolderName : null,
          bankName: normalized.bankName,
          email: normalized.email,
          address: normalized.address,
          secCode: normalized.secCode,
          effectiveDate: normalized.effectiveDate,
        },
        redacted: {
          destinationType: type,
          rail,
          accountHolderName: normalized.accountHolderName,
          bankName: normalized.bankName,
          accountType: normalized.accountType,
          secCode: normalized.secCode,
          routingNumber: normalized.routingNumber,
          accountNumber: mask(normalized.accountNumber),
        },
        autoExecutable: ROUTED_RAILS.includes(rail),
      };
    }

    const normalized = this.normalizeBiller(biller || {});
    const rail = override || 'bill_pay';
    return {
      destinationType: type,
      rail,
      engine: 'payout_center',
      asset: 'USD',
      destinationLabel: `biller:${normalized.billerName || normalized.billerId}`,
      railOptions: {
        billerId: normalized.billerId,
        billerName: normalized.billerName,
        businessName: normalized.billerName,
        accountReference: normalized.accountReference,
        invoiceNumber: normalized.invoiceNumber,
        dueDate: normalized.dueDate,
        email: normalized.email,
        address: normalized.address,
        deliveryMethod: normalized.deliveryMethod,
      },
      redacted: {
        destinationType: type,
        rail,
        billerName: normalized.billerName,
        billerId: normalized.billerId,
        accountReference: normalized.accountReference ? mask(normalized.accountReference) || normalized.accountReference : null,
        invoiceNumber: normalized.invoiceNumber,
        deliveryMethod: normalized.deliveryMethod,
      },
      autoExecutable: ROUTED_RAILS.includes(rail),
    };
  }

  /**
   * Rebuild the route for a stored request row at execution time.
   */
  static resolveFromRecord(record = {}) {
    const metadata = record.metadata || {};
    const stored = metadata.payoutDestination || {};
    return this.plan({
      destinationType: record.destination_type || stored.destinationType,
      destinationAddress: record.destination_address,
      bank: stored.destinationType === 'bank' ? stored : undefined,
      biller: stored.destinationType === 'biller' ? stored : undefined,
      googleWallet: stored.destinationType === 'google_wallet'
        ? { ...(stored.walletPass || {}), bank: stored.routingNumber ? stored : undefined }
        : undefined,
      payoutRail: stored.destinationType === 'google_wallet' ? (stored.fundingRail || metadata.payoutRail) : metadata.payoutRail,
      currency: record.currency || 'USD',
    });
  }

  /**
   * Strip the NACHA file and mask account fields out of a payout receipt
   * before it is persisted on the distribution request.
   */
  static scrubReceipt(value, seen = new WeakSet()) {
    if (Array.isArray(value)) return value.map(v => this.scrubReceipt(v, seen));
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return undefined;
    seen.add(value);
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (DROPPED_RECEIPT_KEYS.has(key)) continue;
      out[key] = MASKED_RECEIPT_KEYS.has(key) ? (mask(v) || null) : this.scrubReceipt(v, seen);
    }
    return out;
  }

  static mask(v) { return mask(v); }
}

module.exports = { PayoutRouteEngine };

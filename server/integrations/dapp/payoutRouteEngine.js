'use strict';

/**
 * Payout Route Engine
 *
 * Decides which rail settles an approved distribution or disbursement.
 *
 * - A wallet destination stays on the crypto path: the SIT mint by default, or
 *   the thirdweb server wallet when the record asks for it.
 * - A bank destination settles over ACH (NACHA file + AS2 transmission).
 * - A biller destination settles over the bill-pay provider.
 *
 * The routing decision is derived from the canonical request, so the same
 * maker/checker approval covers either side and neither rail can be reached
 * without one.
 */

let viem;
try { viem = require('viem'); } catch (e) { viem = null; }

let validateRouting;
try { ({ validateRouting } = require('../ach/nachaGenerator')); } catch (e) { validateRouting = null; }

const DESTINATION_TYPES = ['wallet', 'bank', 'biller'];
const ACCOUNT_TYPES = ['checking', 'savings'];
const HOLDER_TYPES = ['individual', 'business'];

// Rails this engine will hand to the payout center on its own. Anything else
// has to be executed deliberately, so an override cannot auto-release funds.
const ROUTED_RAILS = ['sit', 'ach', 'bill_pay'];

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

function pick(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

class PayoutRouteEngine {
  static get DESTINATION_TYPES() { return [...DESTINATION_TYPES]; }

  /**
   * Resolve the destination type. An explicit type wins; otherwise the record
   * keeps its historical meaning, where the destination is a wallet.
   */
  static resolveDestinationType(destinationType, destinationAddress) {
    if (destinationType) {
      const normalized = String(destinationType).toLowerCase();
      if (!DESTINATION_TYPES.includes(normalized)) {
        throw new Error(`destinationType must be one of ${DESTINATION_TYPES.join(', ')}`);
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

    if (!routingNumber) throw new Error('bank.routingNumber required for a bank destination');
    if (routingNumber.length !== 9) throw new Error('bank.routingNumber must be 9 digits');
    if (validateRouting && !validateRouting(routingNumber)) throw new Error(`bank.routingNumber ${routingNumber} failed the ABA checksum`);
    if (!accountNumber) throw new Error('bank.accountNumber required for a bank destination');
    if (!accountHolderName) throw new Error('bank.accountHolderName required for a bank destination');
    if (!ACCOUNT_TYPES.includes(accountType)) throw new Error(`bank.accountType must be one of ${ACCOUNT_TYPES.join(', ')}`);
    if (!HOLDER_TYPES.includes(holderType)) throw new Error(`bank.holderType must be one of ${HOLDER_TYPES.join(', ')}`);

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
    if (!billerName && !billerId) throw new Error('biller.billerName or biller.billerId required for a biller destination');
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
   * Build the route for a new request. Returns the rail, the rail options the
   * payout center needs, the label to store as the record's destination, and
   * the redacted copy that is safe to persist in metadata or show in the UI.
   */
  static plan({ destinationType, destinationAddress, bank, biller, payoutRail, currency = 'USD' } = {}) {
    const type = this.resolveDestinationType(destinationType, destinationAddress);
    const override = payoutRail ? String(payoutRail).toLowerCase() : null;

    if (type === 'wallet') {
      if (!destinationAddress) throw new Error('destinationAddress required for a wallet destination');
      const rail = override || 'sit';
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
      throw new Error(`${type} destinations settle in USD, not ${currency}`);
    }

    if (type === 'bank') {
      const normalized = this.normalizeBank(bank || {});
      const rail = override || 'ach';
      return {
        destinationType: type,
        rail,
        engine: 'payout_center',
        asset: 'USD',
        destinationLabel: `ach:${mask(normalized.accountNumber)}`,
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
      payoutRail: metadata.payoutRail,
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

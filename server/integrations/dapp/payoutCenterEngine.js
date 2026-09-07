'use strict';

/**
 * Payout Center Engine
 *
 * Single, simplified entry point for distributions, disbursements, expenses,
 * and DEX swaps. Connects source-of-funds ledgers to beneficiary, trustee,
 * and vendor wallets using SIT, stablecoin DEX, or fiat rails.
 */

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let viem;
try { viem = require('viem'); } catch (e) { viem = null; }

function getDappEngine() {
  try { return require('./dappEngine').DappEngine; } catch (e) { return null; }
}

let SovereignTrustEngine;
try { ({ SovereignTrustEngine } = require('./sovereignTrustEngine')); } catch (e) { SovereignTrustEngine = null; }

let StablecoinDexEngine;
try { ({ StablecoinDexEngine } = require('./stablecoinDexEngine')); } catch (e) { StablecoinDexEngine = null; }

let CashAppEngine;
try { ({ CashAppEngine } = require('./cashAppEngine')); } catch (e) { CashAppEngine = null; }

let ModuleFundingEngine;
try { ({ ModuleFundingEngine } = require('./moduleFundingEngine')); } catch (e) { ModuleFundingEngine = null; }

let BtcPayEngine;
try { ({ BtcPayEngine } = require('../payments/btcPayEngine')); } catch (e) { BtcPayEngine = null; }

let ComplianceEngine;
try { ({ ComplianceEngine } = require('../compliance/complianceEngine')); } catch (e) { ComplianceEngine = null; }

let LiliBankEngine;
try { ({ LiliBankEngine } = require('../payments/liliBankEngine')); } catch (e) { LiliBankEngine = null; }

let StripeTreasuryEngine;
try { ({ StripeTreasuryEngine } = require('../payments/stripeTreasuryEngine')); } catch (e) { StripeTreasuryEngine = null; }

let ACHEngine;
try { ({ ACHEngine } = require('../ach/achEngine')); } catch (e) { ACHEngine = null; }

let getMelioClient;
try { ({ getClient: getMelioClient } = require('../melio/melioClient')); } catch (e) { getMelioClient = null; }

// Rails that pay a bank account or a biller: the recipient is an external
// party, not a wallet the dApp knows about.
const FIAT_EXTERNAL_RAILS = new Set(['ach', 'bill_pay', 'melio']);

function id(prefix = 'PAY') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function isAddress(v) { return viem && viem.isAddress && viem.isAddress(v); }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function maskRailOptions(opts) {
  if (!opts || typeof opts !== 'object') return opts;
  const clone = { ...opts };
  ['account', 'accountNumber', 'bankAccount', 'cardNumber', 'destinationAccount', 'accountReference'].forEach(k => {
    if (clone[k]) clone[k] = `****${String(clone[k]).slice(-4)}`;
  });
  return clone;
}

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

class PayoutCenterEngine {
  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS dapp_payout_center (
          id TEXT PRIMARY KEY,
          payment_type TEXT NOT NULL DEFAULT 'payout',
          source_type TEXT,
          source_account_id TEXT,
          recipient_type TEXT,
          recipient_email TEXT,
          recipient_address TEXT,
          amount_usd TEXT,
          asset TEXT,
          rail TEXT,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          tx_hash TEXT,
          tx_data JSONB DEFAULT '{}',
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    }, () => {});
  }

  static async listRecipients({ role } = {}) {
    const DappEngine = getDappEngine();
    if (!DappEngine) throw new Error('DappEngine not available');
    const users = await DappEngine.listUsers();
    return users
      .filter(u => {
        if (!role || role === 'all') return true;
        const roles = Array.isArray(u.roles) ? u.roles : (u.roles ? JSON.parse(u.roles) : [u.role]);
        return roles.includes(role) || u.role === role;
      })
      .map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, roles: u.roles, walletAddress: u.wallet_address }));
  }

  static isBtcAddress(v) {
    if (typeof v !== 'string' || !v.trim()) return false;
    let addr = v.trim();
    if (addr.toLowerCase().startsWith('bitcoin:')) {
      try {
        const u = new URL(addr);
        addr = u.pathname || u.hostname;
      } catch { return false; }
    }
    return /^[13][a-zA-Z0-9]{25,34}$/.test(addr) || /^(bc1|BC1)[a-zA-Z0-9]{11,71}$/.test(addr);
  }

  static async resolveRecipient({ recipientType, identifier, asset = '' } = {}) {
    const upper = String(asset).toUpperCase();
    if (isAddress(identifier)) return { address: viem.getAddress ? viem.getAddress(identifier) : identifier.toLowerCase(), type: 'address' };
    if (upper === 'BTC' && this.isBtcAddress(identifier)) {
      let addr = identifier.trim();
      if (addr.toLowerCase().startsWith('bitcoin:')) {
        const u = new URL(addr);
        addr = u.pathname || u.hostname;
      }
      return { address: addr, type: 'btc_address' };
    }
    const DappEngine = getDappEngine();
    if (!DappEngine) throw new Error('Wallet address required or DappEngine not available');
    const user = await DappEngine.getUserByEmail(identifier).catch(() => null);
    if (!user) throw new Error(`Recipient not found for ${identifier}`);
    if (!user.wallet_address) throw new Error(`Recipient ${identifier} has no linked wallet`);
    return { address: user.wallet_address, type: 'user', user };
  }

  static async createPayment({ paymentType = 'payout', sourceType, sourceAccountId, recipientType, recipientIdentifier, amount, asset = 'SIT', description, rail, railOptions = {} } = {}) {
    await this.ensureTables();
    if (!sourceType || !sourceAccountId) throw new Error('sourceType and sourceAccountId required');
    if (!recipientIdentifier) throw new Error('recipientIdentifier required');
    if (!amount || Number(amount) <= 0) throw new Error('amount must be positive');

    const chosenRail = (rail || 'sit').toLowerCase();
    const recipient = (chosenRail.startsWith('stripe_') || FIAT_EXTERNAL_RAILS.has(chosenRail))
      ? { address: recipientIdentifier, type: 'external' }
      : await this.resolveRecipient({ recipientType, identifier: recipientIdentifier, asset });
    const recordId = id('PC');
    const base = {
      id: recordId,
      payment_type: paymentType,
      source_type: sourceType,
      source_account_id: sourceAccountId,
      recipient_type: recipientType || 'external',
      recipient_email: recipient.user ? recipient.user.email : null,
      recipient_address: recipient.address,
      amount_usd: String(amount),
      asset: asset.toUpperCase(),
      rail: rail || 'sit',
      description: description || `${paymentType} to ${recipient.address}`,
      status: 'pending',
      tx_hash: null,
      tx_data: {},
      metadata: { railOptions },
    };

    await withFallback(async () => {
      const keys = Object.keys(base).filter(k => base[k] !== undefined);
      const cols = keys.join(',');
      const vals = keys.map((_, i) => `$${i + 1}`).join(',');
      await query(`INSERT INTO dapp_payout_center (${cols}) VALUES (${vals})`, keys.map(k => (k === 'tx_data' || k === 'metadata') ? safeJson(base[k]) : base[k]));
    }, () => {});

    // KYC/AML/Sanctions screening before moving real value
    if (ComplianceEngine && process.env.COMPLIANCE_SCREEN_PAYOUTS !== 'false') {
      const screening = await ComplianceEngine.screenRecipientForPayout({
        fullName: railOptions.fullName || railOptions.recipientName,
        businessName: railOptions.businessName || railOptions.recipientBusinessName,
        email: recipient.user ? recipient.user.email : recipientIdentifier,
        bankAccount: railOptions.accountNumber || railOptions.bankAccount,
        routingNumber: railOptions.routingNumber || railOptions.routing,
        country: railOptions.country || 'US',
        address: railOptions.address,
        dateOfBirth: railOptions.dateOfBirth,
      }, amount, sourceAccountId);
      ComplianceEngine.mustPass(screening);
      base.metadata = { ...base.metadata, complianceScreeningId: screening.screening_id };
      await withFallback(async () => {
        await query(`UPDATE dapp_payout_center SET metadata = $1 WHERE id = $2`, [safeJson(base.metadata), base.id]);
      }, () => {});
    }

    let result = null;
    // Reuse the latest valid DEX pool for this asset to avoid paying creation gas each time.
    if (chosenRail === 'dex' && !railOptions.poolAddress) {
      const latest = await this.getLatestPoolAddress(asset);
      if (latest) railOptions.poolAddress = latest;
    }

    switch (chosenRail) {
      case 'sit':
      case 'sovereign': {
        if (!SovereignTrustEngine) throw new Error('SovereignTrustEngine not available');
        result = await SovereignTrustEngine.mintFromSource({
          sourceType,
          sourceAccountId,
          to: recipient.address,
          amount,
          memo: description,
        });
        base.tx_hash = result.tx;
        base.status = result.tx ? 'completed' : 'pending';
        break;
      }
      case 'dex':
      case 'stablecoin_dex': {
        if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
        const seed = railOptions.createPoolIfMissing ? { createPoolIfMissing: true, poolSeedUsdc: railOptions.poolSeedUsdc || 0.005, poolSeedDlbusd: railOptions.poolSeedDlbusd || 10 } : {};
        result = await StablecoinDexEngine.depositAndSwap({
          sourceType,
          sourceAccountId,
          amount,
          targetAsset: asset.toUpperCase(),
          recipient: recipient.address,
          poolAddress: railOptions.poolAddress,
          ...seed,
        });
        base.tx_hash = result.swap && result.swap.txHash;
        base.status = (result.swap && result.swap.mode === 'live' && result.swap.txHash) ? 'completed' : 'pending';
        break;
      }
      case 'cashapp':
      case 'cash': {
        if (!CashAppEngine) throw new Error('CashAppEngine not available');
        result = await CashAppEngine.requestPayment({
          amountUsd: amount,
          recipientTag: railOptions.cashtag,
          walletAddress: recipient.address,
          memo: description,
          direction: railOptions.direction || 'pull',
        });
        base.tx_hash = result && result.paymentId;
        base.status = 'awaiting_sender';
        break;
      }
      case 'fund_rail':
      case 'module': {
        if (!ModuleFundingEngine) throw new Error('ModuleFundingEngine not available');
        result = await ModuleFundingEngine.fundExternalRail({
          sourceType,
          sourceAccountId,
          rail: railOptions.rail || 'stablecoin_dex',
          amount,
          memo: description,
          railOptions: { targetAsset: asset, recipient: recipient.address, ...railOptions },
        });
        base.tx_hash = result && (result.fundingId || result.txHash);
        base.status = 'completed';
        break;
      }
      case 'btcpay': {
        if (!BtcPayEngine || !BtcPayEngine.isConfigured()) throw new Error('BTCPay engine not configured');
        result = await BtcPayEngine.payoutBtc({
          destination: recipient.address,
          amountUsd: amount,
          description,
          memo: description,
          autoApprove: true,
        });
        base.tx_hash = result.payoutId;
        base.status = 'awaiting_payment';
        break;
      }
      case 'lili':
      case 'lili_bank': {
        if (!LiliBankEngine) throw new Error('LiliBankEngine not available');
        result = await LiliBankEngine.createPayment({
          amount,
          currency: asset.toUpperCase() === 'USD' ? 'USD' : 'USD',
          recipientName: railOptions.fullName || railOptions.recipientName || railOptions.businessName || railOptions.recipientBusinessName,
          recipientAccount: railOptions.accountNumber || railOptions.account,
          recipientRouting: railOptions.routingNumber || railOptions.routing,
          recipientBank: railOptions.bankName,
          recipientEmail: railOptions.email,
          sourceAccountId,
          liliAccountId: railOptions.liliAccountId,
          liliBusinessUserId: railOptions.liliBusinessUserId,
          speed: railOptions.speed || 'standard',
          initiatedBy: railOptions.initiatedBy,
        });
        base.tx_hash = result.payment_id;
        base.status = result.status === 'completed' ? 'completed' : (result.status === 'api_pending' ? 'api_pending' : 'manual_pending');
        break;
      }
      case 'stripe_treasury':
      case 'stripe_ach':
      case 'stripe_wire': {
        if (!StripeTreasuryEngine || !StripeTreasuryEngine.isConfigured()) throw new Error('StripeTreasuryEngine not configured');
        const network = chosenRail === 'stripe_wire' ? 'us_domestic_wire' : 'ach';
        result = await StripeTreasuryEngine.createPayment({
          amount,
          financialAccountId: railOptions.financialAccountId || process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID,
          routingNumber: railOptions.routingNumber || railOptions.routing,
          accountNumber: railOptions.accountNumber || railOptions.account,
          accountHolderName: railOptions.recipientName || railOptions.beneficiaryName || railOptions.fullName,
          accountHolderType: railOptions.accountHolderType || railOptions.holderType || 'individual',
          accountType: railOptions.accountType || 'checking',
          network,
          description: description || `PTC payout ${base.id}`,
          statementDescriptor: railOptions.statementDescriptor || 'PTC PAYOUT',
          billingAddress: railOptions.billingAddress || railOptions.address,
          metadata: { ptc_request_id: railOptions.ptc_request_id, initiatedBy: railOptions.initiatedBy, rail },
        });
        base.tx_hash = result.stripe_outbound_payment_id || result.payout_id;
        base.status = result.status === 'completed' ? 'completed' : (result.status === 'failed' ? 'failed' : 'pending');
        break;
      }
      case 'ach': {
        if (!ACHEngine) throw new Error('ACHEngine not available');
        const cents = Math.round(Number(amount) * 100);
        const holderName = railOptions.recipientName || railOptions.fullName || railOptions.businessName;
        const batch = await ACHEngine.createBatch({
          effectiveDate: railOptions.effectiveDate,
          secCode: railOptions.secCode || (railOptions.holderType === 'business' ? 'CCD' : 'PPD'),
          description: (railOptions.entryDescription || paymentType || 'PAYMENT').slice(0, 10).toUpperCase(),
          createdBy: railOptions.initiatedBy || 'payout-center',
          partnerId: railOptions.partnerId,
        }, [{
          receivingRouting: railOptions.routingNumber || railOptions.routing,
          accountNumber: railOptions.accountNumber || railOptions.account,
          amountCents: cents,
          // 22 credits a checking account, 32 a savings account.
          transactionCode: railOptions.accountType === 'savings' ? '32' : '22',
          individualId: railOptions.ptc_request_id || base.id,
          individualName: holderName,
          memo: description,
        }]);
        result = batch;
        base.tx_hash = batch.batch_id;
        // The NACHA file exists but no money moves until the batch is
        // transmitted to the ODFI under its own approval.
        base.status = 'awaiting_transmission';
        break;
      }
      case 'bill_pay':
      case 'melio': {
        if (!getMelioClient) throw new Error('Melio client not available');
        const melio = getMelioClient();
        let vendorId = railOptions.billerId;
        if (!vendorId) {
          const vendor = await melio.createVendor({
            name: railOptions.billerName || railOptions.businessName,
            email: railOptions.email,
            account_number: railOptions.accountReference,
            address: railOptions.address,
          });
          vendorId = vendor.id;
        }
        const bill = await melio.createBill({
          vendor_id: vendorId,
          amount: String(amount),
          currency: 'USD',
          invoice_number: railOptions.invoiceNumber || base.id,
          due_date: railOptions.dueDate,
          note: description,
        });
        const payment = await melio.schedulePayment({
          bill_id: bill.id,
          vendor_id: vendorId,
          amount: String(amount),
          delivery_method: railOptions.deliveryMethod || 'ach',
          scheduled_date: railOptions.dueDate,
          note: description,
        });
        result = { shadow: melio.shadow, vendor_id: vendorId, bill, payment };
        base.tx_hash = payment.id;
        base.status = melio.shadow ? 'manual_pending' : (payment.status === 'completed' ? 'completed' : 'api_pending');
        break;
      }
      default:
        throw new Error(`Unsupported rail: ${rail}`);
    }

    base.tx_data = result || {};
    if (chosenRail.startsWith('stripe_') || FIAT_EXTERNAL_RAILS.has(chosenRail)) {
      const acct = railOptions.accountNumber || railOptions.account || railOptions.accountReference || '';
      base.recipient_address = acct ? `****${String(acct).slice(-4)}` : String(recipientIdentifier);
      base.metadata = { ...base.metadata, railOptions: maskRailOptions(railOptions) };
    }
    base.updated_at = new Date().toISOString();
    await withFallback(async () => {
      await query(`UPDATE dapp_payout_center SET status = $1, tx_hash = $2, tx_data = $3, updated_at = NOW() WHERE id = $4`,
        [base.status, base.tx_hash, safeJson(base.tx_data), base.id]);
    }, () => {});

    return { ...base, result };
  }

  static async getLatestPoolAddress(asset) {
    await this.ensureTables();
    return withFallback(async () => {
      const rows = await query(
        `SELECT tx_data->>'poolAddress' AS pool FROM dapp_payout_center
         WHERE rail = 'dex' AND asset = $1 AND tx_data->>'poolAddress' IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [asset.toUpperCase()]
      );
      return rows.rows[0] ? rows.rows[0].pool : null;
    }, () => null);
  }

  static async listPayments({ limit = 50 } = {}) {
    await this.ensureTables();
    return withFallback(async () => {
      const rows = await query('SELECT * FROM dapp_payout_center ORDER BY created_at DESC LIMIT $1', [limit]);
      return rows.rows;
    }, () => []);
  }
}

module.exports = { PayoutCenterEngine };

'use strict';

/**
 * Stripe Treasury Engine
 *
 * Issues real fiat payouts from a Stripe Treasury financial account using
 * OutboundPayments (ACH / US domestic wire) to external US bank accounts.
 */

let stripe;
try { stripe = require('stripe'); } catch (e) { stripe = null; }

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

function getSecret() {
  return process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TREASURY_SECRET_KEY || null;
}

function getFinancialAccountId() {
  return process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID || null;
}

function id(prefix = 'STR') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function toCents(dollars) { return Math.round(Number(dollars) * 100); }

async function query(text, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(text, params);
}

class StripeTreasuryEngine {
  static isConfigured() {
    return Boolean(getSecret() && getFinancialAccountId());
  }

  static getClient() {
    const secret = getSecret();
    if (!secret) throw new Error('Stripe secret key not configured');
    if (!stripe) throw new Error('stripe npm package not installed');
    return stripe(secret, { apiVersion: '2024-06-20', maxNetworkRetries: 2 });
  }

  static async ensureTables() {
    if (!pool || !pool.query) return;
    await query(`
      CREATE TABLE IF NOT EXISTS stripe_treasury_payouts (
        payout_id TEXT PRIMARY KEY,
        stripe_outbound_payment_id TEXT,
        financial_account_id TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'pending',
        stripe_status TEXT,
        rail TEXT,
        destination_last4 TEXT,
        destination_routing TEXT,
        destination_name TEXT,
        description TEXT,
        stripe_response JSONB,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  /**
   * @param {Object} opts
   * @param {number|string} opts.amount           amount in dollars
   * @param {string} opts.financialAccountId      source Treasury financial account (defaults to env)
   * @param {string} opts.routingNumber           destination bank routing number
   * @param {string} opts.accountNumber           destination bank account number
   * @param {string} opts.accountHolderName       destination account holder name
   * @param {'individual'|'company'} opts.accountHolderType
   * @param {'checking'|'savings'} opts.accountType
   * @param {string} [opts.network]               'ach' or 'us_domestic_wire' (if supported)
   * @param {string} [opts.description]
   * @param {string} [opts.statementDescriptor]
   * @param {Object} [opts.billingAddress]
   * @param {Object} [opts.metadata]
   */
  static async createPayment(opts = {}) {
    await this.ensureTables();
    const client = this.getClient();

    const financialAccountId = opts.financialAccountId || getFinancialAccountId();
    if (!financialAccountId) throw new Error('Stripe Treasury financial account ID not configured');

    const amountCents = toCents(opts.amount);
    if (!amountCents || amountCents <= 0) throw new Error('amount must be positive');
    if (!opts.routingNumber || !opts.accountNumber) throw new Error('routingNumber and accountNumber required');

    const accountType = opts.accountType === 'savings' ? 'savings' : 'checking';
    const accountHolderType = opts.accountHolderType === 'company' ? 'company' : 'individual';
    const network = opts.network || 'ach';
    const description = opts.description || `PTC payout ${id('PAYOUT')}`;
    const statementDescriptor = (opts.statementDescriptor || 'PTC PAYOUT').substring(0, 22);

    const usBankAccount = {
      account_holder_type: accountHolderType,
      account_holder_name: opts.accountHolderName || opts.accountHolder || opts.beneficiaryName,
      account_type: accountType,
      routing_number: String(opts.routingNumber).trim(),
      account_number: String(opts.accountNumber).trim(),
    };
    if (network === 'us_domestic_wire') {
      usBankAccount.networks = ['us_domestic_wire'];
    }

    const destinationPaymentMethodData = {
      type: 'us_bank_account',
      us_bank_account: usBankAccount,
      billing_details: {
        name: opts.accountHolderName || opts.accountHolder || opts.beneficiaryName || 'Beneficiary',
      },
    };
    if (opts.billingAddress) {
      destinationPaymentMethodData.billing_details.address = opts.billingAddress;
    }

    const payoutRecordId = id('STR-PAYOUT');
    const request = {
      financial_account: financialAccountId,
      amount: amountCents,
      currency: 'usd',
      description,
      statement_descriptor: statementDescriptor,
      destination_payment_method_data: destinationPaymentMethodData,
      metadata: opts.metadata || { ptc: true },
    };

    let response;
    let status = 'pending';
    try {
      response = await client.treasury.outboundPayments.create(request);
      status = response.status === 'posted' ? 'completed' : (response.status === 'canceled' ? 'canceled' : (response.status === 'failed' ? 'failed' : 'pending'));
    } catch (err) {
      response = { error: { message: err.message, code: err.code, type: err.type, decline_code: err.decline_code } };
      status = 'failed';
    }

    const stripeStatus = response && response.status ? response.status : null;
    const saved = {
      payout_id: payoutRecordId,
      stripe_outbound_payment_id: response && response.id ? response.id : null,
      financial_account_id: financialAccountId,
      amount_cents: amountCents,
      currency: 'usd',
      status,
      stripe_status: stripeStatus,
      rail: network,
      destination_last4: opts.accountNumber ? String(opts.accountNumber).slice(-4) : null,
      destination_routing: String(opts.routingNumber).trim(),
      destination_name: opts.accountHolderName || opts.accountHolder || opts.beneficiaryName || null,
      description,
      stripe_response: response,
      metadata: opts.metadata || {},
    };

    if (pool && pool.query) {
      try {
        await query(`
          INSERT INTO stripe_treasury_payouts (payout_id, stripe_outbound_payment_id, financial_account_id, amount_cents, currency, status, stripe_status, rail, destination_last4, destination_routing, destination_name, description, stripe_response, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)
        `, [saved.payout_id, saved.stripe_outbound_payment_id, saved.financial_account_id, saved.amount_cents, saved.currency, saved.status, saved.stripe_status, saved.rail, saved.destination_last4, saved.destination_routing, saved.destination_name, saved.description, safeJson(saved.stripe_response), safeJson(saved.metadata)]);
      } catch (dbErr) {
        console.warn('[StripeTreasuryEngine] DB save failed:', dbErr.message);
      }
    }

    return {
      payout_id: payoutRecordId,
      stripe_outbound_payment_id: saved.stripe_outbound_payment_id,
      status,
      stripe_status: stripeStatus,
      amount_cents: amountCents,
      financial_account: financialAccountId,
      response,
    };
  }

  static async listPayouts({ limit = 50 } = {}) {
    await this.ensureTables();
    if (!pool || !pool.query) return [];
    const rows = await query('SELECT * FROM stripe_treasury_payouts ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows.rows;
  }

  static async getStatus(payoutId) {
    await this.ensureTables();
    const row = (await query('SELECT * FROM stripe_treasury_payouts WHERE payout_id = $1', [payoutId])).rows[0];
    if (!row) throw new Error('Payout not found');
    if (!row.stripe_outbound_payment_id) return row;
    const client = this.getClient();
    const response = await client.treasury.outboundPayments.retrieve(row.stripe_outbound_payment_id);
    const status = response.status === 'posted' ? 'completed' : response.status;
    await query('UPDATE stripe_treasury_payouts SET status=$1, stripe_status=$2, stripe_response=$3::jsonb, updated_at=NOW() WHERE payout_id=$4', [status, response.status, safeJson(response), payoutId]);
    return { ...row, status, stripe_status: response.status, response };
  }
}

module.exports = { StripeTreasuryEngine };

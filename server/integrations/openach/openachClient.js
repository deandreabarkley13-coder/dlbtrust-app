/**
 * OpenACH REST API Client
 * Integrates with self-hosted OpenACH instance at ach.dlbtrust.cloud
 * 
 * DEANDREA LAVAR BARKLEY TRUST — Real Money Movement via ACH
 * ODFI: Eaton Family Credit Union (routing: 241075470)
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const OPENACH_BASE_URL = process.env.OPENACH_BASE_URL || 'https://ach.dlbtrust.cloud/openach/api';
const OPENACH_API_TOKEN = process.env.OPENACH_API_TOKEN;
const OPENACH_API_KEY   = process.env.OPENACH_API_KEY;

/**
 * Low-level HTTP POST to OpenACH REST API
 * OpenACH uses POST for all API calls (GET params are logged by web servers)
 */
function openachRequest(endpoint, params = {}, sessionCookie = null) {
  return new Promise((resolve, reject) => {
    const urlStr = `${OPENACH_BASE_URL}/${endpoint}`;
    const parsed = new URL(urlStr);

    const body = new URLSearchParams(params).toString();
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Accept': 'application/json',
    };

    if (sessionCookie) {
      headers['Cookie'] = sessionCookie;
    }

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers,
      // Allow self-signed certs on local server
      rejectUnauthorized: false,
    };

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // Capture session cookie from Set-Cookie header
          const setCookie = res.headers['set-cookie'];
          if (setCookie) {
            const phpsessid = setCookie.find(c => c.startsWith('PHPSESSID'));
            if (phpsessid) json._sessionCookie = phpsessid.split(';')[0];
          }
          resolve(json);
        } catch (e) {
          reject(new Error(`OpenACH parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * OpenACH Session Manager
 * Handles connect/disconnect and caches session per token
 */
class OpenACHSession {
  constructor(apiToken = OPENACH_API_TOKEN, apiKey = OPENACH_API_KEY) {
    if (!apiToken || !apiKey) {
      throw new Error('OPENACH_API_TOKEN and OPENACH_API_KEY must be set in environment');
    }
    this.apiToken = apiToken;
    this.apiKey = apiKey;
    this.sessionCookie = null;
    this.sessionId = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return this;

    const res = await openachRequest('connect', {
      user_api_token: this.apiToken,
      user_api_key: this.apiKey,
    });

    if (!res.success) {
      throw new Error(`OpenACH connect failed: ${res.error}`);
    }

    this.sessionId = res.session_id;
    this.sessionCookie = res._sessionCookie || `PHPSESSID=${res.session_id}`;
    this.connected = true;
    return this;
  }

  async disconnect() {
    if (!this.connected) return;
    await openachRequest('disconnect', {}, this.sessionCookie);
    this.connected = false;
    this.sessionCookie = null;
    this.sessionId = null;
  }

  async request(endpoint, params = {}) {
    if (!this.connected) await this.connect();
    return openachRequest(endpoint, params, this.sessionCookie);
  }
}

/**
 * OpenACH API — High-level business operations
 */
class OpenACHClient {

  /**
   * Get all configured payment types for this origination account
   * Returns e.g. "Trust Dist" (credit) type IDs needed for scheduling payments
   */
  static async getPaymentTypes() {
    const session = new OpenACHSession();
    await session.connect();
    try {
      const res = await session.request('getPaymentTypes');
      if (!res.success) throw new Error(`getPaymentTypes failed: ${res.error}`);
      return res.payment_types || res.data || res;
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Create a Payment Profile for a beneficiary
   * @param {Object} profile
   * @param {string} profile.first_name
   * @param {string} profile.last_name
   * @param {string} profile.email
   * @param {string} profile.external_id  - your internal beneficiary ID
   */
  static async createPaymentProfile({ first_name, last_name, email, external_id }) {
    const session = new OpenACHSession();
    await session.connect();
    try {
      const res = await session.request('savePaymentProfile', {
        payment_profile_first_name: first_name,
        payment_profile_last_name: last_name,
        payment_profile_email_address: email,
        payment_profile_external_id: external_id || '',
      });
      if (!res.success) throw new Error(`createPaymentProfile failed: ${res.error}`);
      return res;
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Get payment profile by your external (internal) ID
   * @param {string} externalId  - your beneficiary/user ID
   */
  static async getPaymentProfileByExternalId(externalId) {
    const session = new OpenACHSession();
    await session.connect();
    try {
      const res = await session.request('getPaymentProfileByExtId', {
        payment_profile_external_id: externalId,
      });
      if (!res.success) throw new Error(`getPaymentProfileByExtId failed: ${res.error}`);
      return res;
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Add a bank account (external account) to a payment profile
   * @param {Object} account
   * @param {string} account.payment_profile_id  - from createPaymentProfile
   * @param {string} account.bank_name           - e.g. "Chase Bank"
   * @param {string} account.routing_number      - 9-digit ABA routing
   * @param {string} account.account_number      - bank account number
   * @param {string} account.account_holder      - full name on account
   * @param {string} account.account_type        - "Checking" or "Savings"
   * @param {string} account.billing_address
   * @param {string} account.billing_city
   * @param {string} account.billing_state
   * @param {string} account.billing_zip
   */
  static async addExternalAccount({
    payment_profile_id,
    bank_name,
    routing_number,
    account_number,
    account_holder,
    account_type = 'Checking',
    billing_address = '',
    billing_city = '',
    billing_state = 'OH',
    billing_zip = '',
  }) {
    const session = new OpenACHSession();
    await session.connect();
    try {
      const res = await session.request('saveExternalAccount', {
        external_account_payment_profile_id: payment_profile_id,
        external_account_name: `${account_holder} - ${bank_name}`,
        external_account_bank: bank_name,
        external_account_holder: account_holder,
        external_account_type: account_type,
        external_account_country_code: 'US',
        external_account_dfi_id: routing_number,
        external_account_number: account_number,
        external_account_billing_address: billing_address,
        external_account_billing_city: billing_city,
        external_account_billing_state_province: billing_state,
        external_account_billing_postal_code: billing_zip,
        external_account_billing_country: 'US',
        external_account_business: '0',
      });
      if (!res.success) throw new Error(`addExternalAccount failed: ${res.error}`);
      return res;
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Schedule a one-time ACH credit disbursement (real money movement)
   * This sends funds FROM the trust TO the beneficiary's bank account
   * @param {Object} schedule
   * @param {string} schedule.external_account_id  - from addExternalAccount
   * @param {string} schedule.payment_type_id      - from getPaymentTypes (Trust Dist)
   * @param {number} schedule.amount               - dollars, e.g. 500.00
   * @param {string} schedule.send_date            - YYYY-MM-DD, must be future business day
   * @param {string} schedule.currency_code        - default "USD"
   * @param {number} schedule.occurrences          - 1 for one-time, 0 for indefinite
   * @param {string} schedule.frequency            - "once", "weekly", "monthly", etc.
   */
  static async schedulePayment({
    external_account_id,
    payment_type_id,
    amount,
    send_date,
    currency_code = 'USD',
    occurrences = 1,
    frequency = 'once',
  }) {
    const session = new OpenACHSession();
    await session.connect();
    try {
      const params = {
        payment_schedule_external_account_id: external_account_id,
        payment_schedule_payment_type_id: payment_type_id,
        payment_schedule_amount: parseFloat(amount).toFixed(2),
        payment_schedule_currency_code: currency_code,
        payment_schedule_next_date: send_date,
        payment_schedule_frequency: frequency,
        payment_schedule_remaining_occurrences: occurrences,
      };

      const res = await session.request('savePaymentSchedule', params);
      if (!res.success) throw new Error(`schedulePayment failed: ${res.error}`);
      return res;
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Get all payment schedules for a payment profile
   * @param {string} payment_profile_id
   */
  static async getPaymentSchedules(payment_profile_id) {
    const session = new OpenACHSession();
    await session.connect();
    try {
      const res = await session.request('getPaymentSchedules', { payment_profile_id });
      if (!res.success) throw new Error(`getPaymentSchedules failed: ${res.error}`);
      return res;
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Get all external accounts (bank accounts) for a payment profile
   * @param {string} payment_profile_id
   */
  static async getExternalAccounts(payment_profile_id) {
    const session = new OpenACHSession();
    await session.connect();
    try {
      const res = await session.request('getExternalAccounts', { payment_profile_id });
      if (!res.success) throw new Error(`getExternalAccounts failed: ${res.error}`);
      return res;
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Full disbursement workflow — creates profile + bank account + schedules payment
   * Use this to onboard a new beneficiary and send their first disbursement in one call
   */
  static async disburseToBeneficiary({
    // Beneficiary info
    first_name,
    last_name,
    email,
    external_id,
    // Bank info
    bank_name,
    routing_number,
    account_number,
    account_type = 'Checking',
    billing_address = '',
    billing_city = '',
    billing_state = 'OH',
    billing_zip = '',
    // Payment
    amount,
    send_date,
    payment_type_id,       // "Trust Dist" type ID — get from getPaymentTypes()
    frequency = 'once',
    occurrences = 1,
  }) {
    const session = new OpenACHSession();
    await session.connect();

    try {
      // Step 1: Create or find existing payment profile
      let profileId;
      if (external_id) {
        try {
          const existing = await session.request('getPaymentProfileByExtId', {
            payment_profile_external_id: external_id,
          });
          if (existing.success && existing.payment_profile_id) {
            profileId = existing.payment_profile_id;
          }
        } catch (_) { /* not found, will create */ }
      }

      if (!profileId) {
        const profileRes = await session.request('savePaymentProfile', {
          payment_profile_first_name: first_name,
          payment_profile_last_name: last_name,
          payment_profile_email_address: email,
          payment_profile_external_id: external_id || '',
        });
        if (!profileRes.success) throw new Error(`Profile creation failed: ${profileRes.error}`);
        profileId = profileRes.payment_profile_id;
      }

      // Step 2: Add bank account
      const accountRes = await session.request('saveExternalAccount', {
        external_account_payment_profile_id: profileId,
        external_account_name: `${first_name} ${last_name} - ${bank_name}`,
        external_account_bank: bank_name,
        external_account_holder: `${first_name} ${last_name}`,
        external_account_type: account_type,
        external_account_country_code: 'US',
        external_account_dfi_id: routing_number,
        external_account_number: account_number,
        external_account_billing_address: billing_address,
        external_account_billing_city: billing_city,
        external_account_billing_state_province: billing_state,
        external_account_billing_postal_code: billing_zip,
        external_account_billing_country: 'US',
        external_account_business: '0',
      });
      if (!accountRes.success) throw new Error(`Bank account creation failed: ${accountRes.error}`);
      const externalAccountId = accountRes.external_account_id;

      // Step 3: Schedule payment
      const scheduleRes = await session.request('savePaymentSchedule', {
        payment_schedule_external_account_id: externalAccountId,
        payment_schedule_payment_type_id: payment_type_id,
        payment_schedule_amount: parseFloat(amount).toFixed(2),
        payment_schedule_currency_code: 'USD',
        payment_schedule_next_date: send_date,
        payment_schedule_frequency: frequency,
        payment_schedule_remaining_occurrences: occurrences,
      });
      if (!scheduleRes.success) throw new Error(`Payment scheduling failed: ${scheduleRes.error}`);

      return {
        success: true,
        payment_profile_id: profileId,
        external_account_id: externalAccountId,
        payment_schedule_id: scheduleRes.payment_schedule_id,
        amount,
        send_date,
        message: `ACH credit of $${amount} scheduled for ${send_date} to ${first_name} ${last_name} at ${bank_name}`,
      };

    } finally {
      await session.disconnect();
    }
  }
}

module.exports = { OpenACHClient, OpenACHSession, openachRequest };

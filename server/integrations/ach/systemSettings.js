'use strict';

/**
 * System Settings — Production/Sandbox Mode & Bank Configuration
 *
 * Manages the system operating mode and external bank endpoint configuration.
 * In PRODUCTION mode, all ACH and wire transmissions route to the configured
 * external bank endpoint over HTTPS via the Open Bank REST API.
 * In SANDBOX mode, transmissions are processed internally (self-transmit).
 *
 * Settings are persisted in PostgreSQL (system_settings table).
 */

const pool = require('../bonds/pgPool');

// Default settings
const DEFAULTS = {
  system_mode: 'production',
  bank_name: 'Open Bank REST API',
  bank_endpoint: '',
  bank_auth_type: 'none',
  bank_api_key: '',
  bank_api_secret: '',
  bank_routing_number: '',
  wire_endpoint: '',
  wire_auth_type: 'none',
  wire_api_key: '',
  settlement_webhook_url: '',
  auto_settle: 'true',
};

// Pre-configured bank templates (common ODFI endpoints)
const BANK_REGISTRY = [
  {
    id: 'open-bank-direct',
    name: 'Open Bank REST API (Direct HTTPS)',
    description: 'Transmit NACHA files directly to any bank that accepts REST API file submissions over HTTPS. No proprietary credentials required — uses open banking standard.',
    endpoint_template: 'https://{bank_host}/api/ach/receive',
    wire_endpoint_template: 'https://{bank_host}/api/wire/originate',
    auth_type: 'none',
    supports_ach: true,
    supports_wire: true,
    settlement_mode: 'webhook',
  },
  {
    id: 'fedach-direct',
    name: 'FedACH Direct (Federal Reserve)',
    description: 'Direct submission to the Federal Reserve ACH network. Requires Fed participant status.',
    endpoint_template: 'https://frbservices.org/ach/submit',
    wire_endpoint_template: 'https://frbservices.org/fedwire/send',
    auth_type: 'bearer',
    supports_ach: true,
    supports_wire: true,
    settlement_mode: 'confirmation',
  },
  {
    id: 'eaton-fcu',
    name: 'Eaton Family Credit Union',
    description: 'ODFI partner for trust distributions and disbursements.',
    endpoint_template: 'https://api.eatonfcu.org/ach/files',
    wire_endpoint_template: 'https://api.eatonfcu.org/wire/originate',
    auth_type: 'bearer',
    supports_ach: true,
    supports_wire: true,
    settlement_mode: 'webhook',
  },
  {
    id: 'column-bank',
    name: 'Column (Banking-as-a-Service)',
    description: 'Modern treasury API with direct Fed access for ACH and Wire.',
    endpoint_template: 'https://api.column.com/ach-transfers',
    wire_endpoint_template: 'https://api.column.com/wire-transfers',
    auth_type: 'bearer',
    supports_ach: true,
    supports_wire: true,
    settlement_mode: 'webhook',
  },
  {
    id: 'increase-bank',
    name: 'Increase (Direct Fed Access)',
    description: 'Purpose-built for treasury/trust operations with real-time ACH and Fedwire.',
    endpoint_template: 'https://api.increase.com/ach_transfers',
    wire_endpoint_template: 'https://api.increase.com/wire_transfers',
    auth_type: 'bearer',
    supports_ach: true,
    supports_wire: true,
    settlement_mode: 'webhook',
  },
  {
    id: 'bill-cash',
    name: 'BILL Cash Account (Betterment)',
    description: 'Route payments through BILL\'s RecordARPayment API. Deposits are recorded in your BILL dashboard and settle to your linked Betterment account (****3054). No NACHA file needed — BILL handles the ACH origination.',
    endpoint_template: 'https://api.bill.com/api/v2',
    wire_endpoint_template: 'https://api.bill.com/api/v2',
    auth_type: 'bill_api',
    supports_ach: true,
    supports_wire: true,
    settlement_mode: 'bill_api',
  },
  {
    id: 'custom',
    name: 'Custom Bank Endpoint',
    description: 'Configure any bank REST API endpoint that accepts NACHA file submissions.',
    endpoint_template: '',
    wire_endpoint_template: '',
    auth_type: 'none',
    supports_ach: true,
    supports_wire: true,
    settlement_mode: 'webhook',
  },
];

class SystemSettings {
  /**
   * Ensure system_settings table exists.
   */
  static async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMP DEFAULT NOW(),
        updated_by VARCHAR(100) DEFAULT 'system'
      )
    `);

    // Seed defaults if empty
    const existing = await pool.query('SELECT key FROM system_settings');
    const existingKeys = new Set(existing.rows.map(r => r.key));

    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (!existingKeys.has(key)) {
        await pool.query(
          'INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
          [key, value]
        );
      }
    }
  }

  /**
   * Get a single setting value.
   */
  static async get(key) {
    const result = await pool.query('SELECT value FROM system_settings WHERE key = $1', [key]);
    return result.rows.length ? result.rows[0].value : (DEFAULTS[key] || null);
  }

  /**
   * Set a single setting value.
   */
  static async set(key, value, updatedBy = 'admin') {
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
      [key, String(value), updatedBy]
    );
  }

  /**
   * Get all settings as a flat object.
   */
  static async getAll() {
    const result = await pool.query('SELECT key, value, updated_at FROM system_settings');
    const settings = { ...DEFAULTS };
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  }

  /**
   * Bulk update multiple settings.
   */
  static async setMany(updates, updatedBy = 'admin') {
    for (const [key, value] of Object.entries(updates)) {
      await SystemSettings.set(key, value, updatedBy);
    }
  }

  /**
   * Get the current system mode: 'production' or 'sandbox'.
   */
  static async getMode() {
    return await SystemSettings.get('system_mode') || 'production';
  }

  /**
   * Switch system mode.
   */
  static async setMode(mode, updatedBy = 'admin') {
    if (!['production', 'sandbox'].includes(mode)) {
      throw new Error('Invalid mode. Must be "production" or "sandbox".');
    }
    await SystemSettings.set('system_mode', mode, updatedBy);
    return mode;
  }

  /**
   * Get the configured bank endpoint for ACH transmission.
   * In production mode: returns the external bank endpoint.
   * In sandbox mode: returns null (triggers self-transmit).
   */
  static async getBankEndpoint() {
    const mode = await SystemSettings.getMode();
    if (mode === 'sandbox') return null;

    const endpoint = await SystemSettings.get('bank_endpoint');
    return endpoint || null;
  }

  /**
   * Get the configured wire endpoint.
   */
  static async getWireEndpoint() {
    const mode = await SystemSettings.getMode();
    if (mode === 'sandbox') return null;

    const endpoint = await SystemSettings.get('wire_endpoint');
    return endpoint || null;
  }

  /**
   * Get bank auth configuration for external transmission.
   */
  static async getBankAuth() {
    return {
      authType: await SystemSettings.get('bank_auth_type') || 'none',
      apiKey: await SystemSettings.get('bank_api_key') || '',
      apiSecret: await SystemSettings.get('bank_api_secret') || '',
    };
  }

  /**
   * Build a partner config object for external bank transmission.
   * This is what gets passed to OpenBankApi.transmit() in production mode.
   * When the configured bank is BILL, sets protocol to 'bill_api' so the
   * transmission engine routes through billClient.recordDeposit() instead.
   */
  static async getProductionPartnerConfig() {
    const mode = await SystemSettings.getMode();
    if (mode === 'sandbox') return null;

    const endpoint = await SystemSettings.get('bank_endpoint');
    if (!endpoint) return null;

    const bankName = await SystemSettings.get('bank_name') || 'External Bank';
    const authType = await SystemSettings.get('bank_auth_type') || 'none';
    const apiKey = await SystemSettings.get('bank_api_key') || '';
    const apiSecret = await SystemSettings.get('bank_api_secret') || '';

    const isBill = authType === 'bill_api' || endpoint.indexOf('api.bill.com') !== -1;

    return {
      partnerId: isBill ? 'BILL-CASH' : 'PRODUCTION-BANK',
      partnerName: bankName,
      protocol: isBill ? 'bill_api' : 'rest_api',
      apiBaseUrl: endpoint,
      apiAuthType: isBill ? 'bill_api' : (authType === 'none' ? 'bearer' : authType),
      apiKey: apiKey,
      apiSecret: apiSecret,
      localAs2Id: 'DLBTRUST-AS2',
      isProduction: true,
      isBill: isBill,
    };
  }

  /**
   * Get the bank registry (pre-configured templates).
   */
  static getBankRegistry() {
    return BANK_REGISTRY;
  }

  /**
   * Apply a bank template to system settings.
   */
  static async applyBankTemplate(templateId, overrides = {}, updatedBy = 'admin') {
    const template = BANK_REGISTRY.find(t => t.id === templateId);
    if (!template) throw new Error(`Bank template not found: ${templateId}`);

    const updates = {
      bank_name: overrides.bank_name || template.name,
      bank_endpoint: overrides.bank_endpoint || template.endpoint_template,
      bank_auth_type: overrides.bank_auth_type || template.auth_type,
      wire_endpoint: overrides.wire_endpoint || template.wire_endpoint_template,
      wire_auth_type: overrides.wire_auth_type || template.auth_type,
    };

    if (overrides.bank_api_key) updates.bank_api_key = overrides.bank_api_key;
    if (overrides.bank_api_secret) updates.bank_api_secret = overrides.bank_api_secret;
    if (overrides.bank_routing_number) updates.bank_routing_number = overrides.bank_routing_number;

    await SystemSettings.setMany(updates, updatedBy);
    return { template: template.name, applied: updates };
  }

  /**
   * Test connectivity to the configured bank endpoint.
   * For BILL endpoints, uses billClient.getStatus() instead of HTTP ping.
   */
  static async testBankConnection() {
    const config = await SystemSettings.getProductionPartnerConfig();
    if (!config) {
      return { connected: false, error: 'No bank endpoint configured or system in sandbox mode' };
    }

    if (config.isBill) {
      try {
        const billClient = require('../bill/billClient');
        const status = await billClient.getStatus();
        return {
          connected: status.connected,
          status_code: status.connected ? 200 : 0,
          latency_ms: 0,
          bank: 'BILL Cash Account',
          organization: status.organization || '',
          user: status.user || '',
          accounts: status.accounts || 0,
          error: status.connected ? null : (status.error || 'BILL API not reachable'),
        };
      } catch (err) {
        return { connected: false, error: 'BILL API error: ' + err.message };
      }
    }

    const { OpenBankApi } = require('./openBankApi');
    return await OpenBankApi.testConnection(config);
  }
}

module.exports = { SystemSettings, BANK_REGISTRY };

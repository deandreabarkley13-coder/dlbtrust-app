'use strict';

/**
 * Treasury ODFI bank — the trust's own funded checking account (Betterment,
 * in the trust name) acting as the Originating Depository Financial
 * Institution for the NACHA files dlb-treasury builds on GCP.
 *
 * dlb-treasury (OpenACH / Payment Hub / ACHEngine) is the originator and does
 * the funding decision; Betterment accepts the files (MFT Gateway file drop,
 * SFTP or server-to-server) and executes them against the trust account.
 *
 * With ACH_ODFI_BANK=betterment this module projects the secret-backed
 * BETTERMENT_ROUTING_NUMBER / BETTERMENT_ACCOUNT_NUMBER onto every originator
 * variable the NACHA / connector / settlement engines read, so the ODFI
 * identity is configured once and never typed into Terraform or .env files.
 * It must be applied before those modules load (nachaGenerator reads its
 * ODFI at require time) — server-3002.js calls apply() first thing.
 */

// Required lazily: apply() must run before any NACHA module loads.
function fileRelay() {
  try { return require('../openach/openachFileRelay').OpenAchFileRelay || null; } catch (e) { return null; }
}

function digits(v) { return String(v || '').replace(/\D/g, ''); }
function last4(v) { const d = digits(v); return d ? d.slice(-4) : null; }
function set(env, name, value) {
  if (value == null || value === '') return false;
  env[name] = String(value);
  return true;
}

const ORIGINATOR_VARS = [
  'ACH_ODFI_ROUTING', 'ACH_ODFI_NAME', 'ACH_IMMEDIATE_ORIGIN', 'ACH_ORIGINATOR_NAME', 'ACH_COMPANY_NAME', 'ACH_COMPANY_ID',
  'NACHA_ODFI_ROUTING', 'NACHA_ORIGINATOR_NAME', 'NACHA_COMPANY_NAME', 'NACHA_IMMEDIATE_ORIGIN_NAME', 'NACHA_IMMEDIATE_DESTINATION_NAME',
  'CLEARING_FUNDING_OPERATING_ACCOUNT', 'LILI_ODFI_ROUTING', 'LILI_ODFI_ACCOUNT', 'LILI_ODFI_NAME',
  'TRUST_BANK_ROUTING', 'TRUST_BANK_ACCOUNT', 'TRUST_BANK_NAME', 'EDI_820_ODFI_ACCOUNT',
];

class TreasuryOdfiBank {
  static getConfig(env = process.env) {
    const bank = String(env.ACH_ODFI_BANK || '').trim().toLowerCase();
    const routing = digits(env.TREASURY_BANK_ROUTING_NUMBER || env.BETTERMENT_ROUTING_NUMBER);
    const account = digits(env.TREASURY_BANK_ACCOUNT_NUMBER || env.BETTERMENT_ACCOUNT_NUMBER);
    const ein = digits(env.ACH_ODFI_COMPANY_EIN || env.INCOME_OBLIGOR_EIN);
    const originatorName = String(env.ACH_ODFI_ORIGINATOR_NAME || env.TREASURY_BANK_ACCOUNT_HOLDER || env.INCOME_OBLIGOR_NAME || '').trim();
    return {
      enabled: bank !== '' && bank !== 'none' && bank !== 'off',
      bank,
      bankName: env.ACH_ODFI_BANK_NAME || (bank === 'betterment' ? 'BETTERMENT' : bank.toUpperCase()),
      routingConfigured: routing.length === 9,
      accountConfigured: account.length >= 4,
      routingLast4: last4(routing),
      accountLast4: last4(account),
      originatorName,
      companyName: String(env.ACH_ODFI_COMPANY_NAME || originatorName).slice(0, 16),
      immediateOrigin: digits(env.ACH_ODFI_IMMEDIATE_ORIGIN) || (routing ? `1${routing}` : ''),
      companyId: String(env.ACH_ODFI_COMPANY_ID || (ein.length === 9 ? `1${ein}` : '')).trim(),
      _routing: routing,
      _account: account,
    };
  }

  static issues(cfg = this.getConfig()) {
    const issues = [];
    if (!cfg.enabled) { issues.push('ACH_ODFI_BANK not set'); return issues; }
    if (!cfg.routingConfigured) issues.push(`${cfg.bank.toUpperCase()}_ROUTING_NUMBER / TREASURY_BANK_ROUTING_NUMBER not configured (9 digits)`);
    if (!cfg.accountConfigured) issues.push(`${cfg.bank.toUpperCase()}_ACCOUNT_NUMBER / TREASURY_BANK_ACCOUNT_NUMBER not configured`);
    if (!cfg.originatorName) issues.push('ACH_ODFI_ORIGINATOR_NAME / INCOME_OBLIGOR_NAME not configured');
    if (!/^\d{10}$/.test(cfg.immediateOrigin)) issues.push('ACH_ODFI_IMMEDIATE_ORIGIN must be 10 digits');
    if (!/^[A-Za-z0-9]{10}$/.test(cfg.companyId)) issues.push('ACH_ODFI_COMPANY_ID (or INCOME_OBLIGOR_EIN) must yield a 10-character ACH company id');
    return issues;
  }

  /**
   * Project the ODFI bank onto the originator env vars. Idempotent; a no-op
   * unless ACH_ODFI_BANK is set. Returns the list of variables written.
   */
  static apply(env = process.env) {
    const cfg = this.getConfig(env);
    if (!cfg.enabled || !cfg.routingConfigured) return [];
    const written = [];
    const put = (name, value) => { if (set(env, name, value)) written.push(name); };
    put('ACH_ODFI_ROUTING', cfg._routing);
    put('NACHA_ODFI_ROUTING', cfg._routing);
    put('TRUST_BANK_ROUTING', cfg._routing);
    put('LILI_ODFI_ROUTING', cfg._routing);
    put('ACH_ODFI_NAME', cfg.bankName);
    put('NACHA_IMMEDIATE_DESTINATION_NAME', cfg.bankName);
    put('TRUST_BANK_NAME', cfg.bankName);
    put('LILI_ODFI_NAME', cfg.originatorName || cfg.bankName);
    put('ACH_IMMEDIATE_ORIGIN', cfg.immediateOrigin);
    put('ACH_ORIGINATOR_NAME', cfg.originatorName);
    put('NACHA_ORIGINATOR_NAME', cfg.originatorName);
    put('NACHA_IMMEDIATE_ORIGIN_NAME', cfg.originatorName);
    put('ACH_COMPANY_NAME', cfg.companyName);
    put('NACHA_COMPANY_NAME', cfg.companyName);
    put('ACH_COMPANY_ID', cfg.companyId);
    if (cfg.accountConfigured) {
      put('CLEARING_FUNDING_OPERATING_ACCOUNT', cfg._account);
      put('LILI_ODFI_ACCOUNT', cfg._account);
      put('TRUST_BANK_ACCOUNT', cfg._account);
      put('EDI_820_ODFI_ACCOUNT', cfg._account);
    }
    return written;
  }

  static fileChannel(env = process.env) {
    const channels = [];
    const OpenAchFileRelay = fileRelay();
    if (OpenAchFileRelay) {
      try {
        const s = OpenAchFileRelay.status();
        channels.push({ channel: 'openach_mft_relay', ready: Boolean(s.ready), transport: s.transport, stationAs2Id: s.stationAs2Id, partnerAs2Id: s.partnerAs2Id, issues: s.issues || [] });
      } catch (e) { channels.push({ channel: 'openach_mft_relay', ready: false, issues: [e.message] }); }
    }
    if (env.MFTGATEWAY_PARTNER_AS2_ID) channels.push({ channel: 'mftgateway_partner', ready: true, partnerAs2Id: env.MFTGATEWAY_PARTNER_AS2_ID, issues: [] });
    if (env.ACH_SFTP_URL) {
      const issues = [];
      if (!env.ACH_SFTP_KEY && !env.ACH_SFTP_PASSWORD) issues.push('ACH_SFTP_KEY or ACH_SFTP_PASSWORD required');
      channels.push({ channel: 'sftp', ready: issues.length === 0, url: String(env.ACH_SFTP_URL).replace(/\/\/[^@/]*@/, '//***@'), issues });
    }
    if (env.ACH_MFT_CHANNEL) channels.push({ channel: 'mft_os', ready: true, channelId: env.ACH_MFT_CHANNEL, issues: [] });
    channels.push({ channel: 'server_to_server', ready: Boolean(env.PAYMENT_SERVER_SERVICE_TOKEN), path: '/api/payment-server/v1', issues: env.PAYMENT_SERVER_SERVICE_TOKEN ? [] : ['PAYMENT_SERVER_SERVICE_TOKEN not configured'] });
    return channels;
  }

  static status(env = process.env) {
    const cfg = this.getConfig(env);
    const issues = this.issues(cfg);
    const channels = this.fileChannel(env);
    const delivery = channels.filter((c) => c.channel !== 'server_to_server');
    if (cfg.enabled && !delivery.some((c) => c.ready)) issues.push('no ready file-delivery channel to the ODFI bank (OpenACH/MFT relay, MFTGATEWAY_PARTNER_AS2_ID, ACH_SFTP_URL or ACH_MFT_CHANNEL)');
    return {
      role: 'odfi',
      enabled: cfg.enabled,
      ready: cfg.enabled && issues.length === 0,
      bank: cfg.bank || null,
      bankName: cfg.enabled ? cfg.bankName : null,
      accountHolder: cfg.originatorName || null,
      routingLast4: cfg.routingLast4,
      accountLast4: cfg.accountLast4,
      immediateOrigin: cfg.enabled && cfg.immediateOrigin ? `******${cfg.immediateOrigin.slice(-4)}` : null,
      companyId: cfg.enabled && cfg.companyId ? `******${cfg.companyId.slice(-4)}` : null,
      originator: 'dlb-treasury (OpenACH / Payment Hub / ACHEngine on GCP)',
      channels,
      issues,
      note: 'dlb-treasury originates and funds the NACHA file from the trust account of record; the ODFI bank accepts the file and executes it against the trust checking account. Settlement is reported only from the bank return/acknowledgement evidence.',
    };
  }
}

module.exports = { TreasuryOdfiBank, ORIGINATOR_VARS };

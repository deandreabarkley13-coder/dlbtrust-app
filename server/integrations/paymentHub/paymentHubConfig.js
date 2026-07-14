'use strict';

const { URL } = require('url');

const MODES = new Set(['disabled', 'shadow', 'local_ach', 'phee']);

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function integer(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function getConfig() {
  const production = process.env.NODE_ENV === 'production';
  const mode = MODES.has(process.env.PAYMENT_HUB_MODE)
    ? process.env.PAYMENT_HUB_MODE
    : 'disabled';

  return {
    production,
    mode,
    live: bool('PAYMENT_HUB_LIVE', false),
    accountingOwner: process.env.PAYMENT_HUB_ACCOUNTING_OWNER || 'dlbtrust',
    approvalThreshold: integer('PAYMENT_APPROVAL_THRESHOLD', production ? 2 : 1, 1, 5),
    allowSelfApproval: !production && bool('PAYMENT_ALLOW_SELF_APPROVAL', false),
    holdHours: integer('PAYMENT_HOLD_HOURS', 72, 1, 720),
    baseUrl: (process.env.PAYMENT_HUB_BASE_URL || '').replace(/\/$/, ''),
    transferPath: process.env.PAYMENT_HUB_TRANSFER_PATH || '/channel/ach/transfer',
    tenantId: process.env.PAYMENT_HUB_TENANT_ID || 'default',
    authToken: process.env.PAYMENT_HUB_AUTH_TOKEN || '',
    serviceToken: process.env.PAYMENT_HUB_SERVICE_TOKEN || '',
    webhookSecret: process.env.PAYMENT_HUB_WEBHOOK_SECRET || '',
    webhookMaxAgeSeconds: integer('PAYMENT_HUB_WEBHOOK_MAX_AGE_SECONDS', 300),
    requestTimeoutMs: integer('PAYMENT_HUB_TIMEOUT_MS', 15000, 1000, 120000),
    maxRetries: integer('PAYMENT_HUB_MAX_RETRIES', 2, 0, 5),
    callbackUrl: process.env.PAYMENT_HUB_CALLBACK_URL || '',
    connectorUrl: process.env.PAYMENT_HUB_ACH_CONNECTOR_URL || '',
    dataEncryptionConfigured: Boolean(process.env.PAYMENT_DATA_ENCRYPTION_KEY),
  };
}

function isSecureEndpoint(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.endsWith('.internal') ||
      url.hostname.endsWith('.svc') ||
      url.hostname.endsWith('.svc.cluster.local')
    );
  } catch (err) {
    return false;
  }
}

function readiness() {
  const config = getConfig();
  const issues = [];
  const warnings = [];

  if (config.accountingOwner !== 'dlbtrust') {
    issues.push('PAYMENT_HUB_ACCOUNTING_OWNER must be dlbtrust to keep one Fineract GL writer');
  }
  if (config.production && !config.dataEncryptionConfigured) {
    issues.push('PAYMENT_DATA_ENCRYPTION_KEY is required in production');
  }
  if (config.production && config.approvalThreshold < 2) {
    issues.push('PAYMENT_APPROVAL_THRESHOLD must be at least 2 in production');
  }
  if (config.mode === 'phee') {
    if (!isSecureEndpoint(config.baseUrl)) issues.push('PAYMENT_HUB_BASE_URL must be HTTPS or a private cluster address');
    if (!config.authToken) issues.push('PAYMENT_HUB_AUTH_TOKEN is required for PHEE mode');
    if (!config.serviceToken) issues.push('PAYMENT_HUB_SERVICE_TOKEN is required for the ACH connector endpoint');
    if (!config.webhookSecret) issues.push('PAYMENT_HUB_WEBHOOK_SECRET is required for signed callbacks');
    if (!isSecureEndpoint(config.callbackUrl)) issues.push('PAYMENT_HUB_CALLBACK_URL must be HTTPS or a private cluster address');
    if (!isSecureEndpoint(config.connectorUrl)) issues.push('PAYMENT_HUB_ACH_CONNECTOR_URL must be HTTPS or a private cluster address');
  }
  if (config.production && config.mode === 'local_ach') {
    warnings.push('local_ach bypasses Payment Hub EE orchestration and should only be used for bank certification');
  }
  if (config.mode === 'disabled') warnings.push('Payment submission is disabled');
  if (config.mode === 'shadow') warnings.push('Shadow mode validates instructions but never transmits them');
  if (!config.live) warnings.push('PAYMENT_HUB_LIVE is false; payment transmission is blocked');

  return {
    ready: issues.length === 0,
    canTransmit: issues.length === 0 && config.mode !== 'disabled' && config.mode !== 'shadow' && config.live,
    issues,
    warnings,
    config: {
      mode: config.mode,
      live: config.live,
      accountingOwner: config.accountingOwner,
      approvalThreshold: config.approvalThreshold,
      baseUrlConfigured: Boolean(config.baseUrl),
      tenantId: config.tenantId,
      callbackUrlConfigured: Boolean(config.callbackUrl),
      connectorUrlConfigured: Boolean(config.connectorUrl),
      dataEncryptionConfigured: config.dataEncryptionConfigured,
    },
  };
}

module.exports = { getConfig, readiness, isSecureEndpoint };

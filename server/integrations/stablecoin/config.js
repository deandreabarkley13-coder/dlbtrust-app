'use strict';

/**
 * Stablecoin module configuration.
 */

const MODES = new Set(['disabled', 'shadow', 'testnet', 'mainnet']);
const NETWORKS = new Set(['testnet', 'public', 'mainnet', 'custom']);

function bool(name, fallback = false) {
  const v = process.env[name];
  return v ? String(v).toLowerCase() === 'true' : fallback;
}

function int(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function str(name, fallback = '') {
  return (process.env[name] || fallback).trim();
}

function getConfig() {
  const mode = MODES.has(process.env.STABLECOIN_MODE) ? process.env.STABLECOIN_MODE : 'disabled';
  const network = str('STABLECOIN_NETWORK', 'testnet').toLowerCase();
  return {
    enabled: bool('STABLECOIN_ENABLED', false),
    mode,
    network,
    assetCode: str('STABLECOIN_ASSET_CODE', 'USDC').toUpperCase(),
    issuerPublic: str('STABLECOIN_ISSUER_PUBLIC', ''),
    issuerSecret: str('STABLECOIN_ISSUER_SECRET', ''),
    distributorPublic: str('STABLECOIN_DISTRIBUTOR_PUBLIC', ''),
    distributorSecret: str('STABLECOIN_DISTRIBUTOR_SECRET', ''),
    horizonUrl: str('HORIZON_URL', network === 'mainnet' || network === 'public'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org'),
    networkPassphrase: str('STELLAR_NETWORK_PASSPHRASE', ''),
    friendbotUrl: str('FRIENDBOT_URL', 'https://friendbot.stellar.org'),
    gatewayFeeCents: int('STABLECOIN_GATEWAY_FEE_CENTS', 25, 0, 1_000_000),
    magicApiKey: str('MAGIC_API_KEY', ''),
    magicSecretKey: str('MAGIC_SECRET_KEY', ''),
    magicBaseUrl: str('MAGIC_BASE_URL', 'https://tee.magiclabs.com'),
    magicWalletGroupId: str('MAGIC_WALLET_GROUP_ID', ''),
    wso2BaseUrl: str('WSO2_BASE_URL', ''),
    wso2TokenUrl: str('WSO2_TOKEN_URL', ''),
    wso2ClientId: str('WSO2_CLIENT_ID', ''),
    wso2ClientSecret: str('WSO2_CLIENT_SECRET', ''),
    wso2ApiContext: str('WSO2_API_CONTEXT', '/stablecoin'),
    // Source-of-funds mappings
    cashHoldingAccount: str('STABLECOIN_CASH_HOLDING_ACCOUNT', 'STABLECOIN_CASH_HOLD'),
    cashSettlementAccount: str('STABLECOIN_CASH_SETTLEMENT_ACCOUNT', ''),
    stablecoinAssetAccount: str('STABLECOIN_ASSET_ACCOUNT', '1210'),
    fineractStablecoinAssetGlId: str('STABLECOIN_FINERACT_ASSET_GL_ID', ''),
  };
}

function isProduction(cfg) {
  return cfg.mode === 'mainnet' || cfg.network === 'mainnet' || cfg.network === 'public';
}

function redact(cfg) {
  const copy = { ...cfg };
  ['issuerSecret', 'distributorSecret', 'magicSecretKey', 'wso2ClientSecret'].forEach((k) => {
    if (copy[k]) copy[k] = '***';
  });
  return copy;
}

module.exports = { getConfig, isProduction, redact, MODES, NETWORKS };

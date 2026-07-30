'use strict';

/**
 * Stablecoin module configuration.
 */

const MODES = new Set(['disabled', 'shadow', 'testnet', 'mainnet']);
const NETWORKS = new Set(['testnet', 'public', 'mainnet', 'custom', 'fystack', 'circle']);

function isFyStackNetwork(network) {
  const n = String(network || '').toLowerCase();
  return n === 'fystack' || n.startsWith('fystack-');
}

function isCircleNetwork(network) {
  const n = String(network || '').toLowerCase();
  return n === 'circle' || n.startsWith('circle-');
}

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
    // FyStack Ignite self-hosted custody / payment rail
    fyStackEnabled: bool('FYSTACK_ENABLED', false),
    fyStackApiKey: str('FYSTACK_API_KEY', ''),
    fyStackApiSecret: str('FYSTACK_API_SECRET', ''),
    fyStackWorkspaceId: str('FYSTACK_WORKSPACE_ID', ''),
    fyStackBaseUrl: str('FYSTACK_BASE_URL', 'http://localhost:8150'),
    fyStackNetwork: str('FYSTACK_NETWORK', mode === 'mainnet' ? 'ETHEREUM_MAINNET' : 'ETHEREUM_SEPOLIA'),
    fyStackAsset: str('FYSTACK_ASSET', 'USDC'),
    fyStackAssetId: str('FYSTACK_ASSET_ID', ''),
    fyStackTreasuryWalletId: str('FYSTACK_TREASURY_WALLET_ID', ''),
    fyStackAddressType: str('FYSTACK_ADDRESS_TYPE', 'evm'),
    fyStackExplorerTx: str('FYSTACK_EXPLORER_TX', ''),
    fyStackShadow: bool('FYSTACK_SHADOW', false),
    // Circle App Kit mainnet stablecoin rail
    circleEnabled: bool('CIRCLE_ENABLED', false),
    circleKitKey: str('CIRCLE_KIT_KEY', ''),
    circleAdapterType: str('CIRCLE_ADAPTER_TYPE', 'viem'),
    circlePrivateKey: str('CIRCLE_PRIVATE_KEY', ''),
    circleApiKey: str('CIRCLE_API_KEY', ''),
    circleEntitySecret: str('CIRCLE_ENTITY_SECRET', ''),
    circleSourceAddress: str('CIRCLE_SOURCE_ADDRESS', ''),
    circleChain: str('CIRCLE_CHAIN', 'Ethereum'),
    circleToken: str('CIRCLE_TOKEN', 'USDC'),
    circleExplorerTx: str('CIRCLE_EXPLORER_TX', ''),
    circleShadow: bool('CIRCLE_SHADOW', false),
    // Circle Mint regulated fiat on-ramp
    circleMintApiKey: str('CIRCLE_MINT_API_KEY', ''),
    circleMintBaseUrl: str('CIRCLE_MINT_BASE_URL', 'https://api.circle.com'),
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
  ['issuerSecret', 'distributorSecret', 'magicSecretKey', 'wso2ClientSecret', 'fyStackApiSecret', 'circlePrivateKey', 'circleApiKey', 'circleEntitySecret', 'circleKitKey', 'circleMintApiKey'].forEach((k) => {
    if (copy[k]) copy[k] = '***';
  });
  return copy;
}

module.exports = { getConfig, isProduction, redact, isFyStackNetwork, isCircleNetwork, MODES, NETWORKS };

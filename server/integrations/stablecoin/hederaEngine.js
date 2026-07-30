'use strict';

/**
 * Hedera Stablecoin Studio engine.
 *
 * Wraps the @hashgraph/stablecoin-npm-sdk to issue, mint, transfer and query
 * Hedera stablecoins. Designed to be used by StablecoinGateway alongside the
 * Stellar BlockchainEngine.
 */

const { getConfig, isProduction } = require('./config');

let sdk;
try {
  sdk = require('@hashgraph/stablecoin-npm-sdk');
} catch (err) {
  console.warn('[hederaEngine] @hashgraph/stablecoin-npm-sdk not installed:', err.message);
}

let hederaSdk;
try {
  hederaSdk = require('@hiero-ledger/sdk');
} catch (err) {
  console.warn('[hederaEngine] @hiero-ledger/sdk not installed:', err.message);
}

let initPromise = null;
let cachedTokenInfo = null;

const TESTNET_FACTORY = '0.0.7353542';
const TESTNET_RESOLVER = '0.0.7353500';
const HEDERA_EXPLORER = 'https://hashscan.io';

function centsToTokenUnits(cents, decimals = 6) {
  if (decimals < 2) decimals = 2;
  const scale = BigInt(10 ** (decimals - 2));
  const scaled = BigInt(cents) * scale;
  const divisor = BigInt(10 ** decimals);
  const whole = scaled / divisor;
  const frac = (scaled % divisor).toString().padStart(decimals, '0');
  return `${whole}.${frac}`;
}

function toHederaTokenAmount(cents, decimals = 6) {
  return BigInt(cents) * (BigInt(10) ** BigInt(decimals)) / 100n;
}

function txExplorerUrl(network, txId) {
  if (!txId || typeof txId !== 'string') return '';
  const net = network === 'mainnet' ? 'mainnet' : 'testnet';
  return `${HEDERA_EXPLORER}/${net}/transaction/${txId}`;
}

function parseHederaPrivateKey(key, type) {
  if (!hederaSdk) throw new Error('@hiero-ledger/sdk is not available');
  const t = (type || '').toUpperCase();
  if (t === 'ECDSA') return hederaSdk.PrivateKey.fromStringECDSA(key);
  if (t === 'ED25519') return hederaSdk.PrivateKey.fromStringED25519(key);
  // Default: use fromString (auto-detect), but ECDSA 0x keys often need explicit type.
  return hederaSdk.PrivateKey.fromString(key);
}

class HederaEngine {
  static getSdk() {
    if (!sdk) throw new Error('@hashgraph/stablecoin-npm-sdk is not installed');
    return sdk;
  }

  async ensureInitialized() {
    const cfg = getConfig();
    if (!cfg.hederaEnabled) throw new Error('Hedera Stablecoin Studio is not enabled');
    if (!cfg.hederaOperatorId) throw new Error('HEDERA_OPERATOR_ID is required');
    if (!cfg.hederaOperatorKey) throw new Error('HEDERA_OPERATOR_KEY is required');

    if (initPromise) return initPromise;
    initPromise = this._init(cfg);
    return initPromise;
  }

  async _init(cfg) {
    const S = HederaEngine.getSdk();
    const networkName = cfg.hederaNetwork === 'mainnet' ? 'mainnet' : 'testnet';

    const factoryAddress = cfg.hederaFactoryId || (networkName === 'testnet' ? TESTNET_FACTORY : '');
    const resolverAddress = cfg.hederaResolverId || (networkName === 'testnet' ? TESTNET_RESOLVER : '');
    if (!factoryAddress || !resolverAddress) {
      throw new Error(`HEDERA_FACTORY_ID and HEDERA_RESOLVER_ID are required for ${networkName}`);
    }

    const mirrorNode = {
      name: `${networkName} mirror node`,
      network: networkName,
      baseUrl: cfg.hederaMirrorNode || `https://${networkName}.mirrornode.hedera.com/api/v1/`,
      apiKey: '',
      headerName: '',
      selected: true,
    };
    const rpcNode = {
      name: `${networkName} RPC`,
      network: networkName,
      baseUrl: cfg.hederaRpcNode || `https://${networkName}.hashio.io/api`,
      apiKey: '',
      headerName: '',
      selected: true,
    };

    await S.Network.init(
      new S.InitializationRequest({
        network: networkName,
        mirrorNode,
        rpcNode,
        configuration: { factoryAddress, resolverAddress },
      }),
    );

    await S.Network.connect(
      new S.ConnectRequest({
        account: {
          accountId: cfg.hederaOperatorId,
          privateKey: { key: cfg.hederaOperatorKey, type: cfg.hederaKeyType || 'ED25519' },
        },
        network: networkName,
        mirrorNode,
        rpcNode,
        wallet: S.SupportedWallets.CLIENT,
      }),
    );

    return { network: networkName, factoryAddress, resolverAddress };
  }

  static reset() {
    initPromise = null;
    cachedTokenInfo = null;
  }

  async readiness() {
    const cfg = getConfig();
    const issues = [];
    const warnings = [];

    if (!cfg.hederaEnabled) issues.push('HEDERA_STUDIO_ENABLED is not true');
    if (!cfg.hederaOperatorId) issues.push('HEDERA_OPERATOR_ID is required');
    if (!cfg.hederaOperatorKey) issues.push('HEDERA_OPERATOR_KEY is required');

    const networkName = (cfg.hederaNetwork || 'testnet').toLowerCase();
    if (networkName === 'mainnet') {
      if (!cfg.hederaFactoryId) issues.push('HEDERA_FACTORY_ID is required for mainnet');
      if (!cfg.hederaResolverId) issues.push('HEDERA_RESOLVER_ID is required for mainnet');
    }

    let mirrorOk = false;
    if (!issues.length && !cfg.hederaShadow) {
      try {
        const base = cfg.hederaMirrorNode || `https://${networkName}.mirrornode.hedera.com/api/v1/`;
        const res = await fetch(`${base}accounts?limit=1`);
        mirrorOk = res.ok;
        if (!res.ok) issues.push(`Hedera mirror node unreachable: ${res.status}`);
      } catch (e) {
        issues.push(`Hedera mirror node unreachable: ${e.message}`);
      }
    }

    return {
      ready: issues.length === 0,
      issues,
      warnings,
      network: networkName,
      mode: cfg.hederaShadow ? 'shadow' : 'live',
      operatorId: cfg.hederaOperatorId,
      tokenId: cfg.hederaTokenId,
      mirrorOk,
    };
  }

  async getTokenInfo(tokenId) {
    if (cachedTokenInfo && cachedTokenInfo.tokenId === tokenId) return cachedTokenInfo;
    const S = HederaEngine.getSdk();
    await this.ensureInitialized();
    const coin = await S.StableCoin.getInfo(new S.GetStableCoinDetailsRequest({ id: tokenId }));
    cachedTokenInfo = {
      tokenId,
      name: coin?.name,
      symbol: coin?.symbol,
      decimals: Number(coin?.decimals || coin?.tokenDecimals || 6),
      totalSupply: coin?.totalSupply?.toString(),
    };
    return cachedTokenInfo;
  }

  async createStablecoin({ name, symbol, decimals = 6, initialSupply = '0', createReserve = false } = {}) {
    const cfg = getConfig();
    if (cfg.hederaShadow) {
      const fakeId = `0.0.shadow-${Date.now()}`;
      cachedTokenInfo = { tokenId: fakeId, name, symbol, decimals };
      return { tokenId: fakeId, simulated: true };
    }

    const S = HederaEngine.getSdk();
    await this.ensureInitialized();
    const operatorId = cfg.hederaOperatorId;

    const request = new S.CreateRequest({
      name,
      symbol,
      decimals,
      initialSupply: centsToTokenUnits(Number(initialSupply) * 100, decimals),
      supplyType: S.TokenSupplyType.INFINITE,
      createReserve,
      grantKYCToOriginalSender: true,
      burnRoleAccount: operatorId,
      wipeRoleAccount: operatorId,
      rescueRoleAccount: operatorId,
      pauseRoleAccount: operatorId,
      freezeRoleAccount: operatorId,
      deleteRoleAccount: operatorId,
      kycRoleAccount: operatorId,
      cashInRoleAccount: operatorId,
      feeRoleAccount: operatorId,
      holdCreatorRoleAccount: operatorId,
      cashInRoleAllowance: '0',
      proxyOwnerAccount: operatorId,
      configId: '0x0000000000000000000000000000000000000000000000000000000000000002',
      configVersion: 1,
    });

    const result = await S.StableCoin.create(request);
    const tokenId = result?.coin?.tokenId?.toString();
    cachedTokenInfo = { tokenId, name, symbol, decimals };
    return { tokenId, simulated: false, txId: result?.coin?.transactionId?.toString() };
  }

  _effectiveTokenId(cfg) {
    if (cfg.hederaTokenId) return cfg.hederaTokenId;
    if (cachedTokenInfo?.tokenId) return cachedTokenInfo.tokenId;
    throw new Error('No HEDERA_TOKEN_ID configured and no token has been created in this session');
  }

  async ensureToken(tokenId) {
    if (tokenId) return tokenId;
    const cfg = getConfig();
    if (cfg.hederaTokenId) return cfg.hederaTokenId;
    if (cachedTokenInfo?.tokenId) return cachedTokenInfo.tokenId;
    throw new Error('No Hedera stablecoin token ID configured or created');
  }

  async isAssociated(tokenId, targetId) {
    const cfg = getConfig();
    if (cfg.hederaShadow) return true;
    const S = HederaEngine.getSdk();
    await this.ensureInitialized();
    return S.StableCoin.isAccountAssociated(
      new S.IsAccountAssociatedTokenRequest({ tokenId, targetId }),
    );
  }

  async ensureDestinationAssociation({ tokenId, targetId, targetKey } = {}) {
    if (await this.isAssociated(tokenId, targetId)) return { associated: true, txId: null };
    if (!targetKey) {
      throw new Error(`Destination ${targetId} is not associated with token ${tokenId}. Provide targetKey or ask the receiver to associate the token.`);
    }
    return this.associateToken({ tokenId, targetId, targetKey });
  }

  async getHederaClient() {
    if (!hederaSdk) throw new Error('@hiero-ledger/sdk is not available');
    const cfg = getConfig();
    const client = cfg.hederaNetwork === 'mainnet'
      ? hederaSdk.Client.forMainnet()
      : hederaSdk.Client.forTestnet();
    client.setOperator(cfg.hederaOperatorId, parseHederaPrivateKey(cfg.hederaOperatorKey, cfg.hederaKeyType));
    return client;
  }

  async associateToken({ tokenId, targetId, targetKey } = {}) {
    if (!hederaSdk) throw new Error('@hiero-ledger/sdk is not available');
    if (!tokenId) throw new Error('tokenId is required');
    if (!targetId) throw new Error('targetId is required');
    if (!targetKey) throw new Error('targetKey is required to sign association');
    const cfg = getConfig();
    if (cfg.hederaShadow) {
      return { associated: true, txId: `shadow-${Date.now()}`, simulated: true };
    }
    const client = await this.getHederaClient();
    const targetPrivateKey = parseHederaPrivateKey(targetKey, cfg.hederaKeyType);
    const tx = await new hederaSdk.TokenAssociateTransaction()
      .setAccountId(targetId)
      .setTokenIds([tokenId])
      .freezeWith(client);
    const signedTx = await tx.sign(targetPrivateKey);
    const receipt = await signedTx.execute(client);
    const txId = receipt?.transactionId?.toString() || '';
    return { associated: true, txId, explorer: txExplorerUrl(cfg.hederaNetwork, txId) };
  }

  async cashIn({ tokenId, targetId, amountCents } = {}) {
    const cfg = getConfig();
    tokenId = await this.ensureToken(tokenId);
    const decimals = cfg.hederaShadow ? cfg.hederaDecimals : (await this.getTokenInfo(tokenId)).decimals;
    const amount = centsToTokenUnits(amountCents, decimals);

    if (cfg.hederaShadow) {
      return { txId: `shadow-${Date.now()}`, tokenId, amount, simulated: true };
    }

    const S = HederaEngine.getSdk();
    await this.ensureInitialized();
    const result = await S.StableCoin.cashIn(
      new S.CashInRequest({ tokenId, targetId, amount }),
    );
    return {
      txId: result?.transactionId?.toString(),
      tokenId,
      amount,
      simulated: false,
      explorer: txExplorerUrl(cfg.hederaNetwork, result?.transactionId?.toString()),
    };
  }

  async transfer({ tokenId, destination, amountCents, destinationKey, memo } = {}) {
    const cfg = getConfig();
    tokenId = await this.ensureToken(tokenId);
    const decimals = cfg.hederaShadow ? cfg.hederaDecimals : (await this.getTokenInfo(tokenId)).decimals;
    const amount = toHederaTokenAmount(amountCents, decimals);
    const operatorId = cfg.hederaOperatorId;

    if (cfg.hederaShadow) {
      return { txId: `shadow-${Date.now()}`, tokenId, amount: amount.toString(), simulated: true };
    }

    await this.ensureInitialized();
    await this.ensureDestinationAssociation({ tokenId, targetId: destination, targetKey: destinationKey });

    const client = await this.getHederaClient();
    const tx = await new hederaSdk.TransferTransaction()
      .addTokenTransfer(tokenId, operatorId, -amount)
      .addTokenTransfer(tokenId, destination, amount)
      .setTransactionMemo(memo || '')
      .freezeWith(client);
    const signedTx = await tx.sign(parseHederaPrivateKey(cfg.hederaOperatorKey, cfg.hederaKeyType));
    const receipt = await signedTx.execute(client);
    const txId = receipt?.transactionId?.toString() || '';
    return {
      txId,
      tokenId,
      amount: amount.toString(),
      simulated: false,
      explorer: txExplorerUrl(cfg.hederaNetwork, txId),
    };
  }

  async settle({ destination, amountCents, memo, destinationKey } = {}) {
    const cfg = getConfig();
    const tokenId = await this.ensureToken();
    const decimals = cfg.hederaShadow ? cfg.hederaDecimals : (await this.getTokenInfo(tokenId)).decimals;

    if (cfg.hederaShadow) {
      return {
        hash: `shadow-${Date.now()}`,
        tokenId,
        amount: centsToTokenUnits(amountCents, decimals),
        memo,
        simulated: true,
        latencyMs: 0,
        explorer: '',
      };
    }

    const start = Date.now();
    const result = await this.transfer({ tokenId, destination, amountCents, destinationKey, memo });
    return {
      hash: result.txId,
      ledger: 0,
      amount: result.amount,
      memo,
      latencyMs: Date.now() - start,
      explorer: result.explorer,
      simulated: false,
      tokenId,
    };
  }

  async getBalance({ tokenId, accountId } = {}) {
    const cfg = getConfig();
    if (cfg.hederaShadow) return '0';
    tokenId = await this.ensureToken(tokenId);

    const S = HederaEngine.getSdk();
    await this.ensureInitialized();
    const balance = await S.StableCoin.getBalanceOf(
      new S.GetAccountBalanceRequest({ tokenId, targetId: accountId }),
    );
    return balance?.value?.toString() || '0';
  }
}

module.exports = { HederaEngine, centsToTokenUnits };

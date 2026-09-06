'use strict';

/**
 * thirdweb server-wallet stablecoin rail.
 *
 * Adapts `ThirdwebServerWalletEngine.send` to the StablecoinGateway engine
 * contract (`readiness()` / `settle()`), so a payment on network `thirdweb`
 * moves ERC-20 USDC from the trust's Vault-held server wallet. Every
 * server-wallet safeguard still applies (distribution policy, price oracle
 * cross-check, THIRDWEB_SERVER_WALLET_MAX_QUANTITY, allowed recipients,
 * THIRDWEB_SERVER_WALLET_LIVE gate). This is an on-chain rail only: it has
 * no fiat leg and does not replace Circle Mint wire on/off-ramps.
 *
 *   THIRDWEB_RAIL_ENABLED=true            select this rail for network "thirdweb"
 *   THIRDWEB_RAIL_TOKEN_ADDRESS           ERC-20 contract (defaults to the dApp USDC address)
 *   THIRDWEB_RAIL_TOKEN_DECIMALS          default 6 (USDC)
 *   THIRDWEB_RAIL_WAIT_MS                 poll thirdweb for confirmation up to N ms (0 = return on submit)
 *   THIRDWEB_RAIL_EXPLORER_TX             explorer URL prefix for confirmed hashes
 */

const { getConfig } = require('./config');
const { ThirdwebServerWalletEngine } = require('../dapp/thirdwebServerWalletEngine');

let dappConfig = null;
try { dappConfig = require('../dapp/config'); } catch (e) { dappConfig = null; }

function centsToQuantity(amountCents, decimals) {
  const cents = BigInt(amountCents);
  if (cents <= 0n) throw new Error('amountCents must be positive');
  if (decimals < 2) throw new Error('THIRDWEB_RAIL_TOKEN_DECIMALS must be >= 2');
  return cents * (10n ** BigInt(decimals - 2));
}

class ThirdwebRailEngine {
  constructor(cfg = getConfig()) {
    this.cfg = cfg;
  }

  _tokenAddress() {
    if (this.cfg.thirdwebRailTokenAddress) return this.cfg.thirdwebRailTokenAddress;
    if (dappConfig && typeof dappConfig.getConfig === 'function') {
      try { return dappConfig.getConfig().usdcAddress || ''; } catch (e) { return ''; }
    }
    return '';
  }

  _inShadow() {
    return this.cfg.mode === 'shadow' || !ThirdwebServerWalletEngine.getConfig().live;
  }

  readiness() {
    const wallet = ThirdwebServerWalletEngine.readiness();
    const issues = [...(wallet.issues || [])];
    const warnings = [];
    if (!this.cfg.thirdwebRailEnabled) issues.push('THIRDWEB_RAIL_ENABLED is not true');
    const tokenAddress = this._tokenAddress();
    if (!tokenAddress) issues.push('THIRDWEB_RAIL_TOKEN_ADDRESS not configured and no dApp USDC address available');
    if (!wallet.live) warnings.push('THIRDWEB_SERVER_WALLET_LIVE=false: settlements are recorded as shadow, nothing is broadcast');
    if (wallet.live && !wallet.allowedRecipients.length) warnings.push('THIRDWEB_SERVER_WALLET_ALLOWED_RECIPIENTS is empty: any address may be paid');
    if (wallet.live && wallet.maxQuantityPerSend === '0') warnings.push('THIRDWEB_SERVER_WALLET_MAX_QUANTITY=0: no per-send ceiling');
    return {
      provider: 'thirdweb-server-wallet',
      ready: issues.length === 0,
      live: Boolean(wallet.live),
      shadow: this._inShadow(),
      enabled: Boolean(this.cfg.thirdwebRailEnabled),
      chainId: wallet.chainId,
      sourceAddress: wallet.address,
      tokenAddress: tokenAddress || null,
      tokenDecimals: this.cfg.thirdwebRailTokenDecimals,
      assetCode: this.cfg.assetCode,
      maxQuantityPerSend: wallet.maxQuantityPerSend,
      allowedRecipients: wallet.allowedRecipients,
      issues,
      warnings,
    };
  }

  /**
   * Settle a gateway payment. `purpose` and `requesterRole` come from the
   * payment metadata so the shared DistributionPolicy is enforced per payment.
   */
  async settle({ destination, amountCents, memo, reference, purpose, requesterRole } = {}) {
    if (!this.cfg.thirdwebRailEnabled) throw new Error('THIRDWEB_RAIL_ENABLED must be true for thirdweb stablecoin payments');
    if (!destination) throw new Error('destination wallet address is required');
    const tokenAddress = this._tokenAddress();
    if (!tokenAddress) throw new Error('THIRDWEB_RAIL_TOKEN_ADDRESS not configured');

    const decimals = this.cfg.thirdwebRailTokenDecimals;
    const quantity = centsToQuantity(amountCents, decimals);
    const amountUsd = Number(amountCents) / 100;

    const start = Date.now();
    const record = await ThirdwebServerWalletEngine.send({
      to: destination,
      quantity,
      tokenAddress,
      amountUsd,
      memo: memo || null,
      reference: reference || null,
      purpose,
      requesterRole: requesterRole || 'trustee',
    });

    let transactionHash = record.transactionHash || null;
    let status = record.status;
    if (!record.shadow && record.transactionId && this.cfg.thirdwebRailWaitMs > 0) {
      try {
        const tx = await ThirdwebServerWalletEngine.waitForTransaction(record.transactionId, { timeoutMs: this.cfg.thirdwebRailWaitMs });
        if (tx.status === 'FAILED') throw new Error(`thirdweb transaction ${record.transactionId} failed: ${tx.errorMessage || 'unknown'}`);
        transactionHash = tx.transactionHash || transactionHash;
        status = tx.status === 'CONFIRMED' ? 'confirmed' : status;
      } catch (err) {
        if (/failed:/.test(err.message)) throw err;
        // Timed out waiting: the transfer is submitted and reconcilable by transactionId.
      }
    }

    const hash = transactionHash || (record.shadow ? record.id : `thirdweb-tx:${record.transactionId}`);
    return {
      hash,
      status,
      amount: amountUsd.toFixed(2),
      memo: memo || null,
      latencyMs: Date.now() - start,
      explorer: transactionHash && this.cfg.thirdwebRailExplorerTx ? `${this.cfg.thirdwebRailExplorerTx}${transactionHash}` : '',
      simulated: Boolean(record.shadow),
      transactionId: record.transactionId || null,
      transferId: record.id,
      tokenAddress: record.tokenAddress,
      quantity: record.quantity,
    };
  }
}

module.exports = { ThirdwebRailEngine, centsToQuantity };

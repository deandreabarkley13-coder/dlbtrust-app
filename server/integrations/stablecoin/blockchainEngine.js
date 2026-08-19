'use strict';

/**
 * Blockchain Engine — direct stablecoin clearing and settlement to wallets.
 *
 * Primary rail: USDC on Stellar. The engine is intentionally narrow: it moves
 * stablecoins from the trust's distributor account to a beneficiary public key.
 * Wallet creation/address resolution is delegated to MagicWalletService.
 */

let sdk;
try {
  sdk = require('@stellar/stellar-sdk');
} catch (err) {
  console.warn('[stablecoin] @stellar/stellar-sdk not installed; settlement will be simulated.');
}

const { getConfig, isProduction } = require('./config');
const signing = require('./walletSigner');

function centsToUnits(cents) {
  const value = Number(cents);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('amountCents must be a non-negative safe integer');
  }
  const whole = BigInt(value) / 100n;
  const fraction = String(value % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

function parseNetworkPassphrase(cfg) {
  if (cfg.networkPassphrase) return cfg.networkPassphrase;
  if (!sdk) return '';
  if (cfg.network === 'mainnet' || cfg.network === 'public') return sdk.Networks.PUBLIC;
  if (cfg.network === 'testnet') return sdk.Networks.TESTNET;
  if (cfg.network === 'custom') return 'Custom Network';
  return sdk.Networks.TESTNET;
}

function loadKeypair(secret) {
  if (!sdk) throw new Error('Stellar SDK is not installed');
  try {
    return sdk.Keypair.fromSecret(secret);
  } catch (e) {
    throw new Error('Invalid Stellar secret key');
  }
}

function getAsset(cfg) {
  if (!sdk) throw new Error('Stellar SDK is not installed');
  if (cfg.issuerPublic) return new sdk.Asset(cfg.assetCode, cfg.issuerPublic);
  if (cfg.issuerSecret) {
    const issuer = loadKeypair(cfg.issuerSecret);
    return new sdk.Asset(cfg.assetCode, issuer.publicKey());
  }
  // Native XLM fallback only when no stablecoin issuer is configured.
  return sdk.Asset.native();
}

async function friendbot(pubkey) {
  const cfg = getConfig();
  if (!cfg.friendbotUrl) return;
  const res = await fetch(`${cfg.friendbotUrl}?addr=${encodeURIComponent(pubkey)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pubkey}: ${res.status}`);
  return res.json();
}

class BlockchainEngine {
  constructor() {
    this.cfg = getConfig();
    this.network = parseNetworkPassphrase(this.cfg);
    if (sdk) {
      this.server = new sdk.Horizon.Server(this.cfg.horizonUrl);
    }
  }

  static centsToUnits(cents) {
    return centsToUnits(cents);
  }

  async readiness() {
    const cfg = getConfig();
    const issues = [];
    const warnings = [];

    if (!cfg.enabled) issues.push('STABLECOIN_ENABLED is not true');
    if (cfg.mode === 'shadow') warnings.push('Blockchain engine is running in shadow/simulation mode');
    if (cfg.mode === 'disabled') issues.push('STABLECOIN_MODE is disabled');
    const custody = signing.custodyStatus(cfg);
    custody.issues.forEach((i) => issues.push(i));
    if (!custody.distributorPublic && !custody.keyInEnvironment) {
      issues.push('STABLECOIN_DISTRIBUTOR_PUBLIC is required when signing with a remote key custodian');
    }
    if (isProduction(cfg) && custody.keyInEnvironment) {
      warnings.push('Distributor key is held in the environment; move it to a custodian before mainnet settlement');
    }
    if (!cfg.assetCode) issues.push('STABLECOIN_ASSET_CODE is required');
    if (isProduction(cfg) && !cfg.issuerPublic && !cfg.issuerSecret) {
      issues.push('Mainnet USDC requires STABLECOIN_ISSUER_PUBLIC (Circle issuer)');
    }
    if (isProduction(cfg) && cfg.friendbotUrl) {
      warnings.push('FRIENDBOT_URL should not be used on mainnet');
    }

    let horizonOk = false;
    if (sdk && this.server && !issues.length) {
      try {
        await this.server.fetchTimebounds(10);
        horizonOk = true;
      } catch (e) {
        issues.push(`Horizon unreachable: ${e.message}`);
      }
    } else if (!sdk) {
      warnings.push('@stellar/stellar-sdk not installed; settlement simulated');
    }

    return {
      ready: issues.length === 0,
      issues,
      warnings,
      network: cfg.network,
      assetCode: cfg.assetCode,
      horizonUrl: cfg.horizonUrl,
      horizonOk,
      signer: { backend: custody.backend, custodial: custody.custodial },
      distributorPublic: custody.distributorPublic,
    };
  }

  async _loadDistributor() {
    if (!sdk) throw new Error('Stellar SDK is not installed');
    const signer = signing.createSigner(this.cfg);
    await this._fundIfNeeded(signer.publicKey());
    const account = await this.server.loadAccount(signer.publicKey());
    return { signer, account };
  }

  async _ensureTrustline(signer) {
    if (!sdk || !this.cfg.issuerPublic) return;
    try {
      const account = await this.server.loadAccount(signer.publicKey());
      const trustline = account.balances.find(
        (b) => b.asset_code === this.cfg.assetCode && b.asset_issuer === this.cfg.issuerPublic
      );
      if (trustline) return;
      const tx = new sdk.TransactionBuilder(account, {
        fee: sdk.BASE_FEE,
        networkPassphrase: this.network,
      })
        .addOperation(sdk.Operation.changeTrust({ asset: getAsset(this.cfg) }))
        .setTimeout(60)
        .build();
      await signer.signTransaction(tx);
      await this.server.submitTransaction(tx);
    } catch (e) {
      console.warn('[blockchainEngine] trustline ensure failed:', e.message);
    }
  }

  async _fundIfNeeded(publicKey) {
    if (isProduction(this.cfg)) return;
    try {
      await this.server.loadAccount(publicKey);
    } catch (e) {
      if (this.cfg.friendbotUrl) await friendbot(publicKey);
    }
  }

  /**
   * Ensure the destination account exists and has a trustline for the configured asset.
   * On testnet, an unfunded account is created via friendbot. If a destinationSecret
   * is provided, a missing trustline is opened by signing from the destination account.
   */
  async ensureDestinationTrustline({ destination, destinationSecret }) {
    if (!sdk) throw new Error('Stellar SDK is not installed');
    if (!destination) throw new Error('destination public key is required');
    let destKey;
    try {
      destKey = sdk.StrKey.isValidEd25519PublicKey(destination)
        ? destination
        : sdk.Keypair.fromPublicKey(destination).publicKey();
    } catch (e) {
      throw new Error('destination is not a valid Stellar public key');
    }

    let destAccount;
    try {
      destAccount = await this.server.loadAccount(destKey);
    } catch (e) {
      if (isProduction(this.cfg)) {
        throw new Error('Destination account does not exist; fund the account before opening a trustline.');
      }
      if (this.cfg.friendbotUrl) {
        await friendbot(destKey);
        destAccount = await this.server.loadAccount(destKey);
      } else {
        throw new Error('Destination account does not exist and friendbot is not configured for this network.');
      }
    }

    const issuer = this.cfg.issuerPublic || (this.cfg.issuerSecret ? loadKeypair(this.cfg.issuerSecret).publicKey() : null);
    if (this.cfg.assetCode === 'XLM' || !issuer) {
      return { accountExists: true, trustlineCreated: false, required: false };
    }

    const line = destAccount.balances.find(
      (b) => b.asset_code === this.cfg.assetCode && b.asset_issuer === issuer
    );
    if (line) return { accountExists: true, trustlineCreated: false, required: true };

    if (!destinationSecret) {
      throw new Error(`Destination account is missing a ${this.cfg.assetCode} trustline; provide destinationSecret to auto-create it.`);
    }

    let destKp;
    try {
      destKp = loadKeypair(destinationSecret);
    } catch (e) {
      throw new Error('destinationSecret is not a valid Stellar secret key');
    }
    if (destKp.publicKey() !== destKey) {
      throw new Error('destinationSecret does not match destination public key');
    }

    const tx = new sdk.TransactionBuilder(destAccount, {
      fee: sdk.BASE_FEE,
      networkPassphrase: this.network,
    })
      .addOperation(sdk.Operation.changeTrust({ asset: getAsset(this.cfg) }))
      .setTimeout(60)
      .build();
    tx.sign(destKp);
    const res = await this.server.submitTransaction(tx);
    return { accountExists: true, trustlineCreated: true, txHash: res.hash };
  }

  /**
   * Settle `amountCents` stablecoins from the distributor to `destination`.
   * Returns tx hash, ledger sequence, latency, and explorer link.
   */
  async settle({ destination, amountCents, memo, destinationSecret }) {
    const cfg = getConfig();
    if (cfg.mode === 'shadow') {
      return {
        hash: `shadow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ledger: 0,
        amount: centsToUnits(amountCents),
        memo: memo || null,
        latencyMs: 0,
        explorer: '',
        simulated: true,
      };
    }

    if (!sdk) throw new Error('Stellar SDK is not installed');
    if (!destination) throw new Error('destination public key is required');
    let destKey;
    try {
      destKey = sdk.StrKey.isValidEd25519PublicKey(destination)
        ? destination
        : sdk.Keypair.fromPublicKey(destination).publicKey();
    } catch (e) {
      throw new Error('destination is not a valid Stellar public key');
    }

    const { signer, account } = await this._loadDistributor();
    await this._ensureTrustline(signer);
    await this._fundIfNeeded(signer.publicKey());
    await this.ensureDestinationTrustline({ destination: destKey, destinationSecret });

    const amount = centsToUnits(amountCents);
    const builder = new sdk.TransactionBuilder(account, {
      fee: sdk.BASE_FEE,
      networkPassphrase: this.network,
    })
      .addOperation(sdk.Operation.payment({
        destination: destKey,
        asset: getAsset(cfg),
        amount,
      }))
      .setTimeout(60);
    if (memo) builder.addMemo(sdk.Memo.text(String(memo).slice(0, 28)));

    const tx = builder.build();
    await signer.signTransaction(tx);

    const start = Date.now();
    const res = await this.server.submitTransaction(tx);
    const latencyMs = Date.now() - start;

    const explorerBase = cfg.network === 'mainnet' || cfg.network === 'public'
      ? 'https://stellar.expert/explorer/public/tx'
      : 'https://stellar.expert/explorer/testnet/tx';

    return {
      hash: res.hash,
      ledger: res.ledger,
      amount,
      memo: memo || null,
      latencyMs,
      explorer: `${explorerBase}/${res.hash}`,
      simulated: false,
    };
  }

  async getBalance(publicKey) {
    if (!sdk) return '0';
    const cfg = getConfig();
    const account = await this.server.loadAccount(publicKey);
    const issuer = cfg.issuerPublic || (cfg.issuerSecret ? loadKeypair(cfg.issuerSecret).publicKey() : null);
    if (cfg.assetCode === 'XLM' || !issuer) {
      const native = account.balances.find((b) => b.asset_type === 'native');
      return native ? native.balance : '0';
    }
    const line = account.balances.find(
      (b) => b.asset_code === cfg.assetCode && b.asset_issuer === issuer
    );
    return line ? line.balance : '0';
  }
}

module.exports = { BlockchainEngine, centsToUnits };

'use strict';

/**
 * Payment Hub connector for the stablecoin / blockchain rail.
 */

const { StablecoinGateway, BlockchainEngine } = require('../stablecoin');
const { getConfig } = require('../stablecoin/config');

class StablecoinConnector {
  static async readiness() {
    const cfg = getConfig();
    const gateway = await StablecoinGateway.readiness().catch(e => ({ ready: false, issues: [e.message] }));
    return {
      ready: cfg.enabled && gateway.ready,
      issues: gateway.issues || [],
      warnings: gateway.blockchain ? gateway.blockchain.warnings : [],
      network: cfg.network,
      assetCode: cfg.assetCode,
    };
  }

  static async transmit(intent) {
    const cfg = getConfig();
    if (cfg.mode === 'shadow') {
      return {
        status: 'settled',
        simulated: true,
        txHash: `shadow-${Date.now()}`,
        ledger: 0,
      };
    }

    const payment = await StablecoinGateway.settleFromIntent(intent);
    return {
      status: 'settled',
      txHash: payment.tx_hash,
      ledger: payment.tx_ledger,
      explorer: payment.tx_explorer,
      latencyMs: payment.latency_ms,
      stablecoinPaymentId: payment.id,
      simulated: payment.tx_hash && payment.tx_hash.startsWith('shadow-'),
    };
  }

  static async status(txHash) {
    if (!txHash) throw new Error('txHash is required');
    const cfg = getConfig();
    if (cfg.mode === 'shadow') return { txHash, status: 'settled', simulated: true };
    const engine = new BlockchainEngine();
    // Horizon tx status can be retrieved by tx hash via /transactions/:hash
    const res = await fetch(`${cfg.horizonUrl}/transactions/${txHash}`);
    if (!res.ok && res.status !== 404) throw new Error(`Horizon lookup failed: ${res.status}`);
    if (res.status === 404) return { txHash, status: 'pending' };
    const body = await res.json();
    return {
      txHash,
      status: body.successful ? 'settled' : 'failed',
      ledger: body.ledger,
      createdAt: body.created_at,
    };
  }
}

module.exports = { StablecoinConnector };

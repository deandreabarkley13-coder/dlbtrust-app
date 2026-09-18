'use strict';

/**
 * Lili Bank as the settlement bank behind the API-gateway clearing rail.
 *
 * Exposes the same `_cfg()` / `_sendPayment()` / `status()` surface as the
 * APISIX/Apigee gateway engines so ApiGatewayClearingEngine can treat Lili as
 * a provider (`API_GATEWAY_PROVIDER=lili`). Money moves through the Lili MCP
 * server (Bill Pay: supplier -> bill -> pay) via LiliMcpEngine; nothing is
 * hand-rolled here.
 *
 * Live only when LILI_CLEARING_LIVE=true AND the Lili MCP OAuth client is
 * configured; otherwise shadow (no MCP call, simulated reference).
 */

const crypto = require('crypto');
const { LiliMcpEngine } = require('./liliMcpEngine');

function txId() { return `LILI-TX-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }

class LiliSettlementBankEngine {
  static _cfg() {
    const env = process.env;
    return {
      provider: 'lili',
      live: String(env.LILI_CLEARING_LIVE || 'false').toLowerCase() === 'true',
      mcpUrl: env.LILI_MCP_URL || 'https://mcp.lili.co/mcp',
      businessUserId: env.LILI_BUSINESS_USER_ID || null,
      sourceRouting: env.LILI_ODFI_ROUTING || null,
      sourceAccount: env.LILI_ODFI_ACCOUNT || null,
      sourceName: env.LILI_ODFI_NAME || 'DLB Trust (Lili Bank)',
    };
  }

  static async _sendPayment({ amount, currency = 'USD', type = 'push', destination = {}, description, reference } = {}) {
    const cfg = this._cfg();
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('amount must be positive'), { status: 400 });
    if (currency !== 'USD') throw Object.assign(new Error('Lili settles USD only'), { status: 400 });
    const routing = destination.routingNumber || destination.routing;
    const account = destination.accountNumber || destination.account;
    if (!routing || !account) throw Object.assign(new Error('destination routingNumber and accountNumber are required'), { status: 400 });

    if (!cfg.live) {
      return {
        transferId: txId(),
        status: 'shadow',
        live: false,
        shadow: true,
        provider: 'lili',
        type,
        amount: n,
        currency,
        reference,
        message: 'LILI_CLEARING_LIVE=false: simulated, no Lili MCP call made',
      };
    }

    const mcpCfg = await LiliMcpEngine.getConfig();
    if (!LiliMcpEngine.isConfigured(mcpCfg)) {
      throw Object.assign(new Error('Lili MCP is not configured (LILI_MCP_ENABLED, LILI_OAUTH_CLIENT_ID, LILI_OAUTH_ACCESS_TOKEN/REFRESH_TOKEN)'), { status: 503 });
    }

    const result = await LiliMcpEngine.payToPayee({
      amount: n,
      recipientName: destination.name || destination.holderName || 'Beneficiary',
      recipientAccount: account,
      recipientRouting: routing,
      recipientBank: destination.bankName || null,
      recipientEmail: destination.email || null,
      businessUserId: cfg.businessUserId || undefined,
      memo: [reference, description].filter(Boolean).join(' ').slice(0, 140),
    });

    if (!result || result.status !== 'api_pending') {
      throw Object.assign(
        new Error(`Lili did not accept the payment: ${(result && result.reason) || 'unknown'}`),
        { status: 502, lili: result || null },
      );
    }

    return {
      transferId: result.externalTxId || result.billId || txId(),
      status: 'originated',
      live: true,
      shadow: false,
      provider: 'lili',
      type,
      amount: n,
      currency,
      reference,
      lili: { billId: result.billId || null, supplierId: result.supplierId || null },
    };
  }

  static async status() {
    const cfg = this._cfg();
    let mcp = { configured: false };
    try { mcp = await LiliMcpEngine.getPublicConfig(); } catch (e) { mcp = { configured: false, error: e.message }; }
    const reachable = Boolean(mcp.configured);
    return {
      engine: 'lili',
      healthy: !cfg.live || reachable,
      mode: cfg.live ? 'live' : 'shadow',
      live: cfg.live,
      apiUrl: cfg.mcpUrl,
      reachable,
      message: cfg.live
        ? (reachable ? 'Lili MCP configured' : `Lili MCP not configured${mcp.error ? `: ${mcp.error}` : ''}`)
        : 'shadow/simulated',
      mcp: {
        enabled: Boolean(mcp.mcpEnabled),
        hasClientId: Boolean(mcp.hasClientId),
        hasToken: Boolean(mcp.hasAccessToken || mcp.hasRefreshToken),
        businessUserId: mcp.businessUserId || null,
        lastRefreshError: mcp.lastRefreshError || null,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = { LiliSettlementBankEngine };

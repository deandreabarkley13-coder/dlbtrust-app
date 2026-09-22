'use strict';

/**
 * Lili Bank as the settlement bank behind the API-gateway clearing rail.
 *
 * Direction: DLB Trust treasury (ODFI, dlb-treasury-management) is the fund
 * source; the trust's Lili business checking account is the CREDIT
 * destination. Lili never originates — it receives.
 *
 *   trust ledger (Dr settlement / Cr treasury cash)
 *     -> NACHA ACH credit (entry 22) via LiliDirectDepositEngine
 *     -> ODFI channel (AS2 partner / MFT / REST / SFTP)
 *     -> Lili (RDFI) account ****last4
 *     -> Lili MCP transaction feed for reconciliation (read-only)
 *
 * Exposes the same `_cfg()` / `_sendPayment()` / `status()` surface as the
 * APISIX/Apigee gateway engines so ApiGatewayClearingEngine can treat Lili as
 * a provider (`API_GATEWAY_PROVIDER=lili`). The destination is fixed to the
 * registered Lili account (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER);
 * any caller-supplied destination that is not that account is rejected.
 *
 * Live only when LILI_CLEARING_LIVE=true; otherwise shadow (no batch, no
 * transmission, simulated reference).
 */

const crypto = require('crypto');
const { LiliMcpEngine } = require('./liliMcpEngine');
const { LiliDirectDepositEngine } = require('./liliDirectDepositEngine');

const DIRECTION = 'treasury_to_lili';

function txId() { return `LILI-TX-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function last4(v) { return v ? String(v).slice(-4) : null; }

class LiliSettlementBankEngine {
  static _cfg() {
    const env = process.env;
    return {
      provider: 'lili',
      direction: DIRECTION,
      live: String(env.LILI_CLEARING_LIVE || 'false').toLowerCase() === 'true',
      mcpUrl: env.LILI_MCP_URL || 'https://mcp.lili.co/mcp',
      businessUserId: env.LILI_BUSINESS_USER_ID || null,
      secCode: ['PPD', 'CCD'].includes(String(env.LILI_CLEARING_SEC_CODE || '').toUpperCase())
        ? String(env.LILI_CLEARING_SEC_CODE).toUpperCase() : 'CCD',
      // Treasury (ODFI) side — the debtor. Named so requestSummary.source reports configured=true.
      sourceRouting: env.ACH_ODFI_ROUTING || env.NACHA_ODFI_ROUTING || env.TRUST_BANK_ROUTING || null,
      sourceAccount: env.CLEARING_FUNDING_OPERATING_ACCOUNT || env.CLEARING_FUNDING_SETTLEMENT_ACCOUNT || null,
      sourceName: env.ACH_ORIGINATOR_NAME || env.ACH_COMPANY_NAME || env.TRUST_NAME || 'DLB Trust',
      gcpProject: env.GCP_PROJECT || env.GOOGLE_CLOUD_PROJECT || null,
    };
  }

  /** The only destination this provider credits: the trust's Lili account. */
  static async defaultDestination() {
    const dest = await LiliDirectDepositEngine.getDestination();
    if (!dest.configured) {
      throw Object.assign(
        new Error('Lili credit destination not configured (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)'),
        { status: 503 },
      );
    }
    return {
      name: dest.accountName,
      bankName: 'Lili',
      routingNumber: dest.routingNumber,
      accountNumber: dest._account,
      accountType: 'checking',
    };
  }

  /**
   * Accept only the registered Lili account. A caller may omit the
   * destination (resolved here) or pass it back; anything else is refused so
   * the gateway can never be used to push treasury funds elsewhere.
   */
  static async _resolveDestination(destination) {
    const lili = await this.defaultDestination();
    if (!destination || (!destination.routingNumber && !destination.routing && !destination.accountNumber && !destination.account)) {
      return lili;
    }
    const routing = String(destination.routingNumber || destination.routing || '');
    const account = String(destination.accountNumber || destination.account || '');
    const sameRouting = routing === String(lili.routingNumber);
    const sameAccount = account === String(lili.accountNumber) || (account.startsWith('****') && last4(account) === last4(lili.accountNumber));
    if (!sameRouting || !sameAccount) {
      throw Object.assign(
        new Error(`Lili provider credits only the registered Lili account (****${last4(lili.accountNumber)}); arbitrary destinations are not accepted`),
        { status: 400 },
      );
    }
    return lili;
  }

  static async _sendPayment({ amount, currency = 'USD', type = 'push', source = null, destination = null, description, reference } = {}) {
    const cfg = this._cfg();
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('amount must be positive'), { status: 400 });
    if (currency !== 'USD') throw Object.assign(new Error('Lili settles USD only'), { status: 400 });

    const dest = await this._resolveDestination(destination);
    const destinationSummary = { name: dest.name, bankName: dest.bankName, routingNumber: dest.routingNumber, accountLast4: last4(dest.accountNumber) };

    if (!cfg.live) {
      return {
        transferId: txId(),
        status: 'shadow',
        live: false,
        shadow: true,
        provider: 'lili',
        direction: DIRECTION,
        type,
        amount: n,
        currency,
        reference,
        destination: destinationSummary,
        message: 'LILI_CLEARING_LIVE=false: simulated, no ACH credit generated or transmitted',
      };
    }

    const odfi = await LiliDirectDepositEngine.odfiStatus();
    if (!odfi.ready) {
      throw Object.assign(
        new Error(`${odfi.blocker || 'No ODFI channel configured'} — cannot originate the treasury -> Lili credit (configure an external AS2 partner / MFT / production partner / ACH_SFTP_URL)`),
        { status: 503 },
      );
    }

    const deposit = await LiliDirectDepositEngine.createDirectDeposit({
      amountCents: Math.round(n * 100),
      memo: [reference, description].filter(Boolean).join(' ').slice(0, 80),
      secCode: cfg.secCode,
      paymentType: 'settlement_funding',
      sourceAccountId: (source && (source.accountId || source.sourceId || source.accountNumber)) || cfg.sourceAccount || null,
      businessUserId: cfg.businessUserId || undefined,
      autoTransmit: true,
      createdBy: 'api_gateway_clearing',
    });

    const status = deposit && deposit.status;
    if (!deposit || !['transmitted', 'awaiting_odfi'].includes(status)) {
      throw Object.assign(
        new Error(`Treasury -> Lili credit was not accepted: ${(deposit && (deposit.error_message || deposit.errorMessage || deposit.status)) || 'unknown'}`),
        { status: 502, lili: deposit || null },
      );
    }

    return {
      transferId: deposit.deposit_id || deposit.depositId || txId(),
      status: status === 'transmitted' ? 'originated' : 'awaiting_odfi',
      live: true,
      shadow: false,
      provider: 'lili',
      direction: DIRECTION,
      type,
      amount: n,
      currency,
      reference,
      destination: destinationSummary,
      lili: {
        depositId: deposit.deposit_id || deposit.depositId || null,
        achBatchId: deposit.ach_batch_id || deposit.achBatchId || null,
        liliPaymentId: deposit.lili_payment_id || deposit.liliPaymentId || null,
        journalEntryId: deposit.journal_entry_id || deposit.journalEntryId || null,
        odfiChannels: odfi.channels,
        odfiLoopback: odfi.loopback,
        reconciliation: 'LiliDirectDepositEngine.reconcile (Lili MCP transaction feed)',
      },
    };
  }

  static async status() {
    const cfg = this._cfg();
    const settle = (p) => Promise.resolve().then(() => p).then((value) => ({ ok: true, value })).catch((e) => ({ ok: false, error: e.message }));
    const [mcp, dest, odfi] = await Promise.all([
      settle(LiliMcpEngine.getPublicConfig()),
      settle(LiliDirectDepositEngine.getDestination()),
      settle(LiliDirectDepositEngine.odfiStatus()),
    ]);

    const destinationConfigured = dest.ok && Boolean(dest.value.configured);
    const odfiReady = odfi.ok && Boolean(odfi.value.ready);
    const mcpConfigured = mcp.ok && Boolean(mcp.value.configured);

    const issues = [];
    if (!destinationConfigured) issues.push(dest.ok ? 'Lili credit destination not configured (LILI_DD_ROUTING_NUMBER / LILI_DD_ACCOUNT_NUMBER)' : `destination: ${dest.error}`);
    if (!odfiReady) issues.push(odfi.ok ? `${odfi.value.blocker || 'No ODFI channel configured'} — no external ODFI to originate the treasury -> Lili credit` : `odfi: ${odfi.error}`);
    if (!mcpConfigured) issues.push(mcp.ok ? 'Lili MCP not configured (reconciliation of the incoming credit unavailable)' : `mcp: ${mcp.error}`);

    const originationReady = destinationConfigured && odfiReady;
    return {
      engine: 'lili',
      direction: DIRECTION,
      healthy: !cfg.live || originationReady,
      mode: cfg.live ? 'live' : 'shadow',
      live: cfg.live,
      apiUrl: cfg.mcpUrl,
      reachable: mcpConfigured,
      message: cfg.live
        ? (originationReady ? 'Treasury -> Lili ACH credit can originate' : issues.join('; '))
        : 'shadow/simulated',
      source: {
        role: 'debtor (ODFI)',
        name: cfg.sourceName,
        routingConfigured: Boolean(cfg.sourceRouting),
        accountConfigured: Boolean(cfg.sourceAccount),
        gcpProject: cfg.gcpProject,
      },
      destination: {
        role: 'creditor (RDFI)',
        bankName: 'Lili',
        configured: destinationConfigured,
        accountName: dest.ok ? dest.value.accountName : null,
        routingNumber: dest.ok ? dest.value.routingNumber : null,
        accountNumberMasked: dest.ok ? dest.value.accountNumberMasked : null,
      },
      odfi: odfi.ok ? odfi.value : { ready: false, channels: [], error: odfi.error },
      secCode: cfg.secCode,
      mcp: {
        role: 'reconciliation (read-only)',
        enabled: mcp.ok && Boolean(mcp.value.mcpEnabled),
        configured: mcpConfigured,
        hasClientId: mcp.ok && Boolean(mcp.value.hasClientId),
        hasToken: mcp.ok && Boolean(mcp.value.hasAccessToken || mcp.value.hasRefreshToken),
        businessUserId: (mcp.ok && mcp.value.businessUserId) || null,
        lastRefreshError: (mcp.ok && mcp.value.lastRefreshError) || null,
      },
      issues,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = { LiliSettlementBankEngine, LILI_CLEARING_DIRECTION: DIRECTION };

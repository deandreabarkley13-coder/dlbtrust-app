'use strict';

/**
 * S2S clearing/settlement engine behind /api/payment-server/v1.
 *
 * clearAndSettle() picks the provider from the registered settlement bank:
 *   lili                     -> LiliSettlementBankEngine._sendPayment
 *                               (NACHA credit, autoTransmit via the ODFI channel)
 *   host_to_host             -> SettlementEngine.createSettlement + executeSettlement
 *                               (HostToHostEngine.executeSettlement)
 *   column | increase | generic -> PartnerBankRails.originate
 *   api_gateway              -> ApiGatewayClearingEngine.clearPayment
 *
 * Every attempt is journaled in settlement_bank_events. Live calls require
 * approvalRef + screeningRef (409 otherwise). A missing ODFI channel for Lili
 * surfaces as 503 with status awaiting_odfi — nothing leaves the platform.
 */

const crypto = require('crypto');
const { SettlementBankRegistry } = require('./settlementBankRegistry');
const { LiliSettlementBankEngine } = require('./liliSettlementBankEngine');
const { LiliDirectDepositEngine } = require('./liliDirectDepositEngine');
const { PartnerBankRails } = require('../rails/partnerBankRails');
const { ApiGatewayClearingEngine } = require('../dapp/apiGatewayClearingEngine');
const { StripePayoutSettlementOriginator } = require('./stripePayoutSettlementOriginator');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
let SettlementEngine;
try { ({ SettlementEngine } = require('../dapp/settlementEngine')); } catch (e) { SettlementEngine = null; }
let HostToHostEngine;
try { ({ HostToHostEngine } = require('../dapp/hostToHostEngine')); } catch (e) { HostToHostEngine = null; }

const STATUSES = ['pending', 'originated', 'awaiting_odfi', 'pending_approval', 'shadow', 'settled', 'reconciled', 'failed', 'rejected'];
const PARTNER_PROVIDERS = ['column', 'increase', 'generic'];

function httpError(message, status) { return Object.assign(new Error(message), { status }); }
function settlementId() { return `SBS-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }

function isLive(provider) {
  const env = process.env;
  switch (provider) {
    case 'lili': return String(env.LILI_CLEARING_LIVE || 'false').toLowerCase() === 'true';
    case 'host_to_host': return true;
    case 'api_gateway': return String(env.LILI_CLEARING_LIVE || env.APIGEE_LIVE || env.APISIX_LIVE || 'false').toLowerCase() === 'true';
    case 'stripe_payout': return StripePayoutSettlementOriginator.getConfig().keyMode === 'live';
    default: return PartnerBankRails.status().ready;
  }
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    settlementId: row.settlement_id,
    bankId: row.bank_id,
    provider: row.provider,
    rail: row.rail,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    status: row.status,
    live: row.live,
    approvalRef: row.approval_ref,
    screeningRef: row.screening_ref,
    reference: row.reference,
    description: row.description,
    providerReference: row.provider_reference,
    providerStatus: row.provider_status,
    error: row.error_message,
    result: row.result || null,
    reconciliation: row.reconciliation || null,
    initiatedBy: row.initiated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class BankSettlementEngine {
  static get STATUSES() { return STATUSES; }

  static async ensureTables() {
    if (!pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settlement_bank_events (
        id SERIAL PRIMARY KEY,
        settlement_id TEXT UNIQUE NOT NULL,
        bank_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        rail TEXT,
        amount_cents BIGINT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        live BOOLEAN NOT NULL DEFAULT FALSE,
        approval_ref TEXT,
        screening_ref TEXT,
        reference TEXT,
        description TEXT,
        provider_reference TEXT,
        provider_status TEXT,
        error_message TEXT,
        result JSONB,
        reconciliation JSONB,
        initiated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS settlement_bank_events_bank_idx ON settlement_bank_events (bank_id, created_at DESC);
    `);
  }

  static async _insert(evt) {
    if (!pool) return;
    await this.ensureTables();
    await pool.query(
      `INSERT INTO settlement_bank_events
         (settlement_id, bank_id, provider, rail, amount_cents, currency, status, live, approval_ref, screening_ref, reference, description, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [evt.settlementId, evt.bankId, evt.provider, evt.rail, evt.amountCents, evt.currency, evt.status, evt.live,
        evt.approvalRef || null, evt.screeningRef || null, evt.reference || null, evt.description || null, evt.initiatedBy || null],
    );
  }

  static async _update(id, { status, providerReference, providerStatus, error, result, reconciliation } = {}) {
    if (!pool) return;
    await pool.query(
      `UPDATE settlement_bank_events SET
         status = COALESCE($2, status),
         provider_reference = COALESCE($3, provider_reference),
         provider_status = COALESCE($4, provider_status),
         error_message = $5,
         result = COALESCE($6::jsonb, result),
         reconciliation = COALESCE($7::jsonb, reconciliation),
         updated_at = NOW()
       WHERE settlement_id = $1`,
      [id, status || null, providerReference || null, providerStatus || null, error || null,
        result === undefined ? null : JSON.stringify(result), reconciliation === undefined ? null : JSON.stringify(reconciliation)],
    );
  }

  static async get(id) {
    if (!pool) throw httpError('settlement_bank_events storage unavailable', 503);
    await this.ensureTables();
    const r = await pool.query('SELECT * FROM settlement_bank_events WHERE settlement_id = $1', [String(id)]);
    return rowToEvent(r.rows[0]);
  }

  static async list({ bankId, limit = 50 } = {}) {
    if (!pool) return [];
    await this.ensureTables();
    const r = bankId
      ? await pool.query('SELECT * FROM settlement_bank_events WHERE bank_id = $1 ORDER BY created_at DESC LIMIT $2', [bankId, limit])
      : await pool.query('SELECT * FROM settlement_bank_events ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map(rowToEvent);
  }

  /** Per-bank readiness: live flag, ready, and the blockers that stop a live settlement. */
  static async readiness(bankId) {
    const bank = await SettlementBankRegistry.resolve(bankId);
    const live = isLive(bank.provider);
    let ready = false;
    let detail = {};
    const blockers = [];
    if (bank.provider === 'lili') {
      const status = await LiliSettlementBankEngine.status();
      ready = Boolean(status.originationReady);
      detail = { mode: status.mode, source: status.source, destination: status.destination, odfi: status.odfi, mcp: status.mcp };
      blockers.push(...(status.issues || []).filter((i) => !/MCP/i.test(i)));
      if (!status.mcp || !status.mcp.configured) blockers.push('Lili MCP not configured — reconciliation of the incoming credit unavailable (origination still allowed)');
    } else if (bank.provider === 'host_to_host') {
      const partner = HostToHostEngine && bank.endpointId ? await HostToHostEngine.getPartner(bank.endpointId).catch(() => null) : null;
      ready = Boolean(partner && partner.enabled);
      detail = { endpointId: bank.endpointId, partner: partner ? { id: partner.partner_id || partner.id, enabled: partner.enabled, messageType: partner.message_type } : null };
      if (!ready) blockers.push(`host-to-host partner ${bank.endpointId || '(none)'} not found or disabled`);
    } else if (PARTNER_PROVIDERS.includes(bank.provider)) {
      const st = PartnerBankRails.status();
      ready = st.ready && st.provider === bank.provider;
      detail = st;
      if (!st.ready) blockers.push(`partner bank not configured (missing ${st.missingConfiguration.join(', ')})`);
      else if (st.provider !== bank.provider) blockers.push(`PARTNER_BANK_PROVIDER=${st.provider} does not match bank provider ${bank.provider}`);
    } else if (bank.provider === 'api_gateway') {
      const r = await ApiGatewayClearingEngine.readiness();
      ready = Boolean(r.ready);
      detail = r;
      if (!r.ready) blockers.push(...(r.blockers || [r.message || 'API gateway not ready']));
    } else if (bank.provider === 'stripe_payout') {
      const st = await StripePayoutSettlementOriginator.status(bank);
      ready = Boolean(st.ready);
      detail = { keyMode: st.keyMode, account: st.account, externalAccount: st.externalAccount, balance: st.balance, destination: st.destination };
      blockers.push(...(st.issues || []));
    }
    return {
      bankId: bank.bankId,
      provider: bank.provider,
      bank: SettlementBankRegistry.publicView(bank),
      live,
      mode: live ? 'live' : 'shadow',
      ready,
      blockers,
      requires: live ? ['approvalRef', 'screeningRef'] : [],
      ...detail,
    };
  }

  static async clearAndSettle({
    bankId,
    amountCents,
    currency = 'USD',
    rail,
    approvalRef,
    screeningRef,
    reference,
    description,
    destination,
    source,
    paymentType = 'settlement_funding',
    flow = 'settlement',
    initiatedBy = 'payment_server',
  } = {}) {
    const bank = await SettlementBankRegistry.resolve(bankId);
    const cents = Number(amountCents);
    if (!Number.isInteger(cents) || cents <= 0) throw httpError('amountCents must be a positive integer', 400);
    if (currency !== 'USD') throw httpError('settlement banks settle USD only', 400);
    if (bank.enabled === false) throw httpError(`settlement bank '${bank.bankId}' is disabled`, 409);

    const live = isLive(bank.provider);
    if (live && !approvalRef) throw httpError('approvalRef (maker/checker record) is required for a live settlement', 409);
    if (live && !screeningRef) throw httpError('screeningRef (compliance screening id) is required for a live settlement', 409);

    if (bank.provider === 'lili') await SettlementBankRegistry.assertLiliDestination(destination);
    const useRail = rail || bank.rail || (bank.provider === 'lili' ? 'ach' : bank.provider);

    const evt = {
      settlementId: settlementId(),
      bankId: bank.bankId,
      provider: bank.provider,
      rail: useRail,
      amountCents: cents,
      currency,
      status: 'pending',
      live,
      approvalRef,
      screeningRef,
      reference: reference || null,
      description: description || null,
      initiatedBy,
    };
    await this._insert(evt);
    const ref = reference || evt.settlementId;

    try {
      let out;
      switch (bank.provider) {
        case 'lili': {
          const r = await LiliSettlementBankEngine._sendPayment({
            amount: cents / 100,
            currency,
            type: 'push',
            source,
            destination: destination || null,
            description,
            reference: ref,
          });
          out = { status: r.status === 'shadow' ? 'shadow' : (['awaiting_odfi', 'pending_approval'].includes(r.status) ? r.status : 'originated'), providerReference: r.transferId || r.depositId || null, providerStatus: r.status, result: r };
          break;
        }
        case 'host_to_host': {
          if (!SettlementEngine) throw httpError('SettlementEngine unavailable', 503);
          const created = await SettlementEngine.createSettlement({
            sourceType: 'payment_server', sourceId: evt.settlementId,
            sourceAccountId: source && (source.accountId || source.sourceId) || undefined,
            rail: 'host_to_host', endpointId: bank.endpointId,
            amount: cents / 100, currency,
            creditorName: bank.accountName || bank.name, creditorAccount: bank._account, creditorRouting: bank.routingNumber, creditorBank: bank.name,
            debtorName: process.env.ACH_ORIGINATOR_NAME || process.env.ACH_COMPANY_NAME || process.env.TRUST_NAME || 'DLB Trust',
            debtorRouting: process.env.ACH_ODFI_ROUTING || null,
            paymentType, description: description || ref,
            config: { approvalRef, screeningRef, reference: ref },
          });
          const r = await SettlementEngine.executeSettlement(created.settlement_id);
          const st = String(r.status || '');
          out = { status: /fail|reject|error/.test(st) ? 'failed' : (/settled|completed|transmitted/.test(st) ? 'settled' : 'originated'), providerReference: r.external_id || r.settlement_id, providerStatus: st, result: r };
          if (out.status === 'failed') throw httpError(r.error_message || `host-to-host settlement ${st}`, 502);
          break;
        }
        case 'column':
        case 'increase':
        case 'generic': {
          if (!live) {
            out = { status: 'shadow', providerReference: null, providerStatus: 'shadow', result: { shadow: true, note: PartnerBankRails.status().note } };
            break;
          }
          const r = await PartnerBankRails.originate(useRail === 'ach' || useRail === 'wire' || useRail === 'rtp' ? useRail : 'ach', {
            amountCents: cents,
            beneficiaryName: bank.accountName || bank.name,
            beneficiaryRouting: bank.routingNumber,
            beneficiaryAccount: bank._account,
            externalAccountId: bank.endpointId || undefined,
            reference: ref,
            description,
            approvalRef,
            screeningRef,
          });
          out = { status: 'originated', providerReference: r.providerReference || r.confirmationNumber || r.fedReference || null, providerStatus: r.providerStatus || 'accepted', result: r };
          break;
        }
        case 'api_gateway': {
          const r = await ApiGatewayClearingEngine.clearPayment({
            rail: 'api_gateway', flow, paymentType,
            amount: cents / 100, currency, reference: ref, description,
            sourceType: 'payment_server', sourceId: evt.settlementId,
            approvalRef, screeningRef, source,
            destination: destination || { name: bank.accountName || bank.name, routingNumber: bank.routingNumber, accountNumber: bank._account },
            initiatedBy,
          });
          out = { status: r.status === 'shadow' || r.shadow ? 'shadow' : (r.status === 'awaiting_odfi' ? 'awaiting_odfi' : 'originated'), providerReference: r.gatewayReference || r.transferId || r.eventId || null, providerStatus: r.status, result: r };
          break;
        }
        case 'stripe_payout': {
          const r = await StripePayoutSettlementOriginator.send(bank, { amountCents: cents, reference: ref, description });
          out = { status: 'originated', providerReference: r.payoutId, providerStatus: r.stripeStatus, result: r };
          break;
        }
        default:
          throw httpError(`unsupported provider ${bank.provider}`, 400);
      }
      await this._update(evt.settlementId, out);
      return { ...evt, ...out, error: null };
    } catch (err) {
      const status = Number(err.status);
      const failedState = status === 503 && bank.provider === 'lili' ? 'awaiting_odfi' : 'failed';
      await this._update(evt.settlementId, { status: failedState, error: err.message });
      err.settlementId = evt.settlementId;
      err.settlementStatus = failedState;
      throw err;
    }
  }

  /** Reconcile a settlement; Lili delegates to LiliDirectDepositEngine.reconcile (MCP feed). */
  static async reconcile(id, { windowDays, businessUserId } = {}) {
    const evt = await this.get(id);
    if (!evt) throw httpError(`settlement ${id} not found`, 404);
    let reconciliation;
    if (evt.provider === 'lili') {
      const depositId = (evt.result && evt.result.lili && evt.result.lili.depositId) || evt.providerReference || null;
      const r = await LiliDirectDepositEngine.reconcile({ windowDays, businessUserId, depositId: depositId || undefined });
      const matched = Boolean(depositId) && (r.deposits || []).some((d) => d.depositId === depositId && d.matched);
      reconciliation = { channel: 'lili_mcp', depositId, matched, at: new Date().toISOString(), summary: r };
      await this._update(id, { status: matched ? 'reconciled' : undefined, reconciliation });
    } else if (evt.provider === 'api_gateway') {
      const eventId = evt.result && evt.result.eventId;
      const r = eventId ? await ApiGatewayClearingEngine.reconcile({ eventId }) : { note: 'no gateway eventId recorded' };
      reconciliation = { channel: 'api_gateway', at: new Date().toISOString(), summary: r };
      await this._update(id, { reconciliation });
    } else {
      reconciliation = { channel: evt.provider, at: new Date().toISOString(), note: 'reconciliation is ledger-side for this provider; status reflects provider acceptance' };
      await this._update(id, { reconciliation });
    }
    return this.get(id);
  }
}

module.exports = { BankSettlementEngine, STATUSES };

'use strict';

/**
 * Intent Routing Engine
 *
 * High-level natural-language / structured intent orchestrator for on/off-ramp
 * and canonical-stablecoin flows. It parses an intent, builds an execution plan
 * across the available engines, and submits the plan through the 1-of-2 Canonical
 * Consensus workflow.
 */

const { query } = require('../bonds/pgPool');

let OnOffRampEngine, TrustMarketEngine, CanonicalMoneyEngine, CrossChainConversionEngine, PairedAssetEngine, SpritzEngine;
try { OnOffRampEngine = require('./onOffRampEngine').OnOffRampEngine; } catch (e) { }
try { TrustMarketEngine = require('./trustMarketEngine').TrustMarketEngine; } catch (e) { }
try { CanonicalMoneyEngine = require('./canonicalMoneyEngine').CanonicalMoneyEngine; } catch (e) { }
try { CrossChainConversionEngine = require('./crossChainConversionEngine').CrossChainConversionEngine; } catch (e) { }
try { PairedAssetEngine = require('./pairedAssetEngine').PairedAssetEngine; } catch (e) { }
try { SpritzEngine = require('../spritz/spritzEngine').SpritzEngine; } catch (e) { }

function canonicalConsensusEngine() {
  try { return require('./canonicalConsensusEngine').CanonicalConsensusEngine; } catch (e) { return null; }
}

function id(prefix = 'INT') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

function normalizeAsset(s) {
  if (!s) return '';
  const t = String(s).toUpperCase().trim();
  if (t.startsWith('USD')) return 'USD';
  return t.replace(/[$,]/g, '');
}

function parseAmount(s) {
  if (typeof s === 'number') return s;
  const m = String(s || '').replace(/[$,\s]/g, '').match(/[\d.]+/);
  return m ? Number(m[0]) : 0;
}

const SOURCE_TYPE_ALIASES = {
  'COUPON': 'bond_interest', 'BOND INTEREST': 'bond_interest', 'FIXED INCOME': 'fixed_income', 'BOND': 'bond',
  'TREASURY': 'treasury', 'TRUST': 'trust', 'CASH': 'cash', 'LEDGER': 'ledger',
  'CORE BANKING': 'core_banking', 'ACCOUNT': 'ledger',
};

function parseSourceType(text) {
  const up = String(text).toUpperCase();
  for (const [alias, type] of Object.entries(SOURCE_TYPE_ALIASES)) {
    if (up.includes(alias)) return type;
  }
  return '';
}

class IntentRoutingEngine {
  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS intent_routing_requests (
        id              TEXT PRIMARY KEY,
        proposal_id     TEXT,
        intent_text     TEXT,
        parsed          JSONB DEFAULT '{}',
        plan            JSONB DEFAULT '{}',
        status          TEXT DEFAULT 'pending',
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  static parseIntent(text, context = {}) {
    const t = String(text || '').toLowerCase();
    const action =
      t.includes('offramp') || t.includes('off-ramp') || t.includes('payout') || t.includes('withdraw') || t.includes('send to bank') ? 'offramp' :
      t.includes('onramp') || t.includes('on-ramp') || t.includes('deposit') || t.includes('fund') || t.includes('buy') ? 'onramp' :
      t.includes('send') || t.includes('transfer') ? 'transfer' :
      t.includes('swap') || t.includes('convert') || t.includes('exchange') ? 'convert' : 'convert';

    const amount = parseAmount(text) || parseAmount(context.amount) || 0;

    // Try to find a target asset
    let targetAsset = context.targetAsset || '';
    const assetMatch = text.match(/(USDC|USDS|DAI|WETH|ETH|BTC|USD|DLBUSD|DLB-PTCUSD|DLB-PRB)\b/gi);
    if (assetMatch && assetMatch.length) {
      const last = assetMatch[assetMatch.length - 1].toUpperCase();
      if (last !== 'USD' || action === 'onramp') targetAsset = last;
      else if (assetMatch.length > 1) targetAsset = assetMatch[assetMatch.length - 2].toUpperCase();
    }
    if (!targetAsset && (action === 'offramp' || action === 'transfer')) targetAsset = 'USD';

    let sourceType = parseSourceType(text) || context.sourceType || '';
    let sourceAsset = context.sourceAsset || '';
    if (!sourceType && !sourceAsset) {
      const firstAsset = assetMatch ? assetMatch[0].toUpperCase() : '';
      if (firstAsset && firstAsset !== targetAsset) {
        if (['DLBUSD', 'DLB-PTCUSD', 'DLB-PRB', 'USDC', 'USDS', 'DAI', 'WETH', 'ETH'].includes(firstAsset)) sourceAsset = firstAsset;
        if (firstAsset === 'USD') sourceAsset = 'USD';
      }
      if (!sourceAsset && !sourceType) {
        sourceType = 'ledger';
      }
    }

    const recipient = text.match(/0x[a-fA-F0-9]{40}/)?.[0] || context.recipient || '';

    const parsed = { action, amount, sourceType, sourceAsset, targetAsset, recipient, raw: text };
    if (context.sourceAccountId) parsed.sourceAccountId = context.sourceAccountId;
    if (context.rail) parsed.rail = context.rail;
    return parsed;
  }

  static _stepStatus(step) {
    if (step.engine === 'direct_transfer') return 'ready';
    if (!step.quote) return 'unknown';
    if (step.quote.error) return 'error';
    if (step.quote.status) return step.quote.status;
    if (step.quote.recommendation && step.quote.routes) {
      const route = step.quote.routes.find(r => r.status === 'ready' || r.status === 'awaiting_buyer');
      return route ? route.status : 'needs_setup';
    }
    if (step.quote.recommended && step.quote.recommended.status) return step.quote.recommended.status;
    return 'needs_setup';
  }

  static _stepIssues(step) {
    if (step.engine === 'direct_transfer') return [];
    if (!step.quote) return ['No quote available'];
    if (step.quote.issues) return step.quote.issues;
    if (step.quote.error) return [step.quote.error];
    if (step.quote.recommended && step.quote.recommended.issues) return step.quote.recommended.issues;
    return [];
  }

  static async plan(parsed) {
    const { action, amount, sourceType, sourceAsset, targetAsset, sourceAccountId, recipient } = parsed;
    const plan = { steps: [], bestStep: null, status: 'ready', issues: [], instructions: '' };

    const addStep = (step) => {
      step.status = this._stepStatus(step);
      step.issues = this._stepIssues(step);
      plan.steps.push(step);
    };

    if (action === 'onramp') {
      const quote = await OnOffRampEngine.quote({ direction: 'onramp', sourceAsset: sourceAsset || 'USD', targetAsset, amount: String(amount), sourceAccountId }).catch(e => ({ error: e.message }));
      addStep({ engine: 'on_off_ramp', direction: 'onramp', quote });
    }

    else if (action === 'offramp') {
      const canonicalAsset = sourceAsset || 'USDC';
      const quote = await OnOffRampEngine.quote({ direction: 'offramp', sourceAsset: canonicalAsset, targetAsset: 'USD', amount: String(amount) }).catch(e => ({ error: e.message }));
      addStep({ engine: 'on_off_ramp', direction: 'offramp', quote });
    }

    else if (action === 'transfer') {
      if (!recipient) { plan.status = 'needs_input'; plan.issues.push('Recipient address required for transfer intent'); }
      else addStep({ engine: 'direct_transfer', asset: targetAsset || sourceAsset, amount: String(amount), recipient });
    }

    else { // convert
      const trustToken = sourceAsset || (sourceType === 'fixed_income' ? 'DLB-PTCUSD' : 'DLBUSD');
      const canonical = targetAsset || 'USDC';

      if (sourceType && sourceType !== 'ledger' && CanonicalMoneyEngine && !sourceAsset) {
        const quote = await CanonicalMoneyEngine.quote({ sourceType, amount: String(amount), targetAsset: canonical, sourceAccountId }).catch(() => null);
        if (quote) addStep({ engine: 'canonical_money', quote });
      }

      if (TrustMarketEngine) {
        const quote = await TrustMarketEngine.quote({ trustToken, pairedAsset: canonical, amount: String(amount), reserveModule: sourceType }).catch(e => ({ status: 'error', issues: [e.message] }));
        addStep({ engine: 'trust_market', quote });
      }

      if (CrossChainConversionEngine) {
        const quote = await CrossChainConversionEngine.quote({ sourceAsset: trustToken, targetAsset: canonical, amount: String(amount), sourceType }).catch(e => ({ status: 'error', issues: [e.message] }));
        addStep({ engine: 'cross_chain', quote });
      }

      if (OnOffRampEngine) {
        const quote = await OnOffRampEngine.quote({ direction: 'exchange', sourceAsset: trustToken, targetAsset: canonical, amount: String(amount), sourceType, sourceAccountId }).catch(e => ({ error: e.message }));
        addStep({ engine: 'on_off_ramp', direction: 'exchange', quote });
      }

      const ready = plan.steps.find(s => ['ready', 'ready_to_list', 'awaiting_buyer', 'awaiting_onramp', 'awaiting_funds'].includes(s.status));
      if (ready) plan.bestStep = ready;
    }

    if (!plan.bestStep) {
      plan.status = 'needs_setup';
      plan.steps.forEach(s => { if (s.issues && s.issues.length) plan.issues.push(...s.issues); });
      if (!plan.issues.length) plan.issues.push('No ready route found');
    }

    plan.instructions = plan.bestStep
      ? `Best route: ${plan.bestStep.engine}${plan.bestStep.direction ? ' (' + plan.bestStep.direction + ')' : ''}. Propose to route through Canonical Consensus.`
      : 'No ready route found. Review the issues and re-plan after resolving gas, liquidity, or configuration blockers.';

    return plan;
  }

  static async quote({ intentText, context = {} }) {
    const parsed = this.parseIntent(intentText, context);
    if (!parsed.amount) throw new Error('Could not parse amount from intent');
    const plan = await this.plan(parsed);
    return { intentText, parsed, plan };
  }

  static async propose({ intentText, context = {}, createdBy }) {
    const { parsed, plan } = await this.quote({ intentText, context });
    const CCE = canonicalConsensusEngine();
    if (!CCE) throw new Error('CanonicalConsensusEngine not available');
    await this.ensureTables();
    const requestId = id();
    const title = `${parsed.action}: ${parsed.amount} ${parsed.sourceAsset || parsed.sourceType || ''} -> ${parsed.targetAsset || 'USD'}`;
    const proposal = await CCE.createProposal({
      category: 'intent',
      title,
      description: `Intent routing: ${intentText}`,
      payload: { requestId, intentText, parsed, plan, context },
      createdBy,
    });
    await query(
      `INSERT INTO intent_routing_requests (id, proposal_id, intent_text, parsed, plan, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [requestId, proposal.id, intentText, safeJson(parsed), safeJson(plan), 'pending', createdBy || 'operator']
    );
    return { requestId, proposalId: proposal.id, parsed, plan, proposal };
  }

  static async listRequests({ limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    const res = await query(
      `SELECT * FROM intent_routing_requests ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [Number(limit), Number(offset)]
    );
    return res.rows.map(r => ({
      ...r,
      parsed: typeof r.parsed === 'string' ? JSON.parse(r.parsed) : r.parsed,
      plan: typeof r.plan === 'string' ? JSON.parse(r.plan) : r.plan,
    }));
  }

  static async getRequest(id) {
    await this.ensureTables();
    const res = await query('SELECT * FROM intent_routing_requests WHERE id = $1', [id]);
    if (!res.rows.length) throw new Error('Intent request not found');
    const r = res.rows[0];
    return { ...r, parsed: JSON.parse(r.parsed || '{}'), plan: JSON.parse(r.plan || '{}') };
  }

  static async _execute(proposal) {
    const { payload } = proposal;
    const { parsed, plan, requestId } = payload;
    if (!plan || !plan.bestStep) throw new Error('No executable plan in intent proposal');
    const step = plan.bestStep;
    let result = null;

    if (step.engine === 'on_off_ramp') {
      const subPayload = { ...parsed, provider: step.quote?.recommended?.provider || step.quote?.routes?.[0]?.provider };
      if (!subPayload.provider) throw new Error('No ramp provider selected');
      result = await OnOffRampEngine._execute({ payload: subPayload });
    }
    else if (step.engine === 'trust_market') {
      result = await TrustMarketEngine.createOffer({
        trustToken: parsed.sourceAsset || 'DLB-PTCUSD',
        pairedAsset: parsed.targetAsset || 'USDC',
        amount: String(parsed.amount),
        reserveModule: parsed.sourceType,
        recipient: parsed.recipient,
      });
    }
    else if (step.engine === 'canonical_money') {
      result = await CanonicalMoneyEngine._execute({ payload: { requestId, route: step.quote, ...parsed, amount: String(parsed.amount) } });
    }
    else if (step.engine === 'cross_chain') {
      const routeName = step.quote?.recommendation;
      const route = (step.quote?.routes || []).find(r => r.name === routeName) || step.quote?.routes?.[0];
      if (!routeName) throw new Error('No cross-chain route recommendation');
      result = await CrossChainConversionEngine._execute({ payload: { requestId, routeName, route, ...parsed, amount: String(parsed.amount) } });
    }
    else if (step.engine === 'direct_transfer') {
      result = { status: 'manual_step', note: `Transfer ${parsed.amount} ${parsed.sourceAsset || parsed.targetAsset} to ${parsed.recipient} using Wallet/Smart Account engine.` };
    }
    else {
      throw new Error(`Engine ${step.engine} not implemented in intent routing`);
    }

    await query(`UPDATE intent_routing_requests SET status = 'executed', plan = $1, updated_at = NOW() WHERE id = $2`, [safeJson({ ...plan, result }), requestId]);
    return { requestId, status: 'executed', step, result };
  }
}

module.exports = { IntentRoutingEngine };

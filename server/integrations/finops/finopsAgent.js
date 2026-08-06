'use strict';

const pool = require('../bonds/pgPool');
const { StablecoinDexEngine } = require('../dapp/stablecoinDexEngine');
const { WalletEngine } = require('../dapp/walletEngine');
const { MasterWalletEngine } = require('../dapp/masterWalletEngine');
const { PayoutCenterEngine } = require('../dapp/payoutCenterEngine');
const { BondTrustReconciliation } = require('../bonds/bondTrustReconciliation');
const { LiveBondEngine } = require('../bonds/liveEngine');
const { DappEngine } = require('../dapp/dappEngine');

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS finops_approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  intent TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

class FinOpsAgent {
  static async ensureTable() {
    await pool.query(TABLES_SQL);
  }

  static id(prefix = 'FIA') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  static normalizeAmount(text) {
    const m = String(text).match(/(?:\$?\s*)([0-9,]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  }

  static parseCommand(text) {
    const t = String(text).toLowerCase();
    const amount = this.normalizeAmount(text);

    // Convert fixed income
    const convertMatch = t.match(/(?:convert|swap|change|turn)\s+(?:\$?\s*([0-9,]+(?:\.[0-9]+)?)\s+)?(?:dlb-prb|bond|fixed income|fixed-income)?\s*(?:principal|interest|accrued)?\s*(?:to|into)\s+(dai|usds|usdc|weth|eth)/);
    if (convertMatch || (t.includes('convert') && (t.includes('interest') || t.includes('principal')) && /dai|usds|usdc|weth|eth/.test(t))) {
      const asset = (convertMatch && convertMatch[2]) ? convertMatch[2].toUpperCase() : (text.match(/dai|usds|usdc|weth|eth/i)[0].toUpperCase());
      const source = /principal/.test(t) ? 'principal' : 'interest';
      const bondName = 'DLB-PRB';
      return { intent: 'convertFixedIncome', params: { bondName, source, amount, targetAsset: asset, reconcile: /reconcile|sync/.test(t) } };
    }

    // Payout / send
    const sendMatch = t.match(/(?:send|pay|transfer)\s+(?:\$?\s*([0-9,]+(?:\.[0-9]+)?)\s+)?(\w+)\s+(?:to|into)\s+(0x[a-f0-9]{40})/i);
    if (sendMatch || (t.includes('send') && t.includes('0x'))) {
      const asset = sendMatch ? sendMatch[2].toUpperCase() : (text.match(/\b(dai|usds|usdc|weth|eth|sit)\b/i)?.[0]?.toUpperCase() || 'SIT');
      const toAddress = (text.match(/0x[a-f0-9]{40}/i) || [])[0];
      return { intent: 'externalSend', params: { amount, asset, toAddress, from: 'distribution' } };
    }

    // Reconcile
    if (/reconcile|sync/.test(t) && /bond|dlb-prb|fixed income/.test(t)) {
      return { intent: 'reconcileBond', params: { bondName: 'DLB-PRB' } };
    }

    // Show data
    if (/source of funds|trust account|treasury|accounts/.test(t)) return { intent: 'showSourceOfFunds', params: {} };
    if (/wallet|balance/.test(t)) return { intent: 'showWallets', params: {} };
    if (/bond|dlb-prb|fixed income/.test(t)) return { intent: 'showBonds', params: {} };
    if (/crm|contact|beneficiary|trustee/.test(t)) return { intent: 'showCrm', params: {} };

    return { intent: 'unknown', params: { text } };
  }

  static summarize(intent, params) {
    if (intent === 'convertFixedIncome') return `Convert ${params.amount ? '$' + params.amount : 'all'} of DLB-PRB ${params.source} to ${params.targetAsset}${params.reconcile ? ' and reconcile trust accounts' : ''}`;
    if (intent === 'externalSend') return `Send ${params.amount ? '$' + params.amount + ' ' : ''}${params.asset} to ${params.toAddress}${params.from ? ' from ' + params.from + ' wallet' : ''}`;
    if (intent === 'reconcileBond') return `Reconcile DLB-PRB trust accounts`;
    if (intent === 'showSourceOfFunds') return 'Show source-of-funds / trust account balances';
    if (intent === 'showWallets') return 'Show wallet balances';
    if (intent === 'showBonds') return 'Show DLB-PRB fixed-income metrics';
    if (intent === 'showCrm') return 'Show CRM contacts / beneficiaries';
    return 'I did not understand. Try: "convert $0.01 DLB-PRB interest to DAI" or "show wallet balances".';
  }

  static async resolveWallet(fromRef, asset) {
    if (!fromRef) {
      const dist = await MasterWalletEngine.getDistributionWallet();
      return dist;
    }
    const ref = String(fromRef).toLowerCase();
    if (ref.startsWith('0x')) {
      const byAddr = await WalletEngine.getWalletByAddress(ref);
      if (byAddr) return byAddr;
    }
    const master = await MasterWalletEngine.getMasterWallet(ref);
    if (master) return master;
    const bySub = await WalletEngine.getWalletBySubtype(ref);
    return bySub;
  }

  static async executeRead(intent) {
    if (intent === 'showSourceOfFunds') {
      const rows = await DappEngine.listSourceBalances();
      return { balances: rows };
    }
    if (intent === 'showWallets') {
      const wallets = await WalletEngine.listWallets ? await WalletEngine.listWallets() : [];
      return { wallets };
    }
    if (intent === 'showBonds') {
      const metrics = await LiveBondEngine.getBondLiveMetrics(1);
      return { bond: metrics };
    }
    if (intent === 'showCrm') {
      const rows = await pool.query('SELECT id, first_name, last_name, email, role, wallet_address FROM contacts ORDER BY created_at DESC LIMIT 50');
      return { contacts: rows.rows };
    }
    throw new Error(`Read intent ${intent} not implemented`);
  }

  static async executeMutate(intent, params) {
    if (intent === 'convertFixedIncome') {
      const bondRes = await pool.query('SELECT id FROM bonds WHERE bond_name = $1 LIMIT 1', [params.bondName || 'DLB-PRB']);
      if (!bondRes.rows.length) throw new Error('Bond not found');
      const bondId = bondRes.rows[0].id;

      if (params.reconcile) {
        await BondTrustReconciliation.sync(bondId);
      }

      const sourceType = params.source === 'principal' ? 'bond' : 'bond_interest';
      const metrics = await LiveBondEngine.getBondLiveMetrics(bondId);
      const max = params.source === 'principal' ? metrics.principal_balance : metrics.accrued_interest_total;
      const amount = params.amount ? Math.min(params.amount, max) : max;
      if (!amount || amount <= 0) throw new Error('No balance available to convert');

      const wallet = await MasterWalletEngine.getDistributionWallet();
      const result = await StablecoinDexEngine.depositAndSwap({
        sourceType,
        sourceAccountId: bondId,
        amount,
        targetAsset: params.targetAsset || 'DAI',
        recipient: wallet ? wallet.address : undefined,
      });

      if (result.amountOut && wallet && wallet.id) {
        await WalletEngine.credit(wallet.id, result.actualTargetAsset || params.targetAsset, result.amountOut, {
          memo: `FinOps conversion: ${params.bondName} ${params.source} -> ${params.targetAsset}`,
          operation_id: result.operationId,
        });
      }

      return { operationId: result.operationId, amountIn: amount, amountOut: result.amountOut, asset: result.actualTargetAsset || params.targetAsset, txHash: result.mintTxHash };
    }

    if (intent === 'externalSend') {
      if (!params.toAddress || !params.amount) throw new Error('Address and amount required');
      const wallet = await this.resolveWallet(params.from, params.asset);
      if (!wallet || !wallet.id) throw new Error('Source wallet not found');
      const result = await WalletEngine.externalSend({
        fromWalletId: wallet.id,
        toAddress: params.toAddress,
        amount: params.amount,
        asset: params.asset,
        memo: params.memo || 'FinOps payout',
      });
      return result;
    }

    if (intent === 'reconcileBond') {
      const bondRes = await pool.query('SELECT id FROM bonds WHERE bond_name = $1 LIMIT 1', [params.bondName || 'DLB-PRB']);
      if (!bondRes.rows.length) throw new Error('Bond not found');
      return await BondTrustReconciliation.sync(bondRes.rows[0].id);
    }

    throw new Error(`Mutating intent ${intent} not implemented`);
  }

  static async process({ command, userId }) {
    await this.ensureTable();
    const parsed = this.parseCommand(command);
    const summary = this.summarize(parsed.intent, parsed.params);

    const readOnly = ['showSourceOfFunds', 'showWallets', 'showBonds', 'showCrm'].includes(parsed.intent);
    if (parsed.intent === 'unknown') {
      return { type: 'message', summary, intent: 'unknown' };
    }

    if (readOnly) {
      const data = await this.executeRead(parsed.intent);
      return { type: 'data', intent: parsed.intent, summary, data };
    }

    const id = this.id();
    await pool.query(
      'INSERT INTO finops_approvals (id, user_id, intent, params, summary, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, userId || '', parsed.intent, JSON.stringify(parsed.params || {}), summary, 'pending']
    );
    return { type: 'approval', approvalId: id, intent: parsed.intent, summary, requiresApproval: true };
  }

  static async listPending({ userId, limit = 20 } = {}) {
    await this.ensureTable();
    const res = await pool.query(
      'SELECT * FROM finops_approvals WHERE status = $1 ORDER BY created_at DESC LIMIT $2',
      ['pending', limit]
    );
    return res.rows;
  }

  static async execute(approvalId, { userId, approved, reason = '' } = {}) {
    await this.ensureTable();
    const res = await pool.query('SELECT * FROM finops_approvals WHERE id = $1 FOR UPDATE', [approvalId]);
    if (!res.rows.length) throw new Error('Approval not found');
    const row = res.rows[0];
    if (row.status !== 'pending') throw new Error(`Approval already ${row.status}`);

    if (!approved) {
      await pool.query('UPDATE finops_approvals SET status = $1, result = $2, updated_at = NOW() WHERE id = $3', ['rejected', JSON.stringify({ reason, rejectedBy: userId }), approvalId]);
      return { status: 'rejected', approvalId };
    }

    try {
      const result = await this.executeMutate(row.intent, row.params);
      await pool.query('UPDATE finops_approvals SET status = $1, result = $2, updated_at = NOW() WHERE id = $3', ['approved', JSON.stringify({ executedBy: userId, result }), approvalId]);
      return { status: 'approved', approvalId, result };
    } catch (err) {
      await pool.query('UPDATE finops_approvals SET status = $1, result = $2, updated_at = NOW() WHERE id = $3', ['failed', JSON.stringify({ error: err.message, failedBy: userId }), approvalId]);
      throw err;
    }
  }
}

module.exports = { FinOpsAgent };

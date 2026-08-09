'use strict';

const fs = require('fs');
const path = require('path');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { CanonicalMoneyEngine } = require('./canonicalMoneyEngine');

function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) return process.env.PERSISTENT_DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

function statePath() { return path.join(dataDir(), 'holding-management-state.json'); }

function ensureDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureDir();
  try { if (fs.existsSync(statePath())) return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (e) { console.warn('[HoldingManagementEngine] load state failed:', e.message); }
  return { holdings: [] };
}

function saveState(state) {
  ensureDir();
  try { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); } catch (e) { console.warn('[HoldingManagementEngine] save state failed:', e.message); }
}

function generateId(prefix = 'HL') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

class HoldingManagementEngine {
  static listHoldings({ status, limit = 100 } = {}) {
    const state = loadState();
    let holdings = state.holdings || [];
    if (status) holdings = holdings.filter(h => h.status === status);
    return holdings.slice(0, Number(limit) || 100);
  }

  static getHolding(holdingId) {
    const state = loadState();
    return (state.holdings || []).find(h => h.id === holdingId) || null;
  }

  static async createHolding({ name, sourceType, sourceAccountId, amount, targetAsset = 'USDC', createdBy = 'operator' } = {}) {
    if (!name || !sourceType || !sourceAccountId || !amount) throw new Error('name, sourceType, sourceAccountId and amount required');
    const amountNum = round2(amount);
    if (amountNum <= 0) throw new Error('amount must be positive');

    const sourceAccount = await TrustAccountingEngine.getAccount(sourceAccountId);
    if (!sourceAccount) throw new Error(`Source account not found: ${sourceAccountId}`);
    const sourceBalance = round2(sourceAccount.balance || 0);
    if (sourceBalance < amountNum) throw new Error(`Insufficient balance in ${sourceAccountId}: ${sourceBalance} < ${amountNum}`);

    const id = generateId('HL');
    const accountCode = `HLD-${Date.now()}`;

    await TrustAccountingEngine.createAccount({
      accountCode,
      accountName: `Holding: ${name}`,
      accountType: 'asset',
      subType: 'holding',
      description: `Canonical holding managed account for ${id}`,
    });

    const journal = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `Fund holding ${id} from ${sourceType}:${sourceAccountId}`,
      referenceType: 'holding',
      referenceId: id,
      postedBy: createdBy,
      postToFineract: false,
      lines: [
        { accountCode, debitAmount: amountNum, creditAmount: 0, memo: 'Hold funds for canonical conversion' },
        { accountCode: sourceAccountId, debitAmount: 0, creditAmount: amountNum, memo: 'Move funds to canonical holding' },
      ],
    });

    const holding = {
      id,
      name,
      accountCode,
      sourceType,
      sourceAccountId,
      amount: amountNum,
      targetAsset: targetAsset.toUpperCase(),
      status: 'held',
      canonicalRequestId: null,
      canonicalProposalId: null,
      canonicalAsset: null,
      canonicalAmount: null,
      canonicalTxHash: null,
      journalEntryId: journal.entry_id,
      createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const state = loadState();
    state.holdings = [holding, ...(state.holdings || [])];
    saveState(state);
    return holding;
  }

  static async canonizeHolding({ holdingId, createdBy = 'operator' } = {}) {
    if (!holdingId) throw new Error('holdingId required');
    const state = loadState();
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) throw new Error(`Holding not found: ${holdingId}`);
    if (holding.status !== 'held' && holding.status !== 'canonicalizing') throw new Error(`Holding status ${holding.status} cannot be canonized`);

    const proposal = await CanonicalMoneyEngine.propose({
      sourceType: 'trust',
      sourceAccountId: holding.accountCode,
      amount: String(holding.amount),
      targetAsset: holding.targetAsset,
      title: `Canonize holding ${holding.id}`,
      createdBy,
    });

    holding.status = 'canonicalizing';
    holding.canonicalRequestId = proposal.requestId;
    holding.canonicalProposalId = proposal.proposalId;
    holding.updatedAt = new Date().toISOString();
    saveState(state);
    return { holding, proposal };
  }

  static async syncHoldingStatus(holdingId) {
    const state = loadState();
    const holding = (state.holdings || []).find(h => h.id === holdingId);
    if (!holding) throw new Error(`Holding not found: ${holdingId}`);
    if (!holding.canonicalRequestId) return holding;

    const requests = await CanonicalMoneyEngine.listRequests({ limit: 1000 });
    const req = (requests || []).find(r => r.id === holding.canonicalRequestId);
    if (!req) return holding;

    if (req.status === 'completed') {
      const result = typeof req.result === 'string' ? JSON.parse(req.result) : (req.result || {});
      holding.status = 'canonical_ready';
      holding.canonicalAsset = result.actualTargetAsset || result.targetAsset || holding.targetAsset;
      holding.canonicalAmount = result.actualAmountOut || result.amountOut || result.amount || holding.amount;
      holding.canonicalTxHash = result.swapTxHash || result.mintTxHash || result.txHash || null;
    } else if (req.status === 'failed') {
      holding.status = 'failed';
    } else {
      holding.status = 'canonicalizing';
    }
    holding.updatedAt = new Date().toISOString();
    saveState(state);
    return holding;
  }

  static async getHoldingDetail(holdingId) {
    const holding = this.getHolding(holdingId);
    if (!holding) return null;
    if (holding.canonicalRequestId) return this.syncHoldingStatus(holdingId);
    return holding;
  }

  static async listSourceAccounts() {
    const accounts = await TrustAccountingEngine.listAccounts({ isActive: true });
    return accounts.filter(a => ['asset', 'liability', 'equity'].includes(a.account_type));
  }
}

module.exports = { HoldingManagementEngine };

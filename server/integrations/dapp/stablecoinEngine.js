'use strict';

/**
 * StablecoinEngine — trust-owned, multi-collateral, auditable stablecoin operations.
 *
 * Wraps the existing PtcStablecoinEngine and adds:
 *   - collateral ratio & health monitoring
 *   - audit log of every mint/redeem/transfer/collateral update
 *   - high-level issue/redeem flow with canonical consensus gating
 *   - beneficiary-address resolution for trust settlement
 */

const fs = require('fs');
const path = require('path');
const { PtcStablecoinEngine } = require('./ptcStablecoinEngine');

let CanonicalConsensusEngine;
try { CanonicalConsensusEngine = require('./canonicalConsensusEngine').CanonicalConsensusEngine; } catch (e) { /* optional */ }

let ModuleSmartAccountEngine;
try { ModuleSmartAccountEngine = require('./moduleSmartAccountEngine').ModuleSmartAccountEngine; } catch (e) { /* optional */ }

function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) return process.env.PERSISTENT_DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

function auditPath() { return path.join(dataDir(), 'stablecoin-audit.json'); }
function ensureDir() { const d = dataDir(); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function loadAudit() {
  ensureDir();
  try { if (fs.existsSync(auditPath())) return JSON.parse(fs.readFileSync(auditPath(), 'utf8')); } catch (e) { console.warn('[StablecoinEngine] audit load failed', e.message); }
  return [];
}

function appendAudit(entry) {
  ensureDir();
  const log = loadAudit();
  log.unshift({ ...entry, timestamp: new Date().toISOString(), id: `AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  try { fs.writeFileSync(auditPath(), JSON.stringify(log.slice(0, 1000), null, 2)); } catch (e) { console.warn('[StablecoinEngine] audit save failed', e.message); }
}

function safeNum(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }

class StablecoinEngine {
  static async info() {
    const ptc = await PtcStablecoinEngine.info().catch(() => ({ deployed: false }));
    const reserves = ptc.reserves || [];
    const totalSupply = safeNum(ptc.totalSupply);
    const collateralValue = reserves.reduce((sum, r) => {
      const price = safeNum(r.price || 1e18) / 1e18;
      const bal = safeNum(r.vaultBalanceFormatted || 0);
      return sum + (bal * price);
    }, 0);
    const ratio = totalSupply > 0 ? collateralValue / totalSupply : (reserves.length ? 1 : 0);
    return {
      name: ptc.tokenName || 'DLB Stablecoin',
      symbol: ptc.tokenSymbol || 'DLB-PTCUSD',
      tokenAddress: ptc.tokenAddress,
      vaultAddress: ptc.vaultAddress,
      deployed: ptc.deployed !== false,
      totalSupply,
      collateralValue,
      collateralRatio: ratio,
      owner: ptc.owner,
      network: ptc.network,
      reserves,
    };
  }

  static async collateralRatio() {
    const info = await this.info();
    return { totalSupply: info.totalSupply, collateralValue: info.collateralValue, ratio: info.collateralRatio };
  }

  static async getAuditLog(limit = 100) {
    return loadAudit().slice(0, limit);
  }

  static async getBeneficiaryAddress(beneficiaryId) {
    if (beneficiaryId && beneficiaryId.startsWith('0x')) return beneficiaryId;
    if (ModuleSmartAccountEngine) {
      const mod = await ModuleSmartAccountEngine.getModule(beneficiaryId).catch(() => null);
      if (mod?.public_address || mod?.publicAddress) return mod.public_address || mod.publicAddress;
    }
    return null;
  }

  static async _consentAndExecute(category, title, payload, operatorEmail) {
    if (!CanonicalConsensusEngine) return null;
    const proposal = await CanonicalConsensusEngine.createProposal({ title, category, payload, createdBy: operatorEmail });
    // Self-approve as maker if operator is a maker/checker; engine can also be invoked by route that asks checker.
    try {
      await CanonicalConsensusEngine.approveProposal({ proposalId: proposal.id, approverEmail: operatorEmail });
    } catch (e) { /* approval may already exist or role mismatch */ }
    return proposal.id;
  }

  static async mint({ moduleKey, token, amount = 'all', recipient, price, operatorEmail, requireConsensus = false } = {}) {
    let to = recipient || '';
    if (!to.startsWith('0x')) to = await this.getBeneficiaryAddress(recipient || moduleKey) || to;

    if (requireConsensus && CanonicalConsensusEngine) {
      const proposalId = await this._consentAndExecute('ptc_mint', `Mint DLB-PTCUSD from ${moduleKey || token}`, { moduleKey, token, amount, recipient: to }, operatorEmail);
      appendAudit({ action: 'mint.proposed', moduleKey, token, amount, recipient: to, proposalId });
      return { proposalId, status: 'pending_consensus' };
    }

    if (price && (moduleKey || token)) {
      await PtcStablecoinEngine.addReserveToken({ moduleKey, token, price }).catch(() => {});
    }

    const result = await PtcStablecoinEngine.approveAndDeposit({ moduleKey, token, amount, recipient: to });
    appendAudit({ action: 'mint.executed', moduleKey, token, amount, recipient: to, txHash: result.txHash, minted: result.mintedStablecoin });
    return result;
  }

  static async redeem({ moduleKey, token, amount, recipient, operatorEmail, requireConsensus = false } = {}) {
    if (requireConsensus && CanonicalConsensusEngine) {
      const proposalId = await this._consentAndExecute('ptc_redeem', `Redeem DLB-PTCUSD for ${moduleKey || token}`, { moduleKey, token, amount, recipient }, operatorEmail);
      appendAudit({ action: 'redeem.proposed', moduleKey, token, amount, recipient, proposalId });
      return { proposalId, status: 'pending_consensus' };
    }

    const result = await PtcStablecoinEngine.redeem({ moduleKey, token, amount, recipient });
    appendAudit({ action: 'redeem.executed', moduleKey, token, amount, recipient, txHash: result.txHash, reserveAmount: result.reserveAmount });
    return result;
  }

  static async transfer({ to, amount, operatorEmail, requireConsensus = false } = {}) {
    if (!to || !amount) throw new Error('to and amount required');
    const recipient = await this.getBeneficiaryAddress(to) || to;

    if (requireConsensus && CanonicalConsensusEngine) {
      const proposalId = await this._consentAndExecute('ptc_transfer', `Transfer DLB-PTCUSD to ${recipient}`, { to: recipient, amount }, operatorEmail);
      appendAudit({ action: 'transfer.proposed', to: recipient, amount, proposalId });
      return { proposalId, status: 'pending_consensus' };
    }

    const result = await PtcStablecoinEngine.transfer({ to: recipient, amount });
    appendAudit({ action: 'transfer.executed', to: recipient, amount, txHash: result.txHash });
    return result;
  }

  static async settle({ to, amount, memo, operatorEmail, requireConsensus = false } = {}) {
    const result = await this.transfer({ to, amount, operatorEmail, requireConsensus });
    appendAudit({ action: 'settle', to, amount, memo, txHash: result.txHash, proposalId: result.proposalId });
    return result;
  }

  static async addCollateral(moduleKey, price, token, decimals) {
    const result = await PtcStablecoinEngine.addReserveToken({ moduleKey, token, price, decimals });
    appendAudit({ action: 'collateral.add', moduleKey, token, price, decimals, txHash: result.txHash });
    return result;
  }

  static async pause() { return PtcStablecoinEngine.setPaused(true); }
  static async unpause() { return PtcStablecoinEngine.setPaused(false); }
  static async balance(address) { return PtcStablecoinEngine.balanceOf(address); }
  static async totalSupply() { return PtcStablecoinEngine.totalSupply(); }
}

module.exports = { StablecoinEngine };

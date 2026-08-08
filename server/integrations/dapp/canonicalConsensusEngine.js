'use strict';

/**
 * Canonical Consensus Engine
 *
 * Two-trustee Maker / Checker attestation layer for ledger-to-token actions.
 * A Maker proposes a canonical operation (mint, redeem, transfer, swap, etc.)
 * and one or more Checker/Maker roles approve it before it is executed.
 *
 * Default: 1-of-2 approval between `maker` and `checker`.
 */

const { query } = require('../bonds/pgPool');
const { TRUSTEES, normalizeRole, getTrusteeByRole, getTrusteeByEmail } = require('./trustees');

let PtcStablecoinEngine, StablecoinDexEngine, ModuleP2PSwapEngine;
try { PtcStablecoinEngine = require('./ptcStablecoinEngine').PtcStablecoinEngine; } catch (e) { /* optional */ }
try { StablecoinDexEngine = require('./stablecoinDexEngine').StablecoinDexEngine; } catch (e) { /* optional */ }
try { ModuleP2PSwapEngine = require('./moduleP2PSwapEngine').ModuleP2PSwapEngine; } catch (e) { /* optional */ }

function id(prefix = 'CC') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }
function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }

function defaultRequiredRoles() {
  return ['maker', 'checker'];
}

function defaultRequiredApprovals() {
  const n = parseInt(process.env.CANONICAL_CONSENSUS_THRESHOLD, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

class CanonicalConsensusEngine {
  static async ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS canonical_proposals (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL,
        description       TEXT,
        category          TEXT NOT NULL,
        payload           JSONB DEFAULT '{}',
        status            TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','failed')),
        required_roles    JSONB DEFAULT '["maker","checker"]',
        required_approvals INTEGER DEFAULT 1,
        approvals         JSONB DEFAULT '[]',
        result            JSONB DEFAULT '{}',
        created_by        TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_canonical_proposals_status ON canonical_proposals(status)`);
  }

  static normalizeRole(role) {
    return normalizeRole(role);
  }

  static validateApprover(role, email) {
    const normalized = normalizeRole(role);
    const byRole = getTrusteeByRole(normalized);
    if (!byRole) throw new Error(`Unknown consensus role: ${role}`);
    if (String(byRole.email).toLowerCase() !== String(email).toLowerCase()) {
      throw new Error(`Email ${email} is not authorized for role ${role}`);
    }
    return { role: normalized, name: byRole.name, email: byRole.email };
  }

  static async createProposal({
    title,
    description,
    category,
    payload,
    requiredRoles,
    requiredApprovals,
    createdBy,
    autoExecute = false,
  } = {}) {
    await this.ensureTables();
    if (!title) throw new Error('title is required');
    if (!category) throw new Error('category is required');
    const roles = Array.isArray(requiredRoles) && requiredRoles.length ? requiredRoles : defaultRequiredRoles();
    const threshold = Number(requiredApprovals) > 0 ? Number(requiredApprovals) : defaultRequiredApprovals();
    const proposalId = id();
    await query(
      `INSERT INTO canonical_proposals (id, title, description, category, payload, required_roles, required_approvals, approvals, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [proposalId, title, description || '', category, safeJson(payload || {}), safeJson(roles), threshold, safeJson([]), createdBy || '']
    );
    const proposal = await this.getProposal(proposalId);
    if (autoExecute && this.isApproved(proposal)) {
      return this.executeProposal(proposalId);
    }
    return proposal;
  }

  static async getProposal(proposalId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM canonical_proposals WHERE id = $1', [proposalId]);
    if (!res.rows.length) throw new Error('Proposal not found');
    return this._format(res.rows[0]);
  }

  static async listProposals({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM canonical_proposals';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows.map(r => this._format(r));
  }

  static _format(row) {
    return {
      ...row,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload || '{}') : (row.payload || {}),
      approvals: Array.isArray(row.approvals) ? row.approvals : JSON.parse(row.approvals || '[]'),
      required_roles: Array.isArray(row.required_roles) ? row.required_roles : JSON.parse(row.required_roles || '[]'),
      result: typeof row.result === 'string' ? JSON.parse(row.result || '{}') : (row.result || {}),
    };
  }

  static isApproved(proposal) {
    const approvals = Array.isArray(proposal.approvals) ? proposal.approvals : [];
    const unique = new Set();
    for (const a of approvals) {
      if (a.status === 'approved' && a.role) unique.add(a.role.toLowerCase());
    }
    const threshold = Number(proposal.required_approvals) || defaultRequiredApprovals();
    return unique.size >= threshold;
  }

  static async approveProposal({ proposalId, role, approverEmail, signature, signerName } = {}) {
    await this.ensureTables();
    const proposal = await this.getProposal(proposalId);
    if (proposal.status === 'executed' || proposal.status === 'failed') throw new Error(`Proposal already ${proposal.status}`);
    if (proposal.status === 'rejected') throw new Error('Proposal was rejected');

    const approver = this.validateApprover(role, approverEmail);
    const approvals = proposal.approvals || [];
    const normalizedRole = approver.role;
    if (approvals.find(a => a.role === normalizedRole && a.status === 'approved')) {
      throw new Error(`Role ${normalizedRole} has already approved this proposal`);
    }

    approvals.push({
      role: normalizedRole,
      status: 'approved',
      email: approver.email,
      name: signerName || approver.name,
      signature: signature || `sig-${normalizedRole}-${Date.now()}`,
      approvedAt: new Date().toISOString(),
    });

    const approved = this.isApproved({ ...proposal, approvals });
    const newStatus = approved ? 'approved' : proposal.status;

    await query(
      `UPDATE canonical_proposals SET approvals = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [safeJson(approvals), newStatus, proposalId]
    );

    const updated = await this.getProposal(proposalId);
    if (updated.status === 'approved') {
      return this.executeProposal(proposalId);
    }
    return updated;
  }

  static async rejectProposal({ proposalId, role, rejectorEmail, reason } = {}) {
    await this.ensureTables();
    const proposal = await this.getProposal(proposalId);
    if (['executed', 'failed', 'rejected'].includes(proposal.status)) throw new Error(`Proposal already ${proposal.status}`);

    const approver = this.validateApprover(role, rejectorEmail);
    const approvals = proposal.approvals || [];
    const idx = approvals.findIndex(a => a.role === approver.role);
    const rejection = { role: approver.role, status: 'rejected', email: approver.email, name: approver.name, reason: reason || '', rejectedAt: new Date().toISOString() };
    if (idx >= 0) approvals[idx] = rejection;
    else approvals.push(rejection);

    await query(
      `UPDATE canonical_proposals SET approvals = $1, status = 'rejected', updated_at = NOW() WHERE id = $2`,
      [safeJson(approvals), proposalId]
    );
    return this.getProposal(proposalId);
  }

  static async executeProposal(proposalId) {
    await this.ensureTables();
    const proposal = await this.getProposal(proposalId);
    if (proposal.status !== 'approved' && proposal.status !== 'pending') throw new Error(`Proposal status ${proposal.status} cannot be executed`);

    try {
      const result = await this._execute(proposal);
      await query(
        `UPDATE canonical_proposals SET status = 'executed', result = $1, updated_at = NOW() WHERE id = $2`,
        [safeJson(result), proposalId]
      );
      return { ...await this.getProposal(proposalId), executed: true };
    } catch (err) {
      await query(
        `UPDATE canonical_proposals SET status = 'failed', result = $1, updated_at = NOW() WHERE id = $2`,
        [safeJson({ error: err.message }), proposalId]
      );
      throw err;
    }
  }

  static async _execute(proposal) {
    const { category, payload } = proposal;
    switch (category) {
      case 'ptc_mint':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        return PtcStablecoinEngine.approveAndDeposit(payload || {});
      case 'ptc_redeem':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        return PtcStablecoinEngine.redeem(payload || {});
      case 'ptc_transfer':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        return PtcStablecoinEngine.transfer(payload || {});
      case 'ptc_whitelist':
        if (!PtcStablecoinEngine) throw new Error('PtcStablecoinEngine not available');
        return PtcStablecoinEngine.whitelist(payload.address, payload.allowed !== false);
      case 'dex_swap':
        if (!StablecoinDexEngine) throw new Error('StablecoinDexEngine not available');
        return StablecoinDexEngine.swap(payload || {});
      case 'p2p_order':
        if (!ModuleP2PSwapEngine) throw new Error('ModuleP2PSwapEngine not available');
        return ModuleP2PSwapEngine.createOrder(payload || {});
      case 'p2p_fill':
        if (!ModuleP2PSwapEngine) throw new Error('ModuleP2PSwapEngine not available');
        return ModuleP2PSwapEngine.fillOrder(payload || {});
      case 'liquidity': {
        const { CanonicalLiquidityEngine } = require('./canonicalLiquidityEngine');
        if (!CanonicalLiquidityEngine) throw new Error('CanonicalLiquidityEngine not available');
        return CanonicalLiquidityEngine._execute(proposal);
      }
      case 'canonical_money': {
        const { CanonicalMoneyEngine } = require('./canonicalMoneyEngine');
        if (!CanonicalMoneyEngine) throw new Error('CanonicalMoneyEngine not available');
        return CanonicalMoneyEngine._execute(proposal);
      }
      case 'cross_chain': {
        const { CrossChainConversionEngine } = require('./crossChainConversionEngine');
        if (!CrossChainConversionEngine) throw new Error('CrossChainConversionEngine not available');
        return CrossChainConversionEngine._execute(proposal);
      }
      case 'custom':
        return { status: 'approved', message: 'Custom proposal approved, no automatic execution configured', payload };
      default:
        throw new Error(`Unknown proposal category: ${category}`);
    }
  }
}

module.exports = { CanonicalConsensusEngine };

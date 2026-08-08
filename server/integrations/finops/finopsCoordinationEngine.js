'use strict';

const pool = require('../bonds/pgPool');

const { FinOpsAgent } = require('./finopsAgent');
const { StablecoinEngine } = require('../dapp/stablecoinEngine');
const { RedemptionEngine } = require('../dapp/redemptionEngine');
const { CanonicalConsensusEngine } = require('../dapp/canonicalConsensusEngine');
const { AccountAbstractionEngine } = require('../dapp/accountAbstractionEngine');
const { WalletEngine } = require('../dapp/walletEngine');

function id(prefix = 'FCJ') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

class FinOpsCoordinationEngine {
  static async ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finops_coordination_jobs (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL,
        payload       JSONB NOT NULL DEFAULT '{}',
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','blocked')),
        result        JSONB,
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 3,
        error         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_finops_coord_jobs_status ON finops_coordination_jobs(status)`);
  }

  static async systemHealth() {
    const health = { ok: true, checks: {}, timestamp: new Date().toISOString() };
    try {
      const stablecoin = await StablecoinEngine.info();
      health.checks.stablecoin = {
        ok: stablecoin && stablecoin.totalSupply > 0,
        totalSupply: stablecoin?.totalSupply,
        collateralRatio: stablecoin?.collateralRatio,
        paused: stablecoin?.paused,
      };
      if (!health.checks.stablecoin.ok) health.ok = false;
    } catch (e) { health.checks.stablecoin = { ok: false, error: e.message }; health.ok = false; }

    try {
      const aa = await AccountAbstractionEngine.readiness();
      health.checks.accountAbstraction = {
        ok: !!aa?.ready,
        enabled: aa?.enabled,
        shadow: aa?.shadow,
        paymasterAddress: aa?.paymasterAddress,
        issues: aa?.issues,
      };
      if (!health.checks.accountAbstraction.ok) health.ok = false;
    } catch (e) { health.checks.accountAbstraction = { ok: false, error: e.message }; health.ok = false; }

    try {
      const paymasterBalance = await AccountAbstractionEngine.getPaymasterBalance();
      const deposit = parseFloat(paymasterBalance?.entryPointDeposit || '0');
      health.checks.paymasterBalance = {
        ok: deposit > 0.00015,
        entryPointDeposit: paymasterBalance?.entryPointDeposit,
        entryPointStake: paymasterBalance?.entryPointStake,
        operatorEth: paymasterBalance?.operatorEth,
      };
      if (!health.checks.paymasterBalance.ok) health.ok = false;
    } catch (e) { health.checks.paymasterBalance = { ok: false, error: e.message }; health.ok = false; }

    try {
      const aa = await AccountAbstractionEngine.getPaymasterBalance();
      const opEth = parseFloat(aa?.operatorEth || '0');
      health.checks.operatorWallet = {
        ok: opEth > 0.000005,
        address: aa?.operatorAddress,
        ethBalance: aa?.operatorEth,
      };
      if (!health.checks.operatorWallet.ok) health.ok = false;
    } catch (e) { health.checks.operatorWallet = { ok: false, error: e.message }; health.ok = false; }

    return health;
  }

  static async submitJob({ type, payload, maxAttempts = 3 }) {
    await this.ensureTable();
    const jobId = id();
    await pool.query(
      'INSERT INTO finops_coordination_jobs (id, type, payload, status, max_attempts) VALUES ($1,$2,$3,$4,$5)',
      [jobId, type, JSON.stringify(payload || {}), 'pending', maxAttempts]
    );
    return this.getJob(jobId);
  }

  static async getJob(jobId) {
    await this.ensureTable();
    const result = await pool.query('SELECT * FROM finops_coordination_jobs WHERE id = $1', [jobId]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    row.payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
    row.result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
    return row;
  }

  static _parseJsonb(value) {
    if (typeof value === 'string') return JSON.parse(value);
    return value ?? null;
  }

  static async listQueue({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTable();
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status] : [];
    const result = await pool.query(
      `SELECT * FROM finops_coordination_jobs ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return result.rows.map(r => {
      r.payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload || {});
      r.result = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
      return r;
    });
  }

  static async processJob(jobId) {
    const job = await this.getJob(jobId);
    if (!job) throw new Error('Job not found');
    if (job.status === 'completed') return job;
    if (job.attempts >= job.max_attempts) {
      await pool.query("UPDATE finops_coordination_jobs SET status='failed', error='max attempts exceeded', updated_at=NOW() WHERE id=$1", [jobId]);
      return this.getJob(jobId);
    }

    await pool.query("UPDATE finops_coordination_jobs SET status='running', attempts=attempts+1, updated_at=NOW() WHERE id=$1", [jobId]);
    let result;
    try {
      switch (job.type) {
        case 'agent_command':
          result = await FinOpsAgent.process({ command: job.payload.command, userId: job.payload.userId });
          break;
        case 'stablecoin_mint':
          result = await StablecoinEngine.mint({ ...job.payload, operatorEmail: job.payload.operatorEmail || 'coordination' });
          break;
        case 'stablecoin_settle':
          result = await StablecoinEngine.settle({ ...job.payload, operatorEmail: job.payload.operatorEmail || 'coordination' });
          break;
        case 'redemption_create':
          result = await RedemptionEngine.create({ ...job.payload, requesterEmail: job.payload.requesterEmail || 'coordination' });
          break;
        case 'consensus_propose':
          result = await CanonicalConsensusEngine.createProposal({ ...job.payload, createdBy: job.payload.createdBy || 'coordination' });
          break;
        case 'aa_prepare_transfer':
          result = await AccountAbstractionEngine.prepareGaslessTransfer(job.payload);
          break;
        default:
          throw new Error(`Unknown coordination job type: ${job.type}`);
      }
      await pool.query(
        "UPDATE finops_coordination_jobs SET status='completed', result=$1, error=NULL, updated_at=NOW() WHERE id=$2",
        [JSON.stringify(result), jobId]
      );
    } catch (err) {
      await pool.query(
        "UPDATE finops_coordination_jobs SET status='failed', error=$1, updated_at=NOW() WHERE id=$2",
        [err.message, jobId]
      );
      throw err;
    }
    return this.getJob(jobId);
  }

  static async runCommand({ command, userId = 'operator', autoExecute = false }) {
    await this.ensureTable();
    const health = await this.systemHealth();
    if (!health.ok) {
      const jobId = await this.submitJob({ type: 'agent_command', payload: { command, userId } });
      return { type: 'queued', reason: 'system health checks failed', health, jobId: job.id };
    }

    if (autoExecute) {
      const job = await this.submitJob({ type: 'agent_command', payload: { command, userId } });
      const processed = await this.processJob(job.id);
      return { type: 'executed', jobId: job.id, job: processed, health };
    }

    // Direct read or approval path
    const parsed = FinOpsAgent.parseCommand(command);
    const readOnly = ['showSourceOfFunds', 'showWallets', 'showBonds', 'showCrm'].includes(parsed.intent);
    if (readOnly) {
      const data = await FinOpsAgent.executeRead(parsed.intent);
      return { type: 'data', intent: parsed.intent, data, health };
    }

    const job = await this.submitJob({ type: 'agent_command', payload: { command, userId } });
    return { type: 'approval_required', jobId: job.id, summary: FinOpsAgent.summarize(parsed.intent, parsed.params), health };
  }

  static async retryFailed() {
    await this.ensureTable();
    const failed = await this.listQueue({ status: 'failed', limit: 10 });
    const results = [];
    for (const job of failed) {
      await pool.query("UPDATE finops_coordination_jobs SET status='pending', error=NULL, updated_at=NOW() WHERE id=$1", [job.id]);
      try { results.push(await this.processJob(job.id)); } catch (e) { results.push({ id: job.id, error: e.message }); }
    }
    return results;
  }
}

module.exports = { FinOpsCoordinationEngine };

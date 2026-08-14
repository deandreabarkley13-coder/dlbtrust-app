'use strict';

/**
 * ProgrammableMoneyEngine — rule-based, consensus-gated money execution for trust assets.
 *
 * A "program" is a reusable instruction that describes a source of funds, an amount,
 * a target asset, and optional conditions/schedule.  Once the program is approved by
 * the required trustee roles it becomes active and can be triggered manually or by an
 * automated scheduler.  Each trigger creates an auditable run and executes through
 * the existing CanonicalMoneyEngine conversion routes.
 */

const { query } = require('../bonds/pgPool');

let _ensureTablesPromise = null;

let CanonicalMoneyEngine;
try { ({ CanonicalMoneyEngine } = require('./canonicalMoneyEngine')); } catch (e) { /* optional */ }

function canonicalConsensusEngine() {
  const { CanonicalConsensusEngine } = require('./canonicalConsensusEngine');
  return CanonicalConsensusEngine;
}

function safeJson(obj) { return JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? String(v) : v); }
function id(prefix = 'PM') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

class ProgrammableMoneyEngine {
  static async ensureTables() {
    if (_ensureTablesPromise) return _ensureTablesPromise;
    _ensureTablesPromise = this._ensureTables().catch((err) => {
      _ensureTablesPromise = null;
      throw err;
    });
    return _ensureTablesPromise;
  }

  static async _ensureTables() {
    await query(`
      CREATE TABLE IF NOT EXISTS programmable_money_programs (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT,
        source_type     TEXT,
        source_account  TEXT,
        source_token    TEXT,
        source_module   TEXT,
        amount          TEXT NOT NULL,
        target_asset    TEXT DEFAULT 'USDC',
        action          TEXT DEFAULT 'convert',
        conditions      JSONB DEFAULT '{}',
        schedule_cron   TEXT,
        status          TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','active','paused','executed','failed','rejected')),
        proposal_id     TEXT,
        result          JSONB DEFAULT '{}',
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_programmable_money_programs_status ON programmable_money_programs(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_programmable_money_programs_proposal ON programmable_money_programs(proposal_id)`);

    await query(`
      CREATE TABLE IF NOT EXISTS programmable_money_runs (
        id            TEXT PRIMARY KEY,
        program_id    TEXT NOT NULL REFERENCES programmable_money_programs(id) ON DELETE CASCADE,
        trigger_event TEXT,
        status        TEXT DEFAULT 'running',
        result        JSONB DEFAULT '{}',
        created_by    TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_programmable_money_runs_program ON programmable_money_runs(program_id)`);

    // Allow 'rejected' status on tables created before this migration
    await query(`ALTER TABLE programmable_money_programs DROP CONSTRAINT IF EXISTS programmable_money_programs_status_check`);
    await query(`ALTER TABLE programmable_money_programs ADD CONSTRAINT programmable_money_programs_status_check CHECK (status IN ('pending','approved','active','paused','executed','failed','rejected'))`);
  }

  static async createProgram({
    name,
    description,
    sourceType,
    sourceAccount,
    sourceToken,
    sourceModule,
    amount,
    targetAsset = 'USDC',
    action = 'convert',
    conditions = {},
    schedule,
    createdBy,
  } = {}) {
    await this.ensureTables();
    if (!name) throw new Error('name is required');
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) throw new Error('amount must be a positive number');
    const amountString = String(amount).trim();
    if (!amountString) throw new Error('amount is required');
    if (action && !['convert', 'swap', 'transfer', 'disburse'].includes(action)) throw new Error('action must be one of: convert, swap, transfer, disburse');
    if (targetAsset && typeof targetAsset !== 'string') throw new Error('targetAsset must be a string');
    if (sourceType && typeof sourceType !== 'string') throw new Error('sourceType must be a string');
    if (sourceAccount && typeof sourceAccount !== 'string') throw new Error('sourceAccount must be a string');
    if (sourceToken && typeof sourceToken !== 'string') throw new Error('sourceToken must be a string');
    if (sourceModule && typeof sourceModule !== 'string') throw new Error('sourceModule must be a string');
    if (conditions && typeof conditions !== 'object') throw new Error('conditions must be an object');
    if (schedule && typeof schedule !== 'string') throw new Error('schedule must be a string');
    if (!CanonicalMoneyEngine) throw new Error('CanonicalMoneyEngine is required for programmable money execution');

    const programId = id();
    const proposal = await canonicalConsensusEngine().createProposal({
      category: 'programmable_money',
      title: `Programmable Money: ${name}`,
      description: description || `Automated ${action} of ${amountString} ${sourceType || sourceToken || sourceModule || 'funds'} to ${targetAsset}`,
      payload: {
        programId,
        sourceType,
        sourceAccount,
        sourceToken,
        sourceModule,
        amount: amountString,
        targetAsset,
        action,
        conditions,
        schedule,
      },
      createdBy: createdBy || 'operator',
      autoExecute: false,
    });

    await query(
      `INSERT INTO programmable_money_programs
       (id, name, description, source_type, source_account, source_token, source_module, amount, target_asset, action, conditions, schedule_cron, status, proposal_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [programId, name, description || '', sourceType || null, sourceAccount || null, sourceToken || null, sourceModule || null, amountString, targetAsset, action, safeJson(conditions || {}), schedule || null, 'pending', proposal.id, createdBy || 'operator']
    );

    return { programId, proposalId: proposal.id, proposal };
  }

  static async listPrograms({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM programmable_money_programs';
    const params = [];
    if (status) { sql += ' WHERE status = $1'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows.map(r => this._formatProgram(r));
  }

  static async getProgram(programId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM programmable_money_programs WHERE id = $1', [programId]);
    if (!res.rows.length) return null;
    return this._formatProgram(res.rows[0]);
  }

  static async approveProgram({ programId, role, approverEmail }) {
    await this.ensureTables();
    const program = await this.getProgram(programId);
    if (!program) throw new Error('Program not found');
    const proposal = await canonicalConsensusEngine().approveProposal({ proposalId: program.proposal_id, role, approverEmail });
    const updated = await this.getProgram(programId);
    return { program: { ...updated, proposal } };
  }

  static async rejectProgram({ programId, role, rejectorEmail, reason }) {
    await this.ensureTables();
    const program = await this.getProgram(programId);
    if (!program) throw new Error('Program not found');
    const proposal = await canonicalConsensusEngine().rejectProposal({ proposalId: program.proposal_id, role, rejectorEmail, reason });
    await query(
      `UPDATE programmable_money_programs SET status='rejected', result=$1, updated_at=NOW() WHERE id=$2`,
      [safeJson({ rejected: true, reason: reason || 'Rejected by trustee', rejectedAt: new Date().toISOString() }), programId]
    );
    const updated = await this.getProgram(programId);
    return { program: { ...updated, proposal } };
  }

  static async triggerProgram({ programId, trigger = 'manual', triggeredBy, payload = {} } = {}) {
    await this.ensureTables();
    const program = await this.getProgram(programId);
    if (!program) throw new Error('Program not found');
    if (program.status !== 'active' && program.status !== 'approved') {
      throw new Error(`Program is ${program.status}; must be approved or active to trigger`);
    }
    if (program.status === 'approved') {
      // First trigger transitions approved program to active lifecycle
      await query(`UPDATE programmable_money_programs SET status='active', updated_at=NOW() WHERE id=$1`, [programId]);
      program.status = 'active';
    }

    const runId = id('PMR');
    await query(
      `INSERT INTO programmable_money_runs (id, program_id, trigger_event, status, result, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [runId, programId, trigger, 'running', safeJson({}), triggeredBy || 'system']
    );

    try {
      const result = await this._executeProgram(program, payload);
      const completedAt = new Date().toISOString();
      const runResult = { ...result, runId, completedAt };
      const runStatus = result.status === 'failed' ? 'failed' : 'completed';
      await query(
        `UPDATE programmable_money_runs SET status=$1, result=$2, updated_at=NOW() WHERE id=$3`,
        [runStatus, safeJson(runResult), runId]
      );

      const prevResult = (program && program.result) || {};
      const consecutiveFailures = runStatus === 'failed' ? ((prevResult.consecutiveFailures || 0) + 1) : 0;
      const programResult = { ...prevResult, lastRun: runResult, consecutiveFailures };
      const programStatus = consecutiveFailures >= 3 ? 'paused' : (program.status === 'approved' ? 'active' : program.status);
      await query(
        `UPDATE programmable_money_programs SET status=$1, result=$2, updated_at=NOW() WHERE id=$3`,
        [programStatus, safeJson(programResult), programId]
      );
      return { runId, result };
    } catch (err) {
      const failedAt = new Date().toISOString();
      const errorResult = { status: 'failed', error: err.message, runId, failedAt };
      await query(
        `UPDATE programmable_money_runs SET status=$1, result=$2, updated_at=NOW() WHERE id=$3`,
        ['failed', safeJson(errorResult), runId]
      );

      const prevResult = (program && program.result) || {};
      const consecutiveFailures = (prevResult.consecutiveFailures || 0) + 1;
      const programResult = { ...prevResult, lastRun: errorResult, consecutiveFailures };
      const programStatus = consecutiveFailures >= 3 ? 'paused' : (program.status === 'approved' ? 'active' : program.status);
      await query(
        `UPDATE programmable_money_programs SET status=$1, result=$2, updated_at=NOW() WHERE id=$3`,
        [programStatus, safeJson(programResult), programId]
      );
      throw err;
    }
  }

  static async listRuns({ programId, status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    let sql = 'SELECT * FROM programmable_money_runs';
    const params = [];
    const conditions = [];
    if (programId) { conditions.push('program_id = $' + (params.length + 1)); params.push(programId); }
    if (status) { conditions.push('status = $' + (params.length + 1)); params.push(status); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(Number(limit), Number(offset));
    const res = await query(sql, params);
    return res.rows.map(r => this._formatRun(r));
  }

  static async getRun(runId) {
    await this.ensureTables();
    const res = await query('SELECT * FROM programmable_money_runs WHERE id = $1', [runId]);
    if (!res.rows.length) return null;
    return this._formatRun(res.rows[0]);
  }

  static async activateFromProposal(programId) {
    await this.ensureTables();
    const program = await this.getProgram(programId);
    if (!program) throw new Error('Program not found');
    await query("UPDATE programmable_money_programs SET status='active', updated_at=NOW() WHERE id=$1", [programId]);
    return { ...await this.getProgram(programId), activated: true };
  }

  static async _executeProgram(program, payload = {}) {
    if (!CanonicalMoneyEngine) throw new Error('CanonicalMoneyEngine not available');
    await CanonicalMoneyEngine.ensureTables();
    const { source_type, source_account, source_token, source_module, amount, target_asset, conditions } = program;

    const route = await CanonicalMoneyEngine._pickRoute({
      sourceType: source_type,
      sourceAccountId: source_account,
      sourceToken: source_token,
      sourceModule: source_module,
      targetAsset: target_asset,
      poolAddress: payload.poolAddress || conditions.poolAddress,
    });

    const requestId = id('CM');
    await query(
      `INSERT INTO canonical_money_requests (id, proposal_id, source_type, source_account, source_token, source_module, amount, target_asset, route, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [requestId, null, source_type || null, source_account || null, source_token || null, source_module || null, String(amount), target_asset, safeJson(route), 'pending', 'programmable-money']
    );

    const proposal = {
      payload: {
        requestId,
        route,
        amount,
        targetAsset: target_asset,
        recipient: payload.recipient || conditions.recipient,
        createPoolIfMissing: payload.createPoolIfMissing || conditions.createPoolIfMissing,
        poolSeedUsdc: payload.poolSeedUsdc || conditions.poolSeedUsdc,
        poolSeedDlbusd: payload.poolSeedDlbusd || conditions.poolSeedDlbusd,
      },
    };

    return await CanonicalMoneyEngine._execute(proposal);
  }

  static _formatProgram(row) {
    if (!row) return row;
    return {
      ...row,
      conditions: typeof row.conditions === 'string' ? JSON.parse(row.conditions || '{}') : (row.conditions || {}),
      result: typeof row.result === 'string' ? JSON.parse(row.result || '{}') : (row.result || {}),
      route: typeof row.route === 'string' ? JSON.parse(row.route || '{}') : (row.route || {}),
    };
  }

  static _formatRun(row) {
    if (!row) return row;
    return {
      ...row,
      result: typeof row.result === 'string' ? JSON.parse(row.result || '{}') : (row.result || {}),
    };
  }
}

module.exports = { ProgrammableMoneyEngine };

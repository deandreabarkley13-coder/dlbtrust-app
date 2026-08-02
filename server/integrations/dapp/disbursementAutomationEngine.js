'use strict';

/**
 * One-Click Distribution / Disbursement Automation Engine
 *
 * Simplifies the full trust payment lifecycle:
 *   1. Compute asset-debt proof (optionally including hard assets).
 *   2. Create a distribution or disbursement request.
 *   3. Orchestrate trustee approvals and execution.
 *   4. Create calendar/messaging artifacts for audit.
 *
 * Two trustees (Administration + Distribution) remain in the loop.
 */

let AssetDebtProofEngine;
try { AssetDebtProofEngine = require('../accounting/assetDebtProofEngine').AssetDebtProofEngine; } catch (e) { AssetDebtProofEngine = null; }

let DistributionRequestEngine;
try { DistributionRequestEngine = require('./distributionRequestEngine').DistributionRequestEngine; } catch (e) { DistributionRequestEngine = null; }

let SafeEngine;
try { SafeEngine = require('./safeEngine').SafeEngine; } catch (e) { SafeEngine = null; }

let DappEngine;
try { DappEngine = require('./dappEngine').DappEngine; } catch (e) { DappEngine = null; }

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let MessagingEngine;
try { MessagingEngine = require('../messaging/messagingEngine').MessagingEngine; } catch (e) { MessagingEngine = null; }

let CalendarEngine;
try { CalendarEngine = require('../calendar/calendarEngine').CalendarEngine; } catch (e) { CalendarEngine = null; }

const { TRUSTEES, REQUIRED_ROLES } = require('./trustees');

function id(prefix = 'AUT') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

async function query(sql, params) { if (!pool) throw new Error('Postgres unavailable'); return pool.query(sql, params); }
async function withFallback(fn, fallback) { try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; } }

class DisbursementAutomationEngine {

  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS disbursement_templates (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL CHECK (type IN ('distribution','disbursement')),
          description TEXT,
          source_type TEXT,
          source_account_id TEXT,
          safe_id     TEXT,
          beneficiaries JSONB DEFAULT '[]',
          amount_usd  TEXT,
          destination_address TEXT,
          memo        TEXT,
          auto_approve BOOLEAN DEFAULT FALSE,
          created_by  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS disbursement_automation_runs (
          id          TEXT PRIMARY KEY,
          template_id TEXT,
          status      TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','proof_ready','approved','executed','partial','failed')),
          proof_id    TEXT,
          request_ids JSONB DEFAULT '[]',
          results     JSONB DEFAULT '{}',
          errors      JSONB DEFAULT '[]',
          created_by  TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    }, () => {});
  }

  static get _mem() {
    if (!DisbursementAutomationEngine.__memory) DisbursementAutomationEngine.__memory = { templates: new Map(), runs: new Map() };
    return DisbursementAutomationEngine.__memory;
  }

  static _rowToObject(row) {
    if (!row) return null;
    const obj = { ...row };
    ['beneficiaries', 'request_ids', 'results', 'errors'].forEach(c => {
      if (obj[c] != null && typeof obj[c] === 'string') obj[c] = JSON.parse(obj[c] || (c === 'beneficiaries' || c === 'request_ids' || c === 'errors' ? '[]' : '{}'));
      if (obj[c] == null) obj[c] = (c === 'beneficiaries' || c === 'request_ids' || c === 'errors') ? [] : {};
    });
    return obj;
  }

  static async _insert(table, row) {
    return withFallback(async () => {
      const keys = Object.keys(row).filter(k => row[k] !== undefined);
      const cols = keys.join(',');
      const vals = keys.map((_, i) => `$${i + 1}`).join(',');
      const params = keys.map(k => (['beneficiaries','request_ids','results','errors'].includes(k) ? JSON.stringify(row[k]) : row[k]));
      const result = await query(`INSERT INTO ${table} (${cols}) VALUES (${vals}) RETURNING *`, params);
      return result.rows[0];
    }, async () => {
      const map = table === 'disbursement_templates' ? DisbursementAutomationEngine._mem.templates : DisbursementAutomationEngine._mem.runs;
      map.set(row.id, row);
      return row;
    });
  }

  static async _update(table, id, updates) {
    return withFallback(async () => {
      const keys = Object.keys(updates).filter(k => updates[k] !== undefined);
      if (!keys.length) return this._get(table, id);
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(',');
      const params = keys.map(k => (['beneficiaries','request_ids','results','errors'].includes(k) ? JSON.stringify(updates[k]) : updates[k]));
      const result = await query(`UPDATE ${table} SET ${set}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`, [...params, id]);
      return result.rows[0];
    }, async () => {
      const map = table === 'disbursement_templates' ? DisbursementAutomationEngine._mem.templates : DisbursementAutomationEngine._mem.runs;
      const row = map.get(id);
      if (!row) return null;
      Object.assign(row, updates);
      map.set(id, row);
      return row;
    });
  }

  static async _get(table, id) {
    return withFallback(async () => {
      const result = await query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      return result.rows[0] || null;
    }, async () => {
      const map = table === 'disbursement_templates' ? DisbursementAutomationEngine._mem.templates : DisbursementAutomationEngine._mem.runs;
      return map.get(id) || null;
    });
  }

  static async _listTemplates(limit = 100) {
    return withFallback(async () => {
      const result = await query('SELECT * FROM disbursement_templates ORDER BY updated_at DESC LIMIT $1 OFFSET $2', [limit, 0]);
      return result.rows.map(r => this._rowToObject(r));
    }, async () => Array.from(DisbursementAutomationEngine._mem.templates.values()).slice(0, limit));
  }

  // ─── Template CRUD ───────────────────────────────────────────────────────

  static async createTemplate({ name, type = 'distribution', description, sourceType, sourceAccountId, safeId, beneficiaries, amountUsd, destinationAddress, memo, autoApprove, createdBy }) {
    await this.ensureTables();
    if (!name) throw new Error('Template name required');
    const row = {
      id: id('TPL'),
      name,
      type,
      description: description || null,
      source_type: sourceType || null,
      source_account_id: sourceAccountId || null,
      safe_id: safeId || null,
      beneficiaries: beneficiaries || [],
      amount_usd: amountUsd == null ? null : String(amountUsd),
      destination_address: destinationAddress || null,
      memo: memo || null,
      auto_approve: autoApprove === true,
      created_by: createdBy || null,
    };
    const inserted = await this._insert('disbursement_templates', row);
    return this._rowToObject(inserted);
  }

  static async listTemplates(limit) { await this.ensureTables(); return (await this._listTemplates(limit)).map(r => this._rowToObject(r)); }

  static async getTemplate(id) { await this.ensureTables(); return this._rowToObject(await this._get('disbursement_templates', id)); }

  static async updateTemplate(id, updates) {
    await this.ensureTables();
    const allowed = ['name','description','source_type','source_account_id','safe_id','beneficiaries','amount_usd','destination_address','memo','auto_approve'];
    const filtered = {};
    for (const k of allowed) if (updates[k] !== undefined) filtered[k] = updates[k];
    return this._rowToObject(await this._update('disbursement_templates', id, filtered));
  }

  static async deleteTemplate(id) {
    await this.ensureTables();
    return withFallback(async () => { await query('DELETE FROM disbursement_templates WHERE id = $1', [id]); return { deleted: true }; }, () => { DisbursementAutomationEngine._mem.templates.delete(id); return { deleted: true }; });
  }

  // ─── One-Click Distribution Automation ───────────────────────────────────────

  /**
   * Run a one-click distribution / disbursement.
   * Parameters:
   *   - templateId (optional)
   *   - name / memo
   *   - sourceType, sourceAccountId, safeId
   *   - amountUsd or beneficiaries[] with amountUsd
   *   - destinationAddress (for single disbursement)
   *   - beneficiaryEmail / beneficiaryName (for single request)
   *   - includeHardAssets (bool)
   *   - trusteeSignatures: [ { role, email, signature, signedAt } ]
   *   - autoExecute (bool)
   *   - createdBy
   */
  static async runOneClickDistribution({
    templateId,
    name,
    type = 'distribution',
    sourceType = 'treasury',
    sourceAccountId = 'TREASURY_HOT',
    safeId,
    amountUsd,
    destinationAddress,
    beneficiaryEmail,
    beneficiaryName,
    beneficiaries,
    memo,
    includeHardAssets = false,
    requesterRole = 'trustee',
    trusteeSignatures,
    autoExecute = false,
    createdBy,
  }) {
    await this.ensureTables();
    if (!AssetDebtProofEngine || !DistributionRequestEngine) throw new Error('Required engines unavailable');

    const runId = id('RUN');
    let run = this._rowToObject(await this._insert('disbursement_automation_runs', {
      id: runId,
      template_id: templateId || null,
      status: 'created',
      request_ids: [],
      results: {},
      errors: [],
      created_by: createdBy || null,
    }));

    const results = { proof: null, requests: [], approvals: [], execution: null };
    const errors = [];

    try {
      // 1. Compute asset-debt proof
      const proof = await AssetDebtProofEngine.computeProof({
        memo: memo || `One-click ${type} run ${runId}`,
        includeHardAssets,
      });
      results.proof = proof;
      await this._update('disbursement_automation_runs', runId, { proof_id: proof.id, status: 'proof_ready' });

      // 2. If trustee signatures supplied, certify the proof
      if (Array.isArray(trusteeSignatures) && trusteeSignatures.length > 0) {
        for (const sig of trusteeSignatures) {
          try { await AssetDebtProofEngine.signProof(proof.id, sig); } catch (e) { errors.push(`proof sign ${sig.role}: ${e.message}`); }
        }
      }

      // 3. Build beneficiary list
      const benList = beneficiaries || [];
      if (!benList.length && amountUsd) {
        benList.push({
          email: beneficiaryEmail || 'beneficiary@trust',
          name: beneficiaryName || 'Beneficiary',
          amountUsd: Number(amountUsd).toFixed(2),
          address: destinationAddress || '',
        });
      }
      if (!benList.length) throw new Error('No beneficiaries or amount provided');

      // 4. Create distribution / disbursement requests
      const requestIds = [];
      for (const b of benList) {
        const req = await DistributionRequestEngine.createRequest({
          type,
          requesterRole,
          beneficiaryEmail: b.email,
          beneficiaryName: b.name,
          amountUsd: b.amountUsd,
          currency: 'USD',
          destinationAddress: b.address,
          sourceType,
          sourceAccountId,
          safeId,
          proofId: proof.id,
          memo: memo || `${type} ${b.name}`,
          createdBy,
        });
        requestIds.push(req.id);
        results.requests.push(req);

        // messaging thread
        if (MessagingEngine) {
          try {
            await MessagingEngine.notify({
              subject: `${type} request ${req.id} requires trustee approval`,
              body: `One-click ${type} run ${runId} created request ${req.id} for ${b.name} (${b.email}) amount $${b.amountUsd}. Proof ${proof.id} attached.`,
              participants: TRUSTEES.map(t => ({ name: t.name, email: t.email, role: t.role })),
              referenceType: 'distribution_request',
              referenceId: req.id,
              sender: createdBy || 'system',
            });
          } catch (e) { errors.push(`messaging: ${e.message}`); }
        }
      }

      await this._update('disbursement_automation_runs', runId, { request_ids: requestIds, results: { step: 'requests_created', proof_id: proof.id, request_count: requestIds.length } });

      // 5. Approve requests if signatures supplied
      if (Array.isArray(trusteeSignatures) && trusteeSignatures.length >= 2) {
        const sigByRole = new Map();
        for (const s of trusteeSignatures) sigByRole.set(s.role, s);
        for (const req of results.requests) {
          try {
            for (const role of REQUIRED_ROLES) {
              const sig = sigByRole.get(role) || trusteeSignatures.find(s => s.role === role);
              if (sig) {
                const approved = await DistributionRequestEngine.approveRequest({ requestId: req.id, role: sig.role, trusteeEmail: sig.trusteeEmail, signature: sig.signature, signerName: sig.signerName });
                results.approvals.push({ requestId: req.id, role, approved });
              }
            }
          } catch (e) { errors.push(`approve ${req.id}: ${e.message}`); }
        }
      }

      // 6. Auto-execute if all requests approved
      if (autoExecute) {
        for (const req of results.requests) {
          try {
            const refreshed = await DistributionRequestEngine.getRequest(req.id);
            if (refreshed.status === 'approved') {
              const executed = await DistributionRequestEngine.executeRequest(req.id);
              results.execution = results.execution || {};
              results.execution[req.id] = executed;
            }
          } catch (e) { errors.push(`execute ${req.id}: ${e.message}`); }
        }
      }

      // 7. Calendar event
      if (CalendarEngine) {
        try {
          await CalendarEngine.createEvent({
            title: `${type} run ${runId}`,
            description: `Created ${results.requests.length} request(s). Proof ${proof.id}.`,
            start: new Date().toISOString(),
            end: new Date(Date.now() + 3600000).toISOString(),
            attendees: TRUSTEES.map(t => t.email),
            metadata: { runId, proofId: proof.id, requestIds },
          });
        } catch (e) { errors.push(`calendar: ${e.message}`); }
      }

      const finalStatus = results.requests.every(r => r.status === 'executed') ? 'executed' : (results.requests.some(r => r.status === 'approved') ? 'approved' : 'created');
      run = this._rowToObject(await this._update('disbursement_automation_runs', runId, { status: finalStatus, results, errors }));

    } catch (e) {
      errors.push(e.message);
      run = this._rowToObject(await this._update('disbursement_automation_runs', runId, { status: 'failed', results, errors }));
    }

    return { run, ...results, errors };
  }

  // ─── One-Click Approve / Execute helpers ───────────────────────────────────

  static async approveAndExecute(requestId, { role, email, signature, executedBy }) {
    await this.ensureTables();
    if (!DistributionRequestEngine) throw new Error('DistributionRequestEngine not available');
    const approved = await DistributionRequestEngine.approveRequest({ requestId, role, trusteeEmail: email, signature, signerName: email });
    if (approved.status === 'approved') {
      const executed = await DistributionRequestEngine.executeRequest(requestId);
      return { approved, executed };
    }
    return { approved, executed: null };
  }

  static async approveAndExecuteRun(runId, { trusteeSignatures, executedBy }) {
    await this.ensureTables();
    const run = this._rowToObject(await this._get('disbursement_automation_runs', runId));
    if (!run) throw new Error('Run not found');
    const results = { approvals: [], executions: [] };
    for (const requestId of run.request_ids || []) {
      for (const sig of trusteeSignatures) {
        try { results.approvals.push(await DistributionRequestEngine.approveRequest({ requestId, ...sig })); } catch (e) { results.approvals.push({ error: e.message, requestId, role: sig.role }); }
      }
      try {
        const refreshed = await DistributionRequestEngine.getRequest(requestId);
        if (refreshed.status === 'approved') results.executions.push(await DistributionRequestEngine.executeRequest(requestId));
      } catch (e) { results.executions.push({ error: e.message, requestId }); }
    }
    return results;
  }

  static async getRun(id) { await this.ensureTables(); return this._rowToObject(await this._get('disbursement_automation_runs', id)); }

  static async listRuns(limit = 100) {
    await this.ensureTables();
    return withFallback(async () => {
      const result = await query('SELECT * FROM disbursement_automation_runs ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, 0]);
      return result.rows.map(r => this._rowToObject(r));
    }, async () => Array.from(DisbursementAutomationEngine._mem.runs.values()).sort((a, b) => b.created_at - a.created_at).slice(0, limit));
  }
}

module.exports = { DisbursementAutomationEngine, TRUSTEES };

/**
 * Trustee Approval Engine
 * DEANDREA LAVAR BARKLEY TRUST — Fiduciary Governance & Approval Workflows
 *
 * Provides centralized approval logic for all platform actions:
 *   - Account creation/closure/activation/freeze
 *   - External transfers and internal transfers
 *   - Manual journal entries
 *   - Platform configuration changes
 *   - Beneficiary distributions
 *   - Account holds
 *
 * Approval tiers: auto, single, dual, committee
 * Policies are configurable per entity_type + action
 */
'use strict';

// ─── Request Number Generator ────────────────────────────────────────────────

function generateRequestNumber() {
  const d = new Date();
  const date = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `APR-${date}-${rand}`;
}

// ─── Schema Initialization ───────────────────────────────────────────────────

function initApprovalSchema(db) {
  const fs = require('fs');
  const path = require('path');
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'approval-schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(sql);
  }
}

// ─── Policy Lookup ───────────────────────────────────────────────────────────

function getPolicy(db, entityType, action) {
  return db.prepare(`
    SELECT * FROM approval_policies
    WHERE entity_type = ? AND action = ? AND is_active = 1
  `).get(entityType, action);
}

function getPlatformConfig(db, key) {
  try {
    const row = db.prepare('SELECT config_value, config_type FROM platform_config WHERE config_key = ?').get(key);
    if (!row) return null;
    if (row.config_type === 'number') return parseInt(row.config_value);
    if (row.config_type === 'boolean') return row.config_value === 'true';
    if (row.config_type === 'json') return JSON.parse(row.config_value);
    return row.config_value;
  } catch (_) {
    return null;
  }
}

// ─── Check If Approval Is Needed ─────────────────────────────────────────────

function requiresApproval(db, entityType, action, amountCents = null) {
  const enabled = getPlatformConfig(db, 'approval_enabled');
  if (enabled === false) return { required: false, reason: 'Approval system disabled' };

  const policy = getPolicy(db, entityType, action);
  if (!policy) return { required: false, reason: 'No policy defined' };
  if (!policy.approval_required) return { required: false, reason: 'Policy set to auto-approve' };

  // Check auto-approve threshold
  if (policy.auto_approve_below_cents && amountCents !== null && amountCents < policy.auto_approve_below_cents) {
    return { required: false, reason: `Below auto-approve threshold ($${(policy.auto_approve_below_cents / 100).toFixed(2)})`, policy };
  }

  // Check amount threshold
  if (policy.amount_threshold_cents && amountCents !== null && amountCents < policy.amount_threshold_cents) {
    return { required: false, reason: `Below approval threshold ($${(policy.amount_threshold_cents / 100).toFixed(2)})`, policy };
  }

  return {
    required: true,
    tier: policy.approval_tier,
    min_approvers: policy.min_approvers,
    policy,
  };
}

// ─── Submit Approval Request ─────────────────────────────────────────────────

function submitApprovalRequest(db, { entityType, entityId, action, summary, details, amountCents, submittedBy, priority }) {
  const check = requiresApproval(db, entityType, action, amountCents);

  if (!check.required) {
    // Auto-approve and log
    insertAuditLog(db, null, 'auto_approved', submittedBy || 'system', JSON.stringify({ entityType, entityId, action, reason: check.reason }));
    return { approved: true, auto: true, reason: check.reason };
  }

  // Deduplication: return existing pending request instead of creating a duplicate
  const existing = db.prepare(
    "SELECT * FROM approval_requests WHERE entity_type = ? AND entity_id = ? AND action = ? AND status IN ('pending', 'escalated')"
  ).get(entityType, entityId, action);
  if (existing) {
    return {
      approved: false,
      pending: true,
      request: existing,
      tier: check.tier,
      min_approvers: check.min_approvers,
      message: `Existing ${check.tier} approval request pending (${existing.request_number})`,
      duplicate: true,
    };
  }

  const requestNumber = generateRequestNumber();
  const expiryHours = getPlatformConfig(db, 'approval_expiry_hours') || 48;
  const expiresAt = new Date(Date.now() + expiryHours * 3600000).toISOString();

  const result = db.prepare(`
    INSERT INTO approval_requests
      (request_number, policy_id, entity_type, entity_id, action, status, priority,
       amount_cents, summary, details, submitted_by, expires_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    requestNumber,
    check.policy ? check.policy.id : null,
    entityType, entityId, action,
    priority || 'normal',
    amountCents || null,
    summary,
    typeof details === 'string' ? details : JSON.stringify(details),
    submittedBy || 'system',
    expiresAt,
  );

  const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(result.lastInsertRowid);

  insertAuditLog(db, request.id, 'submitted', submittedBy || 'system', JSON.stringify({ entityType, entityId, action, summary }));

  return {
    approved: false,
    pending: true,
    request,
    tier: check.tier,
    min_approvers: check.min_approvers,
    message: `Requires ${check.tier} trustee approval`,
  };
}

// ─── Approve / Reject Request ────────────────────────────────────────────────

function approveRequest(db, requestId, { decidedBy, decidedRole, reason }) {
  const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId);
  if (!request) throw new Error('Approval request not found');
  if (request.status !== 'pending' && request.status !== 'escalated') {
    throw new Error(`Cannot approve — request is ${request.status}`);
  }

  // Record the decision
  db.prepare(`
    INSERT INTO approval_decisions (request_id, decision, decided_by, decided_role, reason, tier)
    VALUES (?, 'approved', ?, ?, ?, ?)
  `).run(requestId, decidedBy, decidedRole || 'trustee', reason || null, 'first');

  // Check if enough approvals
  const policy = request.policy_id ? db.prepare('SELECT * FROM approval_policies WHERE id = ?').get(request.policy_id) : null;
  const minApprovers = policy ? policy.min_approvers : 1;
  const approvalCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM approval_decisions WHERE request_id = ? AND decision = 'approved'
  `).get(requestId).cnt;

  if (approvalCount >= minApprovers) {
    // Fully approved
    db.prepare(`
      UPDATE approval_requests
      SET status = 'approved', resolved_at = datetime('now'), resolved_by = ?, resolution_notes = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(decidedBy, reason || 'Approved', requestId);

    insertAuditLog(db, requestId, 'approved', decidedBy, JSON.stringify({ role: decidedRole, reason, approval_count: approvalCount }));

    // Execute the post-approval action
    const result = executeApprovedAction(db, request);
    return { approved: true, request: { ...request, status: 'approved' }, execution: result };
  }

  // Needs more approvals (dual/committee)
  insertAuditLog(db, requestId, 'partial_approved', decidedBy, JSON.stringify({ approval_count: approvalCount, needed: minApprovers }));
  return {
    approved: false,
    partial: true,
    approvals: approvalCount,
    needed: minApprovers,
    message: `${approvalCount}/${minApprovers} approvals received`,
  };
}

function rejectRequest(db, requestId, { decidedBy, decidedRole, reason }) {
  const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId);
  if (!request) throw new Error('Approval request not found');
  if (request.status !== 'pending' && request.status !== 'escalated') {
    throw new Error(`Cannot reject — request is ${request.status}`);
  }

  db.prepare(`
    INSERT INTO approval_decisions (request_id, decision, decided_by, decided_role, reason)
    VALUES (?, 'rejected', ?, ?, ?)
  `).run(requestId, decidedBy, decidedRole || 'trustee', reason);

  db.prepare(`
    UPDATE approval_requests
    SET status = 'rejected', resolved_at = datetime('now'), resolved_by = ?, resolution_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(decidedBy, reason, requestId);

  // Revert entity status if needed
  revertPendingEntity(db, request);

  insertAuditLog(db, requestId, 'rejected', decidedBy, JSON.stringify({ role: decidedRole, reason }));
  return { rejected: true, request: { ...request, status: 'rejected' } };
}

// ─── Execute Post-Approval Actions ───────────────────────────────────────────

function executeApprovedAction(db, request) {
  try {
    const { entity_type, entity_id, action } = request;

    if (entity_type === 'account') {
      if (action === 'create' || action === 'activate') {
        db.prepare("UPDATE trust_accounts SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(entity_id);
        return { executed: true, message: 'Account activated' };
      }
      if (action === 'close') {
        db.prepare("UPDATE trust_accounts SET status = 'closed', closed_date = date('now'), updated_at = datetime('now') WHERE id = ?").run(entity_id);
        return { executed: true, message: 'Account closed' };
      }
      if (action === 'freeze') {
        db.prepare("UPDATE trust_accounts SET status = 'frozen', updated_at = datetime('now') WHERE id = ?").run(entity_id);
        return { executed: true, message: 'Account frozen' };
      }
    }

    if (entity_type === 'external_transfer') {
      if (action === 'create') {
        db.prepare("UPDATE external_transfers SET status = 'approved', approved_by = 'trustee', approved_date = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(entity_id);
        return { executed: true, message: 'Transfer approved for processing' };
      }
      if (action === 'process') {
        db.prepare("UPDATE external_transfers SET status = 'processing', approved_by = 'trustee', approved_date = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(entity_id);
        return { executed: true, message: 'Transfer approved — now processing' };
      }
    }

    if (entity_type === 'config') {
      // Config changes are applied when the details are saved
      if (request.details) {
        try {
          const changes = JSON.parse(request.details);
          if (changes.config_key && changes.config_value !== undefined) {
            db.prepare("UPDATE platform_config SET config_value = ?, updated_by = 'trustee_approved', updated_at = datetime('now') WHERE config_key = ?")
              .run(String(changes.config_value), changes.config_key);
            return { executed: true, message: `Config ${changes.config_key} updated` };
          }
        } catch (_) {}
      }
      return { executed: true, message: 'Configuration change approved' };
    }

    return { executed: false, message: 'No post-approval action defined' };
  } catch (err) {
    return { executed: false, error: err.message };
  }
}

function revertPendingEntity(db, request) {
  try {
    if (request.entity_type === 'account' && request.action === 'create') {
      db.prepare("UPDATE trust_accounts SET status = 'rejected', status_reason = 'Trustee rejected', updated_at = datetime('now') WHERE id = ? AND status = 'pending_approval'").run(request.entity_id);
    }
    if (request.entity_type === 'external_transfer') {
      db.prepare("UPDATE external_transfers SET status = 'rejected', rejected_by = 'trustee', rejected_date = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(request.entity_id);
    }
  } catch (_) {}
}

// ─── List / Query Requests ───────────────────────────────────────────────────

function listApprovalRequests(db, { status, entityType, limit = 50 } = {}) {
  let where = [];
  let params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`SELECT * FROM approval_requests ${clause} ORDER BY submitted_at DESC LIMIT ?`).all(...params, limit);
}

function getApprovalRequest(db, requestId) {
  const request = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId);
  if (!request) return null;
  const decisions = db.prepare('SELECT * FROM approval_decisions WHERE request_id = ? ORDER BY created_at').all(requestId);
  const auditLog = db.prepare('SELECT * FROM approval_audit_log WHERE request_id = ? ORDER BY created_at').all(requestId);
  return { ...request, decisions, audit_log: auditLog };
}

// ─── Policy Management ──────────────────────────────────────────────────────

function listPolicies(db) {
  return db.prepare('SELECT * FROM approval_policies ORDER BY entity_type, action').all();
}

function updatePolicy(db, policyId, updates) {
  const allowedFields = ['approval_required', 'approval_tier', 'min_approvers', 'auto_approve_below_cents', 'amount_threshold_cents', 'escalation_hours', 'is_active'];
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (!sets.length) return null;
  sets.push("updated_at = datetime('now')");
  params.push(policyId);
  db.prepare(`UPDATE approval_policies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM approval_policies WHERE id = ?').get(policyId);
}

// ─── Audit Log ──────────────────────────────────────────────────────────────

function insertAuditLog(db, requestId, eventType, actor, details) {
  db.prepare(`
    INSERT INTO approval_audit_log (request_id, event_type, actor, details)
    VALUES (?, ?, ?, ?)
  `).run(requestId, eventType, actor, details || null);
}

function getAuditLog(db, { requestId, eventType, limit = 100 } = {}) {
  let where = [];
  let params = [];
  if (requestId) { where.push('request_id = ?'); params.push(requestId); }
  if (eventType) { where.push('event_type = ?'); params.push(eventType); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`SELECT * FROM approval_audit_log ${clause} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
}

// ─── Expire Old Requests ────────────────────────────────────────────────────

function expireStaleRequests(db) {
  const result = db.prepare(`
    UPDATE approval_requests
    SET status = 'expired', resolved_at = datetime('now'), resolution_notes = 'Auto-expired', updated_at = datetime('now')
    WHERE status = 'pending' AND expires_at < datetime('now')
  `).run();
  return result.changes;
}

// ─── Dashboard Stats ────────────────────────────────────────────────────────

function getApprovalStats(db) {
  const pending = db.prepare("SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'pending'").get().cnt;
  const approved = db.prepare("SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'approved'").get().cnt;
  const rejected = db.prepare("SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'rejected'").get().cnt;
  const expired = db.prepare("SELECT COUNT(*) AS cnt FROM approval_requests WHERE status = 'expired'").get().cnt;
  const total = db.prepare("SELECT COUNT(*) AS cnt FROM approval_requests").get().cnt;
  const recentPending = db.prepare("SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY submitted_at DESC LIMIT 10").all();
  return { pending, approved, rejected, expired, total, recent_pending: recentPending };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  initApprovalSchema,
  requiresApproval,
  submitApprovalRequest,
  approveRequest,
  rejectRequest,
  listApprovalRequests,
  getApprovalRequest,
  listPolicies,
  updatePolicy,
  getAuditLog,
  expireStaleRequests,
  getApprovalStats,
  getPlatformConfig,
  generateRequestNumber,
};

'use strict';

/**
 * On-Chain FinOps AI Agent — DLB Trust Platform
 *
 * Receives natural-language instructions, translates them into structured
 * financial operations, and executes them only after two trustees
 * (Administration + Distribution) approve. Integrates treasury, core banking,
 * bond/fixed income, trust accounting, cash, CRM, stablecoin DEX, Safe, calendar,
 * messaging, and document modules.
 */

const pool = require('../bonds/pgPool');

let StablecoinDexEngine, DappEngine, PayoutCenterEngine, SourceOfFundsAdapter, CalendarEngine, MessagingEngine, DocumentEngine, GenerationEngine;
try { StablecoinDexEngine = require('../dapp/stablecoinDexEngine').StablecoinDexEngine; } catch (e) { /* optional */ }
try { DappEngine = require('../dapp/dappEngine').DappEngine; } catch (e) { /* optional */ }
try { PayoutCenterEngine = require('../dapp/payoutCenterEngine').PayoutCenterEngine; } catch (e) { /* optional */ }
try { SourceOfFundsAdapter = require('../stablecoin/sourceOfFundsAdapter').SourceOfFundsAdapter; } catch (e) { /* optional */ }
try { CalendarEngine = require('../calendar/calendarEngine').CalendarEngine; } catch (e) { /* optional */ }
try { MessagingEngine = require('../messaging/messagingEngine').MessagingEngine; } catch (e) { /* optional */ }
try { DocumentEngine = require('../documents/documentEngine').DocumentEngine; } catch (e) { /* optional */ }
try { GenerationEngine = require('../documents/generationEngine').GenerationEngine; } catch (e) { /* optional */ }

const { TRUSTEES, REQUIRED_ROLES, normalizeRole, getTrusteeByRole } = require('../dapp/trustees');

function id(prefix = 'FINOPS') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function jsonb(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') return JSON.parse(raw || '{}');
  return raw;
}

function normalizeAsset(word) {
  const w = String(word || '').toUpperCase();
  if (['USD','USDC','USDS','DAI','BUSD'].includes(w)) return 'USDC';
  if (['DLBUSD','DLB','STABLECOIN'].includes(w)) return 'DLBUSD';
  if (['ETH','ETHER','ETHEREUM'].includes(w)) return 'ETH';
  if (['HBAR','HEDERA','HASHGRAPH'].includes(w)) return 'HBAR';
  return w || 'USDC';
}

class FinOpsAgent {

  static getTrustees() { return TRUSTEES; }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finops_tasks (
        id              TEXT PRIMARY KEY,
        prompt          TEXT NOT NULL,
        intent          JSONB DEFAULT '{}',
        status          TEXT DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected','executing','executed','failed')),
        required_roles  JSONB DEFAULT '["administration","distribution"]',
        approvals       JSONB DEFAULT '[]',
        result          JSONB DEFAULT '{}',
        tx_hash         TEXT,
        requested_by    TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_finops_tasks_status ON finops_tasks(status)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Natural-language parser
  // ═══════════════════════════════════════════════════════════════════════════

  static parsePrompt(prompt) {
    if (!prompt || typeof prompt !== 'string') throw new Error('prompt is required');
    const text = prompt.trim();
    const lower = text.toLowerCase();

    let action = 'overview';
    if (/\b(pay|send|transfer|payout|payment)\b/.test(lower)) action = 'payment';
    else if (/\b(distribute|distribution|split among|pay out to)\b/.test(lower)) action = 'distribution';
    else if (/\b(swap|exchange|convert)\b/.test(lower)) action = 'dex_swap';
    else if (/\b(create|deploy|new)\b.*\b(safe|wallet|multisig)\b/.test(lower) || /\bsafe wallet\b/.test(lower)) action = 'create_safe';
    else if (/\b(schedule|calendar|remind|reminder|meeting|appointment)\b/.test(lower)) action = 'schedule';
    else if (/\b(generate|create|draft)\b.*\b(document|report|letter|notice|k-1|form 1041)\b/.test(lower) || /\bdocument\b/.test(lower)) action = 'document';
    else if (/\b(status|overview|summary|health|check|balances|portfolio)\b/.test(lower)) action = 'overview';

    const amountMatch = text.match(/\$?\b(\d+(?:\.\d{1,6})?)\b/);
    const amount = amountMatch ? Number(amountMatch[1]) : null;

    const assetMatch = text.match(/\b(USDC|USDS|DLBUSD|ETH|HBAR|USD|DAI|BUSD)\b/i);
    const asset = assetMatch ? normalizeAsset(assetMatch[1]) : (action === 'dex_swap' ? 'USDC' : 'USDC');

    const ethAddr = text.match(/0x[a-fA-F0-9]{40}/);
    const hederaAddr = text.match(/0\.0\.\d+/);
    const destination = ethAddr ? ethAddr[0] : (hederaAddr ? hederaAddr[0] : null);

    const sourceMatch = text.match(/from\s+(?:(cash|trust|bond|sub_ledger|core_banking|treasury|fixed_income|crm)\s*[:\s]\s*([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+))/i);
    let sourceType = null;
    let sourceAccountId = null;
    if (sourceMatch) {
      sourceType = (sourceMatch[1] || 'cash').toLowerCase();
      sourceAccountId = sourceMatch[2] || sourceMatch[3];
    }

    const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)\b/);
    const date = dateMatch ? dateMatch[1] : null;

    const titleMatch = text.match(/(?:schedule|calendar|meeting|reminder|document|generate|create|title)\s+["']?([^"']{3,120})["']?/i);
    const title = titleMatch ? titleMatch[1].trim() : text.slice(0, 80);

    const beneficiaries = [];
    if (action === 'distribution') {
      const toClause = text.match(/to\s+(.+?)(?:from|on\s|$)/i);
      if (toClause) {
        const parts = toClause[1].split(/,|;|\band\b/i).map(s => s.trim()).filter(Boolean);
        for (const p of parts) {
          const addr = p.match(/0x[a-fA-F0-9]{40}/);
          const amt = p.match(/\$?\b(\d+(?:\.\d+)?)\b/);
          beneficiaries.push({
            name: p.replace(/0x[a-fA-F0-9]{40}|\$?\b\d+(?:\.\d+)?\b/g, '').trim() || 'Beneficiary',
            address: addr ? addr[0] : null,
            amountUsd: amt ? Number(amt[1]) : amount,
          });
        }
      }
      if (!beneficiaries.length && destination) beneficiaries.push({ name: 'Recipient', address: destination, amountUsd: amount });
    }

    let targetAsset = 'USDC';
    if (action === 'dex_swap') {
      const toAsset = text.match(/(?:for|to|into)\s+(USDC|USDS|ETH|DLBUSD|USD)\b/i);
      targetAsset = toAsset ? normalizeAsset(toAsset[1]) : 'USDC';
    }

    return {
      action,
      amount,
      asset,
      targetAsset,
      destination,
      sourceType,
      sourceAccountId,
      date,
      title,
      beneficiaries,
      raw: text,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Task lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  static async createTask({ prompt, requestedBy = 'dapp' }) {
    await this.ensureTables();
    const intent = this.parsePrompt(prompt);
    const taskId = id();
    const approvals = REQUIRED_ROLES.map(role => {
      const trustee = TRUSTEES.find(t => t.role === role);
      return { role: role, status: 'pending', trusteeEmail: trustee.email, trusteeName: trustee.name, signature: null, approvedAt: null };
    });

    await pool.query(
      `INSERT INTO finops_tasks (id, prompt, intent, status, required_roles, approvals, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [taskId, prompt, JSON.stringify(intent), 'pending_approval', JSON.stringify(REQUIRED_ROLES), JSON.stringify(approvals), requestedBy]
    );

    const task = await this.getTask(taskId);
    if (CalendarEngine) {
      try { await CalendarEngine.scheduleFromTask({ ...task, approvals, intent }); } catch (e) { /* non-blocking */ }
    }
    if (MessagingEngine) {
      try {
        await MessagingEngine.notify({
          subject: `FinOps task ${taskId} requires approval`,
          body: `Task: ${prompt}\nIntent: ${JSON.stringify(intent, null, 2)}`,
          participants: TRUSTEES.map(t => t.email),
          referenceType: 'finops_task',
          referenceId: taskId,
        });
      } catch (e) { /* non-blocking */ }
    }
    return task;
  }

  static async getTask(id) {
    await this.ensureTables();
    const result = await pool.query('SELECT * FROM finops_tasks WHERE id = $1', [id]);
    if (!result.rows.length) return null;
    const row = result.rows[0];
    row.intent = jsonb(row.intent);
    row.approvals = jsonb(row.approvals);
    row.required_roles = jsonb(row.required_roles);
    row.result = jsonb(row.result);
    return row;
  }

  static async listTasks({ status, limit = 50, offset = 0 } = {}) {
    await this.ensureTables();
    const where = status ? 'WHERE status = $1' : '';
    const params = status ? [status] : [];
    const result = await pool.query(
      `SELECT * FROM finops_tasks ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return result.rows.map(r => {
      r.intent = jsonb(r.intent);
      r.approvals = jsonb(r.approvals);
      r.required_roles = jsonb(r.required_roles);
      r.result = jsonb(r.result);
      return r;
    });
  }

  static async approveTask({ taskId, role, trusteeEmail, signature, signerName }) {
    await this.ensureTables();
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status === 'executed') throw new Error('Task already executed');

    const roleKey = normalizeRole(role);
    const expected = getTrusteeByRole(roleKey);
    if (!expected) throw new Error(`Unknown role ${role}`);
    if (expected.email.toLowerCase() !== String(trusteeEmail).toLowerCase()) {
      throw new Error(`Email ${trusteeEmail} is not authorized for role ${role} (expected ${expected.email})`);
    }

    const approvals = task.approvals || [];
    const existing = approvals.find(a => a.role === roleKey && a.status === 'approved');
    if (existing) throw new Error(`Role ${role} already approved`);

    const idx = approvals.findIndex(a => a.role === roleKey);
    if (idx < 0) throw new Error(`Role ${role} not required`);

    approvals[idx] = {
      ...approvals[idx],
      status: 'approved',
      trusteeEmail,
      trusteeName: signerName || expected.name,
      signature: signature || `sig-${roleKey}-${Date.now()}`,
      approvedAt: new Date().toISOString(),
    };

    const allApproved = REQUIRED_ROLES.every(r => (approvals.find(a => a.role === r) || {}).status === 'approved');
    let newStatus = task.status;
    if (allApproved) newStatus = 'approved';

    await pool.query(
      `UPDATE finops_tasks SET approvals = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(approvals), newStatus, taskId]
    );

    const updated = await this.getTask(taskId);
    if (MessagingEngine) {
      await MessagingEngine.notify({
        subject: `FinOps task ${taskId} — ${role} approved`,
        body: `${signerName || expected.name} (${trusteeEmail}) approved role ${role}.\nStatus: ${updated.status}`,
        participants: TRUSTEES.map(t => t.email),
        referenceType: 'finops_task',
        referenceId: taskId,
      }).catch(() => {});
    }

    if (updated.status === 'approved') {
      updated.approvals = approvals;
      await this.executeTask(taskId);
    }

    return this.getTask(taskId);
  }

  static async rejectTask({ taskId, role, trusteeEmail, reason }) {
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    const roleKey = normalizeRole(role);
    const expected = getTrusteeByRole(roleKey);
    if (!expected || expected.email.toLowerCase() !== trusteeEmail.toLowerCase()) throw new Error(`Email ${trusteeEmail} is not authorized for role ${role} (expected ${expected.email})`);
    const approvals = task.approvals || [];
    const idx = approvals.findIndex(a => a.role === roleKey);
    if (idx >= 0) approvals[idx] = { ...approvals[idx], status: 'rejected', signature: null, approvedAt: null, reason };
    await pool.query(
      `UPDATE finops_tasks SET approvals = $1, status = 'rejected', updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(approvals), taskId]
    );
    return this.getTask(taskId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Execution
  // ═══════════════════════════════════════════════════════════════════════════

  static async executeTask(taskId) {
    await this.ensureTables();
    const task = await this.getTask(taskId);
    if (!task) throw new Error('Task not found');
    const intent = task.intent || {};

    await pool.query(`UPDATE finops_tasks SET status = 'executing', updated_at = NOW() WHERE id = $1`, [taskId]);

    let result = {};
    let txHash = null;
    let status = 'executed';

    try {
      switch (intent.action) {
        case 'payment':
          result = await this.executePayment(intent);
          txHash = result.tx_hash || (result.result ? result.result.txHash : null) || (result.swap ? result.swap.swapHash || result.swap.transferHash || result.swap.txHash : null);
          break;
        case 'distribution':
          result = await this.executeDistribution(intent);
          txHash = result.txHash || result.tx_hash;
          break;
        case 'dex_swap':
          result = await this.executeDexSwap(intent);
          txHash = result.tx_hash || (result.result ? result.result.txHash : null) || (result.swap ? result.swap.swapHash || result.swap.transferHash || result.swap.txHash : null);
          break;
        case 'create_safe':
          result = await this.executeCreateSafe(intent);
          txHash = result.txHash;
          break;
        case 'schedule':
          result = await this.executeSchedule(intent, taskId);
          break;
        case 'document':
          result = await this.executeDocument(intent, taskId);
          break;
        case 'overview':
        default:
          result = await this.executeOverview(intent);
          break;
      }
    } catch (err) {
      status = 'failed';
      result = { error: err.message, stack: err.stack };
      console.error('[FinOpsAgent] execute failed:', err);
    }

    await pool.query(
      `UPDATE finops_tasks SET status = $1, result = $2, tx_hash = $3, updated_at = NOW() WHERE id = $4`,
      [status, JSON.stringify(result), txHash, taskId]
    );

    const updated = await this.getTask(taskId);
    if (MessagingEngine) {
      await MessagingEngine.notify({
        subject: `FinOps task ${taskId} — ${status}`,
        body: `Task "${task.prompt}" is now ${status}.\nResult: ${JSON.stringify(result, null, 2).slice(0, 1000)}`,
        participants: TRUSTEES.map(t => t.email),
        referenceType: 'finops_task',
        referenceId: taskId,
      }).catch(() => {});
    }
    return updated;
  }

  static _defaultSource(intent) {
    return {
      sourceType: intent.sourceType || process.env.FINOPS_DEFAULT_SOURCE_TYPE || 'cash',
      sourceAccountId: intent.sourceAccountId || process.env.FINOPS_DEFAULT_SOURCE_ACCOUNT || 'CA-OPERATING',
    };
  }

  static _defaultPool() {
    return process.env.BOND_DEX_ADDRESS || process.env.DEX_SWAP_ROUTER || '';
  }

  static async executePayment(intent) {
    if (!intent.amount || !intent.destination) throw new Error('payment requires amount and destination');
    if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');
    const { sourceType, sourceAccountId } = this._defaultSource(intent);
    const asset = this._realisticAsset(intent.asset || 'SIT');
    const result = await PayoutCenterEngine.createPayment({
      paymentType: 'payment',
      sourceType,
      sourceAccountId,
      recipientType: 'external',
      recipientIdentifier: intent.destination,
      amount: intent.amount,
      asset,
      description: intent.prompt || `FinOps payment to ${intent.destination}`,
      rail: asset === 'SIT' ? 'sit' : 'dex',
      railOptions: { createPoolIfMissing: true, poolSeedUsdc: 0.005, poolSeedDlbusd: 10 },
    });
    return result;
  }

  static async executeDistribution(intent) {
    if (!intent.beneficiaries || !intent.beneficiaries.length) throw new Error('distribution requires beneficiaries');
    if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');
    const { sourceType, sourceAccountId } = this._defaultSource(intent);
    const asset = this._realisticAsset(intent.asset || 'SIT');
    const rail = asset === 'SIT' ? 'sit' : 'dex';
    const receipts = [];
    for (const b of intent.beneficiaries) {
      if (!b.address || !b.amountUsd) continue;
      const r = await PayoutCenterEngine.createPayment({
        paymentType: 'distribution',
        sourceType,
        sourceAccountId,
        recipientType: 'external',
        recipientIdentifier: b.address,
        amount: b.amountUsd,
        asset,
        description: intent.prompt || `FinOps distribution to ${b.address}`,
        rail,
        railOptions: { createPoolIfMissing: true, poolSeedUsdc: 0.005, poolSeedDlbusd: 10 },
      });
      receipts.push({ beneficiary: b, ...r });
    }
    return { beneficiaries: receipts, txHash: receipts.length ? receipts[0].tx_hash : null };
  }

  static async executeDexSwap(intent) {
    if (!intent.amount) throw new Error('dex_swap requires amount');
    if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');
    const { sourceType, sourceAccountId } = this._defaultSource(intent);
    const asset = this._realisticAsset(intent.targetAsset || intent.asset || 'ETH');
    const result = await PayoutCenterEngine.createPayment({
      paymentType: 'dex_swap',
      sourceType,
      sourceAccountId,
      recipientType: 'external',
      recipientIdentifier: intent.destination || sourceAccountId,
      amount: intent.amount,
      asset,
      description: intent.prompt || `FinOps DEX swap to ${asset}`,
      rail: asset === 'SIT' ? 'sit' : 'dex',
      railOptions: { createPoolIfMissing: true, poolSeedUsdc: 0.005, poolSeedDlbusd: 10 },
    });
    return result;
  }

  static _realisticAsset(asset) {
    // USDC payouts need a pre-funded DLBUSD/USDC pool; route to ETH or SIT until that pool exists.
    const a = String(asset).toUpperCase();
    if (['USDC','USD','USDS','DAI','BUSD'].includes(a)) return process.env.DLBUSD_USDC_POOL ? 'USDC' : 'SIT';
    if (['DLBUSD','DLB','STABLECOIN'].includes(a)) return 'SIT';
    if (['ETH','ETHER','ETHEREUM','WETH'].includes(a)) return 'ETH';
    if (['SIT','SOVEREIGN'].includes(a)) return 'SIT';
    return a || 'SIT';
  }

  static async executeCreateSafe(intent) {
    if (!DappEngine) throw new Error('DappEngine not available');
    const owners = [process.env.DAPP_OPERATOR_ADDRESS || '0x0000000000000000000000000000000000000000'];
    const result = await DappEngine.createSafe({
      label: intent.title || `FinOps Safe ${id('SAFE')}`,
      owners,
      threshold: 1,
      deployNow: false,
    });
    return result;
  }

  static async executeSchedule(intent, taskId) {
    if (!CalendarEngine) throw new Error('CalendarEngine not available');
    const start = intent.date ? new Date(intent.date) : new Date(Date.now() + 24 * 60 * 60 * 1000);
    const event = await CalendarEngine.createEvent({
      title: intent.title || 'FinOps scheduled event',
      description: intent.raw,
      start,
      end: new Date(start.getTime() + 60 * 60 * 1000),
      eventType: 'general',
      relatedModule: 'finops',
      referenceId: taskId,
      createdBy: 'finops_agent',
    });
    return { event };
  }

  static async executeDocument(intent, taskId) {
    if (!DocumentEngine) throw new Error('DocumentEngine not available');
    const docType = /1041/i.test(intent.raw) ? 'tax_form' : (/k-?1/i.test(intent.raw) ? 'tax_form' : 'payment_confirmation');
    const category = /tax/i.test(intent.raw) ? 'tax' : 'financial';
    const content = `Generated by FinOps Agent for task ${taskId}\nPrompt: ${intent.raw}`;
    const doc = await DocumentEngine.createDocument({
      documentName: intent.title || `FinOps document ${taskId}`,
      documentType: docType,
      category,
      content,
      contentType: 'text/plain',
      referenceType: 'finops_task',
      referenceId: taskId,
      tags: ['finops', 'auto-generated'],
      metadata: { intent },
      createdBy: 'finops_agent',
    });
    return { document: doc };
  }

  static async executeOverview() {
    const summary = { modules: {}, timestamp: new Date().toISOString() };
    try { if (DappEngine) summary.modules.safes = await DappEngine.listSafes(); } catch (e) {}
    try { if (DappEngine) summary.modules.payouts = (await DappEngine.listPayouts()).slice(0, 5); } catch (e) {}
    try { if (DappEngine) summary.modules.distributions = (await DappEngine.listDistributions()).slice(0, 5); } catch (e) {}
    try { if (StablecoinDexEngine) summary.modules.stablecoinDex = StablecoinDexEngine.readiness(); } catch (e) {}
    try { if (DappEngine) summary.modules.sourceOfFunds = await DappEngine.listSourceBalances(); } catch (e) {}
    try { if (CalendarEngine) summary.modules.events = (await CalendarEngine.listEvents({ limit: 5 })).slice(0, 5); } catch (e) {}
    try { if (DocumentEngine) summary.modules.documents = (await DocumentEngine.listDocuments({ limit: 5 })).slice(0, 5); } catch (e) {}
    return summary;
  }
}

module.exports = { FinOpsAgent };

'use strict';

/**
 * Asset-to-Debt Proof Engine
 *
 * Computes a signed statement of the trust's net worth by aggregating
 * source-of-funds module balances (Treasury, Core Banking, Bond/Fixed Income,
 * Trust Accounting, Cash, Sub-Ledger, CRM) and subtracting recorded liabilities.
 *
 * Requires two-trustee (Administration + Distribution) signatures to certify.
 */

const crypto = require('crypto');
let viem;
try { viem = require('viem'); } catch (e) { viem = null; }

const { TRUSTEES, REQUIRED_ROLES, validateTrustee } = require('../dapp/trustees');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }
if (process.env.DAPP_MEMORY_MODE === 'true') pool = null;

let DappEngine;
try { DappEngine = require('../dapp/dappEngine').DappEngine; } catch (e) { DappEngine = null; }

let MessagingEngine;
try { MessagingEngine = require('../messaging/messagingEngine').MessagingEngine; } catch (e) { MessagingEngine = null; }

let CalendarEngine;
try { CalendarEngine = require('../calendar/calendarEngine').CalendarEngine; } catch (e) { CalendarEngine = null; }

function id(prefix = 'ADP') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function query(sql, params) {
  if (!pool || !pool.query) throw new Error('Postgres pool unavailable');
  return pool.query(sql, params);
}

async function withFallback(fn, fallback) {
  try { return await fn(); } catch (e) { if (!pool) return fallback(e); throw e; }
}

function jsonbValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return JSON.parse(raw || '{}');
  return raw;
}

function canonicalString(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function hashProof({ assets, liabilities, totalAssetsCents, totalLiabilitiesCents, netWorthCents, timestamp }) {
  const payload = canonicalString({ assets, liabilities, totalAssetsCents, totalLiabilitiesCents, netWorthCents, timestamp });
  if (viem) {
    return viem.keccak256(viem.stringToHex(payload));
  }
  return '0x' + crypto.createHash('sha256').update(payload).digest('hex');
}

function isBondDerivedSource(b) {
  if (b.type === 'cash' && b.account_type === 'bond_proceeds') return true;
  if (b.type === 'trust') {
    if (['1100', '1200', '4000', '4200'].includes(b.id)) return true;
    if (['bond_investment', 'accrued_interest', 'realized_gain'].includes(b.sub_type)) return true;
  }
  if (b.type === 'sub_ledger') {
    if (b.parent_account_code === '1100' || b.sub_account_type === 'bond_investment' || b.sub_account_type === 'accrued_interest') return true;
  }
  return false;
}

function isNonAssetTrustAccount(b) {
  if (b.type !== 'trust') return false;
  return ['liability', 'equity', 'income', 'expense'].includes(b.account_type);
}

class AssetDebtProofEngine {

  static async ensureTables() {
    await withFallback(async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS asset_debt_proofs (
          id                TEXT PRIMARY KEY,
          total_assets_cents   BIGINT NOT NULL DEFAULT 0,
          total_liabilities_cents BIGINT NOT NULL DEFAULT 0,
          net_worth_cents   BIGINT NOT NULL DEFAULT 0,
          assets            JSONB DEFAULT '[]',
          liabilities       JSONB DEFAULT '[]',
          proof_hash        TEXT,
          signatures        JSONB DEFAULT '[]',
          status            TEXT NOT NULL DEFAULT 'computed' CHECK (status IN ('computed','certified','rejected')),
          memo              TEXT,
          created_by        TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_asset_debt_proofs_status ON asset_debt_proofs(status)`);
    }, () => {});
  }

  static async _mem(op, ...args) {
    if (!AssetDebtProofEngine._memory) AssetDebtProofEngine._memory = new Map();
    if (op === 'set') { AssetDebtProofEngine._memory.set(args[0], args[1]); return args[1]; }
    if (op === 'get') return AssetDebtProofEngine._memory.get(args[0]) || null;
    if (op === 'list') return Array.from(AssetDebtProofEngine._memory.values());
    return null;
  }

  static async _insert(row) {
    return withFallback(async () => {
      const keys = Object.keys(row).filter(k => row[k] !== undefined);
      const cols = keys.join(',');
      const vals = keys.map((_, i) => `$${i + 1}`).join(',');
      const result = await query(`INSERT INTO asset_debt_proofs (${cols}) VALUES (${vals}) RETURNING *`, keys.map(k => {
        if (k === 'assets' || k === 'liabilities' || k === 'signatures') return JSON.stringify(row[k]);
        return row[k];
      }));
      return result.rows[0];
    }, async () => this._mem('set', row.id, row));
  }

  static async _update(id, updates) {
    return withFallback(async () => {
      const keys = Object.keys(updates).filter(k => updates[k] !== undefined);
      if (!keys.length) return this.getProof(id);
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(',');
      const values = keys.map(k => {
        if (k === 'assets' || k === 'liabilities' || k === 'signatures') return JSON.stringify(updates[k]);
        return updates[k];
      });
      const result = await query(`UPDATE asset_debt_proofs SET ${set}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`, [...values, id]);
      return result.rows[0];
    }, async () => {
      const row = await this._mem('get', id);
      if (!row) return null;
      Object.assign(row, updates);
      return this._mem('set', id, row);
    });
  }

  static _rowToObject(row) {
    if (!row) return null;
    return {
      ...row,
      assets: jsonbValue(row.assets) || [],
      liabilities: jsonbValue(row.liabilities) || [],
      signatures: jsonbValue(row.signatures) || [],
    };
  }

  static async getProof(id) {
    await this.ensureTables();
    return withFallback(async () => {
      const result = await query('SELECT * FROM asset_debt_proofs WHERE id = $1', [id]);
      return this._rowToObject(result.rows[0]);
    }, async () => this._rowToObject(await this._mem('get', id)));
  }

  static async listProofs(limit = 50) {
    await this.ensureTables();
    return withFallback(async () => {
      const result = await query('SELECT * FROM asset_debt_proofs ORDER BY created_at DESC LIMIT $1', [limit]);
      return result.rows.map(r => this._rowToObject(r));
    }, async () => (await this._mem('list')).slice(-limit));
  }

  /**
   * Compute an asset/debt proof from live source-of-funds balances.
   * `liabilities` is an array of { name, amount_cents, type? }.
   */
  static async computeProof({ liabilities = [], memo = '', includePendingLiabilities = false, includeHardAssets = false, createdBy = 'system' } = {}) {
    await this.ensureTables();

    const assets = [];
    let totalAssetsCents = 0;

    if (DappEngine) {
      try {
        const balances = await DappEngine.listSourceBalances();
        for (const b of balances) {
          const amountCents = Number(b.balance_cents || 0);
          if (amountCents === 0) continue;

          if (isBondDerivedSource(b)) continue;

          // Skip non-monetary sources like document counts
          if (b.currency === 'count' || b.type === 'documents') continue;

          if (b.type === 'trust' && b.account_type === 'liability') {
            liabilities.push({
              name: b.name || `${b.type}:${b.id}`,
              type: 'trust_liability',
              amount_cents: Math.round(amountCents),
              memo: `Trust accounting liability ${b.id}`,
            });
            continue;
          }

          if (isNonAssetTrustAccount(b)) continue;

          if (b.type === 'bond') {
            const accruedCents = Math.round(Number(b.accrued_interest_cents || 0));
            assets.push({
              ...b,
              source_type: 'bond',
              source_account_id: b.id || '',
              name: `${b.name || `Bond ${b.id}`} — principal`,
              balance_cents: amountCents,
              currency: b.currency || 'USD',
            });
            totalAssetsCents += amountCents;
            if (accruedCents > 0) {
              assets.push({
                ...b,
                source_type: 'bond',
                source_account_id: b.id || '',
                name: `${b.name || `Bond ${b.id}`} — accrued interest`,
                balance_cents: accruedCents,
                currency: b.currency || 'USD',
              });
              totalAssetsCents += accruedCents;
            }
            continue;
          }

          assets.push({
            ...b,
            source_type: b.type || 'unknown',
            source_account_id: b.id || '',
            name: b.name || `${b.type}:${b.id}`,
            balance_cents: amountCents,
            currency: b.currency || 'USD',
          });
          totalAssetsCents += amountCents;
        }
      } catch (e) {
        console.warn('[AssetDebtProofEngine] listSourceBalances failed:', e.message);
      }
    }

    // Include hard assets/liabilities (real estate, vehicles, equipment, loans, etc.)
    if (includeHardAssets) {
      let ExpenseManagementEngine;
      try { ExpenseManagementEngine = require('./expenseManagementEngine').ExpenseManagementEngine; } catch (e) {}
      if (!ExpenseManagementEngine) {
        console.warn('[AssetDebtProofEngine] ExpenseManagementEngine not available for hard assets');
      }
      try {
        const hardAssets = await ExpenseManagementEngine.listRecords({ type: 'asset', status: 'active', limit: 10000 });
        for (const ha of hardAssets) {
          const amountCents = Number(ha.amount_cents || 0);
          if (amountCents === 0) continue;
          assets.push({
            record_type: 'hard_asset',
            category: ha.category,
            name: ha.name,
            identifier: ha.identifier,
            linked_source_type: ha.linked_source_type,
            linked_source_account_id: ha.linked_source_account_id,
            balance_cents: amountCents,
            currency: ha.currency || 'USD',
          });
          totalAssetsCents += amountCents;
        }
        const hardLiabilities = await ExpenseManagementEngine.listRecords({ type: 'liability', status: 'active', limit: 10000 });
        for (const hl of hardLiabilities) {
          const amountCents = Number(hl.amount_cents || 0);
          if (amountCents === 0) continue;
          liabilities.push({
            record_type: 'hard_liability',
            category: hl.category,
            name: hl.name,
            identifier: hl.identifier,
            amount_cents: amountCents,
            currency: hl.currency || 'USD',
            memo: hl.description || '',
          });
        }
      } catch (e) {
        console.warn('[AssetDebtProofEngine] include hard assets failed:', e.message);
      }
    }

    // Normalize liabilities
    const normalizedLiabilities = (liabilities || []).map(l => ({
      name: l.name || 'Unnamed liability',
      type: l.type || 'other',
      amount_cents: Math.round(Number(l.amount_cents || l.amountCents || 0)),
      memo: l.memo || '',
    }));

    let totalLiabilitiesCents = normalizedLiabilities.reduce((s, l) => s + l.amount_cents, 0);

    if (includePendingLiabilities) {
      // Optional: include pending distribution requests as liabilities
      let DistributionRequestEngine;
      try { DistributionRequestEngine = require('../dapp/distributionRequestEngine').DistributionRequestEngine; } catch (e) {}
      if (DistributionRequestEngine) {
        try {
          const pending = (await DistributionRequestEngine.listRequests({ status: 'approved' }) || [])
            .filter(r => r.status === 'approved' && !r.payout_id);
          for (const r of pending) {
            normalizedLiabilities.push({
              name: `Pending ${r.type || 'request'} ${r.id}`,
              type: 'pending_distribution',
              amount_cents: Number(r.amount_cents || 0),
              memo: r.memo || '',
            });
            totalLiabilitiesCents += Number(r.amount_cents || 0);
          }
        } catch (e) {
          console.warn('[AssetDebtProofEngine] pending liabilities failed:', e.message);
        }
      }
    }

    const netWorthCents = totalAssetsCents - totalLiabilitiesCents;
    const timestamp = new Date().toISOString();
    const proofHash = hashProof({ assets, liabilities: normalizedLiabilities, totalAssetsCents, totalLiabilitiesCents, netWorthCents, timestamp });

    const row = {
      id: id(),
      total_assets_cents: totalAssetsCents,
      total_liabilities_cents: totalLiabilitiesCents,
      net_worth_cents: netWorthCents,
      assets,
      liabilities: normalizedLiabilities,
      proof_hash: proofHash,
      signatures: [],
      status: 'computed',
      memo: memo || null,
      created_by: createdBy,
      created_at: timestamp,
      updated_at: timestamp,
    };

    const inserted = await this._insert(row);
    const proof = this._rowToObject(inserted);

    // Notify via messaging and calendar
    try {
      if (MessagingEngine) {
        await MessagingEngine.notify({
          subject: `Asset-Debt Proof ${proof.id} computed`,
          body: `Net worth: $${(netWorthCents / 100).toFixed(2)}. Requires Administration + Distribution signatures to certify.`,
          participants: TRUSTEES.map(t => t.email),
          referenceType: 'asset_debt_proof',
          referenceId: proof.id,
          sender: 'Asset-Debt Proof Engine',
        });
      }
      if (CalendarEngine) {
        await CalendarEngine.createEvent({
          title: `Certify Asset-Debt Proof ${proof.id}`,
          description: `Net worth $${(netWorthCents / 100).toFixed(2)}. Awaiting two-trustee signatures.`,
          start: timestamp,
          eventType: 'review',
          relatedModule: 'asset_debt_proof',
          referenceId: proof.id,
          attendees: TRUSTEES.map(t => t.email),
          createdBy: 'Asset-Debt Proof Engine',
        });
      }
    } catch (e) { console.warn('[AssetDebtProofEngine] notification failed:', e.message); }

    return proof;
  }

  static async signProof(proofId, { role, trusteeEmail, signature, signerName } = {}) {
    await this.ensureTables();
    if (!role || !trusteeEmail) throw new Error('role and trusteeEmail required');
    const trustee = validateTrustee(role, trusteeEmail);

    const proof = await this.getProof(proofId);
    if (!proof) throw new Error('Proof not found');
    if (proof.status === 'rejected') throw new Error('Proof has been rejected');

    let validSig = signature;
    if (!validSig) validSig = `sig-${role}-${Date.now()}`;

    // If we have a blockchain address for the trustee, optionally verify the signature.
    if (viem && trustee.address && signature) {
      try {
        const recovered = await viem.recoverMessageAddress({ message: { raw: proof.proof_hash }, signature });
        if (recovered.toLowerCase() !== trustee.address.toLowerCase()) {
          throw new Error(`Signature does not match trustee address for ${role}`);
        }
      } catch (e) {
        if (e.message && e.message.includes('match')) throw e;
        console.warn('[AssetDebtProofEngine] signature recovery skipped:', e.message);
      }
    }

    const signatures = proof.signatures || [];
    const existing = signatures.find(s => s.role === role);
    if (existing) {
      existing.signature = validSig;
      existing.signerName = signerName || trustee.name;
      existing.signedAt = new Date().toISOString();
    } else {
      signatures.push({
        role,
        trusteeEmail,
        signerName: signerName || trustee.name,
        signature: validSig,
        signedAt: new Date().toISOString(),
      });
    }

    const certified = REQUIRED_ROLES.every(r => signatures.some(s => s.role === r && s.signature));
    const status = certified ? 'certified' : 'computed';

    const updated = await this._update(proofId, { signatures, status });

    if (MessagingEngine) {
      try {
        await MessagingEngine.notify({
          subject: `Asset-Debt Proof ${proofId} ${status === 'certified' ? 'certified' : `signed by ${role}`}`,
          body: `${trustee.name} (${role}) signed the proof. ${status === 'certified' ? 'Both signatures received; proof is now certified.' : 'Awaiting second trustee signature.'}`,
          participants: TRUSTEES.map(t => t.email),
          referenceType: 'asset_debt_proof',
          referenceId: proofId,
          sender: 'Asset-Debt Proof Engine',
        });
      } catch (e) { console.warn('[AssetDebtProofEngine] sign notify failed:', e.message); }
    }

    return this._rowToObject(updated);
  }

  static async rejectProof(proofId, { trusteeEmail, reason } = {}) {
    await this.ensureTables();
    if (!trusteeEmail) throw new Error('trusteeEmail required');
    const byAdmin = TRUSTEES.find(t => t.email.toLowerCase() === trusteeEmail.toLowerCase() && t.role === 'administration');
    if (!byAdmin) throw new Error('Only the Administration trustee can reject a proof');
    const updated = await this._update(proofId, { status: 'rejected', memo: reason || 'Rejected by Administration' });
    return this._rowToObject(updated);
  }

  static async getLatestCertified() {
    await this.ensureTables();
    return withFallback(async () => {
      const result = await query("SELECT * FROM asset_debt_proofs WHERE status = 'certified' ORDER BY created_at DESC LIMIT 1");
      return this._rowToObject(result.rows[0]);
    }, async () => {
      const all = (await this._mem('list'));
      return all.filter(p => p.status === 'certified').sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    });
  }
}

module.exports = { AssetDebtProofEngine };

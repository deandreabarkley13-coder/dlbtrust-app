'use strict';

/**
 * Custody OS Engine
 *
 * A custodian's operating system answers one question for every asset a trust
 * claims to own: who is holding it, under what evidence, and who signed for it.
 * Canonical had a ledger of balances and a reserve engine that reads external
 * custody, but nothing in between — no safekeeping record, no chain of title,
 * no dual-control receipt. This engine is that layer.
 *
 *   1. Custody accounts — where assets sit. Either `self_custody` (the PTC holds
 *      the asset itself) or `third_party` (a named custodian holds it for the
 *      trust, with an account reference).
 *   2. Positions — what is held in a custody account: cash, fixed income,
 *      digital assets, or physical property, each with a valuation.
 *   3. Safekeeping receipts — a position only reaches `receipted` control status
 *      when one trustee proposes it with documentary evidence and a second,
 *      distinct trustee countersigns. That is the same dual control the payment
 *      rails use, applied to custody.
 *   4. Chain of title — every action appends a hash-chained custody event, so a
 *      later edit to the history is detectable (`verifyChain()`).
 *   5. Reserve linkage — countersigning a receipt for a THIRD PARTY custody
 *      position records the matching reserve attestation automatically, so the
 *      reserve engine and the custody records can never disagree.
 *
 * The rule that makes the whole thing meaningful: a self-custody receipt never
 * produces a reserve attestation. The trust signing a statement that it holds
 * its own asset is not evidence of external backing, no matter how many
 * trustees sign it. Only a third-party custodian's statement moves the reserve.
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');

let ReserveEngine;
try { ({ ReserveEngine } = require('../finops/reserveEngine')); } catch (e) { ReserveEngine = null; }

const CUSTODY_TYPES = ['self_custody', 'third_party'];

const ASSET_CLASSES = ['cash', 'fixed_income', 'digital_asset', 'physical'];

const RECEIPT_ACTIONS = ['safekeeping', 'release', 'revaluation'];

/**
 * Which reserve source a countersigned third-party receipt records. Digital and
 * physical holdings are deliberately absent: an on-chain balance is verified by
 * reading the chain, not by a statement, and physical property is not a USD
 * reserve until it is sold.
 */
const RESERVE_SOURCE_BY_ASSET_CLASS = {
  cash: 'custodian_statement',
  fixed_income: 'securities_custodian',
};

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function cents(value) {
  return Math.round(Number(value || 0));
}

function dollars(value) {
  return Number(value || 0) / 100;
}

function requireText(value, message) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) throw new Error(message);
  return text;
}

/** Stable digest over the fields that make a custody event what it is. */
function hashEvent({ prevHash, eventType, custodyAccountId, positionId, receiptId, actor, payload, createdAt }) {
  return crypto.createHash('sha256').update(JSON.stringify([
    prevHash || '',
    eventType,
    custodyAccountId || '',
    positionId || '',
    receiptId || '',
    actor || '',
    payload || {},
    createdAt,
  ])).digest('hex');
}

class CustodyOsEngine {
  static config() {
    return {
      requiredSignatures: (() => {
        const n = Number(process.env.CUSTODY_REQUIRED_SIGNATURES);
        return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : 2;
      })(),
      reserveLinked: String(process.env.CUSTODY_RESERVE_SYNC || 'true').toLowerCase() !== 'false',
    };
  }

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS custody_accounts (
        custody_account_id    TEXT PRIMARY KEY,
        account_name          TEXT NOT NULL,
        custody_type          TEXT NOT NULL CHECK (custody_type IN ('self_custody','third_party')),
        custodian_name        TEXT,
        custodian_account_ref TEXT,
        jurisdiction          TEXT,
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
        notes                 TEXT,
        opened_by             TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS custody_positions (
        position_id        TEXT PRIMARY KEY,
        custody_account_id TEXT NOT NULL REFERENCES custody_accounts(custody_account_id),
        asset_class        TEXT NOT NULL
                           CHECK (asset_class IN ('cash','fixed_income','digital_asset','physical')),
        instrument_ref     TEXT NOT NULL,
        instrument_name    TEXT,
        quantity           NUMERIC(28,8) NOT NULL DEFAULT 0,
        valuation_cents    BIGINT NOT NULL DEFAULT 0,
        control_status     TEXT NOT NULL DEFAULT 'unverified'
                           CHECK (control_status IN ('unverified','receipted','released')),
        last_receipt_id    TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (custody_account_id, instrument_ref)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS custody_receipts (
        receipt_id             TEXT PRIMARY KEY,
        position_id            TEXT NOT NULL REFERENCES custody_positions(position_id),
        action                 TEXT NOT NULL CHECK (action IN ('safekeeping','release','revaluation')),
        valuation_cents        BIGINT NOT NULL DEFAULT 0,
        quantity               NUMERIC(28,8),
        evidence_reference     TEXT NOT NULL,
        proposed_by            TEXT NOT NULL,
        required_signatures    INTEGER NOT NULL DEFAULT 2,
        signatures             JSONB NOT NULL DEFAULT '[]',
        status                 TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','countersigned','void')),
        reserve_attestation_id TEXT,
        reserve_note           TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        settled_at             TIMESTAMPTZ
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS custody_events (
        sequence           BIGSERIAL PRIMARY KEY,
        event_id           TEXT UNIQUE NOT NULL,
        event_type         TEXT NOT NULL,
        custody_account_id TEXT,
        position_id        TEXT,
        receipt_id         TEXT,
        actor              TEXT,
        payload            JSONB NOT NULL DEFAULT '{}',
        prev_hash          TEXT,
        event_hash         TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_custody_positions_account
         ON custody_positions (custody_account_id)`
    );
    return true;
  }

  // ── Chain of title ─────────────────────────────────────────────────────────

  static async _appendEvent({ eventType, custodyAccountId = null, positionId = null, receiptId = null, actor = null, payload = {} }) {
    const tip = await pool.query(
      'SELECT event_hash FROM custody_events ORDER BY sequence DESC LIMIT 1'
    );
    const prevHash = (tip.rows[0] && tip.rows[0].event_hash) || null;
    const createdAt = new Date().toISOString();
    const eventId = id('CEV');
    const eventHash = hashEvent({
      prevHash, eventType, custodyAccountId, positionId, receiptId, actor, payload, createdAt,
    });
    const rows = await pool.query(
      `INSERT INTO custody_events
         (event_id, event_type, custody_account_id, position_id, receipt_id, actor,
          payload, prev_hash, event_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        eventId, eventType, custodyAccountId, positionId, receiptId, actor,
        JSON.stringify(payload), prevHash, eventHash, createdAt,
      ]
    );
    return rows.rows[0];
  }

  static async events({ limit = 100 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM custody_events ORDER BY sequence DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 100, 1), 1000)]
    );
    return rows.rows;
  }

  /**
   * Recompute the hash chain in order. A mismatch means a stored event was
   * altered or removed after the fact, which is exactly what a custody log has
   * to be able to prove.
   */
  static async verifyChain() {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM custody_events ORDER BY sequence ASC');
    let prevHash = null;
    const breaks = [];
    for (const row of rows.rows) {
      let payload = row.payload || {};
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { payload = {}; }
      }
      const expected = hashEvent({
        prevHash,
        eventType: row.event_type,
        custodyAccountId: row.custody_account_id,
        positionId: row.position_id,
        receiptId: row.receipt_id,
        actor: row.actor,
        payload,
        createdAt: new Date(row.created_at).toISOString(),
      });
      if (expected !== row.event_hash || (row.prev_hash || null) !== prevHash) {
        breaks.push({ eventId: row.event_id, sequence: Number(row.sequence) });
      }
      prevHash = row.event_hash;
    }
    return {
      events: rows.rows.length,
      intact: breaks.length === 0,
      breaks,
      tipHash: prevHash,
      note: breaks.length === 0
        ? 'Every custody event hashes to its predecessor; the chain of title is intact.'
        : 'The custody log has been altered: the listed events no longer hash to their predecessor.',
    };
  }

  // ── Custody accounts ───────────────────────────────────────────────────────

  static async openAccount({
    custodyAccountId, accountName, custodyType, custodianName,
    custodianAccountRef, jurisdiction, notes, openedBy,
  } = {}) {
    const name = requireText(accountName, 'accountName is required');
    const type = String(custodyType || '').toLowerCase();
    if (!CUSTODY_TYPES.includes(type)) {
      throw new Error(`custodyType must be one of ${CUSTODY_TYPES.join(', ')}`);
    }
    // A third-party custody account is only meaningful if the custodian and the
    // account it is held under are both named; otherwise it is self custody
    // wearing a custodian's label.
    if (type === 'third_party') {
      requireText(custodianName, 'A third-party custody account requires custodianName');
      requireText(custodianAccountRef, 'A third-party custody account requires custodianAccountRef');
    }
    const actor = requireText(openedBy, 'openedBy is required to open a custody account');

    await this.ensureTables();
    const accountId = String(custodyAccountId || id('CUS')).trim();
    const rows = await pool.query(
      `INSERT INTO custody_accounts
         (custody_account_id, account_name, custody_type, custodian_name,
          custodian_account_ref, jurisdiction, notes, opened_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        accountId, name, type,
        type === 'third_party' ? String(custodianName).trim() : null,
        type === 'third_party' ? String(custodianAccountRef).trim() : null,
        jurisdiction || null, notes || null, actor,
      ]
    );
    await this._appendEvent({
      eventType: 'custody_account_opened',
      custodyAccountId: accountId,
      actor,
      payload: { accountName: name, custodyType: type, custodianName: custodianName || null },
    });
    return rows.rows[0];
  }

  static async getAccount(custodyAccountId) {
    await this.ensureTables();
    const rows = await pool.query(
      'SELECT * FROM custody_accounts WHERE custody_account_id = $1',
      [custodyAccountId]
    );
    return rows.rows[0] || null;
  }

  static async listAccounts() {
    await this.ensureTables();
    const rows = await pool.query(
      "SELECT * FROM custody_accounts WHERE status = 'active' ORDER BY created_at ASC"
    );
    return rows.rows;
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  /**
   * Record what a custody account holds. A new or revalued position always
   * starts at `unverified` control status: booking a holding is a claim, and
   * only a countersigned receipt turns a claim into a custody record.
   */
  static async recordPosition({
    custodyAccountId, assetClass, instrumentRef, instrumentName,
    quantity, valuationCents, recordedBy,
  } = {}) {
    const accountId = requireText(custodyAccountId, 'custodyAccountId is required');
    const ref = requireText(instrumentRef, 'instrumentRef is required');
    const klass = String(assetClass || '').toLowerCase();
    if (!ASSET_CLASSES.includes(klass)) {
      throw new Error(`assetClass must be one of ${ASSET_CLASSES.join(', ')}`);
    }
    const value = cents(valuationCents);
    if (value < 0) throw new Error('valuationCents cannot be negative');
    const actor = requireText(recordedBy, 'recordedBy is required to record a position');

    const account = await this.getAccount(accountId);
    if (!account) throw new Error(`Custody account ${accountId} not found`);
    if (account.status !== 'active') throw new Error(`Custody account ${accountId} is ${account.status}`);

    const positionId = id('CPS');
    const rows = await pool.query(
      `INSERT INTO custody_positions
         (position_id, custody_account_id, asset_class, instrument_ref, instrument_name,
          quantity, valuation_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (custody_account_id, instrument_ref) DO UPDATE
         SET asset_class = EXCLUDED.asset_class,
             instrument_name = COALESCE(EXCLUDED.instrument_name, custody_positions.instrument_name),
             quantity = EXCLUDED.quantity,
             valuation_cents = EXCLUDED.valuation_cents,
             control_status = 'unverified',
             updated_at = NOW()
       RETURNING *`,
      [positionId, accountId, klass, ref, instrumentName || null, Number(quantity || 0), value]
    );
    const position = rows.rows[0];
    await this._appendEvent({
      eventType: 'position_recorded',
      custodyAccountId: accountId,
      positionId: position.position_id,
      actor,
      payload: { assetClass: klass, instrumentRef: ref, valuationCents: value },
    });
    return position;
  }

  static async getPosition(positionId) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT p.*, a.custody_type, a.custodian_name, a.custodian_account_ref, a.status AS account_status
         FROM custody_positions p
         JOIN custody_accounts a ON a.custody_account_id = p.custody_account_id
        WHERE p.position_id = $1`,
      [positionId]
    );
    return rows.rows[0] || null;
  }

  static async listPositions({ custodyAccountId = null } = {}) {
    await this.ensureTables();
    const rows = custodyAccountId
      ? await pool.query(
        `SELECT p.*, a.custody_type, a.custodian_name, a.custodian_account_ref
           FROM custody_positions p
           JOIN custody_accounts a ON a.custody_account_id = p.custody_account_id
          WHERE p.custody_account_id = $1
          ORDER BY p.created_at ASC`,
        [custodyAccountId]
      )
      : await pool.query(
        `SELECT p.*, a.custody_type, a.custodian_name, a.custodian_account_ref
           FROM custody_positions p
           JOIN custody_accounts a ON a.custody_account_id = p.custody_account_id
          ORDER BY p.created_at ASC`
      );
    return rows.rows;
  }

  // ── Safekeeping receipts ───────────────────────────────────────────────────

  static async proposeReceipt({
    positionId, action = 'safekeeping', valuationCents, quantity,
    evidenceReference, proposedBy,
  } = {}) {
    const pid = requireText(positionId, 'positionId is required');
    const act = String(action || 'safekeeping').toLowerCase();
    if (!RECEIPT_ACTIONS.includes(act)) {
      throw new Error(`action must be one of ${RECEIPT_ACTIONS.join(', ')}`);
    }
    // Documentary evidence is the whole point of a receipt: without a statement
    // or document reference there is nothing to countersign.
    const evidence = requireText(
      evidenceReference,
      'A custody receipt requires an evidence reference (custodian statement, vault log or document id)'
    );
    const actor = requireText(proposedBy, 'proposedBy is required to raise a custody receipt');

    const position = await this.getPosition(pid);
    if (!position) throw new Error(`Custody position ${pid} not found`);

    const value = valuationCents === undefined || valuationCents === null
      ? cents(position.valuation_cents)
      : cents(valuationCents);
    if (value < 0) throw new Error('valuationCents cannot be negative');

    const cfg = this.config();
    const receiptId = id('CRC');
    const rows = await pool.query(
      `INSERT INTO custody_receipts
         (receipt_id, position_id, action, valuation_cents, quantity, evidence_reference,
          proposed_by, required_signatures, signatures)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]'::jsonb)
       RETURNING *`,
      [
        receiptId, pid, act, value,
        quantity === undefined || quantity === null ? null : Number(quantity),
        evidence, actor, cfg.requiredSignatures,
      ]
    );
    await this._appendEvent({
      eventType: 'receipt_proposed',
      custodyAccountId: position.custody_account_id,
      positionId: pid,
      receiptId,
      actor,
      payload: { action: act, valuationCents: value, evidenceReference: evidence },
    });
    return rows.rows[0];
  }

  static _signatures(receipt) {
    let signatures = receipt.signatures || [];
    if (typeof signatures === 'string') {
      try { signatures = JSON.parse(signatures); } catch { signatures = []; }
    }
    return Array.isArray(signatures) ? signatures : [];
  }

  /**
   * Countersign a receipt. Once the required number of distinct trustees have
   * signed, the position takes the receipted valuation and — for third-party
   * custody only — the matching reserve attestation is recorded.
   */
  static async countersignReceipt(receiptId, signedBy, { role = null } = {}) {
    const rid = requireText(receiptId, 'receiptId is required');
    const signer = requireText(signedBy, 'signedBy is required to countersign a receipt');
    await this.ensureTables();

    const found = await pool.query('SELECT * FROM custody_receipts WHERE receipt_id = $1', [rid]);
    const receipt = found.rows[0];
    if (!receipt) throw new Error(`Custody receipt ${rid} not found`);
    if (receipt.status !== 'pending') throw new Error(`Custody receipt ${rid} is already ${receipt.status}`);

    const signatures = this._signatures(receipt);
    const key = signer.toLowerCase();
    if (signatures.some((s) => String(s.signedBy).toLowerCase() === key)) {
      throw new Error(`${signer} has already signed ${rid}`);
    }
    signatures.push({ signedBy: signer, role: role || null, at: new Date().toISOString() });

    const required = Number(receipt.required_signatures) || 2;
    const position = await this.getPosition(receipt.position_id);
    if (!position) throw new Error(`Custody position ${receipt.position_id} not found`);

    if (signatures.length < required) {
      const updated = await pool.query(
        `UPDATE custody_receipts SET signatures = $2::jsonb WHERE receipt_id = $1 RETURNING *`,
        [rid, JSON.stringify(signatures)]
      );
      await this._appendEvent({
        eventType: 'receipt_signed',
        custodyAccountId: position.custody_account_id,
        positionId: position.position_id,
        receiptId: rid,
        actor: signer,
        payload: { signatures: signatures.length, requiredSignatures: required },
      });
      return {
        ...updated.rows[0],
        signatures,
        remainingSignatures: required - signatures.length,
      };
    }

    const controlStatus = receipt.action === 'release' ? 'released' : 'receipted';
    const valuationCents = receipt.action === 'release' ? 0 : cents(receipt.valuation_cents);
    await pool.query(
      `UPDATE custody_positions
          SET control_status = $2, valuation_cents = $3, last_receipt_id = $4, updated_at = NOW()
        WHERE position_id = $1`,
      [position.position_id, controlStatus, valuationCents, rid]
    );

    const reserve = await this._syncReserveForPosition({
      position, receipt, valuationCents, controlStatus, signer,
    });

    const settled = await pool.query(
      `UPDATE custody_receipts
          SET status = 'countersigned', signatures = $2::jsonb, settled_at = NOW(),
              reserve_attestation_id = $3, reserve_note = $4
        WHERE receipt_id = $1
        RETURNING *`,
      [rid, JSON.stringify(signatures), reserve.attestationId, reserve.note]
    );
    await this._appendEvent({
      eventType: 'receipt_countersigned',
      custodyAccountId: position.custody_account_id,
      positionId: position.position_id,
      receiptId: rid,
      actor: signer,
      payload: {
        controlStatus,
        valuationCents,
        reserveAttestationId: reserve.attestationId,
        reserveNote: reserve.note,
      },
    });
    return {
      ...settled.rows[0],
      signatures,
      controlStatus,
      reserve,
    };
  }

  /**
   * Push a countersigned custody record into the reserve engine.
   *
   * Self custody is deliberately excluded. Two trustees of the trust signing
   * that the trust holds its own asset is an internal record, not third-party
   * evidence, so it cannot raise the reserve a payment rail may draw on.
   */
  static async _syncReserveForPosition({ position, receipt, valuationCents, controlStatus, signer }) {
    const cfg = this.config();
    if (!cfg.reserveLinked || !ReserveEngine) {
      return { attestationId: null, note: 'Reserve sync disabled; custody record only.' };
    }
    if (position.custody_type !== 'third_party') {
      return {
        attestationId: null,
        note: 'Self-custody receipt: the trust attesting that it holds its own asset is an'
          + ' internal record, so it adds nothing to the reserve.',
      };
    }
    const sourceType = RESERVE_SOURCE_BY_ASSET_CLASS[position.asset_class];
    if (!sourceType) {
      return {
        attestationId: null,
        note: `${position.asset_class} custody is not a USD reserve source; recorded for`
          + ' custody purposes only.',
      };
    }
    try {
      const attestation = await ReserveEngine.record({
        sourceType,
        sourceKey: position.instrument_ref,
        verification: 'statement',
        balanceCents: controlStatus === 'released' ? 0 : valuationCents,
        evidenceReference: receipt.evidence_reference,
        attestedBy: signer,
        detail: {
          custodyAccountId: position.custody_account_id,
          custodian: position.custodian_name,
          custodianAccountRef: position.custodian_account_ref,
          positionId: position.position_id,
          receiptId: receipt.receipt_id,
        },
      });
      return {
        attestationId: attestation.attestation_id,
        note: `Recorded as a ${sourceType} attestation held at ${position.custodian_name}.`,
      };
    } catch (e) {
      // A custody record stands on its own; a reserve rejection is reported
      // rather than rolling back a signed receipt.
      return { attestationId: null, note: `Reserve attestation refused: ${e.message}` };
    }
  }

  static async listReceipts({ status = null, limit = 100 } = {}) {
    await this.ensureTables();
    const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const rows = status
      ? await pool.query(
        `SELECT r.*, p.custody_account_id, p.instrument_ref, p.asset_class
           FROM custody_receipts r
           JOIN custody_positions p ON p.position_id = r.position_id
          WHERE r.status = $1
          ORDER BY r.created_at DESC
          LIMIT $2`,
        [status, capped]
      )
      : await pool.query(
        `SELECT r.*, p.custody_account_id, p.instrument_ref, p.asset_class
           FROM custody_receipts r
           JOIN custody_positions p ON p.position_id = r.position_id
          ORDER BY r.created_at DESC
          LIMIT $1`,
        [capped]
      );
    return rows.rows.map((row) => ({ ...row, signatures: this._signatures(row) }));
  }

  static async voidReceipt(receiptId, voidedBy, reason = null) {
    const rid = requireText(receiptId, 'receiptId is required');
    const actor = requireText(voidedBy, 'voidedBy is required');
    await this.ensureTables();
    const rows = await pool.query(
      `UPDATE custody_receipts SET status = 'void', settled_at = NOW(), reserve_note = $2
        WHERE receipt_id = $1 AND status = 'pending'
        RETURNING *`,
      [rid, reason || `Voided by ${actor}`]
    );
    if (!rows.rows.length) throw new Error(`No pending custody receipt ${rid} to void`);
    await this._appendEvent({
      eventType: 'receipt_voided',
      positionId: rows.rows[0].position_id,
      receiptId: rid,
      actor,
      payload: { reason: reason || null },
    });
    return rows.rows[0];
  }

  // ── Custody statement ──────────────────────────────────────────────────────

  /**
   * The trust's consolidated custody statement: what is held, where, under
   * whose control, and how much of it is third-party verified. `underControl`
   * is the only figure that means anything outside the trust's own books.
   */
  static async statement() {
    const accounts = await this.listAccounts();
    const positions = await this.listPositions();
    const byAccount = new Map(accounts.map((a) => [a.custody_account_id, { ...a, positions: [] }]));

    let heldCents = 0;
    let receiptedThirdPartyCents = 0;
    let selfCustodyCents = 0;
    let unverifiedCents = 0;
    const byAssetClass = {};

    for (const position of positions) {
      if (position.control_status === 'released') continue;
      const value = cents(position.valuation_cents);
      const thirdParty = position.custody_type === 'third_party';
      const receipted = position.control_status === 'receipted';

      heldCents += value;
      if (thirdParty && receipted) receiptedThirdPartyCents += value;
      if (!thirdParty) selfCustodyCents += value;
      if (!receipted) unverifiedCents += value;

      const bucket = byAssetClass[position.asset_class]
        || (byAssetClass[position.asset_class] = { heldCents: 0, thirdPartyReceiptedCents: 0 });
      bucket.heldCents += value;
      if (thirdParty && receipted) bucket.thirdPartyReceiptedCents += value;

      const entry = byAccount.get(position.custody_account_id);
      if (entry) {
        entry.positions.push({
          positionId: position.position_id,
          assetClass: position.asset_class,
          instrumentRef: position.instrument_ref,
          instrumentName: position.instrument_name,
          quantity: Number(position.quantity || 0),
          valuationCents: value,
          valuation: dollars(value),
          controlStatus: position.control_status,
          lastReceiptId: position.last_receipt_id,
          verifiedExternally: thirdParty && receipted,
        });
      }
    }

    return {
      accounts: Array.from(byAccount.values()).map((entry) => ({
        custodyAccountId: entry.custody_account_id,
        accountName: entry.account_name,
        custodyType: entry.custody_type,
        custodianName: entry.custodian_name,
        custodianAccountRef: entry.custodian_account_ref,
        positions: entry.positions,
        valuation: dollars(entry.positions.reduce((s, p) => s + p.valuationCents, 0)),
      })),
      heldCents,
      held: dollars(heldCents),
      thirdPartyReceiptedCents: receiptedThirdPartyCents,
      thirdPartyReceipted: dollars(receiptedThirdPartyCents),
      selfCustodyCents,
      selfCustody: dollars(selfCustodyCents),
      unreceiptedCents: unverifiedCents,
      unreceipted: dollars(unverifiedCents),
      byAssetClass: Object.fromEntries(Object.entries(byAssetClass).map(([klass, bucket]) => [
        klass,
        {
          held: dollars(bucket.heldCents),
          thirdPartyReceipted: dollars(bucket.thirdPartyReceiptedCents),
        },
      ])),
      note: receiptedThirdPartyCents > 0
        ? 'Third-party receipted holdings are evidenced outside the trust and flow through to'
          + ' the reserve; self-custody holdings do not.'
        : 'No holding is receipted at a third-party custodian, so nothing here backs an'
          + ' external payment.',
    };
  }

  /** Re-record reserve attestations for every countersigned third-party position. */
  static async syncReserve({ syncedBy } = {}) {
    const actor = requireText(syncedBy, 'syncedBy is required to sync custody to the reserve');
    const positions = await this.listPositions();
    const synced = [];
    for (const position of positions) {
      if (position.custody_type !== 'third_party') continue;
      if (position.control_status !== 'receipted') continue;
      if (!position.last_receipt_id) continue;
      const found = await pool.query(
        'SELECT * FROM custody_receipts WHERE receipt_id = $1',
        [position.last_receipt_id]
      );
      const receipt = found.rows[0];
      if (!receipt) continue;
      const result = await this._syncReserveForPosition({
        position,
        receipt,
        valuationCents: cents(position.valuation_cents),
        controlStatus: position.control_status,
        signer: actor,
      });
      synced.push({
        positionId: position.position_id,
        instrumentRef: position.instrument_ref,
        assetClass: position.asset_class,
        ...result,
      });
    }
    return { synced: synced.length, positions: synced };
  }

  static async status() {
    const cfg = this.config();
    const statement = await this.statement().catch((e) => ({ error: e.message }));
    const chain = await this.verifyChain().catch((e) => ({ error: e.message }));
    const pending = await this.listReceipts({ status: 'pending' }).catch(() => []);
    return {
      requiredSignatures: cfg.requiredSignatures,
      reserveLinked: cfg.reserveLinked,
      reserveEngineAvailable: Boolean(ReserveEngine),
      pendingReceipts: pending.length,
      chain,
      statement,
    };
  }
}

module.exports = {
  CustodyOsEngine,
  CUSTODY_TYPES,
  ASSET_CLASSES,
  RECEIPT_ACTIONS,
  RESERVE_SOURCE_BY_ASSET_CLASS,
};

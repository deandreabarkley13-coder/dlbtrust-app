'use strict';

/**
 * Messaging Engine — DLB Trust Platform
 *
 * Secure trustee/beneficiary messaging tied to FinOps tasks, approvals,
 * payments, and calendar events. Supports email/phone identity lookups.
 */

const pool = require('../bonds/pgPool');

function id(prefix = 'MSG') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

class MessagingEngine {

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_threads (
        id            TEXT PRIMARY KEY,
        subject       TEXT,
        participants  JSONB DEFAULT '[]',
        reference_type TEXT,
        reference_id   TEXT,
        created_by     TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT PRIMARY KEY,
        thread_id     TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
        sender        TEXT,
        body          TEXT,
        attachments   JSONB DEFAULT '[]',
        read_by       JSONB DEFAULT '[]',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at)`);
  }

  static async createThread({ subject, participants = [], referenceType, referenceId, createdBy } = {}) {
    const threadId = id('THR');
    const result = await pool.query(
      `INSERT INTO message_threads (id, subject, participants, reference_type, reference_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [threadId, subject || null, JSON.stringify(participants), referenceType || null, referenceId || null, createdBy || null]
    );
    return result.rows[0];
  }

  static async sendMessage({ threadId, sender, body, attachments = [] } = {}) {
    if (!threadId || !body) throw new Error('threadId and body are required');
    const messageId = id();
    const result = await pool.query(
      `INSERT INTO messages (id, thread_id, sender, body, attachments)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [messageId, threadId, sender || null, body, JSON.stringify(attachments)]
    );
    await pool.query(
      `UPDATE message_threads SET updated_at = NOW() WHERE id = $1`,
      [threadId]
    );
    return result.rows[0];
  }

  static async listThreads({ referenceType, referenceId, participant, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;
    if (referenceType) { conditions.push(`reference_type = $${idx++}`); params.push(referenceType); }
    if (referenceId) { conditions.push(`reference_id = $${idx++}`); params.push(referenceId); }
    if (participant) { conditions.push(`participants::text ILIKE $${idx++}`); params.push(`%${participant}%`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM message_threads ${where} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );
    return result.rows;
  }

  static async listMessages(threadId, { limit = 100, offset = 0 } = {}) {
    const result = await pool.query(
      `SELECT * FROM messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
      [threadId, limit, offset]
    );
    return result.rows;
  }

  static async getThread(id) {
    const result = await pool.query('SELECT * FROM message_threads WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  static async notify({ subject, body, participants, referenceType, referenceId, sender = 'FinOps Agent' }) {
    const thread = await this.createThread({ subject, participants, referenceType, referenceId, createdBy: sender });
    await this.sendMessage({ threadId: thread.id, sender, body });
    return thread;
  }
}

module.exports = { MessagingEngine };

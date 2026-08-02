'use strict';

/**
 * Calendar & Scheduling Engine — DLB Trust Platform
 *
 * Links calendar events to FinOps tasks, payments, distributions, and
 * disbursements so trustees can schedule, review, and approve operations
 * from a single timeline.
 */

const pool = require('../bonds/pgPool');

function id(prefix = 'EVT') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

class CalendarEngine {

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        description   TEXT,
        start_time    TIMESTAMPTZ NOT NULL,
        end_time      TIMESTAMPTZ,
        all_day       BOOLEAN DEFAULT FALSE,
        event_type    TEXT DEFAULT 'general' CHECK (event_type IN ('general','payment','distribution','disbursement','swap','safe','meeting','deadline','review','document')),
        related_module TEXT,
        reference_id   TEXT,
        attendees      JSONB DEFAULT '[]',
        created_by     TEXT,
        metadata       JSONB DEFAULT '{}',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_time ON calendar_events(start_time)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_ref ON calendar_events(related_module, reference_id)`);
  }

  static async createEvent({
    title, description, start, end, allDay = false,
    eventType = 'general', relatedModule, referenceId,
    attendees = [], createdBy, metadata = {},
  }) {
    if (!title || !start) throw new Error('title and start are required');
    const startTime = new Date(start);
    if (isNaN(startTime.getTime())) throw new Error('Invalid start date');
    const eventId = id();
    const result = await pool.query(
      `INSERT INTO calendar_events
         (id, title, description, start_time, end_time, all_day, event_type, related_module, reference_id, attendees, created_by, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [eventId, title, description || null, startTime, end ? new Date(end) : null,
       !!allDay, eventType, relatedModule || null, referenceId || null,
       JSON.stringify(attendees), createdBy || null, JSON.stringify(metadata)]
    );
    return result.rows[0];
  }

  static async listEvents({ start, end, eventType, relatedModule, referenceId, limit = 100, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;
    if (start) { conditions.push(`start_time >= $${idx++}`); params.push(new Date(start)); }
    if (end) { conditions.push(`start_time <= $${idx++}`); params.push(new Date(end)); }
    if (eventType) { conditions.push(`event_type = $${idx++}`); params.push(eventType); }
    if (relatedModule) { conditions.push(`related_module = $${idx++}`); params.push(relatedModule); }
    if (referenceId) { conditions.push(`reference_id = $${idx++}`); params.push(referenceId); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(
      `SELECT * FROM calendar_events ${where} ORDER BY start_time DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );
    return result.rows;
  }

  static async getEvent(id) {
    const result = await pool.query('SELECT * FROM calendar_events WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  static async updateEvent(id, updates) {
    const allowed = ['title','description','start_time','end_time','all_day','event_type','related_module','reference_id','attendees','metadata'];
    const fields = [];
    const params = [];
    let idx = 1;
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = $${idx++}`);
        params.push(key === 'attendees' || key === 'metadata' ? JSON.stringify(updates[key]) : updates[key]);
      }
    }
    if (!fields.length) throw new Error('No valid fields to update');
    fields.push(`updated_at = NOW()`);
    params.push(id);
    const result = await pool.query(
      `UPDATE calendar_events SET ${fields.join(',')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  }

  static async deleteEvent(id) {
    const result = await pool.query('DELETE FROM calendar_events WHERE id = $1 RETURNING *', [id]);
    return result.rows[0] || null;
  }

  static async scheduleFromTask(task) {
    const title = `FinOps task: ${task.intent.action} ${task.id}`;
    const start = task.intent.date ? new Date(task.intent.date) : new Date(Date.now() + 60 * 60 * 1000);
    return this.createEvent({
      title,
      description: task.prompt,
      start,
      eventType: task.intent.action || 'general',
      relatedModule: 'finops',
      referenceId: task.id,
      attendees: task.approvals ? task.approvals.map(a => a.trusteeEmail).filter(Boolean) : [],
      createdBy: 'finops_agent',
    });
  }
}

module.exports = { CalendarEngine };

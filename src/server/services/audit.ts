import { getDb } from '../db/index.js';
import { v4 as uuid } from 'uuid';

export function logAudit(
  userId: string,
  action: string,
  entityType: string,
  entityId: string,
  details?: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), userId, action, entityType, entityId, details || null);
}

export function getAuditLogs(entityType?: string, entityId?: string, limit = 50) {
  const db = getDb();

  if (entityType && entityId) {
    return db.prepare(`
      SELECT al.*, u.name as user_name, u.email as user_email
      FROM audit_log al JOIN users u ON al.user_id = u.id
      WHERE al.entity_type = ? AND al.entity_id = ?
      ORDER BY al.created_at DESC LIMIT ?
    `).all(entityType, entityId, limit);
  }

  return db.prepare(`
    SELECT al.*, u.name as user_name, u.email as user_email
    FROM audit_log al JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC LIMIT ?
  `).all(limit);
}

import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getAuditLogs } from '../services/audit.js';

const router = Router();

router.get('/', requireAuth, requireRole('admin'), (req: Request, res: Response) => {
  const entityType = req.query.entity_type as string | undefined;
  const entityId = req.query.entity_id as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const logs = getAuditLogs(entityType, entityId, limit);
  res.json({ data: logs });
});

export default router;

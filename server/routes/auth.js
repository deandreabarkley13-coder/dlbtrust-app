'use strict';

/**
 * Auth Routes — Login, Logout, User Management
 * Mounts at: /api/auth
 */

const express = require('express');
const router = express.Router();
const { UserAuth, ROLES } = require('../integrations/auth/userAuth');
const { authRateLimiter, requireAuth, generateCsrfToken } = require('../integrations/auth/securityMiddleware');

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', authRateLimiter(), async (req, res) => {
  try {
    const { username, password } = req.body;
    const meta = {
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
    };
    const result = await UserAuth.login(username, password, meta);
    const csrfToken = generateCsrfToken(result.user.id);
    res.json({ success: true, ...result, csrfToken });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.json({ success: true });

  const meta = { ip: req.ip, userAgent: req.headers['user-agent'] };
  const result = await UserAuth.logout(token, meta);
  res.json(result);
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth(), async (req, res) => {
  try {
    const sessions = await UserAuth.getActiveSessions(req.user.userId);
    res.json({
      success: true,
      user: {
        id: req.user.userId,
        username: req.user.username,
        role: req.user.role,
        roleLabel: ROLES[req.user.role] ? ROLES[req.user.role].label : req.user.role,
      },
      activeSessions: sessions.length,
      authMethod: req.authMethod,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/auth/change-password ───────────────────────────────────────────
router.post('/change-password', requireAuth(), async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const result = await UserAuth.changePassword(req.user.userId, oldPassword, newPassword);
    res.json(result);
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── GET /api/auth/csrf-token ─────────────────────────────────────────────────
router.get('/csrf-token', requireAuth(), (req, res) => {
  const token = generateCsrfToken(req.user.userId);
  res.json({ csrfToken: token });
});

// ─── Admin-only User Management ───────────────────────────────────────────────

// GET /api/auth/users — list all users
router.get('/users', requireAuth({ role: 'admin' }), async (req, res) => {
  try {
    const users = await UserAuth.listUsers();
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/users — create a new user
router.post('/users', requireAuth({ role: 'admin' }), async (req, res) => {
  try {
    const { username, password, displayName, email, role } = req.body;
    const user = await UserAuth.createUser({ username, password, displayName, email, role });
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// PUT /api/auth/users/:id/role — update user role
router.put('/users/:id/role', requireAuth({ role: 'admin' }), async (req, res) => {
  try {
    const { role } = req.body;
    await UserAuth.updateUserRole(parseInt(req.params.id, 10), role);
    res.json({ success: true, message: 'Role updated' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// PUT /api/auth/users/:id/active — enable/disable user
router.put('/users/:id/active', requireAuth({ role: 'admin' }), async (req, res) => {
  try {
    const { active } = req.body;
    await UserAuth.setUserActive(parseInt(req.params.id, 10), active);
    res.json({ success: true, message: active ? 'User enabled' : 'User disabled' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/auth/users/:id/unlock — unlock a locked account
router.post('/users/:id/unlock', requireAuth({ role: 'admin' }), async (req, res) => {
  try {
    await UserAuth.unlockUser(parseInt(req.params.id, 10));
    res.json({ success: true, message: 'Account unlocked' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/auth/users/:id/revoke-sessions — revoke all sessions
router.post('/users/:id/revoke-sessions', requireAuth({ role: 'admin' }), async (req, res) => {
  try {
    await UserAuth.revokeAllSessions(parseInt(req.params.id, 10));
    res.json({ success: true, message: 'All sessions revoked' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/auth/security-log — security audit log
router.get('/security-log', requireAuth({ role: 'admin' }), async (req, res) => {
  try {
    const logs = await UserAuth.getSecurityLog({
      eventType: req.query.eventType,
      username: req.query.username,
      severity: req.query.severity,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
    });
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/roles — list available roles
router.get('/roles', (req, res) => {
  res.json({ success: true, roles: ROLES });
});

module.exports = router;

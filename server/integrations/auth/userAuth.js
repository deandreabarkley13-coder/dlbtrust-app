'use strict';

/**
 * UserAuth — PostgreSQL-backed user authentication with bcrypt + JWT
 *
 * Features:
 *  - Username/password login with bcrypt-hashed passwords
 *  - JWT session tokens with configurable expiry
 *  - Role-based access control (admin, operator, viewer)
 *  - Account lockout after failed login attempts
 *  - Password change with old-password verification
 *  - Session tracking and revocation
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../bonds/pgPool');

const BCRYPT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY = process.env.JWT_EXPIRY || '8h';
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const ROLES = {
  admin: { level: 100, label: 'Administrator', permissions: ['*'] },
  operator: { level: 50, label: 'Operator', permissions: ['transmit', 'wire', 'create_batch', 'view', 'deposit_coupon'] },
  viewer: { level: 10, label: 'Viewer', permissions: ['view'] },
};

class UserAuth {

  /**
   * Ensure the users and sessions tables exist in PostgreSQL
   */
  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(200),
        email VARCHAR(255),
        role VARCHAR(50) NOT NULL DEFAULT 'viewer',
        is_active BOOLEAN NOT NULL DEFAULT true,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        last_login TIMESTAMPTZ,
        last_password_change TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        token_id VARCHAR(100) UNIQUE NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_audit_log (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        user_id INTEGER,
        username VARCHAR(100),
        ip_address VARCHAR(45),
        user_agent TEXT,
        details JSONB,
        severity VARCHAR(20) DEFAULT 'info',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create default admin account if none exist
    const userCount = await pool.query('SELECT COUNT(*) as cnt FROM auth_users');
    if (parseInt(userCount.rows[0].cnt, 10) === 0) {
      await UserAuth.createUser({
        username: 'admin',
        password: 'dlb-admin-2026-trust',
        displayName: 'Trust Administrator',
        role: 'admin',
      });
      console.log('[auth] Default admin user created (username: admin)');
    }
  }

  /**
   * Create a new user
   */
  static async createUser({ username, password, displayName, email, role }) {
    if (!username || !password) throw new Error('Username and password are required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    if (role && !ROLES[role]) throw new Error('Invalid role. Valid roles: ' + Object.keys(ROLES).join(', '));

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO auth_users (username, password_hash, display_name, email, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, username, display_name, role, created_at`,
      [username.toLowerCase().trim(), passwordHash, displayName || username, email || null, role || 'viewer']
    );
    return result.rows[0];
  }

  /**
   * Authenticate user with username/password — returns JWT token
   */
  static async login(username, password, meta = {}) {
    if (!username || !password) throw new Error('Username and password are required');

    const normalizedUsername = username.toLowerCase().trim();
    const userRes = await pool.query(
      'SELECT * FROM auth_users WHERE username = $1',
      [normalizedUsername]
    );

    if (userRes.rows.length === 0) {
      await UserAuth._logSecurityEvent('login_failed', null, normalizedUsername, meta, 'warn', { reason: 'user_not_found' });
      throw new Error('Invalid username or password');
    }

    const user = userRes.rows[0];

    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      await UserAuth._logSecurityEvent('login_locked', user.id, normalizedUsername, meta, 'warn', { minutes_left: minutesLeft });
      throw new Error(`Account is locked. Try again in ${minutesLeft} minute(s).`);
    }

    // Check if account is active
    if (!user.is_active) {
      await UserAuth._logSecurityEvent('login_disabled', user.id, normalizedUsername, meta, 'warn');
      throw new Error('Account is disabled. Contact administrator.');
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000);
        await pool.query(
          'UPDATE auth_users SET failed_attempts = $1, locked_until = $2 WHERE id = $3',
          [attempts, lockUntil, user.id]
        );
        await UserAuth._logSecurityEvent('account_locked', user.id, normalizedUsername, meta, 'critical', { attempts, lock_minutes: LOCKOUT_MINUTES });
        throw new Error(`Account locked after ${MAX_FAILED_ATTEMPTS} failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);
      }
      await pool.query('UPDATE auth_users SET failed_attempts = $1 WHERE id = $2', [attempts, user.id]);
      await UserAuth._logSecurityEvent('login_failed', user.id, normalizedUsername, meta, 'warn', { reason: 'wrong_password', attempts });
      throw new Error('Invalid username or password');
    }

    // Reset failed attempts on successful login
    await pool.query(
      'UPDATE auth_users SET failed_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
    );

    // Generate JWT
    const tokenId = crypto.randomBytes(32).toString('hex');
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tokenId },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    // Decode to get expiry
    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);

    // Store session
    await pool.query(
      `INSERT INTO auth_sessions (user_id, token_id, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, tokenId, meta.ip || null, meta.userAgent || null, expiresAt]
    );

    await UserAuth._logSecurityEvent('login_success', user.id, normalizedUsername, meta, 'info');

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        roleLabel: ROLES[user.role] ? ROLES[user.role].label : user.role,
      },
    };
  }

  /**
   * Verify a JWT token — returns decoded user info
   */
  static async verifyToken(token) {
    if (!token) throw new Error('No token provided');

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') throw new Error('Session expired. Please log in again.');
      throw new Error('Invalid token');
    }

    // Check if session is revoked
    const sessionRes = await pool.query(
      'SELECT revoked FROM auth_sessions WHERE token_id = $1',
      [decoded.tokenId]
    );
    if (sessionRes.rows.length > 0 && sessionRes.rows[0].revoked) {
      throw new Error('Session has been revoked. Please log in again.');
    }

    return decoded;
  }

  /**
   * Logout — revoke the session token
   */
  static async logout(token, meta = {}) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
      await pool.query('UPDATE auth_sessions SET revoked = true WHERE token_id = $1', [decoded.tokenId]);
      await UserAuth._logSecurityEvent('logout', decoded.userId, decoded.username, meta, 'info');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Change password
   */
  static async changePassword(userId, oldPassword, newPassword) {
    if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters');

    const userRes = await pool.query('SELECT password_hash FROM auth_users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) throw new Error('User not found');

    const valid = await bcrypt.compare(oldPassword, userRes.rows[0].password_hash);
    if (!valid) throw new Error('Current password is incorrect');

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query(
      'UPDATE auth_users SET password_hash = $1, last_password_change = NOW(), updated_at = NOW() WHERE id = $2',
      [newHash, userId]
    );

    // Revoke all existing sessions (force re-login)
    await pool.query('UPDATE auth_sessions SET revoked = true WHERE user_id = $1', [userId]);

    await UserAuth._logSecurityEvent('password_changed', userId, null, {}, 'info');
    return { success: true, message: 'Password changed. All sessions revoked — please log in again.' };
  }

  /**
   * List all users (admin only)
   */
  static async listUsers() {
    const result = await pool.query(
      `SELECT id, username, display_name, email, role, is_active, failed_attempts,
              locked_until, last_login, created_at
       FROM auth_users ORDER BY created_at`
    );
    return result.rows;
  }

  /**
   * Update user role (admin only)
   */
  static async updateUserRole(userId, newRole) {
    if (!ROLES[newRole]) throw new Error('Invalid role. Valid roles: ' + Object.keys(ROLES).join(', '));
    await pool.query('UPDATE auth_users SET role = $1, updated_at = NOW() WHERE id = $2', [newRole, userId]);
    return { success: true };
  }

  /**
   * Enable/disable user (admin only)
   */
  static async setUserActive(userId, isActive) {
    await pool.query('UPDATE auth_users SET is_active = $1, updated_at = NOW() WHERE id = $2', [isActive, userId]);
    if (!isActive) {
      await pool.query('UPDATE auth_sessions SET revoked = true WHERE user_id = $1', [userId]);
    }
    return { success: true };
  }

  /**
   * Unlock a user account (admin only)
   */
  static async unlockUser(userId) {
    await pool.query(
      'UPDATE auth_users SET failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1',
      [userId]
    );
    return { success: true };
  }

  /**
   * Get active sessions for a user
   */
  static async getActiveSessions(userId) {
    const result = await pool.query(
      `SELECT id, ip_address, user_agent, created_at, expires_at
       FROM auth_sessions
       WHERE user_id = $1 AND revoked = false AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows;
  }

  /**
   * Revoke all sessions for a user
   */
  static async revokeAllSessions(userId) {
    await pool.query('UPDATE auth_sessions SET revoked = true WHERE user_id = $1', [userId]);
    return { success: true };
  }

  /**
   * Get security audit log
   */
  static async getSecurityLog(filters = {}) {
    const conditions = [];
    const params = [];
    let idx = 1;

    if (filters.eventType) { conditions.push(`event_type = $${idx++}`); params.push(filters.eventType); }
    if (filters.username) { conditions.push(`username = $${idx++}`); params.push(filters.username); }
    if (filters.severity) { conditions.push(`severity = $${idx++}`); params.push(filters.severity); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM security_audit_log ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );
    return result.rows;
  }

  /**
   * Log a security event
   */
  static async _logSecurityEvent(eventType, userId, username, meta, severity, details) {
    try {
      await pool.query(
        `INSERT INTO security_audit_log (event_type, user_id, username, ip_address, user_agent, details, severity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [eventType, userId || null, username || null, meta.ip || null, meta.userAgent || null,
         details ? JSON.stringify(details) : null, severity || 'info']
      );
    } catch (err) {
      console.warn('[auth] security log failed:', err.message);
    }
  }

  /**
   * Check if a user has a specific permission
   */
  static hasPermission(role, permission) {
    const roleConfig = ROLES[role];
    if (!roleConfig) return false;
    if (roleConfig.permissions.includes('*')) return true;
    return roleConfig.permissions.includes(permission);
  }
}

module.exports = { UserAuth, ROLES, JWT_SECRET };

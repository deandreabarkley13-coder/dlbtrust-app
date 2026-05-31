/**
 * OpenACH Patch — dlbtrust.cloud
 * 
 * Drop-in module that adds ACH disbursement routes to the existing Express app.
 * 
 * USAGE — add ONE line to your server.js / app.js:
 * 
 *   require('./server/openach-patch')(app, db);
 * 
 * That's it. The following endpoints will be live:
 *   GET  /api/ach/health          — verify OpenACH connection
 *   GET  /api/ach/payment-types   — list available payment types
 *   POST /api/ach/disburse        — send ACH credit to beneficiary
 *   GET  /api/ach/schedules/:id   — get schedules for a wallet
 *   POST /api/ach/setup-credentials — one-time: insert API user into OpenACH DB
 */

'use strict';

const { execSync } = require('child_process');
const achRouter = require('./routes/ach');

function requireAdmin(req, res, next) {
  if (typeof req.user === 'undefined') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

const TOKEN = process.env.OPENACH_API_TOKEN;
const KEY   = process.env.OPENACH_API_KEY;
const USER_ID      = process.env.OPENACH_USER_ID;
const ORIGINATOR   = process.env.OPENACH_ORIGINATOR_ID;

if (!TOKEN || !KEY) {
  console.warn('[OpenACH] WARNING: OPENACH_API_TOKEN and OPENACH_API_KEY must be set in environment');
}

module.exports = function patchOpenACH(app, db) {
  // Attach DB to app.locals so routes can use it
  if (db && !app.locals.db) {
    app.locals.db = db;
  }

  // Mount ACH router
  app.use('/api/ach', achRouter);

  // One-time setup endpoint — inserts API credentials into OpenACH Docker DB
  // Call once: POST /api/ach/setup-credentials
  // Protected: requires admin authentication
  app.post('/api/ach/setup-credentials', requireAdmin, (req, res) => {
    if (!TOKEN || !KEY || !USER_ID || !ORIGINATOR) {
      return res.status(500).json({ error: 'OpenACH credentials not configured in environment variables' });
    }

    try {
      // Find container — use fixed format string, no user input
      const container = execSync(
        'docker ps --format "{{.Names}}" | grep openach | head -1',
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (!container || !/^[a-zA-Z0-9_.-]+$/.test(container)) {
        return res.status(500).json({ error: 'OpenACH container not found or invalid name' });
      }

      // Find DB
      let dbPath = '/var/www/html/protected/runtime/db/openach.db';
      try {
        const found = execSync(
          `docker exec ${container} find /var/www/html -name "openach.db" 2>/dev/null | head -1`,
          { encoding: 'utf8', timeout: 8000 }
        ).trim();
        if (found && /^[a-zA-Z0-9/_.-]+$/.test(found)) dbPath = found;
      } catch (_) {}

      // Check if already exists — use parameterized-style escaping
      const safeToken = TOKEN.replace(/'/g, "''");
      const existing = execSync(
        `docker exec ${container} sqlite3 "${dbPath}" "SELECT user_api_token FROM user_api WHERE user_api_token='${safeToken}' LIMIT 1;"`,
        { encoding: 'utf8', timeout: 8000 }
      ).trim();

      if (existing.includes(TOKEN)) {
        return res.json({ success: true, message: 'API credentials already active' });
      }

      // Insert credentials — escape values to prevent shell injection
      const safeUserId = USER_ID.replace(/'/g, "''");
      const safeOriginator = ORIGINATOR.replace(/'/g, "''");
      const safeKey = KEY.replace(/'/g, "''");
      const sql = `INSERT INTO user_api (user_api_user_id, user_api_datetime, user_api_originator_info_id, user_api_token, user_api_key, user_api_status) VALUES ('${safeUserId}', datetime('now'), '${safeOriginator}', '${safeToken}', '${safeKey}', 'enabled');`;
      execSync(
        `docker exec ${container} sqlite3 "${dbPath}" "${sql}"`,
        { encoding: 'utf8', timeout: 10000 }
      );

      // Verify
      const verify = execSync(
        `docker exec ${container} sqlite3 "${dbPath}" "SELECT user_api_token FROM user_api WHERE user_api_token='${safeToken}';"`,
        { encoding: 'utf8', timeout: 8000 }
      ).trim();

      if (verify.includes(TOKEN)) {
        return res.json({
          success: true,
          message: 'OpenACH API credentials inserted successfully',
          next_step: 'GET /api/ach/health to verify connection',
        });
      } else {
        return res.status(500).json({ error: 'Insert appeared to succeed but credential not found in DB' });
      }

    } catch (err) {
      return res.status(500).json({ error: 'Setup failed — check server logs' });
    }
  });

  console.log('[OpenACH] Routes mounted at /api/ach');
  console.log('[OpenACH] Run: curl -X POST https://dlbtrust.cloud/api/ach/setup-credentials');
  console.log('[OpenACH] Then: curl https://dlbtrust.cloud/api/ach/health');
};

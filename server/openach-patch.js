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

const TOKEN = process.env.OPENACH_API_TOKEN || '3caee1c2-c218-4959-b6d2-21d4b2a1b42e';
const KEY   = process.env.OPENACH_API_KEY   || 'b74966cf-5276-4d8b-8650-5bd57dcee272';
const USER_ID      = '4fc86059-2e7b-4732-b94f-e7c3715ee8d7';
const ORIGINATOR   = '0eb26e1d-5fcc-4978-a132-dd93c2655429';

module.exports = function patchOpenACH(app, db) {
  // Attach DB to app.locals so routes can use it
  if (db && !app.locals.db) {
    app.locals.db = db;
  }

  // Mount ACH router
  app.use('/api/ach', achRouter);

  // One-time setup endpoint — inserts API credentials into OpenACH Docker DB
  // Call once: POST /api/ach/setup-credentials
  app.post('/api/ach/setup-credentials', (req, res) => {
    try {
      // Find container
      const container = execSync(
        `docker ps --format "{{.Names}}" | grep openach | head -1`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (!container) {
        return res.status(500).json({ error: 'OpenACH container not found' });
      }

      // Find DB
      let dbPath = '/var/www/html/protected/runtime/db/openach.db';
      try {
        const found = execSync(
          `docker exec ${container} find /var/www/html -name "openach.db" 2>/dev/null | head -1`,
          { encoding: 'utf8', timeout: 8000 }
        ).trim();
        if (found) dbPath = found;
      } catch (_) {}

      // Check if already exists
      const existing = execSync(
        `docker exec ${container} sqlite3 "${dbPath}" "SELECT user_api_token FROM user_api WHERE user_api_token='${TOKEN}' LIMIT 1;"`,
        { encoding: 'utf8', timeout: 8000 }
      ).trim();

      if (existing.includes(TOKEN)) {
        return res.json({ success: true, message: 'API credentials already active', token: TOKEN });
      }

      // Insert credentials
      const sql = `INSERT INTO user_api (user_api_user_id, user_api_datetime, user_api_originator_info_id, user_api_token, user_api_key, user_api_status) VALUES ('${USER_ID}', datetime('now'), '${ORIGINATOR}', '${TOKEN}', '${KEY}', 'enabled');`;
      execSync(
        `docker exec ${container} sqlite3 "${dbPath}" "${sql}"`,
        { encoding: 'utf8', timeout: 10000 }
      );

      // Verify
      const verify = execSync(
        `docker exec ${container} sqlite3 "${dbPath}" "SELECT user_api_token FROM user_api WHERE user_api_token='${TOKEN}';"`,
        { encoding: 'utf8', timeout: 8000 }
      ).trim();

      if (verify.includes(TOKEN)) {
        return res.json({
          success: true,
          message: 'OpenACH API credentials inserted successfully',
          token: TOKEN,
          next_step: 'GET /api/ach/health to verify connection',
        });
      } else {
        return res.status(500).json({ error: 'Insert appeared to succeed but credential not found in DB' });
      }

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  console.log('[OpenACH] Routes mounted at /api/ach');
  console.log('[OpenACH] Run: curl -X POST https://dlbtrust.cloud/api/ach/setup-credentials');
  console.log('[OpenACH] Then: curl https://dlbtrust.cloud/api/ach/health');
};

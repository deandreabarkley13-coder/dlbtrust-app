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
 *
 * API credentials come from OPENACH_API_TOKEN / OPENACH_API_KEY in the server's
 * environment. Provisioning them is an operator task run on the OpenACH host —
 * see server/integrations/openach/server-side-setup.js.
 */

'use strict';

const achRouter = require('./routes/ach');

module.exports = function patchOpenACH(app, db) {
  // Attach DB to app.locals so routes can use it
  if (db && !app.locals.db) {
    app.locals.db = db;
  }

  // Mount ACH router
  app.use('/api/ach', achRouter);

  if (!process.env.OPENACH_API_TOKEN || !process.env.OPENACH_API_KEY) {
    console.warn('[OpenACH] OPENACH_API_TOKEN / OPENACH_API_KEY are unset: ACH calls will not authenticate');
  }

  console.log('[OpenACH] Routes mounted at /api/ach');
};


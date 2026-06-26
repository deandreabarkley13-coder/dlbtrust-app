'use strict';
var path = require('path');
var fs = require('fs');

// HD = repo root (httpdocs on production, __dirname/.. locally)
var HD = path.resolve(__dirname, '..');

// Use local express (installed via npm install in HD)
var express = require('express');
var app = express();
var PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// V2 wealth management routes REMOVED — treasury system is the only platform now

// OpenACH routes (legacy — kept for backward compat)
try { require(path.join(HD, 'server', 'openach-patch'))(app, null); console.log('[openach] loaded'); } catch(e) { console.warn('[openach]', e.message); }

// Analytics routes
try { app.use('/api/analytics', require(path.join(HD, 'server', 'routes', 'analytics'))); console.log('[analytics] loaded'); } catch(e) { console.warn('[analytics]', e.message); }

// Fineract core banking routes
try { app.use('/api/fineract', require(path.join(HD, 'server', 'routes', 'fineract'))); console.log('[fineract] loaded'); } catch(e) { console.warn('[fineract]', e.message); }

// Fixed Income / Bond routes
try { app.use('/api/bonds', require(path.join(HD, 'server', 'routes', 'bonds'))); console.log('[bonds] loaded'); } catch(e) { console.warn('[bonds]', e.message); }

// Cash Management routes
try { app.use('/api/cash', require(path.join(HD, 'server', 'routes', 'cash'))); console.log('[cash] loaded'); } catch(e) { console.warn('[cash]', e.message); }

// CRM Engine routes
try { app.use('/api/crm', require(path.join(HD, 'server', 'routes', 'crm'))); console.log('[crm] loaded'); } catch(e) { console.warn('[crm]', e.message); }

// Admin Control routes
try { app.use('/api/admin', require(path.join(HD, 'server', 'routes', 'admin'))); console.log('[admin] loaded'); } catch(e) { console.warn('[admin]', e.message); }

// Document Management routes
try { app.use('/api/documents', require(path.join(HD, 'server', 'routes', 'documents'))); console.log('[documents] loaded'); } catch(e) { console.warn('[documents]', e.message); }

// Trust Accounting routes
try { app.use('/api/accounting', require(path.join(HD, 'server', 'routes', 'accounting'))); console.log('[accounting] loaded'); } catch(e) { console.warn('[accounting]', e.message); }

// Payments & Disbursements — OpenACH-powered ACH disbursements
try { app.use('/api/payments', require(path.join(HD, 'server', 'routes', 'payments'))); console.log('[payments] loaded'); } catch(e) { console.warn('[payments]', e.message); }

// ACH Pipeline — NACHA generation + AS2 transmission
try { app.use('/api/ach-pipeline', require(path.join(HD, 'server', 'routes', 'achPipeline'))); console.log('[ach-pipeline] loaded'); } catch(e) { console.warn('[ach-pipeline]', e.message); }

// AS2 Server — open source AS2 messaging (certs, partners, send/receive)
try { app.use('/api/as2', require(path.join(HD, 'server', 'routes', 'as2'))); console.log('[as2] loaded'); } catch(e) { console.warn('[as2]', e.message); }

// Tax Engine — Form 1041 & K-1 generation
try { app.use('/api/tax', require(path.join(HD, 'server', 'routes', 'tax'))); console.log('[tax] loaded'); } catch(e) { console.warn('[tax]', e.message); }

// Treasury Management System — serve dashboard at root, static files from public/
app.get('/', function(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'dashboard.html'));
});
app.get('/treasury', function(req, res) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(HD, 'public', 'dashboard.html'));
});
app.use(express.static(path.join(HD, 'public'), {
  etag: false,
  maxAge: 0,
  lastModified: true,
  setHeaders: function(res, filePath) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
}));
app.get('*', function(req, res) {
  var idx = path.join(HD, 'public', 'index.html');
  fs.existsSync(idx) ? res.sendFile(idx) : res.status(404).send('Not found');
});

// Start live bond accrual scheduler
try {
  var LiveBondEngine = require(path.join(HD, 'server', 'integrations', 'bonds', 'liveEngine')).LiveBondEngine;
  LiveBondEngine.scheduleAccrualJob();
  console.log('[liveEngine] daily accrual scheduler started');
} catch(e) { console.warn('[liveEngine]', e.message); }

app.listen(PORT, function() {
  console.log('[dlbtrust-treasury] running on port ' + PORT);

  // Auto-seed Fineract GL accounts and post opening balance on startup
  setTimeout(async function() {
    try {
      var FineractClient = require(path.join(HD, 'server', 'integrations', 'fineract', 'fineractClient')).FineractClient;
      var pool = require(path.join(HD, 'server', 'integrations', 'bonds', 'pgPool'));

      // Check Fineract connectivity
      await FineractClient.healthCheck();
      console.log('[fineract-init] Fineract connected — checking GL accounts');

      // Get existing GL accounts
      var existingAccounts = await FineractClient.getGLAccounts();
      var detailAccounts = Array.isArray(existingAccounts)
        ? existingAccounts.filter(function(a) { return a.usage && a.usage.id === 1; })
        : [];

      if (detailAccounts.length >= 15) {
        console.log('[fineract-init] GL accounts already seeded (' + detailAccounts.length + ' detail accounts)');
      } else {
        console.log('[fineract-init] Seeding GL accounts...');
        var TYPE_MAP = { asset: 1, liability: 2, equity: 3, income: 4, expense: 5 };
        var trustAcctsRes = await pool.query('SELECT account_code, account_name, account_type, sub_type FROM trust_accounts ORDER BY account_code');
        var existingCodes = new Set(detailAccounts.map(function(a) { return a.glCode; }));
        var created = 0;

        for (var i = 0; i < trustAcctsRes.rows.length; i++) {
          var acct = trustAcctsRes.rows[i];
          if (existingCodes.has(acct.account_code)) continue;
          var fType = TYPE_MAP[acct.account_type];
          if (!fType) continue;
          try {
            var result = await FineractClient.createGLAccount({
              name: acct.account_name, glCode: acct.account_code,
              type: fType, usage: 1,
              description: 'Trust account: ' + acct.account_name + ' (' + (acct.sub_type || acct.account_type) + ')',
            });
            var fId = result.resourceId || result.id;
            await pool.query(
              "INSERT INTO fineract_gl_mappings (mapping_type, trust_account_code, fineract_gl_id, description) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM fineract_gl_mappings WHERE mapping_type = $1 AND trust_account_code = $2)",
              ['trust_journal', acct.account_code, fId, acct.account_name + ' (' + acct.account_type + ')']
            );
            created++;
          } catch (seedErr) {
            console.warn('[fineract-init] skip ' + acct.account_code + ':', seedErr.message);
          }
        }
        console.log('[fineract-init] Created ' + created + ' GL accounts');
      }

      // Check if opening balance journal entry exists
      var journalRes = await FineractClient.getJournalEntries({ limit: 100 });
      var entries = (journalRes && journalRes.pageItems) || [];
      var hasOpeningBalance = entries.some(function(je) {
        return !je.reversed && je.amount === 100000000 && je.comments && je.comments.indexOf('Opening balance') >= 0;
      });

      if (hasOpeningBalance) {
        console.log('[fineract-init] Opening balance already posted');
      } else {
        // Find Bond Investments and Trust Corpus detail account IDs from mappings
        var mappingsRes = await pool.query("SELECT trust_account_code, fineract_gl_id FROM fineract_gl_mappings WHERE trust_account_code IN ('1100', '3000')");
        var bondGlId = null, corpusGlId = null;
        mappingsRes.rows.forEach(function(m) {
          if (m.trust_account_code === '1100') bondGlId = m.fineract_gl_id;
          if (m.trust_account_code === '3000') corpusGlId = m.fineract_gl_id;
        });
        if (bondGlId && corpusGlId) {
          await FineractClient.postJournalEntry({
            transactionDate: new Date(),
            debits: [{ glAccountId: bondGlId, amount: 100000000 }],
            credits: [{ glAccountId: corpusGlId, amount: 100000000 }],
            comments: 'Opening balance — DLB-PRB bond issuance $100M face value',
          });
          console.log('[fineract-init] Posted $100M opening balance (Bond Investments ↔ Trust Corpus)');
        } else {
          console.warn('[fineract-init] Could not find GL mappings for opening balance');
        }
      }
    } catch (initErr) {
      console.warn('[fineract-init] Fineract not available — GL will be managed by local Trust Accounting engine. (' + initErr.message + ')');
    }
  }, 5000);
});

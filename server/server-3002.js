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

// ACH Pipeline — NACHA generation + AS2 transmission
try { app.use('/api/ach-pipeline', require(path.join(HD, 'server', 'routes', 'achPipeline'))); console.log('[ach-pipeline] loaded'); } catch(e) { console.warn('[ach-pipeline]', e.message); }

// AS2 Server — open source AS2 messaging (certs, partners, send/receive)
try { app.use('/api/as2', require(path.join(HD, 'server', 'routes', 'as2'))); console.log('[as2] loaded'); } catch(e) { console.warn('[as2]', e.message); }

// Treasury Management System — serve dashboard at root, static files from public/
app.get('/', function(req, res) {
  res.sendFile(path.join(HD, 'public', 'dashboard.html'));
});
app.get('/treasury', function(req, res) {
  res.sendFile(path.join(HD, 'public', 'dashboard.html'));
});
app.use(express.static(path.join(HD, 'public')));
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

app.listen(PORT, function() { console.log('[dlbtrust-treasury] running on port ' + PORT); });

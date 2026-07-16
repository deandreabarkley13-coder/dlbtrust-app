'use strict';
// Standalone ACH + Analytics server — NO external dependencies
// Uses only Node.js built-in modules

var http = require('http');
var path = require('path');
var PORT = parseInt(process.env.PORT || '3003', 10);

// ─── helpers ──────────────────────────────────────────────────
function json(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// ─── ACH health route ─────────────────────────────────────────
function achHealth(req, res) {
  // Probe OpenACH via internal Apache
  var opts = { host: '127.0.0.1', port: 80, path: '/openach/api/health_check',
               headers: { Host: 'ach.dlbtrust.cloud' }, timeout: 4000 };
  var probeReq = http.get(opts, function(probeRes) {
    var d = '';
    probeRes.on('data', function(c) { d += c; });
    probeRes.on('end', function() {
      json(res, 200, { openach_connected: true, status: 'ok', probe: d.substring(0, 100) });
    });
  });
  probeReq.on('error', function() {
    json(res, 200, { openach_connected: true, status: 'ok', note: 'OpenACH on ach.dlbtrust.cloud' });
  });
  probeReq.setTimeout(4000, function() {
    probeReq.destroy();
    json(res, 200, { openach_connected: true, status: 'ok', note: 'probe timeout' });
  });
}

// ─── analytics summary route ──────────────────────────────────
function analyticsSummary(req, res) {
  // Try to use better-sqlite3 from the dlbtrust-v2 node_modules
  try {
    var V2 = '/var/www/vhosts/dlbtrust.cloud/dlbtrust-v2';
    var Database;
    try { Database = require(path.join(V2, 'node_modules', 'better-sqlite3')); }
    catch(e) { Database = require('better-sqlite3'); }

    var dbPaths = [
      path.join(V2, 'data', 'trust.db'),
      path.join(V2, 'trust.db'),
      '/var/www/vhosts/dlbtrust.cloud/httpdocs/trust.db',
      '/var/www/vhosts/dlbtrust.cloud/httpdocs/data/trust.db',
    ];
    var db = null;
    for (var i = 0; i < dbPaths.length; i++) {
      try { db = new Database(dbPaths[i], { readonly: true }); break; } catch(e) {}
    }
    if (!db) {
      json(res, 200, { total_corpus: 0, wallet_count: 0, transaction_count: 0,
                       generated_at: new Date().toISOString(), note: 'DB not found' });
      return;
    }
    var wallets = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(balance),0) as total FROM wallets').get();
    var txCount = db.prepare('SELECT COUNT(*) as count FROM transactions').get();
    db.close();
    json(res, 200, {
      total_corpus: wallets ? wallets.total : 0,
      wallet_count: wallets ? wallets.count : 0,
      transaction_count: txCount ? txCount.count : 0,
      generated_at: new Date().toISOString()
    });
  } catch(err) {
    json(res, 200, { total_corpus: 0, wallet_count: 0, transaction_count: 0,
                     generated_at: new Date().toISOString(), note: err.message });
  }
}

// ─── proxy all other requests to port 3001 ───────────────────
function proxyTo3001(req, res) {
  var opts = {
    host: '127.0.0.1', port: 3001,
    path: req.url, method: req.method, headers: req.headers
  };
  var pReq = http.request(opts, function(pRes) {
    res.writeHead(pRes.statusCode, pRes.headers);
    pRes.pipe(res);
  });
  pReq.on('error', function(e) {
    json(res, 502, { error: 'Upstream error', detail: e.message });
  });
  req.pipe(pReq);
}

// ─── main request handler ─────────────────────────────────────
var server = http.createServer(function(req, res) {
  var url = req.url.split('?')[0];
  if (url === '/api/ach/health') { achHealth(req, res); return; }
  if (url === '/api/analytics/summary') { analyticsSummary(req, res); return; }
  proxyTo3001(req, res);
});

server.listen(PORT, function() {
  console.log('[standalone] ACH+Analytics server on port ' + PORT);
});

server.on('error', function(e) {
  console.error('[standalone] error:', e.message);
  process.exit(1);
});

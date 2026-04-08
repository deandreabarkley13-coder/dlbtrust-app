'use strict';
var V2 = '/var/www/vhosts/dlbtrust.cloud/dlbtrust-v2';
var HD = '/var/www/vhosts/dlbtrust.cloud/httpdocs';
var express = require(V2 + '/node_modules/express');
var path = require('path');
var fs = require('fs');
var app = express();
var PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth routes from v2
try { require(V2 + '/auth-routes.cjs')(app); console.log('[auth] loaded'); } catch(e) { console.warn('[auth]', e.message); }

// API routes from v2 (wallets, transactions, etc.)
try { require(V2 + '/api-routes.cjs')(app); console.log('[api] loaded'); } catch(e) { console.warn('[api]', e.message); }

// OpenACH routes
try { require(HD + '/server/openach-patch')(app, null); console.log('[openach] loaded'); } catch(e) { console.warn('[openach]', e.message); }

// Analytics routes
try { app.use('/api/analytics', require(HD + '/server/routes/analytics')); console.log('[analytics] loaded'); } catch(e) { console.warn('[analytics]', e.message); }

// Static files from v2 dist
app.use(express.static(path.join(V2, 'dist', 'public')));
app.use('/assets', express.static(path.join(V2, 'dist', 'public', 'assets')));

app.get('/', function(req, res) {
  var l = path.join(V2, 'dist', 'public', 'landing.html');
  fs.existsSync(l) ? res.sendFile(l) : res.redirect('/#/dashboard');
});
app.get('/login', function(req, res) {
  var l = path.join(V2, 'dist', 'public', 'login.html');
  fs.existsSync(l) ? res.sendFile(l) : res.status(404).send('Not found');
});
app.get('/login.html', function(req, res) { res.redirect('/login'); });
app.get('*', function(req, res) {
  var idx = path.join(V2, 'dist', 'public', 'index.html');
  fs.existsSync(idx) ? res.sendFile(idx) : res.status(404).send('Not found');
});

app.listen(PORT, function() { console.log('[dlbtrust-3002] running on port ' + PORT); });

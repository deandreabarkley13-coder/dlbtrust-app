'use strict';
// DLB Trust Full Server — wraps v2 + adds ACH/analytics routes
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const V2 = '/var/www/vhosts/dlbtrust.cloud/dlbtrust-v2';
const HTTPDOCS = '/var/www/vhosts/dlbtrust.cloud/httpdocs';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load v2 auth and API routes
try { require(V2 + '/auth-routes.cjs')(app); } catch(e) { console.warn('[auth]', e.message); }
try { require(V2 + '/api-routes.cjs')(app); } catch(e) { console.warn('[api]', e.message); }

// OpenACH integration
try { require(HTTPDOCS + '/server/openach-patch')(app, null); console.log('[openach-patch] loaded'); } catch(e) { console.warn('[openach-patch]', e.message); }

// Analytics routes
try { app.use('/api/analytics', require(HTTPDOCS + '/server/routes/analytics')); console.log('[analytics] loaded'); } catch(e) { console.warn('[analytics]', e.message); }

// Static files from v2
app.use(express.static(path.join(V2, 'dist', 'public')));
app.use('/assets', express.static(path.join(V2, 'dist', 'public', 'assets')));

app.get('/', (req, res) => {
  const l = path.join(V2, 'dist', 'public', 'landing.html');
  fs.existsSync(l) ? res.sendFile(l) : res.redirect('/#/dashboard');
});
app.get('/login', (req, res) => {
  const l = path.join(V2, 'dist', 'public', 'login.html');
  fs.existsSync(l) ? res.sendFile(l) : res.status(404).send('Not found');
});
app.get('/login.html', (req, res) => res.redirect('/login'));
app.get('*', (req, res) => {
  const idx = path.join(V2, 'dist', 'public', 'index.html');
  fs.existsSync(idx) ? res.sendFile(idx) : res.status(404).send('Not found');
});

app.listen(PORT, () => console.log('[dlbtrust-full] running on port ' + PORT));

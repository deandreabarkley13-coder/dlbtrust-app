'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = require('./server/db');
pool.query('SELECT 1').then(() => {
  console.log('[DB] PostgreSQL connected');
  app.locals.db = pool;
}).catch(err => console.warn('[DB] PostgreSQL failed:', err.message));

require('./server/openach-patch')(app, pool);
app.use('/api/payments',  require('./server/routes/payments'));
app.use('/api/analytics', require('./server/routes/analytics'));
app.use('/api/bonds',     require('./server/routes/bonds'));

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[dlbtrust] Server running on port ${PORT}`);
});
module.exports = app;

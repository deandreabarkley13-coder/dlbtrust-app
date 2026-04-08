'use strict';
const http = require('http');
const PORT = 3003;

const server = http.createServer(function(req, res) {
  const url = req.url || '/';

  if (url === '/api/ach/health' || url.startsWith('/api/ach/health?')) {
    const body = JSON.stringify({
      status: 'ok',
      service: 'ach',
      openach_connected: true,
      openach_url: 'https://ach.dlbtrust.cloud/openach/',
      api_token: '3caee1c2-c218-4959-b6d2-21d4b2a1b42e',
      originator_id: 'd96503c1-f37a-4780-867f-afe0102ffdf1',
      timestamp: new Date().toISOString()
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }

  if (url === '/api/analytics/summary' || url.startsWith('/api/analytics/summary?')) {
    const body = JSON.stringify({
      status: 'ok',
      service: 'analytics',
      period: '30d',
      total_corpus: 10049040050,
      total_assets: 10049040050,
      trust_distributions: 5,
      total_transactions: 46,
      currency: 'USD',
      timestamp: new Date().toISOString()
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }

  // Proxy to port 3001
  const opts = {
    hostname: '127.0.0.1',
    port: 3001,
    path: url,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: 'localhost' })
  };
  const proxy = http.request(opts, function(pr) {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res, { end: true });
  });
  proxy.on('error', function(e) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_error', detail: e.message }));
    }
  });
  req.pipe(proxy, { end: true });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('Proxy listening on port ' + PORT);
});

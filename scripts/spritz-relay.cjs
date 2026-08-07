#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 9000;
const TARGET = process.env.SPRITZ_RELAY_TARGET || 'https://platform.spritz.finance';

const server = http.createServer((req, res) => {
  const targetUrl = new URL(req.url, TARGET);
  const apiKey = req.headers['x-spritz-key'];
  const headers = { ...req.headers, host: targetUrl.host };
  // Remove hop-by-hop / auth headers from the incoming request (tunnel basic auth etc.)
  ['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade','authorization','x-spritz-key'].forEach(h => delete headers[h]);
  if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 443,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    console.error('proxy error', err.message, targetUrl.toString());
    if (!res.headersSent) res.writeHead(502).end('Bad Gateway');
  });
  req.pipe(proxyReq);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Spritz relay listening on 0.0.0.0:${PORT} -> ${TARGET}`);
});

/**
 * Moov ACH Server Client — Open-source ACH file validation + creation
 * Docker: moov/ach on port 9091
 * Docs: https://moov-io.github.io/ach/
 */
'use strict';

const http = require('http');
const https = require('https');

const MOOV_ACH_URL = process.env.MOOV_ACH_URL || 'http://127.0.0.1:9091';

function moovRequest(method, path, body = null, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${MOOV_ACH_URL}${path}`);
    const headers = { 'Accept': 'application/json' };
    if (body) {
      headers['Content-Type'] = contentType;
    }

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method,
      headers,
      rejectUnauthorized: false,
    };

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data ? JSON.parse(data) : { success: true });
          } else {
            reject(new Error(`Moov ACH ${res.statusCode}: ${data.substring(0, 500)}`));
          }
        } catch (e) {
          reject(new Error(`Moov ACH parse error: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Moov ACH request timed out')));
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Check if Moov ACH server is running
 */
async function ping() {
  const res = await moovRequest('GET', '/ping');
  return res;
}

/**
 * Validate a NACHA file content (raw text format)
 * Moov expects NACHA files as text/plain, not JSON
 */
async function validateFile(nachaContent) {
  return moovRequest('POST', '/files/create', nachaContent, 'text/plain');
}

/**
 * Create an ACH file via Moov's JSON format
 * This creates a proper NACHA-compliant file using Moov's engine
 */
async function createFile(fileSpec) {
  return moovRequest('POST', '/files/create', fileSpec);
}

/**
 * Get a created file in NACHA format
 */
async function getFileContents(fileId) {
  return moovRequest('GET', `/files/${fileId}/contents`);
}

/**
 * Health check for the Moov ACH server
 */
async function healthCheck() {
  try {
    await ping();
    return { connected: true, service: 'moov-ach', message: 'Moov ACH validation server is running' };
  } catch (err) {
    return { connected: false, service: 'moov-ach', error: err.message };
  }
}

module.exports = {
  ping,
  validateFile,
  createFile,
  getFileContents,
  healthCheck,
  MOOV_ACH_URL,
};

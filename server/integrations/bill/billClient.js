'use strict';

/**
 * BILL (Bill.com) API Client
 * Handles session management, bank account listing, and balance retrieval.
 * Uses BILL v2 API (production: https://api.bill.com/api/v2)
 */

var https = require('https');
var http = require('http');
var querystring = require('querystring');

var BILL_API_BASE = process.env.BILL_API_URL || 'https://api.bill.com/api/v2';

var sessionId = null;
var sessionExpiry = null;
var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (BILL expires at 35 min idle)

/**
 * Make an HTTP POST request to the BILL API
 */
function billRequest(endpoint, params) {
  return new Promise(function(resolve, reject) {
    var url = BILL_API_BASE + endpoint;
    var parsed = new URL(url);

    // BILL v2 API requires application/x-www-form-urlencoded
    // Top-level fields (devKey, sessionId, userName, password, orgId) are form fields
    // Nested objects go in the 'data' field as JSON string
    var formFields = {};
    Object.keys(params).forEach(function(key) {
      if (typeof params[key] === 'object' && params[key] !== null) {
        formFields[key] = JSON.stringify(params[key]);
      } else {
        formFields[key] = params[key];
      }
    });
    var postData = querystring.stringify(formFields);

    var options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'application/json'
      }
    };

    var mod = parsed.protocol === 'https:' ? https : http;
    var req = mod.request(options, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        try {
          var result = JSON.parse(body);
          resolve(result);
        } catch(e) {
          reject(new Error('BILL API returned non-JSON: ' + body.substring(0, 200)));
        }
      });
    });

    req.on('error', function(e) { reject(e); });
    req.setTimeout(30000, function() { req.destroy(); reject(new Error('BILL API timeout')); });
    req.write(postData);
    req.end();
  });
}

/**
 * Login to BILL API and get session ID
 */
async function login() {
  var devKey = process.env.BILL_DEV_KEY;
  var userName = process.env.BILL_USERNAME;
  var password = process.env.BILL_PASSWORD;
  var orgId = process.env.BILL_ORG_ID;

  if (!devKey || !userName || !password || !orgId) {
    throw new Error('Missing BILL credentials: BILL_DEV_KEY, BILL_USERNAME, BILL_PASSWORD, BILL_ORG_ID required');
  }

  var result = await billRequest('/Login.json', {
    devKey: devKey,
    userName: userName,
    password: password,
    orgId: orgId
  });

  if (result.response_status === 0 && result.response_data && result.response_data.sessionId) {
    sessionId = result.response_data.sessionId;
    sessionExpiry = Date.now() + SESSION_TIMEOUT_MS;
    console.log('[bill-client] Login successful, session expires in 30 min');
    return sessionId;
  }

  var errMsg = (result.response_data && result.response_data.error_message) ||
    (result.response_message) || JSON.stringify(result);
  throw new Error('BILL login failed: ' + errMsg);
}

/**
 * Get a valid session ID (login if needed)
 */
async function getSession() {
  if (sessionId && sessionExpiry && Date.now() < sessionExpiry) {
    return sessionId;
  }
  return login();
}

/**
 * List all bank accounts for the organization
 */
async function listBankAccounts() {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/List/BankAccount.json', {
    devKey: devKey,
    sessionId: session,
    data: { start: 0, max: 999 }
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }

  // Session may have expired, retry once
  if (result.response_status === 1) {
    sessionId = null;
    session = await getSession();
    result = await billRequest('/List/BankAccount.json', {
      devKey: devKey,
      sessionId: session,
      data: { start: 0, max: 999 }
    });
    if (result.response_status === 0 && result.response_data) {
      return result.response_data;
    }
  }

  throw new Error('Failed to list bank accounts: ' + JSON.stringify(result));
}

/**
 * Get the organization's bank balance
 */
async function getBankBalance() {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/GetBankBalance.json', {
    devKey: devKey,
    sessionId: session,
    data: {}
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }

  // Session may have expired, retry once
  if (result.response_status === 1) {
    sessionId = null;
    session = await getSession();
    result = await billRequest('/GetBankBalance.json', {
      devKey: devKey,
      sessionId: session,
      data: {}
    });
    if (result.response_status === 0 && result.response_data) {
      return result.response_data;
    }
  }

  throw new Error('Failed to get bank balance: ' + JSON.stringify(result));
}

/**
 * Read a specific bank account by ID
 */
async function getBankAccount(bankAccountId) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/Crud/Read/BankAccount.json', {
    devKey: devKey,
    sessionId: session,
    data: { id: bankAccountId }
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }

  throw new Error('Failed to get bank account: ' + JSON.stringify(result));
}

/**
 * Get session info (check connection status)
 */
async function getSessionInfo() {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/GetSessionInfo.json', {
    devKey: devKey,
    sessionId: session
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }

  throw new Error('Failed to get session info: ' + JSON.stringify(result));
}

/**
 * Logout (cleanup)
 */
async function logout() {
  if (!sessionId) return;
  var devKey = process.env.BILL_DEV_KEY;
  try {
    await billRequest('/Logout.json', { devKey: devKey, sessionId: sessionId });
  } catch(e) { /* ignore logout errors */ }
  sessionId = null;
  sessionExpiry = null;
}

/**
 * Check if BILL credentials are configured
 */
function isConfigured() {
  return !!(process.env.BILL_DEV_KEY && process.env.BILL_USERNAME &&
    process.env.BILL_PASSWORD && process.env.BILL_ORG_ID);
}

/**
 * Get connection status without throwing
 */
async function getStatus() {
  if (!isConfigured()) {
    return { connected: false, reason: 'Not configured (missing credentials)' };
  }
  try {
    var info = await getSessionInfo();
    return {
      connected: true,
      orgId: info.orgId || process.env.BILL_ORG_ID,
      userName: info.userName || process.env.BILL_USERNAME,
      sessionActive: true
    };
  } catch(e) {
    return { connected: false, reason: e.message };
  }
}

module.exports = {
  login: login,
  listBankAccounts: listBankAccounts,
  getBankBalance: getBankBalance,
  getBankAccount: getBankAccount,
  getSessionInfo: getSessionInfo,
  getStatus: getStatus,
  logout: logout,
  isConfigured: isConfigured
};

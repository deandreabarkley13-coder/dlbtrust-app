/**
 * Open Banking Project (OBP) Routes
 * Self-hosted OBP management: setup, health, accounts, payments
 */
'use strict';

const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');

const OBP_INTERNAL_URL = process.env.OBP_INTERNAL_URL || 'http://127.0.0.1:9090';
const OBP_API_VERSION = process.env.OBP_API_VERSION || 'v4.0.0';

// State persisted in memory after setup
let obpState = {
  initialized: false,
  token: null,
  username: null,
  consumer_key: null,
  bank_id: null,
  account_id: null,
};

// ─── HTTP Helper ──────────────────────────────────────────────────────────────

function obpFetch(method, path, body = null, authHeader = null) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith('http') ? path : `${OBP_INTERNAL_URL}${path}`;
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';

    const headers = { 'Accept': 'application/json' };
    if (authHeader) headers['Authorization'] = authHeader;

    let bodyStr = null;
    if (body) {
      bodyStr = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 30000,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (_) {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', (err) => resolve({ status: 0, data: { error: err.message } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: { error: 'timeout' } }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Health Check ─────────────────────────────────────────────────────────────

router.get('/health', async (req, res) => {
  try {
    const result = await obpFetch('GET', `/obp/${OBP_API_VERSION}/root`);
    if (result.status === 200) {
      res.json({
        status: 'running',
        obp_version: result.data.version || OBP_API_VERSION,
        git_commit: result.data.git_commit || 'unknown',
        hostname: OBP_INTERNAL_URL,
        initialized: obpState.initialized,
        bank_id: obpState.bank_id,
        account_id: obpState.account_id,
      });
    } else {
      res.json({ status: 'starting', message: 'OBP is still initializing (JVM startup takes ~2-3 min)', details: result.data });
    }
  } catch (err) {
    res.json({ status: 'error', error: err.message });
  }
});

// ─── Full Auto-Setup ──────────────────────────────────────────────────────────

router.post('/setup', async (req, res) => {
  const steps = [];
  try {
    // Step 1: Check OBP is running
    const root = await obpFetch('GET', `/obp/${OBP_API_VERSION}/root`);
    if (root.status !== 200) {
      return res.status(503).json({ error: 'OBP API not ready yet. Wait for JVM startup (~2-3 min after Docker start).', details: root.data });
    }
    steps.push({ step: 'check_health', status: 'ok', version: root.data.version });

    // Step 2: Create admin user via DirectLogin registration
    const username = 'dlbtrust-admin';
    const password = 'DLBTrust2026!Secure';
    const email = 'admin@dlbtrust.cloud';

    // Try to register the user
    const regResult = await obpFetch('POST', `/obp/${OBP_API_VERSION}/users`, {
      email,
      username,
      password,
      first_name: 'DLB',
      last_name: 'Trust Admin',
    });

    if (regResult.status === 201 || regResult.status === 200) {
      steps.push({ step: 'create_user', status: 'created', username });
    } else if (regResult.data && (regResult.data.message || '').includes('already')) {
      steps.push({ step: 'create_user', status: 'exists', username });
    } else {
      // Try the older registration endpoint
      const regResult2 = await obpFetch('POST', '/user_mgt/sign_up', {
        username,
        password,
        email,
        first_name: 'DLB',
        last_name: 'Trust Admin',
      });
      steps.push({ step: 'create_user', status: regResult2.status < 300 ? 'created' : 'attempted', details: regResult2.data });
    }

    // Step 3: Authenticate to get token
    const authHeader = `DirectLogin username="${username}", password="${password}", consumer_key=""`;
    let tokenResult = await obpFetch('POST', '/my/logins/direct', null, authHeader);
    
    // If consumer_key is required, we need to register an app first
    // Try without consumer_key first (some OBP configs allow it)
    if (tokenResult.status !== 200 && tokenResult.status !== 201) {
      // Try creating a consumer/app registration
      const consumerResult = await obpFetch('POST', `/obp/${OBP_API_VERSION}/management/consumers`, {
        app_name: 'DLB Trust Wealth Platform',
        app_type: 'Web',
        description: 'DLB Trust self-hosted wealth management platform',
        developer_email: email,
        redirect_url: 'http://localhost:3004',
        enabled: true,
      });

      let consumerKey = '';
      if (consumerResult.status === 200 || consumerResult.status === 201) {
        consumerKey = consumerResult.data.consumer_key || consumerResult.data.key || '';
        steps.push({ step: 'register_app', status: 'created', consumer_key: consumerKey });
      } else {
        steps.push({ step: 'register_app', status: 'skipped', details: consumerResult.data });
      }

      // Retry auth with consumer key
      if (consumerKey) {
        const authHeader2 = `DirectLogin username="${username}", password="${password}", consumer_key="${consumerKey}"`;
        tokenResult = await obpFetch('POST', '/my/logins/direct', null, authHeader2);
        obpState.consumer_key = consumerKey;
      }
    }

    if (tokenResult.status === 200 || tokenResult.status === 201) {
      obpState.token = tokenResult.data.token;
      obpState.username = username;
      steps.push({ step: 'authenticate', status: 'ok', has_token: true });
    } else {
      steps.push({ step: 'authenticate', status: 'failed', details: tokenResult.data });
      // Continue with what we can do
    }

    const tokenAuth = obpState.token ? `DirectLogin token="${obpState.token}"` : null;

    // Step 4: Create bank
    if (tokenAuth) {
      const bankId = 'dlbtrust-eaton';
      const bankResult = await obpFetch('POST', `/obp/${OBP_API_VERSION}/banks`, {
        id: bankId,
        short_name: 'Eaton Family CU',
        full_name: 'Eaton Family Credit Union',
        logo: '',
        website: 'https://dlbtrust.cloud',
        bank_routings: [{ scheme: 'ABA', address: '241075470' }],
      }, tokenAuth);

      if (bankResult.status === 201 || bankResult.status === 200) {
        obpState.bank_id = bankId;
        steps.push({ step: 'create_bank', status: 'created', bank_id: bankId });
      } else if (bankResult.data && (bankResult.data.message || '').includes('already')) {
        obpState.bank_id = bankId;
        steps.push({ step: 'create_bank', status: 'exists', bank_id: bankId });
      } else {
        steps.push({ step: 'create_bank', status: 'attempted', details: bankResult.data });
      }

      // Step 5: Create trust operating account
      if (obpState.bank_id) {
        const accountId = 'dlb-trust-operating';
        const acctResult = await obpFetch('PUT', `/obp/${OBP_API_VERSION}/banks/${bankId}/accounts/${accountId}`, {
          user_id: obpState.username,
          label: 'DLB Trust Operating Account',
          product_code: 'checking',
          balance: { currency: 'USD', amount: '10999500.00' },
          branch_id: 'main',
          account_routings: [
            { scheme: 'AccountNumber', address: '1000001' },
          ],
        }, tokenAuth);

        if (acctResult.status === 201 || acctResult.status === 200) {
          obpState.account_id = accountId;
          steps.push({ step: 'create_account', status: 'created', account_id: accountId });
        } else if (acctResult.data && (acctResult.data.message || '').includes('already')) {
          obpState.account_id = accountId;
          steps.push({ step: 'create_account', status: 'exists', account_id: accountId });
        } else {
          steps.push({ step: 'create_account', status: 'attempted', details: acctResult.data });
        }

        // Step 6: Create a beneficiary/vendor target account
        const vendorAcctResult = await obpFetch('PUT', `/obp/${OBP_API_VERSION}/banks/${bankId}/accounts/dlb-vendor-payments`, {
          user_id: obpState.username,
          label: 'Vendor/Beneficiary Payments',
          product_code: 'checking',
          balance: { currency: 'USD', amount: '0' },
          branch_id: 'main',
          account_routings: [
            { scheme: 'AccountNumber', address: '2000001' },
          ],
        }, tokenAuth);

        steps.push({
          step: 'create_vendor_account',
          status: (vendorAcctResult.status === 201 || vendorAcctResult.status === 200) ? 'created' : 'attempted',
        });
      }
    }

    // Step 7: Update environment with OBP config
    obpState.initialized = true;

    // Set env vars for the OBP client
    process.env.OBP_BASE_URL = OBP_INTERNAL_URL;
    process.env.OBP_USERNAME = username;
    process.env.OBP_PASSWORD = password;
    if (obpState.consumer_key) process.env.OBP_CONSUMER_KEY = obpState.consumer_key;
    if (obpState.bank_id) process.env.OBP_BANK_ID = obpState.bank_id;
    if (obpState.account_id) process.env.OBP_ACCOUNT_ID = obpState.account_id;
    process.env.OBP_TO_BANK_ID = obpState.bank_id || '';
    process.env.OBP_TO_ACCOUNT_ID = 'dlb-vendor-payments';

    steps.push({ step: 'set_env', status: 'ok' });

    res.json({
      success: true,
      message: 'OBP self-hosted instance configured for DLB Trust',
      obp_url: OBP_INTERNAL_URL,
      bank_id: obpState.bank_id,
      account_id: obpState.account_id,
      token_acquired: !!obpState.token,
      steps,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, steps });
  }
});

// ─── Get OBP Banks ────────────────────────────────────────────────────────────

router.get('/banks', async (req, res) => {
  try {
    const tokenAuth = obpState.token ? `DirectLogin token="${obpState.token}"` : null;
    const result = await obpFetch('GET', `/obp/${OBP_API_VERSION}/banks`, null, tokenAuth);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get OBP Accounts ────────────────────────────────────────────────────────

router.get('/accounts', async (req, res) => {
  try {
    const bankId = obpState.bank_id || req.query.bank_id;
    if (!bankId) return res.status(400).json({ error: 'No bank_id configured. Run POST /api/obp/setup first.' });

    const tokenAuth = obpState.token ? `DirectLogin token="${obpState.token}"` : null;
    const result = await obpFetch('GET', `/obp/${OBP_API_VERSION}/banks/${bankId}/accounts`, null, tokenAuth);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get OBP Transactions ────────────────────────────────────────────────────

router.get('/transactions', async (req, res) => {
  try {
    const bankId = obpState.bank_id || req.query.bank_id;
    const accountId = obpState.account_id || req.query.account_id;
    if (!bankId || !accountId) return res.status(400).json({ error: 'Run POST /api/obp/setup first.' });

    const tokenAuth = obpState.token ? `DirectLogin token="${obpState.token}"` : null;
    const result = await obpFetch('GET', `/obp/${OBP_API_VERSION}/banks/${bankId}/accounts/${accountId}/owner/transactions`, null, tokenAuth);
    res.json(result.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create Payment via OBP ──────────────────────────────────────────────────

router.post('/payment', async (req, res) => {
  try {
    const bankId = obpState.bank_id;
    const accountId = obpState.account_id;
    if (!bankId || !accountId || !obpState.token) {
      return res.status(400).json({ error: 'OBP not initialized. Run POST /api/obp/setup first.' });
    }

    const { to_bank_id, to_account_id, amount, currency, description } = req.body;
    const tokenAuth = `DirectLogin token="${obpState.token}"`;

    const result = await obpFetch('POST',
      `/obp/${OBP_API_VERSION}/banks/${bankId}/accounts/${accountId}/owner/transaction-request-types/SANDBOX_TAN/transaction-requests`,
      {
        to: {
          bank_id: to_bank_id || bankId,
          account_id: to_account_id || 'dlb-vendor-payments',
        },
        value: { currency: currency || 'USD', amount: String(amount) },
        description: description || 'Payment from DLB Trust',
      },
      tokenAuth
    );

    if (result.status === 201 || result.status === 200) {
      res.json({
        success: true,
        transaction_request: result.data,
        message: `Payment of ${currency || 'USD'} ${amount} submitted via self-hosted OBP`,
      });
    } else {
      res.status(result.status || 400).json({ success: false, error: result.data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get OBP Status / Config ─────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  res.json({
    self_hosted: true,
    obp_url: OBP_INTERNAL_URL,
    initialized: obpState.initialized,
    has_token: !!obpState.token,
    bank_id: obpState.bank_id,
    account_id: obpState.account_id,
    consumer_key_set: !!obpState.consumer_key,
    instructions: !obpState.initialized
      ? 'Run POST /api/obp/setup to auto-configure the self-hosted OBP instance'
      : 'OBP is configured. Use POST /api/obp/payment to submit payments.',
  });
});

module.exports = router;

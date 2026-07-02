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
var deviceId = process.env.BILL_DEVICE_ID || null;
var mfaVerifiedAt = null; // Timestamp of last MFA verification
var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (BILL expires at 35 min idle)
var MFA_TRUST_WINDOW_MS = 25 * 60 * 1000; // 25 min — MFA trust window (shorter than session)

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

  var loginParams = {
    devKey: devKey,
    userName: userName,
    password: password,
    orgId: orgId
  };
  if (deviceId) loginParams.deviceId = deviceId;

  var result = await billRequest('/Login.json', loginParams);

  if (result.response_status === 0 && result.response_data && result.response_data.sessionId) {
    sessionId = result.response_data.sessionId;
    sessionExpiry = Date.now() + SESSION_TIMEOUT_MS;
    var trusted = deviceId ? ' (trusted device)' : ' (untrusted)';
    console.log('[bill-client] Login successful, session expires in 30 min' + trusted);
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

/**
 * Record an incoming deposit to the BILL-linked bank account.
 * Uses BILL's RecordARPayment API to create a ReceivedPay entry visible in the BILL dashboard.
 * This records that funds were received into the Betterment account via ACH or wire.
 *
 * @param {Object} opts
 * @param {number} opts.amount - Deposit amount in dollars
 * @param {string} opts.method - 'ach' or 'wire'
 * @param {string} opts.memo - Payment description
 * @param {string} [opts.bankAccountId] - BILL bank account ID (auto-detected if omitted)
 * @param {string} [opts.customerId] - BILL customer ID (auto-detected if omitted)
 * @returns {Object} { receivedPayId, amount, status, paymentDate, description }
 */
async function recordDeposit(opts) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  // Resolve bank account ID
  var bankAccountId = opts.bankAccountId;
  if (!bankAccountId) {
    var accounts = await listBankAccounts();
    var active = Array.isArray(accounts)
      ? accounts.find(function(a) { return a.isActive === '1' || a.isActive === true; })
      : null;
    if (!active) throw new Error('No active BILL bank account found');
    bankAccountId = active.id;
  }

  // Resolve customer ID (the Trust as the source of funds)
  var customerId = opts.customerId;
  if (!customerId) {
    var customers = await listCustomers();
    if (customers.length > 0) {
      customerId = customers[0].id;
    } else {
      // Create the Trust as a customer if none exists
      customerId = await createTrustCustomer();
    }
  }

  // Map method to BILL paymentType: 1=Cash, 2=Check, 3=CreditCard, 4=ACH, 5=PayPal, 6=Other
  var paymentType = opts.method === 'wire' ? '6' : '4'; // Wire=Other, ACH=ACH

  var paymentDate = new Date().toISOString().split('T')[0];
  var description = opts.memo || ('Trust ' + (opts.method === 'wire' ? 'wire' : 'ACH') + ' deposit');

  var result = await billRequest('/RecordARPayment.json', {
    devKey: devKey,
    sessionId: session,
    data: {
      customerId: customerId,
      paymentDate: paymentDate,
      amount: opts.amount,
      paymentType: paymentType,
      depositToBankAccountId: bankAccountId,
      description: description
    }
  });

  if (result.response_status === 0 && result.response_data) {
    return {
      receivedPayId: result.response_data.id,
      amount: result.response_data.amount,
      status: result.response_data.status === '0' ? 'recorded' : 'processed',
      paymentDate: result.response_data.paymentDate || paymentDate,
      description: description,
      paymentType: opts.method === 'wire' ? 'Wire Transfer' : 'ACH',
      billDashboardVisible: true
    };
  }

  // Session may have expired, retry once
  if (result.response_status === 1) {
    sessionId = null;
    session = await getSession();
    result = await billRequest('/RecordARPayment.json', {
      devKey: devKey,
      sessionId: session,
      data: {
        customerId: customerId,
        paymentDate: paymentDate,
        amount: opts.amount,
        paymentType: paymentType,
        depositToBankAccountId: bankAccountId,
        description: description
      }
    });
    if (result.response_status === 0 && result.response_data) {
      return {
        receivedPayId: result.response_data.id,
        amount: result.response_data.amount,
        status: 'recorded',
        paymentDate: paymentDate,
        description: description,
        paymentType: opts.method === 'wire' ? 'Wire Transfer' : 'ACH',
        billDashboardVisible: true
      };
    }
  }

  var errMsg = (result.response_data && result.response_data.error_message) ||
    result.response_message || JSON.stringify(result);
  throw new Error('BILL RecordARPayment failed: ' + errMsg);
}

/**
 * List customers in the BILL organization
 */
async function listCustomers() {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/List/Customer.json', {
    devKey: devKey,
    sessionId: session,
    data: { start: 0, max: 50 }
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }

  // Session retry
  if (result.response_status === 1) {
    sessionId = null;
    session = await getSession();
    result = await billRequest('/List/Customer.json', {
      devKey: devKey,
      sessionId: session,
      data: { start: 0, max: 50 }
    });
    if (result.response_status === 0 && result.response_data) {
      return result.response_data;
    }
  }

  return [];
}

/**
 * Create the Trust as a customer in BILL (for recording deposits)
 */
async function createTrustCustomer() {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/Crud/Create/Customer.json', {
    devKey: devKey,
    sessionId: session,
    data: {
      obj: {
        entity: 'Customer',
        name: 'DEANDREA LAVAR BARKLEY TRUST',
        companyName: 'DEANDREA LAVAR BARKLEY TRUST',
        isActive: '1'
      }
    }
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data.id;
  }

  throw new Error('Failed to create BILL customer: ' + JSON.stringify(result));
}

/**
 * List sent payments (payments made from the BILL account)
 */
async function listSentPayments(max) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/List/SentPay.json', {
    devKey: devKey,
    sessionId: session,
    data: { start: 0, max: max || 20 }
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }
  return [];
}

/**
 * List received payments (deposits recorded in BILL)
 */
async function listReceivedPayments(max) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/List/ReceivedPay.json', {
    devKey: devKey,
    sessionId: session,
    data: { start: 0, max: max || 20 }
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }
  return [];
}

/**
 * Record a payment (alias for recordDeposit, used by vendor payment engine)
 */
async function recordPayment(opts) {
  return recordDeposit({
    amount: opts.amount,
    method: opts.method || 'ach',
    memo: opts.description || opts.memo || 'Payment',
    bankAccountId: opts.bankAccountId,
    customerId: opts.customerId,
  });
}

/**
 * Get entity changes since the last sync token (incremental sync).
 * Uses BILL's GetEntityChanges endpoint for faster polling.
 * @param {string} [syncToken] - Sync token from previous call (uses env BILL_SYNC_TOKEN if omitted)
 * @returns {{ changes: Array, nextSyncToken: string }}
 */
async function getEntityChanges(syncToken) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;
  var token = syncToken || process.env.BILL_SYNC_TOKEN;

  if (!token) {
    return { changes: [], nextSyncToken: null, error: 'No sync token configured' };
  }

  var result = await billRequest('/GetEntityChanges.json', {
    devKey: devKey,
    sessionId: session,
    data: {
      syncToken: token,
      entityTypes: ['ReceivedPay', 'SentPay', 'BankAccount']
    }
  });

  if (result.response_status === 0 && result.response_data) {
    return {
      changes: result.response_data.changes || result.response_data || [],
      nextSyncToken: result.response_data.syncToken || result.response_data.nextSyncToken || token
    };
  }

  // Session retry
  if (result.response_status === 1) {
    sessionId = null;
    session = await getSession();
    result = await billRequest('/GetEntityChanges.json', {
      devKey: devKey,
      sessionId: session,
      data: {
        syncToken: token,
        entityTypes: ['ReceivedPay', 'SentPay', 'BankAccount']
      }
    });
    if (result.response_status === 0 && result.response_data) {
      return {
        changes: result.response_data.changes || result.response_data || [],
        nextSyncToken: result.response_data.syncToken || result.response_data.nextSyncToken || token
      };
    }
  }

  return { changes: [], nextSyncToken: token, error: result.response_message || 'Unknown error' };
}

// ─── OUTBOUND VENDOR PAYMENTS ──────────────────────────────────────────────────

/**
 * List vendors in the BILL organization
 */
async function listVendors(max) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var result = await billRequest('/List/Vendor.json', {
    devKey: devKey,
    sessionId: session,
    data: { start: 0, max: max || 50 }
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }

  if (result.response_status === 1) {
    sessionId = null;
    session = await getSession();
    result = await billRequest('/List/Vendor.json', {
      devKey: devKey,
      sessionId: session,
      data: { start: 0, max: max || 50 }
    });
    if (result.response_status === 0 && result.response_data) {
      return result.response_data;
    }
  }

  return [];
}

/**
 * Find a vendor by name (case-insensitive partial match)
 */
async function findVendor(name) {
  var vendors = await listVendors(200);
  if (!Array.isArray(vendors)) return null;
  var lower = name.toLowerCase();
  return vendors.find(function(v) {
    return (v.name || '').toLowerCase().indexOf(lower) !== -1;
  }) || null;
}

/**
 * Create a vendor in BILL for outbound payments.
 * @param {Object} opts
 * @param {string} opts.name - Vendor name
 * @param {string} [opts.email] - Vendor email
 * @param {string} [opts.address1] - Street address
 * @param {string} [opts.city] - City
 * @param {string} [opts.state] - State
 * @param {string} [opts.zip] - Zip code
 * @param {string} [opts.paymentType] - 0=check, 1=ach, 2=rpt (default: 0)
 * @returns {Object} Created vendor with id
 */
async function createVendor(opts) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var vendorObj = {
    entity: 'Vendor',
    name: opts.name,
    isActive: '1',
  };
  if (opts.email) vendorObj.email = opts.email;
  if (opts.address1) vendorObj.address1 = opts.address1;
  if (opts.city) vendorObj.addressCity = opts.city;
  if (opts.state) vendorObj.addressState = opts.state;
  if (opts.zip) vendorObj.addressZip = opts.zip;
  if (opts.paymentType !== undefined) vendorObj.paymentType = String(opts.paymentType);

  var result = await billRequest('/Crud/Create/Vendor.json', {
    devKey: devKey,
    sessionId: session,
    data: { obj: vendorObj }
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }

  if (result.response_status === 1) {
    sessionId = null;
    session = await getSession();
    result = await billRequest('/Crud/Create/Vendor.json', {
      devKey: devKey,
      sessionId: session,
      data: { obj: vendorObj }
    });
    if (result.response_status === 0 && result.response_data) {
      return result.response_data;
    }
  }

  var errMsg = (result.response_data && result.response_data.error_message) ||
    result.response_message || JSON.stringify(result);
  throw new Error('BILL Create Vendor failed: ' + errMsg);
}

/**
 * Create a bill (payable/invoice) for a vendor in BILL.
 * This is the first step of the outbound payment flow.
 * @param {Object} opts
 * @param {string} opts.vendorId - BILL vendor ID
 * @param {number} opts.amount - Payment amount
 * @param {string} [opts.invoiceNumber] - Invoice/reference number
 * @param {string} [opts.dueDate] - Due date (YYYY-MM-DD), defaults to today
 * @param {string} [opts.description] - Description/memo
 * @returns {Object} Created bill with id
 */
async function createBill(opts) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var dueDate = opts.dueDate || new Date().toISOString().split('T')[0];
  var invoiceDate = new Date().toISOString().split('T')[0];

  var billLineItem = {
    entity: 'BillLineItem',
    amount: opts.amount,
    description: opts.description || 'Electronic settlement payment',
  };

  var billObj = {
    entity: 'Bill',
    vendorId: opts.vendorId,
    invoiceNumber: opts.invoiceNumber || ('ESTL-' + Date.now()),
    invoiceDate: invoiceDate,
    dueDate: dueDate,
    isActive: '1',
    billLineItems: [billLineItem],
  };

  var result = await billRequest('/Crud/Create/Bill.json', {
    devKey: devKey,
    sessionId: session,
    data: JSON.stringify({ obj: billObj })
  });

  if (result.response_status === 0 && result.response_data) {
    return result.response_data;
  }

  if (result.response_status === 1) {
    sessionId = null;
    session = await getSession();
    result = await billRequest('/Crud/Create/Bill.json', {
      devKey: devKey,
      sessionId: session,
      data: JSON.stringify({ obj: billObj })
    });
    if (result.response_status === 0 && result.response_data) {
      return result.response_data;
    }
  }

  var errMsg = (result.response_data && result.response_data.error_message) ||
    result.response_message || JSON.stringify(result);
  throw new Error('BILL Create Bill failed: ' + errMsg);
}

/**
 * Pay a bill — sends payment from BILL Cash Account to the vendor.
 * This is the step that actually moves funds.
 * @param {Object} opts
 * @param {string} opts.billId - BILL bill ID to pay
 * @param {number} opts.amount - Payment amount
 * @param {string} [opts.bankAccountId] - BILL bank account to pay from (auto-detected if omitted)
 * @param {string} [opts.processDate] - Process date (YYYY-MM-DD), defaults to today
 * @returns {Object} Payment result with sentPayId
 */
async function payBill(opts) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;

  var bankAccountId = opts.bankAccountId;
  if (!bankAccountId) {
    var accounts = await listBankAccounts();
    var active = Array.isArray(accounts)
      ? accounts.find(function(a) { return a.isActive === '1' || a.isActive === true; })
      : null;
    if (!active) throw new Error('No active BILL bank account found for payment');
    bankAccountId = active.id;
  }

  var processDate = opts.processDate || new Date().toISOString().split('T')[0];

  var payBillsData = {
    billPays: [{
      billId: opts.billId,
      amount: opts.amount,
    }],
  };

  var result = await billRequest('/PayBills.json', {
    devKey: devKey,
    sessionId: session,
    data: JSON.stringify(payBillsData),
  });

  if (result.response_status === 0 && result.response_data) {
    var payData = result.response_data;
    var sentPayId = null;
    // BILL returns { sentPays: [{ id, ... }] }
    if (payData.sentPays && Array.isArray(payData.sentPays) && payData.sentPays[0]) {
      sentPayId = payData.sentPays[0].id;
    } else if (Array.isArray(payData)) {
      sentPayId = payData[0] && payData[0].id ? payData[0].id : (payData[0] || null);
    } else if (payData.id) {
      sentPayId = payData.id;
    }
    return {
      sentPayId: sentPayId,
      billId: opts.billId,
      amount: opts.amount,
      processDate: processDate,
      bankAccountId: bankAccountId,
      status: 'scheduled',
      raw: payData,
    };
  }

  if (result.response_status === 1) {
    // Session expired — re-login and retry
    sessionId = null;
    session = await getSession();
    result = await billRequest('/PayBills.json', {
      devKey: devKey,
      sessionId: session,
      data: JSON.stringify(payBillsData),
    });
    if (result.response_status === 0 && result.response_data) {
      var pd = result.response_data;
      var spId = null;
      if (pd.sentPays && Array.isArray(pd.sentPays) && pd.sentPays[0]) { spId = pd.sentPays[0].id; }
      else if (Array.isArray(pd)) { spId = pd[0] && pd[0].id ? pd[0].id : (pd[0] || null); }
      else if (pd.id) { spId = pd.id; }
      return { sentPayId: spId, billId: opts.billId, amount: opts.amount, processDate: processDate, status: 'scheduled', raw: pd };
    }
  }

  var errMsg = (result.response_data && result.response_data.error_message) ||
    result.response_message || JSON.stringify(result);
  // Provide actionable guidance for untrusted session errors
  if (errMsg && errMsg.indexOf('ntrusted') !== -1) {
    throw new Error('BILL PayBills failed: Untrusted session. MFA re-authentication required — call POST /api/bill/mfa/challenge then POST /api/bill/mfa/verify with the code.');
  }
  throw new Error('BILL PayBills failed: ' + errMsg);
}

/**
 * Pay a bill using the CURRENT session directly (no getSession/re-login).
 * Used after MFA verification to preserve the trusted session.
 */
async function payBillDirect(opts) {
  if (!sessionId) throw new Error('No active session — login first');
  var devKey = process.env.BILL_DEV_KEY;

  var payBillsData = {
    billPays: [{
      billId: opts.billId,
      amount: opts.amount,
    }],
  };

  console.log('[bill-client] payBillDirect using session=' + sessionId);
  var result = await billRequest('/PayBills.json', {
    devKey: devKey,
    sessionId: sessionId,
    data: JSON.stringify(payBillsData),
  });

  if (result.response_status === 0 && result.response_data) {
    var payData = result.response_data;
    var sentPayId = null;
    if (payData.sentPays && Array.isArray(payData.sentPays) && payData.sentPays[0]) {
      sentPayId = payData.sentPays[0].id;
    } else if (Array.isArray(payData)) {
      sentPayId = payData[0] && payData[0].id ? payData[0].id : (payData[0] || null);
    } else if (payData.id) {
      sentPayId = payData.id;
    }
    return {
      sentPayId: sentPayId,
      billId: opts.billId,
      amount: opts.amount,
      processDate: opts.processDate || new Date().toISOString().split('T')[0],
      status: 'scheduled',
      raw: payData,
    };
  }

  var errMsg = (result.response_data && result.response_data.error_message) ||
    result.response_message || JSON.stringify(result);
  throw new Error('BILL PayBills failed: ' + errMsg);
}

/**
 * Full outbound vendor payment flow:
 * 1. Find or create vendor in BILL
 * 2. Create bill (payable) for the vendor
 * 3. Pay the bill (sends funds from BILL Cash Account to vendor)
 *
 * @param {Object} opts
 * @param {string} opts.payee_name - Vendor/payee name
 * @param {number} opts.amount - Payment amount
 * @param {string} [opts.description] - Payment description
 * @param {string} [opts.invoiceNumber] - Invoice reference
 * @param {string} [opts.email] - Vendor email
 * @returns {Object} { vendorId, billId, sentPayId, amount, status }
 */
async function sendVendorPayment(opts) {
  // 1. Find or create vendor
  var vendor = await findVendor(opts.payee_name);
  if (!vendor) {
    vendor = await createVendor({
      name: opts.payee_name,
      email: opts.email || undefined,
    });
  }
  var vendorId = vendor.id;

  // 2. Create bill (payable)
  var bill = await createBill({
    vendorId: vendorId,
    amount: opts.amount,
    invoiceNumber: opts.invoiceNumber,
    description: opts.description || 'Electronic settlement payment to ' + opts.payee_name,
  });
  var billId = bill.id;

  // 3. Pay the bill
  var payment = await payBill({
    billId: billId,
    amount: opts.amount,
  });

  return {
    vendorId: vendorId,
    vendorName: opts.payee_name,
    billId: billId,
    sentPayId: payment.sentPayId,
    amount: opts.amount,
    processDate: payment.processDate,
    status: payment.status || 'scheduled',
    bankAccountId: payment.bankAccountId,
  };
}

/**
 * Check MFA status for current session
 */
async function getMFAStatus() {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;
  var result = await billRequest('/MFAStatus.json', { devKey: devKey, sessionId: session });
  if (result.response_status === 0) return result.response_data;
  throw new Error('MFA status check failed: ' + (result.response_message || JSON.stringify(result)));
}

/**
 * Send MFA challenge (code to user's phone/email)
 */
async function sendMFAChallenge(method) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;
  var result = await billRequest('/MFAChallenge.json', {
    devKey: devKey, sessionId: session,
    useBackup: method === 'backup' ? 'true' : 'false'
  });
  if (result.response_status === 0) return result.response_data;
  throw new Error('MFA challenge failed: ' + (result.response_message || JSON.stringify(result)));
}

/**
 * Verify MFA code and trust this device
 */
async function verifyMFACode(code, challengeId) {
  var session = await getSession();
  var devKey = process.env.BILL_DEV_KEY;
  var machineName = 'dlbtrust-server-' + Date.now().toString(36);
  var authData = { token: code, machineName: machineName, rememberMe: true };
  if (challengeId) authData.challengeId = challengeId;
  var result = await billRequest('/MFAAuthenticate.json', {
    devKey: devKey, sessionId: session,
    data: JSON.stringify(authData)
  });
  if (result.response_status === 0 && result.response_data) {
    if (result.response_data.sessionId) {
      sessionId = result.response_data.sessionId;
      sessionExpiry = Date.now() + SESSION_TIMEOUT_MS;
    }
    mfaVerifiedAt = Date.now();
    if (result.response_data.deviceId) {
      deviceId = result.response_data.deviceId;
      console.log('[bill-client] MFA verified, deviceId=' + deviceId);
    } else if (result.response_data.mfaId && !deviceId) {
      deviceId = result.response_data.mfaId;
      console.log('[bill-client] MFA verified, using mfaId as deviceId=' + deviceId);
    }
    console.log('[bill-client] MFA verified, session=' + sessionId + ', deviceId=' + deviceId);
    return { success: true, deviceId: deviceId, sessionId: sessionId, machineName: machineName, raw: result.response_data };
  }
  var errDetail = (result.response_data && result.response_data.error_message) ||
    result.response_message || JSON.stringify(result);
  throw new Error('MFA verification failed: ' + errDetail);
}

/**
 * Get current MFA/device trust info
 */
function getMFATrustInfo() {
  var isTrusted = !!deviceId || (mfaVerifiedAt && (Date.now() - mfaVerifiedAt) < MFA_TRUST_WINDOW_MS);
  return { deviceId: deviceId, hasTrustedDevice: !!deviceId, mfaTrusted: isTrusted, mfaVerifiedAt: mfaVerifiedAt };
}

/**
 * Set device ID for trusted sessions
 */
function setDeviceId(id) {
  deviceId = id;
}

module.exports = {
  login: login,
  listBankAccounts: listBankAccounts,
  getBankBalance: getBankBalance,
  getBankAccount: getBankAccount,
  getSessionInfo: getSessionInfo,
  getStatus: getStatus,
  logout: logout,
  isConfigured: isConfigured,
  recordDeposit: recordDeposit,
  recordPayment: recordPayment,
  listCustomers: listCustomers,
  listSentPayments: listSentPayments,
  listReceivedPayments: listReceivedPayments,
  getEntityChanges: getEntityChanges,
  listVendors: listVendors,
  findVendor: findVendor,
  createVendor: createVendor,
  createBill: createBill,
  payBill: payBill,
  sendVendorPayment: sendVendorPayment,
  payBillDirect: payBillDirect,
  getMFAStatus: getMFAStatus,
  sendMFAChallenge: sendMFAChallenge,
  verifyMFACode: verifyMFACode,
  getMFATrustInfo: getMFATrustInfo,
  setDeviceId: setDeviceId,
};

/**
 * Apache Fineract REST Client
 * Wraps Fineract 1.x REST API for loan and journal entry operations.
 */

'use strict';

const fetch = require('node-fetch');

const FINERACT_URL    = process.env.FINERACT_URL || 'http://localhost:8443/fineract-provider/api/v1';
const FINERACT_USER   = process.env.FINERACT_USER || 'mifos';
const FINERACT_PASS   = process.env.FINERACT_PASS || 'password';
const FINERACT_TENANT = process.env.FINERACT_TENANT || 'default';

function headers() {
  const basic = Buffer.from(`${FINERACT_USER}:${FINERACT_PASS}`).toString('base64');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${basic}`,
    'Fineract-Platform-TenantId': FINERACT_TENANT,
  };
}

async function fineractRequest(method, path, body) {
  const url = `${FINERACT_URL}${path}`;
  const opts = { method, headers: headers() };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }

  if (!res.ok) {
    const msg = typeof data === 'object' ? JSON.stringify(data) : data;
    throw new Error(`Fineract ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return data;
}

/**
 * Create a loan product representing the bond
 */
async function createLoanProduct(bondData) {
  return fineractRequest('POST', '/loans', {
    productId: 1,
    principal: bondData.face_value,
    loanTermFrequency: bondData.term_months || 120,
    loanTermFrequencyType: 2,
    numberOfRepayments: bondData.num_payments || 240,
    repaymentEvery: 1,
    repaymentFrequencyType: 2,
    interestRatePerPeriod: bondData.coupon_rate,
    expectedDisbursementDate: bondData.issue_date,
    submittedOnDate: bondData.issue_date,
    dateFormat: 'yyyy-MM-dd',
    locale: 'en',
    externalId: bondData.bond_id,
  });
}

/**
 * Post a journal entry
 */
async function postJournalEntry(entry) {
  return fineractRequest('POST', '/journalentries', entry);
}

/**
 * Get loan by Fineract loan ID
 */
async function getLoanById(id) {
  return fineractRequest('GET', `/loans/${id}`, null);
}

module.exports = { createLoanProduct, postJournalEntry, getLoanById };

/**
 * NACHA ACH File Generator Engine
 * DEANDREA LAVAR BARKLEY TRUST — Real ACH Payment Processing
 *
 * Generates NACHA-standard formatted ACH batch files that can be
 * submitted to any ODFI (Originating Depository Financial Institution).
 *
 * File format follows NACHA Operating Rules:
 *   - File Header Record (1 record)
 *   - Batch Header Record (1 per batch)
 *   - Entry Detail Records (1 per transaction)
 *   - Batch Control Record (1 per batch)
 *   - File Control Record (1 record)
 *
 * ODFI: Eaton Family Credit Union (Routing: 241075470)
 * Originator: DEANDREA LAVAR BARKLEY TRUST
 * Company ID: Trust EIN (set via config)
 */

'use strict';

// --- Constants ---------------------------------------------------------------

const ODFI_ROUTING   = '241075470';
const ODFI_NAME      = 'EATON FAMILY CU';
const COMPANY_NAME   = 'DLB TRUST';
const COMPANY_ID     = '1000000000'; // EIN/Tax ID — update via config
const ORIGIN_ID      = '1241075470'; // 1 + ODFI routing (standard)
const DESTINATION_ID = ' 241075470'; // space + ODFI routing

// Standard Entry Class Codes
const SEC_CODES = {
  PPD: 'PPD', // Prearranged Payment/Deposit (beneficiary distributions)
  CCD: 'CCD', // Corporate Credit/Debit (vendor payments)
  WEB: 'WEB', // Internet-initiated entry
  TEL: 'TEL', // Telephone-initiated entry
};

// Transaction codes
const TX_CODES = {
  CHECKING_CREDIT:  22,
  CHECKING_DEBIT:   27,
  SAVINGS_CREDIT:   32,
  SAVINGS_DEBIT:    37,
  CHECKING_PRENOTE: 23,
  SAVINGS_PRENOTE:  33,
};

// --- Utility Functions --------------------------------------------------------

function pad(str, len, fill = ' ', right = false) {
  const s = String(str || '').substring(0, len);
  return right ? s.padEnd(len, fill) : s.padStart(len, fill);
}

function rpad(str, len) { return pad(str, len, ' ', true); }
function lpad(str, len, fill = '0') { return pad(str, len, fill, false); }

function formatDate(date) {
  const d = date || new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = lpad(d.getMonth() + 1, 2);
  const dd = lpad(d.getDate(), 2);
  return `${yy}${mm}${dd}`;
}

function formatTime(date) {
  const d = date || new Date();
  return lpad(d.getHours(), 2) + lpad(d.getMinutes(), 2);
}

function nextBusinessDay(from) {
  const d = new Date(from || Date.now());
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function computeCheckDigit(routing8) {
  const digits = routing8.split('').map(Number);
  const weights = [3, 7, 1, 3, 7, 1, 3, 7];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += digits[i] * weights[i];
  return (10 - (sum % 10)) % 10;
}

function validateRoutingNumber(routing) {
  if (!/^\d{9}$/.test(routing)) return false;
  const check = computeCheckDigit(routing.slice(0, 8));
  return check === parseInt(routing[8]);
}

// --- Record Builders ---------------------------------------------------------

/**
 * File Header Record (Record Type 1)
 * Position 1-94
 */
function buildFileHeader(opts = {}) {
  const now = new Date();
  const fileDate = formatDate(now);
  const fileTime = formatTime(now);
  const fileIdModifier = opts.fileIdModifier || 'A';

  let record = '';
  record += '1';                              // 01 Record Type Code
  record += '01';                             // 02-03 Priority Code
  record += rpad(DESTINATION_ID, 10);         // 04-13 Immediate Destination
  record += rpad(ORIGIN_ID, 10);              // 14-23 Immediate Origin
  record += fileDate;                         // 24-29 File Creation Date
  record += fileTime;                         // 30-33 File Creation Time
  record += fileIdModifier;                   // 34 File ID Modifier
  record += '094';                            // 35-37 Record Size
  record += '10';                             // 38-39 Blocking Factor
  record += '1';                              // 40 Format Code
  record += rpad(opts.destinationName || ODFI_NAME, 23); // 41-63 Immediate Destination Name
  record += rpad(opts.originName || COMPANY_NAME, 23);    // 64-86 Immediate Origin Name
  record += rpad(opts.referenceCode || '', 8);           // 87-94 Reference Code

  return record;
}

/**
 * Batch Header Record (Record Type 5)
 */
function buildBatchHeader(batch, batchNumber) {
  const effectiveDate = formatDate(batch.effectiveDate || nextBusinessDay());
  const secCode = batch.secCode || SEC_CODES.PPD;

  let record = '';
  record += '5';                                              // 01 Record Type
  record += lpad(batch.serviceClass || '200', 3);            // 02-04 Service Class (200=mixed, 220=credit, 225=debit)
  record += rpad(batch.companyName || COMPANY_NAME, 16);     // 05-20 Company Name
  record += rpad(batch.companyDiscretionary || '', 20);      // 21-40 Company Discretionary Data
  record += rpad(batch.companyId || COMPANY_ID, 10);         // 41-50 Company Identification
  record += secCode;                                         // 51-53 Standard Entry Class Code
  record += rpad(batch.entryDescription || 'PAYMENT', 10);  // 54-63 Company Entry Description
  record += rpad(batch.companyDescDate || '', 6);            // 64-69 Company Descriptive Date
  record += effectiveDate;                                   // 70-75 Effective Entry Date
  record += '   ';                                           // 76-78 Settlement Date (blank)
  record += '1';                                             // 79 Originator Status Code
  record += rpad(ODFI_ROUTING.slice(0, 8), 8);              // 80-87 Originating DFI ID
  record += lpad(batchNumber, 7);                            // 88-94 Batch Number

  return record;
}

/**
 * Entry Detail Record (Record Type 6)
 */
function buildEntryDetail(entry, traceSeq) {
  const txCode = entry.transactionCode || TX_CODES.CHECKING_CREDIT;
  const routing = entry.routingNumber;
  const transitRouting = routing.slice(0, 8);
  const checkDigit = routing[8];

  let record = '';
  record += '6';                                              // 01 Record Type
  record += lpad(txCode, 2);                                 // 02-03 Transaction Code
  record += transitRouting;                                   // 04-11 Receiving DFI ID (Transit/Routing)
  record += checkDigit;                                      // 12 Check Digit
  record += rpad(entry.accountNumber, 17);                   // 13-29 DFI Account Number
  record += lpad(entry.amount, 10);                          // 30-39 Amount (in cents)
  record += rpad(entry.individualId || '', 15);              // 40-54 Individual ID Number
  record += rpad(entry.individualName, 22);                  // 55-76 Individual Name
  record += rpad(entry.discretionaryData || '', 2);          // 77-78 Discretionary Data
  record += '0';                                             // 79 Addenda Record Indicator
  record += ODFI_ROUTING.slice(0, 8);                        // 80-87 Trace Number (ODFI Routing)
  record += lpad(traceSeq, 7);                               // 88-94 Trace Number (Sequence)

  return record;
}

/**
 * Batch Control Record (Record Type 8)
 */
function buildBatchControl(batch, entries, batchNumber) {
  let totalDebit = 0;
  let totalCredit = 0;
  let entryHash = 0;

  for (const entry of entries) {
    const routing8 = parseInt(entry.routingNumber.slice(0, 8));
    entryHash += routing8;
    const code = entry.transactionCode || TX_CODES.CHECKING_CREDIT;
    if ([27, 37].includes(code)) {
      totalDebit += entry.amount;
    } else {
      totalCredit += entry.amount;
    }
  }

  // Hash is last 10 digits only
  const hashStr = lpad(String(entryHash).slice(-10), 10);

  let record = '';
  record += '8';                                          // 01 Record Type
  record += lpad(batch.serviceClass || '200', 3);        // 02-04 Service Class
  record += lpad(entries.length, 6);                     // 05-10 Entry/Addenda Count
  record += hashStr;                                     // 11-20 Entry Hash
  record += lpad(totalDebit, 12);                        // 21-32 Total Debit Entry $ Amount
  record += lpad(totalCredit, 12);                       // 33-44 Total Credit Entry $ Amount
  record += rpad(batch.companyId || COMPANY_ID, 10);     // 45-54 Company Identification
  record += rpad('', 19);                                // 55-73 Message Authentication Code (blank)
  record += rpad('', 6);                                 // 74-79 Reserved
  record += rpad(ODFI_ROUTING.slice(0, 8), 8);           // 80-87 Originating DFI ID
  record += lpad(batchNumber, 7);                        // 88-94 Batch Number

  return record;
}

/**
 * File Control Record (Record Type 9)
 */
function buildFileControl(batchCount, entryCount, entryHash, totalDebit, totalCredit) {
  const hashStr = lpad(String(entryHash).slice(-10), 10);
  const blockCount = Math.ceil((2 + batchCount * 2 + entryCount) / 10);

  let record = '';
  record += '9';                              // 01 Record Type
  record += lpad(batchCount, 6);             // 02-07 Batch Count
  record += lpad(blockCount, 6);             // 08-13 Block Count
  record += lpad(entryCount, 8);             // 14-21 Entry/Addenda Count
  record += hashStr;                         // 22-31 Entry Hash
  record += lpad(totalDebit, 12);            // 32-43 Total Debit Entry $ Amount
  record += lpad(totalCredit, 12);           // 44-55 Total Credit Entry $ Amount
  record += rpad('', 39);                    // 56-94 Reserved

  return record;
}

// --- Main File Generator -----------------------------------------------------

/**
 * Generate a complete NACHA ACH file from one or more batches
 *
 * @param {Object} opts
 * @param {Array} opts.batches - Array of batch objects
 *   Each batch: { secCode, entryDescription, effectiveDate, serviceClass, entries: [...] }
 *   Each entry: { routingNumber, accountNumber, amount (cents), transactionCode,
 *                 individualName, individualId }
 * @param {Object} opts.config - Optional overrides (companyName, companyId, etc.)
 * @returns {Object} { content: string, filename: string, metadata: {...} }
 */
function generateNACHAFile(opts) {
  const config = opts.config || {};
  const batches = opts.batches || [];
  const lines = [];

  // Validate
  if (!batches.length) throw new Error('At least one batch is required');
  for (const batch of batches) {
    if (!batch.entries || !batch.entries.length) {
      throw new Error('Each batch must have at least one entry');
    }
    for (const entry of batch.entries) {
      if (!entry.routingNumber || !validateRoutingNumber(entry.routingNumber)) {
        throw new Error(`Invalid routing number: ${entry.routingNumber}`);
      }
      if (!entry.accountNumber) throw new Error('Account number is required');
      if (!entry.amount || entry.amount <= 0) throw new Error('Amount must be positive');
      if (!entry.individualName) throw new Error('Individual/company name is required');
    }
  }

  // File Header
  lines.push(buildFileHeader(config));

  let totalEntries = 0;
  let totalHash = 0;
  let totalDebitAll = 0;
  let totalCreditAll = 0;
  let traceSeq = 0;

  // Batches
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchNum = b + 1;
    lines.push(buildBatchHeader(batch, batchNum));

    for (const entry of batch.entries) {
      traceSeq++;
      lines.push(buildEntryDetail(entry, traceSeq));

      const routing8 = parseInt(entry.routingNumber.slice(0, 8));
      totalHash += routing8;
      const code = entry.transactionCode || TX_CODES.CHECKING_CREDIT;
      if ([27, 37].includes(code)) {
        totalDebitAll += entry.amount;
      } else {
        totalCreditAll += entry.amount;
      }
    }
    totalEntries += batch.entries.length;

    lines.push(buildBatchControl(batch, batch.entries, batchNum));
  }

  // File Control
  lines.push(buildFileControl(batches.length, totalEntries, totalHash, totalDebitAll, totalCreditAll));

  // Pad to blocking factor of 10 with 9999... records
  const totalRecords = lines.length;
  const blockSize = Math.ceil(totalRecords / 10) * 10;
  while (lines.length < blockSize) {
    lines.push('9'.repeat(94));
  }

  // Build content
  const content = lines.join('\r\n') + '\r\n';

  // Generate filename: ACH_YYYYMMDD_HHMMSS.ach
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `ACH_${ts}.ach`;

  return {
    content,
    filename,
    metadata: {
      batchCount: batches.length,
      entryCount: totalEntries,
      totalDebitCents: totalDebitAll,
      totalCreditCents: totalCreditAll,
      effectiveDate: batches[0].effectiveDate || nextBusinessDay(),
      fileCreated: now.toISOString(),
      odfi: ODFI_ROUTING,
      originator: config.companyName || COMPANY_NAME,
    },
  };
}

/**
 * Generate a NACHA file for a single ACH payment (convenience wrapper)
 */
function generateSingleACH(payment) {
  const txCode = payment.accountType === 'savings'
    ? TX_CODES.SAVINGS_CREDIT
    : TX_CODES.CHECKING_CREDIT;

  const secCode = payment.paymentType === 'vendor_payment'
    ? SEC_CODES.CCD
    : SEC_CODES.PPD;

  return generateNACHAFile({
    batches: [{
      secCode,
      serviceClass: '220', // credits only
      entryDescription: payment.description || 'PAYMENT',
      effectiveDate: payment.effectiveDate || nextBusinessDay(),
      entries: [{
        routingNumber: payment.routingNumber,
        accountNumber: payment.accountNumber,
        amount: payment.amountCents,
        transactionCode: txCode,
        individualName: payment.recipientName,
        individualId: payment.referenceId || '',
      }],
    }],
    config: payment.config || {},
  });
}

/**
 * Generate a NACHA file for a batch of ACH payments
 */
function generateBatchACH(payments, opts = {}) {
  const entries = payments.map(p => ({
    routingNumber: p.routingNumber,
    accountNumber: p.accountNumber,
    amount: p.amountCents,
    transactionCode: p.accountType === 'savings'
      ? TX_CODES.SAVINGS_CREDIT
      : TX_CODES.CHECKING_CREDIT,
    individualName: p.recipientName,
    individualId: p.referenceId || '',
  }));

  return generateNACHAFile({
    batches: [{
      secCode: opts.secCode || SEC_CODES.PPD,
      serviceClass: '220',
      entryDescription: opts.entryDescription || 'TRUST DIST',
      effectiveDate: opts.effectiveDate || nextBusinessDay(),
      entries,
    }],
    config: opts.config || {},
  });
}

/**
 * Parse a NACHA file and return structured data (for verification/reconciliation)
 */
function parseNACHAFile(content) {
  const lines = content.split(/\r?\n/).filter(l => l.length >= 94);
  const result = { fileHeader: null, batches: [], fileControl: null };

  let currentBatch = null;

  for (const line of lines) {
    const type = line[0];

    if (type === '1') {
      result.fileHeader = {
        destination: line.slice(3, 13).trim(),
        origin: line.slice(13, 23).trim(),
        fileDate: line.slice(23, 29),
        fileTime: line.slice(29, 33),
        destinationName: line.slice(40, 63).trim(),
        originName: line.slice(63, 86).trim(),
      };
    } else if (type === '5') {
      currentBatch = {
        serviceClass: line.slice(1, 4),
        companyName: line.slice(4, 20).trim(),
        companyId: line.slice(40, 50).trim(),
        secCode: line.slice(50, 53),
        entryDescription: line.slice(53, 63).trim(),
        effectiveDate: line.slice(69, 75),
        entries: [],
      };
    } else if (type === '6' && currentBatch) {
      currentBatch.entries.push({
        transactionCode: parseInt(line.slice(1, 3)),
        routingNumber: line.slice(3, 12),
        accountNumber: line.slice(12, 29).trim(),
        amount: parseInt(line.slice(29, 39)),
        individualName: line.slice(54, 76).trim(),
        traceNumber: line.slice(79, 94),
      });
    } else if (type === '8') {
      if (currentBatch) {
        currentBatch.control = {
          entryCount: parseInt(line.slice(4, 10)),
          totalDebit: parseInt(line.slice(20, 32)),
          totalCredit: parseInt(line.slice(32, 44)),
        };
        result.batches.push(currentBatch);
        currentBatch = null;
      }
    } else if (type === '9' && line.slice(0, 2) !== '99') {
      result.fileControl = {
        batchCount: parseInt(line.slice(1, 7)),
        entryCount: parseInt(line.slice(13, 21)),
        totalDebit: parseInt(line.slice(31, 43)),
        totalCredit: parseInt(line.slice(43, 55)),
      };
      break;
    }
  }

  return result;
}

module.exports = {
  generateNACHAFile,
  generateSingleACH,
  generateBatchACH,
  parseNACHAFile,
  validateRoutingNumber,
  nextBusinessDay,
  SEC_CODES,
  TX_CODES,
  ODFI_ROUTING,
  COMPANY_NAME,
};

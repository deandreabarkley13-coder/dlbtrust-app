'use strict';

/**
 * NACHA File Generator
 *
 * Generates ACH files in standard NACHA format (fixed-width 94-char records).
 * Supports CCD (corporate) and PPD (personal) SEC codes.
 *
 * ODFI: Eaton Family Credit Union (routing: 241075470)
 * Originator: DEANDREA LAVAR BARKLEY TRUST
 */

const RECORD_LENGTH = 94;
const ODFI_ROUTING = '241075470';
const ODFI_ID = '24107547'; // first 8 digits
const ORIGINATOR_NAME = 'DLB TRUST';
const ORIGINATOR_ID = '1241075470'; // '1' + routing
const COMPANY_NAME = 'DLB TRUST';

function pad(str, len, fill = ' ', alignRight = false) {
  const s = String(str || '').substring(0, len);
  return alignRight ? s.padStart(len, fill) : s.padEnd(len, fill);
}

function numPad(n, len) {
  return String(Math.round(Number(n) || 0)).padStart(len, '0');
}

function formatDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const yy = String(dt.getFullYear()).slice(-2);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

function formatTime(d) {
  const dt = d instanceof Date ? d : new Date();
  return String(dt.getHours()).padStart(2, '0') + String(dt.getMinutes()).padStart(2, '0');
}

/**
 * Compute NACHA check digit for a 9-digit routing number.
 * Used to validate routing numbers.
 */
function routingCheckDigit(routing) {
  const d = String(routing).split('').map(Number);
  const sum = 3 * d[0] + 7 * d[1] + d[2] + 3 * d[3] + 7 * d[4] + d[5] + 3 * d[6] + 7 * d[7];
  return (10 - (sum % 10)) % 10;
}

function validateRouting(routing) {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split('').map(Number);
  const sum = 3 * d[0] + 7 * d[1] + d[2] + 3 * d[3] + 7 * d[4] + d[5] + 3 * d[6] + 7 * d[7] + d[8];
  return sum % 10 === 0;
}

/**
 * Record 1: File Header Record
 */
function fileHeaderRecord(opts = {}) {
  const now = new Date();
  let rec = '';
  rec += '1';                                    // pos 1: record type
  rec += '01';                                   // pos 2-3: priority code
  rec += ' ' + pad(opts.immediateDestination || ODFI_ROUTING, 9, ' ', true); // pos 4-13
  rec += pad(opts.immediateOrigin || ORIGINATOR_ID, 10);   // pos 14-23
  rec += formatDate(opts.fileCreationDate || now);          // pos 24-29
  rec += formatTime(opts.fileCreationDate || now);          // pos 30-33
  rec += pad(opts.fileIdModifier || 'A', 1);               // pos 34
  rec += '094';                                  // pos 35-37: record size
  rec += '10';                                   // pos 38-39: blocking factor
  rec += '1';                                    // pos 40: format code
  rec += pad(opts.immediateDestinationName || 'EATON FAMILY CU', 23); // pos 41-63
  rec += pad(opts.immediateOriginName || ORIGINATOR_NAME, 23);        // pos 64-86
  rec += pad(opts.referenceCode || '', 8);       // pos 87-94
  return rec.padEnd(RECORD_LENGTH);
}

/**
 * Record 5: Batch Header Record
 */
function batchHeaderRecord(batchNumber, opts = {}) {
  const serviceClass = opts.serviceClassCode || '200'; // 200=mixed, 220=credits, 225=debits
  let rec = '';
  rec += '5';                                    // pos 1: record type
  rec += serviceClass;                           // pos 2-4
  rec += pad(opts.companyName || COMPANY_NAME, 16);         // pos 5-20
  rec += pad(opts.companyDiscretionaryData || '', 20);      // pos 21-40
  rec += pad(opts.companyId || ORIGINATOR_ID, 10);          // pos 41-50
  rec += pad(opts.secCode || 'CCD', 3);          // pos 51-53: CCD or PPD
  rec += pad(opts.companyEntryDescription || 'PAYMENT', 10); // pos 54-63
  rec += pad(opts.companyDescriptiveDate || '', 6);          // pos 64-69
  rec += formatDate(opts.effectiveEntryDate || new Date());   // pos 70-75
  rec += pad('', 3);                             // pos 76-78: settlement date (ACH operator)
  rec += '1';                                    // pos 79: originator status (ODFI)
  rec += pad(ODFI_ID, 8);                        // pos 80-87
  rec += numPad(batchNumber, 7);                 // pos 88-94
  return rec.padEnd(RECORD_LENGTH);
}

/**
 * Record 6: Entry Detail Record (CCD/PPD)
 */
function entryDetailRecord(entry, traceSeq) {
  const txCode = entry.transactionCode || '22'; // 22=credit checking, 27=debit checking, 32=credit savings, 37=debit savings
  let rec = '';
  rec += '6';                                    // pos 1: record type
  rec += pad(txCode, 2);                         // pos 2-3: transaction code
  rec += pad(entry.receivingDFI || '', 8);       // pos 4-11: first 8 of routing
  rec += pad(entry.checkDigit || '', 1);         // pos 12: check digit (9th digit of routing)
  rec += pad(entry.accountNumber || '', 17);     // pos 13-29
  rec += numPad(entry.amountCents || 0, 10);     // pos 30-39: amount in cents
  rec += pad(entry.individualId || '', 15);      // pos 40-54: individual ID
  rec += pad(entry.individualName || '', 22);    // pos 55-76: individual name
  rec += pad(entry.discretionaryData || '', 2);  // pos 77-78
  rec += '0';                                    // pos 79: addenda indicator
  rec += pad(ODFI_ID, 8);                        // pos 80-87: trace routing
  rec += numPad(traceSeq, 7);                    // pos 88-94: trace sequence
  return rec.padEnd(RECORD_LENGTH);
}

/**
 * Record 8: Batch Control Record
 */
function batchControlRecord(batchNumber, entries, opts = {}) {
  const serviceClass = opts.serviceClassCode || '200';
  let totalDebit = 0;
  let totalCredit = 0;
  let entryHash = 0;

  for (const e of entries) {
    const amt = Number(e.amountCents || 0);
    const code = String(e.transactionCode || '22');
    if (code === '27' || code === '37') {
      totalDebit += amt;
    } else {
      totalCredit += amt;
    }
    entryHash += Number(e.receivingDFI || 0);
  }
  entryHash = entryHash % 10000000000; // mod 10^10

  let rec = '';
  rec += '8';                                    // pos 1: record type
  rec += serviceClass;                           // pos 2-4
  rec += numPad(entries.length, 6);              // pos 5-10: entry/addenda count
  rec += numPad(entryHash, 10);                  // pos 11-20: entry hash
  rec += numPad(totalDebit, 12);                 // pos 21-32: total debit
  rec += numPad(totalCredit, 12);                // pos 33-44: total credit
  rec += pad(opts.companyId || ORIGINATOR_ID, 10); // pos 45-54
  rec += pad('', 19);                            // pos 55-73: message auth code (blank)
  rec += pad('', 6);                             // pos 74-79: reserved
  rec += pad(ODFI_ID, 8);                        // pos 80-87
  rec += numPad(batchNumber, 7);                 // pos 88-94
  return rec.padEnd(RECORD_LENGTH);
}

/**
 * Record 9: File Control Record
 */
function fileControlRecord(batchCount, blockCount, entryCount, entryHash, totalDebit, totalCredit) {
  let rec = '';
  rec += '9';                                    // pos 1: record type
  rec += numPad(batchCount, 6);                  // pos 2-7: batch count
  rec += numPad(blockCount, 6);                  // pos 8-13: block count
  rec += numPad(entryCount, 8);                  // pos 14-21: entry/addenda count
  rec += numPad(entryHash % 10000000000, 10);    // pos 22-31: entry hash
  rec += numPad(totalDebit, 12);                 // pos 32-43: total debit
  rec += numPad(totalCredit, 12);                // pos 44-55: total credit
  rec += pad('', 39);                            // pos 56-94: reserved
  return rec.padEnd(RECORD_LENGTH);
}

/**
 * Generate a complete NACHA file from batches of entries.
 *
 * @param {Object} opts - file-level options
 * @param {Array<Object>} batches - array of { entries: [...], secCode, companyEntryDescription, serviceClassCode, effectiveEntryDate }
 *   Each entry: { receivingRouting, accountNumber, amountCents, transactionCode, individualId, individualName }
 * @returns {string} NACHA file content
 */
function generateNACHAFile(opts = {}, batches = []) {
  const lines = [];
  let totalEntryCount = 0;
  let totalEntryHash = 0;
  let totalDebit = 0;
  let totalCredit = 0;

  // File Header
  lines.push(fileHeaderRecord(opts));

  // Process each batch
  batches.forEach((batch, idx) => {
    const batchNum = idx + 1;
    const processedEntries = [];

    // Batch Header
    lines.push(batchHeaderRecord(batchNum, {
      secCode: batch.secCode || 'CCD',
      companyEntryDescription: batch.companyEntryDescription || 'PAYMENT',
      serviceClassCode: batch.serviceClassCode || '200',
      effectiveEntryDate: batch.effectiveEntryDate,
      companyName: batch.companyName,
      companyId: batch.companyId,
    }));

    // Entry Detail records
    (batch.entries || []).forEach((entry, entryIdx) => {
      const routing = String(entry.receivingRouting || '');
      const receivingDFI = routing.substring(0, 8);
      const checkDig = routing.length >= 9 ? routing[8] : String(routingCheckDigit(routing));

      const processed = {
        transactionCode: entry.transactionCode || '22',
        receivingDFI,
        checkDigit: checkDig,
        accountNumber: entry.accountNumber,
        amountCents: entry.amountCents,
        individualId: entry.individualId,
        individualName: entry.individualName,
        discretionaryData: entry.discretionaryData,
      };
      processedEntries.push(processed);
      lines.push(entryDetailRecord(processed, entryIdx + 1));
    });

    // Batch Control
    lines.push(batchControlRecord(batchNum, processedEntries, {
      serviceClassCode: batch.serviceClassCode || '200',
      companyId: batch.companyId,
    }));

    // Accumulate file-level totals
    for (const e of processedEntries) {
      const amt = Number(e.amountCents || 0);
      const code = String(e.transactionCode);
      if (code === '27' || code === '37') {
        totalDebit += amt;
      } else {
        totalCredit += amt;
      }
      totalEntryHash += Number(e.receivingDFI || 0);
    }
    totalEntryCount += processedEntries.length;
  });

  // File Control
  const totalLines = lines.length + 1; // +1 for file control itself
  const blockCount = Math.ceil(totalLines / 10);
  lines.push(fileControlRecord(batches.length, blockCount, totalEntryCount, totalEntryHash, totalDebit, totalCredit));

  // Pad to block boundary (blocks of 10 records)
  while (lines.length % 10 !== 0) {
    lines.push('9'.repeat(RECORD_LENGTH));
  }

  return lines.join('\r\n') + '\r\n';
}

/**
 * Parse a NACHA file string back into structured data (for validation/display).
 */
function parseNACHAFile(content) {
  const lines = content.split(/\r?\n/).filter(l => l.length >= RECORD_LENGTH);
  const result = { fileHeader: null, batches: [], fileControl: null };
  let currentBatch = null;

  for (const line of lines) {
    const recType = line[0];
    switch (recType) {
      case '1':
        result.fileHeader = {
          immediateDestination: line.substring(3, 13).trim(),
          immediateOrigin: line.substring(13, 23).trim(),
          fileCreationDate: line.substring(23, 29),
          destinationName: line.substring(40, 63).trim(),
          originName: line.substring(63, 86).trim(),
        };
        break;
      case '5':
        currentBatch = {
          serviceClassCode: line.substring(1, 4),
          companyName: line.substring(4, 20).trim(),
          companyId: line.substring(40, 50).trim(),
          secCode: line.substring(50, 53),
          description: line.substring(53, 63).trim(),
          effectiveDate: line.substring(69, 75),
          entries: [],
        };
        break;
      case '6':
        if (currentBatch) {
          currentBatch.entries.push({
            transactionCode: line.substring(1, 3),
            receivingDFI: line.substring(3, 11),
            checkDigit: line[11],
            accountNumber: line.substring(12, 29).trim(),
            amountCents: parseInt(line.substring(29, 39), 10),
            individualId: line.substring(39, 54).trim(),
            individualName: line.substring(54, 76).trim(),
            traceNumber: line.substring(79, 94),
          });
        }
        break;
      case '8':
        if (currentBatch) {
          currentBatch.control = {
            entryCount: parseInt(line.substring(4, 10), 10),
            entryHash: parseInt(line.substring(10, 20), 10),
            totalDebit: parseInt(line.substring(20, 32), 10),
            totalCredit: parseInt(line.substring(32, 44), 10),
          };
          result.batches.push(currentBatch);
          currentBatch = null;
        }
        break;
      case '9':
        if (line !== '9'.repeat(RECORD_LENGTH)) {
          result.fileControl = {
            batchCount: parseInt(line.substring(1, 7), 10),
            blockCount: parseInt(line.substring(7, 13), 10),
            entryCount: parseInt(line.substring(13, 21), 10),
            entryHash: parseInt(line.substring(21, 31), 10),
            totalDebit: parseInt(line.substring(31, 43), 10),
            totalCredit: parseInt(line.substring(43, 55), 10),
          };
        }
        break;
    }
  }
  return result;
}

module.exports = {
  generateNACHAFile,
  parseNACHAFile,
  validateRouting,
  ODFI_ROUTING,
  ORIGINATOR_NAME,
  ORIGINATOR_ID,
};

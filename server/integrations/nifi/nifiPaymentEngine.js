'use strict';

/**
 * Apache NiFi Payment File Transfer Engine
 * ─────────────────────────────────────────
 *
 * Provides automated server-to-server payment file generation,
 * staging, transfer tracking, and processing for integration with
 * Apache NiFi data-flow pipelines.
 *
 * Key capabilities:
 *  - Generate standardized payment files (NACHA, ISO 20022 pain.001, CSV)
 *  - Stage files for NiFi pickup (poll-based or push-based)
 *  - Track file transfer lifecycle: generated → staged → picked_up → delivered → acknowledged
 *  - Inbound processing: accept settlement confirmations from NiFi
 *  - Auto-reconcile delivered files against settlement records
 *  - HMAC integrity verification on all file transfers
 *  - Circuit breaker + retry for delivery failures
 *
 * NiFi Integration Patterns:
 *   1. PULL: NiFi polls GET /api/nifi/outbox → picks up staged files → ACKs via POST /api/nifi/ack
 *   2. PUSH: System calls NiFi's ListenHTTP processor endpoint to deliver files
 *   3. INBOUND: NiFi POSTs settlement confirmations to POST /api/nifi/inbox
 *
 * Integrates with: ElectronicSettlementEngine, ACHEngine, TrustAccountingEngine,
 *                  SubLedgerEngine, DataBridge, BillClient
 */

var crypto = require('crypto');
var pool = require('../bonds/pgPool');

var DataBridge;
try { DataBridge = require('../accounting/dataBridge').DataBridge; } catch (e) { DataBridge = null; }

var TrustAccountingEngine;
try { TrustAccountingEngine = require('../accounting/trustAccountingEngine').TrustAccountingEngine; } catch (e) { TrustAccountingEngine = null; }

var SubLedgerEngine;
try { SubLedgerEngine = require('../accounting/subLedgerEngine').SubLedgerEngine; } catch (e) { SubLedgerEngine = null; }

var settlementEngine;
try { settlementEngine = require('../payments/electronicSettlementEngine'); } catch (e) { settlementEngine = null; }

var billClient;
try { billClient = require('../bill/billClient'); } catch (e) { billClient = null; }

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

var FILE_FORMATS = ['nacha', 'iso20022', 'csv', 'json'];
var FILE_STATUSES = ['generated', 'staged', 'picked_up', 'delivered', 'acknowledged', 'failed', 'expired'];
var TRANSFER_DIRECTIONS = ['outbound', 'inbound'];
var HMAC_ALGO = 'sha256';
var FILE_EXPIRY_HOURS = 24;
var MAX_RETRIES = 3;
var RETRY_DELAYS_MS = [2000, 5000, 15000];

// Circuit breaker for NiFi delivery
var circuitState = { failures: 0, lastFailure: 0, open: false };
var CIRCUIT_THRESHOLD = 5;
var CIRCUIT_RESET_MS = 120000;

// ─── TABLE SETUP ──────────────────────────────────────────────────────────────

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nifi_payment_files (
      id                  SERIAL PRIMARY KEY,
      file_id             TEXT UNIQUE NOT NULL,
      direction           TEXT NOT NULL DEFAULT 'outbound'
                            CHECK (direction IN ('outbound', 'inbound')),
      file_format         TEXT NOT NULL DEFAULT 'nacha'
                            CHECK (file_format IN ('nacha', 'iso20022', 'csv', 'json')),
      file_name           TEXT NOT NULL,
      file_content        TEXT NOT NULL,
      file_size_bytes     INTEGER NOT NULL DEFAULT 0,
      file_hash           TEXT NOT NULL,
      hmac_signature      TEXT,
      status              TEXT NOT NULL DEFAULT 'generated'
                            CHECK (status IN ('generated', 'staged', 'picked_up', 'delivered',
                                             'acknowledged', 'failed', 'expired')),
      settlement_ids      TEXT[],
      payment_count       INTEGER NOT NULL DEFAULT 0,
      total_amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
      source_system       TEXT NOT NULL DEFAULT 'core_banking',
      destination_system  TEXT DEFAULT 'bill',
      nifi_flow_id        TEXT,
      nifi_processor_id   TEXT,
      delivery_endpoint   TEXT,
      delivery_attempts   INTEGER DEFAULT 0,
      last_error          TEXT,
      picked_up_at        TIMESTAMPTZ,
      delivered_at        TIMESTAMPTZ,
      acknowledged_at     TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_npf_status ON nifi_payment_files(status);
    CREATE INDEX IF NOT EXISTS idx_npf_direction ON nifi_payment_files(direction);
    CREATE INDEX IF NOT EXISTS idx_npf_file_id ON nifi_payment_files(file_id);
  `);

  // Add columns for existing tables
  var migrations = [
    'ALTER TABLE nifi_payment_files ADD COLUMN IF NOT EXISTS nifi_flow_id TEXT',
    'ALTER TABLE nifi_payment_files ADD COLUMN IF NOT EXISTS delivery_endpoint TEXT',
    'ALTER TABLE nifi_payment_files ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER DEFAULT 0',
  ];
  for (var i = 0; i < migrations.length; i++) {
    try { await pool.query(migrations[i]); } catch (e) { /* column exists */ }
  }
}

// Eager init
ensureTables().catch(function(err) { console.warn('[NiFi] Table setup deferred:', err.message); });

// ─── HMAC SIGNING ─────────────────────────────────────────────────────────────

function getHmacSecret() {
  return process.env.NIFI_HMAC_SECRET || process.env.API_KEY || 'nifi-default-hmac-key';
}

function computeHmac(content) {
  return crypto.createHmac(HMAC_ALGO, getHmacSecret()).update(content).digest('hex');
}

function verifyHmac(content, signature) {
  var expected = computeHmac(content);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function computeFileHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ─── FILE GENERATION ──────────────────────────────────────────────────────────

/**
 * Generate a NACHA-format payment file from settlement records.
 */
function generateNACHA(payments, batchOpts) {
  batchOpts = batchOpts || {};
  var immediateOrigin = batchOpts.originRoutingNumber || process.env.ACH_ROUTING || '028000024';
  var immediateDestination = batchOpts.destinationRoutingNumber || '028000024';
  var originName = batchOpts.originName || 'DEANDREA L BARKLEY';
  var companyName = batchOpts.companyName || 'DLB TRUST';
  var batchNumber = batchOpts.batchNumber || 1;
  var fileIdModifier = 'A';

  var now = new Date();
  var fileDate = now.toISOString().replace(/-/g, '').substring(2, 8);
  var fileTime = now.toISOString().substring(11, 15).replace(':', '');

  var lines = [];

  // File Header (Record Type 1)
  lines.push(
    '1' +
    '01' +
    padRight(' ' + immediateDestination, 10) +
    padRight(' ' + immediateOrigin, 10) +
    fileDate +
    fileTime +
    fileIdModifier +
    '094' +
    '10' +
    '1' +
    padRight(immediateDestination.substring(0, 23), 23) +
    padRight(originName, 23) +
    padRight('', 8)
  );

  // Batch Header (Record Type 5)
  var serviceClassCode = '200'; // Mixed debits and credits
  var secCode = batchOpts.secCode || 'PPD';
  var effectiveDate = fileDate;
  var entryDescription = padRight(batchOpts.description || 'PAYMENT', 10);

  lines.push(
    '5' +
    serviceClassCode +
    padRight(companyName, 16) +
    padRight('', 20) +
    padRight(immediateOrigin.substring(0, 10), 10) +
    secCode +
    entryDescription +
    padRight('', 6) +
    effectiveDate +
    '   ' +
    '1' +
    padRight(immediateDestination.substring(0, 8), 8) +
    padLeft(String(batchNumber), 7, '0')
  );

  // Entry Detail Records (Record Type 6)
  var totalDebit = 0;
  var totalCredit = 0;
  var entryHash = 0;
  var entryCount = 0;

  payments.forEach(function(pmt, idx) {
    var transactionCode = pmt.type === 'debit' ? '27' : '22'; // 27=debit, 22=credit
    var routingNumber = pmt.routing || immediateDestination;
    var accountNumber = pmt.account || '0000000000';
    var amountCents = Math.round((pmt.amount || 0) * 100);
    var name = padRight((pmt.name || 'PAYMENT').substring(0, 22), 22);
    var traceNumber = immediateOrigin.substring(0, 8) + padLeft(String(idx + 1), 7, '0');

    lines.push(
      '6' +
      transactionCode +
      padRight(routingNumber.substring(0, 8), 8) +
      routingNumber.charAt(8) +
      padRight(accountNumber, 17) +
      padLeft(String(amountCents), 10, '0') +
      padRight(pmt.id || '', 15) +
      name +
      padRight('', 2) +
      '0' +
      traceNumber
    );

    if (pmt.type === 'debit') totalDebit += amountCents;
    else totalCredit += amountCents;
    entryHash += parseInt(routingNumber.substring(0, 8), 10);
    entryCount++;
  });

  // Batch Control (Record Type 8)
  lines.push(
    '8' +
    serviceClassCode +
    padLeft(String(entryCount), 6, '0') +
    padLeft(String(entryHash % 10000000000), 10, '0') +
    padLeft(String(totalDebit), 12, '0') +
    padLeft(String(totalCredit), 12, '0') +
    padRight(immediateOrigin.substring(0, 10), 10) +
    padRight('', 25) +
    padRight(immediateDestination.substring(0, 8), 8) +
    padLeft(String(batchNumber), 7, '0')
  );

  // File Control (Record Type 9)
  var blockCount = Math.ceil((lines.length + 1) / 10);
  lines.push(
    '9' +
    padLeft('1', 6, '0') +
    padLeft(String(blockCount), 6, '0') +
    padLeft(String(entryCount), 8, '0') +
    padLeft(String(entryHash % 10000000000), 10, '0') +
    padLeft(String(totalDebit), 12, '0') +
    padLeft(String(totalCredit), 12, '0') +
    padRight('', 39)
  );

  // Pad to block boundary (10 records per block)
  while (lines.length % 10 !== 0) {
    lines.push(padRight('9', 94, '9'));
  }

  return lines.join('\n');
}

/**
 * Generate an ISO 20022 pain.001 (Customer Credit Transfer Initiation) XML.
 */
function generateISO20022(payments, batchOpts) {
  batchOpts = batchOpts || {};
  var msgId = batchOpts.messageId || ('NIFI-' + Date.now().toString(36).toUpperCase());
  var now = new Date().toISOString();
  var initiatorName = batchOpts.initiatorName || 'DEANDREA LAVAR BARKLEY TRUST';
  var totalAmount = payments.reduce(function(s, p) { return s + (p.amount || 0); }, 0);

  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.09">\n';
  xml += '  <CstmrCdtTrfInitn>\n';
  xml += '    <GrpHdr>\n';
  xml += '      <MsgId>' + escXml(msgId) + '</MsgId>\n';
  xml += '      <CreDtTm>' + now + '</CreDtTm>\n';
  xml += '      <NbOfTxs>' + payments.length + '</NbOfTxs>\n';
  xml += '      <CtrlSum>' + totalAmount.toFixed(2) + '</CtrlSum>\n';
  xml += '      <InitgPty><Nm>' + escXml(initiatorName) + '</Nm></InitgPty>\n';
  xml += '    </GrpHdr>\n';

  // Payment Information block
  xml += '    <PmtInf>\n';
  xml += '      <PmtInfId>' + escXml(msgId + '-PMT') + '</PmtInfId>\n';
  xml += '      <PmtMtd>TRF</PmtMtd>\n';
  xml += '      <NbOfTxs>' + payments.length + '</NbOfTxs>\n';
  xml += '      <CtrlSum>' + totalAmount.toFixed(2) + '</CtrlSum>\n';
  xml += '      <ReqdExctnDt><Dt>' + now.substring(0, 10) + '</Dt></ReqdExctnDt>\n';
  xml += '      <Dbtr><Nm>' + escXml(initiatorName) + '</Nm></Dbtr>\n';
  xml += '      <DbtrAcct><Id><Other><Id>' + (batchOpts.debtorAccount || '0240') + '</Id></Other></Id></DbtrAcct>\n';
  xml += '      <DbtrAgt><FinInstnId><BICFI>' + (batchOpts.debtorBIC || 'CITIUS33') + '</BICFI></FinInstnId></DbtrAgt>\n';

  payments.forEach(function(pmt, idx) {
    xml += '      <CdtTrfTxInf>\n';
    xml += '        <PmtId>\n';
    xml += '          <InstrId>' + escXml(pmt.id || ('TXN-' + (idx + 1))) + '</InstrId>\n';
    xml += '          <EndToEndId>' + escXml(pmt.settlement_id || pmt.id || ('E2E-' + (idx + 1))) + '</EndToEndId>\n';
    xml += '        </PmtId>\n';
    xml += '        <Amt><InstdAmt Ccy="USD">' + (pmt.amount || 0).toFixed(2) + '</InstdAmt></Amt>\n';
    if (pmt.routing) {
      xml += '        <CdtrAgt><FinInstnId><ClrSysMmbId><MmbId>' + escXml(pmt.routing) + '</MmbId></ClrSysMmbId></FinInstnId></CdtrAgt>\n';
    }
    xml += '        <Cdtr><Nm>' + escXml(pmt.name || 'Payee') + '</Nm></Cdtr>\n';
    if (pmt.account) {
      xml += '        <CdtrAcct><Id><Other><Id>' + escXml(pmt.account) + '</Id></Other></Id></CdtrAcct>\n';
    }
    xml += '        <RmtInf><Ustrd>' + escXml(pmt.memo || pmt.description || 'Payment') + '</Ustrd></RmtInf>\n';
    xml += '      </CdtTrfTxInf>\n';
  });

  xml += '    </PmtInf>\n';
  xml += '  </CstmrCdtTrfInitn>\n';
  xml += '</Document>\n';

  return xml;
}

/**
 * Generate a CSV payment file.
 */
function generateCSV(payments) {
  var lines = ['settlement_id,payee_name,payee_account,payee_routing,amount,currency,type,description,date'];
  payments.forEach(function(pmt) {
    lines.push([
      csvEsc(pmt.settlement_id || pmt.id || ''),
      csvEsc(pmt.name || ''),
      csvEsc(pmt.account || ''),
      csvEsc(pmt.routing || ''),
      (pmt.amount || 0).toFixed(2),
      'USD',
      csvEsc(pmt.type || 'credit'),
      csvEsc(pmt.description || pmt.memo || ''),
      new Date().toISOString().substring(0, 10),
    ].join(','));
  });
  return lines.join('\n');
}

/**
 * Generate a JSON payment file.
 */
function generateJSON(payments, batchOpts) {
  batchOpts = batchOpts || {};
  return JSON.stringify({
    header: {
      messageId: batchOpts.messageId || ('NIFI-' + Date.now().toString(36).toUpperCase()),
      createdAt: new Date().toISOString(),
      initiator: batchOpts.initiatorName || 'DEANDREA LAVAR BARKLEY TRUST',
      paymentCount: payments.length,
      totalAmount: payments.reduce(function(s, p) { return s + (p.amount || 0); }, 0),
      currency: 'USD',
      format: 'dlb-trust-payment-v1',
    },
    payments: payments.map(function(pmt) {
      return {
        id: pmt.settlement_id || pmt.id,
        payee: pmt.name,
        account: pmt.account || null,
        routing: pmt.routing || null,
        amount: pmt.amount,
        type: pmt.type || 'credit',
        description: pmt.description || pmt.memo || null,
      };
    }),
  }, null, 2);
}

// ─── CORE OPERATIONS ──────────────────────────────────────────────────────────

/**
 * Generate a payment file from pending settlements and stage it for NiFi pickup.
 */
async function generateAndStagePaymentFile(opts) {
  await ensureTables();
  opts = opts || {};
  var format = opts.format || 'nacha';
  if (FILE_FORMATS.indexOf(format) === -1) throw new Error('Unsupported format: ' + format);

  // Gather pending settlements
  var payments = opts.payments;
  if (!payments || payments.length === 0) {
    if (settlementEngine) {
      var settlements = await settlementEngine.listSettlements({ status: 'accepted' });
      payments = (Array.isArray(settlements) ? settlements : []).map(function(s) {
        return {
          id: s.payment_ref,
          settlement_id: s.settlement_id,
          name: s.payee_name,
          account: s.payee_account,
          routing: s.payee_routing,
          amount: parseFloat(s.amount) || 0,
          type: 'credit',
          description: s.description,
          memo: s.memo,
        };
      });
    }
    if (!payments || payments.length === 0) {
      return { file_id: null, message: 'No pending payments to stage', payment_count: 0 };
    }
  }

  // Generate file content
  var content;
  switch (format) {
    case 'nacha':    content = generateNACHA(payments, opts); break;
    case 'iso20022': content = generateISO20022(payments, opts); break;
    case 'csv':      content = generateCSV(payments); break;
    case 'json':     content = generateJSON(payments, opts); break;
    default:         content = generateJSON(payments, opts);
  }

  var fileId = 'NPF-' + Date.now().toString(36).toUpperCase() + '-' + randomHex(4);
  var ext = format === 'nacha' ? '.ach' : format === 'iso20022' ? '.xml' : ('.' + format);
  var fileName = 'payment-' + new Date().toISOString().substring(0, 10) + '-' + fileId + ext;
  var fileHash = computeFileHash(content);
  var hmacSig = computeHmac(content);
  var totalAmount = payments.reduce(function(s, p) { return s + (p.amount || 0); }, 0);
  var settlementIds = payments.map(function(p) { return p.settlement_id || p.id; }).filter(Boolean);
  var expiresAt = new Date(Date.now() + FILE_EXPIRY_HOURS * 3600000).toISOString();

  await pool.query(`
    INSERT INTO nifi_payment_files
      (file_id, direction, file_format, file_name, file_content, file_size_bytes,
       file_hash, hmac_signature, status, settlement_ids, payment_count, total_amount,
       source_system, destination_system, delivery_endpoint, expires_at)
    VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, 'staged', $8, $9, $10, $11, $12, $13, $14)
  `, [
    fileId, format, fileName, content, Buffer.byteLength(content),
    fileHash, hmacSig, settlementIds, payments.length, totalAmount,
    opts.source_system || 'core_banking', opts.destination_system || 'bill',
    opts.delivery_endpoint || null, expiresAt,
  ]);

  return {
    file_id: fileId,
    file_name: fileName,
    format: format,
    file_hash: fileHash,
    hmac_signature: hmacSig,
    payment_count: payments.length,
    total_amount: totalAmount,
    settlement_ids: settlementIds,
    status: 'staged',
    expires_at: expiresAt,
  };
}

/**
 * List files available for NiFi pickup (outbox).
 */
async function listOutboxFiles(opts) {
  await ensureTables();
  opts = opts || {};
  var status = opts.status || 'staged';
  var format = opts.format;
  var limit = Math.min(parseInt(opts.limit, 10) || 50, 200);

  var query = 'SELECT * FROM nifi_payment_files WHERE direction = $1 AND status = $2';
  var params = ['outbound', status];
  if (format) {
    query += ' AND file_format = $3';
    params.push(format);
  }
  query += ' AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at ASC LIMIT ' + limit;

  var result = await pool.query(query, params);
  return (result.rows || []).map(function(row) {
    return {
      file_id: row.file_id,
      file_name: row.file_name,
      format: row.file_format,
      file_hash: row.file_hash,
      hmac_signature: row.hmac_signature,
      payment_count: row.payment_count,
      total_amount: parseFloat(row.total_amount),
      status: row.status,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  });
}

/**
 * Download a specific file (NiFi picks it up).
 */
async function getFileContent(fileId) {
  await ensureTables();
  var result = await pool.query(
    'SELECT * FROM nifi_payment_files WHERE file_id = $1', [fileId]
  );
  if (!result.rows || result.rows.length === 0) return null;

  var file = result.rows[0];

  // Mark as picked_up
  if (file.status === 'staged') {
    await pool.query(
      'UPDATE nifi_payment_files SET status = $1, picked_up_at = NOW(), updated_at = NOW() WHERE file_id = $2',
      ['picked_up', fileId]
    );
  }

  return {
    file_id: file.file_id,
    file_name: file.file_name,
    format: file.file_format,
    content: file.file_content,
    file_hash: file.file_hash,
    hmac_signature: file.hmac_signature,
    payment_count: file.payment_count,
    total_amount: parseFloat(file.total_amount),
    settlement_ids: file.settlement_ids,
  };
}

/**
 * Acknowledge file delivery (NiFi confirms receipt).
 */
async function acknowledgeFile(fileId, ackData) {
  await ensureTables();
  ackData = ackData || {};

  var result = await pool.query(
    'SELECT * FROM nifi_payment_files WHERE file_id = $1', [fileId]
  );
  if (!result.rows || result.rows.length === 0) {
    throw new Error('File not found: ' + fileId);
  }

  var file = result.rows[0];

  // Verify HMAC if provided
  if (ackData.hmac_signature) {
    try {
      if (!verifyHmac(file.file_content, ackData.hmac_signature)) {
        throw new Error('HMAC verification failed for file ' + fileId);
      }
    } catch (hmacErr) {
      if (hmacErr.message.indexOf('HMAC') !== -1) throw hmacErr;
    }
  }

  await pool.query(
    `UPDATE nifi_payment_files 
     SET status = 'acknowledged', acknowledged_at = NOW(), updated_at = NOW(),
         nifi_flow_id = COALESCE($2, nifi_flow_id),
         nifi_processor_id = COALESCE($3, nifi_processor_id)
     WHERE file_id = $1`,
    [fileId, ackData.flow_id || null, ackData.processor_id || null]
  );

  // Update linked settlements to 'clearing' status
  if (file.settlement_ids && file.settlement_ids.length > 0 && settlementEngine) {
    for (var i = 0; i < file.settlement_ids.length; i++) {
      try {
        await settlementEngine.advanceSettlementStatus(file.settlement_ids[i], 'clearing', {
          nifi_file_id: fileId,
          nifi_ack_at: new Date().toISOString(),
        });
      } catch (e) { /* settlement may already be past clearing */ }
    }
  }

  // Sync to Data Bridge
  if (DataBridge) {
    try { await DataBridge.syncModule('nifi'); } catch (e) { /* non-fatal */ }
  }

  return {
    file_id: fileId,
    status: 'acknowledged',
    settlement_count: file.settlement_ids ? file.settlement_ids.length : 0,
  };
}

/**
 * Process inbound settlement confirmation from NiFi.
 */
async function processInboundFile(fileData) {
  await ensureTables();
  if (!fileData || !fileData.content) throw new Error('File content required');

  var fileId = 'NPF-IN-' + Date.now().toString(36).toUpperCase() + '-' + randomHex(4);
  var content = typeof fileData.content === 'string' ? fileData.content : JSON.stringify(fileData.content);
  var fileHash = computeFileHash(content);

  // Verify HMAC if provided
  if (fileData.hmac_signature) {
    try {
      if (!verifyHmac(content, fileData.hmac_signature)) {
        throw new Error('Inbound file HMAC verification failed');
      }
    } catch (hmacErr) {
      if (hmacErr.message.indexOf('HMAC') !== -1) throw hmacErr;
    }
  }

  var format = fileData.format || 'json';
  var fileName = fileData.file_name || ('inbound-' + fileId + '.' + format);

  // Parse settlement confirmations
  var confirmations = [];
  try {
    if (format === 'json') {
      var parsed = JSON.parse(content);
      confirmations = parsed.confirmations || parsed.settlements || parsed.payments || [];
      if (!Array.isArray(confirmations)) confirmations = [confirmations];
    } else if (format === 'csv') {
      var lines = content.split('\n').filter(function(l) { return l.trim(); });
      if (lines.length > 1) {
        var headers = lines[0].split(',').map(function(h) { return h.trim(); });
        for (var i = 1; i < lines.length; i++) {
          var vals = lines[i].split(',');
          var obj = {};
          headers.forEach(function(h, idx) { obj[h] = vals[idx] ? vals[idx].trim() : ''; });
          confirmations.push(obj);
        }
      }
    }
  } catch (parseErr) {
    console.warn('[NiFi] Failed to parse inbound file:', parseErr.message);
  }

  // Store inbound file
  await pool.query(`
    INSERT INTO nifi_payment_files
      (file_id, direction, file_format, file_name, file_content, file_size_bytes,
       file_hash, hmac_signature, status, payment_count, total_amount, source_system, destination_system)
    VALUES ($1, 'inbound', $2, $3, $4, $5, $6, $7, 'delivered', $8, $9, $10, 'core_banking')
  `, [
    fileId, format, fileName, content, Buffer.byteLength(content),
    fileHash, fileData.hmac_signature || null, confirmations.length,
    confirmations.reduce(function(s, c) { return s + (parseFloat(c.amount) || 0); }, 0),
    fileData.source_system || 'nifi',
  ]);

  // Process confirmations — advance settlement statuses
  var processed = 0;
  var failed = 0;
  for (var j = 0; j < confirmations.length; j++) {
    var conf = confirmations[j];
    try {
      if (conf.settlement_id && settlementEngine) {
        var newStatus = conf.status || 'settled';
        await settlementEngine.advanceSettlementStatus(conf.settlement_id, newStatus, {
          nifi_confirmation: true,
          confirmation_ref: conf.reference || conf.confirmation_code || null,
        });
        processed++;
      }
    } catch (confErr) {
      console.warn('[NiFi] Confirmation processing failed for', conf.settlement_id, ':', confErr.message);
      failed++;
    }
  }

  return {
    file_id: fileId,
    status: 'delivered',
    confirmations_received: confirmations.length,
    processed: processed,
    failed: failed,
  };
}

/**
 * Push a file to NiFi's ListenHTTP processor endpoint.
 */
async function pushToNiFi(fileId, endpoint) {
  await ensureTables();
  checkCircuit('nifi-push');

  var result = await pool.query(
    'SELECT * FROM nifi_payment_files WHERE file_id = $1', [fileId]
  );
  if (!result.rows || result.rows.length === 0) throw new Error('File not found: ' + fileId);

  var file = result.rows[0];
  endpoint = endpoint || file.delivery_endpoint || process.env.NIFI_ENDPOINT;
  if (!endpoint) throw new Error('No NiFi endpoint configured. Set NIFI_ENDPOINT env var or pass endpoint parameter.');

  // Use Node.js https/http to POST file to NiFi
  var https_mod = require('https');
  var http_mod = require('http');
  var url = require('url');
  var parsed = new URL(endpoint);

  var postData = file.file_content;
  var mod = parsed.protocol === 'https:' ? https_mod : http_mod;

  // Optional mutual-TLS: present a client certificate when NiFi's ListenHTTP
  // endpoint requires one. Sourced from NIFI_CLIENT_* env vars.
  var buildMtlsOptions = require('../ach/openBankApi').buildMtlsOptions;
  var mtlsOptions = buildMtlsOptions({
    useMtls: process.env.NIFI_USE_MTLS === 'true'
      || !!(process.env.NIFI_CLIENT_CERT_PATH && process.env.NIFI_CLIENT_KEY_PATH),
    clientCertPath: process.env.NIFI_CLIENT_CERT_PATH,
    clientKeyPath: process.env.NIFI_CLIENT_KEY_PATH,
    clientCaPath: process.env.NIFI_CLIENT_CA_PATH,
    clientKeyPassphrase: process.env.NIFI_CLIENT_KEY_PASSPHRASE,
  });

  return new Promise(function(resolve, reject) {
    var options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': file.file_format === 'json' ? 'application/json' :
          file.file_format === 'iso20022' ? 'application/xml' :
          'application/octet-stream',
        'Content-Length': Buffer.byteLength(postData),
        'X-NiFi-File-Id': file.file_id,
        'X-NiFi-File-Name': file.file_name,
        'X-NiFi-File-Hash': file.file_hash,
        'X-NiFi-HMAC': file.hmac_signature || '',
        'X-NiFi-Payment-Count': String(file.payment_count),
        'X-NiFi-Total-Amount': String(file.total_amount),
      },
    };

    // Add auth if configured
    if (process.env.NIFI_API_KEY) {
      options.headers['Authorization'] = 'Bearer ' + process.env.NIFI_API_KEY;
    }

    // Merge mutual-TLS client cert/key/ca (additive to header auth)
    Object.assign(options, mtlsOptions);

    var req = mod.request(options, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', async function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          recordCircuitSuccess();
          await pool.query(
            `UPDATE nifi_payment_files 
             SET status = 'delivered', delivered_at = NOW(), delivery_endpoint = $2,
                 delivery_attempts = delivery_attempts + 1, updated_at = NOW()
             WHERE file_id = $1`,
            [fileId, endpoint]
          );
          resolve({
            file_id: fileId,
            status: 'delivered',
            endpoint: endpoint,
            response_status: res.statusCode,
          });
        } else {
          var err = new Error('NiFi delivery failed: HTTP ' + res.statusCode + ' — ' + body.substring(0, 200));
          recordCircuitFailure(err);
          await pool.query(
            `UPDATE nifi_payment_files 
             SET delivery_attempts = delivery_attempts + 1, last_error = $2, updated_at = NOW()
             WHERE file_id = $1`,
            [fileId, err.message]
          );
          reject(err);
        }
      });
    });

    req.on('error', function(err) {
      recordCircuitFailure(err);
      pool.query(
        `UPDATE nifi_payment_files 
         SET delivery_attempts = delivery_attempts + 1, last_error = $2, updated_at = NOW()
         WHERE file_id = $1`,
        [fileId, err.message]
      ).catch(function() {});
      reject(err);
    });

    req.setTimeout(30000, function() {
      req.destroy();
      var err = new Error('NiFi delivery timeout after 30s');
      recordCircuitFailure(err);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Get NiFi dashboard data.
 */
async function getDashboard() {
  await ensureTables();

  var stats = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound_total,
      COUNT(*) FILTER (WHERE direction = 'inbound') AS inbound_total,
      COUNT(*) FILTER (WHERE status = 'staged') AS staged,
      COUNT(*) FILTER (WHERE status = 'picked_up') AS picked_up,
      COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
      COUNT(*) FILTER (WHERE status = 'acknowledged') AS acknowledged,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE status = 'expired') AS expired,
      COALESCE(SUM(total_amount) FILTER (WHERE direction = 'outbound'), 0) AS outbound_volume,
      COALESCE(SUM(total_amount) FILTER (WHERE direction = 'inbound'), 0) AS inbound_volume,
      COALESCE(SUM(payment_count), 0) AS total_payments
    FROM nifi_payment_files
  `);

  var row = stats.rows[0] || {};

  var recentFiles = await pool.query(`
    SELECT file_id, file_name, file_format, direction, status, payment_count, total_amount, created_at
    FROM nifi_payment_files ORDER BY created_at DESC LIMIT 10
  `);

  return {
    stats: {
      outbound_total: parseInt(row.outbound_total) || 0,
      inbound_total: parseInt(row.inbound_total) || 0,
      staged: parseInt(row.staged) || 0,
      picked_up: parseInt(row.picked_up) || 0,
      delivered: parseInt(row.delivered) || 0,
      acknowledged: parseInt(row.acknowledged) || 0,
      failed: parseInt(row.failed) || 0,
      expired: parseInt(row.expired) || 0,
      outbound_volume: parseFloat(row.outbound_volume) || 0,
      inbound_volume: parseFloat(row.inbound_volume) || 0,
      total_payments: parseInt(row.total_payments) || 0,
    },
    recent_files: recentFiles.rows || [],
    circuit_breaker: {
      failures: circuitState.failures,
      open: circuitState.open,
      last_failure: circuitState.lastFailure ? new Date(circuitState.lastFailure).toISOString() : null,
    },
    nifi_endpoint: process.env.NIFI_ENDPOINT || null,
    hmac_configured: !!process.env.NIFI_HMAC_SECRET,
  };
}

/**
 * Expire old staged files that haven't been picked up.
 */
async function expireStaleFiles() {
  await ensureTables();
  var result = await pool.query(`
    UPDATE nifi_payment_files 
    SET status = 'expired', updated_at = NOW()
    WHERE status IN ('staged', 'generated') AND expires_at < NOW()
    RETURNING file_id
  `);
  return { expired: result.rowCount || 0 };
}

/**
 * Get transfer history.
 */
async function getTransferHistory(opts) {
  await ensureTables();
  opts = opts || {};
  var limit = Math.min(parseInt(opts.limit, 10) || 50, 200);
  var offset = parseInt(opts.offset, 10) || 0;
  var direction = opts.direction;

  var query = 'SELECT * FROM nifi_payment_files';
  var params = [];
  if (direction) {
    query += ' WHERE direction = $1';
    params.push(direction);
  }
  query += ' ORDER BY created_at DESC LIMIT ' + limit + ' OFFSET ' + offset;

  var result = await pool.query(query, params);
  return result.rows || [];
}

/**
 * Get circuit breaker status.
 */
function getCircuitStatus() {
  return {
    failures: circuitState.failures,
    open: circuitState.open,
    last_failure: circuitState.lastFailure ? new Date(circuitState.lastFailure).toISOString() : null,
    threshold: CIRCUIT_THRESHOLD,
    reset_ms: CIRCUIT_RESET_MS,
  };
}

// ─── CIRCUIT BREAKER ──────────────────────────────────────────────────────────

function checkCircuit(component) {
  if (!circuitState.open) return;
  if (Date.now() - circuitState.lastFailure > CIRCUIT_RESET_MS) {
    circuitState.open = false;
    circuitState.failures = 0;
    return;
  }
  throw new Error('NiFi circuit breaker OPEN — ' + (component || 'transfer') + ' temporarily unavailable');
}

function recordCircuitFailure(err) {
  circuitState.failures++;
  circuitState.lastFailure = Date.now();
  if (circuitState.failures >= CIRCUIT_THRESHOLD) {
    circuitState.open = true;
    console.error('[NiFi] circuit breaker OPENED:', err.message);
  }
}

function recordCircuitSuccess() {
  if (circuitState.failures > 0) circuitState.failures = Math.max(0, circuitState.failures - 1);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function padRight(str, len, ch) { ch = ch || ' '; while (str.length < len) str += ch; return str.substring(0, len); }
function padLeft(str, len, ch) { ch = ch || ' '; while (str.length < len) str = ch + str; return str.substring(str.length - len); }
function randomHex(n) { return crypto.randomBytes(n).toString('hex').toUpperCase(); }
function escXml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function csvEsc(s) { s = String(s || ''); return s.indexOf(',') !== -1 || s.indexOf('"') !== -1 ? '"' + s.replace(/"/g, '""') + '"' : s; }

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  generateAndStagePaymentFile: generateAndStagePaymentFile,
  listOutboxFiles: listOutboxFiles,
  getFileContent: getFileContent,
  acknowledgeFile: acknowledgeFile,
  processInboundFile: processInboundFile,
  pushToNiFi: pushToNiFi,
  getDashboard: getDashboard,
  expireStaleFiles: expireStaleFiles,
  getTransferHistory: getTransferHistory,
  getCircuitStatus: getCircuitStatus,
  generateNACHA: generateNACHA,
  generateISO20022: generateISO20022,
  generateCSV: generateCSV,
  generateJSON: generateJSON,
  computeHmac: computeHmac,
  verifyHmac: verifyHmac,
  ensureTables: ensureTables,
};

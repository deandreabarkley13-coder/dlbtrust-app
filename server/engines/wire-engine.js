/**
 * Wire Transfer Message Generator Engine
 * DEANDREA LAVAR BARKLEY TRUST — Real Wire Payment Processing
 *
 * Generates:
 *   1. Fedwire-format messages (domestic USD wires via Federal Reserve)
 *   2. SWIFT MT103 messages (international wires)
 *
 * These messages follow industry standards and can be submitted to
 * the originating bank for execution.
 *
 * Originator: DEANDREA LAVAR BARKLEY TRUST
 * Originator Bank: Eaton Family Credit Union (ABA: 241075470)
 */

'use strict';

// --- Constants ---------------------------------------------------------------

const ORIGINATOR_BANK_ABA    = '241075470';
const ORIGINATOR_BANK_NAME   = 'EATON FAMILY CREDIT UNION';
const ORIGINATOR_NAME        = 'DEANDREA LAVAR BARKLEY TRUST';
const ORIGINATOR_ACCOUNT     = ''; // Set per-payment or from config
const ORIGINATOR_ADDRESS     = ''; // Set via config

// Fedwire Type/Subtype codes
const FEDWIRE_TYPES = {
  FUNDS_TRANSFER:  '1000', // Basic funds transfer
  DRAWDOWN_REQ:    '1001', // Drawdown request
  BANK_TO_BANK:    '1002', // Bank-to-bank transfer
  CUSTOMER_CREDIT: '1003', // Customer credit transfer
};

// SWIFT MT103 field tags
const MT103_FIELDS = {
  SENDER_REF:    ':20:',   // Sender's Reference
  BANK_OP_CODE:  ':23B:',  // Bank Operation Code
  VALUE_DATE:    ':32A:',  // Value Date/Currency/Amount
  ORDERING_CUST: ':50K:',  // Ordering Customer
  BENEFICIARY:   ':59:',   // Beneficiary
  REMITTANCE:    ':70:',   // Remittance Information
  CHARGES:       ':71A:',  // Details of Charges
  INTERMED_BANK: ':56A:',  // Intermediary Institution
  ACCT_WITH:     ':57A:',  // Account With Institution
};

// --- Utility Functions --------------------------------------------------------

function generateIMAD() {
  // Input Message Accountability Data
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const source = ORIGINATOR_BANK_ABA.slice(0, 8);
  const seq = String(Math.floor(Math.random() * 999999)).padStart(6, '0');
  return `${dateStr}${source}${seq}`;
}

function generateOMAD() {
  // Output Message Accountability Data (assigned by Fed — simulate for file gen)
  return generateIMAD().replace(/^.{8}/, '00000000');
}

function formatCurrency(cents) {
  return (cents / 100).toFixed(2).replace('.', '');
}

function formatDateISO(date) {
  const d = date || new Date();
  return d.toISOString().slice(0, 10);
}

function formatDateYYMMDD(date) {
  const d = date || new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function wrapLine(text, maxLen = 35) {
  const lines = [];
  for (let i = 0; i < text.length; i += maxLen) {
    lines.push(text.slice(i, i + maxLen));
  }
  return lines;
}

function generateReference() {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `DLB${ts}`;
}

// --- Fedwire Message Generator -----------------------------------------------

/**
 * Generate a Fedwire funds transfer message
 *
 * @param {Object} wire
 * @param {number} wire.amountCents - Transfer amount in cents
 * @param {string} wire.senderAccount - Originator's account number
 * @param {string} wire.senderName - Originator name
 * @param {string} wire.senderAddress - Originator address (optional)
 * @param {string} wire.receiverRoutingNumber - Beneficiary's bank ABA (9 digits)
 * @param {string} wire.receiverBankName - Beneficiary's bank name
 * @param {string} wire.receiverAccount - Beneficiary's account number
 * @param {string} wire.receiverName - Beneficiary name
 * @param {string} wire.receiverAddress - Beneficiary address (optional)
 * @param {string} wire.purpose - Purpose/reference/memo
 * @param {string} wire.intermediaryRouting - Intermediary bank ABA (optional)
 * @param {string} wire.intermediaryName - Intermediary bank name (optional)
 * @returns {Object} { content, filename, metadata }
 */
function generateFedwire(wire) {
  if (!wire.amountCents || wire.amountCents <= 0) {
    throw new Error('Amount must be positive');
  }
  if (!wire.receiverRoutingNumber || !/^\d{9}$/.test(wire.receiverRoutingNumber)) {
    throw new Error('Invalid receiver routing number (must be 9 digits)');
  }
  if (!wire.receiverAccount) throw new Error('Receiver account number is required');
  if (!wire.receiverName) throw new Error('Receiver name is required');

  const imad = generateIMAD();
  const reference = wire.reference || generateReference();
  const amount = formatCurrency(wire.amountCents);

  // Build Fedwire message tags
  const tags = [];

  // {1500} Sender Supplied Information
  tags.push(`{1500}30${FEDWIRE_TYPES.FUNDS_TRANSFER}`);

  // {1510} Type/Subtype
  tags.push(`{1510}${FEDWIRE_TYPES.FUNDS_TRANSFER}`);

  // {1520} IMAD
  tags.push(`{1520}${imad}`);

  // {2000} Amount
  tags.push(`{2000}000000${amount.padStart(12, '0')}`);

  // {3100} Sender DFI (Originator's bank)
  tags.push(`{3100}${ORIGINATOR_BANK_ABA}${ORIGINATOR_BANK_NAME}`);

  // {3400} Receiver DFI (Beneficiary's bank)
  tags.push(`{3400}${wire.receiverRoutingNumber}${wire.receiverBankName || ''}`);

  // {3600} Business Function Code
  tags.push(`{3600}CTR`); // Customer Transfer

  // {4000} Sender Reference
  tags.push(`{4000}${reference}`);

  // {4100} Sender Account / Originator
  const senderAcct = wire.senderAccount || ORIGINATOR_ACCOUNT;
  tags.push(`{4100}${senderAcct}`);

  // {4200} Originator
  const origName = wire.senderName || ORIGINATOR_NAME;
  tags.push(`{4200}D/${senderAcct}*${origName}*${wire.senderAddress || ''}*`);

  // {4320} Originator's Bank
  tags.push(`{4320}${ORIGINATOR_BANK_ABA}*${ORIGINATOR_BANK_NAME}*`);

  // {4400} Beneficiary's Bank (if intermediary)
  if (wire.intermediaryRouting) {
    tags.push(`{4400}${wire.intermediaryRouting}*${wire.intermediaryName || ''}*`);
  }

  // {4200} Beneficiary
  tags.push(`{4300}${wire.receiverAccount}`);

  // {5000} Beneficiary Info
  tags.push(`{5000}D/${wire.receiverAccount}*${wire.receiverName}*${wire.receiverAddress || ''}*`);

  // {6000} OBI (Originator to Beneficiary Information)
  if (wire.purpose) {
    const lines = wrapLine(wire.purpose, 35);
    tags.push(`{6000}${lines.join('*')}*`);
  }

  const content = tags.join('\n');

  // Generate filename
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `WIRE_FED_${ts}.txt`;

  return {
    content,
    filename,
    format: 'fedwire',
    metadata: {
      imad,
      reference,
      amountCents: wire.amountCents,
      amountUSD: (wire.amountCents / 100).toFixed(2),
      senderBank: ORIGINATOR_BANK_NAME,
      senderABA: ORIGINATOR_BANK_ABA,
      receiverBank: wire.receiverBankName || '',
      receiverABA: wire.receiverRoutingNumber,
      beneficiary: wire.receiverName,
      createdAt: now.toISOString(),
    },
  };
}

// --- SWIFT MT103 Message Generator -------------------------------------------

/**
 * Generate a SWIFT MT103 message for international wire transfers
 *
 * @param {Object} wire
 * @param {number} wire.amountCents - Transfer amount in cents
 * @param {string} wire.currency - 3-letter currency code (default USD)
 * @param {string} wire.senderAccount - Originator's account number
 * @param {string} wire.senderName - Originator name
 * @param {string} wire.senderAddress - Originator address
 * @param {string} wire.receiverSwiftBIC - Beneficiary bank SWIFT/BIC code
 * @param {string} wire.receiverBankName - Beneficiary bank name
 * @param {string} wire.receiverAccount - Beneficiary's account (IBAN or local)
 * @param {string} wire.receiverName - Beneficiary name
 * @param {string} wire.receiverAddress - Beneficiary address
 * @param {string} wire.purpose - Remittance info
 * @param {string} wire.intermediaryBIC - Intermediary bank BIC (optional)
 * @param {string} wire.charges - OUR/SHA/BEN (default OUR = sender pays all)
 * @returns {Object} { content, filename, metadata }
 */
function generateSWIFT_MT103(wire) {
  if (!wire.amountCents || wire.amountCents <= 0) {
    throw new Error('Amount must be positive');
  }
  if (!wire.receiverAccount) throw new Error('Receiver account/IBAN is required');
  if (!wire.receiverName) throw new Error('Receiver name is required');

  const reference = wire.reference || generateReference();
  const currency = wire.currency || 'USD';
  const valueDate = formatDateYYMMDD(wire.valueDate || new Date());
  const amount = (wire.amountCents / 100).toFixed(2).replace('.', ',');

  const lines = [];

  // Message header
  lines.push('{1:F01EATNUSXXXXX0000000000}');
  lines.push(`{2:I103${wire.receiverSwiftBIC || 'XXXXXXXXX'}N}`);
  lines.push('{4:');

  // :20: Sender's Reference
  lines.push(`${MT103_FIELDS.SENDER_REF}${reference}`);

  // :23B: Bank Operation Code
  lines.push(`${MT103_FIELDS.BANK_OP_CODE}CRED`);

  // :32A: Value Date / Currency / Amount
  lines.push(`${MT103_FIELDS.VALUE_DATE}${valueDate}${currency}${amount}`);

  // :50K: Ordering Customer (Sender)
  lines.push(`${MT103_FIELDS.ORDERING_CUST}/${wire.senderAccount || ''}`);
  const senderNameLines = wrapLine(wire.senderName || ORIGINATOR_NAME, 35);
  senderNameLines.forEach(l => lines.push(l));
  if (wire.senderAddress) {
    wrapLine(wire.senderAddress, 35).forEach(l => lines.push(l));
  }

  // :56A: Intermediary (optional)
  if (wire.intermediaryBIC) {
    lines.push(`${MT103_FIELDS.INTERMED_BANK}${wire.intermediaryBIC}`);
  }

  // :57A: Account With Institution (beneficiary bank)
  if (wire.receiverSwiftBIC) {
    lines.push(`${MT103_FIELDS.ACCT_WITH}${wire.receiverSwiftBIC}`);
  }

  // :59: Beneficiary
  lines.push(`${MT103_FIELDS.BENEFICIARY}/${wire.receiverAccount}`);
  wrapLine(wire.receiverName, 35).forEach(l => lines.push(l));
  if (wire.receiverAddress) {
    wrapLine(wire.receiverAddress, 35).forEach(l => lines.push(l));
  }

  // :70: Remittance Information
  if (wire.purpose) {
    lines.push(`${MT103_FIELDS.REMITTANCE}${wire.purpose.slice(0, 140)}`);
  }

  // :71A: Details of Charges
  lines.push(`${MT103_FIELDS.CHARGES}${wire.charges || 'OUR'}`);

  // End of message
  lines.push('-}');

  const content = lines.join('\r\n');

  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = `WIRE_SWIFT_MT103_${ts}.txt`;

  return {
    content,
    filename,
    format: 'swift_mt103',
    metadata: {
      reference,
      amountCents: wire.amountCents,
      amountFormatted: `${currency} ${(wire.amountCents / 100).toFixed(2)}`,
      currency,
      senderBank: ORIGINATOR_BANK_NAME,
      receiverBIC: wire.receiverSwiftBIC || 'N/A',
      beneficiary: wire.receiverName,
      charges: wire.charges || 'OUR',
      valueDate: formatDateISO(wire.valueDate || new Date()),
      createdAt: now.toISOString(),
    },
  };
}

/**
 * Generate appropriate wire message based on destination
 * Fedwire for domestic (has ABA routing), SWIFT for international (has BIC)
 */
function generateWireMessage(wire) {
  if (wire.receiverSwiftBIC && !wire.receiverRoutingNumber) {
    return generateSWIFT_MT103(wire);
  }
  return generateFedwire(wire);
}

module.exports = {
  generateFedwire,
  generateSWIFT_MT103,
  generateWireMessage,
  generateReference,
  generateIMAD,
  FEDWIRE_TYPES,
  ORIGINATOR_BANK_ABA,
  ORIGINATOR_BANK_NAME,
  ORIGINATOR_NAME,
};

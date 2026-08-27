#!/usr/bin/env node
'use strict';

/**
 * Send a real fiat wire from the PTC bank ledger to an external beneficiary.
 *
 * Sourcing from an interest-income GL account is supported: the engine maps the
 * income account to the accrued-interest asset account for cash, and the wire
 * GL entry charges the interest-income account.
 *
 * Usage:
 *   node server/scripts/sendPtcBankWire.js \
 *     --amount 5000 \
 *     --fromAccountId TBA-1786901946193-CM2PTE \
 *     --sourceAccountId 4000 \
 *     --routing 121145307 \
 *     --account 692101092959 \
 *     --name "DB NET MGMT" \
 *     --bankName "Lili Bank" \
 *     --senderRouting 121145307 \
 *     --senderAccount TBN-... \
 *     --requiresApproval false
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const { PtcTreasuryEngine } = require('../integrations/os/osEngine');
const { WireEngine } = require('../integrations/wire/wireEngine');
const { TrustAccountingEngine } = require('../integrations/accounting/trustAccountingEngine');
const pool = require('../integrations/bonds/pgPool');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const k = key.replace(/^--/, '');
      const next = argv[i + 1];
      args[k] = next && !next.startsWith('--') ? next : true;
      if (next && !next.startsWith('--')) i++;
    }
  }
  return args;
}

async function findPtcCheckingAccount() {
  const res = await pool.query(
    `SELECT account_id, account_number, balance_cents
     FROM trust_bank_accounts
     WHERE status = 'active' AND account_name ILIKE '%checking%'
     ORDER BY balance_cents DESC, created_at DESC
     LIMIT 1`
  );
  if (!res.rows.length) throw new Error('No active PTC checking account found');
  return res.rows[0];
}

async function reversePaymentJournals(paymentId, fromAccountId, description) {
  if (!TrustAccountingEngine) throw new Error('TrustAccountingEngine not available');

  const { rows: paymentRows } = await pool.query(
    `SELECT entry_id FROM trust_journal_entries
     WHERE reference_type = 'ptc-bank-payment' AND reference_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [paymentId]
  );

  const { rows: fundRows } = await pool.query(
    `SELECT entry_id FROM trust_journal_entries
     WHERE reference_type = 'ptc-bank' AND reference_id = $1
       AND description ILIKE $2
     ORDER BY created_at DESC LIMIT 1`,
    [fromAccountId, `%${description}%`]
  );

  const reverse = [];
  for (const { entry_id } of [...paymentRows, ...fundRows]) {
    const linesRes = await pool.query(
      `SELECT account_code, debit_amount, credit_amount
       FROM trust_journal_lines
       WHERE entry_id = $1`,
      [entry_id]
    );
    if (!linesRes.rows.length) continue;
    const reversedLines = linesRes.rows.map((l) => ({
      accountCode: l.account_code,
      debitAmount: parseFloat(l.credit_amount),
      creditAmount: parseFloat(l.debit_amount),
      memo: `Reversal of ${entry_id}`,
    }));
    const je = await TrustAccountingEngine.postJournalEntry({
      entryDate: new Date(),
      description: `Reverse ${entry_id} — wire replacing ACH`,
      referenceType: 'ptc-bank-payment',
      referenceId: paymentId,
      postedBy: 'ptc-bank-wire',
      lines: reversedLines,
      postToFineract: false,
    });
    reverse.push({ reversedEntryId: entry_id, reversalEntryId: je.entry_id });
  }
  return reverse;
}

function buildPacs008(wire) {
  const amount = (wire.amount_cents / 100).toFixed(2);
  const now = new Date().toISOString();
  const pmtId = wire.wire_id;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>${pmtId}</MsgId>
      <CreDtTm>${now}</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
      <SttlmInf>
        <SttlmMtd>INDA</SttlmMtd>
      </SttlmInf>
    </GrpHdr>
    <CdtTrfTxInf>
      <PmtId>
        <InstrId>${pmtId}</InstrId>
        <EndToEndId>${pmtId}</EndToEndId>
        <TxId>${wire.fed_reference || pmtId}</TxId>
      </PmtId>
      <IntrBkSttlmAmt Ccy="${wire.currency || 'USD'}">${amount}</IntrBkSttlmAmt>
      <Cdtr>
        <Nm>${escapeXml(wire.beneficiary_name)}</Nm>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <Othr>
            <Id>${wire.beneficiary_account}</Id>
          </Othr>
        </Id>
      </CdtrAcct>
      <CdtrAgt>
        <FinInstnId>
          <ClrSysMmbId>
            <MmbId>${wire.beneficiary_routing}</MmbId>
          </ClrSysMmbId>
        </FinInstnId>
      </CdtrAgt>
      <Dbtr>
        <Nm>${escapeXml(wire.sender_name)}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <Othr>
            <Id>${wire.sender_account}</Id>
          </Othr>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <ClrSysMmbId>
            <MmbId>${wire.sender_routing}</MmbId>
          </ClrSysMmbId>
        </FinInstnId>
      </DbtrAgt>
      <RmtInf>
        <Ustrd>${escapeXml(wire.description || '')}</Ustrd>
      </RmtInf>
    </CdtTrfTxInf>
  </FIToFICstmrCdtTrf>
</Document>`;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function exportWireArtifacts(wireId) {
  const wire = await WireEngine.getWire(wireId);
  if (!wire) throw new Error(`Wire not found: ${wireId}`);

  const dir = path.join(__dirname, '..', '..', 'data', 'wire-messages');
  fs.mkdirSync(dir, { recursive: true });

  const structured = WireEngine.formatWireMessage(wire);
  const jsonPath = path.join(dir, `${wireId}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(structured, null, 2));

  const pacsPath = path.join(dir, `${wireId}.pacs.008.xml`);
  fs.writeFileSync(pacsPath, buildPacs008(wire));

  return { jsonPath, pacsPath };
}

async function main() {
  const args = parseArgs(process.argv);

  const amount = Number(args.amount || args.amt || 5000);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number');
  }

  const fromAccount = args.fromAccountId
    ? await (async () => {
        const r = await pool.query(
          'SELECT account_id, account_number, balance_cents FROM trust_bank_accounts WHERE account_id = $1',
          [args.fromAccountId]
        );
        if (!r.rows.length) throw new Error(`Account not found: ${args.fromAccountId}`);
        return r.rows[0];
      })()
    : await findPtcCheckingAccount();

  const routing = args.routing || process.env.PTC_BANK_ROUTING || '121145307';
  const account = args.account || '692101092959';
  const name = args.name || 'DB NET MGMT';
  const bankName = args.bankName || 'Lili Bank';
  const senderRouting = args.senderRouting || process.env.PTC_BANK_ROUTING || routing;
  const senderAccount = args.senderAccount || process.env.PTC_BANK_SETTLEMENT_ACCOUNT || fromAccount.account_number;

  // If the source is an income GL account (e.g. 4000 Interest Income), the engine
  // will map it to the accrued-interest asset account for cash and charge the
  // wire to the income account.
  const sourceAccountId = args.sourceAccountId || '1000';
  const sourceType = args.sourceType || 'trust';

  if (args.replacePaymentId) {
    console.log(`Reversing prior payment ${args.replacePaymentId}...`);
    const reversals = await reversePaymentJournals(args.replacePaymentId, fromAccount.account_id, name);
    const priorRes = await pool.query(`SELECT external_tx_id FROM trust_bank_payments WHERE payment_id = $1`, [args.replacePaymentId]);
    const priorTxId = priorRes.rows[0]?.external_tx_id;
    await pool.query(`UPDATE trust_bank_payments SET status = 'cancelled', updated_at = NOW() WHERE payment_id = $1`, [args.replacePaymentId]);
    if (priorTxId) {
      await pool.query(`UPDATE bank_transfers SET status = 'cancelled', updated_at = NOW() WHERE transfer_id = $1`, [priorTxId]);
      const batchRes = await pool.query(`SELECT ach_batch_id FROM bank_transfers WHERE transfer_id = $1`, [priorTxId]);
      if (batchRes.rows[0]?.ach_batch_id) {
        await pool.query(`UPDATE ach_batches SET status = 'cancelled', updated_at = NOW() WHERE batch_id = $1`, [batchRes.rows[0].ach_batch_id]);
      }
    }
    console.log('Reversed prior payment:', reversals);
  }

  const requiresApproval = args.requiresApproval === 'true' || false;

  const payload = {
    action: 'distribute',
    rail: 'wire',
    amount,
    fromAccountId: fromAccount.account_id,
    sourceType,
    sourceAccountId,
    payee: {
      routing,
      account,
      name,
      bankName,
    },
    description: args.description || `Wire from interest income to ${name}`,
    initiatedBy: args.initiatedBy || process.env.PTC_BANK_INITIATED_BY || 'ptc-bank-script',
    autoSend: true,
    senderRouting,
    senderAccount,
    requiresApproval,
  };

  console.log('Originating PTC bank wire with payload:');
  console.log(JSON.stringify({ ...payload, payee: { ...payload.payee, account: '***' + String(payload.payee.account).slice(-4) } }, null, 2));

  const result = await PtcTreasuryEngine.process(payload);
  console.log('Result:');
  console.log(JSON.stringify(result, null, 2));

  if (result.success && (result.result?.sent?.wire_id || result.result?.sent?.externalTxId)) {
    const wireId = result.result.sent.wire_id || result.result.sent.externalTxId;
    const artifacts = await exportWireArtifacts(wireId);
    console.log('Wire artifacts exported:');
    console.log(JSON.stringify(artifacts, null, 2));
  } else {
    console.warn('Wire did not reach sent/completed status; no artifacts exported.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
});

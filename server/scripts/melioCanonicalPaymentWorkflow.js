#!/usr/bin/env node
'use strict';

/**
 * Canonical ledger → Melio payment-file workflow.
 *
 * End to end, this script:
 *   1. Downloads the ledger account balances CSV (trial balance) for the audit trail.
 *   2. Verifies the source ledger account covers the payment amount.
 *   3. Creates a canonical vendor_bill proposal (Maker/Checker consensus required).
 *   4. Records Maker and Checker approvals with legal-name signatures of record.
 *   5. Executes the proposal, generating the Melio CSV payment file and GL accrual.
 *   6. Downloads the Melio CSV payment file for manual upload to Melio.
 *
 * Manual step after running: in Melio, go to Bills tab → Import bills →
 * Import bills spreadsheet, upload the downloaded CSV, review and pay.
 * After paying in Melio, settle the ledger with:
 *   POST /api/vendors/payments/melio/:paymentId/mark-paid
 *
 * Usage:
 *   ADMIN_SECRET_TOKEN=... \
 *   TRUST_MAKER_SIGNATURE="Malissa Ann Robinson" \
 *   TRUST_CHECKER_SIGNATURE="DeAndrea Lavar Barkley" \
 *   node server/scripts/melioCanonicalPaymentWorkflow.js \
 *     --amount 100.00 \
 *     --sourceType trust \
 *     --sourceAccountId 1000 \
 *     --vendorName "DB NET MGMT" \
 *     --vendorEmail vendor@example.com \
 *     --routing 121145307 \
 *     --account 692101092959 \
 *     --accountType checking \
 *     --bankName "Lili Bank" \
 *     --invoiceNumber INV-1001 \
 *     --dueDate 2026-09-01 \
 *     --memo "Trust expense bill" \
 *     --outDir data/melio-workflow
 *
 * Options:
 *   --baseUrl          Server base URL (default: $DLBTRUST_BASE_URL or http://localhost:3002)
 *   --makerEmail       Maker trustee email (default: $TRUST_MAKER_EMAIL or malissa1130@gmail.com)
 *   --checkerEmail     Checker trustee email (default: $TRUST_CHECKER_EMAIL or deandreabarkley13@gmail.com)
 *   --makerSignature   Maker legal-name signature (default: $TRUST_MAKER_SIGNATURE)
 *   --checkerSignature Checker legal-name signature (default: $TRUST_CHECKER_SIGNATURE)
 */

const fs = require('fs');
const path = require('path');

const args = (() => {
  const argv = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1] || '';
      i += 1;
    }
  }
  return out;
})();

const BASE_URL = (args.baseUrl || process.env.DLBTRUST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || '';

function required(a, keys) {
  for (const k of keys) {
    if (!a[k]) throw new Error(`Missing required argument: --${k}`);
  }
}

async function api(method, route, body) {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
  if (!res.ok) throw new Error(`${method} ${route} failed (${res.status}): ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  return parsed;
}

async function download(route, filePath) {
  const res = await fetch(`${BASE_URL}${route}`, { headers: { 'x-admin-token': TOKEN } });
  if (!res.ok) throw new Error(`GET ${route} failed (${res.status}): ${await res.text()}`);
  fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  return filePath;
}

async function main() {
  if (!TOKEN) throw new Error('ADMIN_SECRET_TOKEN environment variable is required');
  required(args, ['amount', 'vendorName', 'routing', 'account']);

  const amount = Number(args.amount);
  if (!amount || amount <= 0) throw new Error('--amount must be a positive number');

  const sourceType = args.sourceType || 'trust';
  const sourceAccountId = args.sourceAccountId || process.env.MELIO_SOURCE_ACCOUNT_ID || '1000';
  const makerEmail = args.makerEmail || process.env.TRUST_MAKER_EMAIL || 'malissa1130@gmail.com';
  const checkerEmail = args.checkerEmail || process.env.TRUST_CHECKER_EMAIL || 'deandreabarkley13@gmail.com';
  const makerSignature = args.makerSignature || process.env.TRUST_MAKER_SIGNATURE || '';
  const checkerSignature = args.checkerSignature || process.env.TRUST_CHECKER_SIGNATURE || '';
  if (!makerSignature || !checkerSignature) {
    throw new Error('Maker and Checker legal-name signatures are required (--makerSignature/--checkerSignature or TRUST_MAKER_SIGNATURE/TRUST_CHECKER_SIGNATURE)');
  }

  const outDir = path.resolve(args.outDir || path.join(process.cwd(), 'data', 'melio-workflow'));
  fs.mkdirSync(outDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  // 1. Download ledger account balances CSV for the audit trail
  const balancesPath = path.join(outDir, `ledger-balances-${today}.csv`);
  await download('/api/accounting/reports/balances/download', balancesPath);
  console.log(`[1/6] Ledger balances CSV downloaded: ${balancesPath}`);

  // 2. Verify the source ledger account covers the payment
  const tb = await api('GET', '/api/accounting/reports/trial-balance');
  const account = (tb.data.accounts || []).find((a) => String(a.account_code) === String(sourceAccountId));
  const balance = account ? Number(account.current_balance || 0) : null;
  if (balance === null) {
    console.warn(`[2/6] Account ${sourceAccountId} not found in trial balance; server will enforce the balance check`);
  } else if (balance < amount) {
    throw new Error(`Insufficient ledger balance in ${sourceAccountId}: ${balance.toFixed(2)} < ${amount.toFixed(2)}`);
  } else {
    console.log(`[2/6] Source account ${sourceAccountId} balance $${balance.toFixed(2)} covers $${amount.toFixed(2)}`);
  }

  // 3. Create the canonical vendor_bill proposal (Maker/Checker consensus)
  const payload = {
    amount,
    sourceType,
    sourceAccountId,
    invoiceNumber: args.invoiceNumber || `INV-${Date.now()}`,
    dueDate: args.dueDate || today,
    billDate: args.billDate || today,
    memo: args.memo || `Trust vendor bill ${today}`,
    vendor: {
      name: args.vendorName,
      email: args.vendorEmail || '',
      address: {
        line1: args.vendorAddressLine1 || '',
        city: args.vendorCity || '',
        state: args.vendorState || '',
        postalCode: args.vendorPostalCode || '',
        country: args.vendorCountry || 'US',
      },
      bankAccount: {
        accountNumber: args.account,
        routingNumber: args.routing,
        accountType: args.accountType || 'checking',
        bankName: args.bankName || '',
      },
    },
  };
  const proposalRes = await api('POST', '/api/finops/consensus/proposals', {
    title: `Vendor bill: ${args.vendorName} $${amount.toFixed(2)}`,
    description: payload.memo,
    category: 'vendor_bill',
    payload,
  });
  const proposalId = proposalRes.data.id;
  console.log(`[3/6] Canonical vendor_bill proposal created: ${proposalId}`);

  // 4. Maker and Checker approvals with legal-name signatures of record
  await api('POST', `/api/finops/consensus/proposals/${proposalId}/approve`, {
    role: 'maker',
    approverEmail: makerEmail,
    signature: makerSignature,
  });
  console.log(`[4/6] Maker approval recorded (${makerEmail})`);
  const checkerRes = await api('POST', `/api/finops/consensus/proposals/${proposalId}/approve`, {
    role: 'checker',
    approverEmail: checkerEmail,
    signature: checkerSignature,
  });
  console.log(`[4/6] Checker approval recorded (${checkerEmail})`);

  // 5. Execute the proposal → Melio CSV export + GL accrual
  // (the final approval auto-executes once the consensus threshold is met)
  let proposal = checkerRes.data;
  if (proposal.status !== 'executed') {
    proposal = (await api('POST', `/api/finops/consensus/proposals/${proposalId}/execute`)).data;
  }
  const result = proposal.result || proposal;
  const paymentId = result.paymentId || result.exportIdentifier;
  if (!paymentId) throw new Error(`Execution succeeded but no payment id returned: ${JSON.stringify(proposal)}`);
  console.log(`[5/6] Proposal executed. Melio payment: ${paymentId}${result.journalEntryId ? ` (journal ${result.journalEntryId})` : ''}`);

  // 6. Download the Melio CSV payment file for manual upload
  const melioCsvPath = path.join(outDir, result.fileName || `melio-export-${paymentId}-${today}.csv`);
  await download(`/api/vendors/payments/melio/${encodeURIComponent(paymentId)}/download`, melioCsvPath);
  console.log(`[6/6] Melio payment file downloaded: ${melioCsvPath}`);

  console.log('');
  console.log('Next steps:');
  console.log('  1. In Melio, go to Bills tab → Import bills → Import bills spreadsheet.');
  console.log(`  2. Upload ${melioCsvPath}, review the imported bill, and pay it.`);
  console.log('  3. After Melio confirms payment, settle the ledger:');
  console.log(`     curl -X POST ${BASE_URL}/api/vendors/payments/melio/${paymentId}/mark-paid \\`);
  console.log("       -H 'x-admin-token: <ADMIN_SECRET_TOKEN>' -H 'Content-Type: application/json' \\");
  console.log("       -d '{\"settlement_reference\": \"<melio-payment-reference>\"}'");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

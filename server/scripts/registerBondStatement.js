'use strict';
/**
 * Registers a bond's elapsed coupon periods on the ledger and prints the
 * resulting Bond Financial Statement, optionally writing the PDF.
 *
 *   node server/scripts/registerBondStatement.js <bondRef> [asOf] [--pdf out.pdf]
 *
 * <bondRef> may be the bond id, statement id (e.g. 197814430), bond identifier
 * or bond name. Applies migrate-bond-statement.sql first so the statement
 * columns exist. Idempotent.
 */

const fs = require('fs');
const path = require('path');
const pool = require('../integrations/bonds/pgPool');
const { BondStatementEngine } = require('../integrations/bonds/bondStatementEngine');

async function main() {
  const args = process.argv.slice(2);
  const pdfIdx = args.indexOf('--pdf');
  const pdfOut = pdfIdx >= 0 ? args.splice(pdfIdx, 2)[1] : null;
  const [bondRef, asOfArg] = args;
  if (!bondRef) {
    console.error('usage: registerBondStatement.js <bondRef> [asOf YYYY-MM-DD] [--pdf out.pdf]');
    process.exit(2);
  }
  const asOf = asOfArg || new Date().toISOString().slice(0, 10);

  await pool.query(fs.readFileSync(path.join(__dirname, 'migrate-bond-statement.sql'), 'utf8'));

  const result = await BondStatementEngine.registerCoupons(bondRef, { asOf, actor: process.env.USER || 'registerBondStatement' });
  console.log(`[bond-statement] bond ${result.bondId}: registered ${result.registered.length} period(s), skipped ${result.skipped}; accrued ${result.accruedInterest.toFixed(2)} through ${result.lastAccrualDate}`);

  const { statement, pdf, filename } = await BondStatementEngine.renderPdf(bondRef, { asOf });
  console.log(JSON.stringify({ statementId: statement.statementId, asOf: statement.asOf, balance: statement.balance, ledger: statement.ledger }, null, 2));
  if (pdfOut) {
    fs.writeFileSync(pdfOut, pdf);
    console.log(`[bond-statement] wrote ${pdfOut} (${filename}, ${pdf.length} bytes)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('[bond-statement]', err.message); process.exit(1); });

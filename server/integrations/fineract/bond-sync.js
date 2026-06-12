/**
 * Fineract Bond Sync
 * Keeps bond_master_records in sync with Apache Fineract loans.
 */

'use strict';

const pool     = require('../../db/postgres');
const bus      = require('../../event-bus');
const fineract = require('./client');

/**
 * Sync a bond record to Fineract — create or update the corresponding loan
 * and write back fineract_loan_id and accrued_interest.
 */
async function syncBondToFineract(bond_id) {
  const { rows: [bond] } = await pool.query(
    'SELECT * FROM bond_master_records WHERE bond_id = $1',
    [bond_id]
  );
  if (!bond) throw new Error(`Bond ${bond_id} not found`);

  let loanId = bond.fineract_loan_id;

  if (!loanId) {
    const loan = await fineract.createLoanProduct(bond);
    loanId = String(loan.loanId || loan.resourceId);
  }

  const loanData = await fineract.getLoanById(loanId);
  const accrued = loanData.totalInterestCharged || bond.accrued_interest || 0;

  await pool.query(
    `UPDATE bond_master_records
     SET fineract_loan_id = $1, accrued_interest = $2,
         updated_at = now(), updated_by_module = 'fineract'
     WHERE bond_id = $3`,
    [loanId, accrued, bond_id]
  );

  await pool.query(
    `INSERT INTO bond_audit_log (bond_id, source, changes) VALUES ($1,'fineract',$2)`,
    [bond_id, JSON.stringify({ fineract_loan_id: loanId, accrued_interest: accrued })]
  );

  bus.emit('bond:updated', {
    bond_id,
    source: 'fineract',
    changes: { fineract_loan_id: loanId, accrued_interest: accrued },
  });

  return { loanId, accrued };
}

/**
 * Initialize listener — react to bond updates from other modules
 */
function init() {
  bus.on('bond:updated', async ({ bond_id, source }) => {
    if (source === 'fineract') return;
    try {
      await syncBondToFineract(bond_id);
      console.log(`[fineract-sync] synced bond ${bond_id}`);
    } catch (err) {
      console.error(`[fineract-sync] failed for ${bond_id}:`, err.message);
    }
  });
  console.log('[fineract-sync] listener initialized');
}

module.exports = { syncBondToFineract, init };

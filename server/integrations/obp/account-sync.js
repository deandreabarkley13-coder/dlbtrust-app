/**
 * OBP Account Sync
 * Creates Open Bank Project accounts for trust beneficiaries
 * and writes obp_account_id back to bond_master_records.
 */

'use strict';

const pool = require('../../db/postgres');
const bus  = require('../../event-bus');
const obp  = require('./client');

/**
 * Sync beneficiaries to OBP for a given bond
 */
async function syncBeneficiariesToOBP(bond_id) {
  const { rows: [bond] } = await pool.query(
    `SELECT b.*, t.beneficiary_ids
     FROM bond_master_records b
     LEFT JOIN trust_accounts t ON b.trust_account_id = t.id
     WHERE b.bond_id = $1`,
    [bond_id]
  );
  if (!bond) throw new Error(`Bond ${bond_id} not found`);

  const beneficiaries = bond.beneficiary_ids || [];
  let obpAccountId = bond.obp_account_id;

  for (const ben of beneficiaries) {
    try {
      const account = await obp.createAccount(
        typeof ben === 'string' ? { id: ben, name: ben } : ben
      );
      if (!obpAccountId) obpAccountId = account.id || account.account_id;
    } catch (err) {
      console.error(`[obp-sync] failed to create account for beneficiary:`, err.message);
    }
  }

  if (obpAccountId && obpAccountId !== bond.obp_account_id) {
    await pool.query(
      `UPDATE bond_master_records
       SET obp_account_id = $1, updated_at = now(), updated_by_module = 'obp'
       WHERE bond_id = $2`,
      [obpAccountId, bond_id]
    );

    await pool.query(
      `INSERT INTO bond_audit_log (bond_id, source, changes) VALUES ($1,'obp',$2)`,
      [bond_id, JSON.stringify({ obp_account_id: obpAccountId })]
    );

    bus.emit('bond:updated', {
      bond_id,
      source: 'obp',
      changes: { obp_account_id: obpAccountId },
    });
  }

  return { obpAccountId };
}

/**
 * Initialize listener
 */
function init() {
  bus.on('bond:updated', async ({ bond_id, source }) => {
    if (source === 'obp') return;
    try {
      await syncBeneficiariesToOBP(bond_id);
      console.log(`[obp-sync] synced bond ${bond_id}`);
    } catch (err) {
      console.error(`[obp-sync] failed for ${bond_id}:`, err.message);
    }
  });
  console.log('[obp-sync] listener initialized');
}

module.exports = { syncBeneficiariesToOBP, init };

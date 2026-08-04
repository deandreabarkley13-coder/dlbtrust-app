'use strict';
/**
 * One-time repair script for bonds that were incorrectly marked matured
 * and had their principal_balance reduced to zero by an early backfill.
 *
 * This script only acts on bond IDs explicitly listed in the BOND_IDS
 * environment variable (comma-separated), and only if the bond is not
 * actually matured (maturity_date > today) AND is marked 'matured' in the
 * database with a zeroed principal balance. This prevents accidentally
 * erasing legitimate principal repayment history.
 *
 * Example: BOND_IDS=bnd-abc123,bnd-def456 node server/scripts/repairBonds.js
 */

const { BondEngine } = require('../integrations/bonds/bondEngine');
const { LiveBondEngine } = require('../integrations/bonds/liveEngine');

async function repair() {
  const allowListRaw = (process.env.BOND_IDS || '').trim();
  if (!allowListRaw) {
    console.log('[repair] No BOND_IDS provided. Exiting without changes.');
    process.exit(0);
  }
  const allowList = new Set(allowListRaw.split(',').map(s => s.trim()).filter(Boolean));

  const bonds = await BondEngine.listBonds();
  const now = new Date();
  let repaired = 0;
  for (const bond of bonds) {
    if (!allowList.has(bond.id)) continue;

    const maturityDate = new Date(bond.maturity_date);
    const faceValue = parseFloat(bond.face_value || 0);
    const principalBalance = parseFloat(bond.principal_balance || 0);
    const totalPrincipalPaid = parseFloat(bond.total_principal_paid || 0);

    // Only repair bonds explicitly flagged as matured in the DB but whose end date is in the future,
    // and whose principal appears to have been fully paid off.
    if (maturityDate > now && bond.status === 'matured' && principalBalance <= 0 && totalPrincipalPaid >= faceValue) {
      console.log(`[repair] Repairing bond ${bond.id} (${bond.bond_name}): face=${faceValue}, principal=${principalBalance}, paid=${totalPrincipalPaid}`);
      const client = await require('../integrations/bonds/pgPool').connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE bond_balances
           SET principal_balance = $1, total_principal_paid = 0, updated_at = NOW()
           WHERE bond_id = $2`,
          [faceValue, bond.id]
        );
        await client.query(
          `UPDATE bonds SET status = 'active', updated_at = NOW() WHERE id = $1`,
          [bond.id]
        );
        await client.query('COMMIT');
        repaired++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Accrue any interest since the last accrual date using the restored principal
      try {
        const accrueResult = await BondEngine.accrueInterest(bond.id, now.toISOString().split('T')[0]);
        console.log(`[repair] Accrue result for ${bond.bond_name}:`, accrueResult);
      } catch (accErr) {
        console.warn(`[repair] Could not accrue ${bond.bond_name}: ${accErr.message}`);
      }

      const live = await LiveBondEngine.getBondLiveMetrics(bond.id);
      console.log(`[repair] Live metrics for ${bond.bond_name}: status=${live.status}, principal=${live.principal_balance}, accrued=${live.accrued_interest_total}, current_value=${live.total_current_value}`);
    } else {
      console.log(`[repair] Skipping bond ${bond.id} (${bond.bond_name}): does not meet repair criteria`);
    }
  }
  console.log(`[repair] Done. Repaired ${repaired} bond(s).`);
  process.exit(0);
}

repair().catch(err => {
  console.error('[repair] Fatal error:', err);
  process.exit(1);
});

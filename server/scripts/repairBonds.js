'use strict';
/**
 * One-time repair script for bonds that were incorrectly marked matured
 * and had their principal_balance reduced to zero by an early backfill.
 *
 * For any non-matured bond whose principal_balance is zero and total_principal_paid
 * equals (or exceeds) face_value, we reset the principal balance back to face_value,
 * clear the erroneous total_principal_paid, reactivate the bond, and accrue any
 * interest that has accumulated since the last accrual date.
 */

const { BondEngine } = require('../integrations/bonds/bondEngine');
const { LiveBondEngine } = require('../integrations/bonds/liveEngine');

async function repair() {
  const bonds = await BondEngine.listBonds();
  const now = new Date();
  for (const bond of bonds) {
    const maturityDate = new Date(bond.maturity_date);
    const faceValue = parseFloat(bond.face_value || 0);
    const principalBalance = parseFloat(bond.principal_balance || 0);
    const totalPrincipalPaid = parseFloat(bond.total_principal_paid || 0);

    // Repair bonds that are not actually matured but whose principal was paid off
    if (maturityDate > now && (principalBalance <= 0 || totalPrincipalPaid >= faceValue)) {
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
    }
  }
  console.log('[repair] Done');
  process.exit(0);
}

repair().catch(err => {
  console.error('[repair] Fatal error:', err);
  process.exit(1);
});

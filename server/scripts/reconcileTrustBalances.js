'use strict';

const pool = require('../integrations/bonds/pgPool');

async function deriveBalances(db = pool) {
  const result = await db.query(
    `SELECT ta.account_code, ta.account_name, ta.account_type, ta.balance AS stored_balance,
            COALESCE(SUM(
              CASE WHEN je.entry_id IS NOT NULL AND ta.account_type IN ('asset', 'expense')
                THEN jl.debit_amount - jl.credit_amount
                WHEN je.entry_id IS NOT NULL THEN jl.credit_amount - jl.debit_amount
                ELSE 0
              END
            ), 0) AS derived_balance
     FROM trust_accounts ta
     LEFT JOIN trust_journal_lines jl ON jl.account_code = ta.account_code
     LEFT JOIN trust_journal_entries je ON je.entry_id = jl.entry_id AND je.status = 'posted'
     GROUP BY ta.account_code, ta.account_name, ta.account_type, ta.balance
     ORDER BY ta.account_code`
  );
  return result.rows.map((row) => {
    const storedBalance = Number(row.stored_balance || 0);
    const derivedBalance = Number(row.derived_balance || 0);
    return {
      account_code: row.account_code,
      account_name: row.account_name,
      account_type: row.account_type,
      stored_balance: storedBalance,
      derived_balance: derivedBalance,
      drift: derivedBalance - storedBalance,
    };
  });
}

async function reconcileTrustBalances({ apply = false, db = pool } = {}) {
  const balances = await deriveBalances(db);
  const changed = balances.filter((row) => Math.abs(row.drift) > 0.005);
  if (!apply) return { apply: false, changed: false, balances, drift: changed };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const row of changed) {
      await client.query(
        `UPDATE trust_accounts SET balance = $1, updated_at = NOW() WHERE account_code = $2`,
        [row.derived_balance, row.account_code]
      );
    }
    await client.query(
      `INSERT INTO admin_audit_log
       (admin_user, action, resource_type, resource_id, payload, result)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        'reconcileTrustBalances',
        'apply-derived-balances',
        'trust_accounts',
        'all',
        JSON.stringify({ apply: true }),
        JSON.stringify({ changed }),
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* no active transaction */ }
    throw err;
  } finally {
    client.release();
  }
  return { apply: true, changed: changed.length > 0, balances, drift: changed, applied: changed };
}

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function main() {
  const result = await reconcileTrustBalances(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`reconcileTrustBalances failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { deriveBalances, reconcileTrustBalances, parseArgs };

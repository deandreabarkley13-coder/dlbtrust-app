'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// GET /api/treasury/distributions/schedules — List distribution schedules
router.get('/schedules', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const schedules = await db.queryAll(`
      SELECT ds.*,
        (SELECT COUNT(*) FROM distribution_rules dr WHERE dr.schedule_id = ds.id) as rule_count,
        w.name as source_wallet_name
      FROM distribution_schedules ds
      LEFT JOIN wallets w ON w.id = ds.source_wallet_id
      WHERE ds.trust_id = $1
      ORDER BY ds.next_distribution
    `, [trust.id]);
    res.json({ success: true, data: schedules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/distributions/schedules — Create a distribution schedule
router.post('/schedules', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { name, frequency, distribution_basis, source_wallet_id, day_of_month, requires_approval, approval_threshold } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const schedule = await db.queryOne(`
      INSERT INTO distribution_schedules (trust_id, name, frequency, distribution_basis, source_wallet_id, day_of_month, requires_approval, approval_threshold, next_distribution)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      trust.id, name, frequency || 'monthly', distribution_basis || 'fixed',
      source_wallet_id, day_of_month || 1, requires_approval !== false,
      approval_threshold || 100000,
      calculateNextDistribution(frequency || 'monthly', day_of_month || 1),
    ]);

    res.status(201).json({ success: true, data: schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/distributions/schedules/:id/rules — Add a rule to a schedule
router.post('/schedules/:id/rules', async (req, res) => {
  try {
    const { beneficiary_id, allocation_type, fixed_amount, percentage, payment_method, bank_account_id, tax_withholding_pct } = req.body;
    if (!beneficiary_id) return res.status(400).json({ error: 'beneficiary_id is required' });

    const rule = await db.queryOne(`
      INSERT INTO distribution_rules (schedule_id, beneficiary_id, allocation_type, fixed_amount, percentage, payment_method, bank_account_id, tax_withholding_pct)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [req.params.id, beneficiary_id, allocation_type || 'fixed', fixed_amount || 0, percentage || 0, payment_method || 'ach', bank_account_id, tax_withholding_pct || 0]);

    res.status(201).json({ success: true, data: rule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/treasury/distributions — List executed distributions
router.get('/', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { status, limit } = req.query;
    let sql = 'SELECT * FROM distributions WHERE trust_id = $1';
    const params = [trust.id];

    if (status) {
      sql += ' AND status = $2';
      params.push(status);
    }
    sql += ' ORDER BY distribution_date DESC';
    if (limit) sql += ` LIMIT ${parseInt(limit)}`;

    const distributions = await db.queryAll(sql, params);
    res.json({ success: true, data: distributions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/distributions/execute — Execute a distribution (create payments for all beneficiaries)
router.post('/execute', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { schedule_id, distribution_date, notes } = req.body;
    if (!schedule_id) return res.status(400).json({ error: 'schedule_id is required' });

    const schedule = await db.queryOne('SELECT * FROM distribution_schedules WHERE id = $1', [schedule_id]);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

    const rules = await db.queryAll('SELECT * FROM distribution_rules WHERE schedule_id = $1 AND status = $2', [schedule_id, 'active']);
    if (rules.length === 0) return res.status(400).json({ error: 'No active distribution rules for this schedule' });

    // Calculate distribution amounts
    let totalGross = 0;
    let totalTax = 0;
    const paymentItems = [];

    for (const rule of rules) {
      let grossAmount = 0;
      if (rule.allocation_type === 'fixed') {
        grossAmount = rule.fixed_amount;
      } else if (rule.allocation_type === 'percentage') {
        // Percentage of available income
        const incomeWallet = await db.queryOne("SELECT balance FROM wallets WHERE trust_id = $1 AND wallet_type = 'income'", [trust.id]);
        grossAmount = Math.round((incomeWallet?.balance || 0) * rule.percentage / 100);
      }

      const taxWithheld = Math.round(grossAmount * (rule.tax_withholding_pct || 0) / 100);
      const netAmount = grossAmount - taxWithheld;

      paymentItems.push({
        beneficiary_id: rule.beneficiary_id,
        bank_account_id: rule.bank_account_id,
        gross_amount: grossAmount,
        tax_withheld: taxWithheld,
        net_amount: netAmount,
        payment_method: rule.payment_method,
      });

      totalGross += grossAmount;
      totalTax += taxWithheld;
    }

    // Check source wallet has sufficient funds
    if (schedule.source_wallet_id) {
      const sourceWallet = await db.queryOne('SELECT balance FROM wallets WHERE id = $1', [schedule.source_wallet_id]);
      if (sourceWallet && sourceWallet.balance < totalGross) {
        return res.status(400).json({ error: 'Insufficient funds in source wallet', available: sourceWallet.balance, required: totalGross });
      }
    }

    // Create distribution and payment records in a transaction
    const result = await db.transaction(async (client) => {
      // Create distribution record
      const { rows: [dist] } = await client.query(`
        INSERT INTO distributions (trust_id, schedule_id, distribution_date, total_amount, net_amount, tax_withheld, status, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [trust.id, schedule_id, distribution_date || new Date().toISOString().split('T')[0], totalGross, totalGross - totalTax, totalTax, schedule.requires_approval ? 'pending' : 'approved', notes]);

      // Create individual payment records
      const payments = [];
      for (const item of paymentItems) {
        const { rows: [payment] } = await client.query(`
          INSERT INTO distribution_payments (distribution_id, beneficiary_id, bank_account_id, gross_amount, tax_withheld, net_amount, payment_method, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `, [dist.id, item.beneficiary_id, item.bank_account_id, item.gross_amount, item.tax_withheld, item.net_amount, item.payment_method, schedule.requires_approval ? 'pending' : 'approved']);
        payments.push(payment);
      }

      // If auto-approved, debit source wallet
      if (!schedule.requires_approval && schedule.source_wallet_id) {
        await client.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [totalGross, schedule.source_wallet_id]);
      }

      // Update schedule
      await client.query(`
        UPDATE distribution_schedules SET last_distribution = $1, next_distribution = $2, total_distributed = total_distributed + $3, updated_at = NOW()
        WHERE id = $4
      `, [distribution_date || new Date().toISOString().split('T')[0], calculateNextDistribution(schedule.frequency, schedule.day_of_month), totalGross, schedule_id]);

      // Audit
      await client.query(`
        INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
        VALUES ($1, 'trustee', 'distribution_executed', 'distribution', $2, $3)
      `, [trust.id, dist.id, JSON.stringify({ total: totalGross, payments: payments.length })]);

      return { distribution: dist, payments };
    });

    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/distributions/:id/approve — Approve a pending distribution
router.post('/:id/approve', async (req, res) => {
  try {
    const { approved_by } = req.body;
    const dist = await db.queryOne('SELECT * FROM distributions WHERE id = $1', [req.params.id]);
    if (!dist) return res.status(404).json({ error: 'Distribution not found' });
    if (dist.status !== 'pending') return res.status(400).json({ error: `Cannot approve distribution in "${dist.status}" status` });

    await db.transaction(async (client) => {
      await client.query(`
        UPDATE distributions SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2
      `, [approved_by || 'trustee', dist.id]);

      await client.query(`
        UPDATE distribution_payments SET status = 'approved' WHERE distribution_id = $1 AND status = 'pending'
      `, [dist.id]);

      // Debit source wallet
      const schedule = await db.queryOne('SELECT source_wallet_id FROM distribution_schedules WHERE id = $1', [dist.schedule_id]);
      if (schedule?.source_wallet_id) {
        await client.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [dist.total_amount, schedule.source_wallet_id]);
      }

      // Create approval record
      await client.query(`
        INSERT INTO approvals (trust_id, entity_type, entity_id, approved_by, status, decided_at)
        VALUES ($1, 'distribution', $2, $3, 'approved', NOW())
      `, [dist.trust_id, dist.id, approved_by || 'trustee']);
    });

    res.json({ success: true, message: 'Distribution approved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function calculateNextDistribution(frequency, dayOfMonth) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), dayOfMonth || 1);
  if (next <= now) next.setMonth(next.getMonth() + 1);

  const freqMap = { weekly: 0, bi_weekly: 0, monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };
  const addMonths = frequency in freqMap ? freqMap[frequency] : 1;
  if (addMonths === 0) {
    const addDays = frequency === 'weekly' ? 7 : 14;
    next.setDate(next.getDate() + addDays);
  } else {
    next.setMonth(next.getMonth() + addMonths - 1);
  }
  return next.toISOString().split('T')[0];
}

module.exports = router;

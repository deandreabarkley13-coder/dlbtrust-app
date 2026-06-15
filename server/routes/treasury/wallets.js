'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// GET /api/treasury/wallets — All wallets with balances
router.get('/', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const wallets = await db.queryAll(`
      SELECT * FROM wallets WHERE trust_id = $1 ORDER BY wallet_type, name
    `, [trust.id]);
    res.json({ success: true, data: wallets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/wallets/transfer — Internal wallet-to-wallet transfer
router.post('/transfer', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
    const { from_wallet_id, to_wallet_id, amount, description } = req.body;

    if (!from_wallet_id || !to_wallet_id || !amount) {
      return res.status(400).json({ error: 'from_wallet_id, to_wallet_id, and amount are required' });
    }
    const amountCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }

    const fromWallet = await db.queryOne('SELECT * FROM wallets WHERE id = $1', [from_wallet_id]);
    const toWallet = await db.queryOne('SELECT * FROM wallets WHERE id = $1', [to_wallet_id]);
    if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
    if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
    if (fromWallet.balance < amountCents) {
      return res.status(400).json({ error: 'Insufficient funds', available: fromWallet.balance, requested: amountCents });
    }

    await db.transaction(async (client) => {
      // Lock source wallet row to prevent concurrent overdrafts
      const { rows: [locked] } = await client.query('SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [from_wallet_id]);
      if (locked.balance < amountCents) {
        throw new Error('Insufficient funds (concurrent request detected)');
      }
      await client.query('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2', [amountCents, from_wallet_id]);
      await client.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2', [amountCents, to_wallet_id]);

      await client.query(`
        INSERT INTO ledger_entries (trust_id, entry_date, entry_type, debit_wallet_id, credit_wallet_id, amount, description, status, posted_by)
        VALUES ($1, CURRENT_DATE, 'transfer', $2, $3, $4, $5, 'posted', 'trustee')
      `, [trust.id, from_wallet_id, to_wallet_id, amountCents, description || `Transfer: ${fromWallet.name} → ${toWallet.name}`]);

      await client.query(`
        INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
        VALUES ($1, 'trustee', 'wallet_transfer', 'wallet', $2, $3)
      `, [trust.id, from_wallet_id, JSON.stringify({ from: fromWallet.wallet_code, to: toWallet.wallet_code, amount: amountCents })]);
    });

    const updatedFrom = await db.queryOne('SELECT * FROM wallets WHERE id = $1', [from_wallet_id]);
    const updatedTo = await db.queryOne('SELECT * FROM wallets WHERE id = $1', [to_wallet_id]);

    res.json({
      success: true,
      message: 'Transfer completed',
      from_wallet: { id: updatedFrom.id, name: updatedFrom.name, balance: updatedFrom.balance },
      to_wallet: { id: updatedTo.id, name: updatedTo.name, balance: updatedTo.balance },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

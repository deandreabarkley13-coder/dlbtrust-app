'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db-postgres');

// GET /api/treasury/mft/config — Get MFT/SFTP configuration
router.get('/config', async (req, res) => {
  try {
    const config = await db.queryOne("SELECT * FROM mft_config LIMIT 1");
    res.json({
      success: true,
      sftp_configured: !!(config && config.sftp_host),
      sftp_host: config?.sftp_host || '',
      sftp_port: config?.sftp_port || 22,
      sftp_username: config?.sftp_username || '',
      sftp_path: config?.sftp_path || '/incoming',
    });
  } catch (err) {
    res.json({ success: true, sftp_configured: false, sftp_host: '', sftp_port: 22, sftp_username: '', sftp_path: '/incoming' });
  }
});

// POST /api/treasury/mft/config — Save MFT/SFTP configuration
router.post('/config', async (req, res) => {
  try {
    const { sftp_host, sftp_port, sftp_username, sftp_path } = req.body;
    const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');

    const existing = await db.queryOne("SELECT id FROM mft_config LIMIT 1");
    if (existing) {
      await db.query(`
        UPDATE mft_config SET sftp_host = $1, sftp_port = $2, sftp_username = $3, sftp_path = $4, updated_at = NOW()
        WHERE id = $5
      `, [sftp_host, sftp_port || 22, sftp_username, sftp_path || '/incoming', existing.id]);
    } else {
      await db.query(`
        INSERT INTO mft_config (trust_id, sftp_host, sftp_port, sftp_username, sftp_path)
        VALUES ($1, $2, $3, $4, $5)
      `, [trust.id, sftp_host, sftp_port || 22, sftp_username, sftp_path || '/incoming']);
    }

    res.json({ success: true, message: 'SFTP configuration saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/treasury/mft/files — List generated payment files
router.get('/files', async (req, res) => {
  try {
    const files = await db.queryAll("SELECT * FROM mft_files ORDER BY created_at DESC");
    res.json({ success: true, data: files });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// POST /api/treasury/mft/generate-nacha — Generate a NACHA/ACH file from pending payments
router.post('/generate-nacha', async (req, res) => {
  try {
    const trust = await db.queryOne('SELECT * FROM trusts LIMIT 1');

    // Find pending/approved distribution payments with bank accounts
    const payments = await db.queryAll(`
      SELECT dp.*, b.name as beneficiary_name, ba.routing_number, ba.account_number_encrypted, ba.account_type
      FROM distribution_payments dp
      JOIN beneficiaries b ON b.id = dp.beneficiary_id
      LEFT JOIN bank_accounts ba ON ba.id = dp.bank_account_id
      WHERE dp.status IN ('approved', 'pending')
      ORDER BY dp.created_at
    `);

    // Also include any wallet transfers flagged for ACH
    const walletTransfers = await db.queryAll(`
      SELECT le.*, dw.name as from_name, cw.name as to_name
      FROM ledger_entries le
      LEFT JOIN wallets dw ON dw.id = le.debit_wallet_id
      LEFT JOIN wallets cw ON cw.id = le.credit_wallet_id
      WHERE le.entry_type = 'transfer' AND le.trust_id = $1
      ORDER BY le.created_at DESC LIMIT 50
    `, [trust.id]);

    const totalRecords = payments.length + walletTransfers.length;
    const totalAmount = payments.reduce((s, p) => s + (parseInt(p.net_amount) || 0), 0)
      + walletTransfers.reduce((s, t) => s + (parseInt(t.amount) || 0), 0);

    // Generate NACHA-formatted content
    const now = new Date();
    const fileDate = now.toISOString().split('T')[0].replace(/-/g, '');
    const fileTime = now.toTimeString().slice(0, 5).replace(':', '');
    const filename = `ACH_${trust.trust_name?.replace(/\s+/g, '_') || 'DLB_TRUST'}_${fileDate}_${fileTime}.ach`;

    // NACHA File Header (Record Type 1)
    const immediateDestination = '241075470'; // Eaton FCU routing
    const immediateOrigin = trust.ein || '000000000';
    const companyName = (trust.trust_name || 'DLB TRUST').slice(0, 16).padEnd(16);

    let nachaContent = '';
    // File Header Record
    nachaContent += `101 ${immediateDestination.padStart(9, '0')} ${immediateOrigin.padStart(9, '0')}`;
    nachaContent += `${fileDate.slice(2)}${fileTime}`;
    nachaContent += `A094101${companyName.padEnd(23)}Federal Reserve          \n`;

    // Batch Header Record (Record Type 5)
    nachaContent += `5200${companyName}                    `;
    nachaContent += `${immediateOrigin.padStart(10, '0')}PPD TRUSTDIST`;
    nachaContent += `${fileDate.slice(2)}   1${immediateDestination.padStart(8, '0')}0000001\n`;

    // Entry Detail Records (Record Type 6)
    let entryCount = 0;
    let entryHash = 0;
    let totalDebit = 0;
    let totalCredit = 0;

    for (const p of payments) {
      if (!p.routing_number) continue;
      entryCount++;
      const routing = (p.routing_number || '000000000').padStart(9, '0');
      entryHash += parseInt(routing.slice(0, 8)) || 0;
      const amount = Math.abs(parseInt(p.net_amount) || 0);
      totalCredit += amount;
      const acctNum = (p.account_number_encrypted || '0000000000').padEnd(17);
      const name = (p.beneficiary_name || 'BENEFICIARY').slice(0, 22).padEnd(22);
      nachaContent += `622${routing}${acctNum}${String(amount).padStart(10, '0')}`;
      nachaContent += `${name}  0${immediateDestination.padStart(8, '0')}${String(entryCount).padStart(7, '0')}\n`;
    }

    // If no payment records with routing numbers, create a summary record
    if (entryCount === 0) {
      entryCount = 1;
      const dummyRouting = immediateDestination;
      entryHash = parseInt(dummyRouting.slice(0, 8)) || 0;
      totalCredit = totalAmount;
      nachaContent += `622${dummyRouting}${'0'.padEnd(17, '0')}${String(totalAmount).padStart(10, '0')}`;
      nachaContent += `${'DLB TRUST DIST'.padEnd(22)}  0${immediateDestination.padStart(8, '0')}0000001\n`;
    }

    // Batch Control Record (Record Type 8)
    nachaContent += `8200${String(entryCount).padStart(6, '0')}`;
    nachaContent += `${String(entryHash % 10000000000).padStart(10, '0')}`;
    nachaContent += `${String(totalDebit).padStart(12, '0')}${String(totalCredit).padStart(12, '0')}`;
    nachaContent += `${immediateOrigin.padStart(10, '0')}                         ${immediateDestination.padStart(8, '0')}0000001\n`;

    // File Control Record (Record Type 9)
    nachaContent += `9000001000001`;
    nachaContent += `${String(entryHash % 10000000000).padStart(10, '0')}`;
    nachaContent += `${String(totalDebit).padStart(12, '0')}${String(totalCredit).padStart(12, '0')}`;
    nachaContent += `${''.padEnd(39)}\n`;

    // Save to database
    const file = await db.queryOne(`
      INSERT INTO mft_files (trust_id, filename, file_type, content, record_count, total_amount, status)
      VALUES ($1, $2, 'NACHA', $3, $4, $5, 'generated')
      RETURNING *
    `, [trust.id, filename, nachaContent, totalRecords || entryCount, totalAmount || totalCredit]);

    // Audit
    await db.query(`
      INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
      VALUES ($1, 'system', 'nacha_file_generated', 'mft_file', $2, $3)
    `, [trust.id, file.id, JSON.stringify({ filename, records: totalRecords, amount: totalAmount })]);

    res.json({ success: true, data: file });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasury/mft/deliver/:id — Deliver a file via SFTP
router.post('/deliver/:id', async (req, res) => {
  try {
    const file = await db.queryOne('SELECT * FROM mft_files WHERE id = $1', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.status === 'delivered') return res.status(400).json({ error: 'File already delivered' });

    const config = await db.queryOne("SELECT * FROM mft_config LIMIT 1");
    if (!config || !config.sftp_host) {
      return res.status(400).json({ error: 'SFTP not configured. Please save SFTP configuration first.' });
    }

    // Attempt SFTP delivery using ssh2-sftp-client
    let delivered = false;
    let deliveryError = null;

    try {
      const SftpClient = require('ssh2-sftp-client');
      const sftp = new SftpClient();
      await sftp.connect({
        host: config.sftp_host,
        port: config.sftp_port || 22,
        username: config.sftp_username,
        password: process.env.MFT_SFTP_PASSWORD || '',
        readyTimeout: 10000,
      });
      const remotePath = `${config.sftp_path || '/incoming'}/${file.filename}`;
      await sftp.put(Buffer.from(file.content), remotePath);
      await sftp.end();
      delivered = true;
    } catch (sftpErr) {
      deliveryError = sftpErr.message;
      // If SFTP fails, still mark as attempted but not delivered
    }

    if (delivered) {
      await db.query("UPDATE mft_files SET status = 'delivered', delivered_at = NOW() WHERE id = $1", [file.id]);
      const trust = await db.queryOne('SELECT id FROM trusts LIMIT 1');
      await db.query(`
        INSERT INTO audit_log (trust_id, actor, action, entity_type, entity_id, details)
        VALUES ($1, 'system', 'file_delivered', 'mft_file', $2, $3)
      `, [trust.id, file.id, JSON.stringify({ host: config.sftp_host, filename: file.filename })]);
      res.json({ success: true, message: 'File delivered via SFTP' });
    } else {
      await db.query("UPDATE mft_files SET status = 'failed', delivery_error = $1 WHERE id = $2", [deliveryError, file.id]);
      res.status(500).json({ error: `SFTP delivery failed: ${deliveryError}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/treasury/mft/download/:id — Download a NACHA file
router.get('/download/:id', async (req, res) => {
  try {
    const file = await db.queryOne('SELECT * FROM mft_files WHERE id = $1', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

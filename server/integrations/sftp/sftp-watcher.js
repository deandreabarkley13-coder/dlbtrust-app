/**
 * Bank SFTP Watcher
 * Polls /inbound/returns/ every 5 minutes for bank return files.
 * Parses NACHA return codes and updates bond_master_records.
 */

'use strict';

const SFTPClient = require('ssh2-sftp-client');
const pool       = require('../../db/postgres');
const bus        = require('../../event-bus');

const SFTP_HOST     = process.env.SFTP_HOST || '';
const SFTP_USER     = process.env.SFTP_USER || '';
const SFTP_KEY_PATH = process.env.SFTP_KEY_PATH || '';
const SFTP_INBOUND  = process.env.SFTP_INBOUND || '/inbound/returns/';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const processedFiles = new Set();

let pollTimer = null;

async function pollReturns() {
  if (!SFTP_HOST || !SFTP_USER) return;

  const sftp = new SFTPClient();
  try {
    const connectOpts = {
      host: SFTP_HOST,
      username: SFTP_USER,
    };

    if (SFTP_KEY_PATH) {
      const fs = require('fs');
      connectOpts.privateKey = fs.readFileSync(SFTP_KEY_PATH);
    }

    await sftp.connect(connectOpts);
    const fileList = await sftp.list(SFTP_INBOUND);

    for (const file of fileList) {
      if (processedFiles.has(file.name)) continue;
      if (file.type !== '-') continue; // skip directories

      try {
        const remotePath = `${SFTP_INBOUND}${file.name}`;
        const content = await sftp.get(remotePath);
        const text = content.toString('utf8');

        // Parse NACHA return: look for return entries (record type 6, addenda type 99)
        const returnCodes = [];
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.length >= 94 && line[0] === '7' && line.substring(1, 3) === '99') {
            returnCodes.push({
              return_code: line.substring(3, 6),
              original_trace: line.substring(6, 21).trim(),
            });
          }
        }

        // Match returns to bonds via original_trace stored in last_sftp_file
        // Only update bonds whose last_sftp_file contains a matching trace number
        if (returnCodes.length > 0) {
          const traces = returnCodes.map(r => r.original_trace).filter(Boolean);
          if (traces.length > 0) {
            // Find bonds whose last_sftp_file contains one of the returned trace numbers
            const placeholders = traces.map((_, i) => `$${i + 1}`).join(', ');
            const { rows: bonds } = await pool.query(
              `SELECT bond_id FROM bond_master_records
               WHERE last_sftp_file = ANY($1::text[])`,
              [traces]
            );

            for (const bond of bonds) {
              await pool.query(
                `UPDATE bond_master_records
                 SET last_sftp_file = $1, updated_at = now(), updated_by_module = 'sftp'
                 WHERE bond_id = $2`,
                [file.name, bond.bond_id]
              );
              await pool.query(
                `INSERT INTO bond_audit_log (bond_id, source, changes) VALUES ($1,'sftp',$2)`,
                [bond.bond_id, JSON.stringify({ last_sftp_file: file.name, return_codes: returnCodes })]
              );
              bus.emit('bond:updated', {
                bond_id: bond.bond_id,
                source: 'sftp',
                changes: { last_sftp_file: file.name, return_codes: returnCodes },
              });
            }

            if (bonds.length === 0) {
              console.warn(`[sftp-watcher] return file ${file.name}: no matching bonds for traces ${traces.join(', ')}`);
            }
          }
        }

        processedFiles.add(file.name);
        console.log(`[sftp-watcher] processed return file: ${file.name} (${returnCodes.length} returns)`);
      } catch (fileErr) {
        console.error(`[sftp-watcher] error processing ${file.name}:`, fileErr.message);
      }
    }
  } catch (err) {
    console.error('[sftp-watcher] poll error:', err.message);
  } finally {
    await sftp.end();
  }
}

function start() {
  if (!SFTP_HOST || !SFTP_USER) {
    console.log('[sftp-watcher] SFTP not configured, watcher disabled');
    return;
  }
  console.log('[sftp-watcher] starting, polling every 5 minutes');
  pollReturns();
  pollTimer = setInterval(pollReturns, POLL_INTERVAL);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = { start, stop };

/**
 * Bank SFTP Uploader
 * Pushes NACHA ACH files to the bank's SFTP /outbound/ directory.
 */

'use strict';

const SFTPClient = require('ssh2-sftp-client');

const SFTP_HOST     = process.env.SFTP_HOST || '';
const SFTP_USER     = process.env.SFTP_USER || '';
const SFTP_KEY_PATH = process.env.SFTP_KEY_PATH || '';
const SFTP_OUTBOUND = process.env.SFTP_OUTBOUND || '/outbound/ach/';

/**
 * Upload a NACHA file to the bank SFTP outbound directory
 */
async function uploadNACHAFile(filePath) {
  if (!SFTP_HOST || !SFTP_USER) {
    console.warn('[sftp-uploader] SFTP not configured, skipping upload');
    return { success: false, reason: 'SFTP not configured' };
  }

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

    const path = require('path');
    const remotePath = `${SFTP_OUTBOUND}${path.basename(filePath)}`;
    await sftp.put(filePath, remotePath);

    console.log(`[sftp-uploader] uploaded ${filePath} -> ${remotePath}`);
    return { success: true, remotePath };
  } finally {
    await sftp.end();
  }
}

module.exports = { uploadNACHAFile };

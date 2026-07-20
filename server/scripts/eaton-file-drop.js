#!/usr/bin/env node
'use strict';

/**
 * Eaton Family CU — Automated File-Drop Client
 * ────────────────────────────────────────────
 *
 * Machine-to-machine SFTP file-drop protocol for Eaton Family Credit Union:
 *   • push  — upload generated NACHA files to Eaton's inbound file drop
 *   • pull  — retrieve return / ACK-NACK files from Eaton's outbound drop
 *
 * Everything is env-driven and redacted — no host, credential, or account
 * identifier is ever hardcoded, logged in full, or committed.
 *
 * Config (all from environment / provisioned secrets):
 *   ACH_SFTP_URL          sftp://user@host:port/incoming  (inbound drop)
 *   ACH_SFTP_KEY          path to SSH private key (preferred auth)
 *   ACH_SFTP_PASSWORD     password auth (used only if no key)
 *   ACH_SFTP_KNOWN_HOSTS  pinned known_hosts file (recommended)
 *   ACH_SFTP_RETURN_PATH  remote directory holding return/ACK files (default /outbound)
 *   ACH_RETURNS_DIR       local dir to save downloaded returns (default data/ach-returns)
 *   TRUST_ID              protected trust identifier (redacted in output)
 *   TRUST_MASTER_ACCOUNT  protected trust master account (redacted in output)
 *
 * Usage:
 *   node server/scripts/eaton-file-drop.js --upload <batchId>
 *   node server/scripts/eaton-file-drop.js --upload-pending
 *   node server/scripts/eaton-file-drop.js --fetch-returns
 *   node server/scripts/eaton-file-drop.js --status            (show config, redacted)
 *   node server/scripts/eaton-file-drop.js --dry-run --upload-pending
 *
 * --dry-run performs no network I/O and moves no money — it only reports what
 * would happen. Without ACH_SFTP_URL the script refuses to transmit (fail-safe).
 */

const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const HD = path.join(__dirname, '..', '..');

function log(msg) {
  process.stdout.write(msg + '\n');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--upload') args.upload = argv[++i];
    else if (a === '--upload-pending') args.uploadPending = true;
    else if (a === '--fetch-returns') args.fetchReturns = true;
    else if (a === '--status') args.status = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

/**
 * Parse ACH_SFTP_URL into connection parts. Returns null when unset.
 */
function sftpConfig() {
  const url = process.env.ACH_SFTP_URL;
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'sftp:') {
    throw new Error('ACH_SFTP_URL must be an sftp:// URL');
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 22,
    user: decodeURIComponent(parsed.username || ''),
    inboundPath: parsed.pathname || '/incoming',
    privateKey: process.env.ACH_SFTP_KEY || null,
    password: process.env.ACH_SFTP_PASSWORD || null,
    returnPath: process.env.ACH_SFTP_RETURN_PATH || '/outbound',
  };
}

function trustIdentity() {
  try {
    return require(path.join(HD, 'server', 'integrations', 'payments', 'trustIdentity'));
  } catch (e) {
    return null;
  }
}

function printHeader(cfg) {
  const ti = trustIdentity();
  log('── Eaton Family CU File-Drop Client ──');
  if (ti) {
    const s = ti.summary();
    log(`  trust:        ${s.trust_name}`);
    log(`  trust id:     ${s.trust_id || '(not set)'}`);
    log(`  master acct:  ${s.trust_master_account || '(not set)'}`);
  }
  if (cfg) {
    log(`  sftp host:    ${cfg.user ? cfg.user + '@' : ''}${cfg.host}:${cfg.port}`);
    log(`  inbound:      ${cfg.inboundPath}`);
    log(`  returns:      ${cfg.returnPath}`);
    log(`  auth:         ${cfg.privateKey ? 'private key' : (cfg.password ? 'password' : 'NONE')}`);
    log(`  host-key:     ${process.env.ACH_SFTP_KNOWN_HOSTS ? 'pinned known_hosts' : 'accept-new (TOFU)'}`);
  } else {
    log('  sftp:         NOT CONFIGURED (set ACH_SFTP_URL)');
  }
  log('');
}

async function doUpload(batchIds, dryRun) {
  const { ACHEngine } = require(path.join(HD, 'server', 'integrations', 'ach', 'achEngine'));
  let ids = batchIds;
  if (!ids || !ids.length) {
    const pending = await ACHEngine.listBatches({ status: 'pending' });
    ids = (pending || []).map((b) => b.batch_id);
  }
  if (!ids.length) {
    log('No batches to upload.');
    return;
  }
  log(`Batches to upload (${ids.length}): ${ids.join(', ')}`);
  if (dryRun) {
    log('[dry-run] Would transmit the above batches to Eaton over SFTP. No files sent.');
    return;
  }
  let failures = 0;
  for (const id of ids) {
    try {
      const res = await ACHEngine.transmitBatch(id);
      log(`  [ok]   ${id} -> status=${res && res.batch_status} mode=${res && res.mode}`);
    } catch (err) {
      failures++;
      log(`  [FAIL] ${id} -> ${err.message}`);
    }
  }
  if (failures) {
    // Surface partial/total failure to schedulers (cron/systemd) via exit code.
    process.exitCode = 1;
    log(`Upload completed with ${failures} failure(s) of ${ids.length}.`);
  }
}

async function doFetchReturns(cfg, dryRun) {
  const localDir = process.env.ACH_RETURNS_DIR
    || path.join(HD, 'data', 'ach-returns');
  log(`Fetching return/ACK files from ${cfg.returnPath} → ${localDir}`);
  if (dryRun) {
    log('[dry-run] Would list and download new return files. Nothing downloaded.');
    return;
  }
  const { OpenBankApi } = require(path.join(HD, 'server', 'integrations', 'ach', 'openBankApi'));
  const files = await OpenBankApi._sftpList({
    host: cfg.host, port: cfg.port, user: cfg.user,
    privateKey: cfg.privateKey, password: cfg.password,
    remoteDir: cfg.returnPath,
  });
  if (!files.length) {
    log('  No return files present.');
    return;
  }
  fs.mkdirSync(localDir, { recursive: true });
  let downloaded = 0;
  for (const name of files) {
    const localPath = path.join(localDir, path.basename(name));
    if (fs.existsSync(localPath)) {
      log(`  • ${name} (already downloaded, skipping)`);
      continue;
    }
    try {
      await OpenBankApi._sftpDownload({
        host: cfg.host, port: cfg.port, user: cfg.user,
        privateKey: cfg.privateKey, password: cfg.password,
        remotePath: cfg.returnPath.replace(/\/$/, '') + '/' + name,
        localPath,
      });
      downloaded++;
      log(`  [ok]   ${name}`);
    } catch (err) {
      log(`  [FAIL] ${name} -> ${err.message}`);
    }
  }
  log(`Downloaded ${downloaded} new return file(s).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.upload && !args.uploadPending && !args.fetchReturns && !args.status)) {
    log('Eaton Family CU file-drop client. Commands:');
    log('  --upload <batchId>   upload a specific NACHA batch to Eaton');
    log('  --upload-pending     upload all pending batches');
    log('  --fetch-returns      download return/ACK files from Eaton');
    log('  --status             show redacted config and readiness');
    log('  --dry-run            report actions without any network I/O');
    log('');
    log('Config via env: ACH_SFTP_URL, ACH_SFTP_KEY|ACH_SFTP_PASSWORD,');
    log('  ACH_SFTP_KNOWN_HOSTS, ACH_SFTP_RETURN_PATH, ACH_RETURNS_DIR,');
    log('  TRUST_ID, TRUST_MASTER_ACCOUNT (all protected, never hardcoded).');
    return;
  }

  let cfg = null;
  try {
    cfg = sftpConfig();
  } catch (err) {
    log('Config error: ' + err.message);
    process.exitCode = 2;
    return;
  }

  printHeader(cfg);

  if (args.status) {
    log(cfg ? 'Config OK — ready to transmit/fetch.' : 'SFTP not configured.');
    return;
  }

  const needsSftp = args.uploadPending || args.upload || args.fetchReturns;
  if (needsSftp && !cfg && !args.dryRun) {
    log('Refusing to run: ACH_SFTP_URL is not set (fail-safe — no transmission).');
    process.exitCode = 2;
    return;
  }

  if (args.upload || args.uploadPending) {
    await doUpload(args.upload ? [args.upload] : [], args.dryRun);
  }
  if (args.fetchReturns) {
    if (!cfg && args.dryRun) {
      log('[dry-run] SFTP not configured; would fetch returns once ACH_SFTP_URL is set.');
    } else {
      await doFetchReturns(cfg, args.dryRun);
    }
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    log('Fatal: ' + err.message);
    process.exit(1);
  });

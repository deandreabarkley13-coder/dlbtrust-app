#!/usr/bin/env node
'use strict';

/**
 * Move a governance document off the instance volume into shared document
 * storage, as an AES-256-GCM envelope, and print the URI to configure.
 *
 * Usage:
 *   node server/scripts/storeGovernanceDocument.js <file> [--id <document id>] [--confirm]
 *
 * Without --confirm this only reports the content hash and the storage that
 * would be used. With --confirm the document is sealed, pinned, read back and
 * its plaintext hash re-checked before the URI is printed; put that URI in
 * TRUST_SIGNATURE_DOCUMENT_URI. The source file is never modified or deleted.
 */

const fs = require('fs');
const path = require('path');
const { DocumentStorageAdapter } = require('../integrations/documents/storageAdapter');

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const idFlag = argv.indexOf('--id');
const documentId = idFlag >= 0 ? argv[idFlag + 1] : null;
const source = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--id');

async function main() {
  if (!source) throw new Error('usage: storeGovernanceDocument.js <file> [--id <document id>] [--confirm]');
  const file = path.resolve(source);
  const content = fs.readFileSync(file);
  const contentHash = DocumentStorageAdapter.contentHash(content);
  const status = DocumentStorageAdapter.status();
  console.log('file:         ' + file + ' (' + content.length + ' bytes)');
  console.log('content hash: ' + contentHash);
  console.log('backend:      ' + status.backend + ' (live=' + status.live + ', encryption keys=' + status.encryptionKeys + ')');

  if (!confirm) {
    console.log('dry run — re-run with --confirm to pin the document');
    return;
  }
  if (status.backend === 'none' || !status.live) {
    throw new Error('document storage is not live; set DOCUMENT_STORAGE_BACKEND and DOCUMENT_STORAGE_LIVE=true');
  }

  const anchored = await DocumentStorageAdapter.anchor({
    documentId: documentId || path.basename(file),
    content,
    contentType: 'application/pdf',
  });
  if (anchored.error) throw new Error('pin failed: ' + anchored.error);
  if (!anchored.storageUri) throw new Error('pin returned no storage URI');

  const read = await DocumentStorageAdapter.retrieve({
    storageUri: anchored.storageUri,
    contentHash: contentHash,
  });
  if (read.verified !== true) throw new Error('read-back hash did not match the source document');

  console.log('storage uri:  ' + anchored.storageUri);
  console.log('verified read-back against the source hash');
  console.log('set TRUST_SIGNATURE_DOCUMENT_URI=' + anchored.storageUri + ' and unset TRUST_SIGNATURE_DOCUMENT_PATH');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

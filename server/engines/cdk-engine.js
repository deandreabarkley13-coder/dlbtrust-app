/**
 * Polygon CDK Appchain Engine
 * DEANDREA LAVAR BARKLEY TRUST — Private Blockchain Layer
 *
 * Deploys and manages smart contracts on Polygon for:
 *   1. DLBT Token — trust-backed ERC-20 minted 1:1 from banking balances
 *   2. Bridge — mint tokens from banking, burn to sweep back
 *   3. Automated distributions — coupon payments on-chain
 *   4. Governance — pause, ownership transfer, spending limits
 *
 * Uses ethers.js v6 for all on-chain interactions.
 */

'use strict';

const { ethers } = require('ethers');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');

// --- Contract Artifacts (compiled from server/contracts/) --------------------

let TOKEN_ARTIFACT = null;

function getTokenArtifact() {
  if (TOKEN_ARTIFACT) return TOKEN_ARTIFACT;
  const p = path.join(__dirname, '..', 'contracts', 'DLBTrustToken.json');
  if (!fs.existsSync(p)) throw new Error('DLBTrustToken.json not found — run contract compilation first');
  TOKEN_ARTIFACT = JSON.parse(fs.readFileSync(p, 'utf8'));
  return TOKEN_ARTIFACT;
}

// --- RPC + Wallet Setup ------------------------------------------------------

const RPC_ENDPOINTS = {
  'MATIC':      'https://polygon-bor-rpc.publicnode.com',
  'MATIC-AMOY': 'https://rpc-amoy.polygon.technology',
};

function getProvider(network = 'MATIC') {
  const url = RPC_ENDPOINTS[network];
  if (!url) throw new Error(`Unsupported network: ${network}`);
  return new ethers.JsonRpcProvider(url);
}

function decryptPrivateKey(encrypted, passphrase) {
  const parts   = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted key format');
  const [ivHex, authTagHex, cipherHex] = parts;
  const key     = crypto.createHash('sha256').update(passphrase).digest();
  const iv      = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function getSigner(db, walletId, network = 'MATIC') {
  const wallet = db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(walletId);
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);
  if (!wallet.encrypted_private_key) throw new Error('Wallet has no private key');
  const passphrase = process.env.WALLET_ENCRYPTION_KEY;
  if (!passphrase) throw new Error('WALLET_ENCRYPTION_KEY not set');
  const privateKey = decryptPrivateKey(wallet.encrypted_private_key, passphrase);
  const provider   = getProvider(network);
  return new ethers.Wallet(privateKey, provider);
}

// --- Number Generators -------------------------------------------------------

function generateOpNumber(prefix) {
  const d = new Date();
  const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
  const r = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${ds}-${r}`;
}

// --- CDK Config Manager ------------------------------------------------------

class CDKConfigManager {
  constructor(db) { this.db = db; }

  get(key) {
    const row = this.db.prepare('SELECT config_value FROM cdk_chain_config WHERE config_key = ?').get(key);
    return row ? row.config_value : null;
  }

  set(key, value) {
    this.db.prepare(
      "INSERT INTO cdk_chain_config (config_key, config_value) VALUES (?, ?) ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = datetime('now')"
    ).run(key, value);
  }

  getAll() {
    const rows = this.db.prepare('SELECT config_key, config_value FROM cdk_chain_config').all();
    const cfg = {};
    for (const r of rows) cfg[r.config_key] = r.config_value;
    return cfg;
  }
}

// --- Contract Manager --------------------------------------------------------

class ContractManager {
  constructor(db) { this.db = db; }

  async deployToken(signer, name, symbol, decimals) {
    const artifact = getTokenArtifact();
    const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);

    // Deploy
    const contract = await factory.deploy(name, symbol, decimals);
    const receipt  = await contract.deploymentTransaction().wait();

    const addr = await contract.getAddress();

    // Store in DB
    this.db.prepare(`
      INSERT INTO cdk_contracts (contract_type, contract_name, contract_address, deployer_address, tx_hash, blockchain, abi_json, constructor_args, status, block_number, gas_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deployed', ?, ?)
    `).run(
      'token', `${symbol} Token`, addr, signer.address,
      receipt.hash, 'MATIC', JSON.stringify(artifact.abi),
      JSON.stringify([name, symbol, decimals]),
      receipt.blockNumber, receipt.gasUsed.toString()
    );

    return { address: addr, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
  }

  getDeployedToken() {
    return this.db.prepare("SELECT * FROM cdk_contracts WHERE contract_type = 'token' AND status = 'deployed' ORDER BY id DESC LIMIT 1").get();
  }

  getAllContracts() {
    return this.db.prepare('SELECT * FROM cdk_contracts ORDER BY id DESC').all();
  }
}

// --- Token Operations Manager ------------------------------------------------

class TokenOperationsManager {
  constructor(db) { this.db = db; }

  async mint(signer, tokenContractAddress, toAddress, amount, fromAccountId, walletId) {
    const artifact   = getTokenArtifact();
    const contract   = new ethers.Contract(tokenContractAddress, artifact.abi, signer);
    const tokenRow   = this.db.prepare("SELECT * FROM cdk_contracts WHERE contract_address = ?").get(tokenContractAddress);
    const opNum      = generateOpNumber('MINT');
    const amountBig  = ethers.parseUnits(amount, 6); // DLBT has 6 decimals
    const amountCents = Math.round(parseFloat(amount) * 100);

    // Insert pending operation
    this.db.prepare(`
      INSERT INTO cdk_token_operations (operation_type, operation_number, from_account_id, to_wallet_id, wallet_address, amount_cents, token_amount, contract_id, contract_address, status)
      VALUES ('mint', ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(opNum, fromAccountId, walletId, toAddress, amountCents, amount, tokenRow ? tokenRow.id : null, tokenContractAddress);

    const opId = this.db.prepare("SELECT id FROM cdk_token_operations WHERE operation_number = ?").get(opNum).id;

    try {
      // Send mint transaction
      const tx = await contract.mint(toAddress, amountBig);
      this.db.prepare("UPDATE cdk_token_operations SET status = 'submitted', tx_hash = ?, updated_at = datetime('now') WHERE id = ?").run(tx.hash, opId);

      const receipt = await tx.wait();
      this.db.prepare("UPDATE cdk_token_operations SET status = 'confirmed', block_number = ?, gas_used = ?, updated_at = datetime('now') WHERE id = ?")
        .run(receipt.blockNumber, receipt.gasUsed.toString(), opId);

      // Debit banking account
      this.db.prepare("UPDATE trust_accounts SET balance_cents = balance_cents - ?, available_cents = available_cents - ?, updated_at = datetime('now') WHERE id = ?")
        .run(amountCents, amountCents, fromAccountId);

      // Post GL journal entry
      const jeId = this._postJournalEntry(amountCents, 'mint', opNum);
      if (jeId) {
        this.db.prepare("UPDATE cdk_token_operations SET gl_journal_id = ?, updated_at = datetime('now') WHERE id = ?").run(jeId, opId);
      }

      return { opNumber: opNum, txHash: tx.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), amountMinted: amount, status: 'confirmed' };
    } catch (err) {
      this.db.prepare("UPDATE cdk_token_operations SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?").run(err.message, opId);
      throw err;
    }
  }

  async burn(signer, tokenContractAddress, fromAddress, amount, toAccountId, walletId) {
    const artifact   = getTokenArtifact();
    const contract   = new ethers.Contract(tokenContractAddress, artifact.abi, signer);
    const tokenRow   = this.db.prepare("SELECT * FROM cdk_contracts WHERE contract_address = ?").get(tokenContractAddress);
    const opNum      = generateOpNumber('BURN');
    const amountBig  = ethers.parseUnits(amount, 6);
    const amountCents = Math.round(parseFloat(amount) * 100);

    this.db.prepare(`
      INSERT INTO cdk_token_operations (operation_type, operation_number, from_account_id, to_wallet_id, wallet_address, amount_cents, token_amount, contract_id, contract_address, status)
      VALUES ('burn', ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(opNum, toAccountId, walletId, fromAddress, amountCents, amount, tokenRow ? tokenRow.id : null, tokenContractAddress);

    const opId = this.db.prepare("SELECT id FROM cdk_token_operations WHERE operation_number = ?").get(opNum).id;

    try {
      const tx = await contract.burn(fromAddress, amountBig);
      this.db.prepare("UPDATE cdk_token_operations SET status = 'submitted', tx_hash = ?, updated_at = datetime('now') WHERE id = ?").run(tx.hash, opId);

      const receipt = await tx.wait();
      this.db.prepare("UPDATE cdk_token_operations SET status = 'confirmed', block_number = ?, gas_used = ?, updated_at = datetime('now') WHERE id = ?")
        .run(receipt.blockNumber, receipt.gasUsed.toString(), opId);

      // Credit banking account
      this.db.prepare("UPDATE trust_accounts SET balance_cents = balance_cents + ?, available_cents = available_cents + ?, updated_at = datetime('now') WHERE id = ?")
        .run(amountCents, amountCents, toAccountId);

      const jeId = this._postJournalEntry(amountCents, 'burn', opNum);
      if (jeId) {
        this.db.prepare("UPDATE cdk_token_operations SET gl_journal_id = ?, updated_at = datetime('now') WHERE id = ?").run(jeId, opId);
      }

      return { opNumber: opNum, txHash: tx.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), amountBurned: amount, status: 'confirmed' };
    } catch (err) {
      this.db.prepare("UPDATE cdk_token_operations SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?").run(err.message, opId);
      throw err;
    }
  }

  _postJournalEntry(amountCents, opType, ref) {
    try {
      const d   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const r   = Math.floor(1000 + Math.random() * 9000);
      const jeNum = `JE-${d}-${r}`;
      const desc  = opType === 'mint'
        ? `CDK Mint: ${(amountCents / 100).toFixed(2)} DLBT — ${ref}`
        : `CDK Burn: ${(amountCents / 100).toFixed(2)} DLBT — ${ref}`;

      const result = this.db.prepare(`
        INSERT INTO trust_journal_entries (entry_number, entry_date, entry_type, description, reference_type, source_engine, is_posted, total_debit_cents, total_credit_cents, created_by, created_at)
        VALUES (?, date('now'), 'standard', ?, 'cdk_operation', 'cdk_engine', 1, ?, ?, 'cdk_engine', datetime('now'))
      `).run(jeNum, desc, amountCents, amountCents);

      const jeId = result.lastInsertRowid;
      if (!jeId) return null;

      const lines = opType === 'mint'
        ? [
            { code: '1200', desc: 'Digital Assets — DLBT', debit: amountCents, credit: 0 },
            { code: '1000', desc: 'Cash & Equivalents',    debit: 0,          credit: amountCents },
          ]
        : [
            { code: '1000', desc: 'Cash & Equivalents',    debit: amountCents, credit: 0 },
            { code: '1200', desc: 'Digital Assets — DLBT', debit: 0,          credit: amountCents },
          ];

      let lineNum = 1;
      for (const line of lines) {
        let acctRow = this.db.prepare('SELECT id FROM trust_chart_of_accounts WHERE account_code = ?').get(line.code);
        if (!acctRow) {
          const ins = this.db.prepare(`
            INSERT OR IGNORE INTO trust_chart_of_accounts (account_code, account_name, account_type, normal_balance, is_active)
            VALUES (?, ?, ?, ?, 1)
          `).run(line.code, line.desc,
            line.code.startsWith('1') ? 'asset' : 'expense',
            line.code.startsWith('1') ? 'debit' : 'credit');
          acctRow = { id: ins.lastInsertRowid };
        }
        this.db.prepare(`
          INSERT INTO trust_journal_lines (journal_entry_id, line_number, account_id, account_code, description, debit_cents, credit_cents, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(jeId, lineNum++, acctRow.id, line.code, line.desc, line.debit, line.credit);
      }

      return jeNum;
    } catch (err) {
      console.warn('[CDK] GL journal post failed:', err.message);
      return null;
    }
  }

  getOperations(filters = {}) {
    let sql = 'SELECT * FROM cdk_token_operations';
    const conditions = [];
    const params = [];
    if (filters.type) { conditions.push('operation_type = ?'); params.push(filters.type); }
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY id DESC LIMIT ' + (filters.limit || 50);
    return this.db.prepare(sql).all(...params);
  }

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM cdk_token_operations').get().c;
    const mints = this.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount_cents),0) as t FROM cdk_token_operations WHERE operation_type = 'mint' AND status = 'confirmed'").get();
    const burns = this.db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(amount_cents),0) as t FROM cdk_token_operations WHERE operation_type = 'burn' AND status = 'confirmed'").get();
    const pending = this.db.prepare("SELECT COUNT(*) as c FROM cdk_token_operations WHERE status IN ('pending','submitted')").get().c;
    return { total, mints_count: mints.c, mints_total_cents: mints.t, burns_count: burns.c, burns_total_cents: burns.t, pending };
  }
}

// --- Distribution Manager (Coupon payments on-chain) -------------------------

class DistributionManager {
  constructor(db) { this.db = db; }

  async distributeCoupon(signer, tokenContractAddress, recipients, sourceAccountId, bondId) {
    const artifact = getTokenArtifact();
    const contract = new ethers.Contract(tokenContractAddress, artifact.abi, signer);
    const distNum  = generateOpNumber('DIST');
    let totalCents = 0;
    let totalToken = 0;

    for (const r of recipients) {
      totalCents += Math.round(parseFloat(r.amount) * 100);
      totalToken += parseFloat(r.amount);
    }

    this.db.prepare(`
      INSERT INTO cdk_distributions (distribution_number, distribution_type, source_bond_id, source_account_id, recipients_json, total_amount, total_cents, contract_id, status)
      VALUES (?, 'coupon', ?, ?, ?, ?, ?, (SELECT id FROM cdk_contracts WHERE contract_address = ?), 'pending')
    `).run(distNum, bondId || null, sourceAccountId || null, JSON.stringify(recipients), totalToken.toFixed(6), totalCents, tokenContractAddress);

    const distId = this.db.prepare("SELECT id FROM cdk_distributions WHERE distribution_number = ?").get(distNum).id;
    const txHashes = [];

    try {
      for (const r of recipients) {
        const amountBig = ethers.parseUnits(r.amount, 6);
        const tx = await contract.mint(r.address, amountBig);
        txHashes.push(tx.hash);
        await tx.wait();
      }

      this.db.prepare("UPDATE cdk_distributions SET status = 'completed', batch_tx_hashes = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(txHashes), distId);

      // Debit source account
      if (sourceAccountId) {
        this.db.prepare("UPDATE trust_accounts SET balance_cents = balance_cents - ?, available_cents = available_cents - ?, updated_at = datetime('now') WHERE id = ?")
          .run(totalCents, totalCents, sourceAccountId);
      }

      return { distNumber: distNum, txHashes, totalDistributed: totalToken.toFixed(6), recipientCount: recipients.length, status: 'completed' };
    } catch (err) {
      this.db.prepare("UPDATE cdk_distributions SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?").run(err.message, distId);
      throw err;
    }
  }

  getDistributions(limit = 50) {
    return this.db.prepare('SELECT * FROM cdk_distributions ORDER BY id DESC LIMIT ?').all(limit);
  }
}

// --- Token Info (on-chain reads) ---------------------------------------------

async function getTokenInfo(contractAddress, network = 'MATIC') {
  const artifact = getTokenArtifact();
  const provider = getProvider(network);
  const contract = new ethers.Contract(contractAddress, artifact.abi, provider);

  const [name, symbol, decimals, totalSupply, owner, paused] = await Promise.all([
    contract.name(),
    contract.symbol(),
    contract.decimals(),
    contract.totalSupply(),
    contract.owner(),
    contract.paused(),
  ]);

  return {
    address: contractAddress,
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: ethers.formatUnits(totalSupply, Number(decimals)),
    totalSupplyRaw: totalSupply.toString(),
    owner,
    paused,
  };
}

async function getTokenBalance(contractAddress, walletAddress, network = 'MATIC') {
  const artifact = getTokenArtifact();
  const provider = getProvider(network);
  const contract = new ethers.Contract(contractAddress, artifact.abi, provider);
  const bal = await contract.balanceOf(walletAddress);
  const dec = await contract.decimals();
  return { address: walletAddress, balance: ethers.formatUnits(bal, Number(dec)), balanceRaw: bal.toString() };
}

// --- Exports -----------------------------------------------------------------

module.exports = {
  getProvider,
  getSigner,
  decryptPrivateKey,
  generateOpNumber,
  getTokenArtifact,
  getTokenInfo,
  getTokenBalance,
  CDKConfigManager,
  ContractManager,
  TokenOperationsManager,
  DistributionManager,
};

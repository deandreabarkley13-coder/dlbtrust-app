/**
 * Blockchain / Crypto Rails Routes
 * DEANDREA LAVAR BARKLEY TRUST — Circle + Polygon USDC Integration
 *
 * Endpoints:
 *   GET    /api/blockchain/dashboard                - Crypto rails overview metrics
 *   GET    /api/blockchain/config                   - Get blockchain config
 *   PUT    /api/blockchain/config                   - Update blockchain config
 *   GET    /api/blockchain/networks                 - Supported blockchains
 *   GET    /api/blockchain/wallets                  - List wallets
 *   POST   /api/blockchain/wallets                  - Create wallet (via Circle)
 *   GET    /api/blockchain/wallets/:id              - Wallet detail
 *   POST   /api/blockchain/wallets/:id/sync         - Sync wallet balance from chain
 *   POST   /api/blockchain/wallets/:id/freeze       - Freeze wallet
 *   POST   /api/blockchain/wallets/:id/unfreeze     - Unfreeze wallet
 *   POST   /api/blockchain/send                     - Send USDC transfer
 *   GET    /api/blockchain/transactions              - List blockchain transactions
 *   GET    /api/blockchain/transactions/:id          - Transaction detail
 *   POST   /api/blockchain/transactions/:id/approve  - Approve pending transaction
 *   POST   /api/blockchain/transactions/:id/cancel   - Cancel transaction
 *   POST   /api/blockchain/transactions/:id/sync     - Sync tx status from Circle
 *   POST   /api/blockchain/fiat/on-ramp             - Initiate USD → USDC (on-ramp)
 *   POST   /api/blockchain/fiat/off-ramp            - Initiate USDC → USD (off-ramp)
 *   GET    /api/blockchain/fiat/orders               - List fiat gateway orders
 *   GET    /api/blockchain/fiat/orders/:id           - Fiat order detail
 *   GET    /api/blockchain/fiat/balances             - Circle Mint balances
 *   GET    /api/blockchain/audit                     - Audit log
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const {
  SUPPORTED_BLOCKCHAINS,
  WALLET_TYPES,
  TRANSFER_TYPES,
  CircleClient,
  WalletManager,
  TransactionManager,
  FiatGatewayManager,
  logAudit,
  generateChainTxNumber,
  generateFiatOrderNumber,
  generateIdempotencyKey,
  usdToCents,
  centsToUsd,
  mapCircleTxStatus,
  mapFiatStatus,
  maskAddress,
  getExplorerUrl,
} = require('../engines/blockchain-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

function initSchema(db) {
  if (schemaInitialized) return;
  const migrations = [
    'banking-schema.sql',
    'crm-schema.sql',
    'external-transfers-schema.sql',
    'trust-accounting-schema.sql',
    'blockchain-schema.sql',
  ];
  for (const file of migrations) {
    const p = path.join(__dirname, '..', 'db', 'migrations', file);
    if (fs.existsSync(p)) db.exec(fs.readFileSync(p, 'utf8'));
  }
  schemaInitialized = true;
}

// --- Middleware --------------------------------------------------------------

router.use((req, res, next) => {
  try {
    req.db = getDb();
    initSchema(req.db);
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', detail: err.message });
  }
});

// --- Helpers ----------------------------------------------------------------

function getConfig(db, key) {
  const row = db.prepare('SELECT config_value FROM blockchain_config WHERE config_key = ?').get(key);
  return row ? row.config_value : null;
}

function setConfig(db, key, value) {
  db.prepare(`UPDATE blockchain_config SET config_value = ?, updated_at = datetime('now') WHERE config_key = ?`).run(value, key);
}

function getCircleClient(db) {
  const apiKey = process.env.CIRCLE_API_KEY || getConfig(db, 'circle_api_key');
  const env = getConfig(db, 'environment') || 'sandbox';
  if (!apiKey) return null;
  return new CircleClient(apiKey, env);
}

// ─── GET /dashboard ─────────────────────────────────────────────────────────

router.get('/dashboard', (req, res) => {
  try {
    const walletMgr = new WalletManager(req.db);
    const txMgr = new TransactionManager(req.db);
    const fiatMgr = new FiatGatewayManager(req.db);

    const walletStats = walletMgr.getStats();
    const txStats = txMgr.getStats();
    const fiatStats = fiatMgr.getStats();

    const env = getConfig(req.db, 'environment') || 'sandbox';
    const blockchain = getConfig(req.db, 'default_blockchain') || 'MATIC-AMOY';
    const connected = !!(process.env.CIRCLE_API_KEY || getConfig(req.db, 'circle_api_key'));

    res.json({
      environment: env,
      blockchain,
      network: SUPPORTED_BLOCKCHAINS[blockchain] || {},
      connected,
      wallets: walletStats,
      transactions: txStats,
      fiatGateway: fiatStats,
      dailyLimit: getConfig(req.db, 'daily_transfer_limit') || '100000.00',
      approvalThreshold: getConfig(req.db, 'approval_threshold') || '10000.00',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dashboard', detail: err.message });
  }
});

// ─── GET /config ────────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  try {
    const rows = req.db.prepare('SELECT config_key, config_value, is_sensitive, description FROM blockchain_config ORDER BY id').all();
    const config = rows.map(r => ({
      key: r.config_key,
      value: r.is_sensitive && r.config_value ? '••••••••' : r.config_value,
      is_sensitive: !!r.is_sensitive,
      description: r.description,
    }));
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load config', detail: err.message });
  }
});

// ─── PUT /config ────────────────────────────────────────────────────────────

router.put('/config', (req, res) => {
  try {
    const { updates } = req.body; // [{ key, value }, ...]
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates must be an array' });

    const stmt = req.db.prepare(`UPDATE blockchain_config SET config_value = ?, updated_at = datetime('now') WHERE config_key = ?`);
    let count = 0;
    for (const { key, value } of updates) {
      if (key && value !== undefined) {
        stmt.run(value, key);
        count++;
      }
    }

    logAudit(req.db, { eventType: 'config_changed', details: { count, keys: updates.map(u => u.key) } });
    res.json({ updated: count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update config', detail: err.message });
  }
});

// ─── GET /networks ──────────────────────────────────────────────────────────

router.get('/networks', (req, res) => {
  res.json({ networks: SUPPORTED_BLOCKCHAINS });
});

// ─── GET /wallets ───────────────────────────────────────────────────────────

router.get('/wallets', (req, res) => {
  try {
    const walletMgr = new WalletManager(req.db);
    const wallets = walletMgr.listWallets(req.query);
    res.json({
      wallets: wallets.map(w => ({
        ...w,
        address_masked: maskAddress(w.address),
        blockchain_info: SUPPORTED_BLOCKCHAINS[w.blockchain] || {},
        wallet_type_label: WALLET_TYPES[w.wallet_type] || w.wallet_type,
      })),
      count: wallets.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list wallets', detail: err.message });
  }
});

// ─── POST /wallets ──────────────────────────────────────────────────────────

router.post('/wallets', async (req, res) => {
  try {
    const { wallet_name, wallet_type, blockchain, trust_account_id, contact_id, entity_secret_ciphertext } = req.body;

    if (!wallet_name) return res.status(400).json({ error: 'wallet_name is required' });

    const chain = blockchain || getConfig(req.db, 'default_blockchain') || 'MATIC-AMOY';
    const circle = getCircleClient(req.db);

    let circleWalletId = null;
    let circleWalletSetId = null;
    let address = null;

    if (circle) {
      try {
        // Use or create wallet set
        let walletSetId = getConfig(req.db, 'wallet_set_id');
        if (!walletSetId) {
          const setResult = await circle.createWalletSet({
            name: 'DLB Trust Wallet Set',
            entitySecretCiphertext: entity_secret_ciphertext || undefined,
          });
          walletSetId = setResult.data?.walletSet?.id;
          if (walletSetId) setConfig(req.db, 'wallet_set_id', walletSetId);
        }

        if (walletSetId) {
          const walletResult = await circle.createWallet({
            walletSetId,
            blockchains: [chain],
            entitySecretCiphertext: entity_secret_ciphertext || undefined,
            metadata: [{ name: 'trust_wallet_name', value: wallet_name }],
          });
          const created = walletResult.data?.wallets?.[0];
          if (created) {
            circleWalletId = created.id;
            circleWalletSetId = walletSetId;
            address = created.address;
          }
        }
      } catch (circleErr) {
        // Circle API failed — fall back to local wallet
        console.warn('[Blockchain] Circle API error, creating local wallet:', circleErr.message);
      }
    }

    // Create locally (works even without Circle connection)
    if (!circleWalletId) {
      circleWalletId = `local_${generateIdempotencyKey('wal')}`;
      address = `0x${Array.from({length: 40}, () => Math.floor(Math.random()*16).toString(16)).join('')}`;
    }

    const walletMgr = new WalletManager(req.db);
    const wallet = walletMgr.createWallet({
      circleWalletId,
      circleWalletSetId,
      trustAccountId: trust_account_id,
      contactId: contact_id,
      walletName: wallet_name,
      walletType: wallet_type || 'trust',
      blockchain: chain,
      address,
    });

    logAudit(req.db, {
      eventType: 'wallet_created',
      entityType: 'wallet',
      entityId: wallet.id,
      details: { wallet_name, wallet_type, blockchain: chain, address },
    });

    res.status(201).json({
      wallet: { ...wallet, address_masked: maskAddress(wallet.address) },
      circle_connected: !!circle,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'Failed to create wallet', detail: err.message });
  }
});

// ─── GET /wallets/:id ───────────────────────────────────────────────────────

router.get('/wallets/:id', (req, res) => {
  try {
    const walletMgr = new WalletManager(req.db);
    const wallet = walletMgr.getWallet(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const txMgr = new TransactionManager(req.db);
    const outbound = txMgr.listTransactions({ from_wallet_id: wallet.id, limit: '10' });
    const inbound = txMgr.listTransactions({ to_wallet_id: wallet.id, limit: '10' });

    res.json({
      wallet: {
        ...wallet,
        address_masked: maskAddress(wallet.address),
        blockchain_info: SUPPORTED_BLOCKCHAINS[wallet.blockchain] || {},
        wallet_type_label: WALLET_TYPES[wallet.wallet_type] || wallet.wallet_type,
      },
      recentOutbound: outbound,
      recentInbound: inbound,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get wallet', detail: err.message });
  }
});

// ─── POST /wallets/:id/sync ─────────────────────────────────────────────────

router.post('/wallets/:id/sync', async (req, res) => {
  try {
    const walletMgr = new WalletManager(req.db);
    const wallet = walletMgr.getWallet(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const circle = getCircleClient(req.db);
    if (!circle || !wallet.circle_wallet_id || wallet.circle_wallet_id.startsWith('local_')) {
      return res.json({ wallet, synced: false, reason: 'No Circle connection or local-only wallet' });
    }

    const balances = await circle.getWalletBalance(wallet.circle_wallet_id);
    let usdcBalance = '0.00';
    let nativeBalance = '0.00';

    if (balances.data?.tokenBalances) {
      for (const tb of balances.data.tokenBalances) {
        if (tb.token?.symbol === 'USDC') usdcBalance = tb.amount || '0.00';
        if (tb.token?.isNative) nativeBalance = tb.amount || '0.00';
      }
    }

    walletMgr.updateBalance(wallet.id, usdcBalance, nativeBalance);
    const updated = walletMgr.getWallet(wallet.id);

    res.json({ wallet: updated, synced: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sync wallet', detail: err.message });
  }
});

// ─── POST /wallets/:id/freeze & /unfreeze ───────────────────────────────────

router.post('/wallets/:id/freeze', (req, res) => {
  try {
    const walletMgr = new WalletManager(req.db);
    const wallet = walletMgr.getWallet(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    walletMgr.updateStatus(wallet.id, 'frozen');
    logAudit(req.db, { eventType: 'wallet_frozen', entityType: 'wallet', entityId: wallet.id });
    res.json({ wallet: walletMgr.getWallet(wallet.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to freeze wallet', detail: err.message });
  }
});

router.post('/wallets/:id/unfreeze', (req, res) => {
  try {
    const walletMgr = new WalletManager(req.db);
    const wallet = walletMgr.getWallet(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    walletMgr.updateStatus(wallet.id, 'active');
    logAudit(req.db, { eventType: 'wallet_unfrozen', entityType: 'wallet', entityId: wallet.id });
    res.json({ wallet: walletMgr.getWallet(wallet.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unfreeze wallet', detail: err.message });
  }
});

// ─── POST /send ─────────────────────────────────────────────────────────────

router.post('/send', async (req, res) => {
  try {
    const { from_wallet_id, to_address, to_wallet_id, amount, token,
            transfer_type, description, entity_secret_ciphertext } = req.body;

    if (!from_wallet_id) return res.status(400).json({ error: 'from_wallet_id is required' });
    if (!to_address && !to_wallet_id) return res.status(400).json({ error: 'to_address or to_wallet_id is required' });
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Valid amount is required' });

    const walletMgr = new WalletManager(req.db);
    const fromWallet = walletMgr.getWallet(from_wallet_id);
    if (!fromWallet) return res.status(404).json({ error: 'Source wallet not found' });
    if (fromWallet.status === 'frozen') return res.status(400).json({ error: 'Source wallet is frozen' });

    let destAddress = to_address;
    let toWalletId = to_wallet_id || null;

    if (to_wallet_id && !to_address) {
      const toWallet = walletMgr.getWallet(to_wallet_id);
      if (!toWallet) return res.status(404).json({ error: 'Destination wallet not found' });
      destAddress = toWallet.address;
    }

    // Check daily limit
    const dailyLimit = parseFloat(getConfig(req.db, 'daily_transfer_limit') || '100000');
    const txMgr = new TransactionManager(req.db);
    const todayStats = txMgr.getStats();
    if (parseFloat(todayStats.todayVolume) + parseFloat(amount) > dailyLimit) {
      return res.status(400).json({ error: `Daily transfer limit exceeded ($${dailyLimit.toFixed(2)})` });
    }

    // Check approval threshold
    const threshold = parseFloat(getConfig(req.db, 'approval_threshold') || '10000');
    const requiresApproval = parseFloat(amount) >= threshold;

    const idempotencyKey = generateIdempotencyKey('send');
    let circleTxId = null;

    const circle = getCircleClient(req.db);
    if (circle && !fromWallet.circle_wallet_id.startsWith('local_') && !requiresApproval) {
      try {
        const tokenId = getConfig(req.db, 'usdc_token_id');
        const result = await circle.createTransfer({
          walletId: fromWallet.circle_wallet_id,
          destinationAddress: destAddress,
          amounts: [amount.toString()],
          tokenId: tokenId || undefined,
          blockchain: fromWallet.blockchain,
          idempotencyKey,
          entitySecretCiphertext: entity_secret_ciphertext || undefined,
        });
        circleTxId = result.data?.id;
      } catch (circleErr) {
        console.warn('[Blockchain] Circle transfer failed, queuing locally:', circleErr.message);
      }
    }

    const tx = txMgr.createTransaction({
      circleTxId,
      fromWalletId: fromWallet.id,
      fromAddress: fromWallet.address,
      toWalletId,
      toAddress: destAddress,
      token: token || 'USDC',
      amount: amount.toString(),
      amountCents: usdToCents(amount),
      blockchain: fromWallet.blockchain,
      transferType: transfer_type || 'internal',
      direction: 'outbound',
      description,
      requiresApproval,
      idempotencyKey,
    });

    if (circleTxId) {
      txMgr.updateStatus(tx.id, 'submitted', { circleTxId });
    }

    logAudit(req.db, {
      eventType: 'transfer_sent',
      entityType: 'transaction',
      entityId: tx.id,
      details: { from: maskAddress(fromWallet.address), to: maskAddress(destAddress), amount, token: token || 'USDC' },
    });

    res.status(201).json({
      transaction: { ...txMgr.getTransaction(tx.id), from_address_masked: maskAddress(fromWallet.address), to_address_masked: maskAddress(destAddress) },
      circle_submitted: !!circleTxId,
      requires_approval: requiresApproval,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'Failed to send transfer', detail: err.message });
  }
});

// ─── GET /transactions ──────────────────────────────────────────────────────

router.get('/transactions', (req, res) => {
  try {
    const txMgr = new TransactionManager(req.db);
    const txns = txMgr.listTransactions(req.query);
    res.json({
      transactions: txns.map(tx => ({
        ...tx,
        from_address_masked: maskAddress(tx.from_address),
        to_address_masked: maskAddress(tx.to_address),
        explorer_url: getExplorerUrl(tx.blockchain, tx.tx_hash),
        transfer_type_label: TRANSFER_TYPES[tx.transfer_type] || tx.transfer_type,
      })),
      count: txns.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list transactions', detail: err.message });
  }
});

// ─── GET /transactions/:id ──────────────────────────────────────────────────

router.get('/transactions/:id', (req, res) => {
  try {
    const txMgr = new TransactionManager(req.db);
    const tx = txMgr.getTransaction(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    res.json({
      transaction: {
        ...tx,
        from_address_masked: maskAddress(tx.from_address),
        to_address_masked: maskAddress(tx.to_address),
        explorer_url: getExplorerUrl(tx.blockchain, tx.tx_hash),
        transfer_type_label: TRANSFER_TYPES[tx.transfer_type] || tx.transfer_type,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get transaction', detail: err.message });
  }
});

// ─── POST /transactions/:id/approve ─────────────────────────────────────────

router.post('/transactions/:id/approve', async (req, res) => {
  try {
    const txMgr = new TransactionManager(req.db);
    const tx = txMgr.getTransaction(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending_approval') return res.status(400).json({ error: `Cannot approve transaction in ${tx.status} status` });

    const { approved_by, entity_secret_ciphertext } = req.body;

    // Submit to Circle now that it's approved
    const circle = getCircleClient(req.db);
    let circleTxId = null;

    const walletMgr = new WalletManager(req.db);
    const fromWallet = tx.from_wallet_id ? walletMgr.getWallet(tx.from_wallet_id) : null;

    if (circle && fromWallet && !fromWallet.circle_wallet_id.startsWith('local_')) {
      const tokenId = getConfig(req.db, 'usdc_token_id');
      const result = await circle.createTransfer({
        walletId: fromWallet.circle_wallet_id,
        destinationAddress: tx.to_address,
        amounts: [tx.amount],
        tokenId: tokenId || undefined,
        blockchain: tx.blockchain,
        idempotencyKey: tx.idempotency_key,
        entitySecretCiphertext: entity_secret_ciphertext || undefined,
      });
      circleTxId = result.data?.id;
    }

    txMgr.updateStatus(tx.id, circleTxId ? 'submitted' : 'approved', {
      circleTxId,
      approvedBy: approved_by || 'trustee',
    });

    logAudit(req.db, {
      eventType: 'approval_granted',
      entityType: 'transaction',
      entityId: tx.id,
      details: { approved_by: approved_by || 'trustee', amount: tx.amount },
    });

    res.json({ transaction: txMgr.getTransaction(tx.id), circle_submitted: !!circleTxId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve transaction', detail: err.message });
  }
});

// ─── POST /transactions/:id/cancel ──────────────────────────────────────────

router.post('/transactions/:id/cancel', (req, res) => {
  try {
    const txMgr = new TransactionManager(req.db);
    const tx = txMgr.getTransaction(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (['completed', 'cancelled', 'failed'].includes(tx.status)) {
      return res.status(400).json({ error: `Cannot cancel transaction in ${tx.status} status` });
    }

    txMgr.updateStatus(tx.id, 'cancelled', { failureReason: req.body.reason || 'Cancelled by user' });
    logAudit(req.db, { eventType: 'transfer_cancelled', entityType: 'transaction', entityId: tx.id });
    res.json({ transaction: txMgr.getTransaction(tx.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel transaction', detail: err.message });
  }
});

// ─── POST /transactions/:id/sync ────────────────────────────────────────────

router.post('/transactions/:id/sync', async (req, res) => {
  try {
    const txMgr = new TransactionManager(req.db);
    const tx = txMgr.getTransaction(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (!tx.circle_tx_id) return res.json({ transaction: tx, synced: false, reason: 'No Circle transaction ID' });

    const circle = getCircleClient(req.db);
    if (!circle) return res.json({ transaction: tx, synced: false, reason: 'Circle not connected' });

    const result = await circle.getTransaction(tx.circle_tx_id);
    const circleTx = result.data?.transaction || result.data;

    if (circleTx) {
      const newStatus = mapCircleTxStatus(circleTx.state);
      txMgr.updateStatus(tx.id, newStatus, {
        circleState: circleTx.state,
        txHash: circleTx.txHash,
        blockNumber: circleTx.blockHeight,
        networkFee: circleTx.networkFee,
        failureReason: circleTx.errorReason,
      });
    }

    res.json({ transaction: txMgr.getTransaction(tx.id), synced: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sync transaction', detail: err.message });
  }
});

// ─── POST /fiat/on-ramp ─────────────────────────────────────────────────────

router.post('/fiat/on-ramp', async (req, res) => {
  try {
    const { amount, wallet_id, bank_name, bank_account_masked } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Valid amount is required' });

    const fiatMgr = new FiatGatewayManager(req.db);
    const idempotencyKey = generateIdempotencyKey('onramp');

    let circlePaymentId = null;
    const circle = getCircleClient(req.db);

    // In production, this would trigger a Circle Payments API call
    // For sandbox, we create the order locally and provide instructions
    if (circle) {
      try {
        const mintBalances = await circle.getMintBalances();
        // On-ramp is typically initiated by sending a wire to Circle's bank details
        // The Circle Mint API doesn't have a direct "on-ramp" endpoint;
        // instead, you send a wire deposit and Circle credits USDC
      } catch (_) {
        // Continue with local order
      }
    }

    const order = fiatMgr.createOrder({
      direction: 'on_ramp',
      fiatAmount: amount.toString(),
      cryptoAmount: amount.toString(), // 1:1 for USDC
      walletId: wallet_id || null,
      bankName: bank_name || null,
      bankAccountMasked: bank_account_masked || null,
      rail: 'wire',
      idempotencyKey,
    });

    logAudit(req.db, {
      eventType: 'fiat_on_ramp',
      entityType: 'fiat_order',
      entityId: order.id,
      details: { amount, direction: 'on_ramp' },
    });

    res.status(201).json({
      order,
      instructions: {
        message: 'Wire the specified USD amount to Circle\'s bank account. USDC will be credited to your wallet upon settlement.',
        steps: [
          'Log in to your Circle Mint Console (console.circle.com)',
          `Initiate a wire deposit of $${parseFloat(amount).toFixed(2)}`,
          'Use the provided wire instructions from Circle',
          'USDC will be credited upon wire settlement (typically 1-2 business days)',
        ],
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to initiate on-ramp', detail: err.message });
  }
});

// ─── POST /fiat/off-ramp ────────────────────────────────────────────────────

router.post('/fiat/off-ramp', async (req, res) => {
  try {
    const { amount, wallet_id, bank_name, bank_account_masked, destination_id } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Valid amount is required' });

    const fiatMgr = new FiatGatewayManager(req.db);
    const idempotencyKey = generateIdempotencyKey('offramp');

    let circlePaymentId = null;
    const circle = getCircleClient(req.db);

    if (circle && destination_id) {
      try {
        const result = await circle.createPayout({
          destination: { type: 'wire', id: destination_id },
          amount: amount.toString(),
          idempotencyKey,
        });
        circlePaymentId = result.data?.id;
      } catch (_) {
        // Continue with local order
      }
    }

    const order = fiatMgr.createOrder({
      circlePaymentId,
      direction: 'off_ramp',
      fiatAmount: amount.toString(),
      cryptoAmount: amount.toString(),
      walletId: wallet_id || null,
      bankName: bank_name || null,
      bankAccountMasked: bank_account_masked || null,
      rail: 'wire',
      idempotencyKey,
    });

    if (circlePaymentId) {
      fiatMgr.updateStatus(order.id, 'processing', { circleStatus: 'pending' });
    }

    logAudit(req.db, {
      eventType: 'fiat_off_ramp',
      entityType: 'fiat_order',
      entityId: order.id,
      details: { amount, direction: 'off_ramp', circle_submitted: !!circlePaymentId },
    });

    res.status(201).json({
      order: fiatMgr.getOrder(order.id),
      circle_submitted: !!circlePaymentId,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to initiate off-ramp', detail: err.message });
  }
});

// ─── GET /fiat/orders ───────────────────────────────────────────────────────

router.get('/fiat/orders', (req, res) => {
  try {
    const fiatMgr = new FiatGatewayManager(req.db);
    const orders = fiatMgr.listOrders(req.query);
    res.json({ orders, count: orders.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list fiat orders', detail: err.message });
  }
});

// ─── GET /fiat/orders/:id ───────────────────────────────────────────────────

router.get('/fiat/orders/:id', (req, res) => {
  try {
    const fiatMgr = new FiatGatewayManager(req.db);
    const order = fiatMgr.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get order', detail: err.message });
  }
});

// ─── GET /fiat/balances ─────────────────────────────────────────────────────

router.get('/fiat/balances', async (req, res) => {
  try {
    const circle = getCircleClient(req.db);
    if (!circle) return res.json({ balances: null, connected: false });

    const result = await circle.getMintBalances();
    res.json({ balances: result.data, connected: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get balances', detail: err.message });
  }
});

// ─── GET /audit ─────────────────────────────────────────────────────────────

router.get('/audit', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const events = req.db.prepare('SELECT * FROM blockchain_audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
    res.json({
      events: events.map(e => ({
        ...e,
        details: e.details ? JSON.parse(e.details) : null,
      })),
      count: events.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get audit log', detail: err.message });
  }
});

module.exports = router;

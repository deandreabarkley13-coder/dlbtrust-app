/**
 * Polygon CDK Appchain Routes
 * DEANDREA LAVAR BARKLEY TRUST — Private Blockchain Layer
 *
 * Endpoints:
 *   GET    /api/cdk/dashboard              - Chain status, token info, metrics
 *   GET    /api/cdk/config                 - Chain configuration
 *   PUT    /api/cdk/config                 - Update chain configuration
 *   GET    /api/cdk/contracts              - List deployed contracts
 *   POST   /api/cdk/deploy-token           - Deploy DLBT token contract
 *   GET    /api/cdk/token                  - Token info (on-chain read)
 *   GET    /api/cdk/token/balance/:address - Token balance for address
 *   POST   /api/cdk/mint                   - Mint DLBT from banking balance
 *   POST   /api/cdk/burn                   - Burn DLBT to banking balance
 *   GET    /api/cdk/operations             - List mint/burn operations
 *   POST   /api/cdk/distribute             - Distribute coupon payments on-chain
 *   GET    /api/cdk/distributions          - List distribution events
 *   GET    /api/cdk/bridge                 - Bridge operations
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const {
  getProvider, getSigner, getTokenInfo, getTokenBalance,
  CDKConfigManager, ContractManager, TokenOperationsManager, DistributionManager,
  LiquidityPoolManager, USDC_POLYGON,
} = require('../engines/cdk-engine');

// --- DB Setup ---------------------------------------------------------------

function getDb() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db');
  return new Database(dbPath);
}

let schemaInitialized = false;

router.use((req, res, next) => {
  try {
    req.db = getDb();
    req.db.pragma('journal_mode = WAL');
    if (!schemaInitialized) {
      const schemas = [
        'banking-schema.sql', 'blockchain-schema.sql', 'trust-accounting-schema.sql',
        'fixed-income-schema.sql', 'cdk-schema.sql',
      ];
      for (const file of schemas) {
        const p = path.join(__dirname, '..', 'db', 'migrations', file);
        if (fs.existsSync(p)) { try { req.db.exec(fs.readFileSync(p, 'utf8')); } catch (_) {} }
      }
      schemaInitialized = true;
    }
    res.on('finish', () => { try { req.db.close(); } catch (_) {} });
    res.on('close',  () => { try { req.db.close(); } catch (_) {} });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed: ' + err.message });
  }
});

// --- GET /dashboard ---------------------------------------------------------

router.get('/dashboard', async (req, res) => {
  try {
    const cfg      = new CDKConfigManager(req.db);
    const contracts = new ContractManager(req.db);
    const ops      = new TokenOperationsManager(req.db);
    const config   = cfg.getAll();
    const token    = contracts.getDeployedToken();
    const stats    = ops.getStats();

    // Get accounts available for minting
    let accounts = [];
    try {
      accounts = req.db.prepare("SELECT id, account_name, account_type, balance_cents FROM trust_accounts WHERE status = 'active'").all();
    } catch (_) {}

    // Get wallets available as destinations
    let wallets = [];
    try {
      wallets = req.db.prepare("SELECT id, wallet_name, address, usdc_balance, native_balance, blockchain, status FROM blockchain_wallets WHERE status = 'active'").all();
    } catch (_) {}

    // On-chain token info if deployed
    let tokenInfo = null;
    if (token && token.contract_address) {
      try {
        tokenInfo = await getTokenInfo(token.contract_address, config.network || 'MATIC');
      } catch (e) { tokenInfo = { error: e.message, address: token.contract_address }; }
    }

    // Recent operations
    const recentOps = ops.getOperations({ limit: 10 });

    // Pool info
    let poolInfo = null;
    if (token && token.contract_address) {
      try {
        const poolMgr = new LiquidityPoolManager(req.db);
        poolInfo = await poolMgr.getPoolInfo(token.contract_address);
      } catch (_) {}
    }

    res.json({
      chain: config,
      token_contract: token || null,
      token_info: tokenInfo,
      pool_info: poolInfo,
      stats,
      accounts: accounts.map(a => ({ ...a, balance_usd: (a.balance_cents / 100).toFixed(2) })),
      wallets: wallets.map(w => ({ ...w, usdc_balance: parseFloat(w.usdc_balance || '0').toFixed(2) })),
      recent_operations: recentOps,
      has_encryption_key: !!process.env.WALLET_ENCRYPTION_KEY,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /config ------------------------------------------------------------

router.get('/config', (req, res) => {
  try {
    const cfg = new CDKConfigManager(req.db);
    res.json({ config: cfg.getAll() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PUT /config ------------------------------------------------------------

router.put('/config', (req, res) => {
  try {
    const cfg = new CDKConfigManager(req.db);
    const allowed = ['chain_name', 'token_name', 'token_symbol', 'token_decimals', 'deployer_wallet_id'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) cfg.set(key, req.body[key]);
    }
    res.json({ config: cfg.getAll() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- GET /contracts ---------------------------------------------------------

router.get('/contracts', (req, res) => {
  try {
    const mgr = new ContractManager(req.db);
    res.json({ contracts: mgr.getAllContracts() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- POST /deploy-token — Deploy DLBT ERC-20 to Polygon --------------------

router.post('/deploy-token', async (req, res) => {
  try {
    const cfg = new CDKConfigManager(req.db);
    const mgr = new ContractManager(req.db);

    // Check if already deployed
    const existing = mgr.getDeployedToken();
    if (existing) {
      return res.status(400).json({ error: 'Token already deployed', contract: existing });
    }

    const walletId = req.body.wallet_id || cfg.get('deployer_wallet_id');
    if (!walletId) return res.status(400).json({ error: 'No deployer wallet specified. Set deployer_wallet_id in config or pass wallet_id.' });

    const name     = cfg.get('token_name')     || 'DLB Trust Token';
    const symbol   = cfg.get('token_symbol')    || 'DLBT';
    const decimals = parseInt(cfg.get('token_decimals') || '6');
    const network  = cfg.get('network')         || 'MATIC';

    const signer = getSigner(req.db, parseInt(walletId), network);
    const result = await mgr.deployToken(signer, name, symbol, decimals);

    // Save deployer wallet ID
    cfg.set('deployer_wallet_id', walletId.toString());

    res.json({
      message: `${symbol} token deployed to Polygon`,
      contract_address: result.address,
      tx_hash: result.txHash,
      block_number: result.blockNumber,
      gas_used: result.gasUsed,
      explorer_url: `https://polygonscan.com/tx/${result.txHash}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /token — On-chain token info ---------------------------------------

router.get('/token', async (req, res) => {
  try {
    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.status(404).json({ error: 'No token deployed yet. Use POST /deploy-token first.' });

    const cfg     = new CDKConfigManager(req.db);
    const network = cfg.get('network') || 'MATIC';
    const info = await getTokenInfo(token.contract_address, network);
    res.json({ contract: token, token: info });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- GET /token/balance/:address --------------------------------------------

router.get('/token/balance/:address', async (req, res) => {
  try {
    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.status(404).json({ error: 'No token deployed' });

    const cfg     = new CDKConfigManager(req.db);
    const network = cfg.get('network') || 'MATIC';
    const bal = await getTokenBalance(token.contract_address, req.params.address, network);
    res.json(bal);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- POST /mint — Mint DLBT from banking balance ----------------------------

router.post('/mint', async (req, res) => {
  try {
    const { from_account_id, to_wallet_id, amount } = req.body;
    if (!from_account_id || !to_wallet_id || !amount) {
      return res.status(400).json({ error: 'Required: from_account_id, to_wallet_id, amount' });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // Check account balance
    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ? AND status = ?').get(from_account_id, 'active');
    if (!account) return res.status(404).json({ error: 'Account not found or inactive' });
    if (account.balance_cents < amountNum * 100) return res.status(400).json({ error: `Insufficient balance. Account has $${(account.balance_cents / 100).toFixed(2)}, requested $${amountNum.toFixed(2)}` });

    // Get wallet
    const wallet = req.db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(to_wallet_id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    // Get token contract
    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.status(400).json({ error: 'DLBT token not deployed yet. Deploy first via POST /deploy-token' });

    // Get deployer signer (token owner)
    const cfg      = new CDKConfigManager(req.db);
    const deployerWalletId = cfg.get('deployer_wallet_id');
    if (!deployerWalletId) return res.status(400).json({ error: 'No deployer wallet configured' });

    const network = cfg.get('network') || 'MATIC';
    const signer  = getSigner(req.db, parseInt(deployerWalletId), network);

    const ops    = new TokenOperationsManager(req.db);
    const result = await ops.mint(signer, token.contract_address, wallet.address, amountNum.toFixed(6), from_account_id, to_wallet_id);

    res.json({
      message: `Minted ${amountNum.toFixed(2)} DLBT to ${wallet.wallet_name}`,
      ...result,
      explorer_url: `https://polygonscan.com/tx/${result.txHash}`,
      account_debited: account.account_name,
      new_account_balance: ((account.balance_cents - amountNum * 100) / 100).toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /burn — Burn DLBT to credit banking balance -----------------------

router.post('/burn', async (req, res) => {
  try {
    const { to_account_id, from_wallet_id, amount } = req.body;
    if (!to_account_id || !from_wallet_id || !amount) {
      return res.status(400).json({ error: 'Required: to_account_id, from_wallet_id, amount' });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const wallet = req.db.prepare('SELECT * FROM blockchain_wallets WHERE id = ?').get(from_wallet_id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const account = req.db.prepare('SELECT * FROM trust_accounts WHERE id = ? AND status = ?').get(to_account_id, 'active');
    if (!account) return res.status(404).json({ error: 'Account not found or inactive' });

    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.status(400).json({ error: 'DLBT token not deployed' });

    const cfg      = new CDKConfigManager(req.db);
    const deployerWalletId = cfg.get('deployer_wallet_id');
    const network  = cfg.get('network') || 'MATIC';
    const signer   = getSigner(req.db, parseInt(deployerWalletId), network);

    const ops    = new TokenOperationsManager(req.db);
    const result = await ops.burn(signer, token.contract_address, wallet.address, amountNum.toFixed(6), to_account_id, from_wallet_id);

    res.json({
      message: `Burned ${amountNum.toFixed(2)} DLBT, credited ${account.account_name}`,
      ...result,
      explorer_url: `https://polygonscan.com/tx/${result.txHash}`,
      account_credited: account.account_name,
      new_account_balance: ((account.balance_cents + amountNum * 100) / 100).toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /operations --------------------------------------------------------

router.get('/operations', (req, res) => {
  try {
    const ops = new TokenOperationsManager(req.db);
    const filters = {};
    if (req.query.type) filters.type = req.query.type;
    if (req.query.status) filters.status = req.query.status;
    if (req.query.limit) filters.limit = parseInt(req.query.limit);
    const list = ops.getOperations(filters);
    res.json({ count: list.length, operations: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- POST /distribute — Coupon distribution on-chain ------------------------

router.post('/distribute', async (req, res) => {
  try {
    const { recipients, source_account_id, bond_id } = req.body;
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Required: recipients (array of {address, amount})' });
    }

    for (const r of recipients) {
      if (!r.address || !r.amount) return res.status(400).json({ error: 'Each recipient needs address and amount' });
    }

    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.status(400).json({ error: 'DLBT token not deployed' });

    const cfg      = new CDKConfigManager(req.db);
    const deployerWalletId = cfg.get('deployer_wallet_id');
    const network  = cfg.get('network') || 'MATIC';
    const signer   = getSigner(req.db, parseInt(deployerWalletId), network);

    const dist   = new DistributionManager(req.db);
    const result = await dist.distributeCoupon(signer, token.contract_address, recipients, source_account_id, bond_id);

    res.json({ message: 'Coupon distribution completed', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /distributions -----------------------------------------------------

router.get('/distributions', (req, res) => {
  try {
    const dist = new DistributionManager(req.db);
    const list = dist.getDistributions(parseInt(req.query.limit) || 50);
    res.json({ count: list.length, distributions: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- GET /bridge — Bridge operations ----------------------------------------

router.get('/bridge', (req, res) => {
  try {
    const rows = req.db.prepare('SELECT * FROM cdk_bridge_operations ORDER BY id DESC LIMIT 50').all();
    res.json({ count: rows.length, operations: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- POST /pool/create — Create DLBT/USDC liquidity pool on QuickSwap ------

router.post('/pool/create', async (req, res) => {
  try {
    const { wallet_id } = req.body;

    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.status(400).json({ error: 'DLBT token not deployed yet' });

    const cfg     = new CDKConfigManager(req.db);
    const network = cfg.get('network') || 'MATIC';
    const wId     = wallet_id || cfg.get('deployer_wallet_id');
    if (!wId) return res.status(400).json({ error: 'No deployer wallet configured' });

    const signer = getSigner(req.db, parseInt(wId), network);
    const pool   = new LiquidityPoolManager(req.db);
    const result = await pool.createPool(signer, token.contract_address);

    res.json({
      message: result.alreadyExists ? 'Pool already exists' : 'DLBT/USDC pool created on QuickSwap V3',
      ...result,
      explorer_url: `https://polygonscan.com/address/${result.poolAddress}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /pool/add-liquidity — Add DLBT + USDC to pool --------------------

router.post('/pool/add-liquidity', async (req, res) => {
  try {
    const { wallet_id, dlbt_amount, usdc_amount } = req.body;
    if (!dlbt_amount || !usdc_amount) {
      return res.status(400).json({ error: 'Required: dlbt_amount, usdc_amount' });
    }

    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.status(400).json({ error: 'DLBT token not deployed yet' });

    const cfg     = new CDKConfigManager(req.db);
    const network = cfg.get('network') || 'MATIC';
    const wId     = wallet_id || cfg.get('deployer_wallet_id');
    if (!wId) return res.status(400).json({ error: 'No deployer wallet configured' });

    const signer = getSigner(req.db, parseInt(wId), network);
    const pool   = new LiquidityPoolManager(req.db);
    const result = await pool.addLiquidity(signer, token.contract_address, dlbt_amount, usdc_amount);

    res.json({ message: 'Liquidity added to DLBT/USDC pool', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST /pool/swap — Swap DLBT ↔ USDC ------------------------------------

router.post('/pool/swap', async (req, res) => {
  try {
    const { wallet_id, direction, amount } = req.body;
    if (!direction || !amount) {
      return res.status(400).json({ error: 'Required: direction (dlbt_to_usdc or usdc_to_dlbt), amount' });
    }
    if (!['dlbt_to_usdc', 'usdc_to_dlbt'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be dlbt_to_usdc or usdc_to_dlbt' });
    }

    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.status(400).json({ error: 'DLBT token not deployed yet' });

    const cfg     = new CDKConfigManager(req.db);
    const network = cfg.get('network') || 'MATIC';
    const wId     = wallet_id || cfg.get('deployer_wallet_id');
    if (!wId) return res.status(400).json({ error: 'No deployer wallet configured' });

    const signer = getSigner(req.db, parseInt(wId), network);
    const pool   = new LiquidityPoolManager(req.db);

    let result;
    if (direction === 'dlbt_to_usdc') {
      result = await pool.swapDLBTtoUSDC(signer, token.contract_address, amount);
    } else {
      result = await pool.swapUSDCtoDLBT(signer, token.contract_address, amount);
    }

    res.json({ message: `Swap completed: ${direction.replace('_', ' → ').replace('_', ' ')}`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GET /pool — Pool info --------------------------------------------------

router.get('/pool', async (req, res) => {
  try {
    const mgr   = new ContractManager(req.db);
    const token = mgr.getDeployedToken();
    if (!token) return res.json({ exists: false, message: 'DLBT token not deployed yet' });

    const pool     = new LiquidityPoolManager(req.db);
    const poolInfo = await pool.getPoolInfo(token.contract_address);
    const dbPool   = pool.getPool();
    const positions = pool.getPositions();

    res.json({
      ...poolInfo,
      db_pool: dbPool || null,
      positions: positions || [],
      usdc_address: USDC_POLYGON,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

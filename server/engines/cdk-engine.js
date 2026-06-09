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
  // Must match blockchain-engine.js key derivation (scrypt with salt)
  const key     = crypto.scryptSync(passphrase, 'dlbtrust-wallet-keys', 32);
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

// --- Liquidity Pool Manager (QuickSwap V3 / Algebra on Polygon) -------------

const QUICKSWAP_FACTORY   = '0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28';
const QUICKSWAP_NFPM      = '0x8eF88E4c7CfbbaC1C163f7eddd4B578792201de6';
const QUICKSWAP_ROUTER    = '0xf5b509bB0909a69B1c207E495f687a596C168E12';
const USDC_POLYGON        = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const WPOL_ADDRESS        = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';

const ALGEBRA_FACTORY_ABI = [
  'function createPool(address tokenA, address tokenB) external returns (address pool)',
  'function poolByPair(address tokenA, address tokenB) external view returns (address pool)',
];

const ALGEBRA_POOL_ABI = [
  'function globalState() external view returns (uint160 price, int24 tick, uint16 fee, uint8 pluginConfig, uint16 communityFee, bool unlocked)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function liquidity() external view returns (uint128)',
  'function initialize(uint160 initialPrice) external',
];

const NFPM_ABI = [
  'function mint((address token0, address token1, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

const SWAP_ROUTER_ABI_V3 = [
  'function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

class LiquidityPoolManager {
  constructor(db) { this.db = db; }

  // Create DLBT/USDC pool on QuickSwap V3
  async createPool(signer, dlbtTokenAddress) {
    const factory = new ethers.Contract(QUICKSWAP_FACTORY, ALGEBRA_FACTORY_ABI, signer);

    // Check if pool already exists
    const existing = await factory.poolByPair(dlbtTokenAddress, USDC_POLYGON);
    if (existing !== '0x0000000000000000000000000000000000000000') {
      return { poolAddress: existing, alreadyExists: true };
    }

    // Create the pool
    const tx = await factory.createPool(dlbtTokenAddress, USDC_POLYGON);
    const receipt = await tx.wait();

    // Get pool address from event or re-query
    const poolAddress = await factory.poolByPair(dlbtTokenAddress, USDC_POLYGON);

    // Initialize pool at 1:1 price (DLBT = $1 = 1 USDC)
    // Both tokens have 6 decimals, so 1:1 ratio
    // sqrtPriceX96 for 1:1 = 2^96 = 79228162514264337593543950336
    const pool = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, signer);
    const token0 = await pool.token0();

    // If DLBT is token0, price is USDC/DLBT = 1.0 → sqrtPriceX96 = 2^96
    // If USDC is token0, price is DLBT/USDC = 1.0 → sqrtPriceX96 = 2^96
    // Both 6 decimals, 1:1, so sqrtPriceX96 = 2^96 regardless
    const sqrtPriceX96 = 79228162514264337593543950336n;
    const initTx = await pool.initialize(sqrtPriceX96);
    await initTx.wait();

    // Store in DB
    this.db.prepare(`
      INSERT INTO cdk_liquidity_pools (pool_address, token0_address, token1_address, dlbt_address, usdc_address, dex_name, status, create_tx_hash, init_tx_hash)
      VALUES (?, ?, ?, ?, ?, 'QuickSwap V3', 'active', ?, ?)
    `).run(
      poolAddress,
      token0,
      token0.toLowerCase() === dlbtTokenAddress.toLowerCase() ? USDC_POLYGON : dlbtTokenAddress,
      dlbtTokenAddress,
      USDC_POLYGON,
      receipt.hash,
      initTx.hash
    );

    return {
      poolAddress,
      token0,
      token1: token0.toLowerCase() === dlbtTokenAddress.toLowerCase() ? USDC_POLYGON : dlbtTokenAddress,
      createTxHash: receipt.hash,
      initTxHash: initTx.hash,
      alreadyExists: false,
    };
  }

  // Add liquidity to DLBT/USDC pool
  async addLiquidity(signer, dlbtTokenAddress, amountDLBT, amountUSDC) {
    const factory = new ethers.Contract(QUICKSWAP_FACTORY, ALGEBRA_FACTORY_ABI, signer);
    const poolAddress = await factory.poolByPair(dlbtTokenAddress, USDC_POLYGON);
    if (poolAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('Pool does not exist. Create pool first.');
    }

    const pool = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, signer);
    const token0 = await pool.token0();
    const isToken0DLBT = token0.toLowerCase() === dlbtTokenAddress.toLowerCase();

    const dlbtAmount = ethers.parseUnits(amountDLBT.toString(), 6);
    const usdcAmount = ethers.parseUnits(amountUSDC.toString(), 6);

    // Approve NFPM to spend both tokens
    const dlbtContract = new ethers.Contract(dlbtTokenAddress, ERC20_ABI, signer);
    const usdcContract = new ethers.Contract(USDC_POLYGON, ERC20_ABI, signer);

    const approveDLBT = await dlbtContract.approve(QUICKSWAP_NFPM, dlbtAmount);
    await approveDLBT.wait();
    const approveUSDC = await usdcContract.approve(QUICKSWAP_NFPM, usdcAmount);
    await approveUSDC.wait();

    // Mint a liquidity position — full range (tick -887220 to 887220 for Algebra)
    const nfpm = new ethers.Contract(QUICKSWAP_NFPM, NFPM_ABI, signer);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    const amount0 = isToken0DLBT ? dlbtAmount : usdcAmount;
    const amount1 = isToken0DLBT ? usdcAmount : dlbtAmount;
    const token1 = isToken0DLBT ? USDC_POLYGON : dlbtTokenAddress;

    const mintTx = await nfpm.mint({
      token0,
      token1,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min: 0,
      amount1Min: 0,
      recipient: signer.address,
      deadline,
    });
    const receipt = await mintTx.wait();

    // Parse tokenId from Transfer event
    let tokenId = null;
    for (const log of receipt.logs) {
      try {
        if (log.topics[0] === ethers.id('Transfer(address,address,uint256)') && log.address.toLowerCase() === QUICKSWAP_NFPM.toLowerCase()) {
          tokenId = BigInt(log.topics[3]).toString();
        }
      } catch (_) {}
    }

    // Store in DB
    const opNum = generateOpNumber('LP');
    this.db.prepare(`
      INSERT INTO cdk_liquidity_positions (position_number, pool_address, nft_token_id, dlbt_amount, usdc_amount, tx_hash, status, owner_address)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(opNum, poolAddress, tokenId, amountDLBT.toString(), amountUSDC.toString(), receipt.hash, signer.address);

    return {
      positionNumber: opNum,
      tokenId,
      poolAddress,
      dlbtDeposited: amountDLBT.toString(),
      usdcDeposited: amountUSDC.toString(),
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  // Auto-fund pipeline: swap POL → USDC, then seed pool with minted DLBT + USDC
  // This swaps as much POL as available (minus gas reserve) into USDC and pairs with DLBT
  async autoFundFromPOL(signer, dlbtTokenAddress, amountUSD) {
    const provider = getProvider('MATIC');
    const results = { steps: [], totalUSDC: '0', poolFunded: false };

    // Step 1: Check POL balance
    const polBalance = await provider.getBalance(signer.address);
    const polBalanceEth = parseFloat(ethers.formatEther(polBalance));

    const wpolContract = new ethers.Contract(WPOL_ADDRESS, [
      'function deposit() payable',
      'function approve(address spender, uint256 amount) returns (bool)',
    ], signer);

    // Reserve 2 POL for future gas, swap the rest
    const gasReserve = 2.0;
    if (polBalanceEth < gasReserve + 1.0) {
      results.steps.push({ step: 'check_pol', status: 'insufficient', polBalance: polBalanceEth.toFixed(4), minRequired: (gasReserve + 1).toFixed(2) });
      return results;
    }

    // Swap available POL (minus gas reserve) — don't require full coupon amount
    const polToSwap = Math.floor((polBalanceEth - gasReserve) * 10) / 10; // round down to 0.1
    results.steps.push({ step: 'check_pol', status: 'ok', polBalance: polBalanceEth.toFixed(4), polToSwap: polToSwap.toFixed(2) });

    // Step 2: Wrap POL → WPOL
    const amountToSwap = ethers.parseEther(polToSwap.toFixed(1));
    const wrapTx = await wpolContract.deposit({ value: amountToSwap });
    await wrapTx.wait();
    results.steps.push({ step: 'wrap_pol', status: 'done', amount: polToSwap.toFixed(1) });

    // Step 3: Approve router to spend WPOL
    const approveTx = await wpolContract.approve(QUICKSWAP_ROUTER, amountToSwap);
    await approveTx.wait();
    results.steps.push({ step: 'approve_wpol', status: 'done' });

    // Step 4: Swap WPOL → USDC
    const router = new ethers.Contract(QUICKSWAP_ROUTER, SWAP_ROUTER_ABI_V3, signer);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const swapTx = await router.exactInputSingle({
      tokenIn: WPOL_ADDRESS,
      tokenOut: USDC_POLYGON,
      recipient: signer.address,
      deadline,
      amountIn: amountToSwap,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0n,
    });
    const swapReceipt = await swapTx.wait();

    // Check USDC received
    const usdcContract = new ethers.Contract(USDC_POLYGON, ERC20_ABI, provider);
    const usdcBalance = await usdcContract.balanceOf(signer.address);
    const usdcReceived = parseFloat(ethers.formatUnits(usdcBalance, 6));
    results.totalUSDC = usdcReceived.toFixed(6);
    results.steps.push({ step: 'swap_pol_usdc', status: 'done', usdcReceived: usdcReceived.toFixed(6), txHash: swapReceipt.hash });

    // Step 5: Add liquidity to pool (pair minted DLBT with swapped USDC)
    // Use the lesser of: USDC received or requested amount
    const amountToPool = Math.min(usdcReceived, amountUSD);
    if (amountToPool > 0.01) { // minimum threshold
      try {
        const poolResult = await this.addLiquidity(signer, dlbtTokenAddress, amountToPool, amountToPool);
        results.poolFunded = true;
        results.steps.push({ step: 'add_liquidity', status: 'done', dlbt: amountToPool.toFixed(6), usdc: amountToPool.toFixed(6), txHash: poolResult.txHash });
      } catch (poolErr) {
        results.steps.push({ step: 'add_liquidity', status: 'failed', error: poolErr.message });
      }
    }

    // Record operation
    const opNum = generateOpNumber('AUTOFUND');
    this.db.prepare(`
      INSERT INTO cdk_token_operations (operation_type, operation_number, wallet_address, amount_cents, token_amount, contract_address, tx_hash, status)
      VALUES ('auto_fund_pool', ?, ?, ?, ?, ?, ?, 'confirmed')
    `).run(opNum, signer.address, Math.round(amountToPool * 100), amountToPool.toFixed(6), dlbtTokenAddress, swapReceipt.hash);

    return results;
  }

  // Swap DLBT → USDC
  async swapDLBTtoUSDC(signer, dlbtTokenAddress, amountDLBT) {
    const dlbtContract = new ethers.Contract(dlbtTokenAddress, ERC20_ABI, signer);
    const amount = ethers.parseUnits(amountDLBT.toString(), 6);

    // Approve router
    const approveTx = await dlbtContract.approve(QUICKSWAP_ROUTER, amount);
    await approveTx.wait();

    // Swap
    const router = new ethers.Contract(QUICKSWAP_ROUTER, SWAP_ROUTER_ABI_V3, signer);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const swapTx = await router.exactInputSingle({
      tokenIn: dlbtTokenAddress,
      tokenOut: USDC_POLYGON,
      recipient: signer.address,
      deadline,
      amountIn: amount,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0n,
    });
    const receipt = await swapTx.wait();

    // Read USDC balance after swap
    const usdcContract = new ethers.Contract(USDC_POLYGON, ERC20_ABI, getProvider('MATIC'));
    const usdcBalance = await usdcContract.balanceOf(signer.address);

    const opNum = generateOpNumber('SWAP');
    this.db.prepare(`
      INSERT INTO cdk_token_operations (operation_type, operation_number, wallet_address, amount_cents, token_amount, contract_address, tx_hash, block_number, gas_used, status)
      VALUES ('swap_dlbt_usdc', ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
    `).run(opNum, signer.address, Math.round(parseFloat(amountDLBT) * 100), amountDLBT.toString(), dlbtTokenAddress, receipt.hash, receipt.blockNumber, receipt.gasUsed.toString());

    return {
      opNumber: opNum,
      txHash: receipt.hash,
      amountDLBTIn: amountDLBT.toString(),
      usdcBalanceAfter: ethers.formatUnits(usdcBalance, 6),
      gasUsed: receipt.gasUsed.toString(),
      explorerUrl: `https://polygonscan.com/tx/${receipt.hash}`,
    };
  }

  // Swap USDC → DLBT
  async swapUSDCtoDLBT(signer, dlbtTokenAddress, amountUSDC) {
    const usdcContract = new ethers.Contract(USDC_POLYGON, ERC20_ABI, signer);
    const amount = ethers.parseUnits(amountUSDC.toString(), 6);

    const approveTx = await usdcContract.approve(QUICKSWAP_ROUTER, amount);
    await approveTx.wait();

    const router = new ethers.Contract(QUICKSWAP_ROUTER, SWAP_ROUTER_ABI_V3, signer);
    const deadline = Math.floor(Date.now() / 1000) + 300;

    const swapTx = await router.exactInputSingle({
      tokenIn: USDC_POLYGON,
      tokenOut: dlbtTokenAddress,
      recipient: signer.address,
      deadline,
      amountIn: amount,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0n,
    });
    const receipt = await swapTx.wait();

    const dlbtContract = new ethers.Contract(dlbtTokenAddress, ERC20_ABI, getProvider('MATIC'));
    const dlbtBalance = await dlbtContract.balanceOf(signer.address);

    const opNum = generateOpNumber('SWAP');
    this.db.prepare(`
      INSERT INTO cdk_token_operations (operation_type, operation_number, wallet_address, amount_cents, token_amount, contract_address, tx_hash, block_number, gas_used, status)
      VALUES ('swap_usdc_dlbt', ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
    `).run(opNum, signer.address, Math.round(parseFloat(amountUSDC) * 100), amountUSDC.toString(), dlbtTokenAddress, receipt.hash, receipt.blockNumber, receipt.gasUsed.toString());

    return {
      opNumber: opNum,
      txHash: receipt.hash,
      amountUSDCIn: amountUSDC.toString(),
      dlbtBalanceAfter: ethers.formatUnits(dlbtBalance, 6),
      gasUsed: receipt.gasUsed.toString(),
      explorerUrl: `https://polygonscan.com/tx/${receipt.hash}`,
    };
  }

  // Get pool info
  async getPoolInfo(dlbtTokenAddress) {
    const factory = new ethers.Contract(QUICKSWAP_FACTORY, ALGEBRA_FACTORY_ABI, getProvider('MATIC'));
    const poolAddress = await factory.poolByPair(dlbtTokenAddress, USDC_POLYGON);

    if (poolAddress === '0x0000000000000000000000000000000000000000') {
      return { exists: false, poolAddress: null };
    }

    const pool = new ethers.Contract(poolAddress, ALGEBRA_POOL_ABI, getProvider('MATIC'));
    const [globalState, token0, liquidity] = await Promise.all([
      pool.globalState(),
      pool.token0(),
      pool.liquidity(),
    ]);

    const dlbtContract = new ethers.Contract(dlbtTokenAddress, ERC20_ABI, getProvider('MATIC'));
    const usdcContract = new ethers.Contract(USDC_POLYGON, ERC20_ABI, getProvider('MATIC'));
    const [dlbtInPool, usdcInPool] = await Promise.all([
      dlbtContract.balanceOf(poolAddress),
      usdcContract.balanceOf(poolAddress),
    ]);

    return {
      exists: true,
      poolAddress,
      token0,
      price: globalState[0].toString(),
      tick: Number(globalState[1]),
      fee: Number(globalState[2]),
      liquidity: liquidity.toString(),
      dlbtInPool: ethers.formatUnits(dlbtInPool, 6),
      usdcInPool: ethers.formatUnits(usdcInPool, 6),
      dex: 'QuickSwap V3',
      explorerUrl: `https://polygonscan.com/address/${poolAddress}`,
    };
  }

  // Get positions from DB
  getPositions(limit = 50) {
    return this.db.prepare('SELECT * FROM cdk_liquidity_positions ORDER BY id DESC LIMIT ?').all(limit);
  }

  // Get pool record from DB
  getPool() {
    return this.db.prepare("SELECT * FROM cdk_liquidity_pools WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  }
}

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

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
  LiquidityPoolManager,
  USDC_POLYGON,
};

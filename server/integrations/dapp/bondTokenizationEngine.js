'use strict';

/**
 * Bond Tokenization Engine
 *
 * Wraps the internal fixed-income/bond ledger and produces ERC-20 tokens
 * representing bond principal and accrued interest. In shadow mode it records
 * token mints in the local database; in live mode it deploys/mints via an
 * ERC-20 factory or direct BondToken contract, signed either by the dapp hot
 * wallet (DAPP_PRIVATE_KEY) or, with DAPP_SIGNER=thirdweb, by the Vault-held
 * thirdweb server wallet (ThirdwebChainSigner: no key on the host, gas
 * sponsored by the project).
 */

const { getConfig } = require('./config');
const { ThirdwebChainSigner } = require('./thirdwebChainSigner');
const fs = require('fs');
const path = require('path');

let pool;
try { pool = require('../bonds/pgPool'); } catch (e) { pool = null; }

let BondEngine;
try { BondEngine = require('../bonds/bondEngine').BondEngine; } catch (e) { BondEngine = null; }

let viem, chains, privateKeyToAccount;
try { viem = require('viem'); chains = require('viem/chains'); ({ privateKeyToAccount } = require('viem/accounts')); } catch (e) { viem = null; chains = null; privateKeyToAccount = null; }

function str(name, fallback = '') { return (process.env[name] || fallback).trim(); }
function bool(name, fallback = false) { const v = process.env[name]; return v ? String(v).toLowerCase() === 'true' : fallback; }
function num(name, fallback = 0) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : fallback; }

function id(prefix = 'BT') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; }

const memory = { tokens: new Map(), holdings: new Map() };

async function query(sql, params) {
  if (!pool) throw new Error('no database');
  return pool.query(sql, params);
}

async function ensureTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bond_tokens (
      id TEXT PRIMARY KEY,
      bond_id INTEGER,
      bond_name TEXT,
      token_name TEXT NOT NULL,
      token_symbol TEXT NOT NULL,
      token_address TEXT,
      total_supply NUMERIC NOT NULL DEFAULT 0,
      tokenized_principal NUMERIC NOT NULL DEFAULT 0,
      tokenized_interest NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bond_token_holders (
      id TEXT PRIMARY KEY,
      token_id TEXT REFERENCES bond_tokens(id) ON DELETE CASCADE,
      holder_address TEXT NOT NULL,
      balance NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(token_id, holder_address)
    );
  `);
}

function viemChain(chainId) {
  if (!chains) return undefined;
  return Object.values(chains).find((c) => c && typeof c === 'object' && Number(c.id) === Number(chainId)) || chains.sepolia;
}

function walletClient() {
  const cfg = getConfig();
  if (ThirdwebChainSigner.active()) return ThirdwebChainSigner.clients({ chainId: cfg.chainId });
  if (!viem) throw new Error('viem not installed');
  if (!cfg.privateKey) throw new Error('DAPP_PRIVATE_KEY not configured');
  const account = privateKeyToAccount(cfg.privateKey);
  const chain = viemChain(cfg.chainId);
  const fees = cfg.getFees ? (cfg.getFees() || { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') }) : { maxFeePerGas: viem.parseGwei('20'), maxPriorityFeePerGas: viem.parseGwei('0.5') };
  return {
    account,
    fees,
    wallet: viem.createWalletClient({ account, chain, transport: viem.http(cfg.rpcUrl) }),
    publicClient: viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) })
  };
}

function getBondTokenAbi() {
  const abiPath = str('BOND_TOKEN_ABI_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondToken_sol_BondToken.abi'));
  return JSON.parse(fs.readFileSync(abiPath, 'utf8'));
}

function getBondTokenBytecode() {
  const binPath = str('BOND_TOKEN_BYTECODE_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondToken_sol_BondToken.bin'));
  return '0x' + fs.readFileSync(binPath, 'utf8').trim();
}

const factoryAbi = [
  { type: 'function', name: 'createBondToken', inputs: [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }], outputs: [{ type: 'address' }], stateMutability: 'nonpayable' },
  { type: 'event', name: 'BondTokenCreated', inputs: [{ type: 'address', indexed: true, name: 'token' }, { type: 'string', name: 'name' }, { type: 'string', name: 'symbol' }, { type: 'uint256', name: 'initialSupply' }] }
];

class BondTokenizationEngine {
  static getConfig() {
    const cfg = getConfig();
    return {
      enabled: bool('BOND_TOKENIZATION_ENABLED', true),
      shadow: bool('BOND_TOKEN_SHADOW', cfg.dappShadow !== false ? true : cfg.dappShadow),
      factoryAddress: str('BOND_TOKEN_FACTORY', ''),
      bytecodePath: str('BOND_TOKEN_BYTECODE_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondToken_sol_BondToken.bin')),
      abiPath: str('BOND_TOKEN_ABI_PATH', path.join(process.cwd(), 'artifacts', 'contracts_BondToken_sol_BondToken.abi')),
      chainId: cfg.chainId,
      rpcUrl: cfg.rpcUrl,
      privateKey: cfg.privateKey,
      usdcAddress: cfg.usdcAddress,
    };
  }

  /** The wallet that holds unsold units and signs live mints, burns and transfers. */
  static operatorAddress() {
    if (ThirdwebChainSigner.active()) return ThirdwebChainSigner.address() || getConfig().operatorAddress || null;
    return getConfig().operatorAddress || null;
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    const signer = ThirdwebChainSigner.active() ? 'thirdweb' : 'private-key';
    if (!cfg.enabled) issues.push('BOND_TOKENIZATION_ENABLED is not true');
    if (!cfg.shadow) {
      if (signer === 'thirdweb') {
        issues.push(...ThirdwebChainSigner.readiness().issues);
      } else {
        if (!cfg.privateKey) issues.push('DAPP_PRIVATE_KEY not configured');
        if (!cfg.rpcUrl) issues.push('DAPP_RPC_URL not configured');
      }
      if (!cfg.factoryAddress && !fs.existsSync(cfg.bytecodePath)) issues.push('BOND_TOKEN_FACTORY or BOND_TOKEN_BYTECODE_PATH missing');
    }
    return { ready: issues.length === 0, mode: cfg.shadow ? 'shadow' : 'live', signer, operator: this.operatorAddress(), chainId: cfg.chainId, issues };
  }

  /**
   * The bond that stands behind a token nobody named one for.
   *
   * A token with no bond can only be governed by a number in config, and an
   * unbacked token is a claim on nothing. TOKEN_DEFAULT_BACKING_BOND names the
   * bond every new token stands on instead, so DLBUSD and the module tokens
   * share one ledger-derived ceiling rather than each inventing their own.
   */
  static async defaultBackingBondId() {
    const reference = str('TOKEN_DEFAULT_BACKING_BOND', '');
    if (!reference) return null;
    const { CapControlEngine } = require('../os/capControlEngine');
    const bond = await CapControlEngine.resolveBond(reference);
    return bond.id;
  }

  static async createToken({ bondId, tokenName, tokenSymbol, tokenAddress, decimals = 6 } = {}) {
    await ensureTable();
    const backingId = bondId || await this.defaultBackingBondId();
    let bond;
    if (backingId && BondEngine) {
      bond = await BondEngine.getBond(backingId);
    }
    bondId = backingId;
    const cfg = this.getConfig();
    const tokenId = id('BTOK');
    const record = {
      id: tokenId,
      bond_id: bondId || null,
      bond_name: bond ? bond.bond_name : `Bond ${bondId || 'custom'}`,
      token_name: tokenName || `${bond ? bond.bond_name : 'Bond'} Token`,
      token_symbol: tokenSymbol || (bond ? `DLB${bond.id}` : 'DLBBOND'),
      token_address: tokenAddress || (cfg.shadow ? `shadow-${tokenId}` : ''),
      total_supply: 0,
      tokenized_principal: 0,
      tokenized_interest: 0,
      status: 'active',
      metadata: JSON.stringify({ shadow: cfg.shadow, chainId: cfg.chainId, decimals }),
    };

    if (!cfg.shadow && !tokenAddress && ThirdwebChainSigner.active()) {
      const deployed = await ThirdwebChainSigner.deployBondToken({ name: record.token_name, symbol: record.token_symbol, chainId: cfg.chainId });
      record.token_address = deployed.address;
      record.metadata = JSON.stringify({
        shadow: false, chainId: cfg.chainId, decimals, signer: 'thirdweb',
        factory: deployed.factory, deployTx: deployed.transactionHash, deployTransactionId: deployed.transactionId,
        owner: ThirdwebChainSigner.address(),
      });
    } else if (!cfg.shadow && !tokenAddress) {
      const { wallet, publicClient, fees } = walletClient();
      const abi = getBondTokenAbi();
      const bytecode = getBondTokenBytecode();
      const hash = await wallet.deployContract({
        abi,
        bytecode,
        args: [record.token_name, record.token_symbol, 0],
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`bond token deploy failed: ${receipt.transactionHash}`);
      record.token_address = receipt.contractAddress;
    }

    if (pool) {
      await pool.query(
        `INSERT INTO bond_tokens (id, bond_id, bond_name, token_name, token_symbol, token_address, total_supply, tokenized_principal, tokenized_interest, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [record.id, record.bond_id, record.bond_name, record.token_name, record.token_symbol, record.token_address, record.total_supply, record.tokenized_principal, record.tokenized_interest, record.status, record.metadata]
      );
    } else {
      memory.tokens.set(tokenId, record);
    }
    return record;
  }

  static async listTokens() {
    await ensureTable();
    if (pool) {
      const res = await pool.query('SELECT * FROM bond_tokens ORDER BY created_at DESC');
      return res.rows;
    }
    return Array.from(memory.tokens.values());
  }

  static async getToken(tokenId) {
    await ensureTable();
    if (pool) {
      const res = await pool.query('SELECT * FROM bond_tokens WHERE id = $1', [tokenId]);
      if (!res.rows.length) throw new Error('Token not found');
      return res.rows[0];
    }
    const t = memory.tokens.get(tokenId);
    if (!t) throw new Error('Token not found');
    return t;
  }

  /**
   * Put a bond behind a token that had none.
   *
   * DLBUSD and the module tokens were created without a bond, which left them
   * governed by a number in configuration rather than by anything the trust
   * owns. Attaching the bond moves them under its live ceiling, where they
   * share capacity with every other token standing on it: the bond can back a
   * hundred million dollars of claims in total, not a hundred million each.
   *
   * Backing creates no supply, so it is not an issuance — but it can only be
   * done where the bond can actually carry what the token has already issued.
   */
  static async attachBacking({ tokenId, bondReference, attachedBy = null } = {}) {
    await ensureTable();
    const { CapControlEngine, CapControlError } = require('../os/capControlEngine');
    const token = await this.getToken(tokenId);
    const assessment = await CapControlEngine.assertBackable({ tokenId: token.id, bondReference });
    if (
      token.bond_id !== null && token.bond_id !== undefined
      && Number(token.bond_id) !== Number(assessment.bond.id)
    ) {
      throw new CapControlError(
        `${token.token_symbol || token.id} is already backed by bond ${token.bond_id};`
        + ' moving live supply onto another bond would leave the first one backing nothing',
        'CAP_CONTROL_ALREADY_BACKED'
      );
    }

    const metadata = {
      ...(token.metadata && typeof token.metadata === 'object' ? token.metadata : {}),
      backing: {
        bondId: assessment.bond.id,
        bondReference: String(bondReference),
        attachedBy: attachedBy ? String(attachedBy) : null,
        attachedAt: new Date().toISOString(),
      },
    };

    if (pool) {
      const updated = await pool.query(
        `UPDATE bond_tokens
            SET bond_id = $2, bond_name = $3, metadata = $4::jsonb, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [token.id, assessment.bond.id, assessment.bond.name, JSON.stringify(metadata)]
      );
      return { token: updated.rows[0], backing: assessment };
    }
    token.bond_id = assessment.bond.id;
    token.bond_name = assessment.bond.name;
    token.metadata = metadata;
    memory.tokens.set(token.id, token);
    return { token, backing: assessment };
  }

  /**
   * Minting is an authorised act, not an argument. The amount comes from an
   * issuance ticket two trustees agreed to, checked against what the bond
   * actually backs; calling this with a number is how $100m of token ends up
   * standing on a bond worth less than that.
   */
  static async mint({ issuanceId, mintedBy = null } = {}) {
    const { MintExchangeOsEngine } = require('../os/mintExchangeOsEngine');
    return MintExchangeOsEngine.mint({ issuanceId, mintedBy });
  }

  /**
   * The mint itself, once Cap Control, Integrity Control and Issuance OS have
   * all agreed to it. Not a public entry point: it performs no checks of its
   * own, which is exactly why only Mint & Exchange OS may call it.
   */
  static async applyMint({ tokenId, principal, interest, holderAddress } = {}) {
    await ensureTable();
    const token = await this.getToken(tokenId);
    if (token.status !== 'active') throw new Error('Token not active');
    const principalNum = Number(principal) || 0;
    const interestNum = Number(interest) || 0;
    const amount = principalNum + interestNum;
    if (amount <= 0) throw new Error('amount must be positive');

    token.total_supply = Number(token.total_supply || 0) + amount;
    token.tokenized_principal = Number(token.tokenized_principal || 0) + principalNum;
    token.tokenized_interest = Number(token.tokenized_interest || 0) + interestNum;
    token.updated_at = new Date().toISOString();

    const cfg = this.getConfig();
    const target = holderAddress || 'treasury';
    let txHash = null;

    if (!cfg.shadow) {
      if (!token.token_address || token.token_address.startsWith('shadow-')) throw new Error('token has no on-chain address');
      // A pseudo-holder such as 'treasury' has no address; the units land in the operator wallet.
      const onChainHolder = /^0x[0-9a-fA-F]{40}$/.test(String(target)) ? target : this.operatorAddress();
      if (!onChainHolder) throw new Error(`holder ${target} has no on-chain address and no operator wallet is configured`);
      const { wallet, publicClient, fees } = walletClient();
      const abi = getBondTokenAbi();
      const decimals = (token.metadata && token.metadata.decimals) ? token.metadata.decimals : 6;
      const raw = viem.parseUnits(String(amount), decimals);
      const hash = await wallet.writeContract({
        address: token.token_address,
        abi,
        functionName: 'mint',
        args: [onChainHolder, raw],
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`mint failed: ${receipt.transactionHash}`);
      txHash = receipt.transactionHash;
    }

    if (pool) {
      await pool.query('UPDATE bond_tokens SET total_supply = $1, tokenized_principal = $2, tokenized_interest = $3, updated_at = NOW() WHERE id = $4', [token.total_supply, token.tokenized_principal, token.tokenized_interest, tokenId]);
      await pool.query(
        `INSERT INTO bond_token_holders (id, token_id, holder_address, balance) VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_id, holder_address) DO UPDATE SET balance = bond_token_holders.balance + $4, updated_at = NOW()`,
        [id('BTH'), tokenId, target, amount]
      );
    } else {
      memory.tokens.set(tokenId, token);
      const key = `${tokenId}:${target}`;
      const h = memory.holdings.get(key) || { id: id('BTH'), token_id: tokenId, holder_address: target, balance: 0 };
      h.balance += amount;
      memory.holdings.set(key, h);
    }

    return { token, minted: amount, principal: principalNum, interest: interestNum, holder: target, txHash };
  }

  /**
   * The burn itself, once Mint & Exchange OS has an approved movement. Supply
   * and the holder's balance fall together, so the register never accounts for
   * token that no longer exists.
   */
  static async applyBurn({ tokenId, principal, interest, holderAddress } = {}) {
    await ensureTable();
    const token = await this.getToken(tokenId);
    const principalNum = Number(principal) || 0;
    const interestNum = Number(interest) || 0;
    const amount = principalNum + interestNum;
    if (amount <= 0) throw new Error('amount must be positive');
    const target = holderAddress || 'treasury';

    const supply = Number(token.total_supply || 0);
    if (amount > supply) throw new Error(`cannot burn ${amount}: supply is ${supply}`);

    const cfg = this.getConfig();
    let txHash = null;
    if (!cfg.shadow) {
      if (!token.token_address || token.token_address.startsWith('shadow-')) throw new Error('token has no on-chain address');
      // BondToken.burn spends the caller's own balance, so the contract can only
      // retire token the operator wallet holds. Anyone else has to transfer it
      // back first; burning their balance in the ledger alone would leave the
      // chain and the books disagreeing, which is the thing this exists to stop.
      const operator = this.operatorAddress() || '';
      if (!operator || String(target).toLowerCase() !== String(operator).toLowerCase()) {
        throw new Error(`on-chain burn is only possible from the operator wallet ${operator || '(unset)'}, not ${target}`);
      }
      const { wallet, publicClient, fees } = walletClient();
      const abi = getBondTokenAbi();
      const decimals = (token.metadata && token.metadata.decimals) ? token.metadata.decimals : 6;
      const raw = viem.parseUnits(String(amount), decimals);
      const hash = await wallet.writeContract({
        address: token.token_address,
        abi,
        functionName: 'burn',
        args: [raw],
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`burn failed: ${receipt.transactionHash}`);
      txHash = receipt.transactionHash;
    }

    token.total_supply = supply - amount;
    token.tokenized_principal = Math.max(0, Number(token.tokenized_principal || 0) - principalNum);
    token.tokenized_interest = Math.max(0, Number(token.tokenized_interest || 0) - interestNum);
    token.updated_at = new Date().toISOString();

    if (pool) {
      // The holder is debited first: a supply reduction with no holding behind
      // it is exactly the drift Integrity Control exists to catch.
      const updated = await pool.query(
        `UPDATE bond_token_holders SET balance = balance - $3, updated_at = NOW()
          WHERE token_id = $1 AND holder_address = $2 AND balance >= $3
          RETURNING balance`,
        [tokenId, target, amount]
      );
      if (!updated.rows.length) throw new Error(`${target} does not hold ${amount} of ${tokenId}`);
      await pool.query('UPDATE bond_tokens SET total_supply = $1, tokenized_principal = $2, tokenized_interest = $3, updated_at = NOW() WHERE id = $4', [token.total_supply, token.tokenized_principal, token.tokenized_interest, tokenId]);
    } else {
      const key = `${tokenId}:${target}`;
      const h = memory.holdings.get(key);
      if (!h || h.balance < amount) throw new Error(`${target} does not hold ${amount} of ${tokenId}`);
      h.balance -= amount;
      memory.holdings.set(key, h);
      memory.tokens.set(tokenId, token);
    }

    return { token, burned: amount, principal: principalNum, interest: interestNum, holder: target, txHash };
  }

  /**
   * Move existing units from the operator wallet to a holder. Supply does not
   * change; the register moves the balance between the two holders in step
   * with the ERC-20 transfer, so a subscription delivery never leaves the
   * chain and the books disagreeing.
   */
  static async applyTransfer({ tokenId, amount, toAddress, fromAddress } = {}) {
    await ensureTable();
    const token = await this.getToken(tokenId);
    if (token.status !== 'active') throw new Error('Token not active');
    const units = Number(amount) || 0;
    if (units <= 0) throw new Error('amount must be positive');
    if (!toAddress || !/^0x[0-9a-fA-F]{40}$/.test(String(toAddress))) throw new Error('toAddress must be an EVM address');
    const cfg = this.getConfig();
    const from = fromAddress || this.operatorAddress() || 'treasury';
    let txHash = null;

    if (!cfg.shadow) {
      if (!token.token_address || token.token_address.startsWith('shadow-')) throw new Error('token has no on-chain address');
      const operator = this.operatorAddress() || '';
      if (!operator || String(from).toLowerCase() !== operator.toLowerCase()) {
        throw new Error(`on-chain transfer is only possible from the operator wallet ${operator || '(unset)'}, not ${from}`);
      }
      const { wallet, publicClient, fees } = walletClient();
      const abi = getBondTokenAbi();
      const decimals = (token.metadata && token.metadata.decimals) ? token.metadata.decimals : 6;
      const raw = viem.parseUnits(String(units), decimals);
      const hash = await wallet.writeContract({
        address: token.token_address,
        abi,
        functionName: 'transfer',
        args: [toAddress, raw],
        ...fees,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
      if (receipt.status !== 'success') throw new Error(`transfer failed: ${receipt.transactionHash}`);
      txHash = receipt.transactionHash;
    }

    if (pool) {
      const debited = await pool.query(
        `UPDATE bond_token_holders SET balance = balance - $3, updated_at = NOW()
          WHERE token_id = $1 AND holder_address = $2 AND balance >= $3
          RETURNING balance`,
        [tokenId, from, units]
      );
      if (!debited.rows.length) throw new Error(`${from} does not hold ${units} of ${tokenId}`);
      await pool.query(
        `INSERT INTO bond_token_holders (id, token_id, holder_address, balance) VALUES ($1, $2, $3, $4)
         ON CONFLICT (token_id, holder_address) DO UPDATE SET balance = bond_token_holders.balance + $4, updated_at = NOW()`,
        [id('BTH'), tokenId, toAddress, units]
      );
    } else {
      const src = memory.holdings.get(`${tokenId}:${from}`);
      if (!src || src.balance < units) throw new Error(`${from} does not hold ${units} of ${tokenId}`);
      src.balance -= units;
      const key = `${tokenId}:${toAddress}`;
      const dst = memory.holdings.get(key) || { id: id('BTH'), token_id: tokenId, holder_address: toAddress, balance: 0 };
      dst.balance += units;
      memory.holdings.set(key, dst);
    }

    return { token, transferred: units, from, to: toAddress, txHash };
  }

  /**
   * What the contract itself says exists. Only meaningful in live mode against
   * a deployed address; a shadow token has no contract to ask.
   */
  static async chainSupply(tokenId) {
    const token = await this.getToken(tokenId);
    if (!token.token_address || String(token.token_address).startsWith('shadow-')) {
      throw new Error('token has no on-chain address');
    }
    const { publicClient } = walletClient();
    const abi = getBondTokenAbi();
    const decimals = (token.metadata && token.metadata.decimals) ? token.metadata.decimals : 6;
    const raw = await publicClient.readContract({
      address: token.token_address,
      abi,
      functionName: 'totalSupply',
      args: [],
    });
    return Number(viem.formatUnits(raw, decimals));
  }

  static async getHoldings(tokenId) {
    await ensureTable();
    if (pool) {
      const res = await pool.query('SELECT * FROM bond_token_holders WHERE token_id = $1', [tokenId]);
      return res.rows;
    }
    return Array.from(memory.holdings.values()).filter(h => h.token_id === tokenId);
  }

  static async getTokenByBondId(bondId) {
    await ensureTable();
    if (pool) {
      const res = await pool.query("SELECT * FROM bond_tokens WHERE bond_id = $1 AND token_address IS NOT NULL AND token_address <> '' AND token_address NOT LIKE 'shadow-%' ORDER BY created_at DESC LIMIT 1", [bondId]);
      if (res.rows.length) return res.rows[0];
      return null;
    }
    return Array.from(memory.tokens.values()).find(t => t.bond_id === bondId && t.token_address && !t.token_address.startsWith('shadow-')) || null;
  }

  static async getTokenBySymbol(tokenSymbol) {
    await ensureTable();
    if (pool) {
      const res = await pool.query("SELECT * FROM bond_tokens WHERE token_symbol = $1 AND token_address IS NOT NULL AND token_address <> '' AND token_address NOT LIKE 'shadow-%' ORDER BY created_at DESC LIMIT 1", [tokenSymbol.toUpperCase()]);
      if (res.rows.length) return res.rows[0];
      return null;
    }
    return Array.from(memory.tokens.values()).find(t => String(t.token_symbol).toUpperCase() === tokenSymbol.toUpperCase() && t.token_address && !t.token_address.startsWith('shadow-')) || null;
  }

  static async getTokenByAddress(tokenAddress) {
    await ensureTable();
    const addr = String(tokenAddress || '').toLowerCase();
    if (!addr) return null;
    if (pool) {
      const res = await pool.query("SELECT * FROM bond_tokens WHERE LOWER(token_address) = $1 AND token_address IS NOT NULL AND token_address <> '' AND token_address NOT LIKE 'shadow-%' LIMIT 1", [addr]);
      if (res.rows.length) return res.rows[0];
      return null;
    }
    return Array.from(memory.tokens.values()).find(t => String(t.token_address || '').toLowerCase() === addr && t.token_address && !t.token_address.startsWith('shadow-')) || null;
  }

  /**
   * Where a token row actually lives relative to the deployed chain: an
   * `on_chain` token is a live contract on the configured chain, `foreign_chain`
   * a contract elsewhere (testnet leftovers), `shadow` a ledger-only record.
   */
  static classifyToken(token, chainId = this.getConfig().chainId) {
    const address = String((token && token.token_address) || '');
    if (!address || address.startsWith('shadow-')) return 'shadow';
    const meta = (token && token.metadata) || {};
    const tokenChain = Number(meta.chainId);
    if (Number.isFinite(tokenChain) && tokenChain !== Number(chainId)) return 'foreign_chain';
    return 'on_chain';
  }

  static _mergeMetadata(token, patch) {
    const meta = (token.metadata && typeof token.metadata === 'object') ? token.metadata : {};
    return { ...meta, ...patch };
  }

  /**
   * Close a token's register entry. Only a record with no live claim behind it
   * can be retired this way: a shadow or foreign-chain token never held trust
   * value on the deployed chain, and an on-chain token qualifies only once the
   * contract itself reports zero supply. Anything else still has to be burned.
   */
  static async retire({ tokenId, reason, retiredBy = null } = {}) {
    await ensureTable();
    const token = await this.getToken(tokenId);
    if (token.status === 'retired') throw new Error(`${tokenId} is already retired`);
    const why = String(reason || '').trim();
    if (!why) throw new Error('reason is required to retire a token');

    const placement = this.classifyToken(token);
    let chainSupply = null;
    if (placement === 'on_chain') {
      chainSupply = await this.chainSupply(tokenId);
      if (chainSupply > 0) {
        throw new Error(`${token.token_symbol} still has ${chainSupply} in circulation on chain; burn it before retiring`);
      }
    }

    const writtenOff = {
      total_supply: Number(token.total_supply || 0),
      tokenized_principal: Number(token.tokenized_principal || 0),
      tokenized_interest: Number(token.tokenized_interest || 0),
    };
    const metadata = this._mergeMetadata(token, {
      retired: { reason: why, retiredBy, at: new Date().toISOString(), placement, chainSupply, writtenOff },
    });

    if (pool) {
      await pool.query(
        `UPDATE bond_tokens SET status = 'retired', total_supply = 0, tokenized_principal = 0, tokenized_interest = 0,
                metadata = $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [tokenId, JSON.stringify(metadata)]
      );
      await pool.query('UPDATE bond_token_holders SET balance = 0, updated_at = NOW() WHERE token_id = $1', [tokenId]);
    } else {
      memory.tokens.set(tokenId, { ...token, status: 'retired', total_supply: 0, tokenized_principal: 0, tokenized_interest: 0, metadata });
      for (const [key, h] of memory.holdings) if (h.token_id === tokenId) memory.holdings.set(key, { ...h, balance: 0 });
    }
    return { token: await this.getToken(tokenId), placement, chainSupply, writtenOff };
  }

  /**
   * Make the register agree with the contract. The contract is the instrument;
   * when the two differ the ledger is what moves. The delta lands on principal
   * (interest is only ever tokenized deliberately) and on the largest holding,
   * which for every trust token is the operator wallet.
   */
  static async syncSupplyFromChain({ tokenId, syncedBy = null } = {}) {
    await ensureTable();
    const token = await this.getToken(tokenId);
    if (this.classifyToken(token) !== 'on_chain') throw new Error(`${token.token_symbol} is not a contract on the deployed chain`);
    const chainSupply = await this.chainSupply(tokenId);
    const ledgerSupply = Number(token.total_supply || 0);
    const delta = Number((chainSupply - ledgerSupply).toFixed(8));
    if (delta === 0) return { token, chainSupply, ledgerSupply, delta: 0, changed: false };

    const totalSupply = chainSupply;
    const principal = Math.max(0, Number(token.tokenized_principal || 0) + delta);
    const interest = Number(token.tokenized_interest || 0);
    const metadata = this._mergeMetadata(token, {
      chainSync: { at: new Date().toISOString(), syncedBy, from: ledgerSupply, to: chainSupply, delta },
    });

    if (pool) {
      await pool.query(
        `UPDATE bond_tokens SET total_supply = $2, tokenized_principal = $3, tokenized_interest = $4, metadata = $5::jsonb, updated_at = NOW() WHERE id = $1`,
        [tokenId, totalSupply, principal, interest, JSON.stringify(metadata)]
      );
      const holder = await pool.query(
        'SELECT id FROM bond_token_holders WHERE token_id = $1 ORDER BY balance DESC LIMIT 1', [tokenId]
      );
      if (holder.rows.length) {
        await pool.query(
          'UPDATE bond_token_holders SET balance = GREATEST(0, balance + $2), updated_at = NOW() WHERE id = $1',
          [holder.rows[0].id, delta]
        );
      } else if (delta > 0) {
        await pool.query(
          'INSERT INTO bond_token_holders (id, token_id, holder_address, balance) VALUES ($1, $2, $3, $4)',
          [id('BTH'), tokenId, this.operatorAddress() || 'treasury', delta]
        );
      }
    } else {
      memory.tokens.set(tokenId, { ...token, total_supply: totalSupply, tokenized_principal: principal, tokenized_interest: interest, metadata });
      const holders = Array.from(memory.holdings.entries()).filter(([, h]) => h.token_id === tokenId).sort((a, b) => b[1].balance - a[1].balance);
      if (holders.length) memory.holdings.set(holders[0][0], { ...holders[0][1], balance: Math.max(0, holders[0][1].balance + delta) });
    }
    return { token: await this.getToken(tokenId), chainSupply, ledgerSupply, delta, changed: true };
  }

  /**
   * Keep supply tied to the bond as it amortizes. For each active token backed
   * by a bond on the deployed chain, ask Cap Control how much no longer has
   * principal behind it and raise that as a burn awaiting a second trustee —
   * never burn unattended. One open movement per token at a time.
   */
  static async syncSupplyToPrincipal({ initiatedBy = 'bond-token-supply-sync' } = {}) {
    const { MintExchangeOsEngine } = require('../os/mintExchangeOsEngine');
    const tokens = (await this.listTokens()).filter(t => t.status === 'active' && t.bond_id != null && this.classifyToken(t) === 'on_chain');
    const results = [];
    for (const token of tokens) {
      const entry = { tokenId: token.id, symbol: token.token_symbol, requiredCents: 0, action: 'none' };
      try {
        const required = await MintExchangeOsEngine.burnRequired(token.id);
        entry.requiredCents = required.requiredCents;
        if (required.requiredCents <= 0) { results.push(entry); continue; }
        const open = await MintExchangeOsEngine.list({ kind: 'burn', tokenId: token.id, limit: 50 });
        const pending = open.find(m => ['pending_approval', 'approved', 'executing'].includes(m.status));
        if (pending) { entry.action = 'pending'; entry.movementId = pending.movement_id; results.push(entry); continue; }
        const holder = required.holders.find(h => h.balanceCents >= required.requiredCents);
        if (!holder) { entry.action = 'no_holder_covers'; results.push(entry); continue; }
        const movement = await MintExchangeOsEngine.request({
          kind: 'burn',
          tokenId: token.id,
          holderAddress: holder.holderAddress,
          principalCents: required.principalCents,
          interestCents: required.interestCents,
          initiatedBy,
          memo: `supply sync: ${required.required} over the ${required.ceiling.basis} ceiling`,
        });
        entry.action = 'raised';
        entry.movementId = movement.movement_id;
      } catch (err) {
        entry.action = 'error';
        entry.error = err.message;
      }
      results.push(entry);
    }
    return { checked: tokens.length, results };
  }
}

module.exports = { BondTokenizationEngine };

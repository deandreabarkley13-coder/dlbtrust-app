'use strict';

/**
 * Runtime patch for viem/chains so that DApp engines targeting Base mainnet
 * (chainId 8453) resolve the correct chain object without editing every
 * `cfg.chainId === 1 ? mainnet : sepolia` ternary in the codebase.
 *
 * When DAPP_CHAIN_ID=8453, `require('viem/chains').mainnet` and `.sepolia`
 * both return the Base chain object. Other chain IDs are unaffected.
 */

const dotenv = require('dotenv');
dotenv.config();

const chains = require('viem/chains');
const chainId = Number(process.env.DAPP_CHAIN_ID || 1);

if (chainId === 8453) {
  const base = chains.base;
  if (base) {
    Object.defineProperty(chains, 'mainnet', {
      get: () => base,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(chains, 'sepolia', {
      get: () => base,
      enumerable: true,
      configurable: true,
    });
  }
}

module.exports = {};

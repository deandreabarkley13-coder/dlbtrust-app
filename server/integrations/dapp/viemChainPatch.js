'use strict';

/**
 * Runtime patch for viem/chains so that DApp engines targeting Base mainnet
 * (chainId 8453) resolve the correct chain object without editing every
 * `mainnet`/`sepolia` ternary in the codebase.
 *
 * When DAPP_CHAIN_ID=8453, `require('viem/chains').mainnet` and `.sepolia`
 * both return the Base chain object. Other chain IDs are unaffected.
 *
 * Implementation notes: instead of redefining properties on viem's CommonJS
 * exports object (which may be non-configurable in some builds or package
 * manager layouts), we replace the cached module export with a Proxy that
 * intercepts access to `mainnet`/`sepolia` and delegates everything else to
 * the original object. Failures are logged and swallowed so the server can
 * still start when viem is absent or the patch cannot be applied.
 */

try {
  const chains = require('viem/chains');
  if (!chains) return;

  const dotenv = require('dotenv');
  dotenv.config();

  const chainId = Number(process.env.DAPP_CHAIN_ID || 1);
  if (chainId !== 8453) return;

  const base = chains.base;
  if (!base) {
    console.warn('[viemChainPatch] Base chain not found in viem/chains; skipping patch');
    return;
  }

  const patched = new Proxy(chains, {
    get(target, prop, receiver) {
      if (prop === 'mainnet' || prop === 'sepolia') return base;
      return Reflect.get(target, prop, receiver);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
  });

  const cacheKey = require.resolve('viem/chains');
  const cached = require.cache[cacheKey];
  if (cached) {
    cached.exports = patched;
  } else {
    console.warn('[viemChainPatch] viem/chains module cache entry not found; Base chain patch NOT applied');
  }
} catch (err) {
  console.warn('[viemChainPatch] could not apply Base chain patch:', err && err.message);
}

module.exports = {};

'use strict';

const dotenv = require('dotenv');
dotenv.config();

function str(name, def = '') { return process.env[name] || def; }
function bool(name, def = false) { const v = process.env[name]; return v === 'true' || v === '1' || (v === undefined ? def : false); }
function num(name, def = 0) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }

const chainId = num('DAPP_CHAIN_ID', 1);
const rpcUrl = str('DAPP_RPC_URL', chainId === 1 ? 'https://ethereum.publicnode.com' : 'https://ethereum-sepolia-rpc.publicnode.com');

const wethAddress = str('DAPP_WETH_ADDRESS', chainId === 1 ? '0xC02b27E55a55d7e30F02e479463fF28b9fE5B873' : '0x7b79995e5f793A07Bc00c21412eF0E0661d51f4A');

const config = {
  dappEnabled: bool('DAPP_ENABLED', true),
  dappShadow: bool('DAPP_SHADOW', false),
  chainId,
  rpcUrl,
  privateKey: str('DAPP_PRIVATE_KEY', ''),
  defaultThreshold: num('DAPP_DEFAULT_THRESHOLD', 2),
  apiKitBase: str('DAPP_SAFE_API_KIT_BASE', chainId === 1 ? 'https://safe-transaction-mainnet.safe.global' : 'https://safe-transaction-sepolia.safe.global'),
  usdcAddress: str('DAPP_USDC_ADDRESS', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  wethAddress,
  nativeTokenSymbol: str('DAPP_NATIVE_TOKEN', 'ETH'),
  bondDexPoolAddress: str('BOND_DEX_ADDRESS', ''),
  supportedNetworks: ['ethereum', 'sepolia', 'polygon', 'arbitrum', 'base'],
};

module.exports = { getConfig: () => config };

'use strict';

const dotenv = require('dotenv');
dotenv.config();

function str(name, def = '') { return process.env[name] || def; }
function bool(name, def = false) { const v = process.env[name]; return v === 'true' || v === '1' || (v === undefined ? def : false); }
function num(name, def = 0) { const v = Number(process.env[name]); return Number.isFinite(v) ? v : def; }

const chainId = num('DAPP_CHAIN_ID', 1);
const alchemyApiKey = str('ALCHEMY_API_KEY', '');

function defaultRpcUrl(id) {
  if (alchemyApiKey) {
    if (id === 8453) return `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
    if (id === 1) return `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
    if (id === 137) return `https://polygon-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
    if (id === 42161) return `https://arb-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
  }
  if (id === 8453) return 'https://mainnet.base.org';
  if (id === 1) return 'https://ethereum.publicnode.com';
  return 'https://ethereum-sepolia-rpc.publicnode.com';
}

const rpcUrl = str('DAPP_RPC_URL', defaultRpcUrl(chainId));

const wethAddress = str('DAPP_WETH_ADDRESS',
  chainId === 8453 ? '0x4200000000000000000000000000000000000006'
    : chainId === 1 ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    : '0x7b79995e5f793a07bc00c21412ef0e0661d51f4a');

function getFees() {
  let viem;
  try { viem = require('viem'); } catch (e) { return null; }
  const maxFeeGwei = num('DAPP_MAX_FEE_GWEI', 3);
  const priorityFeeGwei = num('DAPP_PRIORITY_FEE_GWEI', 0.1);
  return {
    maxFeePerGas: viem.parseGwei(String(maxFeeGwei)),
    maxPriorityFeePerGas: viem.parseGwei(String(priorityFeeGwei)),
  };
}

const config = {
  dappEnabled: bool('DAPP_ENABLED', true),
  dappShadow: bool('DAPP_SHADOW', false),
  chainId,
  rpcUrl,
  privateKey: str('DAPP_PRIVATE_KEY', ''),
  operatorAddress: str('DAPP_OPERATOR_ADDRESS', ''),
  defaultThreshold: num('DAPP_DEFAULT_THRESHOLD', 2),
  apiKitBase: str('DAPP_SAFE_API_KIT_BASE',
    chainId === 8453 ? 'https://safe-transaction-base.safe.global'
      : chainId === 1 ? 'https://safe-transaction-mainnet.safe.global'
      : 'https://safe-transaction-sepolia.safe.global'),
  usdcAddress: str('DAPP_USDC_ADDRESS',
    chainId === 8453 ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      : '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  usdsAddress: str('DAPP_USDS_ADDRESS', '0xDC035D45d973eBD0d15FBD831697527719126F34'),
  daiAddress: str('DAPP_DAI_ADDRESS', '0x6B175474E89094C44Da98b954EedeAC495271d0F'),
  wethAddress,
  nativeTokenSymbol: str('DAPP_NATIVE_TOKEN', 'ETH'),
  bondDexPoolAddress: str('BOND_DEX_ADDRESS', ''),
  moduleP2PSwapAddress: str('MODULE_P2P_SWAP_ADDRESS', ''),
  coinbaseCdpKeyName: str('COINBASE_CDP_KEY_NAME', ''),
  coinbaseCdpPrivateKey: str('COINBASE_CDP_PRIVATE_KEY', ''),
  alchemyApiKey: str('ALCHEMY_API_KEY', ''),
  supportedNetworks: ['ethereum', 'sepolia', 'polygon', 'arbitrum', 'base'],
  getFees,
};

module.exports = { getConfig: () => config };

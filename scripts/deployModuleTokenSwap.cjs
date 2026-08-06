const fs = require('fs');
const path = require('path');
require('dotenv').config();
const viem = require('viem');
const { mainnet } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const abi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts_ModuleTokenSwap_sol_ModuleTokenSwap.abi'), 'utf8'));
const bytecode = '0x' + fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts_ModuleTokenSwap_sol_ModuleTokenSwap.bin'), 'utf8');

const privateKey = process.env.DAPP_PRIVATE_KEY;
if (!privateKey) { console.error('DAPP_PRIVATE_KEY missing'); process.exit(1); }

const account = privateKeyToAccount(privateKey);
const publicClient = viem.createPublicClient({ chain: mainnet, transport: viem.http(process.env.DAPP_RPC_URL) });
const walletClient = viem.createWalletClient({ account, chain: mainnet, transport: viem.http(process.env.DAPP_RPC_URL) });

(async () => {
  const hash = await walletClient.deployContract({ abi, bytecode, args: [] });
  console.log('deploy tx', hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
  console.log('contract address', receipt.contractAddress);
})();

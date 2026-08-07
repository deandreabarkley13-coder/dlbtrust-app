const fs = require('fs');
const path = require('path');
const solc = require('solc');

const contractPath = path.join(__dirname, '..', 'contracts', 'ModuleTokenSwap.sol');
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'ModuleTokenSwap.sol': { content: source },
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode'],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors) {
  for (const err of output.errors) {
    console.error(err.formattedMessage);
  }
}

const contract = output.contracts['ModuleTokenSwap.sol'].ModuleTokenSwap;
const abi = contract.abi;
const bytecode = contract.evm.bytecode.object;

const outDir = path.join(__dirname, '..', 'artifacts');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'contracts_ModuleTokenSwap_sol_ModuleTokenSwap.abi'), JSON.stringify(abi));
fs.writeFileSync(path.join(outDir, 'contracts_ModuleTokenSwap_sol_ModuleTokenSwap.bin'), bytecode);
console.log('Compiled ModuleTokenSwap');
console.log('Bytecode size:', bytecode.length / 2, 'bytes');

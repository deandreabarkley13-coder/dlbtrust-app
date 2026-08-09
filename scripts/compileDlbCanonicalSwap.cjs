const fs = require('fs');
const path = require('path');
const solc = require('solc');

const contractPath = path.join(__dirname, '..', 'contracts', 'DlbCanonicalSwap.sol');
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'DlbCanonicalSwap.sol': { content: source },
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode'],
      },
    },
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors) {
  for (const err of output.errors) {
    console.error(err.formattedMessage);
    if (err.severity === 'error') process.exit(1);
  }
}

const outDir = path.join(__dirname, '..', 'artifacts');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const contract = output.contracts['DlbCanonicalSwap.sol']['DlbCanonicalSwap'];
if (!contract) {
  console.error('DlbCanonicalSwap contract not found in output');
  process.exit(1);
}

fs.writeFileSync(path.join(outDir, 'contracts_DlbCanonicalSwap_sol_DlbCanonicalSwap.abi'), JSON.stringify(contract.abi));
fs.writeFileSync(path.join(outDir, 'contracts_DlbCanonicalSwap_sol_DlbCanonicalSwap.bin'), contract.evm.bytecode.object);
console.log('Compiled DlbCanonicalSwap — bytecode size:', contract.evm.bytecode.object.length / 2, 'bytes');

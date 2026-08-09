const fs = require('fs');
const path = require('path');
const solc = require('solc');

const contractPath = path.join(__dirname, '..', 'contracts', 'PtcStablecoinSystem.sol');
const source = fs.readFileSync(contractPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'PtcStablecoinSystem.sol': { content: source },
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

const contracts = output.contracts['PtcStablecoinSystem.sol'];
for (const name of ['PtcBackedStablecoin', 'PtcReserveVault']) {
  if (!contracts[name]) {
    console.error(`Contract ${name} not found in output`);
    process.exit(1);
  }
  const abi = contracts[name].abi;
  const bytecode = contracts[name].evm.bytecode.object;
  fs.writeFileSync(path.join(outDir, `contracts_PtcStablecoinSystem_sol_${name}.abi`), JSON.stringify(abi));
  fs.writeFileSync(path.join(outDir, `contracts_PtcStablecoinSystem_sol_${name}.bin`), bytecode);
  console.log(`Compiled ${name} — bytecode size:`, bytecode.length / 2, 'bytes');
}

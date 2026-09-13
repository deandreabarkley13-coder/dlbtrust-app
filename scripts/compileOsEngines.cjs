const fs = require('fs');
const path = require('path');
const solc = require('solc');

const TARGETS = [
  { file: 'StableAmmPool.sol', contracts: ['StableAmmPool'] },
  { file: 'FloorPriceRedemption.sol', contracts: ['FloorPriceRedemption'] },
];

const outDir = path.join(__dirname, '..', 'artifacts');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const target of TARGETS) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'contracts', target.file), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [target.file]: { content: source } },
    settings: {
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
      optimizer: { enabled: true, runs: 200 },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors) {
    for (const err of output.errors) {
      console.error(err.formattedMessage);
      if (err.severity === 'error') process.exit(1);
    }
  }
  const compiled = output.contracts[target.file];
  const base = target.file.replace(/\.sol$/, '');
  for (const name of target.contracts) {
    if (!compiled[name]) {
      console.error(`Contract ${name} not found in output`);
      process.exit(1);
    }
    const bytecode = compiled[name].evm.bytecode.object;
    fs.writeFileSync(path.join(outDir, `contracts_${base}_sol_${name}.abi`), JSON.stringify(compiled[name].abi));
    fs.writeFileSync(path.join(outDir, `contracts_${base}_sol_${name}.bin`), bytecode);
    console.log(`Compiled ${name} — bytecode size:`, bytecode.length / 2, 'bytes');
  }
}

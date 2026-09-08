/**
 * Compile TrustDistributionPolicy.sol (and the test-only mock ERC-20) into
 * artifacts/ using the pinned solc, matching the other contract build scripts.
 *
 *   node scripts/compileTrustDistributionPolicy.cjs
 */
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['TrustDistributionPolicy.sol', 'test/MockERC20.sol'];

const sources = {};
for (const rel of SOURCES) {
  const file = path.join(ROOT, 'contracts', rel);
  if (!fs.existsSync(file)) continue;
  sources[rel] = { content: fs.readFileSync(file, 'utf8') };
}

const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
  },
})));

const errors = (output.errors || []).filter((e) => e.severity === 'error');
for (const err of output.errors || []) console.error(err.formattedMessage);
if (errors.length) process.exit(1);

const outDir = path.join(ROOT, 'artifacts');
fs.mkdirSync(outDir, { recursive: true });

for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, contract] of Object.entries(contracts)) {
    if (!contract.evm.bytecode.object) continue;
    const base = `contracts_${file.replace(/[/.]/g, '_')}_${name}`;
    fs.writeFileSync(path.join(outDir, `${base}.abi`), JSON.stringify(contract.abi));
    fs.writeFileSync(path.join(outDir, `${base}.bin`), contract.evm.bytecode.object);
    console.log(`Compiled ${name} (${contract.evm.bytecode.object.length / 2} bytes)`);
  }
}

/**
 * Hardhat is used only to run a local EVM (`npx hardhat node`) for the contract
 * test suites; contracts are compiled by the scripts/compile*.cjs solc scripts.
 */
module.exports = {
  solidity: '0.8.28',
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
    },
  },
};

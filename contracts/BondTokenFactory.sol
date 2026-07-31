// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BondToken.sol";

contract BondTokenFactory {
    event BondTokenCreated(address indexed token, string name, string symbol, uint256 initialSupply);

    function createBondToken(string memory name, string memory symbol, uint256 initialSupply) external returns (address token) {
        token = address(new BondToken(name, symbol, initialSupply));
        BondToken(token).transferOwnership(msg.sender);
        emit BondTokenCreated(token, name, symbol, initialSupply);
    }

    function createAndMintBondToken(string memory name, string memory symbol, address holder, uint256 amount) external returns (address token) {
        token = address(new BondToken(name, symbol, 0));
        if (amount > 0 && holder != address(0)) {
            BondToken(token).mint(holder, amount);
        }
        BondToken(token).transferOwnership(msg.sender);
        emit BondTokenCreated(token, name, symbol, amount);
    }
}

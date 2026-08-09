// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@account-abstraction/contracts/legacy/v06/UserOperation06.sol";
import "@account-abstraction/contracts/legacy/v06/IPaymaster06.sol";
import "@account-abstraction/contracts/legacy/v06/IEntryPoint06.sol";

/**
 * Sovereign Trust Paymaster (ERC-4337 v0.6)
 *
 * Verifying paymaster that sponsors gas for whitelisted smart-account senders.
 * The owner signs a hash of the userOp (excluding paymasterAndData and signature)
 * off-chain; the contract recovers the signer and pays the gas from its
 * EntryPoint deposit.
 *
 * paymasterAndData layout:
 *   [0:20]  paymaster address
 *   [20:84] abi.encode(uint48 validUntil, uint48 validAfter)
 *   [84:]   65-byte ECDSA signature over the EIP-191 hash of getHash(userOp)
 *
 * This removes the need for end users to hold native ETH.
 */
contract SovereignTrustPaymaster is IPaymaster06 {
    address public immutable entryPoint;
    address public owner;
    mapping(address => bool) public whitelisted;

    uint256 private constant VALID_TIMESTAMP_OFFSET = 20;
    uint256 private constant SIGNATURE_OFFSET = 84;

    modifier onlyOwner() {
        require(msg.sender == owner, "SovereignTrustPaymaster: not owner");
        _;
    }

    modifier onlyEntryPoint() {
        require(msg.sender == entryPoint, "SovereignTrustPaymaster: not entryPoint");
        _;
    }

    constructor(address _entryPoint, address _owner) {
        require(_entryPoint != address(0), "SovereignTrustPaymaster: zero entryPoint");
        require(_owner != address(0), "SovereignTrustPaymaster: zero owner");
        entryPoint = _entryPoint;
        owner = _owner;
    }

    receive() external payable {}

    function setOwner(address _owner) external onlyOwner {
        require(_owner != address(0), "SovereignTrustPaymaster: zero owner");
        owner = _owner;
    }

    function setWhitelisted(address account, bool allowed) external onlyOwner {
        whitelisted[account] = allowed;
    }

    function batchWhitelist(address[] calldata accounts, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; i++) {
            whitelisted[accounts[i]] = allowed;
        }
    }

    /**
     * @notice Hash used by the off-chain service and on-chain verification.
     * Excludes paymasterAndData and signature, and hashes initCode/callData
     * to avoid circular dependencies on paymasterAndData. Includes a validity
     * window, the paymaster address, and chain ID to prevent replay.
     */
    function getHash(UserOperation06 calldata userOp, uint48 validUntil, uint48 validAfter) public view returns (bytes32) {
        // Exclude gas/fee fields and the paymasterAndData/signature so the
        // operator signature remains valid across bundler gas re-estimation.
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    function toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData) public pure returns (uint48 validUntil, uint48 validAfter, bytes calldata signature) {
        require(paymasterAndData.length >= SIGNATURE_OFFSET, "SovereignTrustPaymaster: bad paymasterAndData");
        // validityBytes are two 32-byte words with uint48 values padded to the right.
        // Read the low 48 bits of each word directly from the calldata slice.
        assembly {
            let start := add(paymasterAndData.offset, VALID_TIMESTAMP_OFFSET)
            validUntil := and(calldataload(start), 0xffffffffffff)
            validAfter := and(calldataload(add(start, 32)), 0xffffffffffff)
        }
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    function validatePaymasterUserOp(
        UserOperation06 calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 /*maxCost*/
    ) external override onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        require(whitelisted[userOp.sender], "SovereignTrustPaymaster: sender not whitelisted");

        (uint48 validUntil, uint48 validAfter, bytes calldata signature) = parsePaymasterAndData(userOp.paymasterAndData);
        require(signature.length == 64 || signature.length == 65, "SovereignTrustPaymaster: bad sig length");

        bytes32 hash = toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(add(signature.offset, 0))
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;

        address signer = ecrecover(hash, v, r, s);
        require(signer == owner, "SovereignTrustPaymaster: invalid signature");

        // Layout matches Helpers._parseValidationData: bits 0..159 aggregator (0 here),
        // bits 160..207 validUntil, bits 208..255 validAfter.
        uint256 validUntilBits = uint256(validUntil) << 160;
        uint256 validAfterBits = uint256(validAfter) << 208;
        validationData = validUntilBits | validAfterBits;

        return ("", validationData);
    }

    function postOp(PostOpMode, bytes calldata, uint256) external override onlyEntryPoint {}

    function deposit() external payable onlyOwner {
        IEntryPoint(entryPoint).depositTo{value: msg.value}(address(this));
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        (bool success, ) = to.call{value: amount}("");
        require(success, "SovereignTrustPaymaster: withdraw failed");
    }

    function stake(uint32 unstakeDelay) external payable onlyOwner {
        IEntryPoint(entryPoint).addStake{value: msg.value}(unstakeDelay);
    }
}

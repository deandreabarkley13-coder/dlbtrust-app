// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Minimal ERC-2771 trusted forwarder for gasless Sovereign Trust Token transfers.
 *
 * The relayer submits a signed ForwardRequest and pays the gas. The target
 * contract extracts the original signer from the appended address at the end
 * of the call data.
 */
contract SovereignTrustForwarder {
    struct ForwardRequest {
        address from;
        address to;
        uint256 value;
        uint256 gas;
        uint256 nonce;
        bytes data;
    }

    bytes32 private constant TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,bytes data)"
    );

    string public constant name = "SovereignTrustForwarder";
    string public constant version = "1";

    mapping(address => uint256) private _nonces;

    event MetaTransactionExecuted(address indexed from, address indexed to, bytes data, uint256 nonce, bool success);

    function getNonce(address from) public view returns (uint256) {
        return _nonces[from];
    }

    function execute(
        ForwardRequest calldata req,
        bytes calldata signature
    ) external payable returns (bool success, bytes memory returndata) {
        require(_verify(req, signature), "SovereignTrustForwarder: invalid signature");
        require(_nonces[req.from] == req.nonce, "SovereignTrustForwarder: invalid nonce");

        _nonces[req.from]++;

        (success, returndata) = req.to.call{gas: req.gas, value: req.value}(
            abi.encodePacked(req.data, req.from)
        );

        emit MetaTransactionExecuted(req.from, req.to, req.data, req.nonce, success);

        if (!success && returndata.length > 0) {
            assembly {
                revert(add(returndata, 32), mload(returndata))
            }
        }
    }

    function _verify(ForwardRequest calldata req, bytes calldata signature) internal view returns (bool) {
        bytes32 structHash = keccak256(
            abi.encode(
                TYPEHASH,
                req.from,
                req.to,
                req.value,
                req.gas,
                req.nonce,
                keccak256(req.data)
            )
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        if (signature.length != 65) return false;

        bytes32 r;
        bytes32 s;
        uint8 v;
        bytes memory sig = signature;

        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }

        if (v < 27) v += 27;

        address signer = ecrecover(digest, v, r, s);
        return signer != address(0) && signer == req.from;
    }
}

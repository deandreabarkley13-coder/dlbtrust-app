// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Sovereign Trust ETH Market
 *
 * A gasless ETH-on-ramp for the Sovereign Trust Token (DLBUSD/SIT) system.
 *
 * How it works:
 *   1. Liquidity providers (LPs) deposit native ETH into the market.
 *   2. The trust operator signs a SwapRequest that mints DLBUSD from a
 *      source-of-funds ledger and swaps it for ETH.
 *   3. Any relayer with ETH submits the request. The market contract:
 *        - verifies the operator's EIP-712 signature,
 *        - mints DLBUSD to the LP (the market must hold MINTER role),
 *        - sends the equivalent ETH (based on ethPriceUsd) to the operator.
 *
 * This lets a trust convert ledger-backed DLBUSD into native ETH without
 * holding ETH first, as long as an external LP is willing to supply the ETH.
 */
interface IToken {
    function mint(address to, uint256 amount) external;
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
}

contract SovereignTrustEthMarket {
    string public constant name = "SovereignTrustEthMarket";
    string public constant version = "1";
    uint256 public constant DLBUSD_DECIMALS = 6;
    uint256 public constant ETH_DECIMALS = 18;

    address public owner;
    address public token;
    // ethPriceUsd is scaled by 1e6, e.g. 1800_000000 for $1,800/ETH
    uint256 public ethPriceUsd;
    // feeBps is scaled by 10000, e.g. 100 = 1%
    uint256 public feeBps;

    mapping(address => uint256) public ethDeposits;
    mapping(address => bool) public relayers;
    mapping(address => uint256) public nonces;
    uint256 public totalEth;

    bytes32 private constant TYPEHASH = keccak256(
        "SwapRequest(address token,address operator,uint256 dlbusdAmount,address ethRecipient,uint256 minEthOut,uint256 nonce,uint256 deadline)"
    );

    event EthDeposited(address indexed lp, uint256 amount);
    event EthWithdrawn(address indexed lp, uint256 amount);
    event Swapped(
        address indexed operator,
        address indexed lp,
        address indexed ethRecipient,
        uint256 dlbusdAmount,
        uint256 ethOut,
        uint256 feeDlbusd
    );
    event RelayerSet(address indexed relayer, bool allowed);

    modifier onlyOwner() {
        require(msg.sender == owner, "SovereignTrustEthMarket: not owner");
        _;
    }

    modifier onlyRelayer() {
        require(relayers[msg.sender], "SovereignTrustEthMarket: not relayer");
        _;
    }

    struct SwapRequest {
        address token;
        address operator;
        uint256 dlbusdAmount;
        address ethRecipient;
        uint256 minEthOut;
        uint256 nonce;
        uint256 deadline;
    }

    constructor(address _token, uint256 _ethPriceUsd) {
        require(_token != address(0), "SovereignTrustEthMarket: zero token");
        require(_ethPriceUsd > 0, "SovereignTrustEthMarket: zero price");
        owner = msg.sender;
        token = _token;
        ethPriceUsd = _ethPriceUsd;
        feeBps = 100; // 1% default
    }

    receive() external payable {
        ethDeposits[msg.sender] += msg.value;
        totalEth += msg.value;
        emit EthDeposited(msg.sender, msg.value);
    }

    function depositEth() external payable {
        require(msg.value > 0, "SovereignTrustEthMarket: zero deposit");
        ethDeposits[msg.sender] += msg.value;
        totalEth += msg.value;
        emit EthDeposited(msg.sender, msg.value);
    }

    function withdrawEth(uint256 amount) external {
        require(ethDeposits[msg.sender] >= amount, "SovereignTrustEthMarket: insufficient deposit");
        ethDeposits[msg.sender] -= amount;
        totalEth -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "SovereignTrustEthMarket: withdraw failed");
        emit EthWithdrawn(msg.sender, amount);
    }

    function setOwner(address _owner) external onlyOwner {
        require(_owner != address(0), "SovereignTrustEthMarket: zero owner");
        owner = _owner;
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        relayers[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setPrice(uint256 _ethPriceUsd) external onlyOwner {
        require(_ethPriceUsd > 0, "SovereignTrustEthMarket: zero price");
        ethPriceUsd = _ethPriceUsd;
    }

    function setFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 10000, "SovereignTrustEthMarket: fee too high");
        feeBps = _feeBps;
    }

    function computeEthOut(uint256 dlbusdAmount) public view returns (uint256) {
        // dlbusdAmount is 1e6, ethPriceUsd is 1e6 USD/ETH
        // ETH out = dlbusdAmount * 1e18 / ethPriceUsd
        return (dlbusdAmount * (10 ** ETH_DECIMALS)) / ethPriceUsd;
    }

    function computeFee(uint256 dlbusdAmount) public view returns (uint256) {
        return (dlbusdAmount * feeBps) / 10000;
    }

    function getDomainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function hashSwapRequest(SwapRequest calldata req) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH,
                req.token,
                req.operator,
                req.dlbusdAmount,
                req.ethRecipient,
                req.minEthOut,
                req.nonce,
                req.deadline
            )
        );
    }

    function _verify(SwapRequest calldata req, bytes calldata signature) internal view returns (bool) {
        require(signature.length == 65, "SovereignTrustEthMarket: bad sig length");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", getDomainSeparator(), hashSwapRequest(req)));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(add(signature.offset, 0))
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        address signer = ecrecover(digest, v, r, s);
        return signer != address(0) && signer == req.operator;
    }

    /**
     * @notice Execute a signed swap: mint DLBUSD to the LP and send ETH to the operator.
     * @param req The operator-signed swap request.
     * @param lp The liquidity provider that receives DLBUSD and whose ETH deposit is used.
     * @param signature The operator's EIP-712 signature over `req`.
     */
    function swap(SwapRequest calldata req, address lp, bytes calldata signature) external onlyRelayer {
        require(req.deadline >= block.timestamp, "SovereignTrustEthMarket: expired");
        require(nonces[req.operator]++ == req.nonce, "SovereignTrustEthMarket: bad nonce");
        require(req.token == token, "SovereignTrustEthMarket: wrong token");
        require(_verify(req, signature), "SovereignTrustEthMarket: invalid signature");

        uint256 fee = computeFee(req.dlbusdAmount);
        uint256 dlbusdToLp = req.dlbusdAmount - fee;

        uint256 ethOut = computeEthOut(req.dlbusdAmount);
        require(ethOut >= req.minEthOut, "SovereignTrustEthMarket: slippage");
        require(ethDeposits[lp] >= ethOut, "SovereignTrustEthMarket: lp insufficient eth");

        ethDeposits[lp] -= ethOut;
        totalEth -= ethOut;

        // Mint DLBUSD to the LP. The contract must be a MINTER on the token.
        IToken(token).mint(lp, dlbusdToLp);
        if (fee > 0) {
            IToken(token).mint(msg.sender, fee);
        }

        (bool success, ) = payable(req.ethRecipient).call{value: ethOut}("");
        require(success, "SovereignTrustEthMarket: eth transfer failed");

        emit Swapped(req.operator, lp, req.ethRecipient, req.dlbusdAmount, ethOut, fee);
    }
}

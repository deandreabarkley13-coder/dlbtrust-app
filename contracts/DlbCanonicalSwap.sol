// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * DlbCanonicalSwap — permissioned P2P swap desk for DLB trust tokens into
 * canonical stablecoins (USDS, USDC, DAI, WETH).
 *
 * Standards followed:
 *   - ERC-20 interface for all token interactions
 *   - OpenZeppelin-style ReentrancyGuard and Ownable access control
 *   - Checks-Effects-Interactions pattern
 *   - Event emission for every state change
 *
 * This contract is audit-ready but not a substitute for a formal security audit.
 */
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract DlbCanonicalSwap {
    struct Order {
        uint256 id;
        address maker;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        uint256 amountOut;
        address recipient;
        bool active;
    }

    uint256 public nextOrderId = 1;
    address public owner;
    address public feeRecipient;
    uint256 public feeBps; // fee in basis points, max 1000 (10%)

    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) public makerOrders;
    mapping(address => bool) public canonicalStablecoins;

    uint256 private _status;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeUpdated(uint256 feeBps, address feeRecipient);
    event CanonicalStablecoinUpdated(address indexed token, bool allowed);
    event OrderCreated(
        uint256 indexed id,
        address indexed maker,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        address recipient
    );
    event OrderFilled(uint256 indexed id, address indexed taker, address indexed recipient, uint256 fee);
    event OrderCancelled(uint256 indexed id);

    modifier onlyOwner() {
        require(msg.sender == owner, "DlbCanonicalSwap: not owner");
        _;
    }

    modifier nonReentrant() {
        require(_status == 0, "DlbCanonicalSwap: reentrant call");
        _status = 1;
        _;
        _status = 0;
    }

    constructor(address _owner, address _feeRecipient, uint256 _feeBps) {
        require(_owner != address(0), "DlbCanonicalSwap: zero owner");
        require(_feeBps <= 1000, "DlbCanonicalSwap: fee too high");
        owner = _owner;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        emit OwnershipTransferred(address(0), _owner);
        emit FeeUpdated(_feeBps, _feeRecipient);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "DlbCanonicalSwap: zero owner");
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setFee(uint256 _feeBps, address _feeRecipient) external onlyOwner {
        require(_feeBps <= 1000, "DlbCanonicalSwap: fee too high");
        require(_feeRecipient != address(0), "DlbCanonicalSwap: zero fee recipient");
        feeBps = _feeBps;
        feeRecipient = _feeRecipient;
        emit FeeUpdated(_feeBps, _feeRecipient);
    }

    function setCanonicalStablecoin(address token, bool allowed) external onlyOwner {
        require(token != address(0), "DlbCanonicalSwap: zero token");
        canonicalStablecoins[token] = allowed;
        emit CanonicalStablecoinUpdated(token, allowed);
    }

    function createOrder(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        address recipient
    ) external nonReentrant returns (uint256 orderId) {
        require(tokenIn != address(0), "DlbCanonicalSwap: invalid tokenIn");
        require(tokenOut != address(0), "DlbCanonicalSwap: invalid tokenOut");
        require(tokenIn != tokenOut, "DlbCanonicalSwap: same token");
        require(amountIn > 0, "DlbCanonicalSwap: zero amountIn");
        require(amountOut > 0, "DlbCanonicalSwap: zero amountOut");
        require(recipient != address(0), "DlbCanonicalSwap: invalid recipient");
        require(canonicalStablecoins[tokenOut], "DlbCanonicalSwap: tokenOut not canonical");

        orderId = nextOrderId++;
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            tokenIn: tokenIn,
            amountIn: amountIn,
            tokenOut: tokenOut,
            amountOut: amountOut,
            recipient: recipient,
            active: true
        });
        makerOrders[msg.sender].push(orderId);

        require(
            IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn),
            "DlbCanonicalSwap: tokenIn transfer failed"
        );

        emit OrderCreated(orderId, msg.sender, tokenIn, amountIn, tokenOut, amountOut, recipient);
    }

    function fillOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        require(order.active, "DlbCanonicalSwap: order not active");

        order.active = false;

        uint256 fee = (order.amountOut * feeBps) / 10000;
        uint256 payout = order.amountOut - fee;

        if (fee > 0) {
            require(
                IERC20(order.tokenOut).transferFrom(msg.sender, feeRecipient, fee),
                "DlbCanonicalSwap: fee transfer failed"
            );
        }
        require(
            IERC20(order.tokenOut).transferFrom(msg.sender, order.recipient, payout),
            "DlbCanonicalSwap: payout transfer failed"
        );
        require(
            IERC20(order.tokenIn).transfer(msg.sender, order.amountIn),
            "DlbCanonicalSwap: tokenIn release failed"
        );

        emit OrderFilled(orderId, msg.sender, order.recipient, fee);
    }

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        require(order.active, "DlbCanonicalSwap: order not active");
        require(order.maker == msg.sender || msg.sender == owner, "DlbCanonicalSwap: not maker or owner");

        order.active = false;

        require(
            IERC20(order.tokenIn).transfer(order.maker, order.amountIn),
            "DlbCanonicalSwap: refund failed"
        );

        emit OrderCancelled(orderId);
    }

    function getOrdersByMaker(address maker) external view returns (uint256[] memory) {
        return makerOrders[maker];
    }

    // Allow the owner to recover any ERC-20 accidentally sent to the contract.
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "DlbCanonicalSwap: zero token");
        require(IERC20(token).transfer(owner, amount), "DlbCanonicalSwap: recover failed");
    }
}

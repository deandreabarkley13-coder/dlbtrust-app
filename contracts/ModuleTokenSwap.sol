// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract ModuleTokenSwap {
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
    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) public makerOrders;

    event OrderCreated(
        uint256 indexed id,
        address indexed maker,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        address recipient
    );
    event OrderFilled(uint256 indexed id, address indexed taker, address indexed recipient);
    event OrderCancelled(uint256 indexed id);

    function createOrder(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        address recipient
    ) external returns (uint256 orderId) {
        require(tokenIn != address(0), 'Invalid tokenIn');
        require(tokenOut != address(0), 'Invalid tokenOut');
        require(amountIn > 0, 'amountIn must be > 0');
        require(amountOut > 0, 'amountOut must be > 0');
        require(recipient != address(0), 'Invalid recipient');

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

        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), 'TokenIn transfer failed');

        emit OrderCreated(orderId, msg.sender, tokenIn, amountIn, tokenOut, amountOut, recipient);
    }

    function fillOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        require(order.active, 'Order not active');

        order.active = false;

        // Taker sends tokenOut to the order recipient (maker's chosen payout address)
        require(IERC20(order.tokenOut).transferFrom(msg.sender, order.recipient, order.amountOut), 'TokenOut transfer failed');

        // Taker receives tokenIn from this contract
        require(IERC20(order.tokenIn).transfer(msg.sender, order.amountIn), 'TokenIn release failed');

        emit OrderFilled(orderId, msg.sender, order.recipient);
    }

    function cancelOrder(uint256 orderId) external {
        Order storage order = orders[orderId];
        require(order.active, 'Order not active');
        require(order.maker == msg.sender, 'Not maker');

        order.active = false;

        require(IERC20(order.tokenIn).transfer(order.maker, order.amountIn), 'TokenIn refund failed');

        emit OrderCancelled(orderId);
    }

    function getOrdersByMaker(address maker) external view returns (uint256[] memory) {
        return makerOrders[maker];
    }
}

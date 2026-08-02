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

contract BondDex {
    address public token0;
    address public token1;
    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 public constant FEE_NUMERATOR = 997;
    uint256 public constant FEE_DENOMINATOR = 1000;

    constructor(address _token0, address _token1) {
        require(_token0 < _token1, 'BondDex: token0 must be < token1');
        token0 = _token0;
        token1 = _token1;
    }

    function _updateReserves() private {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external returns (uint256 lp) {
        require(amount0 > 0 && amount1 > 0, 'BondDex: zero amounts');
        IERC20(token0).transferFrom(msg.sender, address(this), amount0);
        IERC20(token1).transferFrom(msg.sender, address(this), amount1);
        if (totalSupply == 0) {
            lp = sqrt(amount0 * amount1);
        } else {
            uint256 lp0 = (amount0 * totalSupply) / reserve0;
            uint256 lp1 = (amount1 * totalSupply) / reserve1;
            lp = lp0 < lp1 ? lp0 : lp1;
        }
        require(lp > 0, 'BondDex: zero LP');
        totalSupply += lp;
        balanceOf[msg.sender] += lp;
        _updateReserves();
    }

    function removeLiquidity(uint256 lp) external returns (uint256 amount0, uint256 amount1) {
        require(balanceOf[msg.sender] >= lp, 'BondDex: insufficient LP');
        amount0 = (lp * reserve0) / totalSupply;
        amount1 = (lp * reserve1) / totalSupply;
        totalSupply -= lp;
        balanceOf[msg.sender] -= lp;
        IERC20(token0).transfer(msg.sender, amount0);
        IERC20(token1).transfer(msg.sender, amount1);
        _updateReserves();
    }

    function swap(uint256 amountIn, address tokenIn, uint256 minOut) external returns (uint256 amountOut) {
        require(tokenIn == token0 || tokenIn == token1, 'BondDex: invalid token');
        require(amountIn > 0, 'BondDex: zero in');
        address tokenOut = tokenIn == token0 ? token1 : token0;
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == token0 ? (reserve0, reserve1) : (reserve1, reserve0);

        uint256 amountInWithFee = (amountIn * FEE_NUMERATOR) / FEE_DENOMINATOR;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn + amountInWithFee;
        amountOut = numerator / denominator;

        require(amountOut > 0 && amountOut >= minOut, 'BondDex: slippage');
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(msg.sender, amountOut);
        _updateReserves();
    }

    function sqrt(uint256 x) private pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

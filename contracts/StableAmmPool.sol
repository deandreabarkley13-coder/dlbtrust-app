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

/**
 * @title StableAmmPool
 * @notice Two-token StableSwap pool for a pegged pair (trust token / canonical stablecoin).
 *
 * Invariant (Curve StableSwap, n = 2):
 *   A·n^n·Σx_i + D = A·n^n·D + D^(n+1) / (n^n·Πx_i)
 * Reserves are normalised to 18 decimals with per-token rate multipliers so
 * an 18-decimal trust token can be paired with a 6-decimal canonical asset.
 * High `A` makes the curve constant-sum-like near balance (minimal slippage);
 * far from balance it degrades to constant-product so the pool cannot be drained.
 */
contract StableAmmPool {
    uint256 private constant N_COINS = 2;
    uint256 private constant PRECISION = 1e18;
    uint256 private constant FEE_DENOMINATOR = 10_000;
    uint256 private constant MAX_FEE_BPS = 100;        // 1%
    uint256 private constant MIN_A = 1;
    uint256 private constant MAX_A = 1_000_000;
    uint256 private constant MAX_ITERATIONS = 255;

    address public owner;
    address public immutable token0;
    address public immutable token1;
    uint256 public immutable rate0;   // 10 ** (18 - decimals0)
    uint256 public immutable rate1;   // 10 ** (18 - decimals1)

    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public A;
    uint256 public feeBps;
    bool public paused;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 private _locked = 1;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ParametersUpdated(uint256 A, uint256 feeBps);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event Mint(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Burn(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity, address indexed to);
    event Swap(address indexed sender, address indexed tokenIn, uint256 amountIn, uint256 amountOut, uint256 fee, address indexed to);
    event Sync(uint256 reserve0, uint256 reserve1);

    modifier onlyOwner() {
        require(msg.sender == owner, 'StableAmmPool: not owner');
        _;
    }

    modifier whenNotPaused() {
        require(!paused, 'StableAmmPool: paused');
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, 'StableAmmPool: reentrant');
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address _token0,
        address _token1,
        uint8 _decimals0,
        uint8 _decimals1,
        uint256 _A,
        uint256 _feeBps,
        address _owner
    ) {
        require(_token0 != address(0) && _token1 != address(0), 'StableAmmPool: zero token');
        require(_token0 < _token1, 'StableAmmPool: token0 must be < token1');
        require(_decimals0 <= 18 && _decimals1 <= 18, 'StableAmmPool: decimals > 18');
        require(_A >= MIN_A && _A <= MAX_A, 'StableAmmPool: A out of range');
        require(_feeBps <= MAX_FEE_BPS, 'StableAmmPool: fee too high');
        require(_owner != address(0), 'StableAmmPool: zero owner');
        token0 = _token0;
        token1 = _token1;
        rate0 = 10 ** (18 - uint256(_decimals0));
        rate1 = 10 ** (18 - uint256(_decimals1));
        A = _A;
        feeBps = _feeBps;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), 'StableAmmPool: zero owner');
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setParameters(uint256 _A, uint256 _feeBps) external onlyOwner {
        require(_A >= MIN_A && _A <= MAX_A, 'StableAmmPool: A out of range');
        require(_feeBps <= MAX_FEE_BPS, 'StableAmmPool: fee too high');
        A = _A;
        feeBps = _feeBps;
        emit ParametersUpdated(_A, _feeBps);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getReserves() external view returns (uint256, uint256) {
        return (reserve0, reserve1);
    }

    /// @notice Invariant D over the current reserves (18-decimal units).
    function getD() external view returns (uint256) {
        return _getD(_xp(reserve0, reserve1), A);
    }

    /// @notice Value of one LP unit in 18-decimal peg units; grows as fees accrue.
    function getVirtualPrice() external view returns (uint256) {
        if (totalSupply == 0) return 0;
        return (_getD(_xp(reserve0, reserve1), A) * PRECISION) / totalSupply;
    }

    /**
     * @notice Marginal price of token0 quoted in token1, 1e18 = parity.
     * Computed on a probe trade of D / 10_000 so it tracks the curve slope
     * rather than a large-trade average. Excludes the swap fee.
     */
    function getPrice() external view returns (uint256) {
        uint256[N_COINS] memory xp = _xp(reserve0, reserve1);
        uint256 D = _getD(xp, A);
        if (D == 0) return 0;
        uint256 dx = D / 10_000;
        if (dx == 0) dx = 1;
        uint256 y = _getY(0, 1, xp[0] + dx, xp, D);
        uint256 dy = xp[1] - y - 1;
        return (dy * PRECISION) / dx;
    }

    /// @notice Output for `amountIn` of `tokenIn` after fee, in tokenOut's native units.
    function getAmountOut(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut, uint256 fee) {
        (amountOut, fee) = _quote(tokenIn, amountIn, reserve0, reserve1);
    }

    // ─── Liquidity ───────────────────────────────────────────────────────────

    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minLiquidity)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 liquidity)
    {
        require(amount0 > 0 || amount1 > 0, 'StableAmmPool: zero amounts');
        uint256 D0 = totalSupply == 0 ? 0 : _getD(_xp(reserve0, reserve1), A);
        if (totalSupply == 0) {
            require(amount0 > 0 && amount1 > 0, 'StableAmmPool: seed both sides');
        }
        if (amount0 > 0) _pull(token0, msg.sender, amount0);
        if (amount1 > 0) _pull(token1, msg.sender, amount1);
        uint256 new0 = reserve0 + amount0;
        uint256 new1 = reserve1 + amount1;
        uint256 D1 = _getD(_xp(new0, new1), A);
        require(D1 > D0, 'StableAmmPool: D did not increase');
        liquidity = totalSupply == 0 ? D1 : (totalSupply * (D1 - D0)) / D0;
        require(liquidity >= minLiquidity && liquidity > 0, 'StableAmmPool: insufficient liquidity minted');
        totalSupply += liquidity;
        balanceOf[msg.sender] += liquidity;
        _update(new0, new1);
        emit Mint(msg.sender, amount0, amount1, liquidity);
    }

    function removeLiquidity(uint256 liquidity, uint256 minAmount0, uint256 minAmount1, address to)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        require(liquidity > 0, 'StableAmmPool: zero liquidity');
        require(to != address(0), 'StableAmmPool: zero recipient');
        require(balanceOf[msg.sender] >= liquidity, 'StableAmmPool: insufficient LP balance');
        amount0 = (reserve0 * liquidity) / totalSupply;
        amount1 = (reserve1 * liquidity) / totalSupply;
        require(amount0 >= minAmount0 && amount1 >= minAmount1, 'StableAmmPool: slippage');
        balanceOf[msg.sender] -= liquidity;
        totalSupply -= liquidity;
        if (amount0 > 0) _push(token0, to, amount0);
        if (amount1 > 0) _push(token1, to, amount1);
        _update(reserve0 - amount0, reserve1 - amount1);
        emit Burn(msg.sender, amount0, amount1, liquidity, to);
    }

    // ─── Swap ────────────────────────────────────────────────────────────────

    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        require(amountIn > 0, 'StableAmmPool: zero input');
        require(to != address(0), 'StableAmmPool: zero recipient');
        require(tokenIn == token0 || tokenIn == token1, 'StableAmmPool: invalid token');
        uint256 fee;
        (amountOut, fee) = _quote(tokenIn, amountIn, reserve0, reserve1);
        require(amountOut > 0 && amountOut >= minAmountOut, 'StableAmmPool: insufficient output');
        _pull(tokenIn, msg.sender, amountIn);
        if (tokenIn == token0) {
            _push(token1, to, amountOut);
            _update(reserve0 + amountIn, reserve1 - amountOut);
        } else {
            _push(token0, to, amountOut);
            _update(reserve0 - amountOut, reserve1 + amountIn);
        }
        emit Swap(msg.sender, tokenIn, amountIn, amountOut, fee, to);
    }

    /// @notice Fold any tokens sent directly to the pool into reserves.
    function sync() external nonReentrant {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
    }

    // ─── StableSwap math ─────────────────────────────────────────────────────

    function _xp(uint256 r0, uint256 r1) internal view returns (uint256[N_COINS] memory xp) {
        xp[0] = r0 * rate0;
        xp[1] = r1 * rate1;
    }

    function _getD(uint256[N_COINS] memory xp, uint256 amp) internal pure returns (uint256) {
        uint256 S = xp[0] + xp[1];
        if (S == 0) return 0;
        uint256 D = S;
        uint256 Ann = amp * N_COINS;
        for (uint256 i = 0; i < MAX_ITERATIONS; i++) {
            uint256 D_P = D;
            for (uint256 j = 0; j < N_COINS; j++) {
                D_P = (D_P * D) / (xp[j] * N_COINS + 1);
            }
            uint256 Dprev = D;
            D = ((Ann * S + D_P * N_COINS) * D) / ((Ann - 1) * D + (N_COINS + 1) * D_P);
            if (D > Dprev ? D - Dprev <= 1 : Dprev - D <= 1) return D;
        }
        revert('StableAmmPool: D did not converge');
    }

    function _getY(uint256 i, uint256 j, uint256 x, uint256[N_COINS] memory xp, uint256 D)
        internal
        view
        returns (uint256)
    {
        require(i != j && i < N_COINS && j < N_COINS, 'StableAmmPool: bad index');
        uint256 Ann = A * N_COINS;
        uint256 c = D;
        uint256 S_ = 0;
        for (uint256 k = 0; k < N_COINS; k++) {
            uint256 _x;
            if (k == i) _x = x;
            else if (k != j) _x = xp[k];
            else continue;
            S_ += _x;
            c = (c * D) / (_x * N_COINS);
        }
        c = (c * D) / (Ann * N_COINS);
        uint256 b = S_ + D / Ann;
        uint256 y = D;
        for (uint256 n = 0; n < MAX_ITERATIONS; n++) {
            uint256 yPrev = y;
            y = (y * y + c) / (2 * y + b - D);
            if (y > yPrev ? y - yPrev <= 1 : yPrev - y <= 1) return y;
        }
        revert('StableAmmPool: y did not converge');
    }

    function _quote(address tokenIn, uint256 amountIn, uint256 r0, uint256 r1)
        internal
        view
        returns (uint256 amountOut, uint256 fee)
    {
        require(tokenIn == token0 || tokenIn == token1, 'StableAmmPool: invalid token');
        require(r0 > 0 && r1 > 0, 'StableAmmPool: no liquidity');
        uint256[N_COINS] memory xp = _xp(r0, r1);
        uint256 D = _getD(xp, A);
        (uint256 i, uint256 j, uint256 rateIn, uint256 rateOut) =
            tokenIn == token0 ? (uint256(0), uint256(1), rate0, rate1) : (uint256(1), uint256(0), rate1, rate0);
        uint256 x = xp[i] + amountIn * rateIn;
        uint256 y = _getY(i, j, x, xp, D);
        uint256 dy = xp[j] - y - 1;
        uint256 dyFee = (dy * feeBps) / FEE_DENOMINATOR;
        amountOut = (dy - dyFee) / rateOut;
        fee = dyFee / rateOut;
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    function _update(uint256 r0, uint256 r1) internal {
        reserve0 = r0;
        reserve1 = r1;
        emit Sync(r0, r1);
    }

    function _pull(address token, address from, uint256 amount) internal {
        require(IERC20(token).transferFrom(from, address(this), amount), 'StableAmmPool: transferFrom failed');
    }

    function _push(address token, address to, uint256 amount) internal {
        require(IERC20(token).transfer(to, amount), 'StableAmmPool: transfer failed');
    }
}

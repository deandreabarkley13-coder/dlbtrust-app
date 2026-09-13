// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IBurnable {
    function burn(uint256 amount) external;
}

/**
 * @title FloorPriceRedemption
 * @notice Owner-funded canonical reserve (USDC/USDS/DAI) that lets whitelisted
 * holders redeem the trust token at a fixed floor price. The trust token is
 * pulled from the redeemer and burned when this contract holds the burner role
 * on it, otherwise retained for the owner to sweep. Canonical reserve is paid
 * out to the redeemer; the contract never mints or invents reserve.
 */
contract FloorPriceRedemption {
    uint256 private constant PRECISION = 1e18;

    address public owner;
    address public immutable trustToken;      // 18-decimal DLB-PTCUSD
    address public immutable reserveToken;    // canonical stablecoin
    uint8 public immutable reserveDecimals;

    uint256 public floorPrice;                // canonical per trust token, 1e18 = 1:1
    bool public paused;
    bool public whitelistEnabled = true;
    bool public burnOnRedeem;
    uint256 public totalRedeemed;             // trust token units
    uint256 public totalPaidOut;              // reserve token units

    mapping(address => bool) public redeemers;
    mapping(address => bool) public pausers;

    uint256 private _locked = 1;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FloorPriceSet(uint256 previousPrice, uint256 newPrice);
    event ReserveFunded(address indexed from, uint256 amount, uint256 reserveBalance);
    event ReserveWithdrawn(address indexed to, uint256 amount, uint256 reserveBalance);
    event TrustTokenSwept(address indexed to, uint256 amount);
    event Redeemed(address indexed redeemer, address indexed to, uint256 trustAmount, uint256 reserveAmount, uint256 floorPrice, bool burned);
    event RedeemerSet(address indexed account, bool allowed);
    event WhitelistEnabled(bool enabled);
    event BurnOnRedeemSet(bool enabled);
    event PauserSet(address indexed account, bool allowed);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    modifier onlyOwner() {
        require(msg.sender == owner, 'FloorPriceRedemption: not owner');
        _;
    }

    modifier onlyPauser() {
        require(msg.sender == owner || pausers[msg.sender], 'FloorPriceRedemption: not pauser');
        _;
    }

    modifier whenNotPaused() {
        require(!paused, 'FloorPriceRedemption: paused');
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, 'FloorPriceRedemption: reentrant');
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address _trustToken, address _reserveToken, uint8 _reserveDecimals, uint256 _floorPrice, address _owner) {
        require(_trustToken != address(0) && _reserveToken != address(0), 'FloorPriceRedemption: zero token');
        require(_trustToken != _reserveToken, 'FloorPriceRedemption: same token');
        require(_reserveDecimals <= 18, 'FloorPriceRedemption: decimals > 18');
        require(_floorPrice > 0, 'FloorPriceRedemption: zero floor');
        require(_owner != address(0), 'FloorPriceRedemption: zero owner');
        trustToken = _trustToken;
        reserveToken = _reserveToken;
        reserveDecimals = _reserveDecimals;
        floorPrice = _floorPrice;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
        emit FloorPriceSet(0, _floorPrice);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), 'FloorPriceRedemption: zero owner');
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setFloorPrice(uint256 newPrice) external onlyOwner {
        require(newPrice > 0, 'FloorPriceRedemption: zero floor');
        emit FloorPriceSet(floorPrice, newPrice);
        floorPrice = newPrice;
    }

    function setRedeemer(address account, bool allowed) external onlyOwner {
        redeemers[account] = allowed;
        emit RedeemerSet(account, allowed);
    }

    function setWhitelistEnabled(bool enabled) external onlyOwner {
        whitelistEnabled = enabled;
        emit WhitelistEnabled(enabled);
    }

    function setBurnOnRedeem(bool enabled) external onlyOwner {
        burnOnRedeem = enabled;
        emit BurnOnRedeemSet(enabled);
    }

    function setPauser(address account, bool allowed) external onlyOwner {
        pausers[account] = allowed;
        emit PauserSet(account, allowed);
    }

    function pause() external onlyPauser {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyPauser {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Reserve ─────────────────────────────────────────────────────────────

    /// @notice Pull `amount` of the canonical asset from the caller into the reserve.
    function fundReserve(uint256 amount) external nonReentrant {
        require(amount > 0, 'FloorPriceRedemption: zero amount');
        require(IERC20(reserveToken).transferFrom(msg.sender, address(this), amount), 'FloorPriceRedemption: transferFrom failed');
        emit ReserveFunded(msg.sender, amount, reserveBalance());
    }

    function withdrawReserve(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), 'FloorPriceRedemption: zero recipient');
        require(amount > 0 && amount <= reserveBalance(), 'FloorPriceRedemption: insufficient reserve');
        require(IERC20(reserveToken).transfer(to, amount), 'FloorPriceRedemption: transfer failed');
        emit ReserveWithdrawn(to, amount, reserveBalance());
    }

    /// @notice Move retained (un-burned) trust tokens back to the treasury.
    function sweepTrustToken(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), 'FloorPriceRedemption: zero recipient');
        require(IERC20(trustToken).transfer(to, amount), 'FloorPriceRedemption: transfer failed');
        emit TrustTokenSwept(to, amount);
    }

    function reserveBalance() public view returns (uint256) {
        return IERC20(reserveToken).balanceOf(address(this));
    }

    /// @notice Canonical owed for `trustAmount` at the current floor, in reserve token units.
    function quoteRedeem(uint256 trustAmount) public view returns (uint256) {
        return (trustAmount * floorPrice) / PRECISION / (10 ** (18 - uint256(reserveDecimals)));
    }

    /// @notice Largest trust amount the reserve can honour at the current floor.
    function maxRedeemable() external view returns (uint256) {
        uint256 reserve = reserveBalance();
        return (reserve * (10 ** (18 - uint256(reserveDecimals))) * PRECISION) / floorPrice;
    }

    /// @notice Reserve coverage of `supply` trust tokens in basis points (10_000 = fully covered).
    function coverageBps(uint256 supply) external view returns (uint256) {
        if (supply == 0) return 0;
        uint256 needed = quoteRedeem(supply);
        if (needed == 0) return 0;
        return (reserveBalance() * 10_000) / needed;
    }

    // ─── Redemption ──────────────────────────────────────────────────────────

    function redeem(uint256 trustAmount, address to) external nonReentrant whenNotPaused returns (uint256 reserveAmount) {
        require(trustAmount > 0, 'FloorPriceRedemption: zero amount');
        require(to != address(0), 'FloorPriceRedemption: zero recipient');
        require(!whitelistEnabled || redeemers[msg.sender], 'FloorPriceRedemption: not whitelisted');
        reserveAmount = quoteRedeem(trustAmount);
        require(reserveAmount > 0, 'FloorPriceRedemption: amount too small');
        require(reserveAmount <= reserveBalance(), 'FloorPriceRedemption: insufficient reserve');

        require(IERC20(trustToken).transferFrom(msg.sender, address(this), trustAmount), 'FloorPriceRedemption: pull failed');
        bool burned = false;
        if (burnOnRedeem) {
            IBurnable(trustToken).burn(trustAmount);
            burned = true;
        }
        require(IERC20(reserveToken).transfer(to, reserveAmount), 'FloorPriceRedemption: payout failed');

        totalRedeemed += trustAmount;
        totalPaidOut += reserveAmount;
        emit Redeemed(msg.sender, to, trustAmount, reserveAmount, floorPrice, burned);
    }
}

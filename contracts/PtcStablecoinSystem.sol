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

interface IPtcBackedStablecoin {
    function mint(address to, uint256 amount) external;
    function burn(uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/**
 * PtcBackedStablecoin — a private/permissioned stablecoin issued by the PTC.
 *
 *   - 18 decimals (standard stablecoin precision)
 *   - Mint/Burn controlled by MINTER / BURNER roles
 *   - Pausable transfers by PAUSER role
 *   - Whitelist enforcement (private trust use)
 *   - Owner can mint/burn manually for reserve-backed operations
 */
contract PtcBackedStablecoin {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    address public owner;
    mapping(address => bool) public minters;
    mapping(address => bool) public burners;
    mapping(address => bool) public pausers;
    mapping(address => bool) public whitelistAdmins;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public whitelisted;
    bool public whitelistEnabled;
    bool public paused;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 value);
    event Burn(address indexed from, uint256 value);
    event Whitelisted(address indexed account, bool allowed);
    event WhitelistEnabled(bool enabled);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    modifier onlyOwner() {
        require(msg.sender == owner, "PtcBackedStablecoin: not owner");
        _;
    }

    modifier onlyMinter() {
        require(minters[msg.sender], "PtcBackedStablecoin: not minter");
        _;
    }

    modifier onlyBurner() {
        require(burners[msg.sender], "PtcBackedStablecoin: not burner");
        _;
    }

    modifier onlyPauser() {
        require(pausers[msg.sender], "PtcBackedStablecoin: not pauser");
        _;
    }

    modifier onlyWhitelistAdmin() {
        require(whitelistAdmins[msg.sender], "PtcBackedStablecoin: not whitelist admin");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PtcBackedStablecoin: paused");
        _;
    }

    constructor(string memory _name, string memory _symbol, address _owner) {
        require(_owner != address(0), "PtcBackedStablecoin: zero owner");
        name = _name;
        symbol = _symbol;
        owner = _owner;
        minters[_owner] = true;
        burners[_owner] = true;
        pausers[_owner] = true;
        whitelistAdmins[_owner] = true;
        whitelistEnabled = true;
        whitelisted[_owner] = true;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PtcBackedStablecoin: zero owner");
        owner = newOwner;
        whitelisted[newOwner] = true;
    }

    function setMinter(address account, bool allowed) external onlyOwner { minters[account] = allowed; }
    function setBurner(address account, bool allowed) external onlyOwner { burners[account] = allowed; }
    function setPauser(address account, bool allowed) external onlyOwner { pausers[account] = allowed; }
    function setWhitelistAdmin(address account, bool allowed) external onlyOwner {
        whitelistAdmins[account] = allowed;
        if (allowed) whitelisted[account] = true;
    }

    function setWhitelisted(address account, bool allowed) external onlyWhitelistAdmin {
        whitelisted[account] = allowed;
        emit Whitelisted(account, allowed);
    }

    function setWhitelistEnabled(bool enabled) external onlyWhitelistAdmin {
        whitelistEnabled = enabled;
        emit WhitelistEnabled(enabled);
    }

    function pause() external onlyPauser {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyPauser {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _beforeTokenTransfer(address(0), to, amount);
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
        emit Mint(to, amount);
    }

    function burn(uint256 amount) external {
        address sender = msg.sender;
        _beforeTokenTransfer(sender, address(0), amount);
        require(balanceOf[sender] >= amount, "PtcBackedStablecoin: insufficient balance");
        totalSupply -= amount;
        balanceOf[sender] -= amount;
        emit Transfer(sender, address(0), amount);
        emit Burn(sender, amount);
    }

    function burnFrom(address from, uint256 amount) external onlyBurner {
        _beforeTokenTransfer(from, address(0), amount);
        require(balanceOf[from] >= amount, "PtcBackedStablecoin: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "PtcBackedStablecoin: allowance exceeded");
        allowance[from][msg.sender] -= amount;
        totalSupply -= amount;
        balanceOf[from] -= amount;
        emit Transfer(from, address(0), amount);
        emit Burn(from, amount);
    }

    function transfer(address to, uint256 amount) external whenNotPaused returns (bool) {
        address sender = msg.sender;
        _beforeTokenTransfer(sender, to, amount);
        require(balanceOf[sender] >= amount, "PtcBackedStablecoin: insufficient balance");
        balanceOf[sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external whenNotPaused returns (bool) {
        address spender = msg.sender;
        _beforeTokenTransfer(from, to, amount);
        require(balanceOf[from] >= amount, "PtcBackedStablecoin: insufficient balance");
        require(allowance[from][spender] >= amount, "PtcBackedStablecoin: allowance exceeded");
        allowance[from][spender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal view {
        require(amount > 0, "PtcBackedStablecoin: zero amount");
        if (whitelistEnabled) {
            require(from == address(0) || whitelisted[from], "PtcBackedStablecoin: sender not whitelisted");
            require(to == address(0) || whitelisted[to], "PtcBackedStablecoin: recipient not whitelisted");
        }
    }
}

/**
 * PtcReserveVault — holds tokenized trust assets as backing for PtcBackedStablecoin.
 *
 * Accepts approved reserve tokens (e.g. DLB-FIXED-INCOME, DLB-BOND, DLB-TREASURY)
 * and mints stablecoin at a configured price. Redemption burns stablecoin and
 * releases reserve tokens back to the caller.
 */
contract PtcReserveVault {
    struct ReserveToken {
        address token;
        uint8 decimals;
        uint256 price; // USD price with 18 decimals (1e18 = $1.00)
        bool active;
    }

    address public owner;
    IPtcBackedStablecoin public stablecoin;

    mapping(address => ReserveToken) public reserveTokens;
    address[] public reserveTokenList;

    event ReserveTokenAdded(address indexed token, uint8 decimals, uint256 price);
    event ReserveTokenRemoved(address indexed token);
    event ReserveDeposited(address indexed token, address indexed depositor, address indexed recipient, uint256 reserveAmount, uint256 stablecoinAmount);
    event ReserveRedeemed(address indexed token, address indexed redeemer, address indexed recipient, uint256 stablecoinAmount, uint256 reserveAmount);

    modifier onlyOwner() {
        require(msg.sender == owner, "PtcReserveVault: not owner");
        _;
    }

    constructor(address _owner, address _stablecoin) {
        require(_owner != address(0), "PtcReserveVault: zero owner");
        require(_stablecoin != address(0), "PtcReserveVault: zero stablecoin");
        owner = _owner;
        stablecoin = IPtcBackedStablecoin(_stablecoin);
    }

    function setStablecoin(address _stablecoin) external onlyOwner {
        require(_stablecoin != address(0), "PtcReserveVault: zero stablecoin");
        stablecoin = IPtcBackedStablecoin(_stablecoin);
    }

    function addReserveToken(address token, uint8 decimals, uint256 price) external onlyOwner {
        require(token != address(0), "PtcReserveVault: zero token");
        require(price > 0, "PtcReserveVault: zero price");
        if (!reserveTokens[token].active) {
            reserveTokenList.push(token);
        }
        reserveTokens[token] = ReserveToken({ token: token, decimals: decimals, price: price, active: true });
        emit ReserveTokenAdded(token, decimals, price);
    }

    function removeReserveToken(address token) external onlyOwner {
        require(reserveTokens[token].active, "PtcReserveVault: token not active");
        reserveTokens[token].active = false;
        emit ReserveTokenRemoved(token);
    }

    function reserveTokenCount() external view returns (uint256) {
        return reserveTokenList.length;
    }

    function depositReserve(address token, uint256 amount, address recipient) external {
        ReserveToken memory r = reserveTokens[token];
        require(r.active, "PtcReserveVault: token not accepted");
        require(amount > 0, "PtcReserveVault: zero amount");
        require(recipient != address(0), "PtcReserveVault: zero recipient");

        // Pull reserve token from caller
        require(IERC20(token).transferFrom(msg.sender, address(this), amount), "PtcReserveVault: reserve transfer failed");

        // Mint stablecoin: amount * price / 10^decimals
        uint256 stablecoinAmount = (amount * r.price) / (10 ** r.decimals);
        stablecoin.mint(recipient, stablecoinAmount);

        emit ReserveDeposited(token, msg.sender, recipient, amount, stablecoinAmount);
    }

    function redeemReserve(address token, uint256 stablecoinAmount, address recipient) external {
        ReserveToken memory r = reserveTokens[token];
        require(r.active, "PtcReserveVault: token not accepted");
        require(stablecoinAmount > 0, "PtcReserveVault: zero stablecoin");
        require(recipient != address(0), "PtcReserveVault: zero recipient");

        // Pull stablecoin from caller into vault and burn it
        require(stablecoin.transferFrom(msg.sender, address(this), stablecoinAmount), "PtcReserveVault: stablecoin transfer failed");
        stablecoin.burn(stablecoinAmount);

        // Release reserve token: stablecoinAmount * 10^decimals / price
        uint256 reserveAmount = (stablecoinAmount * (10 ** r.decimals)) / r.price;
        require(IERC20(token).transfer(recipient, reserveAmount), "PtcReserveVault: reserve release failed");

        emit ReserveRedeemed(token, msg.sender, recipient, stablecoinAmount, reserveAmount);
    }

    function getReserveBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "PtcReserveVault: zero recipient");
        require(IERC20(token).transfer(to, amount), "PtcReserveVault: rescue failed");
    }
}

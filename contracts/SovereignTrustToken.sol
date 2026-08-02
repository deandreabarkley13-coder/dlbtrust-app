// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Sovereign Trust Token (SIT) — a self-issued, private/permissioned stablecoin.
 *
 * Features:
 *   - 6 decimals (matching USD stablecoins)
 *   - Mint/Burn controlled by MINTER / BURNER roles
 *   - Pausable transfers by PAUSER role
 *   - Whitelist enforcement for transfers (permissioned holders)
 *   - ERC-2771 meta-transaction support for gasless user operations
 *   - EIP-2612 permit() for gasless approvals
 *
 * The deployer is the initial admin, minter, burner, pauser and whitelist admin.
 */
contract SovereignTrustToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    address public owner;
    mapping(address => bool) public minters;
    mapping(address => bool) public burners;
    mapping(address => bool) public pausers;
    mapping(address => bool) public whitelistAdmins;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public trustedForwarders;
    mapping(address => bool) public whitelisted;
    bool public whitelistEnabled;
    bool public paused;

    mapping(address => uint256) public nonces;

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 value);
    event Burn(address indexed from, uint256 value);
    event TrustedForwarderSet(address indexed forwarder, bool trusted);
    event Whitelisted(address indexed account, bool allowed);
    event WhitelistEnabled(bool enabled);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    modifier onlyOwner() {
        require(_msgSender() == owner, "SovereignTrustToken: not owner");
        _;
    }

    modifier onlyMinter() {
        require(minters[_msgSender()], "SovereignTrustToken: not minter");
        _;
    }

    modifier onlyBurner() {
        require(burners[_msgSender()], "SovereignTrustToken: not burner");
        _;
    }

    modifier onlyPauser() {
        require(pausers[_msgSender()], "SovereignTrustToken: not pauser");
        _;
    }

    modifier onlyWhitelistAdmin() {
        require(whitelistAdmins[_msgSender()], "SovereignTrustToken: not whitelist admin");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "SovereignTrustToken: paused");
        _;
    }

    constructor(string memory _name, string memory _symbol, address _owner) {
        require(_owner != address(0), "SovereignTrustToken: zero owner");
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

    // ─── Ownership & roles ───────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "SovereignTrustToken: zero owner");
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

    function setTrustedForwarder(address forwarder, bool trusted) external onlyOwner {
        trustedForwarders[forwarder] = trusted;
        emit TrustedForwarderSet(forwarder, trusted);
    }

    // ─── Whitelist ───────────────────────────────────────────────────────────────

    function setWhitelisted(address account, bool allowed) external onlyWhitelistAdmin {
        whitelisted[account] = allowed;
        emit Whitelisted(account, allowed);
    }

    function setWhitelistEnabled(bool enabled) external onlyWhitelistAdmin {
        whitelistEnabled = enabled;
        emit WhitelistEnabled(enabled);
    }

    function isWhitelisted(address account) public view returns (bool) {
        return !whitelistEnabled || whitelisted[account];
    }

    // ─── Pause ───────────────────────────────────────────────────────────────────

    function pause() external onlyPauser {
        paused = true;
        emit Paused(_msgSender());
    }

    function unpause() external onlyPauser {
        paused = false;
        emit Unpaused(_msgSender());
    }

    // ─── Mint / Burn ─────────────────────────────────────────────────────────────

    function mint(address to, uint256 amount) external onlyMinter {
        _beforeTokenTransfer(address(0), to, amount);
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
        emit Mint(to, amount);
    }

    function burn(uint256 amount) external {
        address sender = _msgSender();
        _beforeTokenTransfer(sender, address(0), amount);
        require(balanceOf[sender] >= amount, "SovereignTrustToken: insufficient balance");
        totalSupply -= amount;
        balanceOf[sender] -= amount;
        emit Transfer(sender, address(0), amount);
        emit Burn(sender, amount);
    }

    function burnFrom(address from, uint256 amount) external onlyBurner {
        _beforeTokenTransfer(from, address(0), amount);
        require(balanceOf[from] >= amount, "SovereignTrustToken: insufficient balance");
        totalSupply -= amount;
        balanceOf[from] -= amount;
        emit Transfer(from, address(0), amount);
        emit Burn(from, amount);
    }

    // ─── ERC-20 ──────────────────────────────────────────────────────────────────

    function transfer(address to, uint256 amount) external whenNotPaused returns (bool) {
        address sender = _msgSender();
        _beforeTokenTransfer(sender, to, amount);
        require(balanceOf[sender] >= amount, "SovereignTrustToken: insufficient balance");
        balanceOf[sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[_msgSender()][spender] = amount;
        emit Approval(_msgSender(), spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external whenNotPaused returns (bool) {
        address spender = _msgSender();
        _beforeTokenTransfer(from, to, amount);
        require(balanceOf[from] >= amount, "SovereignTrustToken: insufficient balance");
        require(allowance[from][spender] >= amount, "SovereignTrustToken: allowance exceeded");
        allowance[from][spender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    // ─── EIP-2612 Permit ─────────────────────────────────────────────────────────

    function permit(
        address _owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "SovereignTrustToken: permit expired");

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );

        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH,
                _owner,
                spender,
                value,
                nonces[_owner]++,
                deadline
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == _owner, "SovereignTrustToken: invalid permit signature");

        allowance[_owner][spender] = value;
        emit Approval(_owner, spender, value);
    }

    // ─── ERC-2771 context ────────────────────────────────────────────────────────

    function _msgSender() internal view returns (address) {
        if (msg.sender == address(this)) return msg.sender;
        if (trustedForwarders[msg.sender]) {
            uint256 calldataLength = msg.data.length;
            if (calldataLength >= 20) {
                return address(uint160(uint256(bytes32(msg.data[calldataLength - 20:calldataLength]))));
            }
        }
        return msg.sender;
    }

    // ─── Hooks ───────────────────────────────────────────────────────────────────

    function _beforeTokenTransfer(address from, address to, uint256 amount) internal view {
        require(amount > 0, "SovereignTrustToken: zero amount");
        if (whitelistEnabled) {
            require(from == address(0) || whitelisted[from], "SovereignTrustToken: sender not whitelisted");
            require(to == address(0) || whitelisted[to], "SovereignTrustToken: recipient not whitelisted");
        }
    }
}

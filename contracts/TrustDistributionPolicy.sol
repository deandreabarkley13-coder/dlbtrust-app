// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * TrustDistributionPolicy — the DLB Trust's distribution rules enforced on chain.
 *
 * The trust's settlement assets are custodied by this contract, not by the
 * backend's server wallet, so the rules hold even if that wallet's key is
 * compromised: the wallet is only a MAKER, and a maker can do nothing but
 * propose. Every release passes, in the contract:
 *
 *   1. beneficiary allow-list          (setBeneficiary, setBeneficiaryLimits per token)
 *   2. purpose code allow-list         (setPurpose)
 *   3. per-distribution ceilings       (beneficiary and token)
 *   4. rolling per-period ceilings     (beneficiary and token)
 *   5. maker/checker approval          (approvalThreshold distinct checkers, never the proposer)
 *   6. timelock                        (releaseDelay before execute)
 *   7. proposal expiry                 (execute refused after expiresAt)
 *   8. clawback window + vesting       (escrowed release, revocable until claimed)
 *   9. freeze / pause kill switches    (compliance and pauser roles)
 *
 * Execution is two-phase on purpose. `execute` only reserves the amount into an
 * escrow; the beneficiary is paid by `claim` once the clawback window has passed
 * and, for an installment schedule, once each tranche has vested. Until a tranche
 * is claimed, compliance can `revoke` it and the value returns to the trust — real
 * clawback, which is impossible once an ERC-20 has left the contract.
 *
 * Amounts are token smallest units (wei for the native asset). A ceiling of 0
 * means "no ceiling"; a periodSeconds of 0 disables the rolling window.
 *
 * `owner` is trustee governance and is expected to be a multisig: it sets policy
 * and roles. It cannot move value except through the same propose/approve/execute
 * path as everyone else.
 */
contract TrustDistributionPolicy {
    // ─── Types ───────────────────────────────────────────────────────────────────

    enum Role {
        Maker,
        Checker,
        Executor,
        Pauser,
        Compliance
    }

    enum Status {
        None,
        Proposed,
        Approved,
        Executed,
        Cancelled
    }

    struct Limits {
        bool allowed;
        uint256 maxPerDistribution;
        uint256 periodCap;
        uint32 periodSeconds;
    }

    struct Distribution {
        address token;
        address beneficiary;
        uint256 amount;
        bytes32 purpose;
        bytes32 ref;
        address proposer;
        uint64 proposedAt;
        uint64 approvedAt;
        uint64 eta;
        uint64 expiresAt;
        uint32 installments;
        uint32 interval;
        uint8 approvals;
        Status status;
    }

    struct Escrow {
        uint256 distributionId;
        address token;
        address beneficiary;
        uint256 amount;
        uint256 claimed;
        uint64 claimableAt;
        uint64 expiresAt;
        uint32 installments;
        uint32 interval;
        bool revoked;
    }

    address public constant NATIVE = address(0);

    // ─── Governance state ────────────────────────────────────────────────────────

    address public owner;
    bool public paused;
    uint8 public approvalThreshold;
    uint64 public releaseDelay;
    uint64 public clawbackWindow;
    /// Escrowed value unclaimed this long after it became claimable can be reclaimed by the trust. 0 disables.
    uint64 public claimWindow;

    mapping(Role => mapping(address => bool)) public hasRole;
    mapping(bytes32 => bool) public purposeAllowed;
    mapping(address => Limits) public tokenLimits;
    mapping(address => bool) public beneficiaryAllowed;
    /// Ceilings are per beneficiary AND token, because they are denominated in that token's smallest units.
    mapping(address => mapping(address => Limits)) public beneficiaryLimits;
    mapping(address => bool) public frozen;

    // ─── Ledger state ────────────────────────────────────────────────────────────

    uint256 public distributionCount;
    uint256 public escrowCount;
    mapping(uint256 => Distribution) private _distributions;
    mapping(uint256 => Escrow) private _escrows;
    mapping(uint256 => mapping(address => bool)) public approvedBy;
    mapping(uint256 => uint256) public escrowOf;
    mapping(bytes32 => bool) public referenceUsed;
    /// Value committed to escrows and not yet paid out or returned.
    mapping(address => uint256) public reserved;
    mapping(address => mapping(uint256 => uint256)) public tokenSpent;
    mapping(address => mapping(address => mapping(uint256 => uint256))) public beneficiarySpent;

    uint256 private _entered;

    // ─── Events ──────────────────────────────────────────────────────────────────

    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event RoleSet(Role indexed role, address indexed account, bool allowed);
    event ApprovalThresholdSet(uint8 threshold);
    event ReleaseDelaySet(uint64 seconds_);
    event ClawbackWindowSet(uint64 seconds_);
    event ClaimWindowSet(uint64 seconds_);
    event PurposeSet(bytes32 indexed purpose, bool allowed);
    event TokenLimitsSet(address indexed token, bool allowed, uint256 maxPerDistribution, uint256 periodCap, uint32 periodSeconds);
    event BeneficiarySet(address indexed beneficiary, bool allowed);
    event BeneficiaryLimitsSet(address indexed beneficiary, address indexed token, uint256 maxPerDistribution, uint256 periodCap, uint32 periodSeconds);
    event FrozenSet(address indexed account, bool frozen);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event NativeReceived(address indexed from, uint256 amount);

    event Proposed(
        uint256 indexed distributionId,
        address indexed beneficiary,
        address indexed token,
        uint256 amount,
        bytes32 purpose,
        bytes32 ref,
        address proposer,
        uint64 expiresAt
    );
    event Approved(uint256 indexed distributionId, address indexed checker, uint8 approvals, uint64 eta);
    event Cancelled(uint256 indexed distributionId, address indexed account, bytes32 reason);
    event Executed(uint256 indexed distributionId, uint256 indexed escrowId, uint256 amount, uint64 claimableAt);
    event Claimed(uint256 indexed escrowId, address indexed beneficiary, address indexed token, uint256 amount, uint256 claimedTotal);
    event Revoked(uint256 indexed escrowId, address indexed account, uint256 amount, bytes32 reason);
    event Reclaimed(uint256 indexed escrowId, uint256 amount);

    // ─── Modifiers ───────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "TDP: not owner");
        _;
    }

    modifier onlyRole(Role role) {
        require(hasRole[role][msg.sender], "TDP: role missing");
        _;
    }

    modifier onlyCompliance() {
        require(msg.sender == owner || hasRole[Role.Compliance][msg.sender], "TDP: not compliance");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "TDP: paused");
        _;
    }

    modifier nonReentrant() {
        require(_entered == 0, "TDP: reentrant");
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address owner_, uint8 approvalThreshold_, uint64 releaseDelay_, uint64 clawbackWindow_) {
        require(owner_ != address(0), "TDP: owner required");
        require(approvalThreshold_ >= 1 && approvalThreshold_ <= 10, "TDP: threshold 1-10");
        owner = owner_;
        approvalThreshold = approvalThreshold_;
        releaseDelay = releaseDelay_;
        clawbackWindow = clawbackWindow_;
        emit OwnerChanged(address(0), owner_);
        emit ApprovalThresholdSet(approvalThreshold_);
        emit ReleaseDelaySet(releaseDelay_);
        emit ClawbackWindowSet(clawbackWindow_);
    }

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    // ─── Governance ──────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "TDP: owner required");
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function setRole(Role role, address account, bool allowed) external onlyOwner {
        require(account != address(0), "TDP: account required");
        hasRole[role][account] = allowed;
        emit RoleSet(role, account, allowed);
    }

    function setApprovalThreshold(uint8 threshold) external onlyOwner {
        require(threshold >= 1 && threshold <= 10, "TDP: threshold 1-10");
        approvalThreshold = threshold;
        emit ApprovalThresholdSet(threshold);
    }

    function setReleaseDelay(uint64 seconds_) external onlyOwner {
        releaseDelay = seconds_;
        emit ReleaseDelaySet(seconds_);
    }

    function setClawbackWindow(uint64 seconds_) external onlyOwner {
        clawbackWindow = seconds_;
        emit ClawbackWindowSet(seconds_);
    }

    function setClaimWindow(uint64 seconds_) external onlyOwner {
        claimWindow = seconds_;
        emit ClaimWindowSet(seconds_);
    }

    function setPurpose(bytes32 purpose, bool allowed) external onlyOwner {
        require(purpose != bytes32(0), "TDP: purpose required");
        purposeAllowed[purpose] = allowed;
        emit PurposeSet(purpose, allowed);
    }

    function setTokenLimits(
        address token,
        bool allowed,
        uint256 maxPerDistribution,
        uint256 periodCap,
        uint32 periodSeconds
    ) external onlyOwner {
        tokenLimits[token] = Limits(allowed, maxPerDistribution, periodCap, periodSeconds);
        emit TokenLimitsSet(token, allowed, maxPerDistribution, periodCap, periodSeconds);
    }

    /// Add or remove a beneficiary from the allow-list. Removal stops new proposals, executions and claims.
    function setBeneficiary(address beneficiary, bool allowed) external onlyOwner {
        require(beneficiary != address(0), "TDP: beneficiary required");
        beneficiaryAllowed[beneficiary] = allowed;
        emit BeneficiarySet(beneficiary, allowed);
    }

    function setBeneficiaryLimits(
        address beneficiary,
        address token,
        uint256 maxPerDistribution,
        uint256 periodCap,
        uint32 periodSeconds
    ) external onlyOwner {
        require(beneficiary != address(0), "TDP: beneficiary required");
        beneficiaryLimits[beneficiary][token] = Limits(true, maxPerDistribution, periodCap, periodSeconds);
        emit BeneficiaryLimitsSet(beneficiary, token, maxPerDistribution, periodCap, periodSeconds);
    }

    /// Compliance kill switch for one account: blocks execution and claims.
    function setFrozen(address account, bool value) external onlyCompliance {
        frozen[account] = value;
        emit FrozenSet(account, value);
    }

    function pause() external {
        require(msg.sender == owner || hasRole[Role.Pauser][msg.sender], "TDP: not pauser");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Maker/checker distribution flow ─────────────────────────────────────────

    /**
     * Record an intended distribution. Nothing is reserved or moved: a proposal
     * is a request, and the proposer can never be one of its approvers.
     *
     * `ref` links the proposal to the backend distribution request and can
     * only be used once, so a replayed API call cannot double-propose.
     * `installments`/`interval` schedule the release: 1 installment pays the whole
     * amount when the clawback window ends, N installments vest linearly.
     */
    function propose(
        address token,
        address beneficiary,
        uint256 amount,
        bytes32 purpose,
        bytes32 ref,
        uint64 expiresAt,
        uint32 installments,
        uint32 interval
    ) external onlyRole(Role.Maker) whenNotPaused returns (uint256 distributionId) {
        require(amount > 0, "TDP: amount required");
        require(ref != bytes32(0) && !referenceUsed[ref], "TDP: ref invalid");
        require(purposeAllowed[purpose], "TDP: purpose not allowed");
        require(beneficiaryAllowed[beneficiary], "TDP: beneficiary not allowed");
        require(!frozen[beneficiary], "TDP: beneficiary frozen");
        require(tokenLimits[token].allowed, "TDP: token not allowed");
        require(expiresAt == 0 || expiresAt > block.timestamp, "TDP: already expired");
        require(installments >= 1, "TDP: installments >= 1");
        require(installments == 1 || interval > 0, "TDP: interval required");
        _withinPerDistributionLimits(token, beneficiary, amount);

        referenceUsed[ref] = true;
        distributionId = ++distributionCount;
        _distributions[distributionId] = Distribution({
            token: token,
            beneficiary: beneficiary,
            amount: amount,
            purpose: purpose,
            ref: ref,
            proposer: msg.sender,
            proposedAt: uint64(block.timestamp),
            approvedAt: 0,
            eta: 0,
            expiresAt: expiresAt,
            installments: installments,
            interval: interval,
            approvals: 0,
            status: Status.Proposed
        });
        emit Proposed(distributionId, beneficiary, token, amount, purpose, ref, msg.sender, expiresAt);
    }

    /// Checker approval. Distinct checkers only, never the proposer; the timelock starts at the last approval.
    function approve(uint256 distributionId) external onlyRole(Role.Checker) whenNotPaused {
        Distribution storage d = _distributions[distributionId];
        require(d.status == Status.Proposed, "TDP: not proposed");
        require(d.proposer != msg.sender, "TDP: proposer cannot approve");
        require(!approvedBy[distributionId][msg.sender], "TDP: already approved");
        require(d.expiresAt == 0 || block.timestamp <= d.expiresAt, "TDP: expired");

        approvedBy[distributionId][msg.sender] = true;
        d.approvals += 1;
        if (d.approvals >= approvalThreshold) {
            d.status = Status.Approved;
            d.approvedAt = uint64(block.timestamp);
            d.eta = uint64(block.timestamp) + releaseDelay;
        }
        emit Approved(distributionId, msg.sender, d.approvals, d.eta);
    }

    function cancel(uint256 distributionId, bytes32 reason) external {
        Distribution storage d = _distributions[distributionId];
        require(d.status == Status.Proposed || d.status == Status.Approved, "TDP: not cancellable");
        require(
            msg.sender == owner || msg.sender == d.proposer || hasRole[Role.Compliance][msg.sender],
            "TDP: not authorised"
        );
        d.status = Status.Cancelled;
        emit Cancelled(distributionId, msg.sender, reason);
    }

    /**
     * Commit an approved distribution once its timelock has run: the amount is
     * reserved into an escrow and counts against the rolling ceilings. No value
     * leaves the contract here — `claim` does that, after the clawback window.
     */
    function execute(uint256 distributionId)
        external
        onlyRole(Role.Executor)
        whenNotPaused
        returns (uint256 escrowId)
    {
        Distribution storage d = _distributions[distributionId];
        require(d.status == Status.Approved, "TDP: not approved");
        require(block.timestamp >= d.eta, "TDP: timelocked");
        require(d.expiresAt == 0 || block.timestamp <= d.expiresAt, "TDP: expired");
        require(!frozen[d.beneficiary], "TDP: beneficiary frozen");
        require(beneficiaryAllowed[d.beneficiary], "TDP: beneficiary not allowed");
        require(tokenLimits[d.token].allowed, "TDP: token not allowed");
        require(available(d.token) >= d.amount, "TDP: insufficient unreserved balance");
        _withinPerDistributionLimits(d.token, d.beneficiary, d.amount);
        _consumePeriodLimits(d.token, d.beneficiary, d.amount);

        d.status = Status.Executed;
        reserved[d.token] += d.amount;

        uint64 claimableAt = uint64(block.timestamp) + clawbackWindow;
        escrowId = ++escrowCount;
        _escrows[escrowId] = Escrow({
            distributionId: distributionId,
            token: d.token,
            beneficiary: d.beneficiary,
            amount: d.amount,
            claimed: 0,
            claimableAt: claimableAt,
            expiresAt: claimWindow == 0 ? 0 : claimableAt + claimWindow,
            installments: d.installments,
            interval: d.interval,
            revoked: false
        });
        escrowOf[distributionId] = escrowId;
        emit Executed(distributionId, escrowId, d.amount, claimableAt);
    }

    // ─── Release and clawback ────────────────────────────────────────────────────

    /// Pay the beneficiary everything vested and unclaimed. Callable by anyone; funds only ever go to the beneficiary.
    function claim(uint256 escrowId) external nonReentrant whenNotPaused returns (uint256 amount) {
        Escrow storage e = _escrows[escrowId];
        require(e.amount > 0, "TDP: unknown escrow");
        require(!e.revoked, "TDP: revoked");
        require(!frozen[e.beneficiary], "TDP: beneficiary frozen");
        require(beneficiaryAllowed[e.beneficiary], "TDP: beneficiary not allowed");
        require(e.expiresAt == 0 || block.timestamp <= e.expiresAt, "TDP: claim expired");
        amount = claimable(escrowId);
        require(amount > 0, "TDP: nothing claimable");

        e.claimed += amount;
        reserved[e.token] -= amount;
        emit Claimed(escrowId, e.beneficiary, e.token, amount, e.claimed);
        _payOut(e.token, e.beneficiary, amount);
    }

    /// Clawback: return the unclaimed remainder of an escrow to the trust's unreserved balance.
    function revoke(uint256 escrowId, bytes32 reason) external onlyCompliance returns (uint256 amount) {
        Escrow storage e = _escrows[escrowId];
        require(e.amount > 0, "TDP: unknown escrow");
        require(!e.revoked, "TDP: revoked");
        amount = e.amount - e.claimed;
        require(amount > 0, "TDP: fully claimed");
        e.revoked = true;
        reserved[e.token] -= amount;
        emit Revoked(escrowId, msg.sender, amount, reason);
    }

    /// Un-reserve value the beneficiary never claimed within the claim window.
    function reclaimExpired(uint256 escrowId) external onlyOwner returns (uint256 amount) {
        Escrow storage e = _escrows[escrowId];
        require(e.amount > 0, "TDP: unknown escrow");
        require(!e.revoked, "TDP: revoked");
        require(e.expiresAt != 0 && block.timestamp > e.expiresAt, "TDP: not expired");
        amount = e.amount - e.claimed;
        require(amount > 0, "TDP: fully claimed");
        e.revoked = true;
        reserved[e.token] -= amount;
        emit Reclaimed(escrowId, amount);
    }

    // ─── Views ───────────────────────────────────────────────────────────────────

    /// Balance not already committed to an escrow.
    function available(address token) public view returns (uint256) {
        uint256 balance = token == NATIVE ? address(this).balance : _balanceOf(token);
        uint256 held = reserved[token];
        return balance > held ? balance - held : 0;
    }

    function balanceOfToken(address token) external view returns (uint256) {
        return token == NATIVE ? address(this).balance : _balanceOf(token);
    }

    /// Vested share of an escrow, ignoring what has already been claimed.
    function vested(uint256 escrowId) public view returns (uint256) {
        Escrow storage e = _escrows[escrowId];
        if (e.amount == 0 || block.timestamp < e.claimableAt) return 0;
        if (e.installments <= 1) return e.amount;
        uint256 elapsed = block.timestamp - e.claimableAt;
        uint256 tranches = 1 + elapsed / e.interval;
        if (tranches >= e.installments) return e.amount;
        return (e.amount * tranches) / e.installments;
    }

    function claimable(uint256 escrowId) public view returns (uint256) {
        Escrow storage e = _escrows[escrowId];
        if (e.revoked) return 0;
        if (e.expiresAt != 0 && block.timestamp > e.expiresAt) return 0;
        uint256 due = vested(escrowId);
        return due > e.claimed ? due - e.claimed : 0;
    }

    function distributions(uint256 distributionId) external view returns (Distribution memory) {
        return _distributions[distributionId];
    }

    function escrows(uint256 escrowId) external view returns (Escrow memory) {
        return _escrows[escrowId];
    }

    function periodIndex(uint32 periodSeconds) public view returns (uint256) {
        return periodSeconds == 0 ? 0 : block.timestamp / periodSeconds;
    }

    /// Remaining rolling-period headroom for a beneficiary/token pair; type(uint256).max when uncapped.
    function remainingPeriodAllowance(address token, address beneficiary)
        external
        view
        returns (uint256 beneficiaryRemaining, uint256 tokenRemaining)
    {
        Limits storage bl = beneficiaryLimits[beneficiary][token];
        Limits storage tl = tokenLimits[token];
        beneficiaryRemaining = _remaining(
            bl.periodCap,
            beneficiarySpent[beneficiary][token][periodIndex(bl.periodSeconds)]
        );
        tokenRemaining = _remaining(tl.periodCap, tokenSpent[token][periodIndex(tl.periodSeconds)]);
    }

    // ─── Internals ───────────────────────────────────────────────────────────────

    function _remaining(uint256 cap, uint256 spent) private pure returns (uint256) {
        if (cap == 0) return type(uint256).max;
        return cap > spent ? cap - spent : 0;
    }

    function _withinPerDistributionLimits(address token, address beneficiary, uint256 amount) private view {
        uint256 benCap = beneficiaryLimits[beneficiary][token].maxPerDistribution;
        uint256 tokCap = tokenLimits[token].maxPerDistribution;
        require(benCap == 0 || amount <= benCap, "TDP: over beneficiary per-distribution cap");
        require(tokCap == 0 || amount <= tokCap, "TDP: over token per-distribution cap");
    }

    function _consumePeriodLimits(address token, address beneficiary, uint256 amount) private {
        Limits storage bl = beneficiaryLimits[beneficiary][token];
        if (bl.periodCap > 0) {
            uint256 idx = periodIndex(bl.periodSeconds);
            uint256 next = beneficiarySpent[beneficiary][token][idx] + amount;
            require(next <= bl.periodCap, "TDP: over beneficiary period cap");
            beneficiarySpent[beneficiary][token][idx] = next;
        }
        Limits storage tl = tokenLimits[token];
        if (tl.periodCap > 0) {
            uint256 idx = periodIndex(tl.periodSeconds);
            uint256 next = tokenSpent[token][idx] + amount;
            require(next <= tl.periodCap, "TDP: over token period cap");
            tokenSpent[token][idx] = next;
        }
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        require(ok && data.length >= 32, "TDP: balanceOf failed");
        return abi.decode(data, (uint256));
    }

    function _payOut(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool sent, ) = payable(to).call{value: amount}("");
            require(sent, "TDP: native transfer failed");
            return;
        }
        // transfer(address,uint256); tolerate non-standard tokens that return no data.
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TDP: transfer failed");
    }
}

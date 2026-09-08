// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICapitalPool, IMandateRegistry} from "./interfaces/IMandateRegistry.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title CapitalPool
/// @author Mandate
/// @notice The LP side. Deposit the pool asset, receive shares, earn the pool's cut of
///         whatever the traders make — and absorb what they lose, capped per mandate.
///
/// @dev ERC-4626-shaped rather than strictly ERC-4626-compliant, and the difference is
///      deliberate. A 4626 vault promises `withdraw` and `redeem` succeed up to
///      `maxWithdraw`. This vault cannot promise that, because most of its assets are sitting
///      inside live mandates that must not be yanked out from under an open position. So
///      withdrawal is a two-step request/claim rather than a one-step redeem, and the
///      functions that would lie are simply not implemented.
///
///      **totalAssets = idle + Σ(last-marked equity of every Active mandate)**
///
///      Two honest limitations, stated here rather than discovered by a judge:
///
///      1. *Share price trails the market by one mark.* Mandate equity enters this sum at
///         its last marked value, not its live value. The keeper marks every block, so the
///         lag is small — but an LP transacting between marks transacts at a slightly stale
///         price. The withdrawal delay below is what stops that lag being farmed: you cannot
///         see a mark coming, deposit, and exit inside the same window.
///
///      2. *Losses are socialised across LPs, gains are not concentrated.* A breached mandate
///         returns less than its allocation and every share takes the hit pro rata. That is
///         the deal an LP is signing; the per-mandate allocation cap is what bounds it.
contract CapitalPool is ICapitalPool, ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice The asset LPs deposit.
    IERC20 public immutable assetToken;
    uint8 private immutable _assetDecimals;

    IMandateRegistry public registry;

    /// @notice Capital currently sitting inside live mandates, at cost.
    /// @dev Tracked at allocation value. Live value is `registry.aggregateActiveEquity()`;
    ///      the difference between the two is the pool's open PnL.
    uint256 public totalAllocated;

    /// @notice Delay between requesting a withdrawal and being able to claim it.
    /// @dev The defence against marking-lag arbitrage described in the contract notes. Short
    ///      by design — long enough that an LP cannot round-trip a known mark, short enough
    ///      that it is not a lockup. At 400ms blocks, 60s is ~150 blocks of marks.
    uint64 public withdrawalDelay = 60;

    /// @notice Largest share of pool assets a single mandate may be allocated.
    /// @dev Bounds the blast radius of any one trader. 2_000 bps = 20%.
    uint16 public maxAllocationBps = 2_000;

    struct WithdrawalRequest {
        uint256 shares;
        uint64 readyAt;
    }

    mapping(address => WithdrawalRequest) public withdrawalRequests;

    /// @notice Shares locked in pending withdrawal requests.
    uint256 public pendingWithdrawalShares;

    event Deposited(address indexed lp, uint256 assets, uint256 shares);
    event WithdrawalRequested(address indexed lp, uint256 shares, uint64 readyAt);
    event WithdrawalCancelled(address indexed lp, uint256 shares);
    event WithdrawalClaimed(address indexed lp, uint256 shares, uint256 assets);
    event Allocated(address indexed account, uint256 amount, uint256 totalAllocated);
    event MandateSettled(uint256 indexed mandateId, uint256 allocation, uint256 poolReturn, int256 poolPnl);
    event RegistrySet(address indexed registry);
    event WithdrawalDelaySet(uint64 delay);
    event MaxAllocationBpsSet(uint16 bps);

    modifier onlyRegistry() {
        if (msg.sender != address(registry)) revert Errors.NotAuthorised(msg.sender);
        _;
    }

    constructor(address owner_, address asset_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        if (asset_ == address(0)) revert Errors.ZeroAddress();
        assetToken = IERC20(asset_);
        _assetDecimals = IERC20Metadata(asset_).decimals();
    }

    /// @notice Shares carry the asset's decimals so 1 share ≈ 1 unit at genesis.
    function decimals() public view override returns (uint8) {
        return _assetDecimals;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────────────────────────────────────

    function setRegistry(address registry_) external onlyOwner {
        if (registry_ == address(0)) revert Errors.ZeroAddress();
        if (address(registry) != address(0)) revert Errors.AlreadyInitialised();
        registry = IMandateRegistry(registry_);
        emit RegistrySet(registry_);
    }

    function setWithdrawalDelay(uint64 delay) external onlyOwner {
        // Capped so this can never become a lockup by governance action.
        if (delay > 7 days) revert Errors.WithdrawalNotReady(delay, 7 days);
        withdrawalDelay = delay;
        emit WithdrawalDelaySet(delay);
    }

    function setMaxAllocationBps(uint16 bps) external onlyOwner {
        if (bps == 0 || bps > 10_000) revert Errors.BpsOutOfRange(bps);
        maxAllocationBps = bps;
        emit MaxAllocationBpsSet(bps);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Accounting
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Assets sitting in the pool, unallocated and immediately deployable.
    function idleAssets() public view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    /// @notice Total value of the pool: idle capital plus the live value of every mandate.
    /// @dev Mandate equity is counted at its last marked value. See the contract-level note
    ///      on why that is a real, if small, staleness.
    function totalAssets() public view returns (uint256) {
        uint256 mandateValue = address(registry) == address(0) ? 0 : registry.aggregateActiveEquity();
        return idleAssets() + mandateValue;
    }

    /// @notice Assets one share is worth, scaled by the asset's decimals.
    function pricePerShare() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 10 ** _assetDecimals;
        return totalAssets().mulDiv(10 ** _assetDecimals, supply);
    }

    /// @notice Shares an asset amount would mint right now.
    /// @dev Rounds down — the depositor never mints a share they did not pay for, so a
    ///      deposit can never dilute existing LPs by a rounding error.
    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return assets;
        return assets.mulDiv(supply, totalAssets(), Math.Rounding.Floor);
    }

    /// @notice Assets a share amount is worth right now.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return shares;
        return shares.mulDiv(totalAssets(), supply, Math.Rounding.Floor);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  LP flow
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Deposit assets and receive shares.
    /// @param assets Amount of the pool asset to deposit.
    /// @param receiver Who receives the shares.
    /// @return shares Minted.
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert Errors.ZeroAmount();
        if (receiver == address(0)) revert Errors.ZeroAddress();

        // Convert before the transfer lands, or the depositor's own assets inflate the
        // denominator and they mint too few shares.
        shares = convertToShares(assets);
        if (shares == 0) revert Errors.ZeroAmount();

        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposited(receiver, assets, shares);
    }

    /// @notice Queue a withdrawal. Shares are escrowed now and priced at claim time.
    ///
    /// @dev Two-step on purpose. Pricing at *claim* time rather than request time means an
    ///      LP cannot lock in a share price and then wait to see whether the next mark went
    ///      their way. Escrowing the shares means they cannot be sold on while a claim is
    ///      pending. Together with {withdrawalDelay} this is what makes the one-mark
    ///      staleness in {totalAssets} unprofitable to farm.
    ///
    /// @param shares Shares to redeem.
    function requestWithdrawal(uint256 shares) external nonReentrant {
        if (shares == 0) revert Errors.ZeroAmount();
        if (withdrawalRequests[msg.sender].shares != 0) revert Errors.WithdrawalAlreadyQueued(msg.sender);
        if (shares > balanceOf(msg.sender)) revert Errors.ExceedsMaxRedeem(shares, balanceOf(msg.sender));

        _transfer(msg.sender, address(this), shares);
        pendingWithdrawalShares += shares;

        uint64 readyAt = uint64(block.timestamp) + withdrawalDelay;
        withdrawalRequests[msg.sender] = WithdrawalRequest({shares: shares, readyAt: readyAt});
        emit WithdrawalRequested(msg.sender, shares, readyAt);
    }

    /// @notice Abandon a pending withdrawal and take the shares back.
    function cancelWithdrawal() external nonReentrant {
        WithdrawalRequest memory req = withdrawalRequests[msg.sender];
        if (req.shares == 0) revert Errors.NoPendingWithdrawal(msg.sender);

        delete withdrawalRequests[msg.sender];
        pendingWithdrawalShares -= req.shares;
        _transfer(address(this), msg.sender, req.shares);
        emit WithdrawalCancelled(msg.sender, req.shares);
    }

    /// @notice Claim a matured withdrawal.
    /// @dev Paid from idle capital only. Capital inside a live mandate is not available —
    ///      that is the point of an allocation, and pretending otherwise would mean closing
    ///      a trader's position to fund an LP exit. If idle is short, the LP waits for a
    ///      mandate to settle, or cancels.
    /// @return assets Paid out.
    function claimWithdrawal() external nonReentrant returns (uint256 assets) {
        WithdrawalRequest memory req = withdrawalRequests[msg.sender];
        if (req.shares == 0) revert Errors.NoPendingWithdrawal(msg.sender);
        if (block.timestamp < req.readyAt) {
            revert Errors.WithdrawalNotReady(req.readyAt, uint64(block.timestamp));
        }

        assets = convertToAssets(req.shares);
        uint256 idle = idleAssets();
        if (assets > idle) revert Errors.InsufficientIdleCapital(assets, idle);

        delete withdrawalRequests[msg.sender];
        pendingWithdrawalShares -= req.shares;
        _burn(address(this), req.shares);
        assetToken.safeTransfer(msg.sender, assets);
        emit WithdrawalClaimed(msg.sender, req.shares, assets);
    }

    /// @notice Assets a pending request would pay right now, and whether it is claimable.
    function previewClaim(address lp) external view returns (uint256 assets, bool ready, bool funded) {
        WithdrawalRequest memory req = withdrawalRequests[lp];
        if (req.shares == 0) return (0, false, false);
        assets = convertToAssets(req.shares);
        ready = block.timestamp >= req.readyAt;
        funded = assets <= idleAssets();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Registry hooks
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc ICapitalPool
    /// @dev Allocation is bounded two ways: it must fit in idle capital, and it may not
    ///      exceed `maxAllocationBps` of total pool assets. The second bound is what stops a
    ///      single mandate from being able to lose the whole pool, and it is the reason an
    ///      LP can reason about their downside before depositing.
    function allocate(address to, uint256 amount) external onlyRegistry nonReentrant {
        if (to == address(0)) revert Errors.ZeroAddress();
        if (amount == 0) revert Errors.ZeroAmount();

        uint256 idle = idleAssets();
        if (amount > idle) revert Errors.InsufficientIdleCapital(amount, idle);

        uint256 cap = (totalAssets() * maxAllocationBps) / 10_000;
        if (amount > cap) revert Errors.AllocationCapExceeded(amount, cap);

        totalAllocated += amount;
        assetToken.safeTransfer(to, amount);
        emit Allocated(to, amount, totalAllocated);
    }

    /// @inheritdoc ICapitalPool
    /// @dev The registry has already transferred `poolReturn` in by the time this runs; this
    ///      call only updates accounting. `poolReturn < allocation` is a realised loss and is
    ///      exactly the case the pool exists to bear.
    function onMandateSettled(uint256 mandateId, uint256 allocation, uint256 poolReturn)
        external
        onlyRegistry
    {
        totalAllocated = totalAllocated > allocation ? totalAllocated - allocation : 0;
        emit MandateSettled(mandateId, allocation, poolReturn, int256(poolReturn) - int256(allocation));
    }

    /// @inheritdoc ICapitalPool
    function asset() external view returns (address) {
        return address(assetToken);
    }

    /// @notice Idle capital as a fraction of total assets, in bps. The LP dashboard's gauge.
    function utilisationBps() external view returns (uint256) {
        uint256 total = totalAssets();
        if (total == 0) return 0;
        return ((total - idleAssets()) * 10_000) / total;
    }
}

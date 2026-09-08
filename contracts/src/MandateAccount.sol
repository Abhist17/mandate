// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPerpVenue} from "./interfaces/IPerpVenue.sol";
import {IMandateRegistry} from "./interfaces/IMandateRegistry.sol";
import {RiskEngine} from "./libraries/RiskEngine.sol";
import {Types} from "./libraries/Types.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title MandateAccount
/// @author Mandate
/// @notice Holds one mandate's capital and is the only address that may trade it.
///
/// @dev Deployed as an EIP-1167 minimal proxy per mandate. One clone per mandate isolates
///      state and costs a few thousand gas instead of a full deployment — which matters,
///      because a prop firm issues mandates constantly.
///
///      **Two enforcement points, and both are necessary.**
///
///      *Pre-trade* (here): reject an order that is already outside the terms — oversized
///      notional, or a fill that would land the mandate under its floor even before the
///      market moves.
///
///      *Per-block* (MandateRegistry.markAndEnforce): catch what moved against the trader
///      after they were filled.
///
///      Pre-trade alone is not enough, and it is worth being precise about why: price moves
///      after you are filled. A position that was inside every limit at signing time is
///      outside them thirty seconds later, and no amount of pre-trade checking prevents
///      that. Per-block alone is not enough either — it would let a trader open a position
///      that is instantly, obviously fatal and only catch it a block later, after the fee
///      and spread have already been paid out of the pool's capital.
contract MandateAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Registry that issued this mandate. Also the only address that may settle it.
    IMandateRegistry public registry;
    IPerpVenue public venue;
    IERC20 public assetToken;

    address public trader;
    uint256 public mandateId;

    /// @notice Set once by the clone initialiser.
    bool private _initialised;

    event Initialised(uint256 indexed mandateId, address indexed trader, address venue);
    event OrderPlaced(
        uint256 indexed mandateId, uint16 indexed marketId, bool isLong, uint256 size, uint256 fillPrice
    );
    event OrderClosed(uint256 indexed mandateId, uint16 indexed marketId, int256 realisedPnl);
    event SweptToRegistry(uint256 indexed mandateId, uint256 amount);

    modifier onlyTrader() {
        if (msg.sender != trader) revert Errors.NotMandateTrader(mandateId, msg.sender);
        _;
    }

    modifier onlyRegistry() {
        if (msg.sender != address(registry)) revert Errors.NotAuthorised(msg.sender);
        _;
    }

    /// @notice Initialise a freshly cloned account.
    /// @dev Callable exactly once. The implementation contract itself is left uninitialised
    ///      and holds nothing, so there is nothing to seize by initialising it.
    function initialize(uint256 mandateId_, address trader_, address registry_, address venue_)
        external
    {
        if (_initialised) revert Errors.AlreadyInitialised();
        if (trader_ == address(0) || registry_ == address(0) || venue_ == address(0)) {
            revert Errors.ZeroAddress();
        }
        _initialised = true;
        mandateId = mandateId_;
        trader = trader_;
        registry = IMandateRegistry(registry_);
        venue = IPerpVenue(venue_);
        assetToken = IERC20(IPerpVenue(venue_).asset());
        emit Initialised(mandateId_, trader_, venue_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Trading
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Post idle capital to the venue as collateral.
    /// @dev Separate from {openPosition} so the registry can fund the account before the
    ///      trader ever calls it, and so a trader can top the venue up without trading.
    function fundVenue(uint256 amount) public nonReentrant {
        if (msg.sender != trader && msg.sender != address(registry)) {
            revert Errors.NotAuthorised(msg.sender);
        }
        if (amount == 0) revert Errors.ZeroAmount();
        assetToken.forceApprove(address(venue), amount);
        venue.deposit(amount);
    }

    /// @notice Open or add to a position, subject to the mandate's terms.
    ///
    /// @dev Checks, in order:
    ///        1. the mandate is Active and not past expiry
    ///        2. resulting total notional is within `allocation * maxPositionBps / 10_000`
    ///        3. equity, after the fill and after a worst-case adverse move, still clears
    ///           the binding floor
    ///
    ///      Check 3 is the one that earns its keep. A trader one tick above their drawdown
    ///      floor can technically place a trade that satisfies the position cap; that trade
    ///      is a coin flip on the mandate itself, paid for with the pool's money. The
    ///      slippage buffer is the registry's `preTradeBufferBps` and is a stated,
    ///      configurable parameter rather than a hidden constant.
    ///
    /// @param marketId Venue market.
    /// @param isLong Direction.
    /// @param size Base units, 1e18.
    /// @param limitPrice Worst acceptable fill, 1e8. 0 disables.
    /// @return fillPrice Executed price.
    function openPosition(uint16 marketId, bool isLong, uint256 size, uint256 limitPrice)
        external
        onlyTrader
        nonReentrant
        returns (uint256 fillPrice)
    {
        Types.Terms memory terms = registry.termsOf(mandateId);
        _requireTradeable(terms);

        // ── 2. position cap ──────────────────────────────────────────────────────
        uint256 addedNotional = venue.quoteNotional(marketId, size);
        uint256 projectedNotional = venue.totalNotional(address(this)) + addedNotional;
        uint256 cap = RiskEngine.maxNotional(terms.allocation, terms.maxPositionBps);
        if (projectedNotional > cap) revert Errors.PositionCapExceeded(projectedNotional, cap);

        // ── 3. would this order put the mandate under its floor? ─────────────────
        _requireHeadroomAfter(addedNotional);

        fillPrice = venue.openPosition(marketId, isLong, size, limitPrice);
        emit OrderPlaced(mandateId, marketId, isLong, size, fillPrice);
    }

    /// @notice Close a position.
    /// @dev No risk check: closing can only reduce exposure, and a trader must always be
    ///      able to get flat. Blocking a close to satisfy a risk rule would be perverse.
    function closePosition(uint16 marketId, uint256 limitPrice)
        external
        onlyTrader
        nonReentrant
        returns (int256 realisedPnl)
    {
        realisedPnl = venue.closePosition(marketId, limitPrice);
        emit OrderClosed(mandateId, marketId, realisedPnl);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Settlement (registry only)
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Close everything and return all capital to the registry for settlement.
    /// @dev The registry calls this during breach, expiry or voluntary close. It flattens
    ///      through the venue's authorised path, pulls collateral back, and sweeps the whole
    ///      balance out. Nothing is left behind for the trader to reclaim later.
    /// @return swept Total asset amount handed to the registry.
    function liquidateAndSweep() external onlyRegistry nonReentrant returns (uint256 swept) {
        if (venue.openMarkets(address(this)).length > 0) {
            venue.flatten(address(this));
        }
        uint256 free = venue.freeCollateral(address(this));
        if (free > 0) venue.withdraw(free);

        swept = assetToken.balanceOf(address(this));
        if (swept > 0) assetToken.safeTransfer(address(registry), swept);
        emit SweptToRegistry(mandateId, swept);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Total value controlled by this mandate: venue equity plus any idle balance.
    /// @dev This is the number every mark and every settlement is computed from.
    function equity() public view returns (uint256) {
        return venue.accountEquity(address(this)) + assetToken.balanceOf(address(this));
    }

    /// @notice Signed PnL versus the original allocation.
    function netPnl(uint256 allocation) external view returns (int256) {
        return int256(equity()) - int256(allocation);
    }

    /// @notice Open notional across every market.
    function notional() external view returns (uint256) {
        return venue.totalNotional(address(this));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Internal checks
    // ─────────────────────────────────────────────────────────────────────────────

    function _requireTradeable(Types.Terms memory terms) internal view {
        if (!registry.isActive(mandateId)) revert Errors.MandateNotActive(mandateId);
        if (block.timestamp >= terms.expiry) revert Errors.MandateExpired(mandateId);
    }

    /// @dev Reject an order whose worst-case immediate outcome breaches the floor.
    ///      Worst case is modelled as an adverse move of `preTradeBufferBps` on the new
    ///      notional, on top of the position already held.
    function _requireHeadroomAfter(uint256 addedNotional) internal view {
        (uint256 floor, ) = registry.floorOf(mandateId);
        uint256 current = equity();
        uint256 buffer = (addedNotional * registry.preTradeBufferBps()) / RiskEngine.BPS;
        uint256 projected = current > buffer ? current - buffer : 0;
        if (projected < floor) revert Errors.WouldBreachFloor(projected, floor);
    }
}

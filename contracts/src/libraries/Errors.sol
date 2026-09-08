// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Errors
/// @notice Every revert reason in the protocol, as custom errors.
/// @dev Grouped by the contract that raises them. Custom errors over require strings —
///      cheaper, and the selector is greppable in a failed-tx trace.
library Errors {
    // ── shared ────────────────────────────────────────────────────────────────
    error ZeroAddress();
    error ZeroAmount();
    error NotAuthorised(address caller);
    error AlreadyInitialised();

    // ── terms validation ──────────────────────────────────────────────────────
    /// @dev A bps term exceeded 10_000 (100%).
    error BpsOutOfRange(uint16 value);
    /// @dev maxDrawdownBps must be > 0, else the mandate breaches on the first tick.
    error DrawdownMustBeNonZero();
    /// @dev A mandate whose daily loss limit is looser than its trailing drawdown makes
    ///      the daily limit dead code. Rejected so the terms mean what they say.
    error DailyLossLooserThanDrawdown(uint16 dailyLossBps, uint16 maxDrawdownBps);
    error ExpiryInPast(uint64 expiry, uint64 nowTs);
    error PositionCapTooLow(uint16 maxPositionBps);

    // ── registry / mandate lifecycle ──────────────────────────────────────────
    error UnknownMandate(uint256 mandateId);
    error MandateNotActive(uint256 mandateId);
    error MandateExpired(uint256 mandateId);
    error MandateNotSettleable(uint256 mandateId);
    error NotMandateTrader(uint256 mandateId, address caller);
    error PositionStillOpen(uint256 mandateId);

    // ── pre-trade constraint checks ───────────────────────────────────────────
    /// @dev Resulting notional would exceed allocation * maxPositionBps / 10_000.
    error PositionCapExceeded(uint256 notional, uint256 cap);
    /// @dev Projected equity after worst-case slippage would sit under a floor.
    error WouldBreachFloor(uint256 projectedEquity, uint256 floor);
    error SlippageToleranceTooWide(uint16 bps);

    // ── capital pool ──────────────────────────────────────────────────────────
    error InsufficientIdleCapital(uint256 requested, uint256 idle);
    error WithdrawalNotReady(uint64 readyAt, uint64 nowTs);
    error NoPendingWithdrawal(address owner);
    error WithdrawalAlreadyQueued(address owner);
    error ExceedsMaxRedeem(uint256 shares, uint256 maxShares);
    error AllocationCapExceeded(uint256 requested, uint256 cap);

    // ── venue ─────────────────────────────────────────────────────────────────
    error UnknownMarket(uint16 marketId);
    error MarketClosed(uint16 marketId);
    error MarketAlreadyListed(uint16 marketId);
    error NoOpenPosition(address account, uint16 marketId);
    error PositionAlreadyOpen(address account, uint16 marketId);
    error InsufficientMargin(uint256 required, uint256 available);
    error SlippageExceeded(uint256 executionPrice, uint256 limitPrice);
    error SizeTooSmall(uint256 size, uint256 minSize);
    /// @dev The venue does not hold enough asset to pay a winning position out.
    error InsufficientVenueLiquidity(uint256 requested, uint256 available);

    // ── oracle ────────────────────────────────────────────────────────────────
    error StalePrice(uint16 marketId, uint64 publishedAt, uint64 maxAge);
    error InvalidPrice(int256 price);
    error NoPriceFeed(uint16 marketId);
    error PriceDeviationTooLarge(uint256 previous, uint256 next, uint256 maxDeviationBps);
}

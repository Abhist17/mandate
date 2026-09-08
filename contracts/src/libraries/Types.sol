// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Types
/// @notice Shared structs and enums. Kept in one place so the indexer, the keeper and the
///         frontend can all be generated from a single source of truth.
library Types {
    /// @notice Lifecycle of a mandate.
    /// @dev Active is the only state in which orders are accepted. Every terminal state is
    ///      reached exactly once and is final — there is no un-breaching.
    enum Status {
        None, // never issued
        Active, // trading
        Breached, // hit a risk floor; position flattened, capital returned to the pool
        Expired, // ran past its expiry without breaching
        Closed // closed voluntarily by the trader or the pool

    }

    /// @notice Why a mandate stopped being Active.
    enum BreachKind {
        None,
        TrailingDrawdown, // equity fell below highWaterMark * (1 - maxDrawdownBps)
        DailyLoss, // equity fell below dayStartEquity * (1 - dailyLossBps)
        Expiry // past the expiry timestamp

    }

    /// @notice The rules of a mandate. Fixed at issuance and never mutable — the whole
    ///         point is that both sides can read the terms before either commits.
    struct Terms {
        uint256 allocation; // capital granted, in pool-asset units
        uint16 maxDrawdownBps; // trailing drawdown from the equity high-water mark
        uint16 dailyLossBps; // loss limit from day-start equity
        uint16 profitSplitBps; // trader's share of profit at settlement
        uint16 maxPositionBps; // notional cap as bps of allocation (30_000 = 3x)
        uint64 expiry; // unix seconds; the mandate is dead after this
        uint8 resetHourUtc; // hour of day the daily loss window rolls (0 = 00:00 UTC)
    }

    /// @notice Mutable per-mandate state, updated on every mark.
    struct MandateState {
        address trader;
        address account; // MandateAccount clone that holds the capital
        uint256 highWaterMark; // peak equity ever observed; ratchets up, never down
        uint256 dayStartEquity; // equity at the start of the current loss window
        uint64 dayStartTime; // when the current window opened
        uint256 lastMarkedEquity;
        uint64 lastMarkedAt;
        uint64 issuedAt;
        Status status;
        BreachKind breachKind;
    }

    /// @notice A single isolated-margin perp position on the venue.
    struct Position {
        uint16 marketId;
        bool isLong;
        uint256 size; // base units, 1e18
        uint256 entryPrice; // 1e8
        uint256 margin; // pool-asset units locked against this position
        int256 fundingIndexAtEntry; // funding accumulator snapshot at entry
        uint64 openedAt;
    }
}

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
        TrailingDrawdown, // equity fell below the drawdown floor
        DailyLoss, // equity fell below the daily floor
        Expiry // past the expiry timestamp

    }

    /// @notice How the drawdown floor behaves as the account grows.
    ///
    /// @dev All three exist in the real market and a mandate should be able to express any of
    ///      them. Taken from FundingPips' published 2026 rulebook — see docs/RESEARCH.md §2.
    enum DrawdownMode {
        /// @dev Floor fixed at `allocation * (1 - maxDrawdownBps)` and never moves — not with
        ///      profit, not across phases. This is what most funded models actually use, and
        ///      it is the more generous of the two once a trader is up.
        Static,
        /// @dev Floor follows the equity high-water mark up forever. Harshest: a trader can be
        ///      stopped out while still well in profit.
        Trailing,
        /// @dev Trails up, then stops permanently once it reaches the starting allocation.
        ///      This is the FundingPips Zero rule ("the floor locks at the starting size"),
        ///      and it is the fairest of the three: it protects the pool's principal without
        ///      letting the floor chase a trader indefinitely.
        TrailingUntilBreakeven
    }

    /// @notice Why a payout is being withheld, when it is.
    ///
    /// @dev These are *soft* conditions. They block a reward, they do not kill the mandate —
    ///      matching how real firms treat them. See {RiskEngine-checkPayout}.
    enum PayoutBlock {
        None,
        /// @dev Biggest single day was too large a share of total profit.
        Consistency,
        /// @dev Not enough profitable days yet.
        ProfitableDays,
        /// @dev Equity is too close to the floor to safely pay out.
        Cushion
    }

    /// @notice The rules of a mandate. Fixed at issuance and never mutable — the whole
    ///         point is that both sides can read the terms before either commits.
    /// @dev Packs into two storage slots: `allocation`, then everything else in 200 bits.
    struct Terms {
        uint256 allocation; // capital granted, in pool-asset units
        uint16 maxDrawdownBps; // drawdown allowance, applied per {DrawdownMode}
        uint16 dailyLossBps; // loss limit within one daily window
        uint16 profitSplitBps; // trader's share of profit at settlement
        uint16 maxPositionBps; // notional cap as bps of allocation (30_000 = 3x)
        uint64 expiry; // unix seconds; the mandate is dead after this
        uint8 resetHourUtc; // hour of day the daily loss window rolls (0 = 00:00 UTC)
        DrawdownMode drawdownMode; // how the floor behaves as the account grows
        // ── payout conditions ────────────────────────────────────────────────────
        // Encoded for the same reason the risk limits are: these are the terms real firms
        // use to withhold money, and they are the ones a trader currently cannot audit.
        uint16 maxConsistencyBps; // biggest day as a share of profit, 0 = no rule
        uint16 minProfitableDays; // profitable days required before a payout, 0 = none
        uint16 payoutCushionBps; // headroom above the floor required to pay out, 0 = none
        bool touchIsBreach; // true = touching the floor breaches (real firms are touch-sensitive)
    }

    /// @notice Mutable per-mandate state, updated on every mark.
    struct MandateState {
        address trader;
        address account; // MandateAccount clone that holds the capital
        uint256 highWaterMark; // peak equity ever observed; ratchets up, never down
        uint256 dayStartEquity; // equity at the start of the current loss window
        uint256 dayStartBalance; // realised balance at the start of the window
        uint64 dayStartTime; // when the current window opened
        uint256 lastMarkedEquity;
        uint64 lastMarkedAt;
        uint64 issuedAt;
        // ── daily history, for the consistency rule ──────────────────────────────
        uint256 largestDailyGain; // biggest single completed day's profit
        uint32 profitableDays; // completed days that closed up
        uint32 tradingDays; // completed days
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

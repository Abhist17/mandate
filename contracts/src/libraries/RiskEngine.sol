// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Types} from "./Types.sol";
import {Errors} from "./Errors.sol";

/// @title RiskEngine
/// @author Mandate
/// @notice The rules, as maths. Pure functions, no state, no owner, no upgrade path.
///
/// @dev This library is the entire product claim. A prop firm's rulebook says "10% trailing
///      drawdown" and then a private server decides what that meant. Here it is four lines
///      of arithmetic that anyone can read, anyone can simulate, and nobody can appeal.
///
///      Deliberately a `library` with `internal` functions rather than a deployed contract:
///      the maths is inlined into `MandateRegistry` and `MandateAccount`, so a per-block
///      mark costs no external call. `RiskLens` wraps it for off-chain callers.
///
///      Rounding is fixed and stated: floors round *down*, which is the trader-favourable
///      direction (a lower floor is harder to breach). The boundary is exact — equity
///      exactly equal to the floor is NOT a breach. See `evaluate`.
library RiskEngine {
    /// @notice Basis-point denominator. 10_000 bps = 100%.
    uint256 internal constant BPS = 10_000;

    /// @notice Seconds in a daily loss window.
    uint64 internal constant DAY = 86_400;

    /// @notice Inputs to a single mark. Grouped into a struct because the alternative is a
    ///         nine-argument function and a stack-too-deep error.
    struct MarkInput {
        uint256 allocation;
        int256 netPnl; // realised + unrealised, signed
        int256 unrealisedPnl; // the floating part, used for the daily floor basis
        uint256 highWaterMark;
        uint256 dayStartEquity;
        uint256 dayStartBalance;
        uint64 dayStartTime;
        uint256 largestDailyGain;
        uint32 profitableDays;
        uint32 tradingDays;
        uint16 maxDrawdownBps;
        uint16 dailyLossBps;
        uint64 expiry;
        uint8 resetHourUtc;
        Types.DrawdownMode drawdownMode;
        bool touchIsBreach;
        uint64 timestamp;
    }

    /// @notice Everything a mark produces. The caller persists this; the library holds nothing.
    struct MarkResult {
        uint256 equity;
        uint256 balance; // equity less floating PnL
        uint256 highWaterMark; // post-ratchet
        uint256 dayStartEquity; // post-rollover
        uint256 dayStartBalance; // post-rollover
        uint64 dayStartTime; // post-rollover
        uint256 largestDailyGain; // post day-close accounting
        uint32 profitableDays;
        uint32 tradingDays;
        uint256 trailingFloor;
        uint256 dailyFloor;
        uint256 effectiveFloor; // max(trailingFloor, dailyFloor) — the binding constraint
        Types.BreachKind breach;
        bool rolledDay;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Core arithmetic
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Equity of a mandate: the allocation plus whatever the trader has done to it.
    /// @dev Floored at zero. A loss larger than the allocation cannot make equity negative,
    ///      because the trader never owed the pool more than it granted — that cap is the
    ///      entire point of an allocation. The excess loss is the pool's, and the position
    ///      cap plus the per-block mark exist to keep it from ever getting there.
    /// @param allocation Capital granted to the trader.
    /// @param netPnl Realised plus unrealised PnL, signed.
    /// @return Equity in pool-asset units.
    function equityFrom(uint256 allocation, int256 netPnl) internal pure returns (uint256) {
        if (netPnl >= 0) return allocation + uint256(netPnl);
        uint256 loss = uint256(-netPnl);
        return loss >= allocation ? 0 : allocation - loss;
    }

    /// @notice The trailing drawdown floor: how far equity may fall from its own peak.
    /// @dev `highWaterMark * (10_000 - maxDrawdownBps) / 10_000`, rounded down.
    /// @param highWaterMark Peak equity ever observed for this mandate.
    /// @param maxDrawdownBps Permitted fall from that peak, in bps.
    /// @return The equity level at or below which the mandate is dead.
    function trailingFloor(uint256 highWaterMark, uint16 maxDrawdownBps) internal pure returns (uint256) {
        return (highWaterMark * (BPS - maxDrawdownBps)) / BPS;
    }

    /// @notice The drawdown floor under a given {Types-DrawdownMode}.
    ///
    /// @dev The three modes are the three that exist in the real market, and the differences
    ///      are consequential rather than cosmetic:
    ///
    ///      - `Static` measures from the allocation forever. Once a trader is up, this is the
    ///        most generous: profit is theirs to give back.
    ///      - `Trailing` measures from the peak forever. Harshest — a trader can be stopped
    ///        out while still meaningfully in profit.
    ///      - `TrailingUntilBreakeven` trails up but stops once the floor reaches the
    ///        allocation. It protects the pool's principal without letting the floor chase a
    ///        trader indefinitely, and it is what FundingPips Zero actually does. Expressed
    ///        here as `min(trailing, allocation)`, which is exactly the "locks at the starting
    ///        size" rule: with a 5% band the floor stops moving once the peak reaches
    ///        allocation / 0.95.
    ///
    /// @param highWaterMark Peak equity observed.
    /// @param allocation Capital originally granted.
    /// @param maxDrawdownBps Permitted fall, in bps.
    /// @param mode Which of the three rules applies.
    function drawdownFloor(
        uint256 highWaterMark,
        uint256 allocation,
        uint16 maxDrawdownBps,
        Types.DrawdownMode mode
    ) internal pure returns (uint256) {
        if (mode == Types.DrawdownMode.Static) {
            return (allocation * (BPS - maxDrawdownBps)) / BPS;
        }
        uint256 trailing = trailingFloor(highWaterMark, maxDrawdownBps);
        if (mode == Types.DrawdownMode.TrailingUntilBreakeven && trailing > allocation) {
            return allocation;
        }
        return trailing;
    }

    /// @notice The daily loss floor: how far equity may fall within one loss window.
    /// @param dayStartEquity Equity when the current window opened.
    /// @param dailyLossBps Permitted fall within the window, in bps.
    /// @return The equity level at or below which the mandate is dead for the day.
    function dailyFloor(uint256 dayStartEquity, uint16 dailyLossBps) internal pure returns (uint256) {
        return (dayStartEquity * (BPS - dailyLossBps)) / BPS;
    }

    /// @notice The daily floor measured from the correct base.
    ///
    /// @dev Real firms measure the daily limit from "opening balance or opening equity for
    ///      that day, **whichever is higher**", and the distinction only shows up when a
    ///      trader carries a losing position overnight. In that case balance (realised) sits
    ///      above equity (realised + floating), and taking the higher of the two means the
    ///      overnight floating loss counts against today's allowance rather than being
    ///      quietly forgiven by the rollover.
    ///
    ///      Getting this wrong in the trader's favour would be a real hole: hold a loser
    ///      through the reset and your daily limit resets around it.
    function dailyFloorFromBasis(uint256 dayStartEquity, uint256 dayStartBalance, uint16 dailyLossBps)
        internal
        pure
        returns (uint256)
    {
        uint256 basis = dayStartBalance > dayStartEquity ? dayStartBalance : dayStartEquity;
        return (basis * (BPS - dailyLossBps)) / BPS;
    }

    /// @notice High-water mark ratchet. Goes up, never down.
    /// @dev The one-way property is what makes a *trailing* drawdown trailing. If this could
    ///      fall, a trader could bleed to the floor, wait for the mark to reset, and bleed
    ///      again — which is the failure mode traders complain about in firms that quietly
    ///      recompute their peaks.
    function ratchet(uint256 highWaterMark, uint256 equity) internal pure returns (uint256) {
        return equity > highWaterMark ? equity : highWaterMark;
    }

    /// @notice Notional cap implied by the terms.
    /// @param allocation Capital granted.
    /// @param maxPositionBps Cap as bps of allocation — 30_000 is 3x.
    /// @return Maximum position notional in pool-asset units.
    function maxNotional(uint256 allocation, uint16 maxPositionBps) internal pure returns (uint256) {
        return (allocation * maxPositionBps) / BPS;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Daily loss window
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Which loss window a timestamp falls in.
    /// @dev Real prop firms roll the daily limit at a broker-defined server time, not at
    ///      UTC midnight, so the reset hour is a per-mandate parameter rather than a
    ///      hardcoded constant. `resetHourUtc = 0` gives plain 00:00 UTC.
    /// @param timestamp Unix seconds.
    /// @param resetHourUtc Hour of day the window rolls, 0–23.
    /// @return The window index containing `timestamp`.
    function dayIndex(uint64 timestamp, uint8 resetHourUtc) internal pure returns (uint64) {
        uint64 offset = uint64(resetHourUtc) * 3600;
        // Before the first reset hour of the epoch everything is window 0. Only reachable
        // in tests that warp to near-zero timestamps, but underflow here would be silent.
        if (timestamp < offset) return 0;
        return (timestamp - offset) / DAY;
    }

    /// @notice Whether the loss window has rolled between two timestamps.
    function isNewDay(uint64 lastTs, uint64 nowTs, uint8 resetHourUtc) internal pure returns (bool) {
        return dayIndex(nowTs, resetHourUtc) > dayIndex(lastTs, resetHourUtc);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  The mark
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Mark a mandate: compute equity, roll the day if due, ratchet the peak, and
    ///         decide whether it breached.
    ///
    /// @dev Order matters and follows the spec exactly:
    ///        1. equity   = allocation + netPnl
    ///        2. roll the daily window if the reset hour has passed (day-start equity is set
    ///           to equity *as measured now*, so the new window starts from a clean slate)
    ///        3. hwm      = max(hwm, equity)
    ///        4. floors   from the post-ratchet hwm and the post-rollover day-start equity
    ///        5. breach   if equity < either floor
    ///
    ///      Step 3 before step 4 is safe: if equity set a new high, the resulting floor is
    ///      strictly below it, so a new peak can never itself be a breach.
    ///
    ///      The comparison is strict `<`. Equity exactly at the floor survives. This is the
    ///      "not one wei early" boundary and it is tested at ±1 wei.
    ///
    ///      Expiry is checked first and reported as its own kind — an expired mandate is not
    ///      a failed one, and settlement treats them differently.
    ///
    /// @param input Everything needed to mark, see {MarkInput}.
    /// @return r The resulting equity, floors, updated peaks and breach verdict.
    function evaluate(MarkInput memory input) internal pure returns (MarkResult memory r) {
        r.equity = equityFrom(input.allocation, input.netPnl);
        // Balance is equity with the floating part stripped out. Needed for the daily basis.
        r.balance = equityFrom(input.allocation, input.netPnl - input.unrealisedPnl);

        r.largestDailyGain = input.largestDailyGain;
        r.profitableDays = input.profitableDays;
        r.tradingDays = input.tradingDays;

        // ── daily window rollover ────────────────────────────────────────────────
        if (isNewDay(input.dayStartTime, input.timestamp, input.resetHourUtc)) {
            // Close out the day that just ended before opening the new one. This is what
            // feeds the consistency rule: a day's gain is only known at its close.
            if (r.equity > input.dayStartEquity) {
                uint256 gain = r.equity - input.dayStartEquity;
                if (gain > r.largestDailyGain) r.largestDailyGain = gain;
                r.profitableDays = input.profitableDays + 1;
            }
            r.tradingDays = input.tradingDays + 1;

            r.dayStartEquity = r.equity;
            r.dayStartBalance = r.balance;
            r.dayStartTime = input.timestamp;
            r.rolledDay = true;
        } else {
            r.dayStartEquity = input.dayStartEquity;
            r.dayStartBalance = input.dayStartBalance;
            r.dayStartTime = input.dayStartTime;
        }

        // ── ratchet the peak ─────────────────────────────────────────────────────
        r.highWaterMark = ratchet(input.highWaterMark, r.equity);

        // ── floors ───────────────────────────────────────────────────────────────
        r.trailingFloor =
            drawdownFloor(r.highWaterMark, input.allocation, input.maxDrawdownBps, input.drawdownMode);
        r.dailyFloor = dailyFloorFromBasis(r.dayStartEquity, r.dayStartBalance, input.dailyLossBps);
        r.effectiveFloor = r.trailingFloor > r.dailyFloor ? r.trailingFloor : r.dailyFloor;

        // ── verdict ──────────────────────────────────────────────────────────────
        // `touchIsBreach` selects between touching the floor being fatal (which is what real
        // firms do — their limits are touch-sensitive) and surviving exactly at it. Both are
        // defensible; what matters is that a mandate says which one it is, up front.
        bool underTrailing =
            input.touchIsBreach ? r.equity <= r.trailingFloor : r.equity < r.trailingFloor;
        bool underDaily = input.touchIsBreach ? r.equity <= r.dailyFloor : r.equity < r.dailyFloor;

        if (input.timestamp >= input.expiry) {
            r.breach = Types.BreachKind.Expiry;
        } else if (underTrailing) {
            r.breach = Types.BreachKind.TrailingDrawdown;
        } else if (underDaily) {
            r.breach = Types.BreachKind.DailyLoss;
        } else {
            r.breach = Types.BreachKind.None;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Payout conditions
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice The consistency score: the biggest single day as a share of total profit.
    ///
    /// @dev ```
    ///      score = biggestWinningDay / totalProfit
    ///      ```
    ///
    ///      **This is the rule that actually denies payouts.** A drawdown breach is
    ///      unambiguous and rarely disputed — the number is the number. Consistency is where
    ///      the discretion lives: it is computed on the firm's server, from the firm's record
    ///      of your trades, against a threshold you cannot independently check. FundingPips
    ///      Zero requires ≤15% at every reward request; 2 Step Standard's On-Demand cycle
    ///      requires ≤35%.
    ///
    ///      The rule itself is not unreasonable — it stops someone passing on one lucky
    ///      all-in and then withdrawing. The problem has never been the rule. The problem is
    ///      that the arithmetic is private. Here it is a pure function anyone can call.
    ///
    ///      The score is quantised to basis points and truncates *down*, which is the
    ///      trader-favourable direction and matches how the floors round. A consequence worth
    ///      knowing: sub-bps dust on the best day cannot tip a passing score into a failing
    ///      one, so the boundary is at bps granularity rather than wei granularity.
    ///
    /// @return bps Score in basis points. Zero when there is no profit to be inconsistent
    ///         about, which correctly means "not blocked" rather than "divide by zero".
    function consistencyBps(uint256 largestDailyGain, uint256 equity, uint256 allocation)
        internal
        pure
        returns (uint256 bps)
    {
        if (equity <= allocation) return 0;
        uint256 profit = equity - allocation;
        if (profit == 0) return 0;
        return (largestDailyGain * BPS) / profit;
    }

    /// @notice Inputs to a payout eligibility check.
    struct PayoutCheck {
        uint256 equity;
        uint256 allocation;
        uint256 largestDailyGain;
        uint256 effectiveFloor;
        uint32 profitableDays;
        uint16 maxConsistencyBps;
        uint16 minProfitableDays;
        uint16 payoutCushionBps;
    }

    /// @notice Whether a mandate may take profit right now, and if not, why not.
    ///
    /// @dev These are **soft** conditions. They withhold a reward; they do not kill the
    ///      mandate. That matches how real firms treat them — on FundingPips Zero a failed
    ///      consistency score blocks the reward and the account stays open — and it is the
    ///      right behaviour: a trader who has been inconsistent has not done anything wrong,
    ///      they have just not yet earned the right to withdraw.
    ///
    ///      A mandate that is not in profit is always eligible, because there is no payout to
    ///      block. Withholding a losing trader's zero would be theatre.
    ///
    /// @return ok Whether a payout may proceed.
    /// @return reason Which condition failed. {Types-PayoutBlock-None} when `ok`.
    function checkPayout(PayoutCheck memory c)
        internal
        pure
        returns (bool ok, Types.PayoutBlock reason)
    {
        // No profit, no payout to withhold.
        if (c.equity <= c.allocation) return (true, Types.PayoutBlock.None);

        if (c.maxConsistencyBps != 0) {
            uint256 score = consistencyBps(c.largestDailyGain, c.equity, c.allocation);
            if (score > c.maxConsistencyBps) return (false, Types.PayoutBlock.Consistency);
        }

        if (c.minProfitableDays != 0 && c.profitableDays < c.minProfitableDays) {
            return (false, Types.PayoutBlock.ProfitableDays);
        }

        if (c.payoutCushionBps != 0) {
            // Require the account to be a stated distance clear of its floor before it can
            // take money off the table. Paying out down to the last dollar of headroom leaves
            // a mandate that breaches on the next tick.
            uint256 required = c.effectiveFloor + (c.allocation * c.payoutCushionBps) / BPS;
            if (c.equity < required) return (false, Types.PayoutBlock.Cushion);
        }

        return (true, Types.PayoutBlock.None);
    }

    /// @notice How much room is left before the mandate dies.
    /// @dev This is the number on the trader's screen. Returns 0 when already at or through
    ///      the floor rather than reverting — the UI needs to render a breached mandate too.
    /// @return absolute Distance to the binding floor in pool-asset units.
    /// @return bps Distance as bps of current equity, 0 when equity is 0.
    function distanceToFloor(uint256 equity, uint256 effectiveFloor)
        internal
        pure
        returns (uint256 absolute, uint256 bps)
    {
        if (equity <= effectiveFloor) return (0, 0);
        absolute = equity - effectiveFloor;
        bps = (absolute * BPS) / equity;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Settlement
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Split terminal equity between trader and pool.
    /// @dev  profit       = max(equity - allocation, 0)
    ///       traderPayout = profit * profitSplitBps / 10_000
    ///       poolReturn   = equity - traderPayout
    ///
    ///      Note what happens at a loss: profit is 0, so the trader is paid nothing and the
    ///      pool receives the whole remaining equity. The trader's downside is their share
    ///      of nothing — the pool eats the loss, capped at the allocation. That asymmetry is
    ///      the deal, and it is why the drawdown cap has to be enforced rather than promised.
    ///
    ///      Rounding favours the pool (the trader's share rounds down), so the two legs
    ///      always sum to exactly `equity` with no dust left stranded.
    ///
    /// @param equity Terminal equity of the mandate.
    /// @param allocation Capital originally granted.
    /// @param profitSplitBps Trader's share of profit, in bps.
    /// @return traderPayout Owed to the trader.
    /// @return poolReturn Owed to the pool. Always `equity - traderPayout`.
    function split(uint256 equity, uint256 allocation, uint16 profitSplitBps)
        internal
        pure
        returns (uint256 traderPayout, uint256 poolReturn)
    {
        uint256 profit = equity > allocation ? equity - allocation : 0;
        traderPayout = (profit * profitSplitBps) / BPS;
        poolReturn = equity - traderPayout;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Terms validation
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Reject terms that are malformed or that quietly mean nothing.
    /// @dev The second class matters more than the first. A mandate whose daily loss limit
    ///      is looser than its trailing drawdown has a daily limit that can never fire —
    ///      it reads like a protection and is dead code. Rejecting it means every term
    ///      printed on the mandate is a term that can actually bind.
    function validateTerms(Types.Terms memory t, uint64 nowTs) internal pure {
        if (t.allocation == 0) revert Errors.ZeroAmount();
        if (t.maxDrawdownBps == 0) revert Errors.DrawdownMustBeNonZero();
        if (t.maxDrawdownBps >= BPS) revert Errors.BpsOutOfRange(t.maxDrawdownBps);
        if (t.dailyLossBps == 0 || t.dailyLossBps >= BPS) revert Errors.BpsOutOfRange(t.dailyLossBps);
        if (t.profitSplitBps > BPS) revert Errors.BpsOutOfRange(t.profitSplitBps);
        if (t.dailyLossBps > t.maxDrawdownBps) {
            revert Errors.DailyLossLooserThanDrawdown(t.dailyLossBps, t.maxDrawdownBps);
        }
        // A position cap below 1x means the trader cannot deploy the capital they were given.
        if (t.maxPositionBps < BPS) revert Errors.PositionCapTooLow(t.maxPositionBps);
        if (t.expiry <= nowTs) revert Errors.ExpiryInPast(t.expiry, nowTs);
        if (t.resetHourUtc > 23) revert Errors.BpsOutOfRange(t.resetHourUtc);
        if (t.maxConsistencyBps > BPS) revert Errors.BpsOutOfRange(t.maxConsistencyBps);
        if (t.payoutCushionBps > BPS) revert Errors.BpsOutOfRange(t.payoutCushionBps);
        // A cushion wider than the drawdown band can never be satisfied: the account would
        // have to sit above its own peak to pay out.
        if (t.payoutCushionBps != 0 && t.payoutCushionBps >= t.maxDrawdownBps) {
            revert Errors.BpsOutOfRange(t.payoutCushionBps);
        }
    }
}

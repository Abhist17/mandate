// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RiskEngine} from "../../src/libraries/RiskEngine.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice The rules that decide whether a trader gets paid.
///
/// @dev These matter more than the drawdown tests, and it is worth saying why. A drawdown
///      breach is unambiguous — the number is the number, and traders rarely dispute it. The
///      consistency rule is where prop firms actually withhold money: it is computed on their
///      server, from their record of your trades, against a threshold you cannot check.
///      Encoding it is what makes "the rules are the contract" true of the payout and not
///      just of the risk. See docs/RESEARCH.md §2.1.
contract PayoutRulesTest is Test {
    uint256 constant ALLOC = 100_000e6;

    // ─────────────────────────────────────────────────────────────────────────────
    //  Drawdown modes
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Static: the floor is set at issuance and never moves. Once a trader is up, this
    ///      is the most generous of the three — the profit is theirs to give back.
    function test_static_floorNeverMoves() public pure {
        uint256 atStart =
            RiskEngine.drawdownFloor(ALLOC, ALLOC, 1_000, Types.DrawdownMode.Static);
        uint256 afterRally =
            RiskEngine.drawdownFloor(200_000e6, ALLOC, 1_000, Types.DrawdownMode.Static);

        assertEq(atStart, 90_000e6);
        assertEq(afterRally, 90_000e6, "doubling the account did not move the floor");
    }

    /// @dev Trailing: the floor follows the peak up forever. Harshest — a trader can be
    ///      stopped out while still well in profit.
    function test_trailing_floorFollowsThePeakForever() public pure {
        assertEq(RiskEngine.drawdownFloor(ALLOC, ALLOC, 1_000, Types.DrawdownMode.Trailing), 90_000e6);
        assertEq(
            RiskEngine.drawdownFloor(200_000e6, ALLOC, 1_000, Types.DrawdownMode.Trailing),
            180_000e6,
            "floor is now well above the original allocation"
        );
    }

    /// @dev TrailingUntilBreakeven: trails up, then stops at the allocation. This is the
    ///      FundingPips Zero rule, and the fairest of the three — it protects the pool's
    ///      principal without letting the floor chase a trader indefinitely.
    function test_trailingUntilBreakeven_locksAtTheAllocation() public pure {
        Types.DrawdownMode m = Types.DrawdownMode.TrailingUntilBreakeven;

        // Below breakeven it still trails.
        assertEq(RiskEngine.drawdownFloor(ALLOC, ALLOC, 1_000, m), 90_000e6);
        assertEq(RiskEngine.drawdownFloor(105_000e6, ALLOC, 1_000, m), 94_500e6);

        // The lock engages exactly when the trailing floor would pass the allocation:
        // 111_111e6 * 0.9 = 99_999.9e6, still under. 111_112e6 * 0.9 crosses.
        assertEq(RiskEngine.drawdownFloor(111_111e6, ALLOC, 1_000, m), 99_999_900_000);

        // Past that the floor is pinned, however far the account runs.
        assertEq(RiskEngine.drawdownFloor(200_000e6, ALLOC, 1_000, m), ALLOC, "locked");
        assertEq(RiskEngine.drawdownFloor(1_000_000e6, ALLOC, 1_000, m), ALLOC, "still locked");
    }

    /// @dev The three modes are meaningfully different, in a stated order.
    function test_modesOrderByGenerosityOnceInProfit() public pure {
        uint256 peak = 200_000e6;
        uint256 static_ = RiskEngine.drawdownFloor(peak, ALLOC, 1_000, Types.DrawdownMode.Static);
        uint256 locked =
            RiskEngine.drawdownFloor(peak, ALLOC, 1_000, Types.DrawdownMode.TrailingUntilBreakeven);
        uint256 trailing = RiskEngine.drawdownFloor(peak, ALLOC, 1_000, Types.DrawdownMode.Trailing);

        assertLt(static_, locked, "static is the loosest");
        assertLt(locked, trailing, "trailing is the tightest");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Daily floor basis
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Real firms measure the daily limit from "opening balance or opening equity,
    ///      whichever is higher". Taking the higher means an overnight floating loss counts
    ///      against today rather than being forgiven by the rollover.
    function test_dailyBasis_takesTheHigherOfBalanceAndEquity() public pure {
        // Carried a loser overnight: balance 100k, equity 96k.
        uint256 floor = RiskEngine.dailyFloorFromBasis(96_000e6, 100_000e6, 500);
        assertEq(floor, 95_000e6, "measured from the 100k balance, not the 96k equity");
    }

    function test_dailyBasis_usesEquityWhenItIsHigher() public pure {
        // Carried a winner overnight: balance 100k, equity 104k.
        uint256 floor = RiskEngine.dailyFloorFromBasis(104_000e6, 100_000e6, 500);
        assertEq(floor, 98_800e6, "measured from the 104k equity");
    }

    /// @dev Without this, holding a loser through the reset would quietly widen the next
    ///      day's allowance — a real hole, in the trader's favour and the pool's cost.
    function test_dailyBasis_overnightLossIsNotForgiven() public pure {
        uint256 naive = RiskEngine.dailyFloor(96_000e6, 500); // equity-only
        uint256 correct = RiskEngine.dailyFloorFromBasis(96_000e6, 100_000e6, 500);
        assertGt(correct, naive, "the correct basis is stricter");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  The consistency rule
    // ─────────────────────────────────────────────────────────────────────────────

    function test_consistency_scoreIsBiggestDayOverProfit() public pure {
        // 10k profit, best day 3k -> 30%
        assertEq(RiskEngine.consistencyBps(3_000e6, 110_000e6, ALLOC), 3_000);
    }

    function test_consistency_oneLuckyDayScoresHigh() public pure {
        // The whole profit came from a single day: 100%.
        assertEq(RiskEngine.consistencyBps(10_000e6, 110_000e6, ALLOC), 10_000);
    }

    function test_consistency_spreadProfitScoresLow() public pure {
        // 20k profit, best day 2k -> 10%
        assertEq(RiskEngine.consistencyBps(2_000e6, 120_000e6, ALLOC), 1_000);
    }

    /// @dev No profit means no score, not a division by zero. A trader who is flat or down
    ///      has nothing to be inconsistent about.
    function test_consistency_noProfitIsNotADivideByZero() public pure {
        assertEq(RiskEngine.consistencyBps(5_000e6, ALLOC, ALLOC), 0);
        assertEq(RiskEngine.consistencyBps(5_000e6, 90_000e6, ALLOC), 0);
    }

    function _check(uint256 equity, uint256 bestDay, uint16 maxBps)
        internal
        pure
        returns (bool ok, Types.PayoutBlock reason)
    {
        return RiskEngine.checkPayout(
            RiskEngine.PayoutCheck({
                equity: equity,
                allocation: ALLOC,
                largestDailyGain: bestDay,
                effectiveFloor: 90_000e6,
                profitableDays: 10,
                maxConsistencyBps: maxBps,
                minProfitableDays: 0,
                payoutCushionBps: 0
            })
        );
    }

    /// @dev The FundingPips Zero threshold, applied at the boundary.
    ///
    ///      The score is quantised to basis points, so the boundary is at bps granularity and
    ///      not at wei granularity: with 10k of profit, one extra wei on the best day leaves
    ///      the truncated score at 1500. Crossing requires a full bps, which is 1e6 units
    ///      here. Truncation rounds the score *down*, which is the trader-favourable
    ///      direction — the same convention the floors use.
    function test_consistency_boundaryIsAtBpsGranularity() public pure {
        // 10k profit. 15% of 10k is 1.5k.
        (bool okAt,) = _check(110_000e6, 1_500e6, 1_500);
        assertTrue(okAt, "exactly at the threshold passes");

        // Still 1500 bps after truncation, so still passes.
        (bool okDust,) = _check(110_000e6, 1_500e6 + 1, 1_500);
        assertTrue(okDust, "sub-bps dust rounds down in the trader's favour");

        // A full basis point over is blocked.
        (bool okOver, Types.PayoutBlock reason) = _check(110_000e6, 1_501e6, 1_500);
        assertFalse(okOver, "one bps over is blocked");
        assertEq(uint8(reason), uint8(Types.PayoutBlock.Consistency));
    }

    function test_consistency_disabledWhenThresholdIsZero() public pure {
        (bool ok,) = _check(110_000e6, 10_000e6, 0); // 100% score, rule off
        assertTrue(ok, "0 means no consistency rule");
    }

    /// @dev A losing mandate is always payable, because there is nothing to withhold.
    ///      Blocking a losing trader's zero would be theatre.
    function test_consistency_doesNotBlockALosingMandate() public pure {
        (bool ok,) = _check(90_000e6, 50_000e6, 1_500);
        assertTrue(ok);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Other payout conditions
    // ─────────────────────────────────────────────────────────────────────────────

    function test_minProfitableDays_blocksUntilMet() public pure {
        RiskEngine.PayoutCheck memory c = RiskEngine.PayoutCheck({
            equity: 110_000e6,
            allocation: ALLOC,
            largestDailyGain: 0,
            effectiveFloor: 90_000e6,
            profitableDays: 3,
            maxConsistencyBps: 0,
            minProfitableDays: 7,
            payoutCushionBps: 0
        });
        (bool ok, Types.PayoutBlock reason) = RiskEngine.checkPayout(c);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Types.PayoutBlock.ProfitableDays));

        c.profitableDays = 7;
        (ok,) = RiskEngine.checkPayout(c);
        assertTrue(ok, "exactly the minimum is enough");
    }

    /// @dev Paying out down to the last dollar of headroom leaves a mandate that breaches on
    ///      the next tick. The cushion is what stops that.
    function test_cushion_requiresHeadroomAboveTheFloor() public pure {
        RiskEngine.PayoutCheck memory c = RiskEngine.PayoutCheck({
            equity: 92_000e6, // only 2k above the floor
            allocation: ALLOC,
            largestDailyGain: 0,
            effectiveFloor: 90_000e6,
            profitableDays: 10,
            maxConsistencyBps: 0,
            minProfitableDays: 0,
            payoutCushionBps: 300 // needs 3% of allocation = 3k above the floor
        });

        // Not in profit, so nothing to withhold — the cushion never even applies.
        (bool ok,) = RiskEngine.checkPayout(c);
        assertTrue(ok, "a losing mandate is always payable");

        // In profit but sitting too close to the floor.
        c.equity = 100_001e6;
        c.effectiveFloor = 99_000e6;
        (ok, ) = RiskEngine.checkPayout(c);
        assertFalse(ok, "1k of headroom against a 3k requirement");

        c.equity = 102_500e6;
        (ok,) = RiskEngine.checkPayout(c);
        assertTrue(ok, "3.5k of headroom clears it");
    }

    function test_conditionsAreCheckedInAStableOrder() public pure {
        // Consistency fails AND profitable days fail; consistency is reported first.
        (bool ok, Types.PayoutBlock reason) = RiskEngine.checkPayout(
            RiskEngine.PayoutCheck({
                equity: 110_000e6,
                allocation: ALLOC,
                largestDailyGain: 10_000e6,
                effectiveFloor: 90_000e6,
                profitableDays: 0,
                maxConsistencyBps: 1_500,
                minProfitableDays: 7,
                payoutCushionBps: 0
            })
        );
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Types.PayoutBlock.Consistency));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Touch sensitivity
    // ─────────────────────────────────────────────────────────────────────────────

    function _mark(int256 pnl, bool touchIsBreach)
        internal
        pure
        returns (RiskEngine.MarkResult memory)
    {
        return RiskEngine.evaluate(
            RiskEngine.MarkInput({
                allocation: ALLOC,
                netPnl: pnl,
                unrealisedPnl: 0,
                highWaterMark: ALLOC,
                dayStartEquity: 90_000e6,
                dayStartBalance: 90_000e6,
                dayStartTime: 1_699_952_400,
                largestDailyGain: 0,
                profitableDays: 0,
                tradingDays: 0,
                maxDrawdownBps: 1_000,
                dailyLossBps: 500,
                expiry: 1_699_952_400 + 30 days,
                resetHourUtc: 0,
                drawdownMode: Types.DrawdownMode.Trailing,
                touchIsBreach: touchIsBreach,
                timestamp: 1_699_952_400 + 1 hours
            })
        );
    }

    /// @dev Real firms are touch-sensitive: touching the limit closes the account. Ours is a
    ///      per-mandate flag rather than a hardcoded convention, so a mandate states which
    ///      rule it is under before anyone commits.
    function test_touchSensitivity_changesTheBoundary() public pure {
        // Exactly on the 90k trailing floor.
        assertEq(uint8(_mark(-10_000e6, false).breach), uint8(Types.BreachKind.None), "lenient survives");
        assertEq(
            uint8(_mark(-10_000e6, true).breach),
            uint8(Types.BreachKind.TrailingDrawdown),
            "touch-sensitive breaches"
        );
    }

    function test_touchSensitivity_agreesEverywhereElse() public pure {
        assertEq(uint8(_mark(-9_999e6, false).breach), uint8(_mark(-9_999e6, true).breach));
        assertEq(uint8(_mark(-10_001e6, false).breach), uint8(_mark(-10_001e6, true).breach));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Day-close accounting feeds the consistency rule
    // ─────────────────────────────────────────────────────────────────────────────

    function test_dayClose_recordsGainAndProfitableDay() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(
            RiskEngine.MarkInput({
                allocation: ALLOC,
                netPnl: 8_000e6,
                unrealisedPnl: 0,
                highWaterMark: ALLOC,
                dayStartEquity: ALLOC,
                dayStartBalance: ALLOC,
                dayStartTime: 1_699_952_400,
                largestDailyGain: 3_000e6,
                profitableDays: 2,
                tradingDays: 5,
                maxDrawdownBps: 2_000,
                dailyLossBps: 2_000,
                expiry: 1_699_952_400 + 30 days,
                resetHourUtc: 0,
                drawdownMode: Types.DrawdownMode.Trailing,
                touchIsBreach: false,
                timestamp: 1_699_952_400 + 1 days
            })
        );

        assertTrue(r.rolledDay);
        assertEq(r.largestDailyGain, 8_000e6, "new best day replaced the old one");
        assertEq(r.profitableDays, 3);
        assertEq(r.tradingDays, 6);
    }

    function test_dayClose_losingDayCountsAsTradedNotProfitable() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(
            RiskEngine.MarkInput({
                allocation: ALLOC,
                netPnl: -2_000e6,
                unrealisedPnl: 0,
                highWaterMark: ALLOC,
                dayStartEquity: ALLOC,
                dayStartBalance: ALLOC,
                dayStartTime: 1_699_952_400,
                largestDailyGain: 3_000e6,
                profitableDays: 2,
                tradingDays: 5,
                maxDrawdownBps: 2_000,
                dailyLossBps: 2_000,
                expiry: 1_699_952_400 + 30 days,
                resetHourUtc: 0,
                drawdownMode: Types.DrawdownMode.Trailing,
                touchIsBreach: false,
                timestamp: 1_699_952_400 + 1 days
            })
        );

        assertEq(r.largestDailyGain, 3_000e6, "best day unchanged");
        assertEq(r.profitableDays, 2, "not a profitable day");
        assertEq(r.tradingDays, 6, "but it was a trading day");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Fuzz
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev The consistency score can never exceed 100% of profit if the best day is bounded
    ///      by the profit itself, and a payout is blocked exactly when the score exceeds the
    ///      threshold. No third state.
    function testFuzz_payoutBlockedIffScoreExceedsThreshold(
        uint256 profit,
        uint256 bestDay,
        uint16 threshold
    ) public pure {
        profit = bound(profit, 1, 1_000_000e6);
        bestDay = bound(bestDay, 0, profit);
        threshold = uint16(bound(threshold, 1, 10_000));

        uint256 equity = ALLOC + profit;
        uint256 score = RiskEngine.consistencyBps(bestDay, equity, ALLOC);
        assertLe(score, 10_000, "a day cannot be more than all of the profit");

        (bool ok, Types.PayoutBlock reason) = RiskEngine.checkPayout(
            RiskEngine.PayoutCheck({
                equity: equity,
                allocation: ALLOC,
                largestDailyGain: bestDay,
                effectiveFloor: 0,
                profitableDays: 100,
                maxConsistencyBps: threshold,
                minProfitableDays: 0,
                payoutCushionBps: 0
            })
        );

        assertEq(ok, score <= threshold, "blocked exactly when over threshold");
        if (!ok) assertEq(uint8(reason), uint8(Types.PayoutBlock.Consistency));
    }

    /// @dev Whatever the peak, the locked mode's floor never exceeds the allocation and never
    ///      falls below what static would give. It is bounded by the other two by construction.
    function testFuzz_lockedModeSitsBetweenTheOtherTwo(uint256 peak, uint16 ddBps) public pure {
        peak = bound(peak, ALLOC, ALLOC * 100);
        ddBps = uint16(bound(ddBps, 1, 9_999));

        uint256 static_ = RiskEngine.drawdownFloor(peak, ALLOC, ddBps, Types.DrawdownMode.Static);
        uint256 locked =
            RiskEngine.drawdownFloor(peak, ALLOC, ddBps, Types.DrawdownMode.TrailingUntilBreakeven);
        uint256 trailing = RiskEngine.drawdownFloor(peak, ALLOC, ddBps, Types.DrawdownMode.Trailing);

        assertLe(locked, ALLOC, "locked never rises above the allocation");
        assertGe(locked, static_, "and never below the static floor");
        assertLe(locked, trailing, "and never above the trailing floor");
    }
}

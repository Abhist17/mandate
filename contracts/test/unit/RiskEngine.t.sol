// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RiskEngine} from "../../src/libraries/RiskEngine.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice Tests for the risk maths. The boundary cases are the point: a drawdown rule that
///         fires one wei early is a rule that confiscates a trader's account for nothing,
///         and one that fires one wei late is a rule the pool can't rely on.
contract RiskEngineTest is Test {
    using RiskEngine for RiskEngine.MarkInput;

    uint256 constant ALLOC = 100_000e6; // 100k, 6-decimal asset
    uint16 constant DD_BPS = 1_000; // 10% trailing
    uint16 constant DAILY_BPS = 500; // 5% daily
    uint16 constant SPLIT_BPS = 8_000; // 80/20 to the trader
    uint16 constant POS_BPS = 30_000; // 3x
    uint64 constant T0 = 1_699_952_400; // 2023-11-14 09:00:00 UTC, mid-morning

    function _input(int256 netPnl, uint256 hwm, uint256 dayStart, uint64 ts)
        internal
        pure
        returns (RiskEngine.MarkInput memory)
    {
        return RiskEngine.MarkInput({
            allocation: ALLOC,
            netPnl: netPnl,
            highWaterMark: hwm,
            dayStartEquity: dayStart,
            dayStartTime: T0,
            maxDrawdownBps: DD_BPS,
            dailyLossBps: DAILY_BPS,
            expiry: T0 + 30 days,
            resetHourUtc: 0,
            timestamp: ts
        });
    }

    // ─── equity ───────────────────────────────────────────────────────────────────

    function test_equity_flatIsAllocation() public pure {
        assertEq(RiskEngine.equityFrom(ALLOC, 0), ALLOC);
    }

    function test_equity_addsProfit() public pure {
        assertEq(RiskEngine.equityFrom(ALLOC, 5_000e6), 105_000e6);
    }

    function test_equity_subtractsLoss() public pure {
        assertEq(RiskEngine.equityFrom(ALLOC, -5_000e6), 95_000e6);
    }

    /// @dev A loss larger than the allocation floors at zero rather than underflowing. The
    ///      trader never owes the pool more than it granted them.
    function test_equity_flooredAtZero() public pure {
        assertEq(RiskEngine.equityFrom(ALLOC, -int256(ALLOC)), 0);
        assertEq(RiskEngine.equityFrom(ALLOC, -int256(ALLOC) - 1), 0);
        assertEq(RiskEngine.equityFrom(ALLOC, type(int256).min + 1), 0);
    }

    function test_equity_lossOfExactlyOneWeiLessThanAllocation() public pure {
        assertEq(RiskEngine.equityFrom(ALLOC, -int256(ALLOC - 1)), 1);
    }

    // ─── floors ───────────────────────────────────────────────────────────────────

    function test_trailingFloor_tenPercent() public pure {
        assertEq(RiskEngine.trailingFloor(100_000e6, 1_000), 90_000e6);
    }

    function test_dailyFloor_fivePercent() public pure {
        assertEq(RiskEngine.dailyFloor(100_000e6, 500), 95_000e6);
    }

    function test_floors_roundDownInTradersFavour() public pure {
        // 999 * 0.9 = 899.1 -> floors to 899, the lower (harder to breach) side.
        assertEq(RiskEngine.trailingFloor(999, 1_000), 899);
    }

    // ─── the boundary: not one wei early, not one wei late ────────────────────────

    /// @dev Equity exactly on the floor survives. This is the single most consequential
    ///      line in the protocol and it is asserted at exactly ±1 wei on both sides.
    function test_breach_exactlyAtFloorSurvives() public pure {
        // hwm 100k, 10% dd -> floor 90_000e6. Reach it exactly with a -10_000e6 PnL.
        // dayStartEquity is set to 90k so the daily floor (85.5k) sits well below and the
        // trailing floor is unambiguously the constraint under test.
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(-10_000e6, ALLOC, 90_000e6, T0 + 1 hours));
        assertEq(r.equity, 90_000e6);
        assertEq(r.trailingFloor, 90_000e6);
        assertEq(uint8(r.breach), uint8(Types.BreachKind.None), "at the floor is not a breach");
    }

    function test_breach_oneWeiBelowFloorBreaches() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(-10_000e6 - 1, ALLOC, 90_000e6, T0 + 1 hours));
        assertEq(r.equity, 90_000e6 - 1);
        assertEq(uint8(r.breach), uint8(Types.BreachKind.TrailingDrawdown));
    }

    function test_breach_oneWeiAboveFloorSurvives() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(-10_000e6 + 1, ALLOC, 90_000e6, T0 + 1 hours));
        assertEq(uint8(r.breach), uint8(Types.BreachKind.None));
    }

    // ─── high-water mark ratchets ─────────────────────────────────────────────────

    function test_hwm_ratchetsUp() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(20_000e6, ALLOC, ALLOC, T0 + 1 hours));
        assertEq(r.highWaterMark, 120_000e6);
    }

    function test_hwm_neverRatchetsDown() public pure {
        // Peaked at 120k, now back to 115k. The peak must not follow it down.
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(15_000e6, 120_000e6, ALLOC, T0 + 1 hours));
        assertEq(r.highWaterMark, 120_000e6);
        assertEq(r.trailingFloor, 108_000e6, "floor still measured from the 120k peak");
    }

    /// @dev The trailing floor follows the trader up. Win 20%, and the level that kills you
    ///      rises above where you started — you can now be stopped out in profit.
    function test_hwm_floorFollowsTraderIntoProfit() public pure {
        RiskEngine.MarkResult memory up = RiskEngine.evaluate(_input(20_000e6, ALLOC, ALLOC, T0 + 1 hours));
        assertEq(up.trailingFloor, 108_000e6);
        assertGt(up.trailingFloor, ALLOC, "floor is now above the original allocation");

        // Give back to 107_999e6: still profitable versus allocation, but breached.
        RiskEngine.MarkResult memory back =
            RiskEngine.evaluate(_input(7_999e6, up.highWaterMark, ALLOC, T0 + 2 hours));
        assertGt(back.equity, ALLOC, "still up on the allocation");
        assertEq(uint8(back.breach), uint8(Types.BreachKind.TrailingDrawdown), "breached anyway");
    }

    function test_hwm_newPeakIsNeverItsOwnBreach() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(1_000_000e6, ALLOC, ALLOC, T0 + 1 hours));
        assertEq(uint8(r.breach), uint8(Types.BreachKind.None));
    }

    // ─── daily loss window ────────────────────────────────────────────────────────

    function test_daily_breachWithinTheDay() public pure {
        // -6% on the day: inside the 10% trailing drawdown, outside the 5% daily limit.
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(-6_000e6, ALLOC, ALLOC, T0 + 1 hours));
        assertEq(uint8(r.breach), uint8(Types.BreachKind.DailyLoss));
        assertGt(r.equity, r.trailingFloor, "trailing drawdown was not the binding constraint");
    }

    function test_daily_exactlyAtDailyFloorSurvives() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(-5_000e6, ALLOC, ALLOC, T0 + 1 hours));
        assertEq(r.equity, 95_000e6);
        assertEq(r.dailyFloor, 95_000e6);
        assertEq(uint8(r.breach), uint8(Types.BreachKind.None));
    }

    /// @dev Cross a day boundary and the daily window restarts from wherever equity now is.
    ///      A trader down 4% yesterday gets a fresh 5% today — measured from the lower base,
    ///      not from the original allocation.
    function test_daily_resetsAcrossDayBoundary() public pure {
        uint64 nextDay = T0 + 1 days;
        RiskEngine.MarkInput memory input = _input(-4_000e6, ALLOC, ALLOC, nextDay);
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(input);

        assertTrue(r.rolledDay);
        assertEq(r.dayStartEquity, 96_000e6, "new window starts from current equity");
        assertEq(r.dayStartTime, nextDay);
        assertEq(r.dailyFloor, 91_200e6, "5% of 96k, not of 100k");
        assertEq(uint8(r.breach), uint8(Types.BreachKind.None));
    }

    /// @dev Rolling the day must not launder a trailing-drawdown breach. The peak survives
    ///      the reset, so a trader who is 11% off their high is still dead tomorrow.
    function test_daily_rolloverDoesNotClearTrailingBreach() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(-11_000e6, ALLOC, ALLOC, T0 + 1 days));
        assertTrue(r.rolledDay);
        assertEq(uint8(r.breach), uint8(Types.BreachKind.TrailingDrawdown));
    }

    function test_daily_noRolloverWithinTheSameWindow() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(-1_000e6, ALLOC, ALLOC, T0 + 3 hours));
        assertFalse(r.rolledDay);
        assertEq(r.dayStartEquity, ALLOC);
    }

    function test_dayIndex_respectsCustomResetHour() public pure {
        // T0 is 2023-11-14 09:00:00 UTC.
        uint64 utcMidnight = RiskEngine.dayIndex(T0, 0);
        // A 23:00 reset has not fired yet today, so 09:00 is still in yesterday's window.
        assertEq(RiskEngine.dayIndex(T0, 23), utcMidnight - 1);
        // A 06:00 reset already fired, so the window index matches the UTC-midnight one.
        assertEq(RiskEngine.dayIndex(T0, 6), utcMidnight);
    }

    function test_dayIndex_doesNotUnderflowNearEpoch() public pure {
        assertEq(RiskEngine.dayIndex(0, 12), 0);
        assertEq(RiskEngine.dayIndex(3600, 12), 0);
    }

    // ─── expiry ───────────────────────────────────────────────────────────────────

    function test_expiry_reportedAsItsOwnKind() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(5_000e6, ALLOC, ALLOC, T0 + 30 days));
        assertEq(uint8(r.breach), uint8(Types.BreachKind.Expiry));
    }

    function test_expiry_takesPrecedenceOverDrawdown() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(-50_000e6, ALLOC, ALLOC, T0 + 31 days));
        assertEq(uint8(r.breach), uint8(Types.BreachKind.Expiry));
    }

    function test_expiry_oneSecondBeforeIsStillAlive() public pure {
        RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(0, ALLOC, ALLOC, T0 + 30 days - 1));
        assertEq(uint8(r.breach), uint8(Types.BreachKind.None));
    }

    // ─── position cap ─────────────────────────────────────────────────────────────

    function test_maxNotional_threeX() public pure {
        assertEq(RiskEngine.maxNotional(ALLOC, POS_BPS), 300_000e6);
    }

    function test_maxNotional_oneX() public pure {
        assertEq(RiskEngine.maxNotional(ALLOC, 10_000), ALLOC);
    }

    // ─── settlement split ─────────────────────────────────────────────────────────

    function test_split_profit() public pure {
        (uint256 trader, uint256 pool) = RiskEngine.split(110_000e6, ALLOC, SPLIT_BPS);
        assertEq(trader, 8_000e6, "80% of the 10k profit");
        assertEq(pool, 102_000e6, "allocation back plus the 20% share");
        assertEq(trader + pool, 110_000e6, "legs sum to equity");
    }

    function test_split_loss_traderGetsNothing() public pure {
        (uint256 trader, uint256 pool) = RiskEngine.split(90_000e6, ALLOC, SPLIT_BPS);
        assertEq(trader, 0);
        assertEq(pool, 90_000e6, "pool eats the loss and takes back what's left");
    }

    function test_split_exactlyBreakEven() public pure {
        (uint256 trader, uint256 pool) = RiskEngine.split(ALLOC, ALLOC, SPLIT_BPS);
        assertEq(trader, 0, "break-even is not profit");
        assertEq(pool, ALLOC);
    }

    function test_split_totalLoss() public pure {
        (uint256 trader, uint256 pool) = RiskEngine.split(0, ALLOC, SPLIT_BPS);
        assertEq(trader, 0);
        assertEq(pool, 0);
    }

    function test_split_oneWeiOfProfit() public pure {
        (uint256 trader, uint256 pool) = RiskEngine.split(ALLOC + 1, ALLOC, SPLIT_BPS);
        assertEq(trader, 0, "80% of 1 wei rounds down to nothing");
        assertEq(pool, ALLOC + 1, "and the dust is not stranded");
    }

    function test_split_hundredPercentToTrader() public pure {
        (uint256 trader, uint256 pool) = RiskEngine.split(110_000e6, ALLOC, 10_000);
        assertEq(trader, 10_000e6);
        assertEq(pool, ALLOC);
    }

    // ─── distance to floor (the number on the trader's screen) ────────────────────

    function test_distanceToFloor() public pure {
        (uint256 abs, uint256 bps) = RiskEngine.distanceToFloor(100_000e6, 95_000e6);
        assertEq(abs, 5_000e6);
        assertEq(bps, 500);
    }

    function test_distanceToFloor_zeroWhenBreached() public pure {
        (uint256 abs, uint256 bps) = RiskEngine.distanceToFloor(94_000e6, 95_000e6);
        assertEq(abs, 0);
        assertEq(bps, 0);
    }

    function test_distanceToFloor_zeroEquityDoesNotDivideByZero() public pure {
        (uint256 abs, uint256 bps) = RiskEngine.distanceToFloor(0, 0);
        assertEq(abs, 0);
        assertEq(bps, 0);
    }

    // ─── terms validation ─────────────────────────────────────────────────────────

    function _terms() internal pure returns (Types.Terms memory) {
        return Types.Terms({
            allocation: ALLOC,
            maxDrawdownBps: DD_BPS,
            dailyLossBps: DAILY_BPS,
            profitSplitBps: SPLIT_BPS,
            maxPositionBps: POS_BPS,
            expiry: T0 + 30 days,
            resetHourUtc: 0
        });
    }

    function test_validateTerms_acceptsSaneDefaults() public pure {
        RiskEngine.validateTerms(_terms(), T0);
    }

    function test_validateTerms_rejectsZeroAllocation() public {
        Types.Terms memory t = _terms();
        t.allocation = 0;
        vm.expectRevert(Errors.ZeroAmount.selector);
        this.validate(t, T0);
    }

    function test_validateTerms_rejectsZeroDrawdown() public {
        Types.Terms memory t = _terms();
        t.maxDrawdownBps = 0;
        vm.expectRevert(Errors.DrawdownMustBeNonZero.selector);
        this.validate(t, T0);
    }

    /// @dev A daily limit looser than the trailing drawdown can never fire. Rejecting it
    ///      means every term printed on a mandate is one that can actually bind.
    function test_validateTerms_rejectsDailyLimitThatCanNeverFire() public {
        Types.Terms memory t = _terms();
        t.dailyLossBps = 2_000; // 20% daily against a 10% trailing cap
        vm.expectRevert(
            abi.encodeWithSelector(Errors.DailyLossLooserThanDrawdown.selector, uint16(2_000), DD_BPS)
        );
        this.validate(t, T0);
    }

    function test_validateTerms_rejectsSubOneXPositionCap() public {
        Types.Terms memory t = _terms();
        t.maxPositionBps = 9_999;
        vm.expectRevert(abi.encodeWithSelector(Errors.PositionCapTooLow.selector, uint16(9_999)));
        this.validate(t, T0);
    }

    function test_validateTerms_rejectsPastExpiry() public {
        Types.Terms memory t = _terms();
        t.expiry = T0;
        vm.expectRevert(abi.encodeWithSelector(Errors.ExpiryInPast.selector, T0, T0));
        this.validate(t, T0);
    }

    function test_validateTerms_rejectsSplitOverHundredPercent() public {
        Types.Terms memory t = _terms();
        t.profitSplitBps = 10_001;
        vm.expectRevert(abi.encodeWithSelector(Errors.BpsOutOfRange.selector, uint16(10_001)));
        this.validate(t, T0);
    }

    function test_validateTerms_rejectsBadResetHour() public {
        Types.Terms memory t = _terms();
        t.resetHourUtc = 24;
        vm.expectRevert(abi.encodeWithSelector(Errors.BpsOutOfRange.selector, uint16(24)));
        this.validate(t, T0);
    }

    /// @dev External wrapper so `vm.expectRevert` has a call boundary to catch on.
    function validate(Types.Terms memory t, uint64 nowTs) external pure {
        RiskEngine.validateTerms(t, nowTs);
    }

    // ─── fuzz ─────────────────────────────────────────────────────────────────────

    /// @dev The invariant that makes a mark trustworthy: whatever the price path, equity is
    ///      either at-or-above the binding floor, or the mandate is reported breached. There
    ///      is no third state where a mandate is under water and still alive.
    function testFuzz_breachIffBelowFloor(int256 netPnl, uint256 hwmSeed, uint16 ddBps, uint16 dailyBps)
        public
        pure
    {
        netPnl = bound(netPnl, -int256(ALLOC) * 2, int256(ALLOC) * 10);
        ddBps = uint16(bound(ddBps, 1, 9_999));
        dailyBps = uint16(bound(dailyBps, 1, ddBps)); // daily must be tighter, per validateTerms
        uint256 hwm = bound(hwmSeed, ALLOC, ALLOC * 5);

        RiskEngine.MarkInput memory input = RiskEngine.MarkInput({
            allocation: ALLOC,
            netPnl: netPnl,
            highWaterMark: hwm,
            dayStartEquity: ALLOC,
            dayStartTime: T0,
            maxDrawdownBps: ddBps,
            dailyLossBps: dailyBps,
            expiry: T0 + 30 days,
            resetHourUtc: 0,
            timestamp: T0 + 1 hours
        });

        RiskEngine.MarkResult memory r = RiskEngine.evaluate(input);

        bool under = r.equity < r.trailingFloor || r.equity < r.dailyFloor;
        assertEq(under, r.breach != Types.BreachKind.None, "breach flag must track the floors");

        // The peak is a peak.
        assertGe(r.highWaterMark, hwm);
        assertGe(r.highWaterMark, r.equity);

        // Floors are always reachable levels, never above the peak they derive from.
        assertLe(r.trailingFloor, r.highWaterMark);
        assertLe(r.dailyFloor, r.dayStartEquity);
    }

    /// @dev Settlement never mints and never strands: the two legs sum to exactly equity.
    function testFuzz_splitConservesEquity(uint256 equity, uint256 allocation, uint16 splitBps)
        public
        pure
    {
        equity = bound(equity, 0, 1e30);
        allocation = bound(allocation, 0, 1e30);
        splitBps = uint16(bound(splitBps, 0, 10_000));

        (uint256 trader, uint256 pool) = RiskEngine.split(equity, allocation, splitBps);
        assertEq(trader + pool, equity, "conservation");
        if (equity <= allocation) assertEq(trader, 0, "no payout without profit");
        if (splitBps == 0) assertEq(trader, 0);
    }

    /// @dev Repeated marks over a random path: the high-water mark is monotonic. This is the
    ///      property a trader is really buying — the level that kills them cannot be quietly
    ///      recomputed downward between marks.
    function testFuzz_hwmMonotonicOverPath(int256[8] memory pnlPath) public pure {
        uint256 hwm = ALLOC;
        for (uint256 i = 0; i < pnlPath.length; i++) {
            int256 pnl = bound(pnlPath[i], -int256(ALLOC), int256(ALLOC) * 3);
            RiskEngine.MarkResult memory r = RiskEngine.evaluate(_input(pnl, hwm, ALLOC, T0 + uint64(i + 1) * 1 hours));
            assertGe(r.highWaterMark, hwm, "hwm never falls");
            hwm = r.highWaterMark;
        }
    }
}

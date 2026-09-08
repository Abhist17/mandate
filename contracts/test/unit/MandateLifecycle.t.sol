// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "../utils/Fixture.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {RiskEngine} from "../../src/libraries/RiskEngine.sol";

/// @notice End-to-end tests over the deployed system: issuance, trading under constraints,
///         marking, breach, and settlement. The RiskEngine unit tests prove the maths; these
///         prove the maths is actually wired to the money.
contract MandateLifecycleTest is Fixture {
    // ─────────────────────────────────────────────────────────────────────────────
    //  Issuance
    // ─────────────────────────────────────────────────────────────────────────────

    function test_issue_allocatesCapitalAndOpensAtParity() public {
        uint256 poolBefore = pool.totalAssets();
        (uint256 id, MandateAccount account) = _issue();

        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Active));
        assertEq(account.equity(), ALLOC, "mandate opens holding exactly its allocation");
        assertEq(registry.stateOf(id).highWaterMark, ALLOC);
        assertEq(pool.totalAllocated(), ALLOC);

        // Capital moved out of idle and into a mandate — total pool value is unchanged.
        assertEq(pool.totalAssets(), poolBefore, "allocation is a move, not a loss");
        assertEq(pool.idleAssets(), SEED_LP - ALLOC);
    }

    function test_issue_onlyIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, stranger));
        registry.issue(trader, _defaultTerms());
    }

    function test_issue_rejectsAllocationOverPoolCap() public {
        Types.Terms memory terms = _defaultTerms();
        terms.allocation = (SEED_LP * 3) / 10; // 30% against a 20% cap
        vm.prank(owner);
        vm.expectRevert();
        registry.issue(trader, terms);
    }

    function test_issue_freezesTerms() public {
        (uint256 id,) = _issue();
        Types.Terms memory t = registry.termsOf(id);
        assertEq(t.maxDrawdownBps, DD_BPS);
        assertEq(t.profitSplitBps, SPLIT_BPS);
        // There is deliberately no setter to assert against — a mandate whose rules can
        // change mid-flight is a rulebook again.
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Position cap
    // ─────────────────────────────────────────────────────────────────────────────

    function test_positionCap_allowsUpToTheLimit() public {
        (uint256 id, MandateAccount account) = _issue();
        assertEq(registry.positionCapOf(id), 300_000 * ONE, "3x of a 100k allocation");

        // 3 BTC at 80k = 240k notional, inside the 300k cap.
        vm.prank(trader);
        account.openPosition(BTC, true, 3e18, 0);
        assertApproxEqRel(account.notional(), 240_000 * ONE, 0.01e18);
    }

    function test_positionCap_rejectsOversizedOrder() public {
        (uint256 id, MandateAccount account) = _issue();
        uint256 cap = registry.positionCapOf(id);

        // 4 BTC at 80k = 320k notional against a 300k cap.
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(Errors.PositionCapExceeded.selector, 320_000 * ONE, cap));
        account.openPosition(BTC, true, 4e18, 0);
    }

    /// @dev The cap is on *total* notional, so it cannot be walked around in slices.
    function test_positionCap_countsExistingPositions() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.startPrank(trader);
        account.openPosition(BTC, true, 2e18, 0); // 160k
        vm.expectRevert();
        account.openPosition(BTC, true, 2e18, 0); // would total 320k > 300k cap
        vm.stopPrank();
        assertLt(account.notional(), registry.positionCapOf(id));
    }

    /// @dev And it cannot be walked around across markets either.
    function test_positionCap_countsAcrossMarkets() public {
        (, MandateAccount account) = _issue();
        vm.startPrank(trader);
        account.openPosition(BTC, true, 3e18, 0); // 240k
        vm.expectRevert();
        account.openPosition(ETH, true, 40e18, 0); // +100k -> 340k
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Pre-trade floor check
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev A trader sitting just above their floor should not be able to bet the mandate on
    ///      one more trade with the pool's money.
    function test_preTrade_rejectsOrderThatCouldBreachImmediately() public {
        (uint256 id, MandateAccount account) = _issue();

        // Walk equity down to just above the 95k daily floor.
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 77_700); // ~-4.7k on 2 BTC: just inside the 5% daily floor
        registry.markAndEnforce(id);

        (uint256 floor,) = registry.floorOf(id);
        assertGt(account.equity(), floor, "still alive");

        // With ~200bp assumed adverse move, any meaningful new size fails the check.
        vm.prank(trader);
        vm.expectRevert();
        account.openPosition(BTC, true, 2e18, 0);
    }

    function test_preTrade_allowsOrderWithAmpleHeadroom() public {
        (, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 1e18, 0);
        assertGt(account.equity(), 99_000 * ONE);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Expiry
    // ─────────────────────────────────────────────────────────────────────────────

    function test_expiredMandate_rejectsNewOrders() public {
        (, MandateAccount account) = _issue();
        _skip(30 days);

        vm.prank(trader);
        vm.expectRevert();
        account.openPosition(BTC, true, 1e18, 0);
    }

    function test_expiredMandate_settlesAsExpiredNotBreached() public {
        (uint256 id,) = _issue();
        _skip(30 days);

        registry.markAndEnforce(id);
        Types.MandateState memory s = registry.stateOf(id);
        assertEq(uint8(s.status), uint8(Types.Status.Expired), "expired is not the same as breached");
        assertEq(uint8(s.breachKind), uint8(Types.BreachKind.Expiry));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Marking
    // ─────────────────────────────────────────────────────────────────────────────

    function test_mark_isPermissionless() public {
        (uint256 id,) = _issue();
        // A total stranger — no keeper role, no allowlist, no owner. This is the point.
        vm.prank(stranger);
        registry.markAndEnforce(id);
        assertEq(registry.stateOf(id).lastMarkedAt, uint64(block.timestamp));
    }

    function test_mark_ratchetsHighWaterMarkOnProfit() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);

        _setPrice(BTC, 85_000);
        registry.markAndEnforce(id);

        Types.MandateState memory s = registry.stateOf(id);
        assertGt(s.highWaterMark, ALLOC, "peak followed the trader up");

        // Give some back — the peak must not follow it down.
        _setPrice(BTC, 83_000);
        registry.markAndEnforce(id);
        assertEq(registry.stateOf(id).highWaterMark, s.highWaterMark);
    }

    function test_mark_revertsOnUnknownMandate() public {
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownMandate.selector, uint256(999)));
        registry.markAndEnforce(999);
    }

    function test_mark_revertsOnAlreadySettledMandate() public {
        (uint256 id,) = _issue();
        vm.prank(trader);
        registry.closeMandate(id);
        vm.expectRevert(abi.encodeWithSelector(Errors.MandateNotActive.selector, id));
        registry.markAndEnforce(id);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Breach — the money shot
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev The demo, asserted. Healthy mandate, adverse move, equity crosses the floor,
    ///      one permissionless call flattens the position and revokes the mandate.
    function test_breach_flattensPositionAndRevokesInOneCall() public {
        (uint256 id, MandateAccount account) = _issue();

        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        assertEq(venue.openMarkets(address(account)).length, 1, "position is open");

        // -6.25%: through the 5% daily floor.
        _setPrice(BTC, 75_000);

        vm.prank(stranger);
        bool breached = registry.markAndEnforce(id);

        assertTrue(breached);
        Types.MandateState memory s = registry.stateOf(id);
        assertEq(uint8(s.status), uint8(Types.Status.Breached));
        assertEq(venue.openMarkets(address(account)).length, 0, "position flattened in the same call");
        assertEq(account.equity(), 0, "account fully swept");
    }

    /// @dev Flatten must precede settle. If the order were reversed, the split would be
    ///      computed from a price nobody could actually get filled at.
    function test_breach_settlesFromRealisedNotMarkedEquity() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);

        _setPrice(BTC, 75_000);
        uint256 markedEquity = account.equity();

        vm.recordLogs();
        registry.markAndEnforce(id);

        uint256 finalEquity = registry.stateOf(id).lastMarkedEquity;
        assertLt(finalEquity, markedEquity, "closing cost spread and fee, and settlement paid it");
        assertApproxEqRel(finalEquity, markedEquity, 0.01e18, "but not by much");
    }

    function test_breach_traderIsPaidNothingOnALoss() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000);

        uint256 traderBefore = asset.balanceOf(trader);
        registry.markAndEnforce(id);
        assertEq(asset.balanceOf(trader), traderBefore, "no payout without profit");
    }

    function test_breach_lossStaysWithThePoolAndIsCapped() public {
        uint256 poolBefore = pool.totalAssets();
        (uint256 id, MandateAccount account) = _issue();

        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000);
        registry.markAndEnforce(id);

        uint256 poolAfter = pool.totalAssets();
        assertLt(poolAfter, poolBefore, "the pool took the loss");
        assertGt(poolAfter, poolBefore - ALLOC, "and it is capped by the allocation");
        assertEq(pool.totalAllocated(), 0, "allocation released");
    }

    /// @dev A trailing-drawdown breach after the trader has been in profit: they are stopped
    ///      out while still up on the original allocation, because the floor followed them up.
    function test_breach_trailingDrawdownStopsOutInProfit() public {
        Types.Terms memory terms = _defaultTerms();
        terms.dailyLossBps = DD_BPS; // let the trailing floor be the binding one
        (uint256 id, MandateAccount account) = _issue(trader, terms);

        vm.prank(trader);
        account.openPosition(BTC, true, 3e18, 0);

        _setPrice(BTC, 90_000); // +30k
        registry.markAndEnforce(id);
        uint256 peak = registry.stateOf(id).highWaterMark;
        assertGt(peak, ALLOC);

        _setPrice(BTC, 84_500); // give back more than 10% of the peak
        registry.markAndEnforce(id);

        Types.MandateState memory s = registry.stateOf(id);
        assertEq(uint8(s.status), uint8(Types.Status.Breached));
        assertEq(uint8(s.breachKind), uint8(Types.BreachKind.TrailingDrawdown));
        assertGt(s.lastMarkedEquity, ALLOC, "stopped out while still in profit: that is the deal");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Voluntary close and the profit split
    // ─────────────────────────────────────────────────────────────────────────────

    function test_close_paysTheProfitSplit() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);

        _setPrice(BTC, 84_000); // +8k
        registry.markAndEnforce(id);

        uint256 traderBefore = asset.balanceOf(trader);

        vm.prank(trader);
        registry.closeMandate(id);

        uint256 payout = asset.balanceOf(trader) - traderBefore;
        uint256 finalEquity = registry.stateOf(id).lastMarkedEquity;
        uint256 profit = finalEquity - ALLOC;

        assertGt(payout, 0, "trader was paid");
        assertEq(payout, (profit * SPLIT_BPS) / 10_000, "exactly 80% of realised profit");

        // Measured against the pool's value before the mandate existed, not against its value
        // mid-mandate: mid-mandate totalAssets counts 100% of the unrealised profit, and the
        // whole point of the split is that the trader then takes 80% of it away.
        assertEq(pool.totalAssets(), SEED_LP + profit - payout, "pool kept exactly its 20%");
        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Closed));
    }

    function test_close_onlyTraderOrOwner() public {
        (uint256 id,) = _issue();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotMandateTrader.selector, id, stranger));
        registry.closeMandate(id);
    }

    function test_close_atBreakEvenPaysTraderNothing() public {
        (uint256 id,) = _issue();
        uint256 traderBefore = asset.balanceOf(trader);
        vm.prank(trader);
        registry.closeMandate(id);
        assertEq(asset.balanceOf(trader), traderBefore);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Trader authorisation
    // ─────────────────────────────────────────────────────────────────────────────

    function test_onlyTraderMayTrade() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotMandateTrader.selector, id, stranger));
        account.openPosition(BTC, true, 1e18, 0);
    }

    function test_accountCannotBeReinitialised() public {
        (, MandateAccount account) = _issue();
        vm.expectRevert(Errors.AlreadyInitialised.selector);
        account.initialize(999, stranger, address(registry), address(venue));
    }

    function test_onlyRegistryMaySweep() public {
        (, MandateAccount account) = _issue();
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, trader));
        account.liquidateAndSweep();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Batch marking — the gas argument
    // ─────────────────────────────────────────────────────────────────────────────

    function test_batch_marksManyMandatesInOneTransaction() public {
        uint256[] memory ids = new uint256[](5);
        for (uint256 i; i < 5; ++i) {
            address t = address(uint160(0x1000 + i));
            (ids[i],) = _issue(t, _defaultTerms());
        }

        vm.prank(stranger);
        uint256 breaches = registry.markAndEnforceBatch(ids);
        assertEq(breaches, 0);
        for (uint256 i; i < 5; ++i) {
            assertEq(registry.stateOf(ids[i]).lastMarkedAt, uint64(block.timestamp));
        }
    }

    /// @dev One bad mandate must never stop every other mandate from being enforced.
    function test_batch_survivesOneRevertingMandate() public {
        (uint256 good,) = _issue(trader, _defaultTerms());
        (uint256 closed,) = _issue(makeAddr("t2"), _defaultTerms());
        vm.prank(makeAddr("t2"));
        registry.closeMandate(closed); // now inactive: marking it reverts

        uint256[] memory ids = new uint256[](3);
        ids[0] = closed;
        ids[1] = good;
        ids[2] = 4242; // does not exist

        _skip(1);
        registry.markAndEnforceBatch(ids);
        assertEq(registry.stateOf(good).lastMarkedAt, uint64(block.timestamp), "the good one still marked");
    }

    function test_batch_reportsBreachCount() public {
        (uint256 a, MandateAccount accA) = _issue(trader, _defaultTerms());
        (uint256 b, MandateAccount accB) = _issue(makeAddr("t2"), _defaultTerms());

        vm.prank(trader);
        accA.openPosition(BTC, true, 2e18, 0);
        vm.prank(makeAddr("t2"));
        accB.openPosition(BTC, true, 2e18, 0);

        _setPrice(BTC, 75_000);

        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        assertEq(registry.markAndEnforceBatch(ids), 2, "both breached in one transaction");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Daily window across a real day boundary
    // ─────────────────────────────────────────────────────────────────────────────

    function test_dailyWindow_rollsAtUtcMidnight() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);

        _setPrice(BTC, 78_000); // -4k, inside the 5% daily limit
        registry.markAndEnforce(id);
        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Active));

        uint256 dayStartBefore = registry.stateOf(id).dayStartEquity;
        _skip(1 days);
        registry.markAndEnforce(id);

        Types.MandateState memory s = registry.stateOf(id);
        assertLt(s.dayStartEquity, dayStartBefore, "new window measured from the lower base");
        assertEq(s.dayStartTime, uint64(block.timestamp));
    }

    /// @dev The rollover must not launder a trailing-drawdown breach: the peak survives it.
    function test_dailyWindow_rolloverDoesNotForgiveTrailingBreach() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 3e18, 0);

        _skip(1 days);
        _setPrice(BTC, 76_000); // -12k on 3 BTC, past the 10% trailing floor
        registry.markAndEnforce(id);

        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Breached));
        assertEq(uint8(registry.stateOf(id).breachKind), uint8(Types.BreachKind.TrailingDrawdown));
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Oracle safety
    // ─────────────────────────────────────────────────────────────────────────────

    function test_oracle_staleFeedBlocksTrading() public {
        (, MandateAccount account) = _issue();
        vm.warp(block.timestamp + 1 hours); // no price pushed: the feed goes stale
        vm.prank(trader);
        vm.expectRevert();
        account.openPosition(BTC, true, 1e18, 0);
    }

    function test_oracle_rejectsUnauthorisedPublisher() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, stranger));
        oracle.pushPrice(BTC, 80_000 * PRICE, uint64(block.timestamp));
    }

    function test_oracle_deviationGuardRejectsAbsurdJump() public {
        vm.prank(keeper);
        vm.expectRevert();
        oracle.pushPrice(BTC, 8_000 * PRICE, uint64(block.timestamp)); // -90% in one tick
    }

    function test_oracle_ownerCanForceThroughARealGap() public {
        _forcePrice(BTC, 8_000);
        assertEq(_priceOf(BTC), 8_000 * PRICE);
    }
}

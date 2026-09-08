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

    // ─────────────────────────────────────────────────────────────────────────────
    //  Payout conditions, end to end
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev The soft breach, wired to the money. A trader whose profit came from one lucky
    ///      day cannot withdraw — but the mandate stays Active and they can keep trading
    ///      until the score improves. This is the behaviour a real firm implements on a
    ///      private server; here the trader can read the arithmetic before they try.
    function test_payout_consistencyRuleBlocksTheCloseButNotTheMandate() public {
        Types.Terms memory terms = _defaultTerms();
        terms.maxConsistencyBps = 1_500; // FundingPips Zero's 15%
        terms.dailyLossBps = DD_BPS; // let the trailing floor bind, so a big day is possible
        (uint256 id, MandateAccount account) = _issue(trader, terms);

        // One large winning day: open, rally, roll the day so the gain is booked.
        vm.prank(trader);
        account.openPosition(BTC, true, 3e18, 0);
        _setPrice(BTC, 84_000);
        registry.markAndEnforce(id);
        _skip(1 days);
        registry.markAndEnforce(id);

        assertGt(registry.stateOf(id).largestDailyGain, 0, "a winning day was recorded");
        assertGt(registry.consistencyScore(id), 1_500, "essentially all profit from one day");

        (bool ok, Types.PayoutBlock reason) = registry.payoutEligibility(id);
        assertFalse(ok);
        assertEq(uint8(reason), uint8(Types.PayoutBlock.Consistency));

        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(
                Errors.PayoutConditionNotMet.selector, id, uint8(Types.PayoutBlock.Consistency)
            )
        );
        registry.closeMandate(id);

        // Soft: still trading, not breached.
        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Active), "mandate survives");
    }

    /// @dev The operator cannot wave it through. A payout condition an owner can override is
    ///      a payout condition that means nothing.
    function test_payout_ownerCannotOverrideAConsistencyBlock() public {
        Types.Terms memory terms = _defaultTerms();
        terms.maxConsistencyBps = 1_500;
        terms.dailyLossBps = DD_BPS;
        (uint256 id, MandateAccount account) = _issue(trader, terms);

        vm.prank(trader);
        account.openPosition(BTC, true, 3e18, 0);
        _setPrice(BTC, 84_000);
        registry.markAndEnforce(id);
        _skip(1 days);
        registry.markAndEnforce(id);

        vm.prank(owner);
        vm.expectRevert();
        registry.closeMandate(id);
    }

    /// @dev A losing mandate is always closeable: there is no payout to withhold, and holding
    ///      a trader hostage over a rule about profit they do not have would be absurd.
    function test_payout_losingMandateIsAlwaysCloseable() public {
        Types.Terms memory terms = _defaultTerms();
        terms.maxConsistencyBps = 1_500;
        (uint256 id, MandateAccount account) = _issue(trader, terms);

        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 78_000);
        registry.markAndEnforce(id);

        vm.prank(trader);
        registry.closeMandate(id);
        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Closed));
    }

    /// @dev A breach settles regardless of payout conditions. The conditions gate *taking
    ///      profit*, not being enforced out — a trader cannot dodge a drawdown breach by
    ///      being inconsistent.
    function test_payout_conditionsDoNotBlockBreachSettlement() public {
        Types.Terms memory terms = _defaultTerms();
        terms.maxConsistencyBps = 1; // impossible to satisfy
        (uint256 id, MandateAccount account) = _issue(trader, terms);

        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000);

        vm.prank(stranger);
        registry.markAndEnforce(id);
        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Breached), "enforced anyway");
    }

    /// @dev Two comparable winning days, so no single day dominates the profit. Contrast with
    ///      the one-lucky-day case above: same total profit shape, opposite verdict, and the
    ///      difference is exactly what the consistency rule is for.
    function test_payout_eligibleWhenProfitIsSpreadAcrossDays() public {
        Types.Terms memory terms = _defaultTerms();
        terms.maxConsistencyBps = 9_000; // generous threshold
        terms.dailyLossBps = DD_BPS;
        (uint256 id, MandateAccount account) = _issue(trader, terms);

        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);

        // Day one: a modest gain, booked by the rollover.
        _setPrice(BTC, 81_000);
        registry.markAndEnforce(id);
        _skip(1 days);
        registry.markAndEnforce(id);

        // Day two: a comparable gain, so neither day dominates.
        _setPrice(BTC, 82_000);
        registry.markAndEnforce(id);
        _skip(1 days);
        registry.markAndEnforce(id);

        assertEq(registry.stateOf(id).profitableDays, 2, "two winning days on record");
        assertLt(registry.consistencyScore(id), 9_000, "no single day dominates");

        (bool ok,) = registry.payoutEligibility(id);
        assertTrue(ok, "inside a 90% threshold");

        vm.prank(trader);
        registry.closeMandate(id);
        assertGt(asset.balanceOf(trader), 0, "and the trader was actually paid");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Drawdown modes, end to end
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Under a static floor a trader who is up can give the profit back without dying.
    ///      Under a trailing floor the same path is a breach. Same trades, different terms.
    function test_drawdownMode_staticSurvivesWhatTrailingKills() public {
        Types.Terms memory staticTerms = _defaultTerms();
        staticTerms.drawdownMode = Types.DrawdownMode.Static;
        staticTerms.dailyLossBps = DD_BPS;
        (uint256 staticId, MandateAccount staticAcct) = _issue(trader, staticTerms);

        Types.Terms memory trailingTerms = _defaultTerms();
        trailingTerms.drawdownMode = Types.DrawdownMode.Trailing;
        trailingTerms.dailyLossBps = DD_BPS;
        address t2 = makeAddr("trailingTrader");
        (uint256 trailId, MandateAccount trailAcct) = _issue(t2, trailingTerms);

        vm.prank(trader);
        staticAcct.openPosition(BTC, true, 3e18, 0);
        vm.prank(t2);
        trailAcct.openPosition(BTC, true, 3e18, 0);

        // Rally, so the trailing floor ratchets above the allocation.
        _setPrice(BTC, 90_000);
        registry.markAndEnforce(staticId);
        registry.markAndEnforce(trailId);

        // Give it all back to just above the original allocation.
        _setPrice(BTC, 80_400);
        registry.markAndEnforce(staticId);
        registry.markAndEnforce(trailId);

        assertEq(
            uint8(registry.stateOf(staticId).status),
            uint8(Types.Status.Active),
            "static floor never moved, so giving profit back is survivable"
        );
        assertEq(
            uint8(registry.stateOf(trailId).status),
            uint8(Types.Status.Breached),
            "trailing floor followed the peak up and caught them on the way down"
        );
    }
}
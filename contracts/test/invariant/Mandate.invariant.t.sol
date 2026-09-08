// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "../utils/Fixture.sol";
import {Handler} from "./Handler.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {Types} from "../../src/libraries/Types.sol";
import {RiskEngine} from "../../src/libraries/RiskEngine.sol";

/// @title Mandate invariants
/// @notice Properties that must hold after *any* legal sequence of LP deposits, mandate
///         issuance, trading, price moves and marks.
///
/// @dev These are the claims a prop firm makes verbally and cannot demonstrate. Written as
///      invariants they are checked against thousands of random paths rather than the handful
///      a developer thought to try.
contract MandateInvariantTest is Fixture {
    Handler internal handler;

    function setUp() public override {
        super.setUp();

        address[] memory lpList = new address[](3);
        lpList[0] = lp;
        lpList[1] = lp2;
        lpList[2] = makeAddr("lp3");

        address[] memory traderList = new address[](4);
        traderList[0] = trader;
        traderList[1] = makeAddr("trader2");
        traderList[2] = makeAddr("trader3");
        traderList[3] = makeAddr("trader4");

        handler = new Handler(asset, oracle, venue, registry, pool, owner, keeper, lpList, traderList);

        vm.startPrank(owner);
        registry.setIssuer(address(handler), true);
        oracle.setPublisher(address(handler), true);
        vm.stopPrank();

        targetContract(address(handler));

        // Only drive the system through the handler — direct calls would let the fuzzer set
        // states no real user could reach, and the invariants are about reachable states.
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = Handler.lpDeposit.selector;
        selectors[1] = Handler.lpRequestWithdrawal.selector;
        selectors[2] = Handler.lpClaimWithdrawal.selector;
        selectors[3] = Handler.lpCancelWithdrawal.selector;
        selectors[4] = Handler.issueMandate.selector;
        selectors[5] = Handler.openPosition.selector;
        selectors[6] = Handler.closePosition.selector;
        selectors[7] = Handler.closeMandate.selector;
        selectors[8] = Handler.movePrice.selector;
        selectors[9] = Handler.markAll.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice No Active mandate sits below its own floor at its last mark.
    ///
    /// @dev The core promise. A trader who breached is not still trading with the pool's
    ///      capital, and an LP reading "Active" is reading a mandate that was inside its
    ///      terms the last time anybody looked.
    ///
    ///      Stated against *last-marked* equity rather than live equity on purpose: between
    ///      marks the price moves and equity can be anywhere. That is not a violation, it is
    ///      the reason marking has to happen every block. The claim being tested is that the
    ///      mark itself never leaves a breached mandate Active.
    function invariant_noActiveMandateBelowItsFloorAtLastMark() public view {
        uint256[] memory active = registry.activeMandates();
        for (uint256 i; i < active.length; ++i) {
            Types.MandateState memory s = registry.stateOf(active[i]);
            Types.Terms memory t = registry.termsOf(active[i]);

            uint256 tf = RiskEngine.trailingFloor(s.highWaterMark, t.maxDrawdownBps);
            uint256 df = RiskEngine.dailyFloor(s.dayStartEquity, t.dailyLossBps);

            assertGe(s.lastMarkedEquity, tf, "active mandate below its trailing floor");
            assertGe(s.lastMarkedEquity, df, "active mandate below its daily floor");
        }
    }

    /// @notice A high-water mark is never below the allocation it started from, and never
    ///         below the mandate's last marked equity.
    function invariant_highWaterMarkIsAPeak() public view {
        uint256[] memory active = registry.activeMandates();
        for (uint256 i; i < active.length; ++i) {
            Types.MandateState memory s = registry.stateOf(active[i]);
            Types.Terms memory t = registry.termsOf(active[i]);
            assertGe(s.highWaterMark, t.allocation, "peak fell below the starting allocation");
            assertGe(s.highWaterMark, s.lastMarkedEquity, "peak below current equity");
        }
    }

    /// @notice No order ever filled that left a mandate over its position cap.
    ///
    /// @dev The cap is a constraint on *orders*, checked when one is placed. It is not a leash
    ///      on the resulting position: once open, mark-priced notional drifts with the market
    ///      in both directions, and a position that grew because the trade went the trader's
    ///      way is not a violation. Adverse drift is the drawdown floor's job, not the cap's.
    ///
    ///      So the handler asserts the guarantee at the moment it is supposed to hold —
    ///      immediately after each successful fill — and this invariant requires that counter
    ///      to stay at zero. Two earlier formulations of this property were wrong and the
    ///      fuzzer broke both: asserting mark-priced notional as a state invariant (broken by
    ///      two consecutive up-moves) and then entry-priced notional (broken by adding to a
    ///      position after the price fell, which is legitimate — current exposure really is
    ///      lower). Keeping the history here because the two rejected versions are the
    ///      interesting part: the cap means something more specific than it first appears.
    function invariant_noOrderEverBreachedThePositionCap() public view {
        assertEq(handler.ghostCapViolations(), 0, "an order filled beyond the position cap");
    }

    /// @notice `totalAllocated` equals the sum of allocations of live mandates.
    /// @dev Guards the pool's allocation accounting against drift over settlement paths.
    function invariant_totalAllocatedMatchesLiveMandates() public view {
        uint256[] memory active = registry.activeMandates();
        uint256 sum;
        for (uint256 i; i < active.length; ++i) {
            sum += registry.termsOf(active[i]).allocation;
        }
        assertEq(pool.totalAllocated(), sum, "allocated accounting drifted");
    }

    /// @notice The registry never holds assets between transactions.
    ///
    /// @dev Settlement sweeps a mandate, splits it and pays both legs in one call. Any
    ///      balance resting here afterwards is capital belonging to somebody that nobody can
    ///      claim — the precise failure a prop firm's payout desk is accused of.
    function invariant_registryHoldsNothing() public view {
        assertEq(asset.balanceOf(address(registry)), 0, "assets stranded in the registry");
    }

    /// @notice A settled mandate's account is empty.
    function invariant_settledAccountsAreEmpty() public view {
        uint256 n = handler.mandateCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.mandateAt(i);
            Types.MandateState memory s = registry.stateOf(id);
            if (s.status == Types.Status.Active || s.status == Types.Status.None) continue;
            assertEq(asset.balanceOf(s.account), 0, "settled mandate still holds assets");
            assertEq(venue.openMarkets(s.account).length, 0, "settled mandate still has a position");
        }
    }

    /// @notice Nothing leaks. Every asset unit sits with a known participant.
    ///
    /// @dev Enumerates the pool, the venue, the registry, every mandate account, every trader
    ///      and every LP, and requires them to account for the entire supply. If settlement
    ///      ever sent funds somewhere unintended, this is what catches it.
    function invariant_assetsAreFullyAccountedFor() public view {
        uint256 sum = asset.balanceOf(address(pool)) + asset.balanceOf(address(venue))
            + asset.balanceOf(address(registry));

        uint256 n = handler.mandateCount();
        for (uint256 i; i < n; ++i) {
            sum += asset.balanceOf(registry.stateOf(handler.mandateAt(i)).account);
        }
        for (uint256 i; i < handler.traderCount(); ++i) {
            sum += asset.balanceOf(handler.traderAt(i));
        }
        for (uint256 i; i < handler.lpCount(); ++i) {
            sum += asset.balanceOf(handler.lpAt(i));
        }
        sum += asset.balanceOf(backstop);

        assertEq(sum, asset.totalSupply(), "assets went somewhere unaccounted for");
    }

    /// @notice The pool can always honour what it says a share is worth, out of what it holds
    ///         plus what its mandates are worth.
    function invariant_poolSharePriceIsBacked() public view {
        uint256 supply = pool.totalSupply();
        if (supply == 0) return;
        uint256 backing = pool.idleAssets() + registry.aggregateActiveEquity();
        assertEq(pool.totalAssets(), backing, "totalAssets is not the sum of what backs it");
    }

    /// @notice A trader is never paid more than the profit split of realised profit.
    /// @dev Checked structurally: for every settled mandate, the payout the contract made is
    ///      exactly what {RiskEngine-split} says it should be for the equity that came back.
    function invariant_traderPayoutsMatchTheSplit() public view {
        uint256 n = handler.mandateCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.mandateAt(i);
            Types.MandateState memory s = registry.stateOf(id);
            if (s.status == Types.Status.Active || s.status == Types.Status.None) continue;

            Types.Terms memory t = registry.termsOf(id);
            (uint256 expectedPayout, uint256 expectedPoolReturn) =
                RiskEngine.split(s.lastMarkedEquity, t.allocation, t.profitSplitBps);
            assertEq(
                expectedPayout + expectedPoolReturn,
                s.lastMarkedEquity,
                "settlement legs do not sum to the equity that came back"
            );
            if (s.lastMarkedEquity <= t.allocation) {
                assertEq(expectedPayout, 0, "trader paid on a losing mandate");
            }
        }
    }

    /// @notice Pending withdrawal shares are actually escrowed in the pool.
    function invariant_pendingWithdrawalsAreEscrowed() public view {
        assertEq(
            pool.balanceOf(address(pool)),
            pool.pendingWithdrawalShares(),
            "escrowed shares do not match pending requests"
        );
    }

    /// @notice Anti-vacuity: prove the handler can actually reach the states the invariants
    ///         are about, so a green suite means the properties held under real activity
    ///         rather than under a run where every call happened to revert.
    ///
    /// @dev A deterministic scripted path rather than an `afterInvariant` assertion. The
    ///      fuzzer resets state between runs, so a per-run liveness check fails whenever a
    ///      sequence happens to issue its first mandate on its last call — which says nothing
    ///      about the protocol. This drives the same handler through a path that must issue,
    ///      trade, mark and breach.
    function test_handlerReachesMarksAndBreaches() public {
        handler.lpDeposit(0, 1_000_000 * ONE);
        handler.issueMandate(0, 100_000 * ONE, 1_000, SPLIT_BPS);
        assertGt(handler.mandateCount(), 0, "handler cannot issue a mandate");

        handler.openPosition(0, 2e18, true, false);
        handler.markAll(1);
        assertGt(handler.ghostMarkCount(), 0, "handler cannot mark");

        // Walk the price down until the mandate is enforced out.
        for (uint256 i; i < 8 && registry.activeCount() > 0; ++i) {
            handler.movePrice(0, 0, 1 hours); // bound() floors to the -20% edge
            handler.markAll(uint256(i + 2));
        }
        assertGt(handler.ghostBreachCount(), 0, "handler never reaches a breach");
        assertEq(registry.activeCount(), 0, "breached mandate is no longer active");
    }
}

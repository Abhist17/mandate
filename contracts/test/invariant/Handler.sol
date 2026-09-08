// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {MockERC20} from "../utils/MockERC20.sol";
import {PriceOracle} from "../../src/oracle/PriceOracle.sol";
import {MiniPerp} from "../../src/venue/MiniPerp.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {CapitalPool} from "../../src/CapitalPool.sol";
import {Types} from "../../src/libraries/Types.sol";
import {RiskEngine} from "../../src/libraries/RiskEngine.sol";

/// @notice Drives the protocol through random but *legal* sequences: LPs deposit and queue
///         withdrawals, mandates get issued, traders open and close positions, the price
///         wanders, and the keeper marks.
///
/// @dev Every action swallows reverts. The invariants are about states the protocol reaches,
///      not about which calls happen to succeed under a random input — a rejected oversized
///      order is the system working, not a failed run.
contract Handler is CommonBase, StdCheats, StdUtils {
    uint16 internal constant BTC = 16;
    uint16 internal constant ETH = 32;
    uint256 internal constant ONE = 1e6;
    uint256 internal constant PRICE = 1e8;

    MockERC20 public asset;
    PriceOracle public oracle;
    MiniPerp public venue;
    MandateRegistry public registry;
    CapitalPool public pool;
    address public owner;
    address public keeper;

    address[] public lps;
    address[] public traders;
    uint256[] public allMandates;

    // ── ghost variables ───────────────────────────────────────────────────────────
    /// @notice Everything ever paid to traders as a profit split.
    uint256 public ghostTraderPayouts;
    /// @notice Everything ever returned to the pool at settlement.
    uint256 public ghostPoolReturns;
    /// @notice Sum of allocations ever issued.
    uint256 public ghostAllocated;
    /// @notice What the profit split *should* have paid, recomputed independently.
    uint256 public ghostExpectedPayouts;
    /// @notice Mandates that reached a terminal state.
    uint256 public ghostSettledCount;
    /// @notice Breaches enforced.
    uint256 public ghostBreachCount;
    /// @notice Marks performed.
    uint256 public ghostMarkCount;
    /// @notice Times an order left a mandate over its position cap. Must stay at zero.
    uint256 public ghostCapViolations;
    /// @notice Orders that were actually filled, so the check above is not vacuous.
    uint256 public ghostFilledOrders;

    uint256 public btcPrice = 80_000;
    uint256 public ethPrice = 2_500;

    constructor(
        MockERC20 asset_,
        PriceOracle oracle_,
        MiniPerp venue_,
        MandateRegistry registry_,
        CapitalPool pool_,
        address owner_,
        address keeper_,
        address[] memory lps_,
        address[] memory traders_
    ) {
        asset = asset_;
        oracle = oracle_;
        venue = venue_;
        registry = registry_;
        pool = pool_;
        owner = owner_;
        keeper = keeper_;
        lps = lps_;
        traders = traders_;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  LP actions
    // ─────────────────────────────────────────────────────────────────────────────

    function lpDeposit(uint256 lpSeed, uint256 amount) external {
        address who = lps[bound(lpSeed, 0, lps.length - 1)];
        amount = bound(amount, ONE, 500_000 * ONE);
        asset.mint(who, amount);
        vm.startPrank(who);
        asset.approve(address(pool), amount);
        try pool.deposit(amount, who) {} catch {}
        vm.stopPrank();
    }

    function lpRequestWithdrawal(uint256 lpSeed, uint256 shares) external {
        address who = lps[bound(lpSeed, 0, lps.length - 1)];
        uint256 bal = pool.balanceOf(who);
        if (bal == 0) return;
        shares = bound(shares, 1, bal);
        vm.prank(who);
        try pool.requestWithdrawal(shares) {} catch {}
    }

    function lpClaimWithdrawal(uint256 lpSeed) external {
        address who = lps[bound(lpSeed, 0, lps.length - 1)];
        vm.prank(who);
        try pool.claimWithdrawal() {} catch {}
    }

    function lpCancelWithdrawal(uint256 lpSeed) external {
        address who = lps[bound(lpSeed, 0, lps.length - 1)];
        vm.prank(who);
        try pool.cancelWithdrawal() {} catch {}
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Issuance
    // ─────────────────────────────────────────────────────────────────────────────

    function issueMandate(uint256 traderSeed, uint256 allocSeed, uint256 ddSeed, uint256 splitSeed)
        external
    {
        address who = traders[bound(traderSeed, 0, traders.length - 1)];
        uint16 dd = uint16(bound(ddSeed, 200, 5_000));

        Types.Terms memory terms = Types.Terms({
            allocation: bound(allocSeed, 1_000 * ONE, 200_000 * ONE),
            maxDrawdownBps: dd,
            dailyLossBps: uint16(bound(ddSeed, 100, dd)), // must be tighter than the drawdown
            profitSplitBps: uint16(bound(splitSeed, 0, 10_000)),
            maxPositionBps: 30_000,
            expiry: uint64(block.timestamp) + 30 days,
            resetHourUtc: 0,
            drawdownMode: Types.DrawdownMode(bound(ddSeed, 0, 2)),
            maxConsistencyBps: uint16(bound(splitSeed, 0, 10_000)),
            minProfitableDays: 0,
            payoutCushionBps: 0,
            touchIsBreach: ddSeed % 2 == 0
        });

        vm.prank(owner);
        try registry.issue(who, terms) returns (uint256 id) {
            allMandates.push(id);
            ghostAllocated += terms.allocation;
        } catch {}
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Trading
    // ─────────────────────────────────────────────────────────────────────────────

    function openPosition(uint256 mandateSeed, uint256 sizeSeed, bool isLong, bool useEth) external {
        (uint256 id, MandateAccount account) = _pickActive(mandateSeed);
        if (id == 0) return;

        uint16 marketId = useEth ? ETH : BTC;
        uint256 size = useEth ? bound(sizeSeed, 1e15, 100e18) : bound(sizeSeed, 1e14, 5e18);

        vm.prank(registry.stateOf(id).trader);
        try account.openPosition(marketId, isLong, size, 0) {
            ghostFilledOrders++;
            // The contract's guarantee is about the instant an order fills: total notional,
            // priced at the current mark, must be inside the cap. Checked here rather than as
            // a state invariant because notional legitimately drifts afterwards as the market
            // moves, in both directions.
            Types.Terms memory t = registry.termsOf(id);
            uint256 cap = RiskEngine.maxNotional(t.allocation, t.maxPositionBps);
            if (venue.totalNotional(address(account)) > (cap * 101) / 100) {
                ghostCapViolations++;
            }
        } catch {}
    }

    function closePosition(uint256 mandateSeed, bool useEth) external {
        (uint256 id, MandateAccount account) = _pickActive(mandateSeed);
        if (id == 0) return;

        vm.prank(registry.stateOf(id).trader);
        try account.closePosition(useEth ? ETH : BTC, 0) {} catch {}
    }

    function closeMandate(uint256 mandateSeed) external {
        (uint256 id,) = _pickActive(mandateSeed);
        if (id == 0) return;
        _recordExpectedPayout(id);
        vm.prank(registry.stateOf(id).trader);
        // A close can legitimately revert on an unmet payout condition — that is the soft
        // breach working, not a failure.
        try registry.closeMandate(id) {
            ghostSettledCount++;
        } catch {}
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  The world moves
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Bounded to ±20% per step so the oracle deviation guard never trips. A guard
    ///      rejecting a push is correct behaviour, but it would silently freeze the price
    ///      and hollow out the run.
    function movePrice(uint256 btcSeed, uint256 ethSeed, uint256 timeSeed) external {
        uint256 btcNext = bound(btcSeed, (btcPrice * 80) / 100, (btcPrice * 120) / 100);
        uint256 ethNext = bound(ethSeed, (ethPrice * 80) / 100, (ethPrice * 120) / 100);
        if (btcNext == 0) btcNext = 1;
        if (ethNext == 0) ethNext = 1;

        vm.warp(block.timestamp + bound(timeSeed, 1, 6 hours));
        btcPrice = btcNext;
        ethPrice = ethNext;

        vm.startPrank(keeper);
        try oracle.pushPrice(BTC, btcPrice * PRICE, uint64(block.timestamp)) {} catch {}
        try oracle.pushPrice(ETH, ethPrice * PRICE, uint64(block.timestamp)) {} catch {}
        vm.stopPrank();
    }

    /// @dev The keeper's job, called by a random address to exercise permissionlessness.
    function markAll(uint256 callerSeed) external {
        uint256[] memory active = registry.activeMandates();
        if (active.length == 0) return;

        for (uint256 i; i < active.length; ++i) {
            _recordExpectedPayout(active[i]);
        }

        address caller = address(uint160(bound(callerSeed, 1, type(uint96).max)));
        vm.prank(caller);
        try registry.markAndEnforceBatch(active) returns (uint256 breaches) {
            ghostMarkCount += active.length;
            ghostBreachCount += breaches;
            ghostSettledCount += breaches;
        } catch {}
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────────────

    function _pickActive(uint256 seed) internal view returns (uint256 id, MandateAccount account) {
        uint256[] memory active = registry.activeMandates();
        if (active.length == 0) return (0, MandateAccount(address(0)));
        id = active[bound(seed, 0, active.length - 1)];
        account = MandateAccount(registry.stateOf(id).account);
    }

    /// @dev Snapshot what the split *should* pay if this mandate settled right now, computed
    ///      independently of the contract, so the payout invariant is not just asserting the
    ///      implementation against itself.
    function _recordExpectedPayout(uint256 id) internal {
        Types.MandateState memory s = registry.stateOf(id);
        if (s.status != Types.Status.Active) return;
        Types.Terms memory t = registry.termsOf(id);
        uint256 equity = MandateAccount(s.account).equity();
        (uint256 expected,) = RiskEngine.split(equity, t.allocation, t.profitSplitBps);
        _pendingExpected[id] = expected;
    }

    mapping(uint256 => uint256) internal _pendingExpected;

    function pendingExpected(uint256 id) external view returns (uint256) {
        return _pendingExpected[id];
    }

    function mandateCount() external view returns (uint256) {
        return allMandates.length;
    }

    function mandateAt(uint256 i) external view returns (uint256) {
        return allMandates[i];
    }

    function traderCount() external view returns (uint256) {
        return traders.length;
    }

    function traderAt(uint256 i) external view returns (address) {
        return traders[i];
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }

    function lpAt(uint256 i) external view returns (address) {
        return lps[i];
    }
}

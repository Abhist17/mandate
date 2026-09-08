// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "../utils/Fixture.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice The LP side: deposits, the two-step withdrawal, allocation limits, and how a
///         breach lands on share price.
contract CapitalPoolTest is Fixture {
    // ─── deposits ─────────────────────────────────────────────────────────────────

    function test_firstDepositMintsAtParity() public view {
        assertEq(pool.balanceOf(lp), SEED_LP, "1 share per asset unit at genesis");
        assertEq(pool.totalAssets(), SEED_LP);
        assertEq(pool.pricePerShare(), 1e6);
    }

    function test_secondDepositMintsAtCurrentPrice() public {
        vm.startPrank(lp2);
        asset.approve(address(pool), type(uint256).max);
        uint256 shares = pool.deposit(1_000_000 * ONE, lp2);
        vm.stopPrank();
        assertEq(shares, 1_000_000 * ONE, "flat pool, so still parity");
    }

    /// @dev A depositor must not mint shares against their own incoming assets.
    function test_depositDoesNotDiluteExistingLps() public {
        uint256 priceBefore = pool.pricePerShare();
        vm.startPrank(lp2);
        asset.approve(address(pool), type(uint256).max);
        pool.deposit(500_000 * ONE, lp2);
        vm.stopPrank();
        assertEq(pool.pricePerShare(), priceBefore, "share price unmoved by a deposit");
    }

    function test_depositRejectsZero() public {
        vm.prank(lp);
        vm.expectRevert(Errors.ZeroAmount.selector);
        pool.deposit(0, lp);
    }

    function test_depositRejectsZeroReceiver() public {
        vm.prank(lp);
        vm.expectRevert(Errors.ZeroAddress.selector);
        pool.deposit(ONE, address(0));
    }

    // ─── the two-step withdrawal ──────────────────────────────────────────────────

    function test_withdrawal_escrowsSharesImmediately() public {
        vm.prank(lp);
        pool.requestWithdrawal(1_000 * ONE);

        assertEq(pool.balanceOf(lp), SEED_LP - 1_000 * ONE, "shares left the LP");
        assertEq(pool.balanceOf(address(pool)), 1_000 * ONE, "and are escrowed here");
        assertEq(pool.pendingWithdrawalShares(), 1_000 * ONE);
    }

    function test_withdrawal_cannotClaimBeforeTheDelay() public {
        vm.startPrank(lp);
        pool.requestWithdrawal(1_000 * ONE);
        vm.expectRevert();
        pool.claimWithdrawal();
        vm.stopPrank();
    }

    function test_withdrawal_claimsAfterTheDelay() public {
        uint256 before = asset.balanceOf(lp);
        vm.startPrank(lp);
        pool.requestWithdrawal(1_000 * ONE);
        skip(61);
        uint256 got = pool.claimWithdrawal();
        vm.stopPrank();

        assertEq(got, 1_000 * ONE);
        assertEq(asset.balanceOf(lp) - before, 1_000 * ONE);
        assertEq(pool.pendingWithdrawalShares(), 0);
        assertEq(pool.balanceOf(address(pool)), 0, "escrow released");
    }

    function test_withdrawal_canBeCancelled() public {
        vm.startPrank(lp);
        pool.requestWithdrawal(1_000 * ONE);
        pool.cancelWithdrawal();
        vm.stopPrank();

        assertEq(pool.balanceOf(lp), SEED_LP, "shares returned");
        assertEq(pool.pendingWithdrawalShares(), 0);
    }

    function test_withdrawal_onlyOneRequestAtATime() public {
        vm.startPrank(lp);
        pool.requestWithdrawal(1_000 * ONE);
        vm.expectRevert(abi.encodeWithSelector(Errors.WithdrawalAlreadyQueued.selector, lp));
        pool.requestWithdrawal(1_000 * ONE);
        vm.stopPrank();
    }

    function test_withdrawal_cannotRequestMoreThanHeld() public {
        vm.prank(lp2);
        vm.expectRevert();
        pool.requestWithdrawal(1);
    }

    function test_withdrawal_claimWithoutRequestReverts() public {
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(Errors.NoPendingWithdrawal.selector, lp));
        pool.claimWithdrawal();
    }

    function test_withdrawal_cancelWithoutRequestReverts() public {
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(Errors.NoPendingWithdrawal.selector, lp));
        pool.cancelWithdrawal();
    }

    /// @dev Capital inside a live mandate is not available to exit against. Honouring the
    ///      claim would mean closing a trader's position to fund an LP.
    function test_withdrawal_cannotDrawOnAllocatedCapital() public {
        // Allocate most of the pool out to mandates.
        for (uint256 i; i < 20; ++i) {
            _issue(address(uint160(0x2000 + i)), _defaultTerms());
        }
        uint256 idle = pool.idleAssets();
        assertLt(idle, SEED_LP);

        vm.startPrank(lp);
        pool.requestWithdrawal(pool.balanceOf(lp));
        skip(61);
        vm.expectRevert();
        pool.claimWithdrawal();
        vm.stopPrank();
    }

    /// @dev Pricing at claim time, not request time, is what stops an LP locking in a share
    ///      price and waiting to see whether the next mark went their way.
    function test_withdrawal_isPricedAtClaimTimeNotRequestTime() public {
        (uint256 id, MandateAccount account) = _issue();

        vm.prank(lp);
        pool.requestWithdrawal(1_000_000 * ONE);
        uint256 valueAtRequest = pool.convertToAssets(1_000_000 * ONE);

        // The mandate loses money while the request matures.
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000);
        registry.markAndEnforce(id);

        skip(61);
        vm.prank(lp);
        uint256 got = pool.claimWithdrawal();

        assertLt(got, valueAtRequest, "the LP shared in the loss that happened while queued");
    }

    function test_previewClaim_reportsReadinessAndFunding() public {
        vm.prank(lp);
        pool.requestWithdrawal(1_000 * ONE);

        (uint256 assets, bool ready, bool funded) = pool.previewClaim(lp);
        assertEq(assets, 1_000 * ONE);
        assertFalse(ready, "still inside the delay");
        assertTrue(funded);

        skip(61);
        (,, bool funded2) = pool.previewClaim(lp);
        (, bool ready2,) = pool.previewClaim(lp);
        assertTrue(ready2);
        assertTrue(funded2);
    }

    function test_previewClaim_emptyForNoRequest() public view {
        (uint256 assets, bool ready, bool funded) = pool.previewClaim(lp2);
        assertEq(assets, 0);
        assertFalse(ready);
        assertFalse(funded);
    }

    // ─── allocation ───────────────────────────────────────────────────────────────

    function test_allocate_onlyRegistry() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, stranger));
        pool.allocate(stranger, ONE);
    }

    /// @dev The cap bounds any single trader's blast radius, and is why an LP can reason
    ///      about their downside before depositing.
    function test_allocate_respectsMaxAllocationBps() public {
        Types.Terms memory terms = _defaultTerms();
        terms.allocation = (SEED_LP * 25) / 100; // 25% against the 20% cap
        vm.prank(owner);
        vm.expectRevert();
        registry.issue(trader, terms);

        terms.allocation = (SEED_LP * 19) / 100;
        vm.prank(owner);
        registry.issue(trader, terms); // fits
    }

    function test_allocate_movesIdleWithoutChangingTotal() public {
        uint256 totalBefore = pool.totalAssets();
        _issue();
        assertEq(pool.totalAssets(), totalBefore);
        assertEq(pool.idleAssets(), totalBefore - ALLOC);
        assertEq(pool.utilisationBps(), (ALLOC * 10_000) / totalBefore);
    }

    // ─── how a breach lands on LPs ────────────────────────────────────────────────

    function test_breach_lowersSharePriceForEveryLp() public {
        uint256 priceBefore = pool.pricePerShare();
        (uint256 id, MandateAccount account) = _issue();

        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000);
        registry.markAndEnforce(id);

        assertLt(pool.pricePerShare(), priceBefore, "the loss is socialised, as advertised");
        assertEq(pool.totalAllocated(), 0);
    }

    function test_profitableMandate_raisesSharePrice() public {
        uint256 priceBefore = pool.pricePerShare();
        (uint256 id, MandateAccount account) = _issue();

        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 84_000);
        registry.markAndEnforce(id);

        vm.prank(trader);
        registry.closeMandate(id);

        assertGt(pool.pricePerShare(), priceBefore, "LPs keep their 20% of the profit");
    }

    // ─── admin ────────────────────────────────────────────────────────────────────

    function test_registryCanOnlyBeSetOnce() public {
        vm.prank(owner);
        vm.expectRevert(Errors.AlreadyInitialised.selector);
        pool.setRegistry(stranger);
    }

    function test_withdrawalDelayIsCappedSoItCannotBecomeALockup() public {
        vm.prank(owner);
        vm.expectRevert();
        pool.setWithdrawalDelay(8 days);

        vm.prank(owner);
        pool.setWithdrawalDelay(1 days);
        assertEq(pool.withdrawalDelay(), 1 days);
    }

    function test_maxAllocationBpsIsValidated() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Errors.BpsOutOfRange.selector, uint16(0)));
        pool.setMaxAllocationBps(0);

        vm.prank(owner);
        pool.setMaxAllocationBps(3_000);
        assertEq(pool.maxAllocationBps(), 3_000);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(stranger);
        vm.expectRevert();
        pool.setMaxAllocationBps(3_000);
    }

    function test_shareTokenUsesAssetDecimals() public view {
        assertEq(pool.decimals(), 6);
        assertEq(pool.name(), "Mandate Pool Share");
        assertEq(pool.symbol(), "mAUSD");
    }

    // ─── fuzz ─────────────────────────────────────────────────────────────────────

    /// @dev Deposit then immediately queue and claim the whole position: an LP who does
    ///      nothing in between must not be able to extract more than they put in.
    function testFuzz_roundTripNeverProfits(uint256 amount) public {
        amount = bound(amount, ONE, 1_000_000 * ONE);
        asset.mint(lp2, amount);

        vm.startPrank(lp2);
        asset.approve(address(pool), amount);
        uint256 shares = pool.deposit(amount, lp2);
        pool.requestWithdrawal(shares);
        skip(61);
        uint256 got = pool.claimWithdrawal();
        vm.stopPrank();

        assertLe(got, amount, "a no-op round trip cannot mint value");
        assertApproxEqAbs(got, amount, 2, "and loses at most rounding dust");
    }
}

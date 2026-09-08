// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "../utils/Fixture.sol";
import {DemoIssuer} from "../../src/DemoIssuer.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice The self-serve claim path. This is the only privileged component open to the
///         public, so the tests are mostly about what it *cannot* do.
contract DemoIssuerTest is Fixture {
    DemoIssuer internal issuer;

    address internal tester1 = makeAddr("tester1");
    address internal tester2 = makeAddr("tester2");

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        issuer = new DemoIssuer(owner, address(registry));
        registry.setIssuer(address(issuer), true);
        vm.stopPrank();
    }

    // ─── the happy path ───────────────────────────────────────────────────────────

    function test_anyoneCanClaimOnce() public {
        vm.prank(tester1);
        uint256 id = issuer.claim();

        Types.MandateState memory s = registry.stateOf(id);
        assertEq(s.trader, tester1, "issued to the claimer, not to whoever asked");
        assertEq(uint8(s.status), uint8(Types.Status.Active));
        assertEq(issuer.mandateOf(tester1), id);
        assertEq(issuer.claimsMade(), 1);
    }

    function test_claimedMandateIsImmediatelyTradeable() public {
        vm.prank(tester1);
        uint256 id = issuer.claim();
        MandateAccount account = MandateAccount(registry.stateOf(id).account);

        vm.prank(tester1);
        account.openPosition(BTC, true, 1e18, 0);
        assertGt(account.notional(), 0, "a tester can trade within one transaction of claiming");
    }

    function test_termsMatchWhatIsPublished() public {
        vm.prank(tester1);
        uint256 id = issuer.claim();
        Types.Terms memory t = registry.termsOf(id);

        assertEq(t.allocation, issuer.allocation());
        assertEq(t.maxDrawdownBps, issuer.maxDrawdownBps());
        assertEq(t.dailyLossBps, issuer.dailyLossBps());
        assertEq(t.profitSplitBps, issuer.profitSplitBps());
        assertEq(t.maxPositionBps, issuer.maxPositionBps());
    }

    // ─── what it cannot do ────────────────────────────────────────────────────────

    /// @dev One per address. Otherwise a single tester drains the pool's allocation capacity.
    function test_cannotClaimTwice() public {
        vm.startPrank(tester1);
        issuer.claim();
        vm.expectRevert(abi.encodeWithSelector(DemoIssuer.AlreadyClaimed.selector, tester1));
        issuer.claim();
        vm.stopPrank();
    }

    /// @dev A claimer cannot mint a mandate to an address they do not control, and cannot burn
    ///      someone else's one allocation on their behalf.
    function test_alwaysIssuesToTheCaller() public {
        vm.prank(tester1);
        uint256 id = issuer.claim();
        assertEq(registry.stateOf(id).trader, tester1);
        assertFalse(issuer.hasClaimed(tester2), "claiming does not consume anyone else's turn");
    }

    function test_claimLimitBoundsPoolExposure() public {
        vm.prank(owner);
        issuer.setMaxClaims(2);

        vm.prank(tester1);
        issuer.claim();
        vm.prank(tester2);
        issuer.claim();

        vm.prank(makeAddr("tester3"));
        vm.expectRevert(abi.encodeWithSelector(DemoIssuer.ClaimLimitReached.selector, uint256(2)));
        issuer.claim();
    }

    function test_claimsCanBeClosed() public {
        vm.prank(owner);
        issuer.setOpen(false);

        vm.prank(tester1);
        vm.expectRevert(DemoIssuer.ClaimsClosed.selector);
        issuer.claim();
    }

    /// @dev The kill switch: revoking the issuer role stops it dead, without touching any
    ///      mandate it already issued.
    function test_revokingIssuerRoleDisablesIt() public {
        vm.prank(tester1);
        uint256 existing = issuer.claim();

        vm.prank(owner);
        registry.setIssuer(address(issuer), false);

        vm.prank(tester2);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, address(issuer)));
        issuer.claim();

        assertTrue(registry.isActive(existing), "already-issued mandates are untouched");
    }

    function test_cannotChangeTermsOfAnIssuedMandate() public {
        vm.prank(tester1);
        uint256 id = issuer.claim();
        uint16 before = registry.termsOf(id).maxDrawdownBps;

        vm.prank(owner);
        issuer.setTerms(50_000e6, 2_000, 1_000, 5_000, 20_000, 1 days, 0);

        assertEq(registry.termsOf(id).maxDrawdownBps, before, "issued terms are frozen");
    }

    function test_newTermsApplyToTheNextClaim() public {
        vm.prank(owner);
        issuer.setTerms(50_000e6, 2_000, 1_000, 5_000, 20_000, 1 days, 0);

        vm.prank(tester1);
        uint256 id = issuer.claim();
        assertEq(registry.termsOf(id).allocation, 50_000e6);
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(tester1);
        vm.expectRevert();
        issuer.setOpen(false);
        vm.expectRevert();
        issuer.setMaxClaims(1);
        vm.expectRevert();
        issuer.setTerms(1e6, 1_000, 500, 8_000, 30_000, 1 days, 0);
        vm.stopPrank();
    }

    function test_setTermsRejectsZeroes() public {
        vm.startPrank(owner);
        vm.expectRevert(Errors.ZeroAmount.selector);
        issuer.setTerms(0, 1_000, 500, 8_000, 30_000, 1 days, 0);
        vm.expectRevert(Errors.ZeroAmount.selector);
        issuer.setTerms(1e6, 1_000, 500, 8_000, 30_000, 0, 0);
        vm.stopPrank();
    }

    /// @dev Testers who blow up want another go. That is the behaviour we want out of them.
    function test_ownerCanResetAClaimForAnotherRun() public {
        vm.prank(tester1);
        issuer.claim();

        vm.prank(owner);
        issuer.resetClaim(tester1);

        vm.prank(tester1);
        uint256 second = issuer.claim();
        assertEq(registry.stateOf(second).trader, tester1);
    }

    // ─── the UI's pre-flight check ────────────────────────────────────────────────

    function test_claimStatusExplainsWhyNot() public {
        (bool ok, string memory reason) = issuer.claimStatus(tester1);
        assertTrue(ok);
        assertEq(bytes(reason).length, 0);

        vm.prank(tester1);
        issuer.claim();

        (ok, reason) = issuer.claimStatus(tester1);
        assertFalse(ok);
        assertEq(reason, "This address already claimed a mandate");

        vm.prank(owner);
        issuer.setOpen(false);
        (, reason) = issuer.claimStatus(tester2);
        assertEq(reason, "Claims are closed");
    }

    function test_constructorRejectsZeroRegistry() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new DemoIssuer(owner, address(0));
    }
}

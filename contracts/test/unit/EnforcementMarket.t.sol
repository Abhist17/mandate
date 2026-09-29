// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "../utils/Fixture.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice The enforcement market: whoever enforces a breach is paid for it, out of the
///         capital the enforcement protects.
contract EnforcementMarketTest is Fixture {
    uint256 internal constant BOUNTY = (ALLOC * 25) / 10_000; // default 25 bps

    function _breachable() internal returns (uint256 id, MandateAccount account) {
        (id, account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000); // through the 5% daily floor
    }

    function test_strangerWhoEnforcesIsPaid() public {
        (uint256 id,) = _breachable();
        uint256 before = asset.balanceOf(stranger);

        vm.expectEmit(true, true, false, true, address(registry));
        emit MandateRegistry.EnforcementBountyPaid(id, stranger, BOUNTY);
        vm.prank(stranger);
        registry.markAndEnforce(id);

        assertEq(asset.balanceOf(stranger) - before, BOUNTY, "0.25% of the allocation");
    }

    /// @dev The bounty comes from the capital side. The pool gets back exactly what came
    ///      back from the account, less the bounty; the trader's leg is untouched.
    function test_bountyComesOutOfThePoolsShareNotTheTraders() public {
        uint256 poolBefore = pool.totalAssets();
        (uint256 id,) = _breachable();
        uint256 traderBefore = asset.balanceOf(trader);

        vm.prank(stranger);
        registry.markAndEnforce(id);

        uint256 finalEquity = registry.stateOf(id).lastMarkedEquity;
        assertEq(asset.balanceOf(trader), traderBefore, "a losing trader is paid nothing, bounty or not");
        assertEq(pool.totalAssets(), poolBefore - ALLOC + finalEquity - BOUNTY, "pool bears the bounty");
    }

    function test_traderEnforcingTheirOwnBreachIsNotPaid() public {
        (uint256 id,) = _breachable();
        uint256 before = asset.balanceOf(trader);
        vm.prank(trader);
        registry.markAndEnforce(id);
        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Breached));
        assertEq(asset.balanceOf(trader), before, "nobody earns from their own breach");
    }

    /// @dev Inside the batch's self-call msg.sender is the registry. The bounty — and the
    ///      Breached event's enforcer — must be the batch's real caller.
    function test_batchPaysTheBatchCallerNotTheRegistry() public {
        (uint256 id,) = _breachable();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.recordLogs();
        vm.prank(keeper);
        uint256 breaches = registry.markAndEnforceBatch(ids);

        assertEq(breaches, 1);
        assertEq(asset.balanceOf(keeper), BOUNTY, "keeper paid");
        assertEq(asset.balanceOf(address(registry)), 0, "registry kept nothing");

        bytes32 sig = keccak256("Breached(uint256,uint8,uint256,uint256,address)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                // enforcedBy is indexed: topic 2.
                address by = address(uint160(uint256(logs[i].topics[2])));
                assertEq(by, keeper, "Breached records the real enforcer");
                seen = true;
            }
        }
        assertTrue(seen, "Breached emitted");
    }

    function test_expiryIsAlsoPaid() public {
        (uint256 id,) = _issue();
        _skip(30 days);
        vm.prank(stranger);
        registry.markAndEnforce(id);
        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Expired));
        assertEq(asset.balanceOf(stranger), BOUNTY, "closing an expired mandate is work too");
    }

    function test_healthyMarkPaysNothing() public {
        (uint256 id,) = _issue();
        vm.prank(stranger);
        registry.markAndEnforce(id);
        assertEq(asset.balanceOf(stranger), 0, "a mark that enforces nothing earns nothing");
    }

    function test_ownerCanTuneOrSwitchOff_withinTheCeiling() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.setEnforcementBountyBps(50);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Errors.BpsOutOfRange.selector, uint16(101)));
        registry.setEnforcementBountyBps(101);

        vm.prank(owner);
        registry.setEnforcementBountyBps(0);
        (uint256 id,) = _breachable();
        vm.prank(stranger);
        registry.markAndEnforce(id);
        assertEq(asset.balanceOf(stranger), 0, "switched off");
    }

    // ─── the bounty board ─────────────────────────────────────────────────────────

    function test_previewSaysHealthyIsNotEnforceable() public {
        (uint256 id,) = _issue();
        vm.prank(stranger);
        (bool enforceable,,,, uint256 bounty) = registry.previewEnforce(id);
        assertFalse(enforceable);
        assertEq(bounty, 0);
    }

    function test_previewPredictsTheBreachAndTheBounty() public {
        (uint256 id,) = _breachable();

        vm.prank(stranger);
        (bool enforceable, Types.BreachKind kind, uint256 equity, uint256 floor, uint256 bounty) =
            registry.previewEnforce(id);
        assertTrue(enforceable, "preview sees the breach before anyone marks it");
        assertTrue(kind != Types.BreachKind.None);
        assertLt(equity, floor);
        assertEq(bounty, BOUNTY);

        // And it is right: enforcing now breaches on the rule it named, and pays what it showed.
        vm.prank(stranger);
        assertTrue(registry.markAndEnforce(id));
        assertEq(uint8(registry.stateOf(id).breachKind), uint8(kind), "preview named the rule enforcement used");
        assertEq(asset.balanceOf(stranger), bounty);
    }

    function test_previewShowsTheTraderNoBounty() public {
        (uint256 id,) = _breachable();
        vm.prank(trader);
        (bool enforceable,,,, uint256 bounty) = registry.previewEnforce(id);
        assertTrue(enforceable);
        assertEq(bounty, 0, "the trader would not be paid, so the preview says so");
    }

    function test_previewOfSettledMandateIsInert() public {
        (uint256 id,) = _breachable();
        registry.markAndEnforce(id);
        (bool enforceable,,,, uint256 bounty) = registry.previewEnforce(id);
        assertFalse(enforceable);
        assertEq(bounty, 0);
    }
}

import {Vm} from "forge-std/Vm.sol";

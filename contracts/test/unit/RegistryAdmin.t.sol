// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "../utils/Fixture.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice Registry configuration, access control and the read paths the keeper and frontend
///         depend on.
contract RegistryAdminTest is Fixture {
    // ─── issuers ──────────────────────────────────────────────────────────────────

    function test_issuerCanBeGrantedAndRevoked() public {
        vm.prank(owner);
        registry.setIssuer(stranger, true);
        assertTrue(registry.issuers(stranger));

        vm.prank(stranger);
        registry.issue(trader, _defaultTerms());

        vm.prank(owner);
        registry.setIssuer(stranger, false);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, stranger));
        registry.issue(trader, _defaultTerms());
    }

    function test_setIssuerRejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(Errors.ZeroAddress.selector);
        registry.setIssuer(address(0), true);
    }

    function test_onlyOwnerManagesIssuers() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.setIssuer(stranger, true);
    }

    function test_issueRejectsZeroTrader() public {
        vm.prank(owner);
        vm.expectRevert(Errors.ZeroAddress.selector);
        registry.issue(address(0), _defaultTerms());
    }

    // ─── parameters ───────────────────────────────────────────────────────────────

    function test_preTradeBufferIsConfigurableAndBounded() public {
        vm.prank(owner);
        registry.setPreTradeBufferBps(500);
        assertEq(registry.preTradeBufferBps(), 500);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Errors.SlippageToleranceTooWide.selector, uint16(6_000)));
        registry.setPreTradeBufferBps(6_000);
    }

    /// @dev A wider buffer is a more conservative pre-trade check, so it should reject orders
    ///      a narrower one accepts. Demonstrates the parameter actually does something.
    function test_widerBufferRejectsMoreOrders() public {
        (, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 78_400);

        vm.prank(owner);
        registry.setPreTradeBufferBps(5_000); // 50% assumed adverse move

        vm.prank(trader);
        vm.expectRevert();
        account.openPosition(BTC, true, 1e18, 0);
    }

    function test_maxMarkAgeIsConfigurable() public {
        vm.prank(owner);
        registry.setMaxMarkAge(120);
        assertEq(registry.maxMarkAge(), 120);

        vm.prank(owner);
        vm.expectRevert(Errors.ZeroAmount.selector);
        registry.setMaxMarkAge(0);
    }

    function test_poolCanOnlyBeSetOnce() public {
        vm.prank(owner);
        vm.expectRevert(Errors.AlreadyInitialised.selector);
        registry.setPool(stranger);
    }

    function test_setPoolRejectsZeroAddress() public {
        MandateRegistry fresh = new MandateRegistry(owner, address(venue), address(accountImpl));
        vm.prank(owner);
        vm.expectRevert(Errors.ZeroAddress.selector);
        fresh.setPool(address(0));
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new MandateRegistry(owner, address(0), address(accountImpl));
    }

    // ─── markOne is internal-use only ─────────────────────────────────────────────

    /// @dev markOne exists purely so markAndEnforceBatch can isolate a per-mandate revert.
    ///      Calling it from outside would bypass the batch's reentrancy guard.
    function test_markOneIsOnlyCallableByTheRegistryItself() public {
        (uint256 id,) = _issue();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, stranger));
        registry.markOne(id);
    }

    // ─── views the keeper and UI depend on ────────────────────────────────────────

    function test_headroomReportsDistanceToTheBindingFloor() public {
        (uint256 id,) = _issue();
        (uint256 absolute, uint256 bps) = registry.headroom(id);

        // Fresh mandate: 5% daily floor binds before the 10% trailing floor.
        assertEq(absolute, 5_000 * ONE);
        assertEq(bps, 500);
    }

    function test_headroomShrinksAsEquityFalls() public {
        (uint256 id, MandateAccount account) = _issue();
        (uint256 before,) = registry.headroom(id);

        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 78_000);

        (uint256 after_,) = registry.headroom(id);
        assertLt(after_, before, "the number on the trader's screen moved the right way");
    }

    function test_headroomIsZeroOnceThroughTheFloor() public {
        (uint256 id, MandateAccount account) = _issue();
        vm.prank(trader);
        account.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 74_000);

        (uint256 absolute, uint256 bps) = registry.headroom(id);
        assertEq(absolute, 0);
        assertEq(bps, 0);
    }

    function test_floorOfReportsTheBindingFloor() public {
        (uint256 id,) = _issue();
        (uint256 floor, uint256 lastEquity) = registry.floorOf(id);
        assertEq(floor, 95_000 * ONE, "the tighter daily floor binds");
        assertEq(lastEquity, ALLOC);
    }

    function test_liveEquityPricesThroughTheVenue() public {
        (uint256 id, MandateAccount account) = _issue();
        assertEq(registry.liveEquity(id), ALLOC);

        vm.prank(trader);
        account.openPosition(BTC, true, 1e18, 0);
        _setPrice(BTC, 85_000);
        assertGt(registry.liveEquity(id), ALLOC, "unrealised gain shows up without a mark");
    }

    function test_mandatesOfListsATradersMandates() public {
        _issue();
        _issue();
        uint256[] memory ids = registry.mandatesOf(trader);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
    }

    function test_activeMandatesTracksTheWorkList() public {
        (uint256 a,) = _issue();
        (uint256 b,) = _issue(makeAddr("t2"), _defaultTerms());
        assertEq(registry.activeCount(), 2);

        vm.prank(trader);
        registry.closeMandate(a);

        assertEq(registry.activeCount(), 1);
        assertEq(registry.activeMandates()[0], b, "swap-and-pop kept the survivor");
    }

    /// @dev Removing from the middle of the active set must not corrupt the index mapping.
    function test_activeSetSurvivesOutOfOrderRemoval() public {
        uint256[] memory ids = new uint256[](4);
        address[] memory traders_ = new address[](4);
        for (uint256 i; i < 4; ++i) {
            traders_[i] = address(uint160(0x3000 + i));
            (ids[i],) = _issue(traders_[i], _defaultTerms());
        }

        vm.prank(traders_[1]);
        registry.closeMandate(ids[1]);
        vm.prank(traders_[0]);
        registry.closeMandate(ids[0]);

        assertEq(registry.activeCount(), 2);
        uint256[] memory active = registry.activeMandates();
        for (uint256 i; i < active.length; ++i) {
            assertTrue(active[i] == ids[2] || active[i] == ids[3], "wrong mandate left active");
        }
    }

    function test_positionCapOfMatchesTheTerms() public {
        (uint256 id,) = _issue();
        assertEq(registry.positionCapOf(id), (ALLOC * POS_BPS) / 10_000);
    }

    function test_aggregateActiveEquitySumsLiveMandates() public {
        _issue();
        _issue(makeAddr("t2"), _defaultTerms());
        assertEq(registry.aggregateActiveEquity(), ALLOC * 2);
    }

    function test_isActiveReflectsLifecycle() public {
        (uint256 id,) = _issue();
        assertTrue(registry.isActive(id));
        vm.prank(trader);
        registry.closeMandate(id);
        assertFalse(registry.isActive(id));
    }

    function test_closeUnknownMandateReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownMandate.selector, uint256(42)));
        registry.closeMandate(42);
    }

    function test_ownerMayCloseAMandate() public {
        (uint256 id,) = _issue();
        vm.prank(owner);
        registry.closeMandate(id);
        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Closed));
    }

    function test_mandateIdsIncrementFromOne() public {
        (uint256 first,) = _issue();
        (uint256 second,) = _issue();
        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(registry.nextMandateId(), 3);
    }
}

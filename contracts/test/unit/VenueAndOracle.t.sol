// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "../utils/Fixture.sol";
import {MockPyth} from "../utils/MockPyth.sol";
import {PriceOracle} from "../../src/oracle/PriceOracle.sol";
import {MiniPerp} from "../../src/venue/MiniPerp.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice Venue mechanics and oracle behaviour, including the Pyth backend that Phase 1
///         verified live on Monad testnet.
contract VenueAndOracleTest is Fixture {
    bytes32 constant BTC_FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    address internal punter = makeAddr("punter");

    function _fundPunter(uint256 amount) internal {
        asset.mint(punter, amount);
        vm.startPrank(punter);
        asset.approve(address(venue), type(uint256).max);
        venue.deposit(amount);
        vm.stopPrank();
    }

    // ─── collateral ───────────────────────────────────────────────────────────────

    function test_depositAndWithdraw() public {
        _fundPunter(10_000 * ONE);
        assertEq(venue.freeCollateral(punter), 10_000 * ONE);

        vm.prank(punter);
        venue.withdraw(4_000 * ONE);
        assertEq(venue.freeCollateral(punter), 6_000 * ONE);
        assertEq(asset.balanceOf(punter), 4_000 * ONE);
    }

    function test_withdrawMoreThanFreeReverts() public {
        _fundPunter(1_000 * ONE);
        vm.prank(punter);
        vm.expectRevert(abi.encodeWithSelector(Errors.InsufficientMargin.selector, 2_000 * ONE, 1_000 * ONE));
        venue.withdraw(2_000 * ONE);
    }

    function test_depositRejectsZero() public {
        vm.prank(punter);
        vm.expectRevert(Errors.ZeroAmount.selector);
        venue.deposit(0);
    }

    function test_reserveIsPermissionlessToFund() public {
        uint256 before = venue.reserveContributed();
        asset.mint(punter, 1_000 * ONE);
        vm.startPrank(punter);
        asset.approve(address(venue), type(uint256).max);
        venue.fundReserve(1_000 * ONE);
        vm.stopPrank();
        assertEq(venue.reserveContributed(), before + 1_000 * ONE);
    }

    // ─── opening and closing ──────────────────────────────────────────────────────

    function test_openChargesMarginAndTakerFee() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        uint256 fill = venue.openPosition(BTC, true, 1e18, 0);

        // Fill is worse than mark by half-spread plus impact.
        assertGt(fill, 80_000 * PRICE, "buyer paid up");

        Types.Position memory p = venue.getPosition(punter, BTC);
        assertEq(p.size, 1e18);
        assertTrue(p.isLong);
        assertApproxEqRel(p.margin, 12_000 * ONE, 0.01e18, "15% initial margin on ~80k notional");
        assertLt(venue.freeCollateral(punter), 38_000 * ONE, "margin and fee were debited");
    }

    function test_biggerOrdersGetWorseFills() public {
        uint256 small = venue.previewFill(BTC, 1e17, true);
        uint256 big = venue.previewFill(BTC, 5e18, true);
        assertGt(big, small, "impact is monotonic in size, so size is never free");
    }

    function test_closeReturnsMarginAndProfit() public {
        _fundPunter(50_000 * ONE);
        vm.startPrank(punter);
        venue.openPosition(BTC, true, 1e18, 0);
        vm.stopPrank();

        _setPrice(BTC, 88_000);
        vm.prank(punter);
        int256 pnl = venue.closePosition(BTC, 0);

        assertGt(pnl, 0, "long into a rally");
        assertEq(venue.openMarkets(punter).length, 0);
        assertGt(venue.freeCollateral(punter), 50_000 * ONE, "up on the round trip");
    }

    function test_shortProfitsOnADrop() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        venue.openPosition(BTC, false, 1e18, 0);

        _setPrice(BTC, 72_000);
        vm.prank(punter);
        int256 pnl = venue.closePosition(BTC, 0);
        assertGt(pnl, 0);
    }

    function test_addingToAPositionBlendsTheEntryPrice() public {
        _fundPunter(60_000 * ONE);
        vm.prank(punter);
        venue.openPosition(BTC, true, 1e18, 0);
        uint256 firstEntry = venue.getPosition(punter, BTC).entryPrice;

        _setPrice(BTC, 84_000);
        vm.prank(punter);
        venue.openPosition(BTC, true, 1e18, 0);

        Types.Position memory p = venue.getPosition(punter, BTC);
        assertEq(p.size, 2e18);
        assertGt(p.entryPrice, firstEntry, "blended up");
        assertLt(p.entryPrice, 84_100 * PRICE, "but not all the way to the new price");
    }

    /// @dev Reversing means closing first. Netting a flip inside one call would make the
    ///      position cap ambiguous mid-trade.
    function test_cannotFlipDirectionWithoutClosing() public {
        _fundPunter(60_000 * ONE);
        vm.startPrank(punter);
        venue.openPosition(BTC, true, 1e18, 0);
        vm.expectRevert(abi.encodeWithSelector(Errors.PositionAlreadyOpen.selector, punter, BTC));
        venue.openPosition(BTC, false, 1e18, 0);
        vm.stopPrank();
    }

    function test_closeWithoutPositionReverts() public {
        vm.prank(punter);
        vm.expectRevert(abi.encodeWithSelector(Errors.NoOpenPosition.selector, punter, BTC));
        venue.closePosition(BTC, 0);
    }

    function test_slippageLimitRejectsABadFill() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        vm.expectRevert();
        venue.openPosition(BTC, true, 1e18, 79_000 * PRICE); // limit below the mark
    }

    function test_sizeBelowMinimumReverts() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        vm.expectRevert(abi.encodeWithSelector(Errors.SizeTooSmall.selector, uint256(1e10), uint256(1e14)));
        venue.openPosition(BTC, true, 1e10, 0);
    }

    function test_insufficientMarginReverts() public {
        _fundPunter(100 * ONE);
        vm.prank(punter);
        vm.expectRevert();
        venue.openPosition(BTC, true, 1e18, 0);
    }

    function test_maxOpenPositionsIsBounded() public view {
        // The bound is what makes flatten a single transaction with known worst-case gas.
        assertEq(venue.MAX_OPEN_POSITIONS(), 4);
    }

    // ─── funding ──────────────────────────────────────────────────────────────────

    function test_fundingAccruesAgainstTheLong() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        venue.openPosition(BTC, true, 1e18, 0);

        _skip(3 days); // many funding intervals at a positive rate
        vm.prank(punter);
        int256 pnl = venue.closePosition(BTC, 0);
        assertLt(pnl, 0, "flat price, so the long paid funding and fees");
    }

    function test_fundingRateCanBeUpdated() public {
        vm.prank(owner);
        venue.setFundingRate(BTC, -50);
        assertEq(venue.market(BTC).fundingRateMicros, -50);
    }

    // ─── liquidation ──────────────────────────────────────────────────────────────

    function test_liquidateBelowMaintenanceMargin() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        venue.openPosition(BTC, true, 1e18, 0);

        // 15% initial, 7.5% maintenance: a ~12% drop puts it under.
        _forcePrice(BTC, 69_000);
        vm.prank(stranger); // permissionless, like enforcement
        venue.liquidate(punter, BTC);
        assertEq(venue.openMarkets(punter).length, 0);
    }

    function test_liquidateHealthyPositionReverts() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        venue.openPosition(BTC, true, 1e18, 0);

        vm.prank(stranger);
        vm.expectRevert();
        venue.liquidate(punter, BTC);
    }

    // ─── market admin ─────────────────────────────────────────────────────────────

    function test_unknownMarketReverts() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        vm.expectRevert(abi.encodeWithSelector(Errors.UnknownMarket.selector, uint16(999)));
        venue.openPosition(999, true, 1e18, 0);
    }

    function test_closedMarketRejectsNewOrders() public {
        vm.prank(owner);
        venue.setMarketOpen(BTC, false);

        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        vm.expectRevert(abi.encodeWithSelector(Errors.MarketClosed.selector, BTC));
        venue.openPosition(BTC, true, 1e18, 0);
    }

    function test_cannotListTheSameMarketTwice() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Errors.MarketAlreadyListed.selector, BTC));
        venue.listMarket(BTC, 1_500, 750, 690, 2, 2_000_000 * ONE, 1e14, 20, 2_580);
    }

    /// @dev Maintenance must sit below initial, or a position is liquidatable on open.
    function test_listMarketRejectsMaintenanceAboveInitial() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Errors.BpsOutOfRange.selector, uint16(2_000)));
        venue.listMarket(99, 1_500, 2_000, 690, 2, 2_000_000 * ONE, 1e14, 20, 2_580);
    }

    function test_listedMarketsAreEnumerable() public view {
        assertEq(venue.listedMarketCount(), 2);
        assertEq(venue.listedMarkets(0), BTC);
    }

    function test_onlyOwnerCanListMarkets() public {
        vm.prank(stranger);
        vm.expectRevert();
        venue.listMarket(99, 1_500, 750, 690, 2, 2_000_000 * ONE, 1e14, 20, 2_580);
    }

    function test_flattenIsRestrictedToTheAccountOrAFlattener() public {
        _fundPunter(50_000 * ONE);
        vm.prank(punter);
        venue.openPosition(BTC, true, 1e18, 0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, stranger));
        venue.flatten(punter);

        vm.prank(punter); // an account may always flatten itself
        venue.flatten(punter);
        assertEq(venue.openMarkets(punter).length, 0);
    }

    // ─── oracle: pushed backend ───────────────────────────────────────────────────

    function test_pushBatchSetsEveryMarket() public {
        uint16[] memory ids = new uint16[](2);
        uint256[] memory prices = new uint256[](2);
        ids[0] = BTC;
        ids[1] = ETH;
        prices[0] = 81_000 * PRICE;
        prices[1] = 2_600 * PRICE;

        vm.prank(keeper);
        oracle.pushPrices(ids, prices, uint64(block.timestamp));
        assertEq(_priceOf(BTC), 81_000 * PRICE);
        assertEq(_priceOf(ETH), 2_600 * PRICE);
    }

    function test_pushBatchRejectsMismatchedLengths() public {
        uint16[] memory ids = new uint16[](2);
        uint256[] memory prices = new uint256[](1);
        vm.prank(keeper);
        vm.expectRevert(Errors.ZeroAmount.selector);
        oracle.pushPrices(ids, prices, uint64(block.timestamp));
    }

    function test_pushRejectsZeroPrice() public {
        vm.prank(keeper);
        vm.expectRevert();
        oracle.pushPrice(BTC, 0, uint64(block.timestamp));
    }

    function test_pushRejectsFutureTimestamp() public {
        vm.prank(keeper);
        vm.expectRevert();
        oracle.pushPrice(BTC, 80_000 * PRICE, uint64(block.timestamp + 1));
    }

    function test_pushToUnlistedFeedReverts() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Errors.NoPriceFeed.selector, uint16(777)));
        oracle.pushPrice(777, 1 * PRICE, uint64(block.timestamp));
    }

    function test_isFreshTracksStaleness() public {
        assertTrue(oracle.isFresh(BTC));
        vm.warp(block.timestamp + 301);
        assertFalse(oracle.isFresh(BTC), "past the configured max age");
        assertFalse(oracle.isFresh(777), "unlisted feed is never fresh");
    }

    function test_priceFreshRevertsWhenStale() public {
        vm.warp(block.timestamp + 301);
        vm.expectRevert();
        oracle.priceFresh(BTC);
    }

    function test_configureFeedRejectsAbsurdMaxAge() public {
        vm.prank(owner);
        vm.expectRevert();
        oracle.configureFeed(BTC, false, 2 hours, 2_500); // above MAX_CONFIGURABLE_AGE
    }

    function test_publisherRightsCanBeRevoked() public {
        vm.prank(owner);
        oracle.setPublisher(keeper, false);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Errors.NotAuthorised.selector, keeper));
        oracle.pushPrice(BTC, 80_000 * PRICE, uint64(block.timestamp));
    }

    function test_feedConfigIsReadable() public view {
        PriceOracle.Feed memory f = oracle.feed(BTC);
        assertTrue(f.listed);
        assertFalse(f.usePyth);
        assertEq(f.maxAge, 300);
    }

    // ─── oracle: Pyth backend ─────────────────────────────────────────────────────

    /// @dev Exercises the path against Pyth's real response shape — expo -8, as returned by
    ///      the live contract on Monad testnet during Phase 1.
    function test_pythBackendNormalisesExponent() public {
        MockPyth pyth = new MockPyth();
        pyth.set(BTC_FEED, 7_727_730_500_000, -8, block.timestamp);

        vm.startPrank(owner);
        oracle.setPyth(address(pyth));
        oracle.setPythFeed(BTC, BTC_FEED);
        oracle.configureFeed(BTC, true, 300, 0);
        vm.stopPrank();

        // expo -8 means the raw value is already 1e8-scaled: $77,277.305.
        assertEq(_priceOf(BTC), 7_727_730_500_000, "passes through unchanged at expo -8");
    }

    function test_pythBackendRescalesADifferentExponent() public {
        MockPyth pyth = new MockPyth();
        pyth.set(BTC_FEED, 77_277, 0, block.timestamp); // whole dollars

        vm.startPrank(owner);
        oracle.setPyth(address(pyth));
        oracle.setPythFeed(BTC, BTC_FEED);
        oracle.configureFeed(BTC, true, 300, 0);
        vm.stopPrank();

        assertEq(_priceOf(BTC), 77_277 * PRICE);
    }

    function test_pythBackendRejectsNonPositivePrice() public {
        MockPyth pyth = new MockPyth();
        pyth.set(BTC_FEED, 0, -8, block.timestamp);

        vm.startPrank(owner);
        oracle.setPyth(address(pyth));
        oracle.setPythFeed(BTC, BTC_FEED);
        oracle.configureFeed(BTC, true, 300, 0);
        vm.stopPrank();

        vm.expectRevert();
        oracle.price(BTC);
    }

    /// @dev The reason Pyth is not the default: reading it live during Phase 1 returned a
    ///      price ~15 days old, because nobody had paid to advance it.
    function test_pythStalenessIsCaughtNotIgnored() public {
        MockPyth pyth = new MockPyth();
        pyth.set(BTC_FEED, 7_727_730_500_000, -8, block.timestamp - 15 days);

        vm.startPrank(owner);
        oracle.setPyth(address(pyth));
        oracle.setPythFeed(BTC, BTC_FEED);
        oracle.configureFeed(BTC, true, 300, 0);
        vm.stopPrank();

        assertFalse(oracle.isFresh(BTC));
        vm.expectRevert();
        oracle.priceNoOlderThan(BTC, 300);
    }
}

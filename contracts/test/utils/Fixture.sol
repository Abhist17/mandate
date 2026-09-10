// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {MockERC20} from "./MockERC20.sol";
import {PriceOracle} from "../../src/oracle/PriceOracle.sol";
import {MiniPerp} from "../../src/venue/MiniPerp.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {CapitalPool} from "../../src/CapitalPool.sol";
import {UnderwritingBook} from "../../src/UnderwritingBook.sol";
import {Types} from "../../src/libraries/Types.sol";

/// @notice Full-system fixture. Market parameters mirror Perpl's live Monad testnet config,
///         captured in docs/PHASE1-FINDINGS.md — same markets, comparable margin, the same
///         0.069% taker fee and 2580s funding interval.
contract Fixture is Test {
    uint16 internal constant BTC = 16; // Perpl's real market ids
    uint16 internal constant ETH = 32;

    uint256 internal constant ONE = 1e6; // asset unit (6 decimals)
    uint256 internal constant PRICE = 1e8; // price unit

    // Mandate defaults from SPEC §7: 10% drawdown, 5% daily, 80/20 split, 3x cap.
    uint16 internal constant DD_BPS = 1_000;
    uint16 internal constant DAILY_BPS = 500;
    uint16 internal constant SPLIT_BPS = 8_000;
    uint16 internal constant POS_BPS = 30_000;

    uint256 internal constant ALLOC = 100_000 * ONE;
    uint256 internal constant SEED_LP = 10_000_000 * ONE;
    /// @dev MiniPerp has no order book, so winning positions are paid from a reserve. See
    ///      {MiniPerp-reserveContributed}.
    uint256 internal constant VENUE_RESERVE = 5_000_000 * ONE;

    /// @dev A clean UTC-midnight-anchored start so day-rollover tests are unambiguous.
    uint64 internal constant T0 = 1_699_920_000; // 2023-11-14 00:00:00 UTC

    MockERC20 internal asset;
    PriceOracle internal oracle;
    MiniPerp internal venue;
    MandateAccount internal accountImpl;
    MandateRegistry internal registry;
    CapitalPool internal pool;
    UnderwritingBook internal book;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal lp = makeAddr("lp");
    address internal lp2 = makeAddr("lp2");
    address internal trader = makeAddr("trader");
    address internal stranger = makeAddr("stranger");
    address internal backstop;

    function setUp() public virtual {
        vm.warp(T0);

        asset = new MockERC20("Mandate AUSD", "AUSD", 6);

        vm.startPrank(owner);
        oracle = new PriceOracle(owner, address(0));
        venue = new MiniPerp(owner, address(asset), address(oracle));
        accountImpl = new MandateAccount();
        registry = new MandateRegistry(owner, address(venue), address(accountImpl));
        pool = new CapitalPool(owner, address(asset), "Mandate Pool Share", "mAUSD");

        book = new UnderwritingBook(address(registry), address(asset));

        registry.setPool(address(pool));
        pool.setRegistry(address(registry));
        venue.setFlattener(address(registry), true);

        oracle.setPublisher(keeper, true);
        oracle.configureFeed(BTC, false, 300, 2_500);
        oracle.configureFeed(ETH, false, 300, 2_500);

        // Perpl BTC: 15% initial margin, 0.069% taker, 2580s funding interval.
        venue.listMarket(BTC, 1_500, 750, 690, 2, 2_000_000 * ONE, 1e14, 20, 2_580);
        venue.listMarket(ETH, 1_200, 600, 690, 2, 1_000_000 * ONE, 1e15, 20, 2_580);
        vm.stopPrank();

        _setPrice(BTC, 80_000);
        _setPrice(ETH, 2_500);

        // Back the venue so a profitable mandate can actually be paid out.
        backstop = makeAddr("backstop");
        asset.mint(backstop, VENUE_RESERVE);
        vm.startPrank(backstop);
        asset.approve(address(venue), VENUE_RESERVE);
        venue.fundReserve(VENUE_RESERVE);
        vm.stopPrank();

        // Seed the LP and fund the pool.
        asset.mint(lp, SEED_LP);
        asset.mint(lp2, SEED_LP);
        vm.startPrank(lp);
        asset.approve(address(pool), type(uint256).max);
        pool.deposit(SEED_LP, lp);
        vm.stopPrank();
    }

    // ─── helpers ──────────────────────────────────────────────────────────────────

    function _setPrice(uint16 marketId, uint256 usd) internal {
        vm.prank(keeper);
        oracle.pushPrice(marketId, usd * PRICE, uint64(block.timestamp));
    }

    /// @dev Push a price that may exceed the deviation guard (used to simulate a gap).
    function _forcePrice(uint16 marketId, uint256 usd) internal {
        vm.prank(owner);
        oracle.forcePrice(marketId, usd * PRICE, uint64(block.timestamp));
    }

    function _defaultTerms() internal view returns (Types.Terms memory) {
        return Types.Terms({
            allocation: ALLOC,
            maxDrawdownBps: DD_BPS,
            dailyLossBps: DAILY_BPS,
            profitSplitBps: SPLIT_BPS,
            maxPositionBps: POS_BPS,
            expiry: uint64(block.timestamp) + 30 days,
            resetHourUtc: 0,
            // Trailing (not until-breakeven) keeps the existing suite's expectations intact:
            // these tests were written against a floor that follows the peak up forever.
            drawdownMode: Types.DrawdownMode.Trailing,
            maxConsistencyBps: 0,
            minProfitableDays: 0,
            payoutCushionBps: 0,
            touchIsBreach: false
        });
    }

    function _issue() internal returns (uint256 mandateId, MandateAccount account) {
        return _issue(trader, _defaultTerms());
    }

    function _issue(address who, Types.Terms memory terms)
        internal
        returns (uint256 mandateId, MandateAccount account)
    {
        vm.prank(owner);
        mandateId = registry.issue(who, terms);
        account = MandateAccount(registry.stateOf(mandateId).account);
    }

    /// @dev Advance time and keep every feed fresh, the way the keeper would.
    function _skip(uint256 secs) internal {
        uint256 btcPrice = _priceOf(BTC);
        uint256 ethPrice = _priceOf(ETH);
        vm.warp(block.timestamp + secs);
        vm.startPrank(keeper);
        oracle.pushPrice(BTC, btcPrice, uint64(block.timestamp));
        oracle.pushPrice(ETH, ethPrice, uint64(block.timestamp));
        vm.stopPrank();
    }

    function _priceOf(uint16 marketId) internal view returns (uint256 p) {
        (p,) = oracle.price(marketId);
    }
}

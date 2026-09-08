// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle, IPyth} from "../interfaces/IPriceOracle.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title PriceOracle
/// @author Mandate
/// @notice Prices for marking mandates, from either a pushed feed or Pyth.
///
/// @dev Two backends behind one interface, because neither alone is right for this system:
///
///      1. **Pushed (default).** A permissioned publisher writes Perpl's live oracle price
///         for each market. Perpl's `/api/v1/pub/context` is public and unauthenticated and
///         reports a per-market oracle price (`orl`), refreshed continuously. Since MiniPerp
///         mirrors Perpl's market configuration, marking against Perpl's own oracle is the
///         consistent choice — and it costs one cheap write per block rather than a paid
///         update.
///
///      2. **Pyth.** Verified live on Monad testnet at
///         `0x2880aB155794e7179c9eE2e38200202908C17B43`. Wired and usable per market, but not
///         the default: Pyth is a *pull* oracle, so its onchain price only advances when
///         somebody pays to submit a Hermes update. Reading it during Phase 1 returned a
///         price ~15 days stale. Paying to advance it every block is the wrong shape for a
///         per-block risk loop.
///
///      Both paths enforce the same staleness bound, and every settlement path calls
///      {priceNoOlderThan} rather than {price}. Marking a mandate against a stale price is
///      how a risk engine liquidates someone for a move that never happened.
contract PriceOracle is IPriceOracle, Ownable {
    /// @notice Prices are USD scaled 1e8.
    uint256 public constant PRICE_SCALE = 1e8;

    /// @notice Hard ceiling on any configured staleness bound.
    /// @dev A feed permitted to be an hour old is not a risk oracle.
    uint64 public constant MAX_CONFIGURABLE_AGE = 1 hours;

    struct Feed {
        bool listed;
        bool usePyth;
        uint256 price; // 1e8, pushed backend
        uint64 publishedAt; // source timestamp, pushed backend
        uint64 maxAge; // staleness bound, seconds
        uint16 maxDeviationBps; // per-push move guard, 0 disables
        bytes32 pythFeedId;
    }

    mapping(uint16 marketId => Feed) internal _feeds;

    /// @notice Addresses allowed to push prices. The keeper holds one.
    mapping(address => bool) public publishers;

    IPyth public pyth;

    event FeedConfigured(uint16 indexed marketId, bool usePyth, uint64 maxAge, uint16 maxDeviationBps);
    event PythFeedSet(uint16 indexed marketId, bytes32 feedId);
    event PublisherSet(address indexed publisher, bool allowed);
    event PythSet(address indexed pyth);
    event PricePushed(uint16 indexed marketId, uint256 price, uint64 publishedAt, address indexed publisher);

    modifier onlyPublisher() {
        if (!publishers[msg.sender]) revert Errors.NotAuthorised(msg.sender);
        _;
    }

    constructor(address owner_, address pyth_) Ownable(owner_) {
        pyth = IPyth(pyth_); // may be address(0) if only the pushed backend is used
        publishers[owner_] = true;
        emit PublisherSet(owner_, true);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Configuration
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice List or reconfigure a market's feed.
    /// @param marketId Venue market id.
    /// @param usePyth Read from Pyth instead of the pushed price.
    /// @param maxAge Staleness bound in seconds, capped at {MAX_CONFIGURABLE_AGE}.
    /// @param maxDeviationBps Reject a push that moves the price more than this from the
    ///        previous one. 0 disables. See {pushPrice} for the trade-off this carries.
    function configureFeed(uint16 marketId, bool usePyth, uint64 maxAge, uint16 maxDeviationBps)
        external
        onlyOwner
    {
        if (maxAge == 0 || maxAge > MAX_CONFIGURABLE_AGE) revert Errors.StalePrice(marketId, 0, maxAge);
        Feed storage f = _feeds[marketId];
        f.listed = true;
        f.usePyth = usePyth;
        f.maxAge = maxAge;
        f.maxDeviationBps = maxDeviationBps;
        emit FeedConfigured(marketId, usePyth, maxAge, maxDeviationBps);
    }

    /// @notice Point a market at a Pyth price feed id.
    function setPythFeed(uint16 marketId, bytes32 feedId) external onlyOwner {
        _feeds[marketId].pythFeedId = feedId;
        emit PythFeedSet(marketId, feedId);
    }

    /// @notice Grant or revoke price-pushing rights.
    function setPublisher(address publisher, bool allowed) external onlyOwner {
        if (publisher == address(0)) revert Errors.ZeroAddress();
        publishers[publisher] = allowed;
        emit PublisherSet(publisher, allowed);
    }

    /// @notice Repoint the Pyth contract.
    function setPyth(address pyth_) external onlyOwner {
        pyth = IPyth(pyth_);
        emit PythSet(pyth_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Pushing
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Push one price.
    ///
    /// @dev The deviation guard is a genuine trade-off and is worth stating plainly rather
    ///      than presenting as free safety. It protects against a compromised or malfunctioning
    ///      publisher printing an absurd price and liquidating every open mandate. It also
    ///      means that in a real gap larger than the bound, pushes revert and marking stalls
    ///      until the owner widens it — during exactly the move where marking matters most.
    ///
    ///      We take the bound generous (25% by default) so ordinary volatility never trips it,
    ///      and accept that a single-tick move beyond that needs an owner action. A hard
    ///      circuit breaker on a risk oracle is the more dangerous of the two failures.
    ///
    /// @param marketId Market to price.
    /// @param newPrice USD price scaled 1e8.
    /// @param publishedAt Source timestamp. Must not be in the future.
    function pushPrice(uint16 marketId, uint256 newPrice, uint64 publishedAt) public onlyPublisher {
        Feed storage f = _feeds[marketId];
        if (!f.listed) revert Errors.NoPriceFeed(marketId);
        if (newPrice == 0) revert Errors.InvalidPrice(int256(newPrice));
        if (publishedAt > block.timestamp) revert Errors.InvalidPrice(int256(uint256(publishedAt)));

        uint256 previous = f.price;
        if (previous != 0 && f.maxDeviationBps != 0) {
            uint256 diff = newPrice > previous ? newPrice - previous : previous - newPrice;
            if ((diff * 10_000) / previous > f.maxDeviationBps) {
                revert Errors.PriceDeviationTooLarge(previous, newPrice, f.maxDeviationBps);
            }
        }

        f.price = newPrice;
        f.publishedAt = publishedAt;
        emit PricePushed(marketId, newPrice, publishedAt, msg.sender);
    }

    /// @notice Push many prices in one transaction.
    /// @dev The keeper marks every market each block. Batching is what makes the per-block
    ///      loop cheap enough to be worth running, which is the whole Monad argument.
    function pushPrices(uint16[] calldata marketIds, uint256[] calldata prices, uint64 publishedAt)
        external
        onlyPublisher
    {
        uint256 n = marketIds.length;
        if (n != prices.length) revert Errors.ZeroAmount();
        for (uint256 i; i < n; ++i) {
            pushPrice(marketIds[i], prices[i], publishedAt);
        }
    }

    /// @notice Owner-only push that bypasses the deviation guard.
    /// @dev The documented escape hatch for a genuine gap larger than `maxDeviationBps`.
    function forcePrice(uint16 marketId, uint256 newPrice, uint64 publishedAt) external onlyOwner {
        Feed storage f = _feeds[marketId];
        if (!f.listed) revert Errors.NoPriceFeed(marketId);
        if (newPrice == 0) revert Errors.InvalidPrice(int256(newPrice));
        f.price = newPrice;
        f.publishedAt = publishedAt;
        emit PricePushed(marketId, newPrice, publishedAt, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Reading
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IPriceOracle
    function price(uint16 marketId) public view returns (uint256, uint64) {
        Feed storage f = _feeds[marketId];
        if (!f.listed) revert Errors.NoPriceFeed(marketId);

        if (f.usePyth) {
            IPyth.Price memory p = pyth.getPriceUnsafe(f.pythFeedId);
            return (_normalisePyth(p), uint64(p.publishTime));
        }
        if (f.price == 0) revert Errors.NoPriceFeed(marketId);
        return (f.price, f.publishedAt);
    }

    /// @inheritdoc IPriceOracle
    function priceNoOlderThan(uint16 marketId, uint64 maxAge) public view returns (uint256) {
        (uint256 p, uint64 at) = price(marketId);
        if (block.timestamp > at + maxAge) revert Errors.StalePrice(marketId, at, maxAge);
        return p;
    }

    /// @notice Latest price, bounded by the feed's own configured staleness limit.
    function priceFresh(uint16 marketId) external view returns (uint256) {
        return priceNoOlderThan(marketId, _feeds[marketId].maxAge);
    }

    /// @inheritdoc IPriceOracle
    function isFresh(uint16 marketId) external view returns (bool) {
        Feed storage f = _feeds[marketId];
        if (!f.listed) return false;
        (bool okCall, bytes memory data) =
            address(this).staticcall(abi.encodeWithSelector(this.price.selector, marketId));
        if (!okCall) return false;
        (, uint64 at) = abi.decode(data, (uint256, uint64));
        return block.timestamp <= at + f.maxAge;
    }

    /// @notice Read a market's feed configuration.
    function feed(uint16 marketId) external view returns (Feed memory) {
        return _feeds[marketId];
    }

    /// @dev Pyth prices carry their own exponent. Rescale to 1e8 and reject non-positive.
    function _normalisePyth(IPyth.Price memory p) internal pure returns (uint256) {
        if (p.price <= 0) revert Errors.InvalidPrice(p.price);
        uint256 raw = uint256(uint64(p.price));
        // expo is negative in practice (e.g. -8 means price is scaled 1e8 already).
        int32 target = -8;
        if (p.expo == target) return raw;
        if (p.expo < target) {
            return raw / (10 ** uint32(target - p.expo));
        }
        return raw * (10 ** uint32(p.expo - target));
    }
}

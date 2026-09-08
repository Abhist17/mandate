// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IPriceOracle
/// @notice Price source for marking mandates. All prices are USD, scaled 1e8.
interface IPriceOracle {
    /// @notice Latest price for a market.
    /// @param marketId Venue market id.
    /// @return price USD price scaled 1e8.
    /// @return publishedAt Unix seconds the price was observed at source.
    function price(uint16 marketId) external view returns (uint256 price, uint64 publishedAt);

    /// @notice Latest price, reverting if older than `maxAge` seconds.
    /// @dev Every settlement path uses this rather than {price}. Marking a mandate against a
    ///      stale price is how a risk engine liquidates someone for a move that never happened.
    function priceNoOlderThan(uint16 marketId, uint64 maxAge) external view returns (uint256);

    /// @notice Whether a market has a usable, non-stale price right now.
    function isFresh(uint16 marketId) external view returns (bool);
}

/// @notice Minimal slice of Pyth's EVM interface.
/// @dev Verified live on Monad testnet at 0x2880aB155794e7179c9eE2e38200202908C17B43.
///      See docs/PHASE1-FINDINGS.md §4.
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory);
}

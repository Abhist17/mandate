// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPyth} from "../../src/interfaces/IPriceOracle.sol";

/// @notice Stands in for Pyth at 0x2880aB155794e7179c9eE2e38200202908C17B43 on Monad testnet,
///         whose live behaviour is recorded in docs/PHASE1-FINDINGS.md §4.
contract MockPyth is IPyth {
    mapping(bytes32 => Price) internal _prices;

    function set(bytes32 id, int64 price, int32 expo, uint256 publishTime) external {
        _prices[id] = Price({price: price, conf: 0, expo: expo, publishTime: publishTime});
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory) {
        return _prices[id];
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (Price memory) {
        Price memory p = _prices[id];
        require(block.timestamp <= p.publishTime + age, "stale");
        return p;
    }
}

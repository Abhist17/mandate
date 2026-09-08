// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Types} from "../libraries/Types.sol";

/// @title IPerpVenue
/// @notice The surface `MandateAccount` and `MandateRegistry` need from a perp venue.
///
/// @dev Deliberately small, and deliberately *onchain*. The one operation the whole protocol
///      depends on is {flatten}: a call that closes every position an account holds, in one
///      transaction, callable by the registry during enforcement.
///
///      This is exactly the interface Perpl cannot satisfy. Perpl orders are Ed25519-signed
///      over an authenticated WebSocket and it does not support EIP-1271 contract signatures,
///      so no contract can close a Perpl position. Routing enforcement through an off-chain
///      keyholder would reintroduce the trusted private risk server that Mandate exists to
///      remove. Hence MiniPerp. See docs/PHASE1-FINDINGS.md §2.
interface IPerpVenue {
    /// @notice Credit free collateral to an account. Pulls `amount` of the venue asset.
    function deposit(uint256 amount) external;

    /// @notice Withdraw free collateral. Reverts if it would undercollateralise a position.
    function withdraw(uint256 amount) external;

    /// @notice Open or add to a position.
    /// @param marketId Market to trade.
    /// @param isLong Direction.
    /// @param size Base units, 1e18.
    /// @param limitPrice Worst acceptable fill, 1e8. 0 disables the check.
    /// @return fillPrice Executed price, 1e8.
    function openPosition(uint16 marketId, bool isLong, uint256 size, uint256 limitPrice)
        external
        returns (uint256 fillPrice);

    /// @notice Fully close one position.
    /// @return realisedPnl Signed PnL net of fees and funding, in asset units.
    function closePosition(uint16 marketId, uint256 limitPrice) external returns (int256 realisedPnl);

    /// @notice Close every position `account` holds, ignoring slippage limits.
    /// @dev Called by the registry during breach enforcement. Slippage limits are ignored on
    ///      purpose: a breach must always be enforceable, and a limit price that blocks the
    ///      close would let a trader hold a losing position past their own drawdown cap.
    /// @return realisedPnl Total signed PnL booked by the flatten.
    function flatten(address account) external returns (int256 realisedPnl);

    /// @notice Total account value: free collateral plus margin plus unrealised PnL.
    function accountEquity(address account) external view returns (uint256);

    /// @notice Sum of open notional across all of an account's positions, in asset units.
    function totalNotional(address account) external view returns (uint256);

    /// @notice Notional an order would add, priced at the current oracle price.
    function quoteNotional(uint16 marketId, uint256 size) external view returns (uint256);

    /// @notice Unrealised PnL across all positions, signed, net of accrued funding.
    function unrealisedPnl(address account) external view returns (int256);

    /// @notice One position.
    function getPosition(address account, uint16 marketId) external view returns (Types.Position memory);

    /// @notice Markets in which `account` currently holds a position.
    function openMarkets(address account) external view returns (uint16[] memory);

    /// @notice Free (unlocked) collateral.
    function freeCollateral(address account) external view returns (uint256);

    /// @notice The ERC-20 the venue settles in.
    function asset() external view returns (address);
}

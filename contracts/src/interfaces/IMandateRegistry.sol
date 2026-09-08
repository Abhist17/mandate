// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Types} from "../libraries/Types.sol";

/// @title IMandateRegistry
/// @notice What a MandateAccount and the CapitalPool need from the registry.
interface IMandateRegistry {
    function termsOf(uint256 mandateId) external view returns (Types.Terms memory);
    function stateOf(uint256 mandateId) external view returns (Types.MandateState memory);

    /// @notice Current floor a mandate must stay above, and its last marked equity.
    function floorOf(uint256 mandateId) external view returns (uint256 effectiveFloor, uint256 lastEquity);

    /// @notice Sum of last-marked equity across every Active mandate.
    /// @dev The pool's share price depends on this. See {CapitalPool-totalAssets}.
    function aggregateActiveEquity() external view returns (uint256);

    function isActive(uint256 mandateId) external view returns (bool);

    /// @notice Adverse move, in bps of new notional, that a pre-trade check assumes.
    /// @dev A stated, configurable parameter rather than a constant buried in the account.
    function preTradeBufferBps() external view returns (uint16);
}

/// @title ICapitalPool
interface ICapitalPool {
    /// @notice Move `amount` of idle capital to `to`. Registry only.
    function allocate(address to, uint256 amount) external;

    /// @notice Book the pool's leg of a settled mandate. Registry only.
    /// @dev The registry transfers the assets in first, then calls this to update accounting.
    function onMandateSettled(uint256 mandateId, uint256 allocation, uint256 poolReturn) external;

    function asset() external view returns (address);
    function totalAllocated() external view returns (uint256);
    function idleAssets() external view returns (uint256);
}

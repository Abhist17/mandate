// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IMandateRegistry} from "./interfaces/IMandateRegistry.sol";
import {Types} from "./libraries/Types.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title DemoIssuer
/// @author Mandate
/// @notice Lets anyone claim one testnet mandate for themselves, without asking us.
///
/// @dev **Why this exists.** Issuance on {MandateRegistry} is permissioned, because issuing a
///      mandate commits LP capital and that is not a decision to hand to an anonymous caller.
///      That is the right design for a real deployment and the wrong one for a testnet whose
///      whole purpose is getting strangers to try breaking it — "message me for an
///      allocation" is a funnel with a person in it, and people are the slow part.
///
///      So this contract holds the issuer role and hands out one mandate per address on fixed,
///      published terms. It is the *only* privileged component that is open to the public, and
///      it is deliberately the least powerful one: it cannot change terms, cannot touch an
///      existing mandate, cannot move funds, and can be revoked by removing its issuer role.
///
///      **This is a testnet convenience and should not be deployed to mainnet.** Said plainly
///      here rather than in a doc nobody reads.
contract DemoIssuer is Ownable, ReentrancyGuard {
    IMandateRegistry public immutable registry;

    /// @notice The models a tester can claim.
    ///
    /// @dev Modelled on the account types that actually exist, so a tester can feel the
    ///      difference between them rather than read about it. Sourced from FundingPips'
    ///      published 2026 rulebook — see docs/RESEARCH.md §2.
    ///
    ///      The three differ in the ways that matter and in no others: how the floor behaves,
    ///      how tight the daily limit is, what the split is, and whether a consistency rule
    ///      gates the payout. Running the same trades under `Zero` and under `Evaluation` is
    ///      the fastest way to understand why traders argue about drawdown type.
    enum Preset {
        /// @dev Instant-funded. 5% floor that trails up then locks at the starting size, 3%
        ///      daily, 95% split — and a 15% consistency rule, the strictest of the three.
        ///      Best terms, hardest payout.
        Zero,
        /// @dev Two-step style. 10% STATIC floor, so profit is yours to give back, 5% daily,
        ///      80% split, 35% consistency.
        Evaluation,
        /// @dev Pro style. 6% static floor, 3% daily, 80% split, no consistency rule at all.
        ///      Tightest risk, cleanest payout.
        Pro
    }

    /// @notice Terms every claimed mandate is issued on. Published, fixed, and identical for
    ///         everyone — a tester can read them here before claiming.
    uint256 public allocation = 100_000e6; // 100k, 6-decimal asset
    uint16 public maxDrawdownBps = 1_000; // 10% trailing
    uint16 public dailyLossBps = 500; // 5% daily
    uint16 public profitSplitBps = 8_000; // 80/20 to the trader
    uint16 public maxPositionBps = 30_000; // 3x
    uint64 public duration = 7 days;
    uint8 public resetHourUtc = 0;
    /// @dev Trailing-until-breakeven by default: the fairest of the three modes, and the one
    ///      FundingPips Zero uses. See {Types-DrawdownMode}.
    Types.DrawdownMode public drawdownMode = Types.DrawdownMode.TrailingUntilBreakeven;
    uint16 public maxConsistencyBps = 3_500; // 35% — the 2-Step On-Demand threshold
    uint16 public minProfitableDays = 0; // no minimum on a 7-day testnet mandate
    uint16 public payoutCushionBps = 0;
    bool public touchIsBreach = false;

    /// @notice Total mandates this contract may hand out. Bounds the pool capital it can
    ///         commit even if the issuer role is left on and forgotten.
    uint256 public maxClaims = 100;
    uint256 public claimsMade;

    /// @notice Whether an address has already claimed.
    mapping(address => bool) public hasClaimed;
    /// @notice The mandate an address was issued, for the UI to route to.
    mapping(address => uint256) public mandateOf;

    bool public open = true;

    error AlreadyClaimed(address who);
    error ClaimsClosed();
    error ClaimLimitReached(uint256 limit);

    event Claimed(address indexed trader, uint256 indexed mandateId, uint256 allocation);
    event ClaimedPreset(address indexed trader, uint256 indexed mandateId, Preset preset);
    event TermsUpdated(uint256 allocation, uint16 maxDrawdownBps, uint16 dailyLossBps, uint16 profitSplitBps);
    event OpenSet(bool open);
    event MaxClaimsSet(uint256 maxClaims);

    constructor(address owner_, address registry_) Ownable(owner_) {
        if (registry_ == address(0)) revert Errors.ZeroAddress();
        registry = IMandateRegistry(registry_);
    }

    /// @notice Claim a mandate on the owner-configured terms. One per address.
    /// @dev Issued to `msg.sender`, so a claimer cannot mint mandates to addresses they do not
    ///      control, and cannot claim on someone else's behalf to burn their one allocation.
    /// @return mandateId The new mandate.
    function claim() external nonReentrant returns (uint256 mandateId) {
        return _claim(
            Types.Terms({
                allocation: allocation,
                maxDrawdownBps: maxDrawdownBps,
                dailyLossBps: dailyLossBps,
                profitSplitBps: profitSplitBps,
                maxPositionBps: maxPositionBps,
                expiry: uint64(block.timestamp) + duration,
                resetHourUtc: resetHourUtc,
                drawdownMode: drawdownMode,
                maxConsistencyBps: maxConsistencyBps,
                minProfitableDays: minProfitableDays,
                payoutCushionBps: payoutCushionBps,
                touchIsBreach: touchIsBreach
            })
        );
    }

    /// @notice Claim a mandate on one of the published {Preset} models.
    /// @dev Same one-per-address rule as {claim}. The preset is resolved onchain from
    ///      {presetTerms}, so what a tester picks in the UI is what the registry receives.
    function claimPreset(Preset preset) external nonReentrant returns (uint256 mandateId) {
        mandateId = _claim(presetTerms(preset));
        emit ClaimedPreset(msg.sender, mandateId, preset);
    }

    /// @notice The exact terms a preset issues. Readable before claiming.
    /// @dev A pure function of the enum, so the UI cannot show one thing and the chain do
    ///      another — the terms panel and the issued mandate are the same object.
    function presetTerms(Preset preset) public view returns (Types.Terms memory t) {
        t.allocation = allocation;
        t.maxPositionBps = maxPositionBps;
        t.expiry = uint64(block.timestamp) + duration;
        t.resetHourUtc = resetHourUtc;
        t.touchIsBreach = false;

        if (preset == Preset.Zero) {
            t.maxDrawdownBps = 500; // 5%
            t.dailyLossBps = 300; // 3%
            t.profitSplitBps = 9_500; // 95%
            t.drawdownMode = Types.DrawdownMode.TrailingUntilBreakeven;
            t.maxConsistencyBps = 1_500; // 15% — the strict one
        } else if (preset == Preset.Evaluation) {
            t.maxDrawdownBps = 1_000; // 10%
            t.dailyLossBps = 500; // 5%
            t.profitSplitBps = 8_000; // 80%
            t.drawdownMode = Types.DrawdownMode.Static;
            t.maxConsistencyBps = 3_500; // 35%
        } else {
            t.maxDrawdownBps = 600; // 6%
            t.dailyLossBps = 300; // 3%
            t.profitSplitBps = 8_000; // 80%
            t.drawdownMode = Types.DrawdownMode.Static;
            t.maxConsistencyBps = 0; // no consistency rule
        }
    }

    function _claim(Types.Terms memory t) internal returns (uint256 mandateId) {
        if (!open) revert ClaimsClosed();
        if (hasClaimed[msg.sender]) revert AlreadyClaimed(msg.sender);
        if (claimsMade >= maxClaims) revert ClaimLimitReached(maxClaims);

        hasClaimed[msg.sender] = true;
        claimsMade += 1;

        mandateId = registry.issue(msg.sender, t);
        mandateOf[msg.sender] = mandateId;
        emit Claimed(msg.sender, mandateId, t.allocation);
    }

    /// @notice Whether `who` can claim right now, and why not if they cannot.
    /// @dev The UI reads this so it can disable the button with a reason instead of letting a
    ///      tester discover the answer by paying gas for a revert.
    function claimStatus(address who) external view returns (bool claimable, string memory reason) {
        if (!open) return (false, "Claims are closed");
        if (hasClaimed[who]) return (false, "This address already claimed a mandate");
        if (claimsMade >= maxClaims) return (false, "All demo mandates have been claimed");
        return (true, "");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────────────────────────────────────

    function setOpen(bool open_) external onlyOwner {
        open = open_;
        emit OpenSet(open_);
    }

    function setMaxClaims(uint256 maxClaims_) external onlyOwner {
        maxClaims = maxClaims_;
        emit MaxClaimsSet(maxClaims_);
    }

    /// @notice Update the terms future claims are issued on.
    /// @dev Deliberately cannot touch an already-issued mandate — {MandateRegistry} has no
    ///      function to change terms, by design. This only affects the next claim.
    function setTerms(
        uint256 allocation_,
        uint16 maxDrawdownBps_,
        uint16 dailyLossBps_,
        uint16 profitSplitBps_,
        uint16 maxPositionBps_,
        uint64 duration_,
        uint8 resetHourUtc_
    ) external onlyOwner {
        if (allocation_ == 0 || duration_ == 0) revert Errors.ZeroAmount();
        allocation = allocation_;
        maxDrawdownBps = maxDrawdownBps_;
        dailyLossBps = dailyLossBps_;
        profitSplitBps = profitSplitBps_;
        maxPositionBps = maxPositionBps_;
        duration = duration_;
        resetHourUtc = resetHourUtc_;
        emit TermsUpdated(allocation_, maxDrawdownBps_, dailyLossBps_, profitSplitBps_);
    }

    /// @notice Let an address claim again. For testers who want a second run after a breach.
    function resetClaim(address who) external onlyOwner {
        hasClaimed[who] = false;
    }
}

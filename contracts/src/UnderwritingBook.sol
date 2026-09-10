// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMandateRegistry} from "./interfaces/IMandateRegistry.sol";
import {Types} from "./libraries/Types.sol";
import {RiskEngine} from "./libraries/RiskEngine.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title UnderwritingBook
/// @author Mandate
/// @notice A market where capital competes to fund traders, priced on a verifiable record.
///
/// @dev **The thing this replaces.** A prop firm publishes one menu — 10% drawdown, 80/20,
///      pay us $500 to try — and every trader takes it or leaves. Terms are not priced, they
///      are announced. Worse, the firm's revenue comes partly from challenge fees, so it
///      earns when traders fail, and a trader who proves themselves at one firm starts from
///      zero at the next because their record does not travel.
///
///      **What replaces it.** An LP posts an offer: capital, terms, and the record a trader
///      must have to take it — "no breaches, at least three settled mandates, best
///      consistency under 20%: $50,000 at 90/10". Any trader who meets it claims it. Nobody
///      approves anything. Two LPs who want the same trader compete by improving their terms.
///
///      There are no challenge fees here and no firm. Nobody earns anything when a trader
///      fails; the backer simply loses money, which is the correct incentive and the opposite
///      of the incumbent one.
///
///      **Why this could not be built before.** The whole mechanism rests on a record a
///      stranger can trust without trusting its author. That record exists here because
///      {MandateRegistry} *enforced* the rules it reports on and wrote the outcome itself —
///      it is a primary record, not an attestation. On a platform where enforcement happens
///      on a private server, a track record is a claim, and a market cannot price a claim.
contract UnderwritingBook is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IMandateRegistry public immutable registry;
    IERC20 public immutable assetToken;

    /// @notice What a trader's record must show to claim an offer.
    /// @dev Every field is a floor except `maxBreaches` and `maxConsistencyBps`. A zero means
    ///      "don't care", so an LP who wants to fund anyone leaves it all at zero.
    struct Criteria {
        uint32 minMandatesSettled;
        uint32 maxBreaches; // type(uint32).max = no limit
        uint32 minProfitableExits;
        uint32 minDaysTraded;
        uint256 minRealisedProfit;
        uint16 maxConsistencyBps; // 0 = no requirement
    }

    struct Offer {
        address lp;
        uint256 allocation; // per mandate
        uint32 slotsTotal;
        uint32 slotsTaken;
        bool open;
        Types.Terms terms;
        Criteria criteria;
    }

    Offer[] internal _offers;

    /// @notice Capital an LP has escrowed against still-unclaimed slots.
    mapping(address => uint256) public escrowed;

    /// @notice One claim per trader per offer, so a single trader cannot drain a book.
    mapping(uint256 => mapping(address => bool)) public claimed;

    error OfferClosed(uint256 offerId);
    error OfferExhausted(uint256 offerId);
    error AlreadyClaimed(uint256 offerId, address trader);
    error NotOfferOwner(uint256 offerId, address caller);
    error RecordDoesNotQualify(uint256 offerId, address trader, string reason);
    error NoSlots();

    event OfferPosted(
        uint256 indexed offerId,
        address indexed lp,
        uint256 allocation,
        uint32 slots,
        uint16 profitSplitBps,
        uint16 maxDrawdownBps
    );
    event OfferClaimed(
        uint256 indexed offerId,
        address indexed trader,
        uint256 indexed mandateId,
        address lp,
        uint256 allocation
    );
    event OfferWithdrawn(uint256 indexed offerId, address indexed lp, uint256 refunded);

    constructor(address registry_, address asset_) {
        if (registry_ == address(0) || asset_ == address(0)) revert Errors.ZeroAddress();
        registry = IMandateRegistry(registry_);
        assetToken = IERC20(asset_);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Posting
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Offer capital to any trader whose record meets `criteria`.
    ///
    /// @dev The LP escrows `allocation * slots` up front. Escrowing rather than promising
    ///      matters: an offer a trader qualifies for but cannot actually draw is the same
    ///      broken promise this project exists to remove, one level up.
    ///
    /// @param terms The mandate terms on offer. Validated now, so an unclaimable offer cannot
    ///        sit on the book looking real.
    /// @param criteria The record a trader must have.
    /// @param slots How many traders may claim it.
    /// @return offerId The new offer.
    function postOffer(Types.Terms calldata terms, Criteria calldata criteria, uint32 slots)
        external
        nonReentrant
        returns (uint256 offerId)
    {
        if (slots == 0) revert NoSlots();
        RiskEngine.validateTerms(terms, uint64(block.timestamp));

        uint256 total = terms.allocation * slots;
        assetToken.safeTransferFrom(msg.sender, address(this), total);
        escrowed[msg.sender] += total;

        offerId = _offers.length;
        _offers.push(
            Offer({
                lp: msg.sender,
                allocation: terms.allocation,
                slotsTotal: slots,
                slotsTaken: 0,
                open: true,
                terms: terms,
                criteria: criteria
            })
        );

        emit OfferPosted(
            offerId, msg.sender, terms.allocation, slots, terms.profitSplitBps, terms.maxDrawdownBps
        );
    }

    /// @notice Withdraw an offer and take back the capital behind its unclaimed slots.
    /// @dev Claimed slots are already live mandates and are unaffected.
    function withdrawOffer(uint256 offerId) external nonReentrant {
        Offer storage o = _offers[offerId];
        if (o.lp != msg.sender) revert NotOfferOwner(offerId, msg.sender);
        if (!o.open) revert OfferClosed(offerId);

        uint32 unclaimed = o.slotsTotal - o.slotsTaken;
        uint256 refund = o.allocation * unclaimed;
        o.open = false;

        if (refund > 0) {
            escrowed[msg.sender] -= refund;
            assetToken.safeTransfer(msg.sender, refund);
        }
        emit OfferWithdrawn(offerId, msg.sender, refund);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Claiming
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Take an offer, if your record qualifies.
    ///
    /// @dev No approval step and no counterparty discretion. The contract reads the caller's
    ///      record from the registry, checks it against the offer's criteria, and either
    ///      issues the mandate or reverts with the reason. An LP cannot decline a trader who
    ///      qualifies — that is the difference between a market and an application form.
    function claim(uint256 offerId) external nonReentrant returns (uint256 mandateId) {
        Offer storage o = _offers[offerId];
        if (!o.open) revert OfferClosed(offerId);
        if (o.slotsTaken >= o.slotsTotal) revert OfferExhausted(offerId);
        if (claimed[offerId][msg.sender]) revert AlreadyClaimed(offerId, msg.sender);

        (bool ok, string memory reason) = qualifies(offerId, msg.sender);
        if (!ok) revert RecordDoesNotQualify(offerId, msg.sender, reason);

        claimed[offerId][msg.sender] = true;
        o.slotsTaken += 1;
        escrowed[o.lp] -= o.allocation;

        Types.Terms memory t = o.terms;
        // Expiry is stored as a duration-from-post on the book; refresh it so a mandate
        // claimed late is not born half-expired.
        t.expiry = uint64(block.timestamp) + _durationOf(o);

        assetToken.forceApprove(address(registry), o.allocation);
        // The book pays; the LP is the backer and receives the settlement.
        mandateId = registry.issueBacked(msg.sender, t, o.lp);

        emit OfferClaimed(offerId, msg.sender, mandateId, o.lp, o.allocation);
    }

    /// @notice Whether `trader` may claim `offerId`, and if not, which requirement they miss.
    /// @dev The UI reads this so a trader is told what they are short of rather than being
    ///      told "no". A market that will not say why is a gatekeeper wearing a market's hat.
    function qualifies(uint256 offerId, address trader)
        public
        view
        returns (bool ok, string memory reason)
    {
        Criteria memory c = _offers[offerId].criteria;
        Types.TraderRecord memory r = registry.recordOf(trader);

        if (r.mandatesSettled < c.minMandatesSettled) return (false, "Not enough settled mandates");
        if (r.breaches > c.maxBreaches) return (false, "Too many breaches on record");
        if (r.profitableExits < c.minProfitableExits) return (false, "Not enough profitable exits");
        if (r.daysTraded < c.minDaysTraded) return (false, "Not enough days traded");
        if (r.realisedProfit < c.minRealisedProfit) return (false, "Lifetime profit too low");
        if (c.maxConsistencyBps != 0) {
            // 0 means the trader has never had a profitable exit, so there is no score to
            // meet. Treated as failing rather than passing: an unproven record is not a good
            // one, and silently admitting it would let anyone through a consistency gate.
            if (r.bestConsistencyBps == 0) return (false, "No profitable exit on record yet");
            if (r.bestConsistencyBps > c.maxConsistencyBps) return (false, "Consistency score too high");
        }
        return (true, "");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────────────

    function offerCount() external view returns (uint256) {
        return _offers.length;
    }

    function offerAt(uint256 offerId) external view returns (Offer memory) {
        return _offers[offerId];
    }

    /// @notice Offers that are open and still have a free slot.
    function openOffers() external view returns (uint256[] memory ids) {
        uint256 n = _offers.length;
        uint256 count;
        for (uint256 i; i < n; ++i) {
            if (_offers[i].open && _offers[i].slotsTaken < _offers[i].slotsTotal) ++count;
        }
        ids = new uint256[](count);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            if (_offers[i].open && _offers[i].slotsTaken < _offers[i].slotsTotal) ids[k++] = i;
        }
    }

    /// @dev Offers store an absolute expiry at post time; the remaining window is what a
    ///      claiming trader actually gets. Floored at a day so a stale offer is not useless.
    function _durationOf(Offer storage o) internal view returns (uint64) {
        uint64 nowTs = uint64(block.timestamp);
        if (o.terms.expiry <= nowTs + 1 days) return 1 days;
        return o.terms.expiry - nowTs;
    }
}

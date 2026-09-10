// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Fixture} from "../utils/Fixture.sol";
import {UnderwritingBook} from "../../src/UnderwritingBook.sol";
import {MandateAccount} from "../../src/MandateAccount.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice The market for trader risk.
///
/// @dev What these tests are really asserting is that terms are *priced* rather than
///      published: an LP puts capital behind a record they specify, a trader who meets it
///      takes it without asking anyone, and an LP cannot decline someone who qualifies.
contract UnderwritingBookTest is Fixture {
    address internal lpA = makeAddr("underwriterA");
    address internal lpB = makeAddr("underwriterB");
    address internal rookie = makeAddr("rookie");
    address internal veteran = makeAddr("veteran");

    function _openCriteria() internal pure returns (UnderwritingBook.Criteria memory) {
        return UnderwritingBook.Criteria({
            minMandatesSettled: 0,
            maxBreaches: type(uint32).max,
            minProfitableExits: 0,
            minDaysTraded: 0,
            minRealisedProfit: 0,
            maxConsistencyBps: 0
        });
    }

    function _post(address lp, Types.Terms memory terms, UnderwritingBook.Criteria memory c, uint32 slots)
        internal
        returns (uint256 offerId)
    {
        asset.mint(lp, terms.allocation * slots);
        vm.startPrank(lp);
        asset.approve(address(book), type(uint256).max);
        offerId = book.postOffer(terms, c, slots);
        vm.stopPrank();
    }

    /// @dev Give `who` a settled, profitable mandate so they have a real record.
    function _buildRecord(address who) internal {
        Types.Terms memory t = _defaultTerms();
        t.dailyLossBps = DD_BPS; // let the trailing floor bind so a rally is survivable
        (uint256 id, MandateAccount acct) = _issue(who, t);

        vm.prank(who);
        acct.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 84_000);
        registry.markAndEnforce(id);

        vm.prank(who);
        registry.closeMandate(id);

        _setPrice(BTC, 80_000); // restore for later tests
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Posting
    // ─────────────────────────────────────────────────────────────────────────────

    function test_postOffer_escrowsTheCapitalUpFront() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 3);

        assertEq(book.escrowed(lpA), ALLOC * 3, "capital is held, not promised");
        assertEq(asset.balanceOf(address(book)), ALLOC * 3);

        UnderwritingBook.Offer memory o = book.offerAt(offerId);
        assertEq(o.lp, lpA);
        assertEq(o.slotsTotal, 3);
        assertEq(o.slotsTaken, 0);
        assertTrue(o.open);
    }

    function test_postOffer_rejectsInvalidTerms() public {
        Types.Terms memory bad = _defaultTerms();
        bad.maxDrawdownBps = 0;
        asset.mint(lpA, ALLOC);
        vm.startPrank(lpA);
        asset.approve(address(book), type(uint256).max);
        vm.expectRevert(Errors.DrawdownMustBeNonZero.selector);
        book.postOffer(bad, _openCriteria(), 1);
        vm.stopPrank();
    }

    function test_postOffer_rejectsZeroSlots() public {
        asset.mint(lpA, ALLOC);
        vm.startPrank(lpA);
        asset.approve(address(book), type(uint256).max);
        vm.expectRevert(UnderwritingBook.NoSlots.selector);
        book.postOffer(_defaultTerms(), _openCriteria(), 0);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Claiming
    // ─────────────────────────────────────────────────────────────────────────────

    function test_claim_issuesABackedMandateFundedByTheLp() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 2);
        uint256 poolBefore = pool.totalAssets();

        vm.prank(rookie);
        uint256 mandateId = book.claim(offerId);

        Types.MandateState memory s = registry.stateOf(mandateId);
        assertEq(s.trader, rookie);
        assertEq(s.backer, lpA, "the LP is on the hook, not the pool");
        assertEq(uint8(s.status), uint8(Types.Status.Active));

        assertEq(pool.totalAssets(), poolBefore, "pool capital was never touched");
        assertEq(pool.totalAllocated(), 0, "and its allocation accounting is untouched");
        assertEq(book.escrowed(lpA), ALLOC, "one slot's escrow released");
    }

    /// @dev The claim needs no approval from anyone. That is the whole difference between a
    ///      market and an application form.
    function test_claim_needsNobodysPermission() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 1);

        // Not an issuer, not the owner, never spoken to the LP.
        assertFalse(registry.issuers(rookie));
        vm.prank(rookie);
        book.claim(offerId);

        assertEq(registry.mandatesOf(rookie).length, 1);
    }

    function test_claim_oncePerTraderPerOffer() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 5);
        vm.startPrank(rookie);
        book.claim(offerId);
        vm.expectRevert(
            abi.encodeWithSelector(UnderwritingBook.AlreadyClaimed.selector, offerId, rookie)
        );
        book.claim(offerId);
        vm.stopPrank();
    }

    function test_claim_exhaustsSlots() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 1);
        vm.prank(rookie);
        book.claim(offerId);

        vm.prank(veteran);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingBook.OfferExhausted.selector, offerId));
        book.claim(offerId);
    }

    function test_claim_refreshesExpirySoALateClaimIsNotBornHalfExpired() public {
        Types.Terms memory t = _defaultTerms();
        t.expiry = uint64(block.timestamp) + 30 days;
        uint256 offerId = _post(lpA, t, _openCriteria(), 1);

        _skip(20 days);

        vm.prank(rookie);
        uint256 id = book.claim(offerId);
        assertGt(registry.termsOf(id).expiry, uint64(block.timestamp) + 9 days, "window refreshed");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  The record is the price
    // ─────────────────────────────────────────────────────────────────────────────

    function test_criteria_rookieCannotTakeAProvenTradersOffer() public {
        UnderwritingBook.Criteria memory strict = _openCriteria();
        strict.minMandatesSettled = 1;
        strict.minProfitableExits = 1;
        uint256 offerId = _post(lpA, _defaultTerms(), strict, 1);

        (bool ok, string memory reason) = book.qualifies(offerId, rookie);
        assertFalse(ok);
        assertEq(reason, "Not enough settled mandates");

        vm.prank(rookie);
        vm.expectRevert();
        book.claim(offerId);
    }

    function test_criteria_provenTraderQualifiesForTheSameOffer() public {
        _buildRecord(veteran);

        UnderwritingBook.Criteria memory strict = _openCriteria();
        strict.minMandatesSettled = 1;
        strict.minProfitableExits = 1;
        uint256 offerId = _post(lpA, _defaultTerms(), strict, 1);

        (bool ok,) = book.qualifies(offerId, veteran);
        assertTrue(ok, "a settled, profitable mandate is the credential");

        vm.prank(veteran);
        uint256 id = book.claim(offerId);
        assertEq(registry.stateOf(id).backer, lpA);
    }

    /// @dev This is the market working: the same trader is worth better terms to a second LP,
    ///      and nobody had to negotiate. A prop firm publishes one menu for everyone.
    function test_market_provenTraderGetsBetterTermsThanARookie() public {
        _buildRecord(veteran);

        Types.Terms memory openTerms = _defaultTerms();
        openTerms.profitSplitBps = 7_000; // 70% — the "anyone" price
        uint256 openOffer = _post(lpA, openTerms, _openCriteria(), 1);

        Types.Terms memory primeTerms = _defaultTerms();
        primeTerms.profitSplitBps = 9_200; // 92% — the proven-trader price
        UnderwritingBook.Criteria memory strict = _openCriteria();
        strict.minProfitableExits = 1;
        uint256 primeOffer = _post(lpB, primeTerms, strict, 1);

        (bool rookieOnPrime,) = book.qualifies(primeOffer, rookie);
        (bool vetOnPrime,) = book.qualifies(primeOffer, veteran);
        assertFalse(rookieOnPrime, "rookie is priced out of the better terms");
        assertTrue(vetOnPrime);

        vm.prank(veteran);
        uint256 id = book.claim(primeOffer);
        assertEq(registry.termsOf(id).profitSplitBps, 9_200, "record bought a better split");

        // And the open offer is still there for the rookie to start building a record on.
        vm.prank(rookie);
        uint256 rookieId = book.claim(openOffer);
        assertEq(registry.termsOf(rookieId).profitSplitBps, 7_000);
    }

    function test_criteria_breachCountIsEnforced() public {
        UnderwritingBook.Criteria memory c = _openCriteria();
        c.maxBreaches = 0;
        uint256 offerId = _post(lpA, _defaultTerms(), c, 1);

        // Give the trader a breach.
        (uint256 id, MandateAccount acct) = _issue(rookie, _defaultTerms());
        vm.prank(rookie);
        acct.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000);
        registry.markAndEnforce(id);
        _setPrice(BTC, 80_000);

        assertEq(registry.recordOf(rookie).breaches, 1);
        (bool ok, string memory reason) = book.qualifies(offerId, rookie);
        assertFalse(ok);
        assertEq(reason, "Too many breaches on record");
    }

    /// @dev An unproven record must not sail through a consistency gate. Zero means "never had
    ///      a profitable exit", not "perfect score".
    function test_criteria_unprovenRecordFailsAConsistencyGate() public {
        UnderwritingBook.Criteria memory c = _openCriteria();
        c.maxConsistencyBps = 2_000;
        uint256 offerId = _post(lpA, _defaultTerms(), c, 1);

        (bool ok, string memory reason) = book.qualifies(offerId, rookie);
        assertFalse(ok);
        assertEq(reason, "No profitable exit on record yet");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Settlement goes to the backer, never the pool
    // ─────────────────────────────────────────────────────────────────────────────

    function test_settlement_returnsToTheBackerNotThePool() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 1);
        vm.prank(rookie);
        uint256 id = book.claim(offerId);

        uint256 poolBefore = pool.totalAssets();
        uint256 lpBefore = asset.balanceOf(lpA);

        vm.prank(rookie);
        registry.closeMandate(id);

        assertGt(asset.balanceOf(lpA), lpBefore, "the backer got their capital back");
        assertEq(pool.totalAssets(), poolBefore, "the pool neither gained nor lost");
    }

    function test_settlement_backerEatsTheLossNotThePool() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 1);
        vm.prank(rookie);
        uint256 id = book.claim(offerId);
        MandateAccount acct = MandateAccount(registry.stateOf(id).account);

        uint256 poolBefore = pool.totalAssets();

        vm.prank(rookie);
        acct.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000);
        registry.markAndEnforce(id);

        assertEq(uint8(registry.stateOf(id).status), uint8(Types.Status.Breached));
        assertLt(asset.balanceOf(lpA), ALLOC, "backer took the loss");
        assertEq(pool.totalAssets(), poolBefore, "pool untouched by a loss it did not underwrite");
    }

    /// @dev A backed mandate must not show up in the pool's assets. Counting it would inflate
    ///      every LP's share price with capital that is not theirs.
    function test_pool_doesNotCountBackedMandatesInItsAssets() public {
        uint256 poolBefore = pool.totalAssets();
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 1);
        vm.prank(rookie);
        book.claim(offerId);

        assertEq(registry.activeCount(), 1);
        assertEq(pool.totalAssets(), poolBefore, "share price unmoved by someone else's mandate");
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Withdrawal
    // ─────────────────────────────────────────────────────────────────────────────

    function test_withdrawOffer_refundsUnclaimedSlotsOnly() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 3);
        vm.prank(rookie);
        book.claim(offerId);

        uint256 before = asset.balanceOf(lpA);
        vm.prank(lpA);
        book.withdrawOffer(offerId);

        assertEq(asset.balanceOf(lpA) - before, ALLOC * 2, "two unclaimed slots refunded");
        assertEq(book.escrowed(lpA), 0);
        assertFalse(book.offerAt(offerId).open);
    }

    function test_withdrawOffer_onlyTheAuthor() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 1);
        vm.prank(lpB);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingBook.NotOfferOwner.selector, offerId, lpB));
        book.withdrawOffer(offerId);
    }

    function test_withdrawnOfferCannotBeClaimed() public {
        uint256 offerId = _post(lpA, _defaultTerms(), _openCriteria(), 1);
        vm.prank(lpA);
        book.withdrawOffer(offerId);

        vm.prank(rookie);
        vm.expectRevert(abi.encodeWithSelector(UnderwritingBook.OfferClosed.selector, offerId));
        book.claim(offerId);
    }

    function test_openOffers_listsOnlyClaimableOnes() public {
        uint256 a = _post(lpA, _defaultTerms(), _openCriteria(), 1);
        uint256 b = _post(lpB, _defaultTerms(), _openCriteria(), 1);
        assertEq(book.openOffers().length, 2);

        vm.prank(rookie);
        book.claim(a);
        assertEq(book.openOffers().length, 1, "exhausted offer drops off the book");
        assertEq(book.openOffers()[0], b);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  The record itself
    // ─────────────────────────────────────────────────────────────────────────────

    function test_record_isWrittenBySettlementNotSelfReported() public {
        assertEq(registry.recordOf(veteran).mandatesSettled, 0);
        _buildRecord(veteran);

        Types.TraderRecord memory r = registry.recordOf(veteran);
        assertEq(r.mandatesIssued, 1);
        assertEq(r.mandatesSettled, 1);
        assertEq(r.profitableExits, 1);
        assertEq(r.breaches, 0);
        assertGt(r.realisedProfit, 0);
        assertEq(r.capitalEntrusted, ALLOC);
        assertGt(r.firstMandateAt, 0);
    }

    function test_record_countsBreaches() public {
        (uint256 id, MandateAccount acct) = _issue(rookie, _defaultTerms());
        vm.prank(rookie);
        acct.openPosition(BTC, true, 2e18, 0);
        _setPrice(BTC, 75_000);
        registry.markAndEnforce(id);

        Types.TraderRecord memory r = registry.recordOf(rookie);
        assertEq(r.breaches, 1);
        assertEq(r.profitableExits, 0);
        assertGt(r.realisedLoss, 0);
    }

    function test_record_isPublicAndFreeToRead() public view {
        // Anyone can read anyone's record — that is what makes it portable. A firm's record
        // of you is theirs; this one is yours.
        registry.recordOf(address(0xdead));
    }
}

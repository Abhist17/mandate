// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IMandateRegistry, ICapitalPool} from "./interfaces/IMandateRegistry.sol";
import {IPerpVenue} from "./interfaces/IPerpVenue.sol";
import {MandateAccount} from "./MandateAccount.sol";
import {RiskEngine} from "./libraries/RiskEngine.sol";
import {Types} from "./libraries/Types.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title MandateRegistry
/// @author Mandate
/// @notice Issues mandates, marks them, and enforces their terms.
///
/// @dev **The one design decision that matters here is that {markAndEnforce} is
///      permissionless.** Anyone can call it: an LP protecting their capital, a passing
///      observer, a competing trader who wants the allocation freed up, or our own keeper.
///
///      That single property is what separates this from a prop firm's risk server. Every
///      incumbent runs enforcement on a private machine, which means the rules are only as
///      real as the operator's willingness to apply them — and an operator who benefits from
///      a trader breaching has an obvious reason to be diligent, while an operator who
///      benefits from them surviving has an obvious reason not to be. Here the enforcement
///      is a public function. Our keeper is a convenience. If it dies, the rules still work.
///
///      Marks are cheap and batched. `markAndEnforceBatch` folds many mandates into one
///      transaction, which is the entire economic argument for running this on Monad: a
///      continuous per-block risk loop over hundreds of accounts only pays for itself at
///      400ms blocks and sub-cent gas.
contract MandateRegistry is IMandateRegistry, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Implementation cloned for each mandate.
    address public immutable accountImplementation;
    IPerpVenue public immutable venue;
    IERC20 public immutable assetToken;

    ICapitalPool public pool;

    /// @notice Addresses permitted to issue mandates.
    /// @dev Issuance is permissioned because it commits LP capital; *enforcement* is not.
    ///      Those two facts are the whole trust model and they point in opposite directions
    ///      on purpose.
    mapping(address => bool) public issuers;

    /// @inheritdoc IMandateRegistry
    uint16 public preTradeBufferBps = 200; // 2% adverse move assumed pre-trade

    /// @notice Max age of an oracle-derived equity mark used for enforcement.
    uint64 public maxMarkAge = 60;

    uint256 public nextMandateId = 1;

    mapping(uint256 => Types.Terms) internal _terms;
    mapping(uint256 => Types.MandateState) internal _states;
    mapping(address => uint256[]) internal _mandatesOf;

    /// @notice Every mandate currently in the Active state.
    uint256[] internal _activeMandates;
    mapping(uint256 => uint256) internal _activeIndex; // mandateId => index+1, 0 = not active

    event MandateIssued(
        uint256 indexed mandateId,
        address indexed trader,
        address indexed account,
        uint256 allocation,
        uint16 maxDrawdownBps,
        uint16 dailyLossBps,
        uint16 profitSplitBps,
        uint16 maxPositionBps,
        uint64 expiry
    );
    event EquityMarked(
        uint256 indexed mandateId,
        uint256 equity,
        uint256 highWaterMark,
        uint256 trailingFloor,
        uint256 dailyFloor,
        int256 netPnl,
        uint64 markedAt,
        address indexed by
    );
    event DayRolled(uint256 indexed mandateId, uint256 dayStartEquity, uint64 dayStartTime);
    event Breached(
        uint256 indexed mandateId,
        Types.BreachKind kind,
        uint256 equityAtBreach,
        uint256 floor,
        address indexed enforcedBy
    );
    event Settled(
        uint256 indexed mandateId,
        Types.Status finalStatus,
        uint256 finalEquity,
        uint256 traderPayout,
        uint256 poolReturn
    );
    event IssuerSet(address indexed issuer, bool allowed);
    event PoolSet(address indexed pool);
    event PreTradeBufferSet(uint16 bps);
    event MaxMarkAgeSet(uint64 age);

    modifier onlyIssuer() {
        if (!issuers[msg.sender]) revert Errors.NotAuthorised(msg.sender);
        _;
    }

    constructor(address owner_, address venue_, address accountImplementation_) Ownable(owner_) {
        if (venue_ == address(0) || accountImplementation_ == address(0)) revert Errors.ZeroAddress();
        venue = IPerpVenue(venue_);
        accountImplementation = accountImplementation_;
        assetToken = IERC20(IPerpVenue(venue_).asset());
        issuers[owner_] = true;
        emit IssuerSet(owner_, true);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Wire the capital pool. Set once at deploy; the two contracts are circular.
    function setPool(address pool_) external onlyOwner {
        if (pool_ == address(0)) revert Errors.ZeroAddress();
        if (address(pool) != address(0)) revert Errors.AlreadyInitialised();
        pool = ICapitalPool(pool_);
        emit PoolSet(pool_);
    }

    function setIssuer(address issuer, bool allowed) external onlyOwner {
        if (issuer == address(0)) revert Errors.ZeroAddress();
        issuers[issuer] = allowed;
        emit IssuerSet(issuer, allowed);
    }

    /// @notice Set the adverse move assumed by pre-trade checks.
    function setPreTradeBufferBps(uint16 bps) external onlyOwner {
        if (bps > 5_000) revert Errors.SlippageToleranceTooWide(bps);
        preTradeBufferBps = bps;
        emit PreTradeBufferSet(bps);
    }

    function setMaxMarkAge(uint64 age) external onlyOwner {
        if (age == 0) revert Errors.ZeroAmount();
        maxMarkAge = age;
        emit MaxMarkAgeSet(age);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Issuance
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Issue a mandate: clone an account, pull the allocation from the pool, fund it.
    /// @dev The terms are validated at issuance and then frozen. There is no `updateTerms`,
    ///      by design — a mandate whose rules can change mid-flight is a rulebook again.
    /// @param trader Who may trade the allocation.
    /// @param terms The rules. See {RiskEngine-validateTerms} for what is rejected.
    /// @return mandateId Identifier of the new mandate.
    function issue(address trader, Types.Terms calldata terms)
        external
        onlyIssuer
        nonReentrant
        returns (uint256 mandateId)
    {
        if (trader == address(0)) revert Errors.ZeroAddress();
        RiskEngine.validateTerms(terms, uint64(block.timestamp));

        mandateId = nextMandateId++;

        address account = Clones.clone(accountImplementation);
        MandateAccount(account).initialize(mandateId, trader, address(this), address(venue));

        _terms[mandateId] = terms;

        // Move the capital BEFORE registering the mandate as Active.
        //
        // Ordering matters here and it is not cosmetic. `pool.totalAssets()` is
        // `idle + Σ(equity of Active mandates)`, and the pool's allocation cap is a fraction
        // of that total. Registering the mandate first would count its allocation as mandate
        // equity while the same capital was still sitting in idle — inflating totalAssets by
        // exactly the amount being allocated, and so inflating the cap that is supposed to
        // bound it. A 25% allocation would pass a 20% cap. Found by
        // CapitalPool.t.sol::test_allocate_respectsMaxAllocationBps.
        pool.allocate(account, terms.allocation);
        MandateAccount(account).fundVenue(terms.allocation);

        _states[mandateId] = Types.MandateState({
            trader: trader,
            account: account,
            highWaterMark: terms.allocation,
            dayStartEquity: terms.allocation,
            dayStartTime: uint64(block.timestamp),
            lastMarkedEquity: terms.allocation,
            lastMarkedAt: uint64(block.timestamp),
            issuedAt: uint64(block.timestamp),
            status: Types.Status.Active,
            breachKind: Types.BreachKind.None
        });

        _mandatesOf[trader].push(mandateId);
        _activeMandates.push(mandateId);
        _activeIndex[mandateId] = _activeMandates.length;

        emit MandateIssued(
            mandateId,
            trader,
            account,
            terms.allocation,
            terms.maxDrawdownBps,
            terms.dailyLossBps,
            terms.profitSplitBps,
            terms.maxPositionBps,
            terms.expiry
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Marking and enforcement — PERMISSIONLESS
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Mark a mandate to market and, if it breached, flatten and settle it.
    ///
    /// @dev **Anyone may call this.** No allowlist, no keeper role, no owner check. That is
    ///      the trust property, and it is deliberately a one-line decision rather than a
    ///      subsystem: the absence of an access modifier is the feature.
    ///
    ///      A mark reads live equity from the account (which prices open positions through
    ///      the venue oracle), runs {RiskEngine-evaluate}, and persists the result. If the
    ///      verdict is a breach, the position is flattened *first* and settlement then uses
    ///      the equity that actually came back — not the equity we thought we had a moment
    ///      earlier. Settling on a projected number would let the difference between the
    ///      marked price and the real fill fall on whichever side was not paying attention.
    ///
    /// @param mandateId Mandate to mark.
    /// @return breached Whether this call ended the mandate.
    function markAndEnforce(uint256 mandateId) public nonReentrant returns (bool breached) {
        return _markAndEnforce(mandateId);
    }

    /// @notice Mark many mandates in one transaction.
    /// @dev This is where the Monad argument lives. A per-block risk loop over hundreds of
    ///      accounts is only economically viable if a mark costs a fraction of a cent, and
    ///      batching is what gets it there. A mandate that reverts (stale price, mid-flight
    ///      state) does not abort the batch — one bad mandate must never stop every other
    ///      mandate from being enforced.
    /// @param mandateIds Mandates to mark.
    /// @return breachedCount How many were ended by this call.
    function markAndEnforceBatch(uint256[] calldata mandateIds)
        external
        nonReentrant
        returns (uint256 breachedCount)
    {
        uint256 n = mandateIds.length;
        for (uint256 i; i < n; ++i) {
            try this.markOne(mandateIds[i]) returns (bool didBreach) {
                if (didBreach) ++breachedCount;
            } catch {
                // Deliberately swallowed. See the note above.
            }
        }
    }

    /// @notice External entry point used by {markAndEnforceBatch} for per-mandate isolation.
    /// @dev Only callable by this contract. Exists solely so a revert in one mandate can be
    ///      caught without unwinding the whole batch.
    function markOne(uint256 mandateId) external returns (bool) {
        if (msg.sender != address(this)) revert Errors.NotAuthorised(msg.sender);
        return _markAndEnforce(mandateId);
    }

    function _markAndEnforce(uint256 mandateId) internal returns (bool breached) {
        Types.MandateState storage s = _states[mandateId];
        if (s.status == Types.Status.None) revert Errors.UnknownMandate(mandateId);
        if (s.status != Types.Status.Active) revert Errors.MandateNotActive(mandateId);

        Types.Terms memory terms = _terms[mandateId];
        uint256 markedEquity = MandateAccount(s.account).equity();

        RiskEngine.MarkResult memory r = RiskEngine.evaluate(
            RiskEngine.MarkInput({
                allocation: terms.allocation,
                netPnl: int256(markedEquity) - int256(terms.allocation),
                highWaterMark: s.highWaterMark,
                dayStartEquity: s.dayStartEquity,
                dayStartTime: s.dayStartTime,
                maxDrawdownBps: terms.maxDrawdownBps,
                dailyLossBps: terms.dailyLossBps,
                expiry: terms.expiry,
                resetHourUtc: terms.resetHourUtc,
                timestamp: uint64(block.timestamp)
            })
        );

        s.highWaterMark = r.highWaterMark;
        s.lastMarkedEquity = r.equity;
        s.lastMarkedAt = uint64(block.timestamp);
        if (r.rolledDay) {
            s.dayStartEquity = r.dayStartEquity;
            s.dayStartTime = r.dayStartTime;
            emit DayRolled(mandateId, r.dayStartEquity, r.dayStartTime);
        }

        emit EquityMarked(
            mandateId,
            r.equity,
            r.highWaterMark,
            r.trailingFloor,
            r.dailyFloor,
            int256(markedEquity) - int256(terms.allocation),
            uint64(block.timestamp),
            msg.sender
        );

        if (r.breach == Types.BreachKind.None) return false;

        emit Breached(mandateId, r.breach, r.equity, r.effectiveFloor, msg.sender);
        s.breachKind = r.breach;
        _terminate(
            mandateId,
            s,
            terms,
            r.breach == Types.BreachKind.Expiry ? Types.Status.Expired : Types.Status.Breached
        );
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Voluntary close
    // ─────────────────────────────────────────────────────────────────────────────

    /// @notice Close a mandate voluntarily and take the profit split.
    /// @dev Open to the trader and to the registry owner. A trader closing in profit is the
    ///      happy path the whole thing is built for; a trader closing at a loss just returns
    ///      what's left.
    function closeMandate(uint256 mandateId) external nonReentrant {
        Types.MandateState storage s = _states[mandateId];
        if (s.status == Types.Status.None) revert Errors.UnknownMandate(mandateId);
        if (s.status != Types.Status.Active) revert Errors.MandateNotActive(mandateId);
        if (msg.sender != s.trader && msg.sender != owner()) {
            revert Errors.NotMandateTrader(mandateId, msg.sender);
        }
        _terminate(mandateId, s, _terms[mandateId], Types.Status.Closed);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Settlement
    // ─────────────────────────────────────────────────────────────────────────────

    /// @dev Flatten, sweep, split, pay. In that order.
    ///
    ///      Flattening before settling is not a detail: settlement must be computed from the
    ///      capital that actually came back through the venue, including the spread and fee
    ///      paid to get flat. Anything else pays somebody out of a number that was never
    ///      realisable.
    function _terminate(
        uint256 mandateId,
        Types.MandateState storage s,
        Types.Terms memory terms,
        Types.Status finalStatus
    ) internal {
        // 1. flatten and pull every asset back to this contract
        uint256 finalEquity = MandateAccount(s.account).liquidateAndSweep();

        // 2. split what actually came back
        (uint256 traderPayout, uint256 poolReturn) =
            RiskEngine.split(finalEquity, terms.allocation, terms.profitSplitBps);

        // 3. mark terminal before paying anyone
        s.status = finalStatus;
        s.lastMarkedEquity = finalEquity;
        s.lastMarkedAt = uint64(block.timestamp);
        _removeActive(mandateId);

        // 4. pay
        if (traderPayout > 0) assetToken.safeTransfer(s.trader, traderPayout);
        if (poolReturn > 0) assetToken.safeTransfer(address(pool), poolReturn);
        pool.onMandateSettled(mandateId, terms.allocation, poolReturn);

        emit Settled(mandateId, finalStatus, finalEquity, traderPayout, poolReturn);
    }

    function _removeActive(uint256 mandateId) internal {
        uint256 idx = _activeIndex[mandateId];
        if (idx == 0) return;
        uint256 last = _activeMandates.length;
        if (idx != last) {
            uint256 moved = _activeMandates[last - 1];
            _activeMandates[idx - 1] = moved;
            _activeIndex[moved] = idx;
        }
        _activeMandates.pop();
        delete _activeIndex[mandateId];
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Views
    // ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IMandateRegistry
    function termsOf(uint256 mandateId) external view returns (Types.Terms memory) {
        return _terms[mandateId];
    }

    /// @inheritdoc IMandateRegistry
    function stateOf(uint256 mandateId) external view returns (Types.MandateState memory) {
        return _states[mandateId];
    }

    /// @inheritdoc IMandateRegistry
    function isActive(uint256 mandateId) external view returns (bool) {
        return _states[mandateId].status == Types.Status.Active;
    }

    /// @inheritdoc IMandateRegistry
    function floorOf(uint256 mandateId) public view returns (uint256 effectiveFloor, uint256 lastEquity) {
        Types.MandateState storage s = _states[mandateId];
        Types.Terms storage t = _terms[mandateId];
        uint256 tf = RiskEngine.trailingFloor(s.highWaterMark, t.maxDrawdownBps);
        uint256 df = RiskEngine.dailyFloor(s.dayStartEquity, t.dailyLossBps);
        effectiveFloor = tf > df ? tf : df;
        lastEquity = s.lastMarkedEquity;
    }

    /// @inheritdoc IMandateRegistry
    /// @dev Uses last-*marked* equity, not live equity. The pool's share price therefore
    ///      trails the market by at most one keeper mark. Stated plainly because it is a real
    ///      limitation: an LP transacting between marks transacts at a slightly stale price.
    ///      At 400ms blocks that window is small, but it is not zero.
    function aggregateActiveEquity() external view returns (uint256 total) {
        uint256 n = _activeMandates.length;
        for (uint256 i; i < n; ++i) {
            total += _states[_activeMandates[i]].lastMarkedEquity;
        }
    }

    /// @notice Live equity of a mandate, priced through the venue right now.
    /// @dev What the keeper and the frontend read. More expensive than {aggregateActiveEquity}
    ///      because it touches the oracle per open position.
    function liveEquity(uint256 mandateId) external view returns (uint256) {
        return MandateAccount(_states[mandateId].account).equity();
    }

    /// @notice Distance to the binding floor, absolute and in bps. The trader's readout.
    function headroom(uint256 mandateId) external view returns (uint256 absolute, uint256 bps) {
        (uint256 floor,) = floorOf(mandateId);
        return RiskEngine.distanceToFloor(MandateAccount(_states[mandateId].account).equity(), floor);
    }

    /// @notice Every mandate currently Active. The keeper's work list.
    function activeMandates() external view returns (uint256[] memory) {
        return _activeMandates;
    }

    function activeCount() external view returns (uint256) {
        return _activeMandates.length;
    }

    function mandatesOf(address trader) external view returns (uint256[] memory) {
        return _mandatesOf[trader];
    }

    /// @notice Notional cap implied by a mandate's terms.
    function positionCapOf(uint256 mandateId) external view returns (uint256) {
        return RiskEngine.maxNotional(_terms[mandateId].allocation, _terms[mandateId].maxPositionBps);
    }
}
